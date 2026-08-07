"""
Crew Member model — EMS personnel belonging to a ServiceProvider.
Crew members self-assign to shifts by typing their name + HPCSA#.
"""
from typing import Union
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Boolean, ForeignKey, DateTime, Integer
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class CrewMember(Base):
    __tablename__ = "crew_members"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    provider_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("service_providers.id"), nullable=False, index=True
    )
    email: Mapped[str] = mapped_column(
        String(255), unique=True, nullable=False, index=True
    )
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(
        String(255), nullable=False,
        comment="Full name e.g. 'A. Ishwar'"
    )
    initials: Mapped[Union[str, None]] = mapped_column(
        String(10), nullable=True,
        comment="Initials e.g. 'A.I.'"
    )
    hpcsa_number: Mapped[Union[str, None]] = mapped_column(
        String(20), nullable=True,
        comment="HPCSA registration number e.g. '0049530'"
    )
    qualification: Mapped[str] = mapped_column(
        String(10), nullable=False, default="AEA",
        comment="HPCSA registration category: BAA / AEA / ECT / ECA / ANT / ECP. "
                "See app.utils.hpcsa for the tier translation used by the rules + tariff engines."
    )
    phone: Mapped[Union[str, None]] = mapped_column(String(20), nullable=True)
    # URL of the crew member's face photo (resized ~256px JPEG on disk under
    # /uploads/crew). Only the URL string lives in the DB — image bytes never do.
    photo_url: Mapped[Union[str, None]] = mapped_column(String(500), nullable=True)
    role: Mapped[str] = mapped_column(
        String(20), nullable=False, default="crew",
        comment="'admin' = provider admin dashboard, 'crew' = mobile PRF"
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Set only by the provider-level deactivation cascade, so that reactivating
    # the company restores exactly the crew IT switched off — and nobody else.
    #
    # Without this, reactivation would have to be "set every crew member of this
    # provider active", which silently hands a login back to the paramedic who
    # left last year and was deactivated individually. Their record is
    # indistinguishable from a cascaded one once both are just is_active=false.
    deactivated_with_provider: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false",
        comment="True when this crew member was deactivated BY the provider "
                "cascade; cleared when the provider is reactivated",
    )
    last_login: Mapped[Union[datetime, None]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # ── Account lockout (mirrors User) ──
    failed_login_attempts: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0",
        comment="Consecutive failed login attempts"
    )
    locked_until: Mapped[Union[datetime, None]] = mapped_column(
        DateTime(timezone=True), nullable=True,
        comment="Account locked until this timestamp (NULL = not locked)"
    )

    # ── Bulk session revocation (mirrors User) ──
    # This matters more for crew than for back-office staff. A crew token lives
    # 12 hours, is minted onto a SHARED tablet that rides in an ambulance, and
    # opens patient records. When a device is lost, left at a hospital or handed
    # to the wrong person, End Shift on the real device cannot help — it revokes
    # only the JTI it can see. This kills every session for the practitioner.
    tokens_revoked_at: Mapped[Union[datetime, None]] = mapped_column(
        DateTime(timezone=True), nullable=True,
        comment="Invalidate all crew tokens issued before this time (NULL = none revoked)"
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
    provider = relationship("ServiceProvider", back_populates="crew_members")

    def __repr__(self):
        return f"<CrewMember {self.full_name} ({self.qualification})>"
