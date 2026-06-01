"""
EDI Submission model — tracks claim submissions to clearinghouses.
"""
from typing import Union
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Text, ForeignKey, DateTime, Enum as SAEnum, Integer
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base
import enum


class EDIFormat(str, enum.Enum):
    HEALTHBRIDGE_XML = "healthbridge_xml"
    MEDISWITCH_XML = "mediswitch_xml"
    HPCSA_JSON = "hpcsa_json"


class SubmissionStatus(str, enum.Enum):
    DRAFT = "draft"
    VALIDATED = "validated"
    SUBMITTED = "submitted"
    ACKNOWLEDGED = "acknowledged"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    PARTIAL = "partial"
    REVERSED = "reversed"


class EDISubmission(Base):
    __tablename__ = "edi_submissions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    claim_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("claims.id"), nullable=False, index=True
    )
    clearinghouse: Mapped[str] = mapped_column(
        String(50), nullable=False, comment="healthbridge, mediswitch"
    )
    edi_format: Mapped[EDIFormat] = mapped_column(
        SAEnum(EDIFormat, name="edi_format"), nullable=False
    )
    submission_status: Mapped[SubmissionStatus] = mapped_column(
        SAEnum(SubmissionStatus, name="submission_status"),
        nullable=False,
        default=SubmissionStatus.DRAFT,
    )
    edi_payload: Mapped[Union[str, None]] = mapped_column(
        Text, nullable=True, comment="Generated EDI XML/JSON payload"
    )
    edi_reference: Mapped[Union[str, None]] = mapped_column(
        String(100), nullable=True, comment="Clearinghouse transaction reference"
    )
    response_payload: Mapped[Union[dict, None]] = mapped_column(
        JSONB, nullable=True, comment="Clearinghouse response"
    )
    response_code: Mapped[Union[str, None]] = mapped_column(
        String(20), nullable=True, comment="e.g. 277-A1, 999"
    )
    rejection_reasons: Mapped[Union[dict, None]] = mapped_column(
        JSONB, nullable=True, comment="List of rejection codes/reasons"
    )
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    submitted_at: Mapped[Union[datetime, None]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    acknowledged_at: Mapped[Union[datetime, None]] = mapped_column(
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
    claim = relationship("Claim", backref="edi_submissions")

    def __repr__(self):
        return f"<EDISubmission {self.clearinghouse} — {self.submission_status.value}>"
