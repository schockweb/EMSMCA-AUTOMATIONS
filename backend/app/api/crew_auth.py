"""
Crew Authentication API — Login, profile, and password management for crew members.
Separate from the admin auth system — crew get a JWT with provider_id + crew_id claims.
"""
from __future__ import annotations
import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.crew_member import CrewMember
from app.models.service_provider import ServiceProvider
from app.models.vehicle import Vehicle
from app.services.vehicle_occupancy import claim_vehicle, release_crew
from app.utils.client_ip import get_trusted_client_ip
from app.utils.login_throttle import (
    clear_source_failures,
    is_source_blocked,
    register_source_failure,
)
from app.utils.security import (
    verify_password,
    verify_password_async,
    verify_password_or_dummy,
    token_is_revoked_by_family,
    hash_password,
    create_access_token,
    decode_token,
    MAX_FAILED_ATTEMPTS,
    LOCKOUT_DURATION_MINUTES,
    blacklist_token,
    is_token_blacklisted,
    validate_password_complexity,
)

logger = logging.getLogger("ems.crew_auth")

# Shift tokens live long enough to cover a full EMS shift with breaks / device sleep.
# The tablet may go idle while the crew attends to a patient — the session must persist
# until the physical End Shift button is pressed.
CREW_SHIFT_TOKEN_HOURS = 12

router = APIRouter(prefix="/api/crew", tags=["Crew Authentication"])

crew_oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/crew/login", auto_error=False)


# ── Schemas ──────────────────────────────────────────────────

class CrewLoginRequest(BaseModel):
    email: str
    password: str

class CrewLoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    crew_id: str
    crew_name: str
    provider_id: str
    provider_name: str
    provider_slug: str
    qualification: str
    hpcsa_number: str | None = None
    role: str = "crew"

class CrewProfileResponse(BaseModel):
    id: str
    email: str
    full_name: str
    initials: str | None = None
    hpcsa_number: str | None = None
    qualification: str
    phone: str | None = None
    provider_id: str
    provider_name: str
    provider_slug: str
    provider_pr_number: str | None = None


# ── Dependency: Get current crew member from JWT ─────────────

