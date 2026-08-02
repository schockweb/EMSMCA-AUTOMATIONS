"""
Security utilities — JWT token handling with JTI claims, password hashing
with complexity validation, token blacklisting, and role-based guards.
"""
from __future__ import annotations
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
import bcrypt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.models.user import User, UserRole

settings = get_settings()

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")

# ── Account Lockout Settings ─────────────────────
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_DURATION_MINUTES = 45


# ── Password Hashing ──────────────────────────────

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))


async def verify_password_async(plain_password: str, hashed_password: str) -> bool:
    """Non-blocking bcrypt verify — runs in a thread so the event loop (and DB
    connections) aren't held hostage by the ~200 ms CPU-bound hash check."""
    import asyncio
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, verify_password, plain_password, hashed_password
    )


# A bcrypt digest of a value nobody knows, built once per process. Verifying
# against it is how an UNKNOWN account is made to cost the same as a real one.
# Generated rather than hard-coded so the work factor always tracks whatever
# gensalt() currently defaults to.
_DUMMY_HASH: Optional[str] = None


def _dummy_hash() -> str:
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = hash_password(uuid.uuid4().hex + uuid.uuid4().hex)
    return _DUMMY_HASH


async def verify_password_or_dummy(
    plain_password: str, hashed_password: Optional[str]
) -> bool:
    """Verify a password, spending the SAME bcrypt time when there is no account.

    Every login path short-circuited on an unknown identity — `if not user or not
    verify(...)` never reaches the hash — so a request for an address that does
    not exist came back in single-digit milliseconds while a real one spent
    ~200 ms in bcrypt. That gap is a reliable oracle for "does this account exist
    here", readable by an anonymous caller with a stopwatch and no valid
    credential.

    On this platform an account IS a person: the paramedic login set discloses
    which practitioners work for which ambulance service, and the provider portal
    set discloses which ambulance services are customers. Neither is ours to
    leak, and lockout does not help — enumeration needs one attempt per address,
    never five against the same one.

    Hashing the submitted password against a throwaway digest costs what the real
    check costs and returns False. The comparison is deliberately performed and
    discarded; it must not be optimised away.
    """
    if not hashed_password:
        await verify_password_async(plain_password, _dummy_hash())
        return False
    return await verify_password_async(plain_password, hashed_password)


# ── Password Complexity Validation ────────────────

def validate_password_complexity(password: str) -> None:
    """
    Enforce password complexity rules for a healthcare platform.
    Raises ValueError with a descriptive message if the password is weak.
    """
    errors = []
    if len(password) < 12:
        errors.append("Password must be at least 12 characters long")
    if not re.search(r'[A-Z]', password):
        errors.append("Must contain at least one uppercase letter")
    if not re.search(r'[a-z]', password):
        errors.append("Must contain at least one lowercase letter")
    if not re.search(r'[0-9]', password):
        errors.append("Must contain at least one digit")
    if not re.search(r'[!@#$%^&*()_+\-=\[\]{};:\'",.<>?/\\|`~]', password):
        errors.append("Must contain at least one special character (!@#$%^&*...)")
    if errors:
        raise ValueError("; ".join(errors))


# ── JWT Tokens (with JTI for revocation) ──────────

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    now = datetime.now(timezone.utc)
    to_encode = data.copy()
    expire = now + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    jti = str(uuid.uuid4())
    # Issue time is what makes bulk revocation possible: the blacklist can only
    # revoke a token whose JTI someone has seen, and a stolen token is by
    # definition one nobody has seen. `iat_ms` carries the millisecond precision
    # the standard second-granularity `iat` cannot — see
    # token_is_revoked_by_family for why one second is too coarse here.
    to_encode.update({
        "exp": expire, "iat": int(now.timestamp()),
        "iat_ms": int(now.timestamp() * 1000),
        "type": "access", "jti": jti,
    })
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_refresh_token(data: dict) -> str:
    now = datetime.now(timezone.utc)
    to_encode = data.copy()
    expire = now + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    jti = str(uuid.uuid4())
    to_encode.update({
        "exp": expire, "iat": int(now.timestamp()),
        "iat_ms": int(now.timestamp() * 1000),
        "type": "refresh", "jti": jti,
    })
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        return payload
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )


# ── Token Blacklist Check ─────────────────────────

async def is_token_blacklisted(jti: str, db: AsyncSession) -> bool:
    """Check if a token's JTI has been revoked."""
    from app.models.token_blacklist import TokenBlacklist
    result = await db.execute(
        select(TokenBlacklist).where(TokenBlacklist.jti == jti)
    )
    return result.scalar_one_or_none() is not None


