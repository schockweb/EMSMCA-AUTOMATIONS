"""
Crew Member model — EMS personnel belonging to a ServiceProvider.
Crew members self-assign to shifts by typing their name + HPCSA#.
"""
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Boolean, ForeignKey, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class CrewMember(Base):
    __tablename__ = "crew_members"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    provider_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("service_providers.id"), nullable=False
    )
    email: Mapped[str] = mapped_column(
        String(255), unique=True, nullable=False, index=True
    )
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(
        String(255), nullable=False,
        comment="Full name e.g. 'A. Ishwar'"
    )
    initials: Mapped[str | None] = mapped_column(
        String(10), nullable=True,
        comment="Initials e.g. 'A.I.'"
    )
    hpcsa_number: Mapped[str | None] = mapped_column(
        String(20), nullable=True,
        comment="HPCSA registration number e.g. '0049530'"
    )
    qualification: Mapped[str] = mapped_column(
        String(10), nullable=False, default="AEA",
        comment="HPCSA registration category: BAA / AEA / ECT / ECA / ANT / ECP. "
                "See app.utils.hpcsa for the tier translation used by the rules + tariff engines."
    )
    phone: Mapped[str | None] = mapped_column(String(20), nullable=True)
    role: Mapped[str] = mapped_column(
        String(20), nullable=False, default="crew",
        comment="'admin' = provider admin dashboard, 'crew' = mobile PRF"
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_login: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
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
