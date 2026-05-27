"""
Security utilities — JWT token handling with JTI claims, password hashing
with complexity validation, token blacklisting, and role-based guards.
"""
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
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    jti = str(uuid.uuid4())
    to_encode.update({"exp": expire, "type": "access", "jti": jti})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_refresh_token(data: dict) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    jti = str(uuid.uuid4())
    to_encode.update({"exp": expire, "type": "refresh", "jti": jti})
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


async def blacklist_token(
    jti: str,
    user_id: uuid.UUID | None,
    token_type: str,
    expires_at: datetime,
    db: AsyncSession,
) -> None:
    """Add a token JTI to the blacklist."""
    from app.models.token_blacklist import TokenBlacklist
    entry = TokenBlacklist(
        jti=jti,
        user_id=user_id,
        token_type=token_type,
        expires_at=expires_at,
    )
    db.add(entry)
    await db.flush()


# ── Current User Dependency ───────────────────────

async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    payload = decode_token(token)
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
    return user


# ── Role Guard ─────────────────────────────────────

def require_role(*roles: UserRole):
    """Dependency factory: require the current user to have one of the specified roles."""
    async def role_checker(current_user: User = Depends(get_current_user)):
        if current_user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Insufficient permissions. Required: {[r.value for r in roles]}",
            )
        return current_user
    return role_checker
