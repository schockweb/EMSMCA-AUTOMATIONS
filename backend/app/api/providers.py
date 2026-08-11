"""
Service Provider Admin API — CRUD for providers, crew members, and vehicles.
Admin-only endpoints for onboarding and managing service providers.
"""
from __future__ import annotations
from typing import Annotated, Optional
import uuid
import logging
import re
from datetime import datetime, timedelta, timezone

import os
import io
import shutil
from PIL import Image
from fastapi import APIRouter, Depends, HTTPException, Path, Request, status, UploadFile, File, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select, func, or_, cast, Text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.crew_auth import portal_grant_scheme, require_portal_grant
from app.config import get_settings
from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.service_provider import ServiceProvider
from app.models.crew_member import CrewMember
from app.models.vehicle import Vehicle
from app.models.digital_prf import DigitalPRF, PRFStatus
from app.utils.client_ip import get_trusted_client_ip
from app.utils.login_throttle import (
    clear_source_failures,
    is_source_blocked,
    register_source_failure,
)
from app.utils.security import (
    get_current_user,
    hash_password,
    require_role,
    verify_password,
    verify_password_async,
    verify_password_or_dummy,
    MAX_FAILED_ATTEMPTS,
    LOCKOUT_DURATION_MINUTES,
)
from app.utils.hpcsa import (
    HPCSA_CATEGORIES,
    DEFAULT_CATEGORY,
    CATEGORY_LABELS,
    normalise_category,
)
from app.models.user import User, UserRole

logger = logging.getLogger("ems.providers")

# provider_id / crew_id / vehicle_id path parameters are UUIDs. Constrain them at
# the routing layer so a malformed value (a slug, a truncated id, an injection
# probe) is rejected with a clean 422 BEFORE the handler runs. Every handler here
# starts with uuid.UUID(provider_id); that raises ValueError on bad input, which
# was surfacing as an unhandled 500 plus one crash-log row per bad request
# (flagged as a low-severity robustness gap in the 2026-08-11 pre-go-live scan).
# The value stays a `str`, so the existing uuid.UUID(...) call sites are unchanged.
_UUID_PATTERN = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
UUIDPath = Annotated[str, Path(pattern=_UUID_PATTERN)]

# Provider lifecycle (create / re-credential / logo / delete) is a back-office
# privilege operation, not something every authenticated account may do. Those
# routes ran on bare get_current_user, so any active User — and the User model
# defaults new accounts to PARAMEDIC — could rewrite a provider's portal login
# (the password that unlocks crew devices) or hard-delete a provider together
# with all of its crew, vehicles and Patient Report Forms.
_provider_admin = require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)

router = APIRouter(prefix="/api/providers", tags=["Service Providers"])


def _validate_portal_password(pw: str) -> None:
    """
    Complexity gate for the provider PORTAL password.

    This is the shared secret a crew types once per device to unlock a shift
    (the portal-grant device unlock, f80df14). It is therefore the credential
    that stands between the internet and a provider's patient PRFs — but it was
    the only password in the system set without any complexity check, while crew
    and admin passwords both had one.
    """
    from app.utils.security import validate_password_complexity
    try:
        validate_password_complexity(pw)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Portal password: {e}")


# Derive from settings.UPLOAD_DIR like main.py and digital_prf.py already do.
# These were hardcoded to "/app/uploads/..." — the container path — and created
# at IMPORT time, so importing this module anywhere outside Docker died with
# PermissionError on '/app'. That is why the backend test suite could never run
# in CI. The container's WORKDIR is /app, so the configured default "./uploads"
# resolves to the same /app/uploads in production: no behaviour change.
_UPLOAD_ROOT = get_settings().UPLOAD_DIR or "./uploads"
UPLOAD_DIR = os.path.join(_UPLOAD_ROOT, "logos")
CREW_PHOTO_DIR = os.path.join(_UPLOAD_ROOT, "crew")
VEHICLE_PHOTO_DIR = os.path.join(_UPLOAD_ROOT, "vehicles")

# Best-effort at import; the upload handlers create the directory again before
# writing, so an unwritable path here must not take the whole module down.
for _d in (UPLOAD_DIR, CREW_PHOTO_DIR, VEHICLE_PHOTO_DIR):
    try:
        os.makedirs(_d, exist_ok=True)
    except OSError as _e:  # pragma: no cover - environment dependent
        logger.warning("Could not pre-create upload dir %s: %s", _d, _e)
ALLOWED_PHOTO_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


# ── Dual auth: accept admin OR crew-admin tokens ──────────

from app.api.crew_auth import crew_oauth2_scheme
from fastapi.security import OAuth2PasswordBearer

admin_oauth2 = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


async def get_admin_or_crew_admin(
    admin_token: str = Depends(admin_oauth2),
    crew_token: str = Depends(crew_oauth2_scheme),
    db: AsyncSession = Depends(get_db),
):
    """Accept either an admin user token OR a crew admin token.

    Mirrors the checks get_current_user performs. This used to decode the token
    and return the user on existence alone: it never consulted the blacklist and
    never looked at is_active, so on the ~32 endpoints guarded by this dependency
    logging out did nothing and a deactivated admin kept full access until their
    token expired.

    2026-08-03: the same gap opened a second time. `tokens_revoked_at` — bulk
    session revocation, built for the lost-tablet case — shipped into the shared
    dependencies and did not reach this hand-rolled copy, so on these ~32
    endpoints (the provider portal password, SMTP credentials, crew CRUD,
    reset-password, the provider PRF list) "revoke that device's sessions" did
    nothing. That is the recurring shape in this codebase: a control written
    correctly in one place and not carried to the second door.

    Anything added to get_current_user or get_current_crew MUST be added here in
    the same change, until this is refactored to depend on them rather than
    re-implement them.
    """
    from app.utils.security import (
        decode_token as _decode,
        is_token_blacklisted as _blacklisted,
        token_is_revoked_by_family as _revoked,
    )
    # Try admin token first
    if admin_token:
        try:
            payload = _decode(admin_token)
            # A refresh token must not authenticate an API call.
            if payload.get("token_scope") != "crew" and payload.get("type") == "access":
                jti = payload.get("jti")
                if not (jti and await _blacklisted(jti, db)):
                    from app.models.user import User as _U
                    result = await db.execute(select(_U).where(_U.id == payload.get("sub")))
                    user = result.scalar_one_or_none()
                    if user and user.is_active and not _revoked(payload, user.tokens_revoked_at):
                        return user
        except Exception:
            pass
    # Try crew token
    if crew_token:
        try:
            payload = _decode(crew_token)
            if payload.get("token_scope") == "crew":
                jti = payload.get("jti")
                if not (jti and await _blacklisted(jti, db)):
                    crew_id = payload.get("crew_id")
                    # Provider flag carried over from get_current_crew (see the
                    # note above about the second door): a deactivated client's
                    # crew admin must lose these endpoints too, and the cascade
                    # alone would leave a manually re-enabled admin holding them.
                    row = (await db.execute(
                        select(CrewMember, ServiceProvider.is_active)
                        .join(ServiceProvider, ServiceProvider.id == CrewMember.provider_id)
                        .where(CrewMember.id == crew_id)
                    )).first()
                    crew = row[0] if row else None
                    if (crew and crew.is_active and row[1]
                            and not _revoked(payload, crew.tokens_revoked_at)):
                        return crew
        except Exception:
            pass
    raise HTTPException(status_code=401, detail="Not authenticated")


# ── Schemas ──────────────────────────────────────────────────

class ProviderCreate(BaseModel):
    # Lengths mirror the columns in models/service_provider.py. Without them an
    # ordinary control-room contact like "011 123 4567 / 082 555 1234" (27
    # chars) overflows phone's VARCHAR(20) and the worker gets a bare 500 that
    # names no field; a 422 at the boundary says which one is too long.
    name: str = Field(min_length=1, max_length=255)
    slug: str | None = Field(None, max_length=100)
    pr_number: str | None = Field(None, max_length=50)
    pty_reg_number: str | None = Field(None, max_length=50)
    # PRF file/display naming prefix — replaces the automatic provider-name
    # prefix in exported-PDF filenames when set; blank keeps automatic naming.
    prf_name: str | None = Field(None, max_length=100)
    phone: str | None = Field(None, max_length=20)
    email: str | None = Field(None, max_length=255)
    address: str | None = None
    # PRF numbering baseline — the last PRF number already used; new PRFs for this
    # provider start after it. Same semantics as `current_prf_number` in settings.
    # Accepts alphanumeric values like "JEM0690" — the numeric part seeds the counter.
    current_prf_number: int | str | None = None

    # New Client Onboarding fields
    portal_login_email: str | None = None
    portal_login_password: str | None = None
    admin_email: str | None = None
    admin_password: str | None = None
    # PRF outbound email account — the address submitted PRF PDFs are sent
    # FROM to the receiving facility. Gmail/Outlook app password required.
    smtp_service: str | None = None
    smtp_email: str | None = None
    smtp_password: str | None = None

class ProviderUpdate(BaseModel):
    # Same lengths as ProviderCreate — the edit dialog can overflow a column
    # just as easily as the onboarding form.
    name: str | None = Field(None, min_length=1, max_length=255)
    pr_number: str | None = Field(None, max_length=50)
    pty_reg_number: str | None = Field(None, max_length=50)
    # PRF naming prefix. Sent as an explicit null to clear back to automatic
    # provider-name naming (unlike credentials, which are omit-to-keep).
    prf_name: str | None = Field(None, max_length=100)
    phone: str | None = Field(None, max_length=20)
    email: str | None = Field(None, max_length=255)
    address: str | None = None
    logo_url: str | None = None
    is_active: bool | None = None
    # Portal credentials (EMSMCA Client Login — shared by all staff)
    portal_login_username: str | None = None
    portal_login_password: str | None = None
    # Admin crew credentials
    admin_email: str | None = None
    admin_password: str | None = None
    # PRF numbering baseline — the last PRF number already used. Only applied
    # when the admin actually enters a value; a blank field (None) leaves the
    # existing counter untouched so re-saving other fields never resets it.
    # Accepts alphanumeric values like "JEM0690" — the numeric part seeds the counter.
    current_prf_number: int | str | None = None
    # PRF outbound email account (Gmail/Outlook). smtp_password is
    # omit-to-keep like the other credentials; smtp_email = "" clears it.
    smtp_service: str | None = None
    smtp_email: str | None = None
    smtp_password: str | None = None

