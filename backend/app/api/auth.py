"""
Auth API — Login (with account lockout), Token Refresh (with rotation blacklisting),
Logout (server-side token revocation), and Current User Profile.
"""
from __future__ import annotations
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, status, Request
from fastapi.responses import JSONResponse
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User, ALL_PERMISSIONS
from app.models.audit_log import AuditLog
from app.models.service_provider import ServiceProvider
from app.schemas.auth import TokenResponse, RefreshRequest, UserProfile
from app.utils.security import (
    verify_password,
    verify_password_async,
    verify_password_or_dummy,
    token_is_revoked_by_family,
    create_access_token,
    create_refresh_token,
    decode_token,
    get_current_user,
    blacklist_token,
    is_token_blacklisted,
    oauth2_scheme,
    MAX_FAILED_ATTEMPTS,
    LOCKOUT_DURATION_MINUTES,
)

from app.utils.client_ip import get_trusted_client_ip

import logging
logger = logging.getLogger("ems.auth")

router = APIRouter(prefix="/api/auth", tags=["Authentication"])


async def _record_login_audit(
    db: AsyncSession,
    user_id,
    action: str,
    ip_address: str,
    details: dict | None = None,
):
    """Write a login event to the immutable audit log."""
    log = AuditLog(
        user_id=user_id,
        action=action,
        entity_type="auth",
        entity_id=user_id,
        details=details,
        ip_address=ip_address,
    )
    db.add(log)


