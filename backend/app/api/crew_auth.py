"""
Crew Authentication API — Login, profile, and password management for crew members.
Separate from the admin auth system — crew get a JWT with provider_id + crew_id claims.
"""
import logging
from datetime import datetime, timedelta, timezone

# Shift tokens live long enough to cover a full EMS shift with breaks / device sleep.
# The tablet may go idle while the crew attends to a patient — the session must persist
# until the physical End Shift button is pressed.
CREW_SHIFT_TOKEN_HOURS = 12

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.crew_member import CrewMember
from app.models.service_provider import ServiceProvider
from app.utils.security import (
    verify_password,
    hash_password,
    create_access_token,
    decode_token,
)
from fastapi.security import OAuth2PasswordBearer

logger = logging.getLogger("ems.crew_auth")

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
    result = await db.execute(select(CrewMember).where(CrewMember.id == crew_id))
    crew = result.scalar_one_or_none()
    if not crew or not crew.is_active:
        raise HTTPException(status_code=401, detail="Crew member not found or inactive")
    return crew


# ── Endpoints ────────────────────────────────────────────────

@router.post("/login", response_model=CrewLoginResponse)
async def crew_login(body: CrewLoginRequest, db: AsyncSession = Depends(get_db)):
    """Authenticate a crew member and return a JWT."""
    result = await db.execute(
        select(CrewMember).where(CrewMember.email == body.email.strip().lower())
    )
    crew = result.scalar_one_or_none()

    if not crew or not verify_password(body.password, crew.hashed_password):
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

    # Update last_login
    crew.last_login = datetime.now(timezone.utc)
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


@router.post("/change-password")
async def crew_change_password(
    current_password: str,
    new_password: str,
    crew: CrewMember = Depends(get_current_crew),
    db: AsyncSession = Depends(get_db),
):
    """Change the crew member's password."""
    if not verify_password(current_password, crew.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    crew.hashed_password = hash_password(new_password)
    await db.commit()
    return {"message": "Password updated successfully"}


# ── HPCSA-based shift-start lookup (no password needed) ──────

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
async def crew_lookup_by_hpcsa(body: ShiftLookupRequest, db: AsyncSession = Depends(get_db)):
    """
    Authenticate a crew member by HPCSA number + name for the shift-start flow.
    Used on mobile where email/password login is replaced by HPCSA card scan / manual entry.
    """
    # Look up by HPCSA number within the given provider
    provider_result = await db.execute(
        select(ServiceProvider).where(ServiceProvider.slug == body.provider_slug.strip().lower())
    )
    provider = provider_result.scalar_one_or_none()
    if not provider or not provider.is_active:
        raise HTTPException(status_code=404, detail="Provider not found")

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

