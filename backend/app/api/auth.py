"""
Auth API — Login (with account lockout), Token Refresh (with rotation blacklisting),
Logout (server-side token revocation), and Current User Profile.
"""
from __future__ import annotations
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, status, Request
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User
from app.models.audit_log import AuditLog
from app.schemas.auth import LoginRequest, TokenResponse, RefreshRequest, UserProfile
from app.models.user import ALL_PERMISSIONS
from app.utils.security import (
    verify_password,
    create_access_token,
    create_refresh_token,
    decode_token,
    get_current_user,
    blacklist_token,
    is_token_blacklisted,
    MAX_FAILED_ATTEMPTS,
    LOCKOUT_DURATION_MINUTES,
    oauth2_scheme,
)

import logging
logger = logging.getLogger("ems.auth")

router = APIRouter(prefix="/api/auth", tags=["Authentication"])


def _get_client_ip(request: Request) -> str:
    """Extract client IP, respecting X-Forwarded-For from reverse proxy."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


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
    client_ip = _get_client_ip(request)
    logger.info("Login attempt for user=%s from ip=%s", form_data.username, client_ip)

    result = await db.execute(select(User).where(User.email == form_data.username))
    user = result.scalar_one_or_none()

    # ── Check if account is locked ──
    if user and user.locked_until:
        if datetime.now(timezone.utc) < user.locked_until:
            remaining = int((user.locked_until - datetime.now(timezone.utc)).total_seconds() / 60)
            logger.warning("Blocked login for locked account user=%s, %d min remaining", form_data.username, remaining)
            await _record_login_audit(
                db, user.id, "LOGIN_BLOCKED_LOCKOUT", client_ip,
                {"reason": f"Account locked for {remaining} more minutes"},
            )
            await db.commit()
            raise HTTPException(
                status_code=status.HTTP_423_LOCKED,
                detail=f"Account is locked due to too many failed attempts. Try again in {remaining} minutes.",
            )
        else:
            # Lockout expired — reset
            user.failed_login_attempts = 0
            user.locked_until = None

    # ── Validate credentials ──
    if not user or not verify_password(form_data.password, user.hashed_password):
        # Record failed attempt
        if user:
            user.failed_login_attempts = (user.failed_login_attempts or 0) + 1

            if user.failed_login_attempts >= MAX_FAILED_ATTEMPTS:
                user.locked_until = datetime.now(timezone.utc) + timedelta(minutes=LOCKOUT_DURATION_MINUTES)
                logger.warning(
                    "Account locked: user=%s after %d failed attempts. Locked for %d min.",
                    form_data.username, user.failed_login_attempts, LOCKOUT_DURATION_MINUTES,
                )
                await _record_login_audit(
                    db, user.id, "ACCOUNT_LOCKED", client_ip,
                    {"failed_attempts": user.failed_login_attempts, "lockout_minutes": LOCKOUT_DURATION_MINUTES},
                )
                await db.commit()
                raise HTTPException(
                    status_code=status.HTTP_423_LOCKED,
                    detail=f"Account locked after {MAX_FAILED_ATTEMPTS} failed attempts. Try again in {LOCKOUT_DURATION_MINUTES} minutes.",
                )

            await _record_login_audit(
                db, user.id, "LOGIN_FAILED", client_ip,
                {"failed_attempts": user.failed_login_attempts},
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
    db: AsyncSession = Depends(get_db),
):
    """Rotate refresh token — blacklists the old one and issues new tokens."""
    payload = decode_token(body.refresh_token)
    if payload.get("type") != "refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid refresh token",
        )

    # Check if old refresh token has been revoked
    old_jti = payload.get("jti")
    if old_jti and await is_token_blacklisted(old_jti, db):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token has been revoked",
        )

    user_id = payload.get("sub")

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

    client_ip = _get_client_ip(request)
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
        permissions=current_user.permissions or list(ALL_PERMISSIONS),
    )
