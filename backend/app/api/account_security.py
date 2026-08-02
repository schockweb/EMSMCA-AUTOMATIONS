"""
Account Security API — admin view of locked-out accounts + manual unlock.

When a service-provider portal login or a crew-member login exceeds the failed-
login threshold, the account is locked for a cool-off period (see auth.py and
crew_auth.py). This router lets an EMSMCA admin SEE who is currently locked —
so they can phone the provider and verify it was really them — and CLEAR the
lock immediately instead of making them wait out the timer, so they can get
back into their ePRF.
"""
from __future__ import annotations
import uuid
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.user import User, UserRole
from app.models.service_provider import ServiceProvider
from app.models.crew_member import CrewMember
from app.utils.client_ip import get_trusted_client_ip
from app.utils.security import require_role

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/account-security", tags=["Account Security"])


class LockedAccount(BaseModel):
    account_type: str            # 'provider' | 'crew'
    id: str
    name: str
    login_email: str | None = None
    phone: str | None = None
    provider_name: str | None = None   # for crew: the provider they belong to
    failed_attempts: int = 0
    locked_until: str | None = None


class UnlockRequest(BaseModel):
    account_type: str
    id: str


@router.get("/locked", response_model=list[LockedAccount])
async def list_locked_accounts(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)),
):
    """Every provider + crew account currently inside its lockout window."""
    now = datetime.now(timezone.utc)
    out: list[LockedAccount] = []

    prov_res = await db.execute(
        select(ServiceProvider).where(
            ServiceProvider.locked_until.isnot(None),
            ServiceProvider.locked_until > now,
        )
    )
    for p in prov_res.scalars():
        out.append(LockedAccount(
            account_type="provider",
            id=str(p.id),
            name=p.name,
            login_email=p.portal_login_email,
            phone=p.phone,
            failed_attempts=p.failed_login_attempts or 0,
            locked_until=p.locked_until.isoformat() if p.locked_until else None,
        ))

    crew_res = await db.execute(
        select(CrewMember, ServiceProvider.name)
        .join(ServiceProvider, CrewMember.provider_id == ServiceProvider.id)
        .where(
            CrewMember.locked_until.isnot(None),
            CrewMember.locked_until > now,
        )
    )
    for c, provider_name in crew_res.all():
        out.append(LockedAccount(
            account_type="crew",
            id=str(c.id),
            name=c.full_name,
            login_email=c.email,
            phone=c.phone,
            provider_name=provider_name,
            failed_attempts=c.failed_login_attempts or 0,
            locked_until=c.locked_until.isoformat() if c.locked_until else None,
        ))

    out.sort(key=lambda a: a.locked_until or "", reverse=True)
    return out


@router.post("/unlock")
async def unlock_account(
    body: UnlockRequest,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)),
):
    """Clear the lockout on a provider or crew account so they can log in now.

    Resets the failed-attempt counter and the lock timestamp. Should only be
    done after the admin has verified out-of-band (phone call) that the lockout
    was the genuine user, not an attacker.
    """
    try:
        oid = uuid.UUID(body.id)
    except (ValueError, AttributeError):
        raise HTTPException(400, "Invalid account id")

    if body.account_type == "provider":
        obj = (await db.execute(
            select(ServiceProvider).where(ServiceProvider.id == oid)
        )).scalar_one_or_none()
    elif body.account_type == "crew":
        obj = (await db.execute(
            select(CrewMember).where(CrewMember.id == oid)
        )).scalar_one_or_none()
    else:
        raise HTTPException(400, "account_type must be 'provider' or 'crew'")

    if not obj:
        raise HTTPException(404, "Account not found")

    obj.failed_login_attempts = 0
    obj.locked_until = None
    await db.commit()
    logger.info(
        "Admin %s unlocked %s account %s", getattr(_admin, "email", "?"),
        body.account_type, body.id,
    )
    return {"message": "Account unlocked", "id": body.id, "account_type": body.account_type}


class RevokeSessionsRequest(BaseModel):
    account_type: str            # 'provider' | 'crew' | 'user'
    id: str
    reason: str | None = None


@router.post("/revoke-sessions")
async def revoke_sessions(
    body: RevokeSessionsRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)),
):
    """Kill every session for one account, including ones nobody has seen.

    THE CASE THIS EXISTS FOR
    ------------------------
    A tablet is left at a hospital, or a phone is stolen mid-shift, or a crew
    member is dismissed and walks out still logged in. Until now there was no
    answer: `POST /api/crew/logout` revokes the token IN THE CALLER'S HAND, and
    the whole problem is that the token is in somebody else's hand. Deactivating
    the crew member works for crew tokens but does nothing about a provider's
    device grants, and nothing at all can be done about an admin refresh token
    once it has been copied. The honest answer was "wait twelve hours".

    This stamps a cutoff on the identity. Every token minted before this instant
    stops working on its next request — the copy included, because the check is
    on issue time rather than on a list of tokens we happen to know about.

    Account types map to the three token families:
      user     — back-office access + refresh tokens
      crew     — 12-hour shift tokens for one practitioner
      provider — every device unlock grant for the whole company, which is what
                 you want after the shared company password leaks. Rotate the
                 password AND call this; rotating alone leaves the outstanding
                 grants able to mint fresh crew tokens.

    Not reversible and not meant to be: the holders sign in again. For a
    provider that means every crew tablet re-enters the company password.
    """
    try:
        oid = uuid.UUID(body.id)
    except (ValueError, AttributeError):
        raise HTTPException(400, "Invalid account id")

    model = {
        "provider": ServiceProvider,
        "crew": CrewMember,
        "user": User,
    }.get(body.account_type)
    if model is None:
        raise HTTPException(400, "account_type must be 'provider', 'crew' or 'user'")

    obj = (await db.execute(select(model).where(model.id == oid))).scalar_one_or_none()
    if not obj:
        raise HTTPException(404, "Account not found")

    now = datetime.now(timezone.utc)
    obj.tokens_revoked_at = now

    # Audited: this is an administrator forcibly ending someone else's access to
    # patient records, which an investigator needs to see attributed.
    db.add(AuditLog(
        user_id=_admin.id,
        action="SESSIONS_REVOKED",
        entity_type=f"auth_{body.account_type}",
        entity_id=oid,
        details={
            "account_type": body.account_type,
            "revoked_by": getattr(_admin, "email", None),
            "reason": (body.reason or "")[:500] or None,
        },
        ip_address=get_trusted_client_ip(request),
    ))
    await db.commit()

    # The response cache answers a HIT before the route's auth dependency runs,
    # so without this the revoked token keeps receiving cached 200s until the
    # entry expires. The entries are keyed by a fingerprint of tokens we never
    # see, so they cannot be purged selectively — and a revocation that takes
    # five minutes to bite is not a revocation.
    try:
        from app.core.response_cache import purge_all_cached_responses
        purge_all_cached_responses()
    except Exception:
        pass

    logger.warning(
        "Admin %s REVOKED ALL SESSIONS for %s %s (reason: %s)",
        getattr(_admin, "email", "?"), body.account_type, body.id, body.reason or "—",
    )
    return {
        "message": "All sessions revoked",
        "id": body.id,
        "account_type": body.account_type,
        "revoked_at": now.isoformat(),
    }
