"""
ERA (Electronic Remittance Advice) model — tracks scheme payments and reconciliation.
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from sqlalchemy import String, Text, ForeignKey, DateTime, Enum as SAEnum, Numeric, Integer
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base
import enum


class ERAStatus(str, enum.Enum):
    RECEIVED = "received"
    PARSING = "parsing"
    PARSED = "parsed"
    RECONCILED = "reconciled"
    DISCREPANCY = "discrepancy"
    FAILED = "failed"


class PaymentStatus(str, enum.Enum):
    PENDING = "pending"
    PAID_FULL = "paid_full"
    PAID_PARTIAL = "paid_partial"
    REJECTED = "rejected"
    REVERSED = "reversed"
    WRITTEN_OFF = "written_off"


class ERA(Base):
    """Electronic Remittance Advice — scheme payment record."""
    __tablename__ = "eras"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    claim_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("claims.id"), nullable=False, index=True
    )
    edi_submission_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("edi_submissions.id"), nullable=True
    )
    era_status: Mapped[ERAStatus] = mapped_column(
        SAEnum(ERAStatus, name="era_status"), nullable=False, default=ERAStatus.RECEIVED
    )
    payment_status: Mapped[PaymentStatus] = mapped_column(
        SAEnum(PaymentStatus, name="payment_status"), nullable=False, default=PaymentStatus.PENDING
    )

    # Financial
    amount_claimed: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    amount_approved: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    amount_paid: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    patient_liability: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0)
    discount_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0)

    # Scheme details
    scheme_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    scheme_reference: Mapped[str | None] = mapped_column(String(100), nullable=True)
    payment_reference: Mapped[str | None] = mapped_column(String(100), nullable=True)
    payment_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Line-level breakdown
    line_details: Mapped[dict | None] = mapped_column(
        JSONB, nullable=True,
        comment="Per-line approved/paid amounts and rejection reasons"
    )

    # Rejection / adjustment
    rejection_codes: Mapped[dict | None] = mapped_column(
        JSONB, nullable=True,
        comment="List of HPCSA rejection reason codes"
    )
    adjustment_reasons: Mapped[dict | None] = mapped_column(
        JSONB, nullable=True,
        comment="Adjustment reason codes and descriptions"
    )

    # Reconciliation
    reconciliation_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    auto_reconciled: Mapped[bool] = mapped_column(default=False)

    # Raw ERA data
    raw_era_data: Mapped[dict | None] = mapped_column(
        JSONB, nullable=True, comment="Original ERA payload from clearinghouse"
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # Relationships
    claim = relationship("Claim", backref="eras")

    @property
    def variance(self) -> Decimal:
        """Difference between claimed and paid amounts."""
        return self.amount_claimed - self.amount_paid

    @property
    def pay_rate(self) -> float:
        """Percentage of claimed amount that was paid."""
        if self.amount_claimed == 0:
            return 0.0
        return float(self.amount_paid / self.amount_claimed * 100)

    def __repr__(self):
        return f"<ERA {self.scheme_reference} — R{self.amount_paid} / R{self.amount_claimed}>"
