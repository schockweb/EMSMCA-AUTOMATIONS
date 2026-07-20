"""
Service Provider Admin API — CRUD for providers, crew members, and vehicles.
Admin-only endpoints for onboarding and managing service providers.
"""
from __future__ import annotations
import uuid
import logging
import re
from datetime import datetime, timezone

import os
import io
import shutil
from PIL import Image
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from pydantic import BaseModel, EmailStr
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.service_provider import ServiceProvider
from app.models.crew_member import CrewMember
from app.models.vehicle import Vehicle
from app.models.digital_prf import DigitalPRF, PRFStatus
from app.utils.security import get_current_user, hash_password, verify_password, verify_password_async
from app.utils.hpcsa import HPCSA_CATEGORIES, DEFAULT_CATEGORY, normalise_category
from app.models.user import User

logger = logging.getLogger("ems.providers")

router = APIRouter(prefix="/api/providers", tags=["Service Providers"])

UPLOAD_DIR = "/app/uploads/logos"
os.makedirs(UPLOAD_DIR, exist_ok=True)

CREW_PHOTO_DIR = "/app/uploads/crew"
os.makedirs(CREW_PHOTO_DIR, exist_ok=True)
VEHICLE_PHOTO_DIR = "/app/uploads/vehicles"
os.makedirs(VEHICLE_PHOTO_DIR, exist_ok=True)
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
    """Accept either an admin user token OR a crew admin token."""
    from app.utils.security import decode_token as _decode
    # Try admin token first
    if admin_token:
        try:
            payload = _decode(admin_token)
            if payload.get("token_scope") != "crew":
                from app.models.user import User as _U
                result = await db.execute(select(_U).where(_U.id == payload.get("sub")))
                user = result.scalar_one_or_none()
                if user:
                    return user
        except Exception:
            pass
    # Try crew token
    if crew_token:
        try:
            payload = _decode(crew_token)
            if payload.get("token_scope") == "crew":
                crew_id = payload.get("crew_id")
                result = await db.execute(select(CrewMember).where(CrewMember.id == crew_id))
                crew = result.scalar_one_or_none()
                if crew and crew.is_active:
                    return crew
        except Exception:
            pass
    raise HTTPException(status_code=401, detail="Not authenticated")


# ── Schemas ──────────────────────────────────────────────────

class ProviderCreate(BaseModel):
    name: str
    slug: str | None = None
    pr_number: str | None = None
    pty_reg_number: str | None = None
    # PRF file/display naming prefix — replaces the automatic provider-name
    # prefix in exported-PDF filenames when set; blank keeps automatic naming.
    prf_name: str | None = None
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    # PRF numbering baseline — the last PRF number already used; new PRFs for this
    # provider start after it. Same semantics as `current_prf_number` in settings.
    current_prf_number: int | None = None

    # New Client Onboarding fields
    portal_login_email: str | None = None
    portal_login_password: str | None = None
    admin_email: str | None = None
    admin_password: str | None = None

class ProviderUpdate(BaseModel):
    name: str | None = None
    pr_number: str | None = None
    pty_reg_number: str | None = None
    # PRF naming prefix. Sent as an explicit null to clear back to automatic
    # provider-name naming (unlike credentials, which are omit-to-keep).
    prf_name: str | None = None
    phone: str | None = None
    email: str | None = None
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
    current_prf_number: int | None = None

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
    """Coerce + validate an HPCSA category value from request bodies.

    Accepts a canonical category code or a legacy tier (BLS/ILS/ALS) which is
    silently normalised. Rejects anything else with HTTP 400 so the admin sees
    a clear error rather than letting bad data into the DB.
    """
    if value is None or value == "":
        if required:
            raise HTTPException(400, f"qualification is required (one of {sorted(HPCSA_CATEGORIES)})")
        return None
    normalised = normalise_category(value)
    if normalised is None:
        raise HTTPException(
            400,
            f"Invalid qualification '{value}'. Expected an HPCSA category: {sorted(HPCSA_CATEGORIES)}.",
        )
    return normalised

class VehicleCreate(BaseModel):
    callsign: str
    registration: str
    vehicle_type: str = "Ambulance"

