"""
CrewShift — one row per crew member signing on to a vehicle.

WHY THIS TABLE EXISTS
---------------------
Until now a shift was not a row anywhere. It was a 12-hour JWT with the
vehicle's id copied into its claims, so nothing on the server ever knew which
ambulance was out: two tablets could both sign on to ALPHA 12 and neither the
picker nor the API would notice.

WHAT IT IS NOT
--------------
It is not a lock. A crew that taps an occupied vehicle is told who is already
on it and may continue anyway, because two things make a hard block unsafe:

  * End Shift is not reliably pressed. A flat battery or a closed tab would
    otherwise strand a vehicle for the rest of the day with no way to release
    it, and a crew standing at a scene cannot wait for an administrator.
  * Shift start works offline from a cached roster (offlineShiftCache), so a
    device with no signal cannot consult this table at all. A rule that a
    portion of starts structurally bypass is a warning whether or not it is
    written as a block.

Staleness is handled at READ time rather than by a background job: an open
shift older than STALE_AFTER_HOURS is ignored. That is self-correcting and does
not require a scheduler to be running for the answer to be right.

NO PATIENT DATA lives here — it is crew, vehicle and clock only, which is why
the foreign keys cascade instead of protecting the row the way audit_logs does.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Index, String, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

# How long an unclosed shift is still believed. The crew token itself lasts 12
# hours (CREW_SHIFT_TOKEN_HOURS); past that the session is dead regardless, so
# an open row beyond this window describes a vehicle nobody can still be using.
STALE_AFTER_HOURS = 14


class CrewShift(Base):
    __tablename__ = "crew_shifts"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    provider_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("service_providers.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    crew_member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("crew_members.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    vehicle_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("vehicles.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )

    # Denormalised so the warning can be written without joining vehicles, and
    # so it still reads correctly if the vehicle is later renamed or removed.
    vehicle_callsign: Mapped[str | None] = mapped_column(String(50), nullable=True)
    crew_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    partner_name: Mapped[str | None] = mapped_column(String(200), nullable=True)

    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # 'crew' (End Shift pressed), 'logout', or 'superseded' (the same crew
    # signed on to a different vehicle without ending the previous shift).
    ended_reason: Mapped[str | None] = mapped_column(String(20), nullable=True)

    __table_args__ = (
        # The occupancy lookup: newest open shift for one vehicle. Partial on
        # ended_at IS NULL, because closed shifts are the overwhelming majority
        # within days of go-live and are never read by this query.
        Index(
            "ix_crew_shifts_vehicle_open",
            "vehicle_id", "started_at",
            postgresql_where=text("ended_at IS NULL"),
        ),
    )

    def __repr__(self):
        state = "open" if self.ended_at is None else "ended"
        return f"<CrewShift {self.vehicle_callsign} {self.crew_name} ({state})>"
