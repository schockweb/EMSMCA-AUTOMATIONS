"""
Service Provider model — Multi-tenant root entity for EMS companies.
Each provider (e.g., JEMS Medical Services) has their own crew, vehicles, and PRFs.
"""
from typing import Union
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Boolean, Text, DateTime, Integer
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
    pr_number: Mapped[Union[str, None]] = mapped_column(
        String(50), nullable=True,
        comment="BHF/PCNS Practice Registration Number"
    )
    pty_reg_number: Mapped[Union[str, None]] = mapped_column(
        String(50), nullable=True,
        comment="PTY Registration Number"
    )
    prf_name: Mapped[Union[str, None]] = mapped_column(
        String(100), nullable=True,
        comment="Admin-chosen prefix for PRF file/display names; falls back to `name` when unset"
    )
    phone: Mapped[Union[str, None]] = mapped_column(String(20), nullable=True)
    email: Mapped[Union[str, None]] = mapped_column(String(255), nullable=True)
    address: Mapped[Union[str, None]] = mapped_column(Text, nullable=True)
    logo_url: Mapped[Union[str, None]] = mapped_column(String(500), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    
    # Generic portal login credentials
    portal_login_email: Mapped[Union[str, None]] = mapped_column(
        String(255), unique=True, nullable=True, index=True,
        comment="Email used on main EMSMCA login page to redirect to this provider's portal"
    )
    portal_login_password_hash: Mapped[Union[str, None]] = mapped_column(String(255), nullable=True)

    # ── Portal-login account lockout (mirrors User) ──
    failed_login_attempts: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0",
        comment="Consecutive failed portal-login attempts"
    )
    locked_until: Mapped[Union[datetime, None]] = mapped_column(
        DateTime(timezone=True), nullable=True,
        comment="Portal login locked until this timestamp (NULL = not locked)"
    )

    # ── Bulk revocation of device unlocks ──
    # One company password is shared across every crew tablet, so when it leaks
    # it leaks to everyone at once. Rotating the password alone does NOT undo
    # the damage: the 12-hour portal grants already minted from the old password
    # stay valid, and each one can still be exchanged for crew tokens. Stamping
    # this kills every outstanding grant for the company in a single write.
    tokens_revoked_at: Mapped[Union[datetime, None]] = mapped_column(
        DateTime(timezone=True), nullable=True,
        comment="Invalidate all portal grants issued before this time (NULL = none revoked)"
    )

    # Outbound PRF email account — each provider sends "PRF to receiving
    # facility" PDFs from its OWN Gmail / Outlook mailbox. The app password is
    # Fernet-encrypted at rest (app/utils/crypto.py) and never returned by any
    # API. smtp_service picks the host/port (app/utils/emailer.SMTP_SERVICES).
    smtp_service: Mapped[Union[str, None]] = mapped_column(
        String(20), nullable=True,
        comment="'gmail' | 'outlook' — outbound SMTP service for PRF emails"
    )
    smtp_email: Mapped[Union[str, None]] = mapped_column(
        String(255), nullable=True,
        comment="Sending address / SMTP username for PRF emails"
    )
    smtp_password_encrypted: Mapped[Union[str, None]] = mapped_column(
        Text, nullable=True,
        comment="Fernet-encrypted app password for smtp_email"
    )

    # Per-provider PRF numbering baseline. Set once by the admin at onboarding
    # (the count of PRFs the company has already completed). The next digital
    # PRF continues from here — see `_next_prf_number` in api/digital_prf.py.
    # Not surfaced back to the settings form; it only seeds the counter.
    prf_start_number: Mapped[Union[int, None]] = mapped_column(
        Integer, nullable=True,
        comment="Onboarding baseline; next digital PRF = max(this, provider's current max) + 1"
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
    crew_members = relationship("CrewMember", back_populates="provider", lazy="selectin")
    vehicles = relationship("Vehicle", back_populates="provider", lazy="selectin")
    digital_prfs = relationship("DigitalPRF", back_populates="provider", lazy="select")

    def __repr__(self):
        return f"<ServiceProvider {self.name} ({self.slug})>"
