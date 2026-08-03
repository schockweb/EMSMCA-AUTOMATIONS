"""
Reading the audit trail.

WHY THIS EXISTS
---------------
`audit_logs` had 31 write sites across app/api and app/services and ZERO read
sites. The PHI access log built for POPIA s22 breach scoping — the thing that
answers "which patients were exposed?" — could not be queried by any means
except `psql` on the production host.

That is not a small gap. The log exists for the worst day, and on the worst day
the person who needs it is under time pressure, may not have database access,
and is trying to answer a regulator inside 72 hours.

WHAT IS DELIBERATELY NOT HERE
-----------------------------
No delete, no edit, no bulk export of `details`. This router only reads. The
table is append-only at the database level (migration c2f9a48d61be), and adding
a mutating endpoint here would be handing back exactly what that trigger took
away.

READING THE TRAIL IS ITSELF A PHI EVENT. The rows name which patient records an
actor opened, so a search across them is a disclosure in its own right — and it
is recorded as one. An investigator looking at the log is in the log.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import String, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.user import User, UserRole
from app.services.phi_audit import record_phi_access, ACTION_READ
from app.utils.security import require_role

router = APIRouter(
    prefix="/api/audit-logs",
    tags=["Audit"],
    dependencies=[Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN))],
)

# A hard ceiling on one response. The table is the fastest-growing in the system
# (record_phi_access fires on every PRF read), and an unbounded query against it
# is both a slow scan and the largest single disclosure the product can produce.
MAX_LIMIT = 500


class AuditEntry(BaseModel):
    id: str
    action: str
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    user_id: Optional[str] = None
    crew_member_id: Optional[str] = None
    actor_name: Optional[str] = None
    ip_address: Optional[str] = None
    created_at: str
    details: Optional[dict] = None
    before_state: Optional[dict] = None
    after_state: Optional[dict] = None


def _entry(r: AuditLog) -> AuditEntry:
    details = r.details or {}
    return AuditEntry(
        id=str(r.id),
        action=r.action,
        entity_type=r.entity_type,
        entity_id=str(r.entity_id) if r.entity_id else None,
        user_id=str(r.user_id) if r.user_id else None,
        crew_member_id=str(r.crew_member_id) if r.crew_member_id else None,
        actor_name=details.get("actor_name"),
        ip_address=r.ip_address,
        created_at=r.created_at.isoformat() if r.created_at else "",
        details=details or None,
        before_state=r.before_state,
        after_state=r.after_state,
    )


@router.get("", response_model=list[AuditEntry])
async def search_audit_log(
    request: Request,
    action: Optional[str] = Query(None, description="Exact action, e.g. READ, TRANSMIT, LOGIN_SUCCESS"),
    entity_type: Optional[str] = Query(None, description="e.g. digital_prf, case, user"),
    entity_id: Optional[str] = Query(None, description="The specific record"),
    actor_id: Optional[str] = Query(None, description="User OR crew member id"),
    since_hours: int = Query(168, ge=1, le=24 * 365, description="Look-back window in hours"),
    limit: int = Query(100, ge=1, le=MAX_LIMIT),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)),
):
    """Search the trail. Newest first.

    The default window is seven days rather than "everything": the common
    question is "what happened recently", and an unbounded default on the
    largest table in the system is how a diagnostic tool becomes an outage.
    """
    q = select(AuditLog).where(
        AuditLog.created_at >= datetime.now(timezone.utc) - timedelta(hours=since_hours)
    )
    if action:
        q = q.where(AuditLog.action == action.strip().upper())
    if entity_type:
        q = q.where(AuditLog.entity_type == entity_type.strip())
    if entity_id:
        try:
            q = q.where(AuditLog.entity_id == uuid.UUID(entity_id))
        except (ValueError, TypeError):
            raise HTTPException(400, "entity_id must be a UUID")
    if actor_id:
        try:
            aid = uuid.UUID(actor_id)
        except (ValueError, TypeError):
            raise HTTPException(400, "actor_id must be a UUID")
        # One parameter covers both actor kinds — an investigator asking "what
        # did this person do" should not have to know first whether they are a
        # back-office user or a crew member.
        q = q.where(or_(AuditLog.user_id == aid, AuditLog.crew_member_id == aid))

    rows = (await db.execute(
        q.order_by(AuditLog.created_at.desc()).limit(limit).offset(offset)
    )).scalars().all()

    # Searching the trail is itself an access to information about which
    # patients were seen by whom, so it is recorded. The investigator is in the
    # log — which is the property that makes the log worth anything.
    await record_phi_access(
        db, action=ACTION_READ, entity_type="audit_log", entity_id=None,
        user=_admin, request=request,
        details={"returned": len(rows), "filter_action": action,
                 "filter_entity_type": entity_type, "since_hours": since_hours},
    )
    return [_entry(r) for r in rows]


@router.get("/summary")
async def audit_summary(
    since_hours: int = Query(24, ge=1, le=24 * 90),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)),
):
    """Counts by action over a window, plus the total held.

    The first question in an incident is "how much of this is there", and that
    should not require pulling rows.
    """
    since = datetime.now(timezone.utc) - timedelta(hours=since_hours)
    by_action = (await db.execute(
        select(AuditLog.action, func.count(AuditLog.id))
        .where(AuditLog.created_at >= since)
        .group_by(AuditLog.action)
        .order_by(func.count(AuditLog.id).desc())
    )).all()
    total = (await db.execute(select(func.count(AuditLog.id)))).scalar() or 0
    oldest = (await db.execute(select(func.min(AuditLog.created_at)))).scalar()

    return {
        "window_hours": since_hours,
        "by_action": {a: n for a, n in by_action},
        "total_rows_held": total,
        "oldest_entry": oldest.isoformat() if oldest else None,
        "retention": (
            "No automatic deletion. This is the POPIA s22 ledger — the record of "
            "who accessed which patient file — and the retention decision belongs "
            "to the responsible party in writing, not to a background task. The "
            "table is append-only at the database level."
        ),
    }


@router.get("/patient/{entity_id}")
async def who_accessed_this_record(
    entity_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)),
):
    """Everyone who has touched one record, ever.

    The breach-scoping question, asked the way it actually arrives: not "show me
    the log" but "who has seen THIS patient's file". No look-back window — an
    incident can concern an access from a year ago.
    """
    try:
        eid = uuid.UUID(entity_id)
    except (ValueError, TypeError):
        raise HTTPException(400, "entity_id must be a UUID")

    rows = (await db.execute(
        select(AuditLog).where(AuditLog.entity_id == eid)
        .order_by(AuditLog.created_at.desc()).limit(MAX_LIMIT)
    )).scalars().all()

    actors: dict[str, dict] = {}
    for r in rows:
        aid = str(r.user_id or r.crew_member_id or "unknown")
        a = actors.setdefault(aid, {
            "actor_id": aid,
            "actor_name": (r.details or {}).get("actor_name"),
            "actor_type": (r.details or {}).get("actor_type"),
            "actions": {}, "first": None, "last": None,
        })
        a["actions"][r.action] = a["actions"].get(r.action, 0) + 1
        ts = r.created_at.isoformat() if r.created_at else None
        a["last"] = a["last"] or ts
        a["first"] = ts

    await record_phi_access(
        db, action=ACTION_READ, entity_type="audit_log", entity_id=eid,
        user=_admin, request=request,
        details={"query": "who_accessed_this_record", "entries": len(rows)},
    )

    return {
        "entity_id": entity_id,
        "entries": len(rows),
        "truncated": len(rows) >= MAX_LIMIT,
        "actors": list(actors.values()),
    }
