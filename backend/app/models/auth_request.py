"""
SchemeAuthRequest model — audit trail of every authorization request to medical schemes.
"""
from typing import Union
import uuid
import enum
from datetime import datetime, timezone
from sqlalchemy import String, Text, ForeignKey, DateTime, Enum as SAEnum, Numeric
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class AuthRequestStatus(str, enum.Enum):
    PENDING = "pending"
    APPROVED = "approved"
    DECLINED = "declined"
    ERROR = "error"
    TIMEOUT = "timeout"


class SchemeAuthRequest(Base):
    __tablename__ = "scheme_auth_requests"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    case_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cases.id"), nullable=False, index=True
    )
    claim_id: Mapped[Union[uuid.UUID, None]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("claims.id"), nullable=True
    )
    scheme_name: Mapped[Union[str, None]] = mapped_column(
        String(255), nullable=True,
        comment="Name of the medical scheme contacted"
    )
    request_payload: Mapped[Union[dict, None]] = mapped_column(
        JSONB, nullable=True,
        comment="Exact JSON payload sent to the scheme API"
    )
    response_payload: Mapped[Union[dict, None]] = mapped_column(
        JSONB, nullable=True,
        comment="Raw response from the scheme API"
    )
    status: Mapped[AuthRequestStatus] = mapped_column(
        SAEnum(AuthRequestStatus, name="auth_request_status"),
        nullable=False,
        default=AuthRequestStatus.PENDING,
    )
    auth_number: Mapped[Union[str, None]] = mapped_column(
        String(100), nullable=True,
        comment="Authorization number returned on approval"
    )
    approved_amount: Mapped[Union[float, None]] = mapped_column(
        Numeric(12, 2), nullable=True,
        comment="Scheme-approved financial limit"
    )
    decline_reason: Mapped[Union[str, None]] = mapped_column(
        Text, nullable=True,
        comment="Reason if the scheme declined"
    )
    requested_by: Mapped[Union[uuid.UUID, None]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    requested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
    responded_at: Mapped[Union[datetime, None]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Relationships
    case = relationship("Case", backref="auth_requests")
    claim = relationship("Claim", backref="auth_requests")

    def __repr__(self):
        return f"<SchemeAuthRequest {self.status.value} — {self.auth_number}>"