async def get_current_crew(
    token: str = Depends(crew_oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> CrewMember:
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_token(token)
    crew_id = payload.get("crew_id")
    if not crew_id or payload.get("token_scope") != "crew":
        raise HTTPException(status_code=401, detail="Invalid crew token")

    # Honour revocation. The admin dependency has always done this; the crew one
    # did not, so a crew token could not be invalidated by ANY means short of
    # waiting out its 12 hours — End Shift only cleared localStorage.
    jti = payload.get("jti")
    if jti and await is_token_blacklisted(jti, db):
        raise HTTPException(status_code=401, detail="Session ended")
    # Crew row AND the employer's active flag in ONE round-trip. Every crew
    # request passes through here, so this must not become two queries.
    #
    # The provider flag is checked because a deactivated CLIENT must stop
    # working immediately, not in twelve hours. Deactivation cascades to the
    # crew rows, which alone would be enough — but a back-office admin can
    # re-enable an individual crew member, and every other gate that could catch
    # that (portal-login, portal-unlock, shift-start) is a SIGN-IN gate. A tablet
    # already holding a token never touches one again for the life of that token.
    row = (await db.execute(
        select(CrewMember, ServiceProvider.is_active)
        .join(ServiceProvider, ServiceProvider.id == CrewMember.provider_id)
        .where(CrewMember.id == crew_id)
    )).first()
    crew = row[0] if row else None
    if not crew or not crew.is_active:
        raise HTTPException(status_code=401, detail="Crew member not found or inactive")
    if not row[1]:
        raise HTTPException(status_code=401, detail="This service is no longer active. Contact your administrator.")

    # Bulk revocation — the lost-tablet case. Blacklisting by JTI can only kill
    # a token someone presents; this kills every session minted for this
    # practitioner before the cutoff, including copies nobody has seen.
    if token_is_revoked_by_family(payload, getattr(crew, "tokens_revoked_at", None)):
        raise HTTPException(status_code=401, detail="Session revoked. Sign in again.")
    return crew


# ── Endpoints ────────────────────────────────────────────────

def _crew_login_audit(db: AsyncSession, crew: CrewMember, action: str, ip: str, details: dict | None = None):
    """Audit-log a crew login event. user_id stays NULL — crew aren't Users."""
    db.add(AuditLog(
        user_id=None,
        action=action,
        entity_type="auth_crew",
        entity_id=crew.id,
        details={"crew_email": crew.email, "provider_id": str(crew.provider_id), **(details or {})},
        ip_address=ip,
    ))


@router.post("/login", response_model=CrewLoginResponse)
async def crew_login(body: CrewLoginRequest, request: Request, db: AsyncSession = Depends(get_db)):
    """Authenticate a crew member and return a JWT. Enforces account lockout."""
    client_ip = get_trusted_client_ip(request)
    # Case-INSENSITIVE match, comparing lower() on both sides rather than
    # lower-casing only the typed value against a stored value that may carry
    # capitals. The sign-in name is now stored exactly as the administrator
    # typed it (so "EMSMCAadmin" displays that way), and the crew member types
    # it on a tablet whose keyboard auto-capitalises the first letter. Matching
    # exactly on a lower-cased input would mean an account created or edited
    # with any capital could never sign in — a silent lockout, discovered only
    # when someone cannot start a shift.
    result = await db.execute(
        select(CrewMember).where(
            func.lower(CrewMember.email) == body.email.strip().lower()
        )
    )
    crew = result.scalar_one_or_none()

    # Same lockout policy as admin users: 5 fails → 45 min lock.
    if crew and crew.locked_until and crew.locked_until > datetime.now(timezone.utc):
        _crew_login_audit(db, crew, "CREW_LOGIN_FAILED_LOCKED", client_ip)
        await db.commit()
        raise HTTPException(
            status_code=403,
            detail="Account locked due to too many failed attempts. Try again later.",
        )

    # Run bcrypt in a thread executor so the event loop (and DB pool) isn't
    # blocked by the ~200 ms CPU-bound hash check.
    #
    # Computed before the `not crew` test so an unknown address costs the same
    # as a real one. Short-circuiting made this endpoint an oracle for "does
    # this paramedic have a login here" — which discloses who works for which
    # ambulance service to an anonymous caller. See verify_password_or_dummy.
    password_ok = await verify_password_or_dummy(
        body.password, crew.hashed_password if crew else None
    )
    if not crew or not password_ok:
        if crew:
            crew.failed_login_attempts = (crew.failed_login_attempts or 0) + 1
            if crew.failed_login_attempts >= MAX_FAILED_ATTEMPTS:
                crew.locked_until = datetime.now(timezone.utc) + timedelta(minutes=LOCKOUT_DURATION_MINUTES)
            _crew_login_audit(db, crew, "CREW_LOGIN_FAILED", client_ip, {
                "failed_attempts": crew.failed_login_attempts,
                "locked_until": crew.locked_until.isoformat() if crew.locked_until else None,
            })
            await db.commit()
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not crew.is_active:
        raise HTTPException(status_code=403, detail="Account deactivated. Contact your admin.")

    # Load provider
    provider_result = await db.execute(
        select(ServiceProvider).where(ServiceProvider.id == crew.provider_id)
    )
    provider = provider_result.scalar_one_or_none()
    if not provider or not provider.is_active:
        raise HTTPException(status_code=403, detail="Service provider is inactive")

    # Success — reset lockout counters, update last_login
    crew.failed_login_attempts = 0
    crew.locked_until = None
    crew.last_login = datetime.now(timezone.utc)
    _crew_login_audit(db, crew, "CREW_LOGIN_SUCCESS", client_ip)
    await db.commit()

    # Create JWT with crew-specific claims
    token = create_access_token({
        "sub": str(crew.id),
        "crew_id": str(crew.id),
        "provider_id": str(provider.id),
        "provider_slug": provider.slug,
        "role": crew.role,
        "token_scope": "crew",
    })

    logger.info("Crew login: %s (%s) for provider %s", crew.full_name, crew.email, provider.name)

    return CrewLoginResponse(
        access_token=token,
        crew_id=str(crew.id),
        crew_name=crew.full_name,
        provider_id=str(provider.id),
        provider_name=provider.name,
        provider_slug=provider.slug,
        qualification=crew.qualification,
        hpcsa_number=crew.hpcsa_number,
        role=crew.role,
    )


@router.get("/me", response_model=CrewProfileResponse)
async def crew_profile(
    crew: CrewMember = Depends(get_current_crew),
    db: AsyncSession = Depends(get_db),
):
    """Get the current crew member's profile."""
    provider_result = await db.execute(
        select(ServiceProvider).where(ServiceProvider.id == crew.provider_id)
    )
    provider = provider_result.scalar_one()

    return CrewProfileResponse(
        id=str(crew.id),
        email=crew.email,
        full_name=crew.full_name,
        initials=crew.initials,
        hpcsa_number=crew.hpcsa_number,
        qualification=crew.qualification,
        phone=crew.phone,
        provider_id=str(provider.id),
        provider_name=provider.name,
        provider_slug=provider.slug,
        provider_pr_number=provider.pr_number,
    )


class CrewPasswordChange(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password")
async def crew_change_password(
    body: CrewPasswordChange,
    crew: CrewMember = Depends(get_current_crew),
    db: AsyncSession = Depends(get_db),
):
    """Change the crew member's password.

    Both fields arrive in the REQUEST BODY. They were previously bare scalar
    parameters, which FastAPI binds from the QUERY STRING — so every password
    change sent both the old and the new password in the URL, where they were
    recorded verbatim in nginx access logs, browser history and any referrer.
    """
    # Thread-offloaded: bcrypt is ~200ms of CPU and would stall the event loop.
    if not await verify_password_async(body.current_password, crew.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    try:
        validate_password_complexity(body.new_password)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    crew.hashed_password = hash_password(body.new_password)
    crew.failed_login_attempts = 0
    crew.locked_until = None
    await db.commit()
    return {"message": "Password updated successfully"}


# ── HPCSA-based shift-start lookup (no password needed) ──────

# ── Portal grant: proof the company password was entered on this device ──────
#
# WHY THIS EXISTS
# ---------------
# `shift-start-by-id` and `lookup-hpcsa` mint 12-hour crew tokens that can read,
# edit and delete Patient Report Forms. Both used to run with NO authentication
# at all: their docstrings asserted "the company-wide portal login already
# authenticated the user", but nothing on the server ever checked that, and the
# crew UI never performed such a login. Combined with the public crew list
# (which returned crew UUIDs and HPCSA numbers), anyone on the internet could
# collect an ID and exchange it for a patient-record token.
#
# A device now has to prove the company portal password was entered before it
# can mint a crew session. The grant is provider-bound and shift-length, so a
# crew enters the company password once per device per shift.
PORTAL_GRANT_HOURS = 12
PORTAL_GRANT_SCOPE = "portal_grant"

portal_grant_scheme = OAuth2PasswordBearer(tokenUrl="/api/crew/portal-unlock", auto_error=False)


class PortalUnlockRequest(BaseModel):
    provider_slug: str
    password: str


class PortalUnlockResponse(BaseModel):
    grant: str
    expires_in_hours: int = PORTAL_GRANT_HOURS
    provider_name: str
    provider_slug: str


async def require_portal_grant(
    provider_slug: str,
    token: str | None,
    db: AsyncSession,
) -> ServiceProvider:
    """Resolve the provider and require a valid grant bound to it.

    Accepts EITHER a portal grant or an already-valid crew token for the same
    provider — the latter so a crew mid-shift can still add a colleague without
    re-entering the company password.
    """
    result = await db.execute(
        select(ServiceProvider).where(
            ServiceProvider.slug == provider_slug.strip().lower(),
            ServiceProvider.is_active == True,  # noqa: E712
        )
    )
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    if not token:
        raise HTTPException(
            status_code=401,
            detail="This device is not unlocked. Enter the company password to start a shift.",
        )

    payload = decode_token(token)
    scope = payload.get("token_scope")
    if scope not in (PORTAL_GRANT_SCOPE, "crew"):
        raise HTTPException(status_code=401, detail="Invalid device unlock token")

    # A refresh token must not unlock a device. Both token families are signed
    # with the same key, so without this an admin's 7-day refresh credential
    # would satisfy the gate.
    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Invalid device unlock token")

    # Revocation must be honoured here too. This gate accepts an existing crew
    # token as proof of unlock (so a mid-shift crew can add a colleague without
    # re-entering the company password) but never consulted the blacklist — so a
    # crew token revoked at End Shift could still be exchanged for a FRESH
    # 12-hour patient-record token, making logout reversible for the token's
    # remaining lifetime.
    jti = payload.get("jti")
    if jti and await is_token_blacklisted(jti, db):
        raise HTTPException(status_code=401, detail="This device unlock has been revoked.")

    if str(payload.get("provider_id")) != str(provider.id):
        # Never let one company's unlock reach another company's crew.
        raise HTTPException(status_code=403, detail="Token does not belong to this provider")

    # Bulk revocation, checked on BOTH shapes this gate accepts.
    #
    # Rotating a leaked company password does not by itself invalidate the
    # 12-hour grants already minted from the old one, and each surviving grant
    # still mints fresh crew tokens — so without this the rotation buys nothing
    # until the last grant expires.
    if token_is_revoked_by_family(payload, getattr(provider, "tokens_revoked_at", None)):
        raise HTTPException(
            status_code=401,
            detail="This device unlock has been revoked. Enter the company password again.",
        )
    if scope == "crew":
        holder = await db.scalar(
            select(CrewMember).where(CrewMember.id == payload.get("crew_id"))
        )
        if holder is not None and token_is_revoked_by_family(
            payload, getattr(holder, "tokens_revoked_at", None)
        ):
            raise HTTPException(status_code=401, detail="Session revoked. Sign in again.")

    return provider


@router.post("/portal-unlock", response_model=PortalUnlockResponse)
async def portal_unlock(body: PortalUnlockRequest, request: Request, db: AsyncSession = Depends(get_db)):
    """Exchange the company portal password for a short-lived, provider-bound grant.

    Rate-limited as an auth path and subject to the same 5-fail/45-min lockout as
    the portal login, since it verifies the same secret.
    """
    client_ip = get_trusted_client_ip(request)
    result = await db.execute(
        select(ServiceProvider).where(
            ServiceProvider.slug == body.provider_slug.strip().lower(),
            ServiceProvider.is_active == True,  # noqa: E712
        )
    )
    provider = result.scalar_one_or_none()

    # Uniform failure for unknown provider / unset password / wrong password so
    # this cannot be used to enumerate which companies exist or are configured.
    generic = HTTPException(status_code=401, detail="Incorrect company password")

    # The uniform 401 below only hides the DIFFERENCE if it also costs the same.
    # Returning immediately for an unknown or unconfigured slug skipped bcrypt
    # entirely, so the response time distinguished exactly what the shared error
    # message was written to conceal: which companies exist on this platform.
    if not provider or not provider.portal_login_password_hash:
        await verify_password_or_dummy(body.password, None)
        raise generic

    # Blocked per SOURCE, not per provider.
    #
    # A provider-wide lock here was a clinical-availability weapon: the slug list
    # is public and unauthenticated, so five wrong guesses shut an entire
    # ambulance service out of starting shifts for 45 minutes, and a loop kept
    # every company out indefinitely. Throttling the address that is guessing
    # keeps the brute-force protection and removes the denial of service — a
    # crew on another connection is never affected by an attacker's failures.
    # See app/utils/login_throttle.py.
    if await is_source_blocked("portal", str(provider.id), client_ip):
        raise HTTPException(
            status_code=403,
            detail="Too many incorrect attempts from this device. Try again later.",
        )

    if not await verify_password_async(body.password, provider.portal_login_password_hash):
        source_failures = await register_source_failure("portal", str(provider.id), client_ip)
        # The provider-wide counter is still maintained, but only as a RECORD —
        # it drives the admin Locked-Accounts view and alerting. It no longer
        # decides whether a request is refused.
        provider.failed_login_attempts = (provider.failed_login_attempts or 0) + 1
        db.add(AuditLog(
            user_id=None, action="PORTAL_UNLOCK_FAILED", entity_type="auth_portal",
            entity_id=provider.id, ip_address=client_ip,
            details={
                "provider_slug": provider.slug,
                "failed_attempts": provider.failed_login_attempts,
                "source_failures": source_failures,
            },
        ))
        await db.commit()
        raise generic

    await clear_source_failures("portal", str(provider.id), client_ip)
    provider.failed_login_attempts = 0
    provider.locked_until = None
    db.add(AuditLog(
        user_id=None, action="PORTAL_UNLOCK_SUCCESS", entity_type="auth_portal",
        entity_id=provider.id, ip_address=client_ip,
        details={"provider_slug": provider.slug},
    ))
    await db.commit()

    grant = create_access_token(
        {"sub": str(provider.id), "provider_id": str(provider.id),
         "provider_slug": provider.slug, "token_scope": PORTAL_GRANT_SCOPE},
        expires_delta=timedelta(hours=PORTAL_GRANT_HOURS),
    )
    logger.info("Portal unlocked for %s from ip=%s", provider.slug, client_ip)
    return PortalUnlockResponse(
        grant=grant, provider_name=provider.name, provider_slug=provider.slug,
    )


class ShiftLookupRequest(BaseModel):
    hpcsa_number: str
    full_name: str | None = None   # Optional — HPCSA is the sole identifier
    provider_slug: str

class ShiftLookupResponse(BaseModel):
    crew_id: str
    full_name: str
    hpcsa_number: str
    qualification: str
    provider_id: str
    provider_name: str
    provider_slug: str
    access_token: str
    token_type: str = "bearer"
    role: str = "crew"
    shift_started_at: str   # ISO timestamp

@router.post("/lookup-hpcsa", response_model=ShiftLookupResponse)
async def crew_lookup_by_hpcsa(
    body: ShiftLookupRequest,
    db: AsyncSession = Depends(get_db),
    grant: str | None = Depends(portal_grant_scheme),
):
    """Identify a crew member by HPCSA number for the shift-start flow.

    REQUIRES a device unlock (portal grant) or an existing crew token for the
    same provider. An HPCSA number is a semi-public professional registration
    number and this endpoint mints a 12-hour patient-record token, so it must
    never stand on the HPCSA number alone.
    """
    provider = await require_portal_grant(body.provider_slug, grant, db)

    crew_result = await db.execute(
        select(CrewMember).where(
            CrewMember.hpcsa_number == body.hpcsa_number.strip().upper(),
            CrewMember.provider_id == provider.id,
            CrewMember.is_active == True,
        )
    )
    crew = crew_result.scalar_one_or_none()

    if not crew:
        raise HTTPException(
            status_code=404,
            detail=f"No active crew member found with HPCSA {body.hpcsa_number.strip().upper()} for this provider."
        )

    # Optional name cross-check — only runs if name was submitted
    if body.full_name:
        stored_first = (crew.full_name or "").split()[0].lower()
        submitted = body.full_name.strip().lower()
        if stored_first and stored_first not in submitted:
            raise HTTPException(
                status_code=401,
                detail="Name does not match HPCSA records. Please check your details."
            )

    # Update last_login and record shift start
    now = datetime.now(timezone.utc)
    crew.last_login = now
    await db.commit()

    token = create_access_token(
        {
            "sub": str(crew.id),
            "crew_id": str(crew.id),
            "provider_id": str(provider.id),
            "provider_slug": provider.slug,
            "role": crew.role,
            "token_scope": "crew",
        },
        expires_delta=timedelta(hours=CREW_SHIFT_TOKEN_HOURS),
    )

    logger.info("Shift start: %s (HPCSA: %s) for provider %s", crew.full_name, crew.hpcsa_number, provider.name)

    return ShiftLookupResponse(
        crew_id=str(crew.id),
        full_name=crew.full_name,
        hpcsa_number=crew.hpcsa_number or "",
        qualification=crew.qualification,
        provider_id=str(provider.id),
        provider_name=provider.name,
        provider_slug=provider.slug,
        access_token=token,
        role=crew.role,
        shift_started_at=now.isoformat(),
    )


class ShiftStartByIdRequest(BaseModel):
    crew_id: str
    provider_slug: str
    partner_name: str | None = None   # Name of the assisting crew member
    vehicle_id: str | None = None
    vehicle_callsign: str | None = None

class ShiftStartByIdResponse(BaseModel):
    crew_id: str
    full_name: str
    qualification: str
    provider_id: str
    provider_name: str
    provider_slug: str
    hpcsa_number: str | None = None
    access_token: str
    token_type: str = "bearer"
    role: str = "crew"
    partner_name: str | None = None
    vehicle_id: str | None = None
    vehicle_callsign: str | None = None
    shift_started_at: str

@router.post("/shift-start-by-id", response_model=ShiftStartByIdResponse)
async def shift_start_by_id(
    body: ShiftStartByIdRequest,
    db: AsyncSession = Depends(get_db),
    grant: str | None = Depends(portal_grant_scheme),
):
    """Start a shift for a crew member selected by name from a dropdown.

    REQUIRES a device unlock (portal grant) proving the company password was
    entered on this device, or an existing crew token for the same provider.
    Selecting a name is identification, not authentication — without this gate
    anyone holding a crew UUID could mint a 12-hour patient-record token.
    """
    provider = await require_portal_grant(body.provider_slug, grant, db)

    crew_result = await db.execute(
        select(CrewMember).where(
            CrewMember.id == body.crew_id,
            CrewMember.provider_id == provider.id,
            CrewMember.is_active == True,
        )
    )
    crew = crew_result.scalar_one_or_none()
    if not crew:
        raise HTTPException(status_code=404, detail="Crew member not found")

    now = datetime.now(timezone.utc)
    crew.last_login = now
    await db.commit()

    # Record the vehicle so the NEXT crew to tap it is told it is taken.
    # Advisory only — see app/models/crew_shift.py for why this is a warning
    # and not a lock. The vehicle is verified to belong to this provider first:
    # body.vehicle_id is client-supplied and was previously copied into the
    # token unchecked, so without this a tablet could claim an id from another
    # company's fleet and appear in their picker's warning.
    #
    # AFTER the commit above, in its own transaction, and swallowing everything.
    # Starting a shift is the one crew action that must never fail: if this ran
    # inside the same transaction, any error — a malformed id, or the
    # crew_shifts table not yet existing on a database the migration has not
    # reached — would poison the session, fail the commit, and stop every crew
    # in the company from signing on. A courtesy warning is not allowed to cost
    # that.
    if body.vehicle_id:
        try:
            vehicle = (await db.execute(
                select(Vehicle).where(
                    Vehicle.id == uuid.UUID(body.vehicle_id),
                    Vehicle.provider_id == provider.id,
                )
            )).scalar_one_or_none()
            if vehicle:
                await claim_vehicle(
                    db,
                    provider_id=provider.id,
                    crew_member_id=crew.id,
                    vehicle_id=vehicle.id,
                    vehicle_callsign=vehicle.callsign,
                    crew_name=crew.full_name,
                    partner_name=body.partner_name or None,
                )
                await db.commit()
        except Exception:
            logger.warning("Could not record vehicle claim at shift start", exc_info=True)
            await db.rollback()

    token = create_access_token(
        {
            "sub": str(crew.id),
            "crew_id": str(crew.id),
            "provider_id": str(provider.id),
            "provider_slug": provider.slug,
            "role": crew.role,
            "token_scope": "crew",
            "partner_name": body.partner_name or "",
            "vehicle_id": body.vehicle_id or "",
            "vehicle_callsign": body.vehicle_callsign or "",
        },
        expires_delta=timedelta(hours=CREW_SHIFT_TOKEN_HOURS),
    )

    logger.info(
        "Shift start (by ID): %s for provider %s | partner: %s | vehicle: %s",
        crew.full_name, provider.name, body.partner_name or "—", body.vehicle_callsign or "—"
    )

    return ShiftStartByIdResponse(
        crew_id=str(crew.id),
        full_name=crew.full_name,
        qualification=crew.qualification,
        provider_id=str(provider.id),
        provider_name=provider.name,
        provider_slug=provider.slug,
        hpcsa_number=crew.hpcsa_number,
        access_token=token,
        role=crew.role,
        partner_name=body.partner_name,
        vehicle_id=body.vehicle_id,
        vehicle_callsign=body.vehicle_callsign,
        shift_started_at=now.isoformat(),
    )


class ClaimVehicleRequest(BaseModel):
    vehicle_id: str


@router.post("/claim-vehicle")
async def claim_vehicle_endpoint(
    body: ClaimVehicleRequest,
    crew: CrewMember = Depends(get_current_crew),
    db: AsyncSession = Depends(get_db),
):
    """Record that the caller is on this vehicle for the rest of their shift.

    The dashboard's shift-start flow authenticates through `lookup-hpcsa`,
    which never receives a vehicle — the crew picks one first and it is only
    kept on the device. Without this call that entire flow would claim nothing,
    and the warning would fire for the login-page wizard alone.

    Deliberately separate from shift start rather than bolted onto
    `lookup-hpcsa`: that endpoint is also used to add a colleague mid-shift and
    to resolve each extra crew member, so writing a claim inside it would
    record a vehicle takeover every time a third crew member was added.

    Scoped to the caller's own provider. A crew cannot claim, and therefore
    cannot appear to occupy, another company's ambulance.
    """
    try:
        vid = uuid.UUID(body.vehicle_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid vehicle id")

    vehicle = (await db.execute(
        select(Vehicle).where(
            Vehicle.id == vid,
            Vehicle.provider_id == crew.provider_id,
        )
    )).scalar_one_or_none()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    await claim_vehicle(
        db,
        provider_id=crew.provider_id,
        crew_member_id=crew.id,
        vehicle_id=vehicle.id,
        vehicle_callsign=vehicle.callsign,
        crew_name=crew.full_name,
    )
    await db.commit()
    return {"message": "Vehicle claimed", "vehicle_callsign": vehicle.callsign}


@router.post("/logout")
async def crew_logout(
    token: str = Depends(crew_oauth2_scheme),
    db: AsyncSession = Depends(get_db),
):
    """End a crew session server-side.

    Until this existed a crew token could not be revoked at all: clearing the
    device only removed the local copy, so a token captured from a lost or
    shared tablet stayed valid for its full 12 hours and no administrator could
    do anything about it.
    """
    if not token:
        return {"message": "No active session"}
    try:
        payload = decode_token(token)
    except HTTPException:
        return {"message": "Session already invalid"}

    jti = payload.get("jti")
    if jti:
        exp = datetime.fromtimestamp(payload.get("exp", 0), tz=timezone.utc)
        await blacklist_token(jti, payload.get("crew_id"), "access", exp, db)
        await db.commit()

    # Free the ambulance. A session that has been revoked cannot be in use, so
    # holding the claim open would warn the next crew off a vehicle that is
    # standing free — the failure mode this feature exists to avoid.
    try:
        if payload.get("crew_id"):
            if await release_crew(db, uuid.UUID(payload["crew_id"]), "logout"):
                await db.commit()
    except Exception:   # releasing a vehicle must never fail a logout
        logger.warning("Could not release vehicle claim on crew logout", exc_info=True)
        await db.rollback()

    # Purge this session's cached responses.
    #
    # ResponseCacheMiddleware is the OUTERMOST middleware, so a cache HIT
    # returns the stored body without running the route — which means
    # get_current_crew and the blacklist check above never execute. Blacklisting
    # alone therefore left a just-ended session still receiving 200s with real
    # data for up to the cache TTL. The admin logout has purged since the same
    # bug was found there; the crew one never did, and crew is the side with the
    # lost-tablet problem.
    try:
        from app.core.response_cache import bump_revocation_epoch, purge_session_cache
        dropped = purge_session_cache(f"Bearer {token}")
        bump_revocation_epoch()   # the other gunicorn workers
        if dropped:
            logger.info("Crew logout purged %d cached responses", dropped)
    except Exception:  # cache housekeeping must never break logout
        pass

    return {"message": "Session ended"}