class CrewMemberCreate(BaseModel):
    full_name: str
    hpcsa_number: str | None = None  # Primary identifier for crew, optional for admin
    qualification: str = DEFAULT_CATEGORY   # HPCSA category — see app.utils.hpcsa
    email: str | None = None       # Optional — auto-generated if omitted
    initials: str | None = None
    phone: str | None = None
    password: str | None = None    # Not used for login — ignored
    role: str = "crew"

class CrewMemberUpdate(BaseModel):
    full_name: str | None = None
    initials: str | None = None
    hpcsa_number: str | None = None
    qualification: str | None = None        # HPCSA category — see app.utils.hpcsa
    phone: str | None = None
    is_active: bool | None = None
    role: str | None = None


def _validate_category(value: str | None, *, required: bool = True) -> str | None:
    """Validate an HPCSA registration category from an admin request body.

    STRICT BY DESIGN: only canonical category codes are accepted, and the value
    is stored exactly as given. A legacy billing tier (BLS / ILS / ALS) used to
    be normalised silently here — so an admin who chose "ALS" had it saved as
    "ECP" and saw a different value when reopening the record. Because the
    category drives scope-of-practice enforcement, quietly substituting one is
    a compliance problem, not a convenience: the caller is now told to pick a
    real category instead.

    NOTE: `normalise_category` remains deliberately lenient for OCR'd / legacy
    PRF data (see app/rules/hpcsa_scope.py) — that path must keep coping with
    free text. This strictness applies only to the admin crew endpoints.
    """
    if value is None or value == "":
        if required:
            raise HTTPException(400, f"qualification is required (one of {sorted(HPCSA_CATEGORIES)})")
        return None

    key = value.strip().upper()
    if key in HPCSA_CATEGORIES:
        return key

    # A recognised-but-non-canonical value (a tier, or free text like
    # "Paramedic"): say what it would have become rather than silently doing it.
    suggestion = normalise_category(key)
    if suggestion is not None:
        tier_note = ""
        if key in {"BLS", "ILS", "ALS"}:
            tier_note = (
                f" '{key}' is a billing tier, not an HPCSA registration category"
                " — the tier is worked out automatically from the category."
            )
        raise HTTPException(
            400,
            f"Invalid qualification '{value}'.{tier_note} Did you mean '{suggestion}'"
            f" ({CATEGORY_LABELS.get(suggestion, suggestion)})?"
            f" Choose one of: {sorted(HPCSA_CATEGORIES)}.",
        )

    raise HTTPException(
        400,
        f"Invalid qualification '{value}'. Expected an HPCSA category: {sorted(HPCSA_CATEGORIES)}.",
    )

class VehicleCreate(BaseModel):
    callsign: str
    registration: str
    vehicle_type: str = "Ambulance"

class VehicleUpdate(BaseModel):
    callsign: str | None = None
    registration: str | None = None
    vehicle_type: str | None = None
    is_active: bool | None = None


def _coerce_prf_baseline(value: int | str | None) -> int | None:
    """Normalise the admin-entered "Latest PRF Number" to the integer that
    seeds the per-provider counter. The field accepts alphanumeric values
    like "JEM0690" or "PRF-690" — the LAST run of digits is the number
    (prefixes/labels before it are tolerated and discarded). Returns None
    for a blank field (leave the counter untouched); raises 400 when a
    non-blank value contains no digits at all."""
    if value is None:
        return None
    if isinstance(value, str):
        if not value.strip():
            return None
        runs = re.findall(r"\d+", value)
        if not runs:
            raise HTTPException(400, "Latest PRF Number must contain a number, e.g. 690 or JEM0690.")
        # More than one run of digits is genuinely ambiguous and was resolved
        # silently: "0690/26" seeded 26, "EL30/2026" seeded 2026, "2026-08-11"
        # seeded 11. The wrong baseline is never echoed back anywhere, so the
        # first the client would know of it is their PRF numbering restarting
        # or jumping. Ask rather than guess.
        if len(runs) > 1:
            raise HTTPException(
                400,
                f"'{value}' has more than one number in it, so the starting point is "
                f"unclear. Enter just the last PRF number used — for example "
                f"{runs[0]} or {runs[-1]}.",
            )
        value = int(runs[0])
    if value < 0:
        raise HTTPException(400, "Current PRF number cannot be negative.")
    return value


_SMTP_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _apply_smtp_settings(provider: ServiceProvider, data: dict) -> None:
    """PRF outbound email account (per-provider Gmail / Outlook).

    Shared by the admin CRUD and the provider-settings endpoints. Field
    semantics (all keys optional — only keys present in `data` are touched):
      • smtp_email = ""     → clears the whole account (sending disabled)
      • smtp_email = value  → validated + stored lowercase
      • smtp_service        → must be 'gmail' or 'outlook'
      • smtp_password       → stored Fernet-encrypted; blank/omitted keeps
                              the existing password (never echoed back)
    """
    if "smtp_email" in data:
        email = (data.get("smtp_email") or "").strip().lower()
        if not email:
            provider.smtp_email = None
            provider.smtp_service = None
            provider.smtp_password_encrypted = None
        else:
            if not _SMTP_EMAIL_RE.match(email):
                raise HTTPException(400, "PRF sending email address is not valid.")
            provider.smtp_email = email
    if "smtp_service" in data and (data.get("smtp_service") or "").strip():
        svc = str(data["smtp_service"]).strip().lower()
        if svc not in ("gmail", "outlook"):
            raise HTTPException(400, "PRF sending service must be Gmail or Outlook.")
        provider.smtp_service = svc
    pw = data.get("smtp_password")
    if pw and str(pw).strip():
        from app.utils.crypto import encrypt_str
        # Strip ALL whitespace, not just ends: Gmail displays app passwords in
        # spaced groups ("abcd efgh ijkl mnop") and admins paste them that way —
        # the real credential is the 16 characters without spaces.
        provider.smtp_password_encrypted = encrypt_str(re.sub(r"\s+", "", str(pw)))


async def _verify_new_smtp_credential(data: dict, provider: ServiceProvider) -> None:
    """When a NEW app password was typed, attempt a real SMTP login BEFORE the
    save commits — a typo'd Gmail/Outlook app password would otherwise fail
    silently on every later PRF send. Auth rejection blocks the save with a
    clear message; network trouble fails open (the password may be right)."""
    # Same whitespace-stripping as storage — test exactly what will be stored.
    pw = re.sub(r"\s+", "", str(data.get("smtp_password") or ""))
    if not pw or not (provider.smtp_email and provider.smtp_service):
        return
    import asyncio
    from app.utils.emailer import test_smtp_login
    ok, reason = await asyncio.to_thread(
        test_smtp_login, provider.smtp_service, provider.smtp_email, pw
    )
    if not ok and reason == "smtp_auth_failed":
        raise HTTPException(
            400,
            "Gmail/Outlook rejected this app password. Generate an App Password "
            "in the account's security settings and enter it here.",
        )


def _slugify(name: str) -> str:
    """Generate a URL-safe slug from a provider name."""
    slug = name.lower().strip()
    slug = re.sub(r'[^a-z0-9\s-]', '', slug)
    slug = re.sub(r'[\s-]+', '-', slug).strip('-')
    return slug[:100]


_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,99}$")


def _validate_slug(slug: str) -> str:
    """Accept only a slug shape, because the slug reaches the filesystem.

    `_slugify` was applied ONLY to a slug derived from the provider name — an
    explicitly supplied `slug` was stored verbatim. The logo upload then builds
    `f"{provider.slug}_logo{ext}"` and hands it to os.path.join, which does not
    normalise `..`, so a provider created with slug `../../../../tmp/pwn` wrote
    attacker-chosen bytes outside the uploads directory. The logo route performs
    no content validation either, unlike the crew photo route (re-encoded
    through PIL) and document upload (magic-byte checked).

    Whitelist rather than blacklist: the set of characters legal in a slug is
    small and known, while the set of characters dangerous in a path depends on
    the platform and grows.
    """
    slug = (slug or "").strip().lower()
    if not _SLUG_RE.match(slug):
        raise HTTPException(
            400,
            "Slug must be lowercase letters, digits and hyphens only, "
            "starting with a letter or digit (max 100 characters).",
        )
    return slug


# ═══════════════════════════════════════════════════════════
# PUBLIC ENDPOINT (no auth required — for login page dropdown)
# ═══════════════════════════════════════════════════════════

@router.get("/public")
async def list_providers_public(db: AsyncSession = Depends(get_db)):
    """List active providers for the Client dropdown on the login page. No auth."""
    result = await db.execute(
        select(ServiceProvider)
        .where(ServiceProvider.is_active == True)
        .order_by(ServiceProvider.name)
    )
    return [
        {"name": p.name, "slug": p.slug, "logo_url": p.logo_url}
        for p in result.scalars().all()
    ]


class PortalLoginRequest(BaseModel):
    username: str   # portal_login_email
    password: str   # portal_login_password

