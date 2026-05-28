"""
Tariff Lines API — CRUD for per-scheme tariff code entries.

Each rate schema can have many tariff lines (base rates, mileage rates,
procedure codes, etc.).  The billing engine reads these lines at runtime
for schemes that do NOT have a hardcoded Python module (GEMS / Discovery).

Routes are nested under /api/tariff-lines and reference the parent
rate_schema by ID.
"""
import logging
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.rate_schema import RateSchema
from app.models.scheme_tariff_line import SchemeTariffLine
from app.utils.security import get_current_user

logger = logging.getLogger("ems.tariff_lines")

router = APIRouter(prefix="/api/tariff-lines", tags=["Tariff Lines"])


# ── Pydantic Schemas ────────────────────────────────────────────────────────

class TariffLineCreate(BaseModel):
    rate_schema_id: int
    tariff_code: str = Field(..., max_length=30)
    description: str
    category: str = Field(
        default="base_rate",
        pattern=r"^(base_rate|mileage|procedure|medication|consumable|equipment|admin|other)$",
    )
    level_of_care: str | None = Field(
        default=None,
        pattern=r"^(BLS|ILS|ALS)$",
    )
    loaded: bool | None = None
    primary_rate: Decimal = Field(default=Decimal("0"), ge=0)
    iht_rate: Decimal = Field(default=Decimal("0"), ge=0)
    unit: str = Field(default="per call", max_length=30)
    keywords: str | None = None
    is_active: bool = True
    notes: str | None = None


class TariffLineUpdate(BaseModel):
    tariff_code: str | None = Field(default=None, max_length=30)
    description: str | None = None
    category: str | None = Field(
        default=None,
        pattern=r"^(base_rate|mileage|procedure|medication|consumable|equipment|admin|other)$",
    )
    level_of_care: str | None = Field(default=None)
    loaded: bool | None = None
    primary_rate: Decimal | None = Field(default=None, ge=0)
    iht_rate: Decimal | None = Field(default=None, ge=0)
    unit: str | None = Field(default=None, max_length=30)
    keywords: str | None = None
    is_active: bool | None = None
    notes: str | None = None


class TariffLineResponse(BaseModel):
    id: int
    rate_schema_id: int
    tariff_code: str
    description: str
    category: str
    level_of_care: str | None
    loaded: bool | None
    primary_rate: Decimal
    iht_rate: Decimal
    unit: str
    keywords: str | None
    is_active: bool
    notes: str | None
    created_at: datetime | None
    updated_at: datetime | None

    model_config = {"from_attributes": True}


def _line_to_dict(line: SchemeTariffLine) -> dict:
    """Convert a SchemeTariffLine ORM object to a response dict."""
    return {
        "id": line.id,
        "rate_schema_id": line.rate_schema_id,
        "tariff_code": line.tariff_code,
        "description": line.description,
        "category": line.category,
        "level_of_care": line.level_of_care,
        "loaded": line.loaded,
        "primary_rate": float(line.primary_rate) if line.primary_rate is not None else 0,
        "iht_rate": float(line.iht_rate) if line.iht_rate is not None else 0,
        "unit": line.unit,
        "keywords": line.keywords,
        "is_active": line.is_active,
        "notes": line.notes,
        "created_at": line.created_at.isoformat() if line.created_at else None,
        "updated_at": line.updated_at.isoformat() if line.updated_at else None,
    }


# ── Endpoints ───────────────────────────────────────────────────────────────

