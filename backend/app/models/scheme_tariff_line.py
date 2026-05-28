"""
SchemeTariffLine model — One row per tariff code per medical scheme.

Each RateSchema (the parent) can have many tariff lines. The billing engine
reads these rows to build invoice lines for schemes that do NOT have a
hardcoded Python module (GEMS/Discovery).

Column semantics match `app.rules.base.TariffEntry` so the engine can
iterate DB rows using the same attribute names as hardcoded entries.
"""
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import (
    Boolean, ForeignKey, Integer, Numeric, String, Text,
    DateTime,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class SchemeTariffLine(Base):
    __tablename__ = "scheme_tariff_lines"

    id: Mapped[int] = mapped_column(
        Integer, primary_key=True, autoincrement=True,
    )
    rate_schema_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("rate_schemas.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    tariff_code: Mapped[str] = mapped_column(
        String(30), nullable=False,
        comment="NHRPL / internal tariff code, e.g. '100', '9111'",
    )
    description: Mapped[str] = mapped_column(
        Text, nullable=False,
        comment="Load-bearing description used by engine keyword matching",
    )
    category: Mapped[str] = mapped_column(
        String(30), nullable=False, default="base_rate",
        comment="base_rate | mileage | procedure | medication | consumable | equipment | admin | other",
    )
    level_of_care: Mapped[str | None] = mapped_column(
        String(10), nullable=True,
        comment="BLS | ILS | ALS | NULL (applies to all levels)",
    )
    loaded: Mapped[bool | None] = mapped_column(
        Boolean, nullable=True,
        comment="TRUE = with patient, FALSE = unloaded/callout, NULL = N/A",
    )
    primary_rate: Mapped[Decimal] = mapped_column(
        Numeric(10, 2), nullable=False, default=Decimal("0"),
        comment="Rate in Rand for primary (emergency) calls",
    )
    iht_rate: Mapped[Decimal] = mapped_column(
        Numeric(10, 2), nullable=False, default=Decimal("0"),
        comment="Rate in Rand for inter-hospital transfer (IHT/IFT) calls",
    )
    unit: Mapped[str] = mapped_column(
        String(30), nullable=False, default="per call",
        comment="Billing unit: per call | per km | per 15 min | per item",
    )
    keywords: Mapped[str | None] = mapped_column(
        Text, nullable=True,
        comment="Comma-separated keyword phrases for engine matching, e.g. 'up to 45, base rate'",
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True,
        comment="Soft delete / disable flag",
    )
    notes: Mapped[str | None] = mapped_column(
        Text, nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )

    # Relationship back to parent
    rate_schema = relationship("RateSchema", back_populates="tariff_lines")

    def __repr__(self) -> str:
        return (
            f"<SchemeTariffLine {self.tariff_code} "
            f"[{self.category}] R{self.primary_rate}/{self.iht_rate}>"
        )