@router.post("/{slug}/portal-login")
async def portal_login(
    slug: str,
    body: PortalLoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Verify company-wide portal credentials (portal_login_email / portal_login_password).
    These are set in the EMSMCA Client Login section when creating a provider and allow
    ALL staff (admin + crew) of that company to access their login portal.
    Returns provider info on success so the frontend can render the branded portal.

    THE THIRD DOOR TO THE SAME SECRET
    ---------------------------------
    Account lockout was added on 2026-07-23 and reached the other two doors —
    `/api/crew/portal-unlock` and the portal branch of `/api/auth/login` — but
    never reached this one. It read the same `portal_login_password_hash` and
    never looked at `locked_until`, never incremented `failed_login_attempts`
    and wrote no audit row, so the whole lockout control was bypassable by
    choosing this URL: unlimited guesses at the shared company password, leaving
    nothing in the audit log.

    That mattered because `GET /api/providers/public` hands out every active
    slug without authentication, and one correct guess chains through
    portal-unlock → public-crew → shift-start-by-id to a 12-hour token that can
    read, edit and delete that company's patient records.

    Now enforced identically to its two siblings, and the failure responses are
    uniform so this cannot be used to enumerate which companies are configured.
    """
    client_ip = get_trusted_client_ip(request)
    result = await db.execute(
        select(ServiceProvider).where(
            ServiceProvider.slug == slug.strip().lower(),
            ServiceProvider.is_active == True,
        )
    )
    provider = result.scalar_one_or_none()

    generic = HTTPException(status_code=401, detail="Invalid username or password")

    # Unknown slug and unconfigured provider both answer the same way, and both
    # still pay the bcrypt cost, so neither the status code nor the response
    # time distinguishes them. The previous 404/403 pair confirmed for an
    # anonymous caller exactly which companies exist and which have credentials.
    if not provider or not provider.portal_login_password_hash:
        await verify_password_or_dummy(body.password, None)
        raise generic

    # Throttled per SOURCE for the same reason as /api/crew/portal-unlock: this
    # verifies the same shared company password, and a provider-wide lock driven
    # by an anonymous caller takes an ambulance service off the air. See
    # app/utils/login_throttle.py.
    if await is_source_blocked("portal", str(provider.id), client_ip):
        db.add(AuditLog(
            user_id=None, action="PORTAL_LOGIN_FAILED_LOCKED", entity_type="auth_portal",
            entity_id=provider.id, ip_address=client_ip,
            details={"provider_slug": provider.slug, "route": "portal-login"},
        ))
        await db.commit()
        raise HTTPException(
            status_code=403,
            detail="Too many incorrect attempts from this device. Try again later.",
        )

    stored_username = (provider.portal_login_email or "").strip().lower()
    submitted_username = body.username.strip().lower()
    password_ok = await verify_password_or_dummy(
        body.password, provider.portal_login_password_hash
    )

    if stored_username != submitted_username or not password_ok:
        source_failures = await register_source_failure("portal", str(provider.id), client_ip)
        provider.failed_login_attempts = (provider.failed_login_attempts or 0) + 1
        db.add(AuditLog(
            user_id=None, action="PORTAL_LOGIN_FAILED", entity_type="auth_portal",
            entity_id=provider.id, ip_address=client_ip,
            details={
                "provider_slug": provider.slug, "route": "portal-login",
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
        user_id=None, action="PORTAL_LOGIN_SUCCESS", entity_type="auth_portal",
        entity_id=provider.id, ip_address=client_ip,
        details={"provider_slug": provider.slug, "route": "portal-login"},
    ))
    await db.commit()

    return {
        "valid": True,
        "provider_name": provider.name,
        "provider_slug": provider.slug,
        "logo_url": provider.logo_url,
        "pr_number": provider.pr_number,
    }


@router.get("/{slug}/public-vehicles")
async def list_vehicles_public_by_slug(
    slug: str,
    db: AsyncSession = Depends(get_db),
    grant: str | None = Depends(portal_grant_scheme),
):
    """List active vehicles for the shift-start dropdown.

    Gated behind the same device unlock as public-crew — fleet callsigns and
    registrations are operational data, and the two lists are fetched together.
    """
    provider = await require_portal_grant(slug, grant, db)

    vehicle_result = await db.execute(
        select(Vehicle)
        .where(Vehicle.provider_id == provider.id, Vehicle.is_active == True)
        .order_by(Vehicle.callsign)
    )
    return [
        {
            "id": str(v.id),
            "callsign": v.callsign,
            "registration": v.registration,
            "vehicle_type": v.vehicle_type,
        }
        for v in vehicle_result.scalars().all()
    ]


@router.get("/{slug}/public-crew")
async def list_crew_public_by_slug(
    slug: str,
    db: AsyncSession = Depends(get_db),
    grant: str | None = Depends(portal_grant_scheme),
):
    """List active crew for the shift-start dropdown.

    REQUIRES a device unlock (portal grant) or a crew token for this provider.
    Despite the name this was never safe to expose publicly: it returned each
    crew member's UUID and HPCSA number, which were exactly the inputs
    /api/crew/shift-start-by-id and /api/crew/lookup-hpcsa needed to mint a
    12-hour patient-record token — so it functioned as the directory for an
    unauthenticated account-takeover. The HPCSA number is no longer returned;
    nothing in the dropdown needs it.
    """
    provider = await require_portal_grant(slug, grant, db)

    crew_result = await db.execute(
        select(CrewMember)
        .where(
            CrewMember.provider_id == provider.id,
            CrewMember.is_active == True,
            CrewMember.role != 'admin'
        )
        .order_by(CrewMember.full_name)
    )
    return [
        {
            "id": str(c.id),
            "full_name": c.full_name,
            "qualification": c.qualification,
        }
        for c in crew_result.scalars().all()
    ]


# ═══════════════════════════════════════════════════════════
# PROVIDER ENDPOINTS (admin-protected)
# ═══════════════════════════════════════════════════════════

@router.get("")
async def list_providers(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(_provider_admin),
):
    """List all service providers with crew and vehicle counts.

    Back-office admin only. This ran on bare `get_current_user`, so any
    authenticated account — including a crew-created User defaulting to
    PARAMEDIC, or an admin narrowed to a single page — could enumerate every
    tenant on the platform together with each one's `portal_login_username`
    (returned below) and a crew admin's email address. That is the customer
    list of the business plus the login identity for the shared company
    password, handed to anyone with any token.

    The counts are four GROUPED queries, not four queries PER PROVIDER.

    This loop used to await a crew count, a vehicle count, a PRF count and an
    admin-email lookup inside the iteration — five round-trips per provider, run
    strictly one after another because each is awaited before the next begins.
    At the 105 tenants this platform is sized for that is 421 sequential
    round-trips for one page load, and the page gets slower in direct
    proportion to how successful the business is. It is now a fixed five
    regardless of tenant count.
    """
    result = await db.execute(select(ServiceProvider).order_by(ServiceProvider.name))
    providers = result.scalars().all()

    def _counts(rows) -> dict:
        return {pid: n for pid, n in rows}

    crew_counts = _counts((await db.execute(
        select(CrewMember.provider_id, func.count(CrewMember.id))
        .group_by(CrewMember.provider_id)
    )).all())
    vehicle_counts = _counts((await db.execute(
        select(Vehicle.provider_id, func.count(Vehicle.id))
        .group_by(Vehicle.provider_id)
    )).all())
    prf_counts = _counts((await db.execute(
        select(DigitalPRF.provider_id, func.count(DigitalPRF.id))
        .group_by(DigitalPRF.provider_id)
    )).all())
    # min() rather than the old `.limit(1)`: that had no ORDER BY, so which
    # address you got back was whatever the planner happened to return first
    # and could change between calls for a provider with several admins.
    admin_emails = dict((await db.execute(
        select(CrewMember.provider_id, func.min(CrewMember.email))
        .where(CrewMember.role == "admin")
        .group_by(CrewMember.provider_id)
    )).all())

    items = []
    for p in providers:
        admin_email = admin_emails.get(p.id)

        items.append({
            "id": str(p.id),
            "name": p.name,
            "slug": p.slug,
            "pr_number": p.pr_number,
            "pty_reg_number": p.pty_reg_number,
            "prf_name": p.prf_name,
            "phone": p.phone,
            "email": p.email,
            "address": p.address,
            "logo_url": p.logo_url,
            "is_active": p.is_active,
            "portal_login_username": p.portal_login_email,
            "admin_email": admin_email,
            "smtp_service": p.smtp_service,
            "smtp_email": p.smtp_email,
            "smtp_configured": bool(p.smtp_email and p.smtp_password_encrypted),
            "crew_count": crew_counts.get(p.id, 0),
            "vehicle_count": vehicle_counts.get(p.id, 0),
            "prf_count": prf_counts.get(p.id, 0),
            "created_at": p.created_at.isoformat() if p.created_at else None,
        })

    return items


@router.post("", status_code=201)
async def create_provider(
    body: ProviderCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(_provider_admin),
):
    """Create a new service provider."""
    # Validated, not merely defaulted: an explicit slug used to bypass _slugify
    # entirely and reach os.path.join in the logo upload path.
    slug = _validate_slug(body.slug or _slugify(body.name))

    # Check slug uniqueness
    existing = await db.execute(select(ServiceProvider).where(ServiceProvider.slug == slug))
    if existing.scalar_one_or_none():
        raise HTTPException(400, f"Slug '{slug}' is already taken")

    # Check portal login uniqueness if provided
    if body.portal_login_email:
        portal_email = body.portal_login_email.strip().lower()
        existing_portal = await db.execute(select(ServiceProvider).where(ServiceProvider.portal_login_email == portal_email))
        if existing_portal.scalar_one_or_none():
            raise HTTPException(400, f"Portal Login Email '{portal_email}' is already in use by another client.")
    else:
        portal_email = None

    provider = ServiceProvider(
        name=body.name,
        slug=slug,
        pr_number=body.pr_number,
        pty_reg_number=body.pty_reg_number,
        prf_name=(body.prf_name or "").strip() or None,
        phone=body.phone,
        email=body.email,
        address=body.address,
        prf_start_number=_coerce_prf_baseline(body.current_prf_number),
        portal_login_email=portal_email,
        portal_login_password_hash=(
            _validate_portal_password(body.portal_login_password)
            or hash_password(body.portal_login_password)
        ) if body.portal_login_password else None,
    )
    # PRF outbound email account (Gmail/Outlook), validated + encrypted.
    _apply_smtp_settings(provider, body.model_dump(exclude_unset=True))
    await _verify_new_smtp_credential(body.model_dump(exclude_unset=True), provider)
    db.add(provider)
    await db.flush()  # To get provider.id for the crew member

    # Optionally create an admin crew member
    if body.admin_email and body.admin_password:
        admin_email = body.admin_email.strip().lower()
        existing_crew_email = await db.execute(select(CrewMember).where(CrewMember.email == admin_email))
        if existing_crew_email.scalar_one_or_none():
            raise HTTPException(400, f"Admin email '{admin_email}' is already registered as a crew member.")
        
        admin_crew = CrewMember(
            provider_id=provider.id,
            email=admin_email,
            hashed_password=hash_password(body.admin_password),
            full_name=f"{body.name} Admin",
            initials="AD",
            qualification=DEFAULT_CATEGORY,  # HPCSA category; ILS is a BILLING TIER and _validate_category rejects it
            role="admin",
            is_active=True,
        )
        db.add(admin_crew)

    await db.commit()
    await db.refresh(provider)
    logger.info("Created provider: %s (%s)", provider.name, provider.slug)
    return {"id": str(provider.id), "name": provider.name, "slug": provider.slug}


@router.post("/{provider_id}/logo")
async def upload_provider_logo(
    provider_id: UUIDPath,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(_provider_admin),
):
    """Upload a logo for a service provider."""
    result = await db.execute(select(ServiceProvider).where(ServiceProvider.id == uuid.UUID(provider_id)))
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(404, "Provider not found")
        
    file_ext = (os.path.splitext(file.filename)[1] if file.filename else ".png").lower()
    if file_ext not in ALLOWED_LOGO_EXTENSIONS:
        raise HTTPException(400, f"Unsupported logo format '{file_ext}'. Use PNG, JPG, SVG or WEBP.")
    # basename() as well as the create-time slug validation. Providers created
    # BEFORE that validation existed may already hold a traversing slug, and
    # this is the line that turns one into a write outside UPLOAD_DIR.
    safe_filename = os.path.basename(f"{provider.slug}_logo{file_ext}")
    file_path = os.path.join(UPLOAD_DIR, safe_filename)
    if os.path.dirname(os.path.abspath(file_path)) != os.path.abspath(UPLOAD_DIR):
        raise HTTPException(400, "Invalid provider slug for a filename")

    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    provider.logo_url = f"/uploads/logos/{safe_filename}"
    await db.commit()
    return {"logo_url": provider.logo_url}


@router.get("/{provider_id}")
async def get_provider(
    provider_id: UUIDPath,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(_provider_admin),
):
    """Get full provider details.

    Every sibling route on this router (settings, crew, vehicles, prfs, logo,
    patch, delete) is gated by _assert_settings_access or _provider_admin; this
    one and the list route were left on bare authentication, so any logged-in
    account could read any tenant's record by UUID.
    """
    result = await db.execute(
        select(ServiceProvider).where(ServiceProvider.id == uuid.UUID(provider_id))
    )
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(404, "Provider not found")
    return {
        "id": str(provider.id),
        "name": provider.name,
        "slug": provider.slug,
        "pr_number": provider.pr_number,
        "pty_reg_number": provider.pty_reg_number,
        "prf_name": provider.prf_name,
        "phone": provider.phone,
        "email": provider.email,
        "address": provider.address,
        "logo_url": provider.logo_url,
        "is_active": provider.is_active,
        "smtp_service": provider.smtp_service,
        "smtp_email": provider.smtp_email,
        "smtp_configured": bool(provider.smtp_email and provider.smtp_password_encrypted),
        "created_at": provider.created_at.isoformat() if provider.created_at else None,
    }


@router.patch("/{provider_id}")
async def update_provider(
    provider_id: UUIDPath,
    body: ProviderUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(_provider_admin),
):
    """Update provider details, portal credentials, and admin crew credentials."""
    result = await db.execute(
        select(ServiceProvider).where(ServiceProvider.id == uuid.UUID(provider_id))
    )
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(404, "Provider not found")

    # Standard fields — set directly on the model.
    #
    # `is_active` is deliberately NOT in this set. Flipping it is a lifecycle
    # operation with a cascade and an audit entry attached (see
    # _apply_provider_active); assigning it here would have produced a provider
    # that is hidden from the portal while every one of its crew members can
    # still start a shift and open patient records — the exact hole the cascade
    # exists to close. The field is still accepted on this route so existing
    # callers keep working; it is routed through the same helper below.
    standard_fields = {"name", "pr_number", "pty_reg_number", "prf_name", "phone", "email", "address", "logo_url"}
    for key, val in body.model_dump(exclude_unset=True).items():
        if key in standard_fields:
            if key == "prf_name":
                val = (val or "").strip() or None
            setattr(provider, key, val)

    if body.is_active is not None and body.is_active != provider.is_active:
        await _apply_provider_active(
            db, provider, active=body.is_active,
            actor_id=user.id, ip=get_trusted_client_ip(request),
        )

    # PRF numbering baseline. Only touched when the admin entered a value — a
    # blank field leaves the existing counter untouched. The next digital
    # PRF continues from this value + 1 (see `_next_prf_number`).
    baseline = _coerce_prf_baseline(body.current_prf_number)
    if baseline is not None:
        provider.prf_start_number = baseline

    # PRF outbound email account (Gmail/Outlook), validated + encrypted.
    _apply_smtp_settings(provider, body.model_dump(exclude_unset=True))
    await _verify_new_smtp_credential(body.model_dump(exclude_unset=True), provider)

    # EMSMCA Client Login (portal_login_email / portal_login_password_hash on ServiceProvider)
    if body.portal_login_username is not None:
        new_portal_email = body.portal_login_username.strip().lower() or None
        # create_provider pre-checks this; the edit path did not, so pasting one
        # client's portal username onto another — an ordinary slip when working
        # down a spreadsheet of 100 — hit the DB unique constraint and surfaced
        # as a bare 500 "An internal error occurred", with no indication of which
        # field was wrong or which client already owned it.
        if new_portal_email and new_portal_email != (provider.portal_login_email or ""):
            clash = (await db.execute(
                select(ServiceProvider).where(
                    ServiceProvider.portal_login_email == new_portal_email,
                    ServiceProvider.id != uuid.UUID(provider_id),
                )
            )).scalar_one_or_none()
            if clash:
                raise HTTPException(
                    400,
                    f"The client login '{new_portal_email}' already belongs to {clash.name}. "
                    f"Each client needs its own login.",
                )
        provider.portal_login_email = new_portal_email
    if body.portal_login_password is not None and body.portal_login_password.strip():
        _validate_portal_password(body.portal_login_password)
        provider.portal_login_password_hash = hash_password(body.portal_login_password)

    # Admin crew member credentials
    if body.admin_email or body.admin_password:
        admin_result = await db.execute(
            # .limit(1) is load-bearing. Nothing stops a provider having two crew
            # admins — add_crew_member takes `role` verbatim and update_crew_member
            # promotes with a bare setattr — and without the limit a second admin
            # makes scalar_one_or_none() raise MultipleResultsFound, which turns
            # EVERY subsequent PATCH of that provider into a permanent 500. The
            # equivalent query in update_provider_settings already limits.
            select(CrewMember).where(
                CrewMember.provider_id == uuid.UUID(provider_id),
                CrewMember.role == "admin",
            ).limit(1)
        )
        admin = admin_result.scalar_one_or_none()

        # crew_members.email is DB-unique. create_provider pre-checks it; this
        # path did not, so reusing an admin email across two clients — the same
        # spreadsheet slip as the portal login above — raised an IntegrityError
        # the admin saw as a bare 500.
        if body.admin_email and body.admin_email.strip():
            wanted = body.admin_email.strip().lower()
            if not admin or wanted != (admin.email or "").lower():
                taken = (await db.execute(
                    select(CrewMember).where(CrewMember.email == wanted)
                )).scalar_one_or_none()
                if taken:
                    owner = (await db.execute(
                        select(ServiceProvider).where(ServiceProvider.id == taken.provider_id)
                    )).scalar_one_or_none()
                    raise HTTPException(
                        400,
                        f"The admin email '{wanted}' is already used by "
                        f"{owner.name if owner else 'another client'}. "
                        f"Each admin needs their own email address.",
                    )

        if admin:
            # Update existing admin
            if body.admin_email:
                admin.email = body.admin_email.strip().lower()
            if body.admin_password and body.admin_password.strip():
                admin.hashed_password = hash_password(body.admin_password)
        else:
            # Create new admin crew member
            if body.admin_email and body.admin_password:
                admin = CrewMember(
                    provider_id=uuid.UUID(provider_id),
                    email=body.admin_email.strip().lower(),
                    hashed_password=hash_password(body.admin_password),
                    full_name=f"{provider.name} Admin",
                    initials="AD",
                    qualification=DEFAULT_CATEGORY,
                    role="admin",
                    is_active=True,
                )
                db.add(admin)

    await db.commit()
    return {"message": "Provider updated", "id": str(provider.id)}


# ═══════════════════════════════════════════════════════════
# PROVIDER LIFECYCLE — deactivate / reactivate
# ═══════════════════════════════════════════════════════════
#
# There is no "remove a client" in this system, and that is a design decision
# rather than a missing feature. `audit_logs.crew_member_id` records which crew
# member read which patient's record — the POPIA subject-access trail — and the
# table carries an append-only trigger, so the rows cannot be cleared to free
# the foreign key. Crew names and HPCSA numbers are also on submitted PRFs,
# which are the legal record of who treated a patient. Deleting a client orphans
# both, permanently. Deactivation is the operation that was actually wanted:
# the company stops working, and the clinical record stays answerable.


async def _apply_provider_active(
    db: AsyncSession,
    provider: ServiceProvider,
    *,
    active: bool,
    actor_id: uuid.UUID | None,
    ip: str | None,
) -> int:
    """Flip a provider's active flag and carry the change to its crew.

    Returns the number of crew members whose state changed. Does NOT commit —
    the caller owns the transaction, so the provider row and its crew always
    move together.

    Deactivating the provider alone is not enough. Every gate that reads
    `ServiceProvider.is_active` (portal-login, portal-unlock, the shift-start
    routes) refuses a deactivated company, but `get_current_crew` authorises on
    the crew row, so a tablet already holding a 12-hour token would keep reading
    and writing patient records for the rest of that token's life. Switching the
    crew off, and stamping `tokens_revoked_at`, ends those sessions on the next
    request instead of up to twelve hours later.

    Reactivation restores only the crew this cascade switched off — see
    `CrewMember.deactivated_with_provider`.
    """
    from sqlalchemy import update as sql_update

    now = datetime.now(timezone.utc)
    provider.is_active = active

    if not active:
        # Kill outstanding device unlocks for the company. Without this a valid
        # portal grant survives in a tablet's storage; it cannot be redeemed
        # while the provider is inactive, but it must not spring back to life
        # the moment the client is reactivated either.
        provider.tokens_revoked_at = now
        result = await db.execute(
            sql_update(CrewMember)
            .where(
                CrewMember.provider_id == provider.id,
                CrewMember.is_active == True,  # noqa: E712
            )
            .values(
                is_active=False,
                deactivated_with_provider=True,
                tokens_revoked_at=now,
                updated_at=now,
            )
        )
    else:
        result = await db.execute(
            sql_update(CrewMember)
            .where(
                CrewMember.provider_id == provider.id,
                CrewMember.deactivated_with_provider == True,  # noqa: E712
            )
            .values(
                is_active=True,
                deactivated_with_provider=False,
                updated_at=now,
            )
        )

    crew_affected = result.rowcount or 0

    db.add(AuditLog(
        user_id=actor_id,
        action="PROVIDER_REACTIVATED" if active else "PROVIDER_DEACTIVATED",
        entity_type="service_provider",
        entity_id=provider.id,
        before_state={"is_active": not active},
        after_state={"is_active": active},
        details={"provider_slug": provider.slug, "crew_affected": crew_affected},
        ip_address=ip,
    ))

    # The response cache answers a HIT before the route's auth dependency runs,
    # and /api/providers is cached for 60s — including this client's crew list
    # and its PRF list. Without this, a crew admin whose company was just
    # deactivated keeps receiving cached 200s carrying patient report data for
    # up to a minute, on every gunicorn worker that did not handle this request.
    # Same treatment as revoke-sessions, for the same reason.
    try:
        from app.core.response_cache import (
            bump_revocation_epoch, purge_all_cached_responses,
        )
        purge_all_cached_responses()      # this worker, immediately
        bump_revocation_epoch()           # every other worker, within a second
    except Exception:  # cache housekeeping must never fail the operation
        pass

    logger.info(
        "Provider %s %s by user=%s (%d crew members affected)",
        provider.slug, "reactivated" if active else "deactivated",
        actor_id, crew_affected,
    )
    return crew_affected


@router.post("/{provider_id}/deactivate")
async def deactivate_provider(
    provider_id: UUIDPath,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(_provider_admin),
):
    """Deactivate a client: the company and all of its crew stop working.

    Reversible. Nothing is deleted — PRFs, cases, claims, documents and the
    audit trail are untouched, and deactivated crew keep their names on the
    reports they signed, because the clinical record still has to answer who
    treated a patient and what they were qualified to give.
    """
    provider = await _load_provider(db, uuid.UUID(provider_id))
    was_active = provider.is_active

    # Runs the cascade even when the client is already inactive. A crew member
    # added while the company was switched off is created active, and clicking
    # Deactivate again is the obvious way an admin would expect to catch that.
    crew_affected = await _apply_provider_active(
        db, provider, active=False,
        actor_id=user.id, ip=get_trusted_client_ip(request),
    )
    await db.commit()

    lead = f"{provider.name} deactivated." if was_active else f"{provider.name} was already deactivated."
    return {
        "message": (
            f"{lead} {crew_affected} crew member"
            f"{'' if crew_affected == 1 else 's'} can no longer sign in."
        ),
        "is_active": False,
        "crew_affected": crew_affected,
    }


@router.post("/{provider_id}/reactivate")
async def reactivate_provider(
    provider_id: UUIDPath,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(_provider_admin),
):
    """Reactivate a client and the crew that were switched off with it.

    Crew members deactivated individually — a paramedic who left the service —
    stay deactivated. Only the ones this client's deactivation switched off come
    back.
    """
    provider = await _load_provider(db, uuid.UUID(provider_id))

    crew_affected = await _apply_provider_active(
        db, provider, active=True,
        actor_id=user.id, ip=get_trusted_client_ip(request),
    )
    await db.commit()
    return {
        "message": (
            f"{provider.name} reactivated. {crew_affected} crew member"
            f"{'' if crew_affected == 1 else 's'} restored."
        ),
        "is_active": True,
        "crew_affected": crew_affected,
    }


@router.delete("/{provider_id}", status_code=204)
async def delete_provider(
    provider_id: UUIDPath,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(_provider_admin),
):
    """Hard-delete a provider — refused once the client has clinical history.

    This used to answer a plain 500 "An internal error occurred" for any client
    that had ever been used, because the cascade below deletes `crew_members`
    and PostgreSQL refuses:

        DELETE FROM crew_members WHERE provider_id = $1
        violates foreign key constraint "audit_logs_crew_member_id_fkey"

    That is not a bug to be worked around — it is the POPIA access trail
    refusing to be unpicked, and it reads to an admin as a crash in the product.
    The refusal is now explicit, states the reason, and points at Deactivate.

    A client created by mistake and never used has no such history, and removing
    it is harmless, so that case is still allowed.
    """
    from sqlalchemy import delete as sql_delete

    pid = uuid.UUID(provider_id)

    result = await db.execute(select(ServiceProvider).where(ServiceProvider.id == pid))
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(404, "Provider not found")

    # Everything that a hard delete would have to destroy or orphan. These are
    # the only FK paths into this provider's rows: digital_prfs and vehicles
    # reference the provider, digital_prfs and audit_logs reference its crew.
    prf_count = (await db.execute(
        select(func.count(DigitalPRF.id)).where(DigitalPRF.provider_id == pid)
    )).scalar_one() or 0
    audit_count = (await db.execute(
        select(func.count(AuditLog.id)).where(
            AuditLog.crew_member_id.in_(
                select(CrewMember.id).where(CrewMember.provider_id == pid)
            )
        )
    )).scalar_one() or 0

    if prf_count or audit_count:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{provider.name} has clinical history — {prf_count} Patient Report "
                f"Form(s) and {audit_count} patient-access record(s) — which must be "
                f"retained and cannot be deleted. Deactivate this client instead: the "
                f"company and its crew stop being able to sign in, and everything on "
                f"record stays intact."
            ),
        )

    # The logo file is removed AFTER the transaction commits — see below.
    # Deleting it here, before the cascade, is what destroyed a live client's
    # logo on 2026-08-07: removing a file is not transactional, the cascade
    # below then failed on a foreign key these two pre-checks do not cover
    # (they count digital_prfs and audit_logs only), the transaction rolled
    # back — and the provider survived with logo_url still set, pointing at a
    # file that no longer existed. The row and the image have to fail together.
    logo_path = (
        os.path.join("/app", provider.logo_url.lstrip("/"))
        if provider.logo_url else None
    )

    # Cascade delete in FK-safe order:
    # 1. Vehicles
    await db.execute(sql_delete(Vehicle).where(Vehicle.provider_id == pid))
    # 2. Crew members
    await db.execute(sql_delete(CrewMember).where(CrewMember.provider_id == pid))
    # 3. Provider itself
    await db.execute(sql_delete(ServiceProvider).where(ServiceProvider.id == pid))

    await db.commit()

    # Only now that the row is definitely gone. If the commit above had raised,
    # the client would still exist and would still need its logo.
    if logo_path and os.path.exists(logo_path):
        try:
            os.remove(logo_path)
        except OSError:
            pass

    logger.info("Deleted unused provider %s (%s)", provider.name, provider_id)


# ═══════════════════════════════════════════════════════════
# PROVIDER SETTINGS (accessible to the provider's own crew admin)
# ═══════════════════════════════════════════════════════════

class ProviderSettingsUpdate(BaseModel):
    name: str | None = None
    pr_number: str | None = None
    pty_reg_number: str | None = None
    # PRF naming prefix — explicit null/blank clears back to automatic naming.
    prf_name: str | None = None
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    # EMSMCA Client Login (shared portal credentials on ServiceProvider)
    portal_login_username: str | None = None
    portal_login_password: str | None = None
    # Portal Admin Login (admin crew member credentials)
    admin_email: str | None = None
    admin_password: str | None = None
    # PRF numbering baseline — count of PRFs completed so far at onboarding.
    # Only sent when the admin fills the field; the next digital PRF continues
    # from here. Never echoed back on GET (the field stays blank on return).
    # Accepts alphanumeric values like "JEM0690" — the numeric part seeds the counter.
    current_prf_number: int | str | None = None
    # PRF outbound email account (Gmail/Outlook + app password).
    smtp_service: str | None = None
    smtp_email: str | None = None
    smtp_password: str | None = None


# Back-office User roles allowed to administer ANY provider's settings.
# Deliberately not "any authenticated User" — see _assert_settings_access.
_SETTINGS_ADMIN_ROLES = (UserRole.ADMIN, UserRole.SUPER_ADMIN)


def _assert_settings_access(principal, provider_id: uuid.UUID) -> None:
    """Authorise a principal to administer this provider's settings.

    Two principal types reach here via get_admin_or_crew_admin:

    * CrewMember — must hold the crew "admin" role AND belong to this provider.
    * User — must be a back-office ADMIN or SUPER_ADMIN.

    The User branch did not exist. get_admin_or_crew_admin is authentication
    only: it returns ANY active User without inspecting role, and the User model
    defaults new accounts to PARAMEDIC. So every non-crew login — the lowest
    privilege account in the system — could administer EVERY provider on the
    instance: set the portal password that unlocks crew devices, read SMTP
    credentials, call reset-password and receive a plaintext temporary password
    in the response, and page through another tenant's PRF history. On a shared
    client VM that made one back-office account a master key for all tenants.
    """
    if isinstance(principal, CrewMember):
        if principal.role != "admin" or principal.provider_id != provider_id:
            raise HTTPException(status_code=403, detail="Admin access required")
        return

    if isinstance(principal, User):
        if principal.role not in _SETTINGS_ADMIN_ROLES:
            raise HTTPException(status_code=403, detail="Admin access required")
        return

    # Unknown principal type — fail closed rather than fall through to allow.
    raise HTTPException(status_code=403, detail="Admin access required")


async def _load_provider(db: AsyncSession, pid: uuid.UUID) -> ServiceProvider:
    result = await db.execute(select(ServiceProvider).where(ServiceProvider.id == pid))
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(404, "Provider not found")
    return provider


@router.get("/{provider_id}/settings")
async def get_provider_settings(
    provider_id: UUIDPath,
    db: AsyncSession = Depends(get_db),
    principal = Depends(get_admin_or_crew_admin),
):
    """Company settings for the client admin dashboard. These details are
    auto-populated into the top-left corner of the PDF PRF."""
    pid = uuid.UUID(provider_id)
    _assert_settings_access(principal, pid)
    provider = await _load_provider(db, pid)

    admin_res = await db.execute(
        select(CrewMember.email)
        .where(CrewMember.provider_id == pid, CrewMember.role == "admin")
        .limit(1)
    )
    return {
        "id": str(provider.id),
        "name": provider.name,
        "slug": provider.slug,
        "pr_number": provider.pr_number,
        "pty_reg_number": provider.pty_reg_number,
        "prf_name": provider.prf_name,
        "phone": provider.phone,
        "email": provider.email,
        "address": provider.address,
        "logo_url": provider.logo_url,
        "portal_login_username": provider.portal_login_email,
        "admin_email": admin_res.scalar_one_or_none(),
        "smtp_service": provider.smtp_service,
        "smtp_email": provider.smtp_email,
        "smtp_configured": bool(provider.smtp_email and provider.smtp_password_encrypted),
    }


@router.patch("/{provider_id}/settings")
async def update_provider_settings(
    provider_id: UUIDPath,
    body: ProviderSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    principal = Depends(get_admin_or_crew_admin),
):
    """Update company details, portal credentials, and admin login."""
    pid = uuid.UUID(provider_id)
    _assert_settings_access(principal, pid)
    provider = await _load_provider(db, pid)

    data = body.model_dump(exclude_unset=True)
    for key in ("name", "pr_number", "pty_reg_number", "prf_name", "phone", "email", "address"):
        if key in data:
            val = (data[key] or "").strip() or None
            if key == "name":
                if not val:
                    raise HTTPException(400, "Company name cannot be empty")
                provider.name = val
            else:
                setattr(provider, key, val)

    # EMSMCA Client Login (shared portal credentials)
    if body.portal_login_username is not None:
        new_username = body.portal_login_username.strip().lower() or None
        if new_username and new_username != (provider.portal_login_email or "").lower():
            dup = await db.execute(
                select(ServiceProvider).where(
                    ServiceProvider.portal_login_email == new_username,
                    ServiceProvider.id != pid,
                )
            )
            if dup.scalar_one_or_none():
                raise HTTPException(400, "Portal login username is already in use by another client.")
        provider.portal_login_email = new_username
    if body.portal_login_password and body.portal_login_password.strip():
        _validate_portal_password(body.portal_login_password)
        provider.portal_login_password_hash = hash_password(body.portal_login_password)

    # PRF numbering baseline. Only touched when the admin actually entered a
    # value — a blank field leaves the existing counter untouched, so
    # re-saving other settings never resets the sequence. The next digital PRF
    # will be this value + 1 (see `_next_prf_number`).
    baseline = _coerce_prf_baseline(body.current_prf_number)
    if baseline is not None:
        provider.prf_start_number = baseline

    # PRF outbound email account (Gmail/Outlook), validated + encrypted.
    _apply_smtp_settings(provider, body.model_dump(exclude_unset=True))
    await _verify_new_smtp_credential(body.model_dump(exclude_unset=True), provider)

    # Portal Admin Login (admin crew member)
    if body.admin_email or (body.admin_password and body.admin_password.strip()):
        admin_res = await db.execute(
            select(CrewMember)
            .where(CrewMember.provider_id == pid, CrewMember.role == "admin")
            .limit(1)
        )
        admin = admin_res.scalar_one_or_none()
        new_email = body.admin_email.strip().lower() if body.admin_email else None

        if new_email and (not admin or new_email != (admin.email or "").lower()):
            dup_q = select(CrewMember).where(CrewMember.email == new_email)
            if admin:
                dup_q = dup_q.where(CrewMember.id != admin.id)
            dup = await db.execute(dup_q)
            if dup.scalar_one_or_none():
                raise HTTPException(400, f"Admin email '{new_email}' is already registered to another user.")

        if admin:
            if new_email:
                admin.email = new_email
            if body.admin_password and body.admin_password.strip():
                admin.hashed_password = hash_password(body.admin_password)
        elif new_email and body.admin_password and body.admin_password.strip():
            db.add(CrewMember(
                provider_id=pid,
                email=new_email,
                hashed_password=hash_password(body.admin_password),
                full_name=f"{provider.name} Admin",
                initials="AD",
                qualification=DEFAULT_CATEGORY,
                role="admin",
                is_active=True,
            ))

    await db.commit()
    logger.info("Updated settings for provider %s", provider_id)
    return {"message": "Settings updated", "id": str(provider.id)}


ALLOWED_LOGO_EXTENSIONS = {".png", ".jpg", ".jpeg", ".svg", ".webp"}


@router.post("/{provider_id}/settings/logo")
async def upload_provider_logo_settings(
    provider_id: UUIDPath,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    principal = Depends(get_admin_or_crew_admin),
):
    """Upload a company logo from the client admin dashboard."""
    pid = uuid.UUID(provider_id)
    _assert_settings_access(principal, pid)
    provider = await _load_provider(db, pid)

    file_ext = (os.path.splitext(file.filename)[1] if file.filename else ".png").lower()
    if file_ext not in ALLOWED_LOGO_EXTENSIONS:
        raise HTTPException(400, f"Unsupported logo format '{file_ext}'. Use PNG, JPG, SVG or WEBP.")

    # basename() as well as the create-time slug validation. Providers created
    # BEFORE that validation existed may already hold a traversing slug, and
    # this is the line that turns one into a write outside UPLOAD_DIR.
    safe_filename = os.path.basename(f"{provider.slug}_logo{file_ext}")
    file_path = os.path.join(UPLOAD_DIR, safe_filename)
    if os.path.dirname(os.path.abspath(file_path)) != os.path.abspath(UPLOAD_DIR):
        raise HTTPException(400, "Invalid provider slug for a filename")
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    provider.logo_url = f"/uploads/logos/{safe_filename}"
    await db.commit()
    logger.info("Uploaded logo for provider %s", provider_id)
    return {"logo_url": provider.logo_url}


# ═══════════════════════════════════════════════════════════
# CREW MEMBER ENDPOINTS
# ═══════════════════════════════════════════════════════════

@router.get("/{provider_id}/crew")
async def list_crew(
    provider_id: UUIDPath,
    db: AsyncSession = Depends(get_db),
    principal = Depends(get_admin_or_crew_admin),
):
    """List all crew members for a provider."""
    _assert_settings_access(principal, uuid.UUID(provider_id))
    result = await db.execute(
        select(CrewMember)
        .where(CrewMember.provider_id == uuid.UUID(provider_id))
        .order_by(CrewMember.full_name)
    )
    crew = result.scalars().all()
    return [
        {
            "id": str(c.id),
            "email": c.email,
            "full_name": c.full_name,
            "initials": c.initials,
            "hpcsa_number": c.hpcsa_number,
            "qualification": c.qualification,
            "phone": c.phone,
            "role": c.role,
            "is_active": c.is_active,
            "photo_url": c.photo_url,
            "last_login": c.last_login.isoformat() if c.last_login else None,
            "created_at": c.created_at.isoformat() if c.created_at else None,
        }
        for c in crew
    ]


@router.post("/{provider_id}/crew", status_code=201)
async def add_crew_member(
    provider_id: UUIDPath,
    body: CrewMemberCreate,
    db: AsyncSession = Depends(get_db),
    principal = Depends(get_admin_or_crew_admin),
):
    """Add a new crew member to a provider."""
    _assert_settings_access(principal, uuid.UUID(provider_id))
    # Verify provider exists
    provider = await db.execute(
        select(ServiceProvider).where(ServiceProvider.id == uuid.UUID(provider_id))
    )
    if not provider.scalar_one_or_none():
        raise HTTPException(404, "Provider not found")

    # HPCSA is the primary identifier — must be unique per provider
    if body.hpcsa_number:
        existing_hpcsa = await db.execute(
            select(CrewMember).where(
                CrewMember.hpcsa_number == body.hpcsa_number.strip().upper(),
                CrewMember.provider_id == uuid.UUID(provider_id),
            )
        )
        if existing_hpcsa.scalar_one_or_none():
            raise HTTPException(400, f"HPCSA number '{body.hpcsa_number}' is already registered for this provider.")

    # Auto-generate a placeholder email if not supplied (login by email is not used)
    email = (body.email or f"{body.hpcsa_number or uuid.uuid4().hex[:8]}@hpcsa.placeholder").strip().lower()

    # Ensure email is unique across all crew
    existing_email = await db.execute(select(CrewMember).where(CrewMember.email == email))
    if existing_email.scalar_one_or_none():
        email = f"{uuid.uuid4().hex[:8]}.{email}"  # de-dupe with prefix

    crew = CrewMember(
        provider_id=uuid.UUID(provider_id),
        email=email,
        hashed_password=hash_password(uuid.uuid4().hex),  # unusable random password
        full_name=body.full_name.strip(),
        initials=body.initials,
        hpcsa_number=body.hpcsa_number.strip().upper() if body.hpcsa_number else None,
        qualification=_validate_category(body.qualification, required=False) if body.role == "admin" else _validate_category(body.qualification, required=True),
        phone=body.phone,
        role=body.role,
    )
    db.add(crew)
    await db.commit()
    await db.refresh(crew)
    logger.info("Added crew member: %s (HPCSA: %s) to provider %s", crew.full_name, crew.hpcsa_number, provider_id)

    return {
        "id": str(crew.id),
        "full_name": crew.full_name,
        "hpcsa_number": crew.hpcsa_number,
        "qualification": crew.qualification,
        "message": "Crew member registered. They may now sign in with their HPCSA number.",
    }


@router.patch("/{provider_id}/crew/{crew_id}")
async def update_crew_member(
    provider_id: UUIDPath,
    crew_id: UUIDPath,
    body: CrewMemberUpdate,
    db: AsyncSession = Depends(get_db),
    principal = Depends(get_admin_or_crew_admin),
):
    """Update a crew member's details."""
    _assert_settings_access(principal, uuid.UUID(provider_id))
    result = await db.execute(
        select(CrewMember).where(
            CrewMember.id == uuid.UUID(crew_id),
            CrewMember.provider_id == uuid.UUID(provider_id),
        )
    )
    crew = result.scalar_one_or_none()
    if not crew:
        raise HTTPException(404, "Crew member not found")

    # Reactivating one person cannot quietly reopen a deactivated client. Their
    # login would still be refused (every sign-in gate reads the provider's
    # flag), so the only thing this would achieve is a crew member who looks
    # active in the admin list and cannot start a shift.
    if body.is_active is True and not crew.is_active:
        provider = await _load_provider(db, uuid.UUID(provider_id))
        if not provider.is_active:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"{provider.name} is deactivated, so its crew cannot be "
                    f"reactivated individually. Reactivate the client first."
                ),
            )

    for key, val in body.model_dump(exclude_unset=True).items():
        if key == "qualification":
            val = _validate_category(val, required=False)
            if val is None:
                continue   # silently skip "unset" qualification PATCHes
        setattr(crew, key, val)

    # An individual deactivation is not a cascaded one: reactivating the client
    # must not hand this person their login back. Clearing the flag on an
    # individual reactivation keeps the two states from blurring together.
    if body.is_active is not None:
        crew.deactivated_with_provider = False

    await db.commit()
    return {"message": "Crew member updated", "id": str(crew.id)}


