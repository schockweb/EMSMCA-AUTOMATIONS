"""
Rate Schema API — CRUD for billing rate schemas.
Manages per-scheme tariff configuration (rate per km, base fees, multipliers).
"""
import logging
from datetime import date, datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.rate_schema import RateSchema
from app.utils.security import get_current_user

logger = logging.getLogger("ems.rate_schemas")

router = APIRouter(prefix="/api/rate-schemas", tags=["Rate Schemas"])


# ── Pydantic Schemas ────────────────────────────────────────

class RateSchemaCreate(BaseModel):
    schema_code: str = Field(..., max_length=50)
    scheme_name: str = Field(..., max_length=200)
    effective_from: date
    effective_to: date | None = None
    rate_per_km: Decimal = Field(..., ge=0)
    rate_per_minute: Decimal = Field(default=Decimal("0"), ge=0)
    base_fee: Decimal = Field(default=Decimal("0"), ge=0)
    minimum_km: Decimal = Field(default=Decimal("0"), ge=0)
    min_minutes: int = Field(default=0, ge=0)
    km_rounding: str = Field(default="nearest", pattern=r"^(none|nearest|nearest_1|up|up_0\.5|up_1|down)$")
    time_rounding: str = Field(default="none", pattern=r"^(none|up_5|up_15|nearest_5)$")
    time_basis: str = Field(default="dispatch_to_clear", pattern=r"^(dispatch_to_clear|transport_only|scene_to_clear)$")
    after_hours_multiplier: Decimal = Field(default=Decimal("1.0"), ge=0)
    weekend_multiplier: Decimal = Field(default=Decimal("1.0"), ge=0)
    active: bool = Field(default=True)
    notes: str | None = None


class RateSchemaUpdate(BaseModel):
    scheme_name: str | None = Field(default=None, max_length=200)
    effective_from: date | None = None
    effective_to: date | None = None
    rate_per_km: Decimal | None = Field(default=None, ge=0)
    rate_per_minute: Decimal | None = Field(default=None, ge=0)
    base_fee: Decimal | None = Field(default=None, ge=0)
    minimum_km: Decimal | None = Field(default=None, ge=0)
    min_minutes: int | None = Field(default=None, ge=0)
    km_rounding: str | None = Field(default=None, pattern=r"^(none|nearest|nearest_1|up|up_0\.5|up_1|down)$")
    time_rounding: str | None = Field(default=None, pattern=r"^(none|up_5|up_15|nearest_5)$")
    time_basis: str | None = Field(default=None, pattern=r"^(dispatch_to_clear|transport_only|scene_to_clear)$")
    after_hours_multiplier: Decimal | None = Field(default=None, ge=0)
    weekend_multiplier: Decimal | None = Field(default=None, ge=0)
    active: bool | None = None
    notes: str | None = None


class RateSchemaResponse(BaseModel):
    id: int
    schema_code: str
    scheme_name: str
    effective_from: date
    effective_to: date | None
    rate_per_km: Decimal
    rate_per_minute: Decimal
    base_fee: Decimal
    minimum_km: Decimal
    min_minutes: int
    km_rounding: str
    time_rounding: str
    time_basis: str
    after_hours_multiplier: Decimal
    weekend_multiplier: Decimal
    active: bool
    notes: str | None
    created_at: datetime | None
    updated_at: datetime | None

    model_config = {"from_attributes": True}


def _schema_to_dict(schema: RateSchema) -> dict:
    """Convert a RateSchema ORM object to a response dict."""
    return {
        "id": schema.id,
        "schema_code": schema.schema_code,
        "scheme_name": schema.scheme_name,
        "effective_from": schema.effective_from.isoformat() if schema.effective_from else None,
        "effective_to": schema.effective_to.isoformat() if schema.effective_to else None,
        "rate_per_km": float(schema.rate_per_km) if schema.rate_per_km is not None else None,
        "rate_per_minute": float(schema.rate_per_minute) if schema.rate_per_minute is not None else 0,
        "base_fee": float(schema.base_fee) if schema.base_fee is not None else None,
        "minimum_km": float(schema.minimum_km) if schema.minimum_km is not None else None,
        "min_minutes": schema.min_minutes or 0,
        "km_rounding": schema.km_rounding,
        "time_rounding": getattr(schema, "time_rounding", "none") or "none",
        "time_basis": getattr(schema, "time_basis", "dispatch_to_clear") or "dispatch_to_clear",
        "after_hours_multiplier": float(schema.after_hours_multiplier) if schema.after_hours_multiplier is not None else None,
        "weekend_multiplier": float(schema.weekend_multiplier) if schema.weekend_multiplier is not None else None,
        "active": getattr(schema, "active", True),
        "notes": schema.notes,
        "created_at": schema.created_at.isoformat() if schema.created_at else None,
        "updated_at": schema.updated_at.isoformat() if schema.updated_at else None,
    }


