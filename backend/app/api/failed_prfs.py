"""
Failed PRF Management API — Admin tools for reviewing and reprocessing
PRFs that failed during the automated processing pipeline.
"""
from __future__ import annotations
import asyncio
import logging
from datetime import datetime, timezone, date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, text, or_, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.digital_prf import DigitalPRF, PRFStatus
from app.models.user import UserRole
from app.utils.security import get_current_user, require_permission, require_role
from app.tasks.publish import publish_task, publish_delay

logger = logging.getLogger("ems.failed_prfs")

# case_number is String(50) and globally unique.
_CASE_NUMBER_MAX = 50


async def _next_correction_case_number(db: AsyncSession, original) -> str | None:
    """Derive a unique case number for a correction of `original`.

    Returns None only when the original itself never got one — a PRF that failed
    before a case number was assigned has nothing to derive from, and None is
    the honest answer rather than an invented identifier.
    """
    base = (original.case_number or "").strip()
    if not base:
        return None

    for attempt in range(1, 100):
        suffix = f"-C{attempt}"
        candidate = base[: _CASE_NUMBER_MAX - len(suffix)] + suffix
        exists = await db.execute(
            select(DigitalPRF.id).where(DigitalPRF.case_number == candidate).limit(1)
        )
        if exists.scalar_one_or_none() is None:
            return candidate

    # 99 corrections of one call is not a real scenario; if it happens, leaving
    # the field NULL is far better than raising a unique-violation at commit and
    # losing the admin's corrections.
    logger.warning(
        "Could not derive a unique correction case number from %r after 99 tries", base
    )
    return None

# ROUTER-LEVEL role gate, deliberately not per-route.
#
# Every route here was authentication-only (`Depends(get_current_user)`), and
# nothing in this module filters by provider — the queue is instance-wide by
# design, because back-office staff fix failed PRFs across every company. The
# combination meant ANY account, including the default PARAMEDIC role, could
# enumerate and read the complete patient record of every failed or stuck PRF
# belonging to every provider on the instance — form_data carries patient name,
# SA ID number, scheme membership and clinical notes — and rewrite any of them
# via /correct.
#
# Cross-provider visibility is correct for this queue and is kept; what was
# missing is that only back-office ADMINs should have it. The gate lives on the
# router so a route added later cannot quietly omit it. (require_role already
# treats SUPER_ADMIN as satisfying any check.)
router = APIRouter(
    prefix="/api/failed-prfs",
    tags=["Failed Forms"],
    dependencies=[
        Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)),
        # ...and the fine-grained key, so an admin who was deliberately not
        # given the failed-forms page cannot reach it through the API either.
        Depends(require_permission("failed_forms")),
    ],
)

# A PRF is "stuck" when the crew submitted it but the billing pipeline never
# produced a Case — the SUBMITTED-black-hole state (lost queue message, worker
# outage). Stuck rows are surfaced here alongside FAILED ones so admins can see
# and retry them. Keep the threshold in sync with STUCK_AFTER_MINUTES in
# app/tasks/prf_processing.py (the beat watchdog that auto-requeues them).
STUCK_AFTER_MINUTES = 10


def _stuck_condition():
    """SQLAlchemy filter for submitted-but-never-processed PRFs."""
    ref_time = func.coalesce(
        DigitalPRF.submitted_at, DigitalPRF.updated_at, DigitalPRF.created_at
    )
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=STUCK_AFTER_MINUTES)
    return and_(
        DigitalPRF.status == PRFStatus.SUBMITTED,
        DigitalPRF.case_id.is_(None),
        ref_time < cutoff,
    )


# ── Pydantic Schemas ────────────────────────────────────────

class CorrectionBody(BaseModel):
    form_data: dict


class FailedPRFStats(BaseModel):
    total_failed: int
    failed_today: int
    avg_attempts: float
    oldest_unresolved_days: int | None


# ── Endpoints ───────────────────────────────────────────────