@router.post("/{provider_id}/crew/{crew_id}/photo")
async def upload_crew_photo(
    provider_id: UUIDPath,
    crew_id: UUIDPath,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    principal = Depends(get_admin_or_crew_admin),
):
    """Upload / replace a crew member's face photo.

    The image is centre-cropped to a square and resized to a 256×256 JPEG
    thumbnail (~20-40KB) so storage stays tiny even across thousands of crew —
    only the file lands on disk, and just the URL string on the row (never the
    image bytes)."""
    _assert_settings_access(principal, uuid.UUID(provider_id))
    result = await db.execute(
        select(CrewMember).where(
            CrewMember.id == uuid.UUID(crew_id),
            CrewMember.provider_id == uuid.UUID(provider_id),
        )
    )
    crew = result.scalar_one_or_none()
    if not crew:
        raise HTTPException(404, "Crew member not found")

    ext = (os.path.splitext(file.filename)[1] if file.filename else "").lower()
    if ext and ext not in ALLOWED_PHOTO_EXTENSIONS:
        raise HTTPException(400, f"Unsupported image format '{ext}'. Use PNG, JPG or WEBP.")

    raw = await file.read()
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        # Centre-crop to a square, then resize down to a 256×256 thumbnail.
        w, h = img.size
        side = min(w, h)
        left, top = (w - side) // 2, (h - side) // 2
        img = img.crop((left, top, left + side, top + side)).resize((256, 256), Image.LANCZOS)
    except Exception:
        raise HTTPException(400, "Could not read the image file.")

    filename = f"{crew.id}.jpg"
    img.save(os.path.join(CREW_PHOTO_DIR, filename), "JPEG", quality=80, optimize=True)

    crew.photo_url = f"/uploads/crew/{filename}"
    await db.commit()
    logger.info("Uploaded crew photo for %s (%s)", crew.full_name, crew.id)
    return {"photo_url": crew.photo_url}


