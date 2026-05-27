"""
Vehicle model — Ambulances belonging to a ServiceProvider.
Each vehicle has a callsign and registration. The dedicated phone per ambulance
selects the vehicle at shift start.
"""
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Boolean, ForeignKey, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class Vehicle(Base):
    __tablename__ = "vehicles"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    provider_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("service_providers.id"), nullable=False
    )
    callsign: Mapped[str] = mapped_column(
        String(50), nullable=False,
        comment="Vehicle callsign e.g. 'ALPHA 12', 'MED 5'"
    )
    registration: Mapped[str] = mapped_column(
        String(20), nullable=False,
        comment="Vehicle registration number e.g. 'GP 123-456'"
    )
    vehicle_type: Mapped[str] = mapped_column(
        String(50), nullable=False, default="Ambulance",
        comment="Ambulance, Response Vehicle, etc."
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    # Relationships
    provider = relationship("ServiceProvider", back_populates="vehicles")

    def __repr__(self):
        return f"<Vehicle {self.callsign} ({self.registration})>"
