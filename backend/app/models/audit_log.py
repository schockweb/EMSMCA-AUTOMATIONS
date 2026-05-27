"""
AuditLog model — Immutable, append-only POPIA compliance ledger.
"""
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Text, ForeignKey, DateTime
from sqlalchemy.dialects.postgresql import UUID, JSONB, INET
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True, index=True
    )
    action: Mapped[str] = mapped_column(
        String(50), nullable=False,
        comment="CREATE, READ, UPDATE, DELETE, TRANSMIT"
    )
    entity_type: Mapped[str] = mapped_column(
        String(50), nullable=False,
        comment="claim, document, case, user, etc."
    )
    entity_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    details: Mapped[dict | None] = mapped_column(
        JSONB, nullable=True, comment="Contextual metadata"
    )
    before_state: Mapped[dict | None] = mapped_column(
        JSONB, nullable=True,
        comment="Snapshot of relevant fields before change. NULL for creation events."
    )
    after_state: Mapped[dict | None] = mapped_column(
        JSONB, nullable=True,
        comment="Snapshot of relevant fields after change."
    )
    notes: Mapped[str | None] = mapped_column(
        Text, nullable=True,
        comment="Free-text context. Mandatory for VOIDED and CORRECTED events."
    )
    ip_address: Mapped[str | None] = mapped_column(
        String(50), nullable=True, comment="Client IP address"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    # Relationships
    user = relationship("User", back_populates="audit_logs")

    def __repr__(self):
        return f"<AuditLog {self.action} {self.entity_type}/{self.entity_id}>"