@router.post("/{provider_id}/crew/{crew_id}/reset-password")
async def reset_crew_password(
    provider_id: UUIDPath,
    crew_id: UUIDPath,
    db: AsyncSession = Depends(get_db),
    principal = Depends(get_admin_or_crew_admin),
):
    """Reset a crew member's password (admin action)."""
    _assert_settings_access(principal, uuid.UUID(provider_id))
    result = await db.execute(
        select(CrewMember).where(
            CrewMember.id == uuid.UUID(crew_id),
            CrewMember.provider_id == uuid.UUID(provider_id),
        )
    )
    crew = result.scalar_one_or_none()
    if not crew:
        raise HTTPException(404, "Crew member not found")

    new_password = f"Crew@{uuid.uuid4().hex[:8].capitalize()}"
    crew.hashed_password = hash_password(new_password)
    await db.commit()
    return {"message": "Password reset", "temp_password": new_password}


@router.delete("/{provider_id}/crew/{crew_id}")
async def delete_crew_member(
    provider_id: UUIDPath,
    crew_id: UUIDPath,
    db: AsyncSession = Depends(get_db),
    principal = Depends(get_admin_or_crew_admin),
):
    """Delete a crew member from a provider."""
    _assert_settings_access(principal, uuid.UUID(provider_id))
    result = await db.execute(
        select(CrewMember).where(
            CrewMember.id == uuid.UUID(crew_id),
            CrewMember.provider_id == uuid.UUID(provider_id),
        )
    )
    crew = result.scalar_one_or_none()
    if not crew:
        raise HTTPException(404, "Crew member not found")

    from sqlalchemy import update
    from app.models.digital_prf import DigitalPRF

    # This used to force-DELETE every PRF where this person was crew 1 OR crew
    # 2, with no status filter and no audit entry. Deactivating a paramedic who
    # had left therefore destroyed every patient report they had ever written or
    # merely co-signed — including PROCESSED records inside the seven-year
    # retention window, and reports authored by somebody else where they were
    # only the second crew member. The Claims survived as billable rows with no
    # source document, leaving the provider billing schemes for calls whose PRF
    # no longer existed.
    #
    # A PRF is a clinical and legal record. It outlives the employment of the
    # person who wrote it, so removing a crew member must never remove one.
    #
    # Authorship: if this person is crew 1 on any PRF, deleting the row would
    # leave that record unattributable, so we refuse and point the admin at
    # deactivation — which already blocks login and hides them from the shift
    # picker while keeping the record intact.
    authored = await db.execute(
        select(func.count(DigitalPRF.id)).where(DigitalPRF.crew_member_1_id == crew.id)
    )
    authored_count = authored.scalar_one() or 0
    if authored_count:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{crew.full_name} is the recorded practitioner on {authored_count} "
                f"Patient Report Form(s), which must be retained. Deactivate this "
                f"crew member instead — they will no longer be able to log in or "
                f"start a shift, and their reports stay intact."
            ),
        )

    # Only a partner reference remains. Null it, exactly as delete_vehicle does:
    # the report keeps its author and its content.
    await db.execute(
        update(DigitalPRF)
        .where(DigitalPRF.crew_member_2_id == crew.id)
        .values(crew_member_2_id=None)
    )

    await db.delete(crew)
    await db.commit()

    logger.info("Deleted crew member: %s from provider %s", crew_id, provider_id)
    return {"message": "Crew member deleted"}