@router.post("/login", response_model=TokenResponse)
async def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: AsyncSession = Depends(get_db),
):
    """Authenticate user and return JWT tokens. Enforces account lockout after repeated failures."""
    client_ip = get_trusted_client_ip(request)
    logger.info("Login attempt for user=%s from ip=%s", form_data.username, client_ip)

    result = await db.execute(select(User).where(User.email == form_data.username))
    user = result.scalar_one_or_none()

    # ── Check if this is a Client Portal Redirect ──
    if not user:
        provider_res = await db.execute(
            select(ServiceProvider).where(func.lower(ServiceProvider.portal_login_email) == form_data.username.lower())
        )
        provider = provider_res.scalar_one_or_none()

        if provider and provider.portal_login_password_hash:
            # Same lockout policy as admin users: 5 fails → 45 min lock.
            if provider.locked_until and provider.locked_until > datetime.now(timezone.utc):
                await _record_login_audit(
                    db, None, "PORTAL_LOGIN_FAILED_LOCKED", client_ip,
                    {"provider_id": str(provider.id), "provider_slug": provider.slug},
                )
                await db.commit()
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Account locked due to too many failed attempts. Try again later.",
                )

            if await verify_password_async(form_data.password, provider.portal_login_password_hash):
                provider.failed_login_attempts = 0
                provider.locked_until = None
                await _record_login_audit(
                    db, None, "PORTAL_LOGIN_SUCCESS", client_ip,
                    {"provider_id": str(provider.id), "provider_slug": provider.slug},
                )
                await db.commit()
                # Valid client redirect! Return custom response bypassing TokenResponse
                return JSONResponse(content={
                    "client_redirect": True,
                    "slug": provider.slug,
                    "provider_name": provider.name,
                    "logo_url": provider.logo_url,
                    "pr_number": provider.pr_number,
                })

            # Wrong portal password — count it and lock at the threshold.
            provider.failed_login_attempts = (provider.failed_login_attempts or 0) + 1
            if provider.failed_login_attempts >= MAX_FAILED_ATTEMPTS:
                provider.locked_until = datetime.now(timezone.utc) + timedelta(minutes=LOCKOUT_DURATION_MINUTES)
            await _record_login_audit(
                db, None, "PORTAL_LOGIN_FAILED", client_ip,
                {
                    "provider_id": str(provider.id),
                    "provider_slug": provider.slug,
                    "failed_attempts": provider.failed_login_attempts,
                    "locked_until": provider.locked_until.isoformat() if provider.locked_until else None,
                },
            )
            await db.commit()
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Incorrect email or password",
                headers={"WWW-Authenticate": "Bearer"},
            )

    # ── Check if locked out ──
    if user and user.locked_until and user.locked_until > datetime.now(timezone.utc):
        await _record_login_audit(db, user.id, "LOGIN_FAILED_LOCKED", client_ip)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account locked due to too many failed attempts. Try again later.",
        )

    # ── Validate credentials ──
    #
    # Evaluated BEFORE the `not user` test rather than after it. Written as
    # `not user or not await verify(...)` the bcrypt call is short-circuited
    # away for an address that does not exist, so an unknown email answered in
    # milliseconds and a real one took ~200 ms — an existence oracle for anyone
    # with a stopwatch and no credential. verify_password_or_dummy spends the
    # same time either way.
    password_ok = await verify_password_or_dummy(
        form_data.password, user.hashed_password if user else None
    )
    if not user or not password_ok:
        # Record failed attempt
        if user:
            user.failed_login_attempts = (user.failed_login_attempts or 0) + 1
            if user.failed_login_attempts >= MAX_FAILED_ATTEMPTS:
                user.locked_until = datetime.now(timezone.utc) + timedelta(minutes=LOCKOUT_DURATION_MINUTES)
            await _record_login_audit(
                db, user.id, "LOGIN_FAILED", client_ip,
                {"failed_attempts": user.failed_login_attempts, "locked_until": user.locked_until.isoformat() if user.locked_until else None},
            )
            await db.commit()

        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # ── Check if deactivated ──
    if not user.is_active:
        await _record_login_audit(db, user.id, "LOGIN_FAILED_INACTIVE", client_ip)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is deactivated",
        )

    # ── Success — reset failed attempts, issue tokens ──
    user.failed_login_attempts = 0
    user.locked_until = None

    access_token = create_access_token(data={"sub": str(user.id)})
    refresh_token = create_refresh_token(data={"sub": str(user.id)})

    await _record_login_audit(db, user.id, "LOGIN_SUCCESS", client_ip)
    await db.commit()

    logger.info("Login successful for user=%s", form_data.username)

    return TokenResponse(
        access_token=access_token,
        refresh_token=refresh_token,
    )


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(
    body: RefreshRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Rotate refresh token — blacklists the old one and issues new tokens."""
    payload = decode_token(body.refresh_token)
    if payload.get("type") != "refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid refresh token",
        )

    user_id = payload.get("sub")

    # ── Refresh-token REUSE means the token was stolen ──
    #
    # Rotation blacklists a refresh token the instant it is spent, so a valid
    # holder never presents the same one twice. A second presentation therefore
    # means two parties hold it — and the platform cannot tell which of them is
    # the legitimate user. Simply 401ing the replay (the previous behaviour)
    # rejects one request and leaves the attacker's freshly-rotated token, which
    # they obtained on the FIRST use, valid for its full seven days.
    #
    # The standard response is to assume compromise and revoke the whole family:
    # every token issued to this account before now dies, both parties are
    # logged out, and whoever knows the password gets back in. Logging out a
    # legitimate user on a rare race is a far better outcome than leaving a
    # thief with a week of authenticated access to patient records.
    old_jti = payload.get("jti")
    if old_jti and await is_token_blacklisted(old_jti, db):
        if user_id:
            replayed_user = await db.scalar(select(User).where(User.id == user_id))
            if replayed_user is not None:
                replayed_user.tokens_revoked_at = datetime.now(timezone.utc)
                await _record_login_audit(
                    db, replayed_user.id, "REFRESH_TOKEN_REUSE_REVOKED",
                    get_trusted_client_ip(request),
                    {"jti": old_jti,
                     "note": "Blacklisted refresh token replayed — all sessions revoked"},
                )
                await db.commit()
                logger.warning(
                    "Refresh token REUSE for user=%s (jti=%s) — revoked all sessions",
                    user_id, old_jti,
                )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token has been revoked",
        )

    # Ensure user still exists in the database (prevents infinite loop after a DB wipe)
    user = await db.scalar(select(User).where(User.id == user_id))
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User no longer exists",
        )

    # A deactivated account must stop refreshing immediately. Without this a
    # disabled user keeps minting fresh token pairs for the refresh token's
    # remaining 7 days; get_current_user would reject the resulting access
    # tokens, but the credential should die at the source, not downstream.
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account is deactivated",
        )

    # A refresh token from before a mass revocation must not mint anything.
    # Without this the family revocation above stops access tokens but leaves
    # the refresh credential able to issue fresh ones — revoking nothing.
    if token_is_revoked_by_family(payload, user.tokens_revoked_at):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session revoked. Please sign in again.",
        )

    # Blacklist the old refresh token so it can't be reused
    if old_jti:
        exp = datetime.fromtimestamp(payload.get("exp", 0), tz=timezone.utc)
        await blacklist_token(old_jti, user_id, "refresh", exp, db)

    access_token = create_access_token(data={"sub": user_id})
    new_refresh_token = create_refresh_token(data={"sub": user_id})

    await db.commit()

    return TokenResponse(
        access_token=access_token,
        refresh_token=new_refresh_token,
    )


@router.post("/logout")
async def logout(
    request: Request,
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
):
    """
    Server-side logout — revokes the current access token.
    The frontend should also send the refresh token in the body for full revocation.
    """
    # Revoke the access token
    payload = decode_token(token)
    jti = payload.get("jti")
    user_id = payload.get("sub")
    if jti:
        exp = datetime.fromtimestamp(payload.get("exp", 0), tz=timezone.utc)
        await blacklist_token(jti, user_id, "access", exp, db)

    # Optionally revoke the refresh token if sent in body
    try:
        body = await request.json()
        refresh_token_str = body.get("refresh_token")
        if refresh_token_str:
            try:
                ref_payload = decode_token(refresh_token_str)
                ref_jti = ref_payload.get("jti")
                if ref_jti:
                    ref_exp = datetime.fromtimestamp(ref_payload.get("exp", 0), tz=timezone.utc)
                    await blacklist_token(ref_jti, user_id, "refresh", ref_exp, db)
            except HTTPException:
                pass  # Refresh token already expired — that's fine
    except Exception:
        pass  # No body sent — just revoke the access token

    await db.commit()

    # The response cache answers a HIT before the route runs, so its auth
    # dependency never executes. Without this purge a just-logged-out token
    # keeps reading cached data until the entry expires (up to 5 minutes).
    try:
        from app.core.response_cache import purge_session_cache
        dropped = purge_session_cache(request.headers.get("Authorization", ""))
        if dropped:
            logger.info("Logout purged %d cached responses", dropped)
    except Exception:  # never let cache housekeeping break logout
        pass

    client_ip = get_trusted_client_ip(request)
    logger.info("User %s logged out from ip=%s", user_id, client_ip)

    return {"message": "Logged out successfully"}


@router.get("/me", response_model=UserProfile)
async def get_me(current_user: User = Depends(get_current_user)):
    """Return the current authenticated user's profile."""
    return UserProfile(
        id=str(current_user.id),
        email=current_user.email,
        full_name=current_user.full_name,
        role=current_user.role.value,
        bhf_practice_number=current_user.bhf_practice_number,
        is_active=current_user.is_active,
        # `or` would treat an EMPTY list as "unset" and grant EVERY permission —
        # so deliberately stripping a user to no permissions used to hand them
        # the full set. Only a genuine NULL means "not configured".
        permissions=(list(ALL_PERMISSIONS) if current_user.permissions is None
                     else current_user.permissions),
    )
