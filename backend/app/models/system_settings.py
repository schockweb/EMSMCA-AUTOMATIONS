"""
SystemSettings model — database-backed key-value configuration store.
Replaces hardcoded .env values for admin-configurable settings.
"""
from typing import Union
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Text, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class SystemSettings(Base):
    __tablename__ = "system_settings"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    key: Mapped[str] = mapped_column(
        String(100), unique=True, nullable=False, index=True,
        comment="Dotted key e.g. scheme_api.base_url"
    )
    value: Mapped[Union[str, None]] = mapped_column(
        Text, nullable=True,
        comment="Setting value (encrypted for secrets)"
    )
    category: Mapped[str] = mapped_column(
        String(50), nullable=False, default="general",
        comment="Grouping category for the UI"
    )
    label: Mapped[str] = mapped_column(
        String(255), nullable=False,
        comment="Human-readable display name"
    )
    description: Mapped[Union[str, None]] = mapped_column(
        Text, nullable=True,
        comment="Help text displayed in the settings UI"
    )
    value_type: Mapped[str] = mapped_column(
        String(20), nullable=False, default="string",
        comment="string, secret, boolean, select"
    )
    options: Mapped[Union[dict, None]] = mapped_column(
        JSONB, nullable=True,
        comment="Available options for select-type settings"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    updated_by: Mapped[Union[uuid.UUID, None]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    def __repr__(self):
        return f"<SystemSettings {self.key}={self.value}>"