# ═══════════════════════════════════════════════════════════
# VEHICLE ENDPOINTS
# ═══════════════════════════════════════════════════════════

@router.get("/{provider_id}/vehicles")
async def list_vehicles(
    provider_id: UUIDPath,
    db: AsyncSession = Depends(get_db),
    principal = Depends(get_admin_or_crew_admin),
):
    """List all vehicles for a provider, plus whether each one is currently
    on an in-progress call. `is_active` reflects registry enable/disable;
    `in_use` reflects whether the vehicle is bound to a DRAFT PRF right
    now (i.e. a crew is mid-shift in that ambulance). The admin dashboard
    shows In Use / Available based on `in_use`, not `is_active`.
    """
    pid = uuid.UUID(provider_id)
    _assert_settings_access(principal, pid)
    result = await db.execute(
        select(Vehicle)
        .where(Vehicle.provider_id == pid)
        .order_by(Vehicle.callsign)
    )
    vehicles = result.scalars().all()

    # Single round-trip: which vehicle_ids have a DRAFT PRF right now?
    in_use_res = await db.execute(
        select(DigitalPRF.vehicle_id)
        .where(
            DigitalPRF.provider_id == pid,
            DigitalPRF.status == PRFStatus.DRAFT,
            DigitalPRF.vehicle_id.is_not(None),
        )
        .distinct()
    )
    in_use_ids: set[uuid.UUID] = {row[0] for row in in_use_res.all() if row[0] is not None}

    return [
        {
            "id": str(v.id),
            "callsign": v.callsign,
            "registration": v.registration,
            "vehicle_type": v.vehicle_type,
            "is_active": v.is_active,
            "in_use": v.id in in_use_ids,
            "photo_url": v.photo_url,
            "created_at": v.created_at.isoformat() if v.created_at else None,
        }
        for v in vehicles
    ]


