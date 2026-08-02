"""
Case model — Parent entity for an EMS event (pre-authorization tracking).
"""
from typing import Union
import uuid
from datetime import datetime, date, timezone
from sqlalchemy import String, Date, Text, ForeignKey, DateTime, Boolean, Enum as SAEnum
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base
from app.utils.encrypted_types import EncryptedPatientID
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
    patient_id_number: Mapped[Union[str, None]] = mapped_column(
        # ENCRYPTED AT REST. Fernet token on disk, plain string in Python — the
        # transform lives in the column type, so no call site needs to know.
        # The column was String(13), exactly an SA ID and far too small to hold
        # a token, which is why this could not be done before.
        EncryptedPatientID, nullable=True,
        comment="SA ID number — Fernet-encrypted at rest; see app/utils/patient_id.py"
    )
    patient_id_hash: Mapped[Union[str, None]] = mapped_column(
        # Keyed HMAC-SHA256 of the digits, so equality lookups and duplicate
        # detection still work without decrypting. HMAC and not a bare digest:
        # an SA ID is 13 digits with a checksum, so a plain SHA-256 of every
        # possible value is computable on a laptop.
        String(64), nullable=True, index=True,
        comment="HMAC-SHA256 lookup hash of patient_id_number"
    )
    patient_dob: Mapped[Union[date, None]] = mapped_column(Date, nullable=True)
    medical_scheme_name: Mapped[Union[str, None]] = mapped_column(String(255), nullable=True)
    scheme_member_number: Mapped[Union[str, None]] = mapped_column(String(50), nullable=True)
    incident_date: Mapped[Union[date, None]] = mapped_column(Date, nullable=True)
    incident_location: Mapped[Union[str, None]] = mapped_column(Text, nullable=True)
    preauth_number: Mapped[Union[str, None]] = mapped_column(String(50), nullable=True)
    preauth_status: Mapped[PreAuthStatus] = mapped_column(
        SAEnum(PreAuthStatus, name="preauth_status"),
        nullable=False,
        default=PreAuthStatus.PENDING,
    )
    dependant_code: Mapped[Union[str, None]] = mapped_column(
        String(5), nullable=True,
        comment="Scheme dependant code e.g. 00=principal, 01=spouse"
    )
    dispatch_type: Mapped[Union[str, None]] = mapped_column(
        String(20), nullable=True,
        comment="Canonical call type — 'Primary' or 'IFT'. "
                "Normalised from extracted_data['incident_type'] via normalise_call_type(). "
                "Legacy 'IHT' rows are migrated to 'IFT' by Alembic."
    )
    referring_doctor_pr: Mapped[Union[str, None]] = mapped_column(
        String(20), nullable=True,
        comment="Referring doctor PR number — mandatory for IFT (Inter-Facility Transfer)"
    )
    auth_flag: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False,
        comment="True when scheme couldn't be matched — pins PRF to top of queue"
    )
    auth_flag_reason: Mapped[Union[str, None]] = mapped_column(
        Text, nullable=True,
        comment="Reason for flagging e.g. 'No API config found for scheme: XYZ Medical'"
    )
    custom_display_name: Mapped[Union[str, None]] = mapped_column(
        String(255), nullable=True,
        comment="Manual override for the PRF list name (rename dialog). "
                "When set, takes precedence over the computed PRF display name."
    )
    assigned_provider_id: Mapped[Union[uuid.UUID, None]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True, index=True
        # Same reasoning as documents.uploaded_by — User.cases back-populates
        # through this FK, and it was unindexed.
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
        index=True,  # case list orders by created_at DESC; indexed so pagination
                     # over 7 years of retained cases stays fast
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


# Wire the lookup-hash listener at import time. Registering it here rather than
# in application startup means anything that imports the model — the API, the
# Celery workers, the backfill script, the tests — gets consistent behaviour.
# A Case written by a worker with no hash would be a Case the office cannot find.
from app.utils.encrypted_types import register_patient_id_hash_sync  # noqa: E402

register_patient_id_hash_sync()
