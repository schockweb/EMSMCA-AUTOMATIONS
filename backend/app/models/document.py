"""
Document model — PRF files, OCR metadata, and confidence scoring.
"""
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Boolean, Float, Text, ForeignKey, DateTime, Enum as SAEnum, UUID, JSON as JSONB
# from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base
import enum




class OCRStatus(str, enum.Enum):
    PENDING = "pending"
    PREPROCESSING = "preprocessing"
    EXTRACTING = "extracting"
    COMPLETED = "completed"
    FAILED = "failed"


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    case_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cases.id"), nullable=True, index=True
    )
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    storage_uri: Mapped[str] = mapped_column(Text, nullable=False)
    processed_uri: Mapped[str | None] = mapped_column(Text, nullable=True)
    document_type: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
        default="PRF",
    )
    ocr_status: Mapped[OCRStatus] = mapped_column(
        SAEnum(OCRStatus, name="ocr_status"),
        nullable=False,
        default=OCRStatus.PENDING,
    )
    ocr_confidence_avg: Mapped[float | None] = mapped_column(Float, nullable=True)
    ocr_field_scores: Mapped[dict | None] = mapped_column(
        JSONB, nullable=True, comment="Per-field confidence map"
    )
    extracted_data: Mapped[dict | None] = mapped_column(
        JSONB, nullable=True, comment="Structured extraction result"
    )
    needs_hitl_review: Mapped[bool] = mapped_column(
        Boolean, default=False,
        comment="Auto-flagged if AI confidence < threshold"
    )
    group_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True,
        comment="UUID shared by documents in the same bundle"
    )
    is_group_primary: Mapped[bool] = mapped_column(
        Boolean, default=False,
        comment="True if this is the primary PRF in a bundle"
    )
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
        comment="When the HITL reviewer approved the data"
    )
    reviewed_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True,
        comment="User who performed the HITL review"
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
    case = relationship("Case", back_populates="documents")
    uploaded_by_user = relationship("User", foreign_keys=[uploaded_by], back_populates="documents")
    reviewed_by_user = relationship("User", foreign_keys=[reviewed_by_id])

    def __repr__(self):
        return f"<Document {self.original_filename} ({self.ocr_status.value})>"