@router.post("/{provider_id}/vehicles", status_code=201)
async def add_vehicle(
    provider_id: UUIDPath,
    body: VehicleCreate,
    db: AsyncSession = Depends(get_db),
    principal = Depends(get_admin_or_crew_admin),
):
    """Add a vehicle to a provider's fleet."""
    _assert_settings_access(principal, uuid.UUID(provider_id))
    vehicle = Vehicle(
        provider_id=uuid.UUID(provider_id),
        callsign=body.callsign,
        registration=body.registration,
        vehicle_type=body.vehicle_type,
    )
    db.add(vehicle)
    await db.commit()
    await db.refresh(vehicle)
    logger.info("Added vehicle %s (%s) to provider %s", vehicle.callsign, vehicle.registration, provider_id)
    return {"id": str(vehicle.id), "callsign": vehicle.callsign, "registration": vehicle.registration}


@router.patch("/{provider_id}/vehicles/{vehicle_id}")
async def update_vehicle(
    provider_id: UUIDPath,
    vehicle_id: UUIDPath,
    body: VehicleUpdate,
    db: AsyncSession = Depends(get_db),
    principal = Depends(get_admin_or_crew_admin),
):
    """Update a vehicle's details."""
    _assert_settings_access(principal, uuid.UUID(provider_id))
    result = await db.execute(
        select(Vehicle).where(
            Vehicle.id == uuid.UUID(vehicle_id),
            Vehicle.provider_id == uuid.UUID(provider_id),
        )
    )
    vehicle = result.scalar_one_or_none()
    if not vehicle:
        raise HTTPException(404, "Vehicle not found")
    for key, val in body.model_dump(exclude_unset=True).items():
        setattr(vehicle, key, val)
    await db.commit()
    return {"message": "Vehicle updated", "id": str(vehicle.id)}


