"""
CrashEvent model — Platform-wide crash/error monitoring ledger.
Captures unhandled exceptions from Backend, Celery workers, and Frontend.
"""
import uuid
from datetime import datetime, timezone, timedelta
from enum import Enum as PyEnum
from sqlalchemy import String, Boolean, Text, DateTime, Enum, ForeignKey, text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class CrashSource(str, PyEnum):
    BACKEND = "backend"
    CELERY = "celery"
    FRONTEND = "frontend"


class CrashSeverity(str, PyEnum):
    CRITICAL = "critical"
    ERROR = "error"
    WARNING = "warning"


class CrashEvent(Base):
    __tablename__ = "crash_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    source: Mapped[str] = mapped_column(
        Enum(CrashSource, name="crash_source", create_constraint=True, native_enum=False),
        nullable=False, index=True,
        comment="Origin layer: backend, celery, frontend"
    )
    severity: Mapped[str] = mapped_column(
        Enum(CrashSeverity, name="crash_severity", create_constraint=True, native_enum=False),
        nullable=False, index=True, default=CrashSeverity.ERROR,
        comment="Impact level: critical, error, warning"
    )
    error_type: Mapped[str] = mapped_column(
        String(255), nullable=False,
        comment="Exception class name e.g. ValueError, TypeError"
    )
    message: Mapped[str] = mapped_column(
        String(2000), nullable=False,
        comment="Error message (truncated to 2000 chars)"
    )
    stacktrace: Mapped[str | None] = mapped_column(
        Text, nullable=True,
        comment="Full traceback / component stack"
    )
    endpoint: Mapped[str | None] = mapped_column(
        String(500), nullable=True,
        comment="API route, Celery task name, or frontend URL"
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True, index=True
    )
    metadata_blob: Mapped[dict | None] = mapped_column(
        JSONB, nullable=True,
        comment="Extra context: request body, task args, browser info"
    )
    resolved: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False,
        comment="Manually marked as resolved by admin"
    )
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False, index=True,
    )

    # Relationships
    user = relationship("User", foreign_keys=[user_id])

    # ── Auto-purge configuration ──
    RETENTION_DAYS = 90

    @classmethod
    def purge_cutoff(cls) -> datetime:
        """Return the datetime before which records should be purged."""
        return datetime.now(timezone.utc) - timedelta(days=cls.RETENTION_DAYS)

    def __repr__(self):
        return f"<CrashEvent [{self.severity}] {self.source}/{self.error_type}>"