# ── Endpoints ───────────────────────────────────────────────

@router.get("")
async def list_rate_schemas(
    active_only: bool = Query(False, description="If true, return only active schemas (active=True)"),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List all rate schemas, optionally filtered to only active ones."""
    query = select(RateSchema).order_by(RateSchema.scheme_name, RateSchema.effective_from)

    if active_only:
        query = query.where(RateSchema.active == True)

    result = await db.execute(query)
    schemas = result.scalars().all()
    return [_schema_to_dict(s) for s in schemas]


@router.get("/lookup/{scheme_name}")
async def lookup_by_scheme_name(
    scheme_name: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Lookup the currently active rate schema for a medical scheme by name.

    Returns the active schema (effective_to IS NULL) whose scheme_name
    matches (case-insensitive). Returns 404 if no active schema exists.
    """
    result = await db.execute(
        select(RateSchema).where(
            RateSchema.scheme_name.ilike(scheme_name.strip()),
            RateSchema.effective_to.is_(None),
        )
    )
    schema = result.scalar_one_or_none()
    if not schema:
        raise HTTPException(404, f"No active rate schema found for scheme '{scheme_name}'")
    return _schema_to_dict(schema)


@router.get("/{schema_code}")
async def get_rate_schema(
    schema_code: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Get a rate schema by its unique schema_code."""
    result = await db.execute(
        select(RateSchema).where(RateSchema.schema_code == schema_code.strip())
    )
    schema = result.scalar_one_or_none()
    if not schema:
        raise HTTPException(404, f"Rate schema '{schema_code}' not found")
    return _schema_to_dict(schema)


@router.post("", status_code=201)
async def create_rate_schema(
    body: RateSchemaCreate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Create a new rate schema."""
    # Check uniqueness
    existing = await db.execute(
        select(RateSchema).where(RateSchema.schema_code == body.schema_code.strip())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(400, f"Schema code '{body.schema_code}' already exists")

    # Validate effective date range
    if body.effective_to and body.effective_to < body.effective_from:
        raise HTTPException(400, "effective_to must be on or after effective_from")

    schema = RateSchema(
        schema_code=body.schema_code.strip(),
        scheme_name=body.scheme_name.strip(),
        effective_from=body.effective_from,
        effective_to=body.effective_to,
        rate_per_km=body.rate_per_km,
        rate_per_minute=body.rate_per_minute,
        base_fee=body.base_fee,
        minimum_km=body.minimum_km,
        min_minutes=body.min_minutes,
        km_rounding=body.km_rounding,
        time_rounding=body.time_rounding,
        time_basis=body.time_basis,
        after_hours_multiplier=body.after_hours_multiplier,
        weekend_multiplier=body.weekend_multiplier,
        active=body.active,
        notes=body.notes,
    )
    db.add(schema)
    await db.commit()
    await db.refresh(schema)
    logger.info("Created rate schema: %s (%s)", schema.schema_code, schema.scheme_name)
    return _schema_to_dict(schema)


@router.put("/{schema_id}")
async def update_rate_schema(
    schema_id: int,
    body: RateSchemaUpdate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Update an existing rate schema by ID."""
    result = await db.execute(
        select(RateSchema).where(RateSchema.id == schema_id)
    )
    schema = result.scalar_one_or_none()
    if not schema:
        raise HTTPException(404, f"Rate schema with id {schema_id} not found")

    update_data = body.model_dump(exclude_unset=True)

    # Validate effective date range if both are being set
    new_from = update_data.get("effective_from", schema.effective_from)
    new_to = update_data.get("effective_to", schema.effective_to)
    if new_to is not None and new_from is not None and new_to < new_from:
        raise HTTPException(400, "effective_to must be on or after effective_from")

    for key, val in update_data.items():
        if key == "scheme_name" and val is not None:
            val = val.strip()
        setattr(schema, key, val)

    schema.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(schema)
    logger.info("Updated rate schema: %s", schema.schema_code)
    return _schema_to_dict(schema)


@router.delete("/{schema_id}")
async def delete_rate_schema(
    schema_id: int,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Delete a rate schema by ID."""
    result = await db.execute(
        select(RateSchema).where(RateSchema.id == schema_id)
    )
    schema = result.scalar_one_or_none()
    if not schema:
        raise HTTPException(404, f"Rate schema with id {schema_id} not found")

    await db.delete(schema)
    await db.commit()
    logger.info("Deleted rate schema: %s (id=%d)", schema.schema_code, schema_id)
    return {"message": "Rate schema deleted", "schema_code": schema.schema_code}
