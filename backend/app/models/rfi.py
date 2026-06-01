"""
RFI (Request for Information) model — tracks suspended claims requiring additional data.
"""
from typing import Union
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Boolean, Text, ForeignKey, DateTime, Enum as SAEnum
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base
import enum


class RFIStatus(str, enum.Enum):
    OPEN = "open"
    RESPONDED = "responded"
    RESOLVED = "resolved"
    EXPIRED = "expired"


class RFIPriority(str, enum.Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class RFI(Base):
    __tablename__ = "rfis"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    claim_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("claims.id"), nullable=False, index=True
    )
    rfi_status: Mapped[RFIStatus] = mapped_column(
        SAEnum(RFIStatus, name="rfi_status"),
        nullable=False,
        default=RFIStatus.OPEN,
    )
    priority: Mapped[RFIPriority] = mapped_column(
        SAEnum(RFIPriority, name="rfi_priority"),
        nullable=False,
        default=RFIPriority.MEDIUM,
    )
    reason_code: Mapped[str] = mapped_column(
        String(50), nullable=False,
        comment="MISSING_PREAUTH, INVALID_ICD10, MISSING_SIGNATURE, etc."
    )
    reason_description: Mapped[str] = mapped_column(Text, nullable=False)
    missing_fields: Mapped[Union[dict, None]] = mapped_column(
        JSONB, nullable=True,
        comment="List of specific fields that need correction"
    )
    response_data: Mapped[Union[dict, None]] = mapped_column(
        JSONB, nullable=True,
        comment="Data submitted in response to the RFI"
    )
    assigned_to: Mapped[Union[uuid.UUID, None]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    resolved_by: Mapped[Union[uuid.UUID, None]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    resolved_at: Mapped[Union[datetime, None]] = mapped_column(
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
    claim = relationship("Claim", backref="rfis")

    def __repr__(self):
        return f"<RFI {self.reason_code} — {self.rfi_status.value}>"