class VehicleUpdate(BaseModel):
    callsign: str | None = None
    registration: str | None = None
    vehicle_type: str | None = None
    is_active: bool | None = None


def _slugify(name: str) -> str:
    """Generate a URL-safe slug from a provider name."""
    slug = name.lower().strip()
    slug = re.sub(r'[^a-z0-9\s-]', '', slug)
    slug = re.sub(r'[\s-]+', '-', slug).strip('-')
    return slug[:100]


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
async def portal_login(slug: str, body: PortalLoginRequest, db: AsyncSession = Depends(get_db)):
    """Verify company-wide portal credentials (portal_login_email / portal_login_password).
    These are set in the EMSMCA Client Login section when creating a provider and allow
    ALL staff (admin + crew) of that company to access their login portal.
    Returns provider info on success so the frontend can render the branded portal.
    """
    result = await db.execute(
        select(ServiceProvider).where(
            ServiceProvider.slug == slug.strip().lower(),
            ServiceProvider.is_active == True,
        )
    )
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")
    if not provider.portal_login_password_hash:
        raise HTTPException(status_code=403, detail="No portal credentials configured for this provider")
    # Case-insensitive username match
    stored_username = (provider.portal_login_email or "").strip().lower()
    submitted_username = body.username.strip().lower()
    if stored_username != submitted_username:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    if not await verify_password_async(body.password, provider.portal_login_password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    return {
        "valid": True,
        "provider_name": provider.name,
        "provider_slug": provider.slug,
        "logo_url": provider.logo_url,
        "pr_number": provider.pr_number,
    }


@router.get("/{slug}/public-vehicles")
async def list_vehicles_public_by_slug(slug: str, db: AsyncSession = Depends(get_db)):
    """List active vehicles for a provider by slug. No auth — used in crew shift-start flow."""
    provider_result = await db.execute(
        select(ServiceProvider).where(
            ServiceProvider.slug == slug.strip().lower(),
            ServiceProvider.is_active == True,
        )
    )
    provider = provider_result.scalar_one_or_none()
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

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
async def list_crew_public_by_slug(slug: str, db: AsyncSession = Depends(get_db)):
    """List active crew members for a provider by slug. No auth — used in
    the shift-start flow so the crew can pick their name from a dropdown
    instead of typing an HPCSA number. The HPCSA number is still returned
    so the existing /lookup-hpcsa flow can run unchanged once the crew
    selects themselves."""
    provider_result = await db.execute(
        select(ServiceProvider).where(
            ServiceProvider.slug == slug.strip().lower(),
            ServiceProvider.is_active == True,
        )
    )
    provider = provider_result.scalar_one_or_none()
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

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
            "hpcsa_number": c.hpcsa_number,
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
    user: User = Depends(get_current_user),
):
    """List all service providers with crew and vehicle counts."""
    result = await db.execute(select(ServiceProvider).order_by(ServiceProvider.name))
    providers = result.scalars().all()

    items = []
    for p in providers:
        # Count crew
        crew_count = await db.execute(
            select(func.count(CrewMember.id)).where(CrewMember.provider_id == p.id)
        )
        # Count vehicles
        vehicle_count = await db.execute(
            select(func.count(Vehicle.id)).where(Vehicle.provider_id == p.id)
        )
        # Count PRFs
        prf_count = await db.execute(
            select(func.count(DigitalPRF.id)).where(DigitalPRF.provider_id == p.id)
        )
        
        # Get Admin Email
        admin_crew = await db.execute(
            select(CrewMember.email).where(
                CrewMember.provider_id == p.id,
                CrewMember.role == "admin"
            ).limit(1)
        )
        admin_email = admin_crew.scalar_one_or_none()

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
            "crew_count": crew_count.scalar() or 0,
            "vehicle_count": vehicle_count.scalar() or 0,
            "prf_count": prf_count.scalar() or 0,
            "created_at": p.created_at.isoformat() if p.created_at else None,
        })

    return items


