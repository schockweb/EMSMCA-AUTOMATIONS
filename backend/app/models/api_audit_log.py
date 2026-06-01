from typing import Union
from sqlalchemy import String, Integer, DateTime, JSON
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.dialects.postgresql import UUID, JSONB
import uuid
from datetime import datetime, timezone
from app.database import Base

class APIAuditLog(Base):
    __tablename__ = "api_audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    internal_claim_id: Mapped[str] = mapped_column(
        String(50), nullable=True, index=True,
        comment="References the internal claim processed"
    )
    scheme_destination_code: Mapped[str] = mapped_column(
        String(100), nullable=False, index=True,
        comment="The destination scheme identifier, e.g. DEST_DISC_001"
    )
    action: Mapped[str] = mapped_column(
        String(50), nullable=False,
        comment="e.g. REQUEST_AUTH, SUBMIT_CLAIM"
    )
    status_code: Mapped[Union[int, None]] = mapped_column(
        Integer, nullable=True,
        comment="HTTP status code received from external API"
    )
    request_payload: Mapped[Union[dict, None]] = mapped_column(
        JSONB, nullable=True,
        comment="Sanitized outbound payload"
    )
    response_payload: Mapped[Union[dict, None]] = mapped_column(
        JSONB, nullable=True,
        comment="Sanitized incoming response body"
    )
    error_message: Mapped[Union[str, None]] = mapped_column(
        String, nullable=True,
        comment="Internal error logs or connection timeouts"
    )
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        index=True
    )