def token_is_revoked_by_family(payload: dict, revoked_at: Optional[datetime]) -> bool:
    """True when this token was issued before its owner's tokens were mass-revoked.

    WHY A SECOND MECHANISM EXISTS ALONGSIDE THE BLACKLIST
    -----------------------------------------------------
    The blacklist revokes one token, by JTI, and can only ever revoke a JTI
    somebody has presented. That is precisely the wrong shape for the case that
    matters: a token COPIED off a device. Nobody has seen the copy, so there is
    no JTI to blacklist, and the original stays valid — logging out on the real
    device blacklists the real device's token and leaves the thief's untouched.

    A per-identity cutoff inverts that. Stamping `tokens_revoked_at = now` kills
    every credential issued before that instant, seen or unseen, in one write.
    It is the only thing that answers "a crew tablet was left at the hospital"
    or "this refresh token was replayed, assume the account is compromised".

    Fails CLOSED on a token with no `iat`. Tokens minted before this field
    existed cannot prove when they were issued, so once an identity has been
    revoked they are treated as predating it. That logs out anyone still holding
    a pre-upgrade token at the moment of a revocation — which is the correct
    trade when the alternative is a revocation that silently does not revoke.
    """
    if revoked_at is None:
        return False
    if revoked_at.tzinfo is None:
        revoked_at = revoked_at.replace(tzinfo=timezone.utc)
    # `iat_ms` rather than the standard `iat`, and the difference matters.
    #
    # A JWT NumericDate is whole seconds, but the cutoff is a database timestamp
    # carrying microseconds — and the events this defends against happen INSIDE
    # one second. Refresh-token reuse is the clearest case: the replay that
    # triggers revocation typically arrives milliseconds after the exchange that
    # minted the attacker's token, so at second granularity the attacker's token
    # and the cutoff share a timestamp and the comparison lets it live. That is
    # the entire attack surviving the countermeasure aimed at it.
    #
    # Rounding the other way is no better: it would revoke the token the victim
    # gets when they immediately sign back in, locking them out for the rest of
    # the second. Milliseconds remove the ambiguity instead of picking a side.
    #
    # `iat` is still emitted for standards compliance and is used as a fallback
    # for tokens minted before iat_ms existed.
    issued_ms = payload.get("iat_ms")
    if issued_ms is None:
        iat = payload.get("iat")
        if iat is None:
            return True
        try:
            issued_ms = int(iat) * 1000
        except (TypeError, ValueError):
            return True
    try:
        issued_ms = int(issued_ms)
    except (TypeError, ValueError):
        return True

    return issued_ms < int(revoked_at.timestamp() * 1000)


async def blacklist_token(
    jti: str,
    user_id: uuid.UUID | None,
    token_type: str,
    expires_at: datetime,
    db: AsyncSession,
) -> None:
    """Add a token JTI to the blacklist."""
    from app.models.token_blacklist import TokenBlacklist
    from sqlalchemy.exc import IntegrityError
    entry = TokenBlacklist(
        jti=jti,
        user_id=user_id,
        token_type=token_type,
        expires_at=expires_at,
    )
    db.add(entry)
    try:
        async with db.begin_nested():
            await db.flush()
    except IntegrityError:
        pass  # Already blacklisted concurrently


# ── Current User Dependency ───────────────────────

async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    payload = decode_token(token)

    # A refresh token must never work as an access token. Both are signed with
    # the same key and carry `sub`, so without this check a 7-day refresh
    # credential authenticates every bearer-guarded endpoint — turning a
    # long-lived token meant only for rotation into a long-lived API key.
    if payload.get("type") != "access":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token type",
        )

    user_id = payload.get("sub")
    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing subject claim",
        )

    # Check if token has been revoked
    jti = payload.get("jti")
    if jti and await is_token_blacklisted(jti, db):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has been revoked",
        )

    try:
        user_uuid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid user ID in token",
        )

    result = await db.execute(select(User).where(User.id == user_uuid))
    user = result.scalar_one_or_none()

    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive",
        )

    # Bulk revocation — set when a refresh token is replayed (treated as theft)
    # or when an administrator ends every session for this account.
    if token_is_revoked_by_family(payload, getattr(user, "tokens_revoked_at", None)):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session revoked. Please sign in again.",
        )
    return user


# ── Role Guard ─────────────────────────────────────

def require_role(*roles: UserRole):
    """Dependency factory: require the current user to have one of the specified roles.

    SUPER_ADMIN implicitly satisfies every role check. The match used to be
    exact, so `require_role(UserRole.ADMIN)` returned 403 to a SUPER_ADMIN —
    locking the highest-privileged account out of user management, claim
    approval and claim rejection. Call sites worked around it one at a time by
    passing both roles; several never did. Encoding the hierarchy here means a
    new `require_role(ADMIN)` cannot reintroduce the trap.
    """
    async def role_checker(current_user: User = Depends(get_current_user)):
        if current_user.role != UserRole.SUPER_ADMIN and current_user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Insufficient permissions. Required: {[r.value for r in roles]}",
            )
        return current_user
    return role_checker


# ── Fine-grained permission guard ──────────────────────────

def has_permission(user: User, *keys: str) -> bool:
    """True when `user` holds ANY of `keys`.

    Semantics match the /api/auth/me fix: a NULL `permissions` column means
    "not configured" and grants everything (this is how every existing account
    was created — the model default is the full list, and users.py stores
    `body.permissions or ALL_PERMISSIONS`). An EMPTY list means "deliberately
    stripped to nothing" and grants nothing. Using `or` here would collapse
    those two cases and hand a stripped user the full set.
    """
    if user.role == UserRole.SUPER_ADMIN:
        return True
    if user.permissions is None:
        return True
    granted = set(user.permissions)
    return any(k in granted for k in keys)


def require_permission(*keys: str):
    """Dependency factory: require ANY of the given permission keys.

    Until now the permission model was PRESENTATION ONLY. `permissions` was
    stored on the user, echoed back at login, and used by the frontend to hide
    nav links — but no endpoint ever consulted it. A user created with
    permissions=['dashboard'] still had a token that reached every route: the
    rule builder, the tariff engine, the failed-PRF queue (including the
    endpoint that rewrites clinical data), EDI generation and submission, ERA
    reconciliation, provider administration and member lookup. The whole model
    was a UI convention that looked like access control.

    That is survivable while the only account on the box is a SUPER_ADMIN, which
    is exactly the current production state. It stops being survivable the
    moment a client creates limited staff logins on their own VM and reasonably
    believes the checkboxes mean something.

    SUPER_ADMIN bypasses, consistent with require_role.
    """
    async def permission_checker(current_user: User = Depends(get_current_user)):
        if not has_permission(current_user, *keys):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Insufficient permissions. Required one of: {list(keys)}",
            )
        return current_user
    return permission_checker