@router.get("/stats")
async def get_failed_stats(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Aggregate statistics for failed PRFs — must be defined before /{prf_id}."""
    # Total failed
    result = await db.execute(
        select(func.count(DigitalPRF.id)).where(
            DigitalPRF.status == PRFStatus.FAILED
        )
    )
    total_failed = result.scalar() or 0

    # Failed today
    today_start = datetime.combine(date.today(), datetime.min.time()).replace(
        tzinfo=timezone.utc
    )
    result = await db.execute(
        select(func.count(DigitalPRF.id)).where(
            DigitalPRF.status == PRFStatus.FAILED,
            DigitalPRF.last_processing_at >= today_start,
        )
    )
    failed_today = result.scalar() or 0

    # Average attempts
    result = await db.execute(
        select(func.avg(DigitalPRF.processing_attempts)).where(
            DigitalPRF.status == PRFStatus.FAILED
        )
    )
    avg_attempts = round(float(result.scalar() or 0), 1)

    # Oldest unresolved (days since created_at)
    result = await db.execute(
        select(func.min(DigitalPRF.created_at)).where(
            DigitalPRF.status == PRFStatus.FAILED
        )
    )
    oldest_created = result.scalar()
    oldest_unresolved_days = None
    if oldest_created:
        delta = datetime.now(timezone.utc) - oldest_created
        oldest_unresolved_days = delta.days

    # Stuck submissions (SUBMITTED, no Case, older than the threshold) —
    # additive key; the UI shows a warning banner when this is non-zero.
    result = await db.execute(
        select(func.count(DigitalPRF.id)).where(_stuck_condition())
    )
    total_stuck = result.scalar() or 0

    return {
        "total_failed": total_failed,
        "failed_today": failed_today,
        "avg_attempts": avg_attempts,
        "oldest_unresolved_days": oldest_unresolved_days,
        "total_stuck": total_stuck,
    }


@router.get("")
async def list_failed_prfs(
    search: str | None = Query(None, description="Search by PRF number"),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List failed PRFs plus stuck submissions (SUBMITTED but never processed).

    Stuck rows carry status="submitted" and no processing_error; the UI labels
    them distinctly. They sort first (NULL last_processing_at, NULLS FIRST) —
    exactly the rows needing the most attention.

    PAGED, and it selects columns rather than whole rows. Neither was true
    before: this loaded every matching DigitalPRF entity, and `form_data` is a
    JSONB blob carrying the entire clinical record including base64 signatures
    and captured document images — tens of kilobytes each, all of it detoasted
    and shipped out of Postgres so the handler could read two name fields from
    it. One broker outage escalates a whole shift into this queue, and the page
    that exists to fix an incident becomes the thing that falls over.
    """
    # `.astext` is JSONB-only; this column is generic JSON (see the model), so
    # the key is extracted as a string via as_string() instead. Doing it in SQL
    # is the whole point — it keeps the rest of the blob in Postgres.
    name_fields = func.trim(
        func.concat_ws(
            " ",
            DigitalPRF.form_data["patient_name"].as_string(),
            DigitalPRF.form_data["patient_surname"].as_string(),
        )
    )
    query = (
        select(
            DigitalPRF.id,
            DigitalPRF.prf_number,
            DigitalPRF.case_number,
            DigitalPRF.status,
            DigitalPRF.processing_error,
            DigitalPRF.processing_attempts,
            DigitalPRF.last_processing_at,
            DigitalPRF.submitted_at,
            DigitalPRF.created_at,
            DigitalPRF.case_id,
            name_fields.label("patient_name"),
        )
        .where(
            or_(
                DigitalPRF.status == PRFStatus.FAILED,
                _stuck_condition(),
            )
        )
        .order_by(DigitalPRF.last_processing_at.desc().nullsfirst())
    )

    if search:
        query = query.where(
            DigitalPRF.prf_number == int(search)
            if search.isdigit()
            else DigitalPRF.case_number.ilike(f"%{search}%")
        )

    result = await db.execute(query.offset(skip).limit(limit))
    prfs = result.all()

    return [
        {
            "id": str(prf.id),
            "prf_number": prf.prf_number,
            "case_number": prf.case_number,
            "status": prf.status.value,
            "patient_name": (prf.patient_name or "").strip(),
            "processing_error": (
                (prf.processing_error or "")[:200]
            ),
            "processing_attempts": prf.processing_attempts,
            "last_processing_at": (
                prf.last_processing_at.isoformat()
                if prf.last_processing_at
                else None
            ),
            "submitted_at": (
                prf.submitted_at.isoformat() if prf.submitted_at else None
            ),
            "created_at": (
                prf.created_at.isoformat() if prf.created_at else None
            ),
        }
        for prf in prfs
    ]


@router.get("/count")
async def count_failed_prfs(
    search: str | None = Query(None, description="Search by PRF number"),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Total rows matching the same filter as the list endpoint, so the page can
    show an honest "showing N of M" now that the list is capped. Declared before
    /{prf_id} so this literal path wins over the UUID route."""
    conditions = [or_(DigitalPRF.status == PRFStatus.FAILED, _stuck_condition())]
    if search:
        conditions.append(
            DigitalPRF.prf_number == int(search)
            if search.isdigit()
            else DigitalPRF.case_number.ilike(f"%{search}%")
        )
    total = (await db.execute(
        select(func.count()).select_from(DigitalPRF).where(*conditions)
    )).scalar() or 0
    return {"total": total}


@router.get("/{prf_id}")
async def get_failed_prf(
    prf_id: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Full detail for a single failed PRF, including complete form_data and error."""
    import uuid

    try:
        prf_uuid = uuid.UUID(prf_id)
    except ValueError:
        raise HTTPException(400, "Invalid PRF ID format")

    result = await db.execute(
        select(DigitalPRF).where(DigitalPRF.id == prf_uuid)
    )
    prf = result.scalar_one_or_none()
    if not prf:
        raise HTTPException(404, f"PRF {prf_id} not found")

    return {
        "id": str(prf.id),
        "prf_number": prf.prf_number,
        "case_number": prf.case_number,
        "status": prf.status.value,
        "form_data": prf.form_data,
        "processing_error": prf.processing_error,
        "processing_attempts": prf.processing_attempts,
        "last_processing_at": (
            prf.last_processing_at.isoformat()
            if prf.last_processing_at
            else None
        ),
        "review_flags": prf.review_flags,
        "created_at": prf.created_at.isoformat() if prf.created_at else None,
        "updated_at": prf.updated_at.isoformat() if prf.updated_at else None,
        "submitted_at": (
            prf.submitted_at.isoformat() if prf.submitted_at else None
        ),
    }


@router.put("/{prf_id}/correct")
async def correct_failed_prf(
    prf_id: str,
    body: CorrectionBody,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Create a NEW PRF submission with corrected form_data, linked to the original
    via correction_of_id. The original PRF is marked CORRECTED and never modified.

    This follows the immutable correction pattern required by POPIA:
      - Original form_data is preserved as before_state in the audit log.
      - Corrected form_data is preserved as after_state in the audit log.
      - The new PRF is enqueued for processing automatically.
    """
    import uuid as _uuid

    try:
        prf_uuid = _uuid.UUID(prf_id)
    except ValueError:
        raise HTTPException(400, "Invalid PRF ID format")

    # FOR UPDATE: a correction and a late/redelivered billing task for the same
    # PRF must not interleave. Without the lock both can observe a billable
    # original and each produce a Case + Claim for one ambulance call.
    result = await db.execute(
        select(DigitalPRF).where(DigitalPRF.id == prf_uuid).with_for_update()
    )
    original = result.scalar_one_or_none()
    if not original:
        raise HTTPException(404, f"PRF {prf_id} not found")

    if original.status != PRFStatus.FAILED:
        raise HTTPException(
            400,
            f"Only FAILED PRFs can be corrected. This PRF is '{original.status.value}'.",
        )

    # ALREADY BILLED — refuse.
    #
    # The status check alone is not enough. A PRF can be FAILED *and* already
    # hold a case_id: the billing task creates the Case, then something later in
    # the same run raises, and _mark_failed stamps FAILED over a row that was
    # billed. It then still appears in the failed queue (which filters on status
    # only), Retry is refused because it is already processed, so Correct is the
    # only action the UI offers — and correcting it mints a SECOND Case, Document
    # and Claim for the same ambulance call. Duplicate billing to the scheme.
    #
    # The sibling reprocess_failed_prf has always made this check; this route
    # never did.
    if original.case_id is not None:
        raise HTTPException(
            409,
            f"This PRF has already been billed (case {original.case_id}). "
            f"Correcting it would raise a second claim for the same incident. "
            f"Amend the existing case instead.",
        )

    # ── Build corrected form_data (merge original + corrections) ──
    original_data = dict(original.form_data or {})
    corrected_data = dict(original_data)
    corrected_data.update(body.form_data)

    # ── Create NEW PRF row with corrected data ──
    #
    # NUMBERING. prf_number carries the +100000 offset only because
    # (provider_id, prf_number) is unique and the original still holds the real
    # number. `_next_prf_number` now EXCLUDES rows with correction_of_id set, so
    # this out-of-band value no longer drags the provider's live sequence up by
    # 100 000 per correction.
    #
    # CASE NUMBER. This used to be left NULL with the comment "will be assigned
    # during processing" — nothing ever assigns it, so the corrected record (the
    # one that actually gets billed) stayed unfindable in the admin search,
    # which matches on case_number, and the PDF emailed to the receiving facility
    # fell back to the bogus 100005 for its title. The correction is the same
    # incident as the original, so its case number is derived from the
    # original's with a -C suffix: searching the original number still finds it,
    # and the lineage is readable without a join. case_number is globally unique
    # and capped at 50 characters, so the suffix is applied to a truncated base
    # and the counter climbs until it lands.
    corrected_case_number = await _next_correction_case_number(db, original)

    from app.models.digital_prf import DigitalPRF as PRFModel

    # CARRY EVERYTHING EXCEPT THE EXPLICIT EXCLUSIONS — do not hand-list what to
    # copy.
    #
    # This was a hand-written list of columns, and it has now been wrong twice.
    # The timestamps and odometer readings were forgotten first and added later;
    # then all FIVE signature columns were still missing, so a correction
    # produced a record with no handover signature — the receiving facility's
    # proof of delivery — on the row that actually gets billed and rendered into
    # the PDF. The form mirrors some signatures into form_data and the viewer
    # falls back to those, which is why only handover_signature and
    # valuables_signature were visibly lost, and why nobody noticed.
    #
    # A copy-list fails silently every time a clinical column is added. An
    # exclusion list fails loudly instead: forget to exclude something and you
    # get an obvious duplicate-identity bug, not a quietly missing signature.
    _NOT_INHERITED = {
        # Identity / numbering — the correction gets its own.
        "id", "prf_number", "case_number",
        # Lifecycle — set explicitly below.
        "status", "form_data", "correction_of_id", "review_flags", "submitted_at",
        "created_at", "updated_at",
        # Billing artefacts of the ORIGINAL run. Inheriting case_id would make
        # the correction look already-billed and skip the pipeline entirely.
        "case_id", "document_id",
        "processing_error", "processing_attempts", "last_processing_at",
        # Delivery stamps belong to the original send, not the re-issue.
        "facility_email_sent_to", "facility_email_sent_at", "facility_email_error",
    }
    inherited = {
        c.key: getattr(original, c.key)
        for c in PRFModel.__table__.columns
        if c.key not in _NOT_INHERITED
    }

    corrected_prf = PRFModel(
        **inherited,
        prf_number=original.prf_number + 100000,
        case_number=corrected_case_number,
        status=PRFStatus.SUBMITTED,
        form_data=corrected_data,
        # Link to original
        correction_of_id=original.id,
        review_flags=[{
            "type": "manual_correction",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "corrected_fields": list(body.form_data.keys()),
            "original_prf_id": str(original.id),
        }],
        submitted_at=datetime.now(timezone.utc),
    )
    db.add(corrected_prf)

    # ── Mark original as CORRECTED (immutable — no data change) ──
    original.status = PRFStatus.CORRECTED
    original.updated_at = datetime.now(timezone.utc)

    # ── Write audit log with before/after snapshots ──
    from app.models.audit_log import AuditLog
    audit = AuditLog(
        user_id=getattr(current_user, "id", None),
        action="CORRECTED",
        entity_type="digital_prf",
        entity_id=original.id,
        details={
            "corrected_fields": list(body.form_data.keys()),
            "new_prf_id": str(corrected_prf.id),
        },
        before_state={"form_data": original_data, "status": "failed"},
        after_state={"form_data": corrected_data, "status": "submitted"},
        notes=f"Manual correction of {len(body.form_data)} field(s). New PRF created.",
    )
    db.add(audit)

    await db.commit()
    await db.refresh(corrected_prf)

    # ── Enqueue the corrected PRF for processing ──
    #
    # The commit above has already happened, so an unhandled enqueue failure
    # returned a 500 for work that WAS saved. The admin then reasonably retries,
    # producing a second correction of the same PRF — another +100000 row and
    # another -C suffix — for one actual correction. The submit path in
    # digital_prf.py already handles a broker outage explicitly; this one did
    # not.
    #
    # Reverting is not the right recovery here (unlike submit, there is no
    # earlier state to fall back to — the correction is a new row that the admin
    # asked for and that is now committed). Instead say plainly that it was
    # saved. A correction left in SUBMITTED with no task is precisely the state
    # the stuck-PRF watchdog on this very queue detects and re-drives.
    from app.tasks.prf_processing import process_prf_submission
    try:
        # Synchronous kombu publish — offloaded so a hung broker cannot freeze
        # the event loop for every other request. See api/digital_prf.py submit.
        await publish_delay(process_prf_submission, str(corrected_prf.id))
    except Exception as enqueue_err:
        logger.error(
            "PRF %s corrected → new PRF %s SAVED but could not be enqueued: %s",
            prf_id, str(corrected_prf.id), enqueue_err,
        )
        raise HTTPException(
            status_code=503,
            detail=(
                "The correction was saved, but the processing queue is "
                "unavailable. Do NOT re-submit it — it will be picked up "
                "automatically once the queue recovers."
            ),
        )

    logger.info(
        "PRF %s corrected → new PRF %s created and enqueued",
        prf_id, str(corrected_prf.id),
    )
    return {
        "message": "PRF corrected. New submission created and enqueued.",
        "original_prf_id": str(original.id),
        "corrected_prf_id": str(corrected_prf.id),
    }


@router.post("/{prf_id}/reprocess")
async def reprocess_failed_prf(
    prf_id: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """
    Reset a failed PRF back to SUBMITTED and requeue for processing
    without changing form_data.
    """
    import uuid

    try:
        prf_uuid = uuid.UUID(prf_id)
    except ValueError:
        raise HTTPException(400, "Invalid PRF ID format")

    result = await db.execute(
        select(DigitalPRF).where(DigitalPRF.id == prf_uuid)
    )
    prf = result.scalar_one_or_none()
    if not prf:
        raise HTTPException(404, f"PRF {prf_id} not found")

    # Guards — reprocessing is only meaningful for PRFs whose pipeline never
    # completed. Without these, reprocessing a PROCESSED PRF flipped it back to
    # SUBMITTED while the task refused to touch it (case already exists) —
    # stranding it as "Processing…" forever; and reprocessing a DRAFT would
    # push an incomplete, never-submitted form into billing.
    if prf.status == PRFStatus.PROCESSED or prf.case_id is not None:
        raise HTTPException(
            409,
            "This PRF has already been processed (a case exists) — nothing to reprocess.",
        )
    if prf.status not in (PRFStatus.FAILED, PRFStatus.SUBMITTED):
        raise HTTPException(
            409,
            f"Only failed or stuck-submitted PRFs can be reprocessed "
            f"(this one is '{prf.status.value}').",
        )

    # Reset processing state. submitted_at is stamped NOW: a retry IS a fresh
    # submission attempt. Without this, an old PRF kept its original (stale)
    # submitted_at and instantly re-matched the stuck condition (>10 min), so
    # the admin alert stayed lit with a misleading "not picked up yet" row
    # even while the retry was genuinely in flight.
    prf.status = PRFStatus.SUBMITTED
    prf.processing_error = None
    prf.processing_attempts = 0
    prf.submitted_at = datetime.now(timezone.utc)
    prf.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(prf)

    # Requeue for processing. Synchronous kombu publish — offloaded so a hung
    # broker cannot freeze the event loop. See api/digital_prf.py submit.
    from app.tasks.prf_processing import process_prf_submission
    await publish_delay(process_prf_submission, str(prf.id))

    logger.info("PRF %s requeued for reprocessing", prf_id)
    return {"message": "PRF requeued for reprocessing", "prf_id": str(prf.id)}
