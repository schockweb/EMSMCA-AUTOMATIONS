"""
Case model — Parent entity for an EMS event (pre-authorization tracking).
"""
import uuid
from datetime import datetime, date, timezone
from sqlalchemy import String, Date, Text, ForeignKey, DateTime, Boolean, Enum as SAEnum
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base
import enum


class PreAuthStatus(str, enum.Enum):
    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"


class Case(Base):
    __tablename__ = "cases"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    patient_name: Mapped[str] = mapped_column(String(255), nullable=False)
    patient_id_number: Mapped[str | None] = mapped_column(
        String(13), nullable=True, comment="SA ID number — encrypted at rest"
    )
    patient_dob: Mapped[date | None] = mapped_column(Date, nullable=True)
    medical_scheme_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    scheme_member_number: Mapped[str | None] = mapped_column(String(50), nullable=True)
    incident_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    incident_location: Mapped[str | None] = mapped_column(Text, nullable=True)
    preauth_number: Mapped[str | None] = mapped_column(String(50), nullable=True)
    preauth_status: Mapped[PreAuthStatus] = mapped_column(
        SAEnum(PreAuthStatus, name="preauth_status"),
        nullable=False,
        default=PreAuthStatus.PENDING,
    )
    dependant_code: Mapped[str | None] = mapped_column(
        String(5), nullable=True,
        comment="Scheme dependant code e.g. 00=principal, 01=spouse"
    )
    dispatch_type: Mapped[str | None] = mapped_column(
        String(20), nullable=True,
        comment="Canonical call type — 'Primary' or 'IFT'. "
                "Normalised from extracted_data['incident_type'] via normalise_call_type(). "
                "Legacy 'IHT' rows are migrated to 'IFT' by Alembic."
    )
    referring_doctor_pr: Mapped[str | None] = mapped_column(
        String(20), nullable=True,
        comment="Referring doctor PR number — mandatory for IFT (Inter-Facility Transfer)"
    )
    auth_flag: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False,
        comment="True when scheme couldn't be matched — pins PRF to top of queue"
    )
    auth_flag_reason: Mapped[str | None] = mapped_column(
        Text, nullable=True,
        comment="Reason for flagging e.g. 'No API config found for scheme: XYZ Medical'"
    )
    assigned_provider_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
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
    assigned_provider = relationship("User", back_populates="cases")
    claims = relationship("Claim", back_populates="case", lazy="selectin")
    documents = relationship("Document", back_populates="case", lazy="selectin")

    def __repr__(self):
        return f"<Case {self.id} — {self.patient_name}>"