@router.post("", status_code=201)
async def create_provider(
    body: ProviderCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Create a new service provider."""
    slug = body.slug or _slugify(body.name)

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
        prf_start_number=body.current_prf_number,
        portal_login_email=portal_email,
        portal_login_password_hash=hash_password(body.portal_login_password) if body.portal_login_password else None,
    )
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
            qualification="ILS", # Default valid category
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
    provider_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Upload a logo for a service provider."""
    result = await db.execute(select(ServiceProvider).where(ServiceProvider.id == uuid.UUID(provider_id)))
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(404, "Provider not found")
        
    file_ext = (os.path.splitext(file.filename)[1] if file.filename else ".png").lower()
    if file_ext not in ALLOWED_LOGO_EXTENSIONS:
        raise HTTPException(400, f"Unsupported logo format '{file_ext}'. Use PNG, JPG, SVG or WEBP.")
    safe_filename = f"{provider.slug}_logo{file_ext}"
    file_path = os.path.join(UPLOAD_DIR, safe_filename)

    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    provider.logo_url = f"/uploads/logos/{safe_filename}"
    await db.commit()
    return {"logo_url": provider.logo_url}


@router.get("/{provider_id}")
async def get_provider(
    provider_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get full provider details."""
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
        "created_at": provider.created_at.isoformat() if provider.created_at else None,
    }


@router.patch("/{provider_id}")
async def update_provider(
    provider_id: str,
    body: ProviderUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Update provider details, portal credentials, and admin crew credentials."""
    result = await db.execute(
        select(ServiceProvider).where(ServiceProvider.id == uuid.UUID(provider_id))
    )
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(404, "Provider not found")

    # Standard fields — set directly on the model
    standard_fields = {"name", "pr_number", "pty_reg_number", "prf_name", "phone", "email", "address", "logo_url", "is_active"}
    for key, val in body.model_dump(exclude_unset=True).items():
        if key in standard_fields:
            if key == "prf_name":
                val = (val or "").strip() or None
            setattr(provider, key, val)

    # PRF numbering baseline. Only touched when the admin entered a value — a
    # blank field (None) leaves the existing counter untouched. The next digital
    # PRF continues from this value + 1 (see `_next_prf_number`).
    if body.current_prf_number is not None:
        if body.current_prf_number < 0:
            raise HTTPException(400, "Current PRF number cannot be negative.")
        provider.prf_start_number = body.current_prf_number

    # EMSMCA Client Login (portal_login_email / portal_login_password_hash on ServiceProvider)
    if body.portal_login_username is not None:
        provider.portal_login_email = body.portal_login_username.strip().lower() or None
    if body.portal_login_password is not None and body.portal_login_password.strip():
        provider.portal_login_password_hash = hash_password(body.portal_login_password)

    # Admin crew member credentials
    if body.admin_email or body.admin_password:
        admin_result = await db.execute(
            select(CrewMember).where(
                CrewMember.provider_id == uuid.UUID(provider_id),
                CrewMember.role == "admin",
            )
        )
        admin = admin_result.scalar_one_or_none()

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
                    qualification="ILS",
                    role="admin",
                    is_active=True,
                )
                db.add(admin)

    await db.commit()
    return {"message": "Provider updated", "id": str(provider.id)}


@router.delete("/{provider_id}", status_code=204)
async def delete_provider(
    provider_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Hard-delete a provider and ALL related data (crew, vehicles, PRFs, logos)."""
    from sqlalchemy import delete as sql_delete
    from app.models.digital_prf import DigitalPRF

    pid = uuid.UUID(provider_id)

    result = await db.execute(select(ServiceProvider).where(ServiceProvider.id == pid))
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(404, "Provider not found")

    # Delete logo file from disk if present
    if provider.logo_url:
        logo_path = os.path.join("/app", provider.logo_url.lstrip("/"))
        if os.path.exists(logo_path):
            try:
                os.remove(logo_path)
            except OSError:
                pass

    # Cascade delete in FK-safe order:
    # 1. PRFs linked to this provider
    await db.execute(sql_delete(DigitalPRF).where(DigitalPRF.provider_id == pid))
    # 2. Vehicles
    await db.execute(sql_delete(Vehicle).where(Vehicle.provider_id == pid))
    # 3. Crew members
    await db.execute(sql_delete(CrewMember).where(CrewMember.provider_id == pid))
    # 4. Provider itself
    await db.execute(sql_delete(ServiceProvider).where(ServiceProvider.id == pid))

    await db.commit()
    logger.info("Deleted provider %s (%s) and all related data", provider.name, provider_id)


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
    current_prf_number: int | None = None


def _assert_settings_access(principal, provider_id: uuid.UUID) -> None:
    """Crew tokens may only manage their own provider's settings, and only
    when they hold the admin role. Full admin User tokens pass unchanged."""
    if isinstance(principal, CrewMember):
        if principal.role != "admin" or principal.provider_id != provider_id:
            raise HTTPException(status_code=403, detail="Admin access required")


async def _load_provider(db: AsyncSession, pid: uuid.UUID) -> ServiceProvider:
    result = await db.execute(select(ServiceProvider).where(ServiceProvider.id == pid))
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(404, "Provider not found")
    return provider


@router.get("/{provider_id}/settings")
async def get_provider_settings(
    provider_id: str,
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
    }


@router.patch("/{provider_id}/settings")
async def update_provider_settings(
    provider_id: str,
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
        provider.portal_login_password_hash = hash_password(body.portal_login_password)

    # PRF numbering baseline. Only touched when the admin actually entered a
    # value — a blank field (None) leaves the existing counter untouched, so
    # re-saving other settings never resets the sequence. The next digital PRF
    # will be this value + 1 (see `_next_prf_number`).
    if body.current_prf_number is not None:
        if body.current_prf_number < 0:
            raise HTTPException(400, "Current PRF number cannot be negative.")
        provider.prf_start_number = body.current_prf_number

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
                qualification="ILS",
                role="admin",
                is_active=True,
            ))

    await db.commit()
    logger.info("Updated settings for provider %s", provider_id)
    return {"message": "Settings updated", "id": str(provider.id)}


ALLOWED_LOGO_EXTENSIONS = {".png", ".jpg", ".jpeg", ".svg", ".webp"}


@router.post("/{provider_id}/settings/logo")
async def upload_provider_logo_settings(
    provider_id: str,
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

    safe_filename = f"{provider.slug}_logo{file_ext}"
    file_path = os.path.join(UPLOAD_DIR, safe_filename)
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
    provider_id: str,
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
    provider_id: str,
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
    provider_id: str,
    crew_id: str,
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
    for key, val in body.model_dump(exclude_unset=True).items():
        if key == "qualification":
            val = _validate_category(val, required=False)
            if val is None:
                continue   # silently skip "unset" qualification PATCHes
        setattr(crew, key, val)
    await db.commit()
    return {"message": "Crew member updated", "id": str(crew.id)}


@router.post("/{provider_id}/crew/{crew_id}/photo")
async def upload_crew_photo(
    provider_id: str,
    crew_id: str,
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
    provider_id: str,
    crew_id: str,
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
    provider_id: str,
    crew_id: str,
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

    from sqlalchemy import delete
    from app.models.digital_prf import DigitalPRF
    
    # ⚠️ TEMPORARY ENABLEMENT: Force-delete dud PRFs associated with this crew member
    await db.execute(
        delete(DigitalPRF).where(
            (DigitalPRF.crew_member_1_id == crew.id) | 
            (DigitalPRF.crew_member_2_id == crew.id)
        )
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
    provider_id: str,
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
    provider_id: str,
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
    provider_id: str,
    vehicle_id: str,
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
    provider_id: str,
    vehicle_id: str,
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
    provider_id: str,
    vehicle_id: str,
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
    provider_id: str,
    db: AsyncSession = Depends(get_db),
    principal = Depends(get_admin_or_crew_admin),
):
    """List this provider's submitted PRFs for the client admin dashboard.

    Drafts are excluded — a PRF only lands here once the crew has actually
    submitted it (SUBMITTED → PROCESSED / FAILED / CORRECTED). Selects only
    the summary columns: full rows carry five base64 signatures each, which
    would bloat a list response badly.
    """
    pid = uuid.UUID(provider_id)
    _assert_settings_access(principal, pid)

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
        .where(
            DigitalPRF.provider_id == pid,
            DigitalPRF.status != PRFStatus.DRAFT,
        )
        .order_by(func.coalesce(DigitalPRF.submitted_at, DigitalPRF.created_at).desc())
        .limit(500)
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
    return items
