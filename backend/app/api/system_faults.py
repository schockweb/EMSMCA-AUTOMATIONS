"""
The operator's queue: what is wrong, what the system proposes to do, approve or dismiss.

This is the human half of the self-healing loop. Everything the engine could not
safely fix on its own lands here with the reason it was not attempted, so the
answer to "why is this waiting for me?" is on the record rather than inferred.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.system_fault import (
    OPEN_STATUSES, FaultSeverity, FaultStatus, SystemFault,
)
from app.models.user import User, UserRole
from app.utils.client_ip import get_trusted_client_ip
from app.utils.security import require_role

# Approving a fix executes code against production. ADMIN and SUPER_ADMIN only.
router = APIRouter(
    prefix="/api/system-faults",
    tags=["System Health"],
    dependencies=[Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN))],
)


class FaultOut(BaseModel):
    id: str
    fault_key: str
    title: str
    severity: str
    status: str
    evidence: Optional[dict] = None
    remedy_key: Optional[str] = None
    remedy_description: Optional[str] = None
    auto_eligible: bool
    decision_reason: Optional[str] = None
    attempts: int
    occurrences: int
    first_seen_at: str
    last_seen_at: str
    resolved_at: Optional[str] = None
    outcome: Optional[str] = None
    can_apply: bool


def _out(f: SystemFault, applicable: bool) -> FaultOut:
    return FaultOut(
        id=str(f.id),
        fault_key=f.fault_key,
        title=f.title,
        severity=f.severity.value,
        status=f.status.value,
        evidence=f.evidence,
        remedy_key=f.remedy_key,
        remedy_description=f.remedy_description,
        auto_eligible=f.auto_eligible,
        decision_reason=f.decision_reason,
        attempts=f.attempts,
        occurrences=f.occurrences,
        first_seen_at=f.first_seen_at.isoformat() if f.first_seen_at else "",
        last_seen_at=f.last_seen_at.isoformat() if f.last_seen_at else "",
        resolved_at=f.resolved_at.isoformat() if f.resolved_at else None,
        outcome=f.outcome,
        can_apply=applicable,
    )


def _has_runnable_remedy(fault: SystemFault) -> bool:
    """Is there actually a fix to press a button on?

    Read from the live registry rather than from `remedy_key` on the row: a
    remedy can be removed in a deploy while old rows still name it, and
    offering a button that 400s is worse than offering none.
    """
    from app.services.monitor.registry import get_probe
    probe = get_probe(fault.fault_key)
    return probe is not None and probe.remedy is not None


@router.get("", response_model=list[FaultOut])
async def list_faults(
    include_resolved: bool = Query(False, description="Include healed/cleared history"),
    limit: int = Query(100, le=500),
    db: AsyncSession = Depends(get_db),
):
    """Everything currently wrong, worst first, plus recent history on request."""
    q = select(SystemFault)
    if not include_resolved:
        q = q.where(SystemFault.status.in_(OPEN_STATUSES))

    # Severity is an enum, and neither its storage order nor its alphabetical
    # order is its urgency order — sorted as text, CRITICAL lands after HIGH.
    # An explicit CASE puts the thing that is on fire at the top of the page.
    severity_rank = case(
        (SystemFault.severity == FaultSeverity.CRITICAL, 0),
        (SystemFault.severity == FaultSeverity.HIGH, 1),
        (SystemFault.severity == FaultSeverity.MEDIUM, 2),
        else_=3,
    )
    rows = (await db.execute(
        q.order_by(severity_rank.asc(), SystemFault.last_seen_at.desc()).limit(limit)
    )).scalars().all()
    return [_out(f, _has_runnable_remedy(f)) for f in rows]


@router.get("/summary")
async def fault_summary(db: AsyncSession = Depends(get_db)):
    """One-glance state, for the dashboard badge and for an uptime probe."""
    open_rows = (await db.execute(
        select(SystemFault).where(SystemFault.status.in_(OPEN_STATUSES))
    )).scalars().all()

    since = datetime.now(timezone.utc) - timedelta(hours=24)
    healed = (await db.execute(
        select(func.count(SystemFault.id)).where(
            SystemFault.status == FaultStatus.AUTO_HEALED,
            SystemFault.resolved_at >= since,
        )
    )).scalar() or 0

    by_sev: dict[str, int] = {}
    for f in open_rows:
        by_sev[f.severity.value] = by_sev.get(f.severity.value, 0) + 1

    return {
        "open": len(open_rows),
        "by_severity": by_sev,
        "awaiting_approval": sum(
            1 for f in open_rows if f.status == FaultStatus.AWAITING_APPROVAL
        ),
        "self_healed_last_24h": healed,
        "worst": min(
            (f.severity.value for f in open_rows),
            key=lambda s: ["critical", "high", "medium", "low"].index(s),
            default=None,
        ),
    }


class ApproveRequest(BaseModel):
    note: Optional[str] = None


@router.post("/{fault_id}/approve", response_model=FaultOut)
async def approve_fault(
    fault_id: str,
    body: ApproveRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)),
):
    """Run the proposed fix.

    Executed through exactly the same path as an unattended repair, including
    the re-probe afterwards — so an approved fix is verified rather than assumed
    to have worked, and reports honestly if it did not.
    """
    try:
        fid = uuid.UUID(fault_id)
    except (ValueError, TypeError):
        raise HTTPException(400, "Invalid fault id")

    from app.services.monitor.engine import apply_remedy_by_id

    fault = await apply_remedy_by_id(db, fid, _admin)

    db.add(AuditLog(
        user_id=_admin.id,
        action="FAULT_REMEDY_APPROVED",
        entity_type="system_fault",
        entity_id=fault.id,
        details={
            "fault_key": fault.fault_key,
            "remedy": fault.remedy_key,
            "result": fault.status.value,
            "outcome": (fault.outcome or "")[:500],
            "note": (body.note or "")[:500] or None,
        },
        ip_address=get_trusted_client_ip(request),
    ))
    await db.commit()
    await db.refresh(fault)
    return _out(fault, _has_runnable_remedy(fault))


class DismissRequest(BaseModel):
    reason: str


@router.post("/{fault_id}/dismiss", response_model=FaultOut)
async def dismiss_fault(
    fault_id: str,
    body: DismissRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)),
):
    """Close a fault without running the fix — handled by hand, or not a problem.

    A reason is REQUIRED. A dismissed fault is a decision that the condition is
    acceptable, and the next person to see the same key deserves to know who
    decided that and why. If the condition is still true the probe will re-open
    it on the next sweep, which is correct: dismissing is not suppressing.
    """
    try:
        fid = uuid.UUID(fault_id)
    except (ValueError, TypeError):
        raise HTTPException(400, "Invalid fault id")
    if not (body.reason or "").strip():
        raise HTTPException(400, "A reason is required to dismiss a fault.")

    fault = (await db.execute(
        select(SystemFault).where(SystemFault.id == fid)
    )).scalar_one_or_none()
    if fault is None:
        raise HTTPException(404, "Fault not found")

    fault.status = FaultStatus.DISMISSED
    fault.resolved_at = datetime.now(timezone.utc)
    fault.approved_by = _admin.id
    fault.approved_at = datetime.now(timezone.utc)
    fault.outcome = f"Dismissed by {_admin.email}: {body.reason.strip()}"[:2000]

    db.add(AuditLog(
        user_id=_admin.id,
        action="FAULT_DISMISSED",
        entity_type="system_fault",
        entity_id=fault.id,
        details={"fault_key": fault.fault_key, "reason": body.reason.strip()[:500]},
        ip_address=get_trusted_client_ip(request),
    ))
    await db.commit()
    await db.refresh(fault)
    return _out(fault, _has_runnable_remedy(fault))


@router.post("/sweep")
async def run_sweep_now(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)),
):
    """Run every probe immediately instead of waiting for the schedule.

    For the moment after a deploy or a repair when you want to know NOW rather
    than in five minutes.
    """
    from app.services.monitor.engine import run_sweep
    return await run_sweep(db)
