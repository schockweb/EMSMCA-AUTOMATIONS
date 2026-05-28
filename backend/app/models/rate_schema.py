"""
Rate Schema model — Stores per-scheme tariff configuration for billing.

Each rate schema defines how a medical scheme is billed: rate per km,
base fees, rounding rules, after-hours / weekend multipliers, etc.
A PRF is linked to a rate schema via `digital_prfs.billing_schema_code`.
"""
from datetime import date, datetime, timezone
from decimal import Decimal
from sqlalchemy import Boolean, Integer, String, Text, Date, DateTime, Numeric
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class RateSchema(Base):
    __tablename__ = "rate_schemas"

    id: Mapped[int] = mapped_column(
        Integer, primary_key=True, autoincrement=True
    )
    schema_code: Mapped[str] = mapped_column(
        String(50), unique=True, nullable=False, index=True,
        comment="Unique tariff code e.g. 'GEMS-2026' or 'MEDSHIELD-STD'"
    )
    scheme_name: Mapped[str] = mapped_column(
        String(200), nullable=False,
        comment="Medical scheme display name"
    )
    effective_from: Mapped[date] = mapped_column(
        Date, nullable=False,
        comment="Start date this tariff is active"
    )
    effective_to: Mapped[date | None] = mapped_column(
        Date, nullable=True,
        comment="End date — NULL means currently active"
    )
    rate_per_km: Mapped[Decimal] = mapped_column(
        Numeric(10, 2), nullable=False,
        comment="Rand rate per kilometre"
    )
    rate_per_minute: Mapped[Decimal] = mapped_column(
        Numeric(10, 4), nullable=False, default=Decimal("0"),
        comment="Rand rate per minute of billable time"
    )
    base_fee: Mapped[Decimal] = mapped_column(
        Numeric(10, 2), nullable=False, default=0,
        comment="Fixed base/call-out fee in Rand"
    )
    minimum_km: Mapped[Decimal] = mapped_column(
        Numeric(6, 1), nullable=False, default=0,
        comment="Minimum billable kilometres"
    )
    min_minutes: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0,
        comment="Minimum billable minutes"
    )
    km_rounding: Mapped[str] = mapped_column(
        String(20), nullable=False, default="nearest",
        comment="KM rounding: none, up_0.5, up_1, nearest_1"
    )
    time_rounding: Mapped[str] = mapped_column(
        String(20), nullable=False, default="none",
        comment="Time rounding: none, up_5, up_15, nearest_5"
    )
    time_basis: Mapped[str] = mapped_column(
        String(30), nullable=False, default="dispatch_to_clear",
        comment="Billable time segment: dispatch_to_clear, transport_only, scene_to_clear"
    )
    after_hours_multiplier: Mapped[Decimal] = mapped_column(
        Numeric(4, 2), nullable=False, default=Decimal("1.0"),
        comment="Multiplier for after-hours calls"
    )
    weekend_multiplier: Mapped[Decimal] = mapped_column(
        Numeric(4, 2), nullable=False, default=Decimal("1.0"),
        comment="Multiplier for weekend calls"
    )
    active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True,
        comment="Hard disable flag — inactive schemas cannot be used for new bills"
    )
    notes: Mapped[str | None] = mapped_column(
        Text, nullable=True,
        comment="Free-text notes about this tariff"
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )

    # Child tariff line items
    tariff_lines = relationship(
        "SchemeTariffLine",
        back_populates="rate_schema",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    def __repr__(self):
        active = "active" if self.effective_to is None else f"until {self.effective_to}"
        return f"<RateSchema {self.schema_code} ({active})>"
