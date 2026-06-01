"""
Claim model — Financial representation of a Case.
"""
from typing import Union
import uuid
from datetime import datetime, timezone
from sqlalchemy import Boolean, String, Text, ForeignKey, DateTime, Enum as SAEnum, Numeric
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base
import enum


class AdjudicationStatus(str, enum.Enum):
    PENDING = "pending"
    CLEAN = "clean"
    RFI = "rfi"
    REJECTED = "rejected"
    SUBMITTED = "submitted"
    PAID = "paid"


class Claim(Base):
    __tablename__ = "claims"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    case_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cases.id"), nullable=False, index=True
    )
    total_amount: Mapped[float] = mapped_column(
        Numeric(12, 2), nullable=True, default=0
    )
    target_scheme: Mapped[Union[str, None]] = mapped_column(String(255), nullable=True)
    adjudication_status: Mapped[AdjudicationStatus] = mapped_column(
        SAEnum(AdjudicationStatus, name="adjudication_status"),
        nullable=False,
        default=AdjudicationStatus.PENDING,
    )
    dispatch_reference_number: Mapped[Union[str, None]] = mapped_column(
        String(100), nullable=True,
        comment="CAD/Dispatch reference — used when billing an AGGREGATOR payer (e.g. ER24, Netcare 911)"
    )

    # ── Void / Re-bill ────────────────────────────────────
    voided: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False,
        comment="True if this claim has been voided"
    )
    voided_at: Mapped[Union[datetime, None]] = mapped_column(
        DateTime(timezone=True), nullable=True,
        comment="Timestamp when claim was voided"
    )
    voided_by: Mapped[Union[uuid.UUID, None]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True,
        comment="User who voided this claim"
    )
    voided_reason: Mapped[Union[str, None]] = mapped_column(
        Text, nullable=True,
        comment="Mandatory reason for voiding — audit trail"
    )
    amended_by_id: Mapped[Union[uuid.UUID, None]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("claims.id"), nullable=True,
        comment="If voided, the replacement claim's ID"
    )

    submitted_at: Mapped[Union[datetime, None]] = mapped_column(
        DateTime(timezone=True), nullable=True
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
    case = relationship("Case", back_populates="claims")
    claim_lines = relationship("ClaimLine", back_populates="claim", lazy="selectin")

    def __repr__(self):
        return f"<Claim {self.id} — R{self.total_amount} ({self.adjudication_status.value})>"
