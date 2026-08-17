"""
Vehicle occupancy — who is currently signed on to which ambulance.

This is the single place that knows what "in use" means. Four call sites need
the answer (the picker, both shift-start flows, and End Shift) and a rule
restated four times is a rule that drifts.

The contract, in full:

  A vehicle is IN USE when a crew_shifts row for it has ended_at IS NULL and
  started_at within STALE_AFTER_HOURS. Nothing else counts.

Every function here is written so that failing is cheaper than blocking. A
claim that cannot be written must not stop a crew starting a shift, and a
lookup that cannot be answered must not stop them picking a vehicle — an
ambulance crew standing at a scene is the worst possible audience for a
consistency error. Callers therefore treat exceptions as "unknown", and the
UI treats "unknown" as "no warning".
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.crew_shift import STALE_AFTER_HOURS, CrewShift

logger = logging.getLogger("ems.vehicle_occupancy")


def _cutoff() -> datetime:
    return datetime.now(timezone.utc) - timedelta(hours=STALE_AFTER_HOURS)


async def open_shift_for_vehicle(
    db: AsyncSession, vehicle_id: uuid.UUID
) -> CrewShift | None:
    """The newest live shift on this vehicle, or None.

    Newest rather than only — if two crews have already signed on, the warning
    should name the most recent one, since that is the crew whose session is
    still being used.
    """
    return (
        await db.execute(
            select(CrewShift)
            .where(
                CrewShift.vehicle_id == vehicle_id,
                CrewShift.ended_at.is_(None),
                CrewShift.started_at >= _cutoff(),
            )
            .order_by(CrewShift.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def claim_vehicle(
    db: AsyncSession,
    *,
    provider_id: uuid.UUID,
    crew_member_id: uuid.UUID,
    vehicle_id: uuid.UUID,
    vehicle_callsign: str | None = None,
    crew_name: str | None = None,
    partner_name: str | None = None,
) -> CrewShift | None:
    """Record that this crew member is now on this vehicle.

    Idempotent per (crew, vehicle): re-entering the same shift start, or the
    dashboard's claim landing after shift-start-by-id has already written one,
    updates the existing row instead of stacking duplicates that would each
    have to be closed later.

    Does NOT commit — the caller owns the transaction, so a failure here rolls
    back with whatever else it was doing rather than half-recording a shift.
    """
    existing = (
        await db.execute(
            select(CrewShift).where(
                CrewShift.crew_member_id == crew_member_id,
                CrewShift.ended_at.is_(None),
                CrewShift.started_at >= _cutoff(),
            )
        )
    ).scalars().all()

    mine = next((s for s in existing if s.vehicle_id == vehicle_id), None)

    # One crew member cannot be on two ambulances. Anything still open on a
    # DIFFERENT vehicle is a shift they walked away from without ending, and
    # leaving it open would warn the next crew off a vehicle that is free.
    for stale in existing:
        if stale is not mine:
            stale.ended_at = datetime.now(timezone.utc)
            stale.ended_reason = "superseded"

    if mine is not None:
        mine.partner_name = partner_name or mine.partner_name
        return mine

    shift = CrewShift(
        provider_id=provider_id,
        crew_member_id=crew_member_id,
        vehicle_id=vehicle_id,
        vehicle_callsign=vehicle_callsign,
        crew_name=crew_name,
        partner_name=partner_name,
    )
    db.add(shift)
    return shift


async def release_crew(
    db: AsyncSession, crew_member_id: uuid.UUID, reason: str = "crew"
) -> int:
    """Close every open shift for one crew member. Returns rows closed.

    Called from End Shift and from crew logout. Does not commit.
    """
    res = await db.execute(
        update(CrewShift)
        .where(
            CrewShift.crew_member_id == crew_member_id,
            CrewShift.ended_at.is_(None),
        )
        .values(ended_at=datetime.now(timezone.utc), ended_reason=reason)
    )
    return res.rowcount or 0


def describe(shift: CrewShift | None) -> dict:
    """Shape the picker consumes. Safe to call with None."""
    if shift is None:
        return {"in_use": False}

    started = shift.started_at
    if started.tzinfo is None:          # belt and braces on a naive column read
        started = started.replace(tzinfo=timezone.utc)
    minutes = max(0, int((datetime.now(timezone.utc) - started).total_seconds() // 60))

    return {
        "in_use": True,
        "crew_name": shift.crew_name,
        "partner_name": shift.partner_name,
        "vehicle_callsign": shift.vehicle_callsign,
        "since": started.isoformat(),
        "minutes_ago": minutes,
    }
