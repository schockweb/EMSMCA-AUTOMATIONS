"""
A detected production fault, its proposed fix, and what was done about it.

WHY A TABLE AND NOT JUST A LOG LINE
-----------------------------------
`crash_events` records that something THREW. Most of the ways this platform
actually fails throw nothing at all: beat publishing to a queue no worker
consumes, a migration that exists but was never applied, a spool directory
growing without bound, nginx holding a stale upstream address while every
request 502s and the backend reports healthy. Nobody gets an exception; the
system simply stops doing part of its job.

This table is the other half — a fault is a CONDITION that a probe asserts is
false, with a named remedy attached and a lifecycle that ends in either "fixed
itself" or "a human approved the fix". It is deliberately durable rather than
in-memory so that the record of an unattended repair survives the restart that
repair may have caused.

ONE OPEN ROW PER FAULT KEY. A condition that stays true for an hour is one row
with a rising `occurrences`, not twelve. That is the same folding `crash_events`
learned the hard way after the development database reached 3.68 million rows.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone
from typing import Union

from sqlalchemy import (
    JSON, Boolean, DateTime, Enum as SAEnum, ForeignKey, Integer, String, Text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class FaultStatus(str, enum.Enum):
    # A probe asserted the condition is false and no remedy has run.
    DETECTED = "detected"
    # The remedy ran unattended and the probe now passes.
    AUTO_HEALED = "auto_healed"
    # A fix is proposed and is waiting for a human. This is the queue the
    # operator actually looks at.
    AWAITING_APPROVAL = "awaiting_approval"
    # Approved and executed successfully.
    RESOLVED = "resolved"
    # The remedy ran and the condition is STILL false. Never retried silently —
    # see the attempt cap in the engine.
    REMEDY_FAILED = "remedy_failed"
    # A human decided this is not a problem, or fixed it another way.
    DISMISSED = "dismissed"
    # The condition stopped being true on its own before anyone acted.
    CLEARED = "cleared"


class FaultSeverity(str, enum.Enum):
    CRITICAL = "critical"     # patient care or data at risk right now
    HIGH = "high"             # a core function is not working
    MEDIUM = "medium"         # degraded, or heading for a failure
    LOW = "low"               # housekeeping


class SystemFault(Base):
    __tablename__ = "system_faults"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )

    # Stable identifier for the CONDITION, e.g. "celery_queue_has_no_consumer".
    # Folding happens on this plus an open status.
    fault_key: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    severity: Mapped[FaultSeverity] = mapped_column(
        SAEnum(FaultSeverity, name="fault_severity"), nullable=False, index=True
    )
    status: Mapped[FaultStatus] = mapped_column(
        SAEnum(FaultStatus, name="fault_status"), nullable=False,
        default=FaultStatus.DETECTED, index=True,
    )

    # What the probe actually saw. Never patient data — probes report counts,
    # ages, identifiers and states, never clinical content. Same rule as
    # phi_audit: an operational table must not become a second PHI store.
    evidence: Mapped[Union[dict, None]] = mapped_column(JSON, nullable=True)

    # The fix, in the operator's language, and the machine key that performs it.
    remedy_key: Mapped[Union[str, None]] = mapped_column(String(100), nullable=True)
    remedy_description: Mapped[Union[str, None]] = mapped_column(Text, nullable=True)

    # Whether this was eligible to run unattended, and the reason either way.
    # Recorded per-occurrence rather than looked up later, because the answer
    # depends on runtime state (attempt count, flap detection, kill switch) and
    # an investigator needs to know what the engine decided AT THE TIME.
    auto_eligible: Mapped[bool] = mapped_column(Boolean, default=False)
    decision_reason: Mapped[Union[str, None]] = mapped_column(Text, nullable=True)

    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    occurrences: Mapped[int] = mapped_column(Integer, default=1, server_default="1")

    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )
    last_attempt_at: Mapped[Union[datetime, None]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    resolved_at: Mapped[Union[datetime, None]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Who approved it, when a human did.
    approved_by: Mapped[Union[uuid.UUID, None]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    approved_at: Mapped[Union[datetime, None]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Free text from the remedy run — stdout, counts affected, the error.
    outcome: Mapped[Union[str, None]] = mapped_column(Text, nullable=True)

    def __repr__(self) -> str:
        return f"<SystemFault {self.fault_key} {self.status.value}>"


# Statuses that mean "this is still a live problem". Folding and the operator's
# queue both key off this set, so it lives here rather than being re-listed at
# each call site and drifting.
OPEN_STATUSES = (
    FaultStatus.DETECTED,
    FaultStatus.AWAITING_APPROVAL,
    FaultStatus.REMEDY_FAILED,
)
