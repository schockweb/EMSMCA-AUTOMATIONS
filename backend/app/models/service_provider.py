"""
Service Provider model — Multi-tenant root entity for EMS companies.
Each provider (e.g., JEMS Medical Services) has their own crew, vehicles, and PRFs.
"""
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Boolean, Text, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class ServiceProvider(Base):
    __tablename__ = "service_providers"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(
        String(255), nullable=False,
        comment="Display name e.g. 'JEMS Medical Services'"
    )
    slug: Mapped[str] = mapped_column(
        String(100), unique=True, nullable=False, index=True,
        comment="URL slug e.g. 'jems' → /jems/crew"
    )
    pr_number: Mapped[str | None] = mapped_column(
        String(50), nullable=True,
        comment="BHF/PCNS Practice Registration Number"
    )
    pty_reg_number: Mapped[str | None] = mapped_column(
        String(50), nullable=True,
        comment="PTY Registration Number"
    )
    phone: Mapped[str | None] = mapped_column(String(20), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    logo_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # Relationships
    crew_members = relationship("CrewMember", back_populates="provider", lazy="selectin")
    vehicles = relationship("Vehicle", back_populates="provider", lazy="selectin")
    digital_prfs = relationship("DigitalPRF", back_populates="provider", lazy="selectin")

    def __repr__(self):
        return f"<ServiceProvider {self.name} ({self.slug})>"