@router.post("/{provider_id}/vehicles/{vehicle_id}/photo")
async def upload_vehicle_photo(
    provider_id: UUIDPath,
    vehicle_id: UUIDPath,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    principal = Depends(get_admin_or_crew_admin),
):
    """Upload / replace an ambulance photo.

    Centre-cropped to a square and resized to a 256×256 JPEG thumbnail
    (~20-40KB) — only the file lands on disk, and just the URL string on the
    row (never the image bytes)."""
    _assert_settings_access(principal, uuid.UUID(provider_id))
    result = await db.execute(
        select(Vehicle).where(
            Vehicle.id == uuid.UUID(vehicle_id),
            Vehicle.provider_id == uuid.UUID(provider_id),
        )
    )
    vehicle = result.scalar_one_or_none()
    if not vehicle:
        raise HTTPException(404, "Vehicle not found")

    ext = (os.path.splitext(file.filename)[1] if file.filename else "").lower()
    if ext and ext not in ALLOWED_PHOTO_EXTENSIONS:
        raise HTTPException(400, f"Unsupported image format '{ext}'. Use PNG, JPG or WEBP.")

    raw = await file.read()
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        # Centre-crop to a square, then resize down to a 256×256 thumbnail.
        w, h = img.size
        side = min(w, h)
        left, top = (w - side) // 2, (h - side) // 2
        img = img.crop((left, top, left + side, top + side)).resize((256, 256), Image.LANCZOS)
    except Exception:
        raise HTTPException(400, "Could not read the image file.")

    filename = f"{vehicle.id}.jpg"
    img.save(os.path.join(VEHICLE_PHOTO_DIR, filename), "JPEG", quality=80, optimize=True)

    vehicle.photo_url = f"/uploads/vehicles/{filename}"
    await db.commit()
    logger.info("Uploaded vehicle photo for %s (%s)", vehicle.callsign, vehicle.id)
    return {"photo_url": vehicle.photo_url}


@router.delete("/{provider_id}/vehicles/{vehicle_id}")
async def delete_vehicle(
    provider_id: UUIDPath,
    vehicle_id: UUIDPath,
    db: AsyncSession = Depends(get_db),
    principal = Depends(get_admin_or_crew_admin),
):
    """Delete a vehicle from a provider's fleet."""
    _assert_settings_access(principal, uuid.UUID(provider_id))
    result = await db.execute(
        select(Vehicle).where(
            Vehicle.id == uuid.UUID(vehicle_id),
            Vehicle.provider_id == uuid.UUID(provider_id),
        )
    )
    vehicle = result.scalar_one_or_none()
    if not vehicle:
        raise HTTPException(404, "Vehicle not found")

    from sqlalchemy import update
    from app.models.digital_prf import DigitalPRF

    # Preserve historical PRFs by nulling their vehicle reference
    await db.execute(
        update(DigitalPRF)
        .where(DigitalPRF.vehicle_id == vehicle.id)
        .values(vehicle_id=None)
    )

    await db.delete(vehicle)
    await db.commit()
    logger.info("Deleted vehicle: %s from provider %s", vehicle_id, provider_id)
    return {"message": "Vehicle deleted"}


# ═══════════════════════════════════════════════════════════
# SUBMITTED PRF ENDPOINTS (client admin dashboard)
# ═══════════════════════════════════════════════════════════

@router.get("/{provider_id}/prfs")
async def list_provider_prfs(
    provider_id: UUIDPath,
    response: Response,
    search: Optional[str] = None,
    skip: int = 0,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    principal = Depends(get_admin_or_crew_admin),
):
    """List this provider's submitted PRFs for the client admin dashboard.

    Drafts are excluded — a PRF only lands here once the crew has actually
    submitted it (SUBMITTED → PROCESSED / FAILED / CORRECTED). Selects only
    the summary columns: full rows carry five base64 signatures each, which
    would bloat a list response badly.

    Response body stays a bare array (backward-compatible: cached/old frontend
    bundles call .filter on it directly, so we must NOT wrap it in an object).
    The match total rides in the `X-Total-Count` header, so the dashboard can
    page/search across the full 7-year retained history instead of silently
    capping at one page. Server-side search covers PRF number, case number, and
    the form_data blob (patient name, call type, scheme). Crew/vehicle names are
    resolved only for the selected page and are not part of the search.
    """
    pid = uuid.UUID(provider_id)
    _assert_settings_access(principal, pid)

    conditions = [
        DigitalPRF.provider_id == pid,
        DigitalPRF.status != PRFStatus.DRAFT,
    ]
    if search and search.strip():
        term = f"%{search.strip()}%"
        id_clauses = [
            cast(DigitalPRF.prf_number, Text).ilike(term),
            DigitalPRF.case_number.ilike(term),
            # search_text, NOT cast(form_data AS text).
            #
            # The blob scan detoasted and read the whole clinical payload of
            # every one of this provider's PRFs — production rows average 150 KB
            # and are mostly base64 signatures and photos that nobody searches.
            # Measured on a provider with 559 records: 146 ms against the blob,
            # 2.5 ms without it. This column holds the same text minus the
            # images, the nested clinical arrays and the ciphertext, and carries
            # a trigram index. See migration d5b7e91a3c62.
            DigitalPRF.search_text.ilike(term),
        ]
        # Searching by SA ID number.
        #
        # The blob scan above cannot find one any more: the ID inside form_data
        # is encrypted, so an ILIKE matches ciphertext and returns nothing —
        # silently, which is the dangerous part. An operator typing an ID would
        # conclude the patient is not in the system.
        #
        # The keyed hash restores it, and is strictly faster than what it
        # replaces: an indexed equality check rather than detoasting and
        # scanning every clinical blob. Only attempted when the term actually
        # looks like an identifier, so ordinary text searches skip it.
        from app.utils.patient_id import id_hash, normalise_id
        digits = normalise_id(search)
        if len(digits) >= 6:
            hashed = id_hash(digits)
            if hashed:
                id_clauses.append(DigitalPRF.patient_id_hash == hashed)
        conditions.append(or_(*id_clauses))

    total = (await db.execute(
        select(func.count()).select_from(DigitalPRF).where(*conditions)
    )).scalar() or 0

    result = await db.execute(
        select(
            DigitalPRF.id,
            DigitalPRF.prf_number,
            DigitalPRF.case_number,
            DigitalPRF.case_id,
            DigitalPRF.status,
            DigitalPRF.form_data,
            DigitalPRF.vehicle_id,
            DigitalPRF.crew_member_1_id,
            DigitalPRF.crew_member_2_id,
            DigitalPRF.submitted_at,
            DigitalPRF.created_at,
        )
        .where(*conditions)
        .order_by(func.coalesce(DigitalPRF.submitted_at, DigitalPRF.created_at).desc())
        .offset(skip)
        .limit(limit)
    )
    rows = result.all()

    # Batch-resolve crew + vehicle names (two queries total, not 3 per row).
    crew_ids = {r.crew_member_1_id for r in rows} | {r.crew_member_2_id for r in rows}
    crew_ids.discard(None)
    crew_names: dict[uuid.UUID, str] = {}
    if crew_ids:
        crew_res = await db.execute(
            select(CrewMember.id, CrewMember.full_name).where(CrewMember.id.in_(crew_ids))
        )
        crew_names = {cid: name for cid, name in crew_res.all()}

    vehicle_ids = {r.vehicle_id for r in rows}
    vehicle_ids.discard(None)
    vehicle_callsigns: dict[uuid.UUID, str] = {}
    if vehicle_ids:
        veh_res = await db.execute(
            select(Vehicle.id, Vehicle.callsign).where(Vehicle.id.in_(vehicle_ids))
        )
        vehicle_callsigns = {vid: cs for vid, cs in veh_res.all()}

    items = []
    for r in rows:
        fd = r.form_data if isinstance(r.form_data, dict) else {}
        patient_name = " ".join(
            str(part).strip()
            for part in (fd.get("patient_name"), fd.get("patient_surname"))
            if part
        ).strip()
        items.append({
            "id": str(r.id),
            "prf_number": r.prf_number,
            "case_number": r.case_number,
            # case_id is set once the billing pipeline finishes — the dashboard
            # only enables "View" when it exists (the PRF viewer loads by case).
            "case_id": str(r.case_id) if r.case_id else None,
            "status": r.status.value,
            "patient_name": patient_name or None,
            "call_type": fd.get("call_type"),
            "crew_1": crew_names.get(r.crew_member_1_id),
            "crew_2": crew_names.get(r.crew_member_2_id),
            "vehicle": vehicle_callsigns.get(r.vehicle_id),
            "submitted_at": r.submitted_at.isoformat() if r.submitted_at else None,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        })
    # Bare array body (backward-compatible); total in a header so old cached
    # frontends that call .filter on the response keep working after deploy.
    response.headers["X-Total-Count"] = str(int(total))
    return items