@router.get("/by-schema/{schema_id}")
async def list_tariff_lines(
    schema_id: int,
    active_only: bool = Query(False, description="If true, return only active lines"),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List all tariff lines for a given rate schema."""
    # Verify parent exists
    parent = await db.execute(select(RateSchema).where(RateSchema.id == schema_id))
    if not parent.scalar_one_or_none():
        raise HTTPException(404, f"Rate schema with id {schema_id} not found")

    query = (
        select(SchemeTariffLine)
        .where(SchemeTariffLine.rate_schema_id == schema_id)
        .order_by(SchemeTariffLine.category, SchemeTariffLine.level_of_care, SchemeTariffLine.tariff_code)
    )
    if active_only:
        query = query.where(SchemeTariffLine.is_active == True)

    result = await db.execute(query)
    lines = result.scalars().all()
    return [_line_to_dict(ln) for ln in lines]


@router.post("", status_code=201)
async def create_tariff_line(
    body: TariffLineCreate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Create a new tariff line for a rate schema."""
    # Verify parent exists
    parent = await db.execute(select(RateSchema).where(RateSchema.id == body.rate_schema_id))
    if not parent.scalar_one_or_none():
        raise HTTPException(404, f"Rate schema with id {body.rate_schema_id} not found")

    # Check uniqueness (tariff_code within schema)
    existing = await db.execute(
        select(SchemeTariffLine).where(
            SchemeTariffLine.rate_schema_id == body.rate_schema_id,
            SchemeTariffLine.tariff_code == body.tariff_code.strip(),
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            400,
            f"Tariff code '{body.tariff_code}' already exists in schema id {body.rate_schema_id}",
        )

    line = SchemeTariffLine(
        rate_schema_id=body.rate_schema_id,
        tariff_code=body.tariff_code.strip(),
        description=body.description.strip(),
        category=body.category,
        level_of_care=body.level_of_care,
        loaded=body.loaded,
        primary_rate=body.primary_rate,
        iht_rate=body.iht_rate,
        unit=body.unit,
        keywords=body.keywords.strip() if body.keywords else None,
        is_active=body.is_active,
        notes=body.notes.strip() if body.notes else None,
    )
    db.add(line)
    await db.commit()
    await db.refresh(line)
    logger.info(
        "Created tariff line: %s (%s) for schema_id=%d",
        line.tariff_code, line.description[:50], body.rate_schema_id,
    )
    return _line_to_dict(line)


@router.put("/{line_id}")
async def update_tariff_line(
    line_id: int,
    body: TariffLineUpdate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Update an existing tariff line by ID."""
    result = await db.execute(
        select(SchemeTariffLine).where(SchemeTariffLine.id == line_id)
    )
    line = result.scalar_one_or_none()
    if not line:
        raise HTTPException(404, f"Tariff line with id {line_id} not found")

    update_data = body.model_dump(exclude_unset=True)

    # If changing tariff_code, check uniqueness within the same schema
    new_code = update_data.get("tariff_code")
    if new_code and new_code.strip() != line.tariff_code:
        dup = await db.execute(
            select(SchemeTariffLine).where(
                SchemeTariffLine.rate_schema_id == line.rate_schema_id,
                SchemeTariffLine.tariff_code == new_code.strip(),
            )
        )
        if dup.scalar_one_or_none():
            raise HTTPException(
                400,
                f"Tariff code '{new_code}' already exists in this schema",
            )

    for key, val in update_data.items():
        if isinstance(val, str) and key in ("tariff_code", "description", "keywords", "notes"):
            val = val.strip() if val else val
        setattr(line, key, val)

    line.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(line)
    logger.info("Updated tariff line: id=%d code=%s", line.id, line.tariff_code)
    return _line_to_dict(line)


@router.delete("/{line_id}")
async def delete_tariff_line(
    line_id: int,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Delete a tariff line by ID."""
    result = await db.execute(
        select(SchemeTariffLine).where(SchemeTariffLine.id == line_id)
    )
    line = result.scalar_one_or_none()
    if not line:
        raise HTTPException(404, f"Tariff line with id {line_id} not found")

    code = line.tariff_code
    schema_id = line.rate_schema_id
    await db.delete(line)
    await db.commit()
    logger.info("Deleted tariff line: %s (id=%d) from schema_id=%d", code, line_id, schema_id)
    return {"message": "Tariff line deleted", "tariff_code": code}


@router.post("/duplicate/{source_schema_id}/{target_schema_id}")
async def duplicate_lines(
    source_schema_id: int,
    target_schema_id: int,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Copy all tariff lines from one schema to another (for annual rate updates).

    Skips any lines where the tariff_code already exists in the target.
    """
    # Verify both schemas exist
    for sid, label in [(source_schema_id, "source"), (target_schema_id, "target")]:
        result = await db.execute(select(RateSchema).where(RateSchema.id == sid))
        if not result.scalar_one_or_none():
            raise HTTPException(404, f"{label.capitalize()} schema id {sid} not found")

    # Load source lines
    result = await db.execute(
        select(SchemeTariffLine).where(SchemeTariffLine.rate_schema_id == source_schema_id)
    )
    source_lines = result.scalars().all()

    if not source_lines:
        raise HTTPException(400, "Source schema has no tariff lines to copy")

    # Load existing target codes to skip duplicates
    result = await db.execute(
        select(SchemeTariffLine.tariff_code).where(
            SchemeTariffLine.rate_schema_id == target_schema_id
        )
    )
    existing_codes = {row[0] for row in result.all()}

    created = 0
    skipped = 0
    for src in source_lines:
        if src.tariff_code in existing_codes:
            skipped += 1
            continue
        new_line = SchemeTariffLine(
            rate_schema_id=target_schema_id,
            tariff_code=src.tariff_code,
            description=src.description,
            category=src.category,
            level_of_care=src.level_of_care,
            loaded=src.loaded,
            primary_rate=src.primary_rate,
            iht_rate=src.iht_rate,
            unit=src.unit,
            keywords=src.keywords,
            is_active=True,
            notes=f"Copied from schema id {source_schema_id}",
        )
        db.add(new_line)
        created += 1

    await db.commit()
    logger.info(
        "Duplicated %d lines from schema %d to %d (%d skipped)",
        created, source_schema_id, target_schema_id, skipped,
    )
    return {
        "message": f"Duplicated {created} tariff lines",
        "created": created,
        "skipped": skipped,
    }
