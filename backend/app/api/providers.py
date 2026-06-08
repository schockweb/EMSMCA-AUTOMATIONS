"""
Service Provider Admin API — CRUD for providers, crew members, and vehicles.
Admin-only endpoints for onboarding and managing service providers.
"""
from __future__ import annotations
import uuid
import logging
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.service_provider import ServiceProvider
from app.models.crew_member import CrewMember
from app.models.vehicle import Vehicle
from app.models.digital_prf import DigitalPRF, PRFStatus
from app.utils.security import get_current_user, hash_password
from app.utils.hpcsa import HPCSA_CATEGORIES, DEFAULT_CATEGORY, normalise_category
from app.models.user import User

logger = logging.getLogger("ems.providers")

router = APIRouter(prefix="/api/providers", tags=["Service Providers"])


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
    phone: str | None = None
    email: str | None = None
    address: str | None = None

class ProviderUpdate(BaseModel):
    name: str | None = None
    pr_number: str | None = None
    pty_reg_number: str | None = None
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    logo_url: str | None = None
    is_active: bool | None = None

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
        items.append({
            "id": str(p.id),
            "name": p.name,
            "slug": p.slug,
            "pr_number": p.pr_number,
            "pty_reg_number": p.pty_reg_number,
            "phone": p.phone,
            "email": p.email,
            "address": p.address,
            "logo_url": p.logo_url,
            "is_active": p.is_active,
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

    provider = ServiceProvider(
        name=body.name,
        slug=slug,
        pr_number=body.pr_number,
        pty_reg_number=body.pty_reg_number,
        phone=body.phone,
        email=body.email,
        address=body.address,
    )
    db.add(provider)
    await db.commit()
    await db.refresh(provider)
    logger.info("Created provider: %s (%s)", provider.name, provider.slug)
    return {"id": str(provider.id), "name": provider.name, "slug": provider.slug}


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
    """Update provider details."""
    result = await db.execute(
        select(ServiceProvider).where(ServiceProvider.id == uuid.UUID(provider_id))
    )
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(404, "Provider not found")
    for key, val in body.model_dump(exclude_unset=True).items():
        setattr(provider, key, val)
    await db.commit()
    return {"message": "Provider updated", "id": str(provider.id)}


# ═══════════════════════════════════════════════════════════
# CREW MEMBER ENDPOINTS
# ═══════════════════════════════════════════════════════════

@router.get("/{provider_id}/crew")
async def list_crew(
    provider_id: str,
    db: AsyncSession = Depends(get_db),
    _auth = Depends(get_admin_or_crew_admin),
):
    """List all crew members for a provider."""
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
    _auth = Depends(get_admin_or_crew_admin),
):
    """Add a new crew member to a provider."""
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
    _auth = Depends(get_admin_or_crew_admin),
):
    """Update a crew member's details."""
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


@router.post("/{provider_id}/crew/{crew_id}/reset-password")
async def reset_crew_password(
    provider_id: str,
    crew_id: str,
    db: AsyncSession = Depends(get_db),
    _auth = Depends(get_admin_or_crew_admin),
):
    """Reset a crew member's password (admin action)."""
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
    _auth = Depends(get_admin_or_crew_admin),
):
    """Delete a crew member from a provider."""
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
    _auth = Depends(get_admin_or_crew_admin),
):
    """List all vehicles for a provider, plus whether each one is currently
    on an in-progress call. `is_active` reflects registry enable/disable;
    `in_use` reflects whether the vehicle is bound to a DRAFT PRF right
    now (i.e. a crew is mid-shift in that ambulance). The admin dashboard
    shows In Use / Available based on `in_use`, not `is_active`.
    """
    pid = uuid.UUID(provider_id)
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
            "created_at": v.created_at.isoformat() if v.created_at else None,
        }
        for v in vehicles
    ]


@router.post("/{provider_id}/vehicles", status_code=201)
async def add_vehicle(
    provider_id: str,
    body: VehicleCreate,
    db: AsyncSession = Depends(get_db),
    _auth = Depends(get_admin_or_crew_admin),
):
    """Add a vehicle to a provider's fleet."""
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
    _auth = Depends(get_admin_or_crew_admin),
):
    """Update a vehicle's details."""
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


@router.delete("/{provider_id}/vehicles/{vehicle_id}")
async def delete_vehicle(
    provider_id: str,
    vehicle_id: str,
    db: AsyncSession = Depends(get_db),
    _auth = Depends(get_admin_or_crew_admin),
):
    """Delete a vehicle from a provider's fleet."""
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
