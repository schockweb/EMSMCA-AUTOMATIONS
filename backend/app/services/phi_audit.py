"""
Who looked at a patient's record.

WHY THIS EXISTS
---------------
Until now nothing anywhere logged a READ. `audit_logs` had entries for logins,
corrections and claim changes, but not one row saying that a person opened a
patient's clinical record. `app/services/audit.py::log_action` accepts
action="READ" and no caller has ever passed it.

That is not merely a missing feature. POPIA section 22 requires the responsible
party to notify the Information Regulator AND every affected data subject when
there are reasonable grounds to believe personal information has been accessed
by an unauthorised person. Doing that requires knowing WHOSE information was
accessed. With no read log the honest answer to "which patients were exposed?"
is "we cannot tell, so we must assume all of them" — which turns a contained
incident into an instance-wide disclosure.

WHAT IS DELIBERATELY NOT RECORDED
---------------------------------
No patient name, no ID number, no clinical content. The log stores the record's
IDENTIFIER and the actor; the patient is resolved by joining when an
investigation actually needs it. Copying patient data into the audit trail would
create a SECOND, longer-lived store of the same PHI — a table that then needs
its own access controls, its own retention rule, and its own breach analysis.
An audit log that leaks is worse than none.

WHAT IT CANNOT SEE
------------------
`ResponseCacheMiddleware` answers a repeated GET from memory WITHOUT running the
route, so a re-read of the same record by the SAME session inside that TTL (30s
for these paths) produces no second row. Cache keys include a fingerprint of the
caller's token, so a different person reading the same record always misses the
cache and is always logged. For breach scoping — "did this account ever access
this patient?" — that is sufficient; for "how many times", it is not.

An earlier version of this note claimed the only blind spot was 30 seconds. It
was wrong twice over, and both were found by an adversarial review rather than
by us: the crew PRF detail route ALSO has a Redis cache whose TTL for a
submitted PRF is CACHE_TTL_PRF_SUBMITTED_SECONDS — one HOUR — and the audit
call sat below its early return, so an hour of re-reads recorded a single
access. That call now runs before the cache check. And the case LIST route,
which discloses up to 200 patients' names and decrypted ID numbers in one
response, was not logged at all; it now records one row per request.

WHAT IS STILL NOT LOGGED: edits and deletions. This module records READ and
TRANSMIT only. Do not describe it as "a full audit trail".
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Optional

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit_log import AuditLog

logger = logging.getLogger("ems.phi_audit")

# Actions this module writes. READ = a record was displayed to someone.
# TRANSMIT = PHI left the system (emailed, exported, downloaded), which is a
# materially more serious event and is queried separately.
ACTION_READ = "READ"
ACTION_TRANSMIT = "TRANSMIT"


def _client_ip(request: Optional[Request]) -> Optional[str]:
    """Best-effort client address.

    X-Forwarded-For is caller-controlled and therefore NOT trusted as identity —
    it is recorded as a hint alongside the peer address, never instead of it.
    The peer is nginx on this deployment, so the forwarded value is the only
    thing carrying the real client; an investigator needs to know both and needs
    to know which is which.
    """
    if request is None:
        return None
    peer = request.client.host if request.client else None
    forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if forwarded and forwarded != peer:
        return f"{peer} via {forwarded}"[:50]
    return (peer or None) if peer is None else peer[:50]


async def record_phi_access(
    db: AsyncSession,
    *,
    action: str,
    entity_type: str,
    entity_id: Optional[uuid.UUID | str],
    user: Any = None,
    crew: Any = None,
    request: Optional[Request] = None,
    details: Optional[dict] = None,
) -> None:
    """Append one access record, in its OWN transaction.

    `db` is accepted so call sites read naturally, but is deliberately NOT used
    for the write. Two reasons, both found the hard way:

      * A GET performs no other write, so the audit row has to be committed or
        it is discarded when the session closes. Committing the CALLER's session
        would also commit anything else pending in it.
      * If that commit failed, the caller's session is left unusable and the
        handler's next query dies — and recovering it with a rollback expires
        every loaded ORM object, so the handler's next attribute access triggers
        a lazy load and raises MissingGreenlet. A read audit must not be able to
        break the read it is auditing; a separate session makes that structural
        rather than a matter of care.

    NEVER raises. A failure to log must not deny a paramedic the clinical record
    of the patient in front of them — the harm from a blocked read at a roadside
    is immediate and physical, while a missing audit row is later and
    administrative. The failure is logged loudly instead, because a read audit
    that silently stops working is indistinguishable from one that is working.
    """
    try:
        if isinstance(entity_id, str):
            try:
                entity_id = uuid.UUID(entity_id)
            except (ValueError, TypeError):
                entity_id = None

        meta: dict = dict(details or {})
        if crew is not None:
            meta.setdefault("actor_type", "crew")
            meta.setdefault("actor_name", getattr(crew, "full_name", None))
            meta.setdefault("provider_id", str(getattr(crew, "provider_id", "") or "") or None)
        elif user is not None:
            meta.setdefault("actor_type", "back_office")
            meta.setdefault("actor_name", getattr(user, "full_name", None))
            meta.setdefault("actor_role", getattr(getattr(user, "role", None), "value", None))
        else:
            meta.setdefault("actor_type", "unknown")

        if request is not None:
            meta.setdefault("route", request.url.path)

        row = AuditLog(
            user_id=getattr(user, "id", None),
            crew_member_id=getattr(crew, "id", None),
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            details=meta,
            ip_address=_client_ip(request),
        )

        from app.database import AsyncSessionLocal
        async with AsyncSessionLocal() as audit_db:
            audit_db.add(row)
            await audit_db.commit()
    except Exception:
        logger.exception(
            "PHI access log FAILED for %s %s/%s — the read proceeded but is "
            "unrecorded, so a breach involving it cannot be scoped",
            action, entity_type, entity_id,
        )
