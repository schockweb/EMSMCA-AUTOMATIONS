"""
Failed PRF Management API — Admin tools for reviewing and reprocessing
PRFs that failed during the automated processing pipeline.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone, date

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.digital_prf import DigitalPRF, PRFStatus
from app.utils.security import get_current_user

logger = logging.getLogger("ems.failed_prfs")

router = APIRouter(prefix="/api/failed-prfs", tags=["Failed Forms"])


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

    return {
        "total_failed": total_failed,
        "failed_today": failed_today,
        "avg_attempts": avg_attempts,
        "oldest_unresolved_days": oldest_unresolved_days,
    }


@router.get("")
async def list_failed_prfs(
    search: str | None = Query(None, description="Search by PRF number"),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List all failed PRFs, ordered by last_processing_at DESC."""
    query = (
        select(DigitalPRF)
        .where(DigitalPRF.status == PRFStatus.FAILED)
        .order_by(DigitalPRF.last_processing_at.desc())
    )

    if search:
        query = query.where(
            DigitalPRF.prf_number == int(search)
            if search.isdigit()
            else DigitalPRF.case_number.ilike(f"%{search}%")
        )

    result = await db.execute(query)
    prfs = result.scalars().all()

    return [
        {
            "id": str(prf.id),
            "prf_number": prf.prf_number,
            "case_number": prf.case_number,
            "patient_name": (
                (prf.form_data or {}).get("patient_name", "")
                + " "
                + (prf.form_data or {}).get("patient_surname", "")
            ).strip(),
            "processing_error": (
                (prf.processing_error or "")[:200]
            ),
            "processing_attempts": prf.processing_attempts,
            "last_processing_at": (
                prf.last_processing_at.isoformat()
                if prf.last_processing_at
                else None
            ),
            "created_at": (
                prf.created_at.isoformat() if prf.created_at else None
            ),
        }
        for prf in prfs
    ]


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

    result = await db.execute(
        select(DigitalPRF).where(DigitalPRF.id == prf_uuid)
    )
    original = result.scalar_one_or_none()
    if not original:
        raise HTTPException(404, f"PRF {prf_id} not found")

    if original.status != PRFStatus.FAILED:
        raise HTTPException(
            400,
            f"Only FAILED PRFs can be corrected. This PRF is '{original.status.value}'.",
        )

    # ── Build corrected form_data (merge original + corrections) ──
    original_data = dict(original.form_data or {})
    corrected_data = dict(original_data)
    corrected_data.update(body.form_data)

    # ── Create NEW PRF row with corrected data ──
    from app.models.digital_prf import DigitalPRF as PRFModel
    corrected_prf = PRFModel(
        provider_id=original.provider_id,
        vehicle_id=original.vehicle_id,
        crew_member_1_id=original.crew_member_1_id,
        crew_member_2_id=original.crew_member_2_id,
        prf_number=original.prf_number + 100000,  # Offset to avoid collision; will be unique
        case_number=None,  # Will be assigned during processing
        status=PRFStatus.SUBMITTED,
        form_data=corrected_data,
        # Copy real-time timestamps from original
        time_call_received=original.time_call_received,
        time_dispatched=original.time_dispatched,
        time_mobile=original.time_mobile,
        time_on_scene=original.time_on_scene,
        time_depart_scene=original.time_depart_scene,
        time_at_destination=original.time_at_destination,
        time_handover=original.time_handover,
        time_available=original.time_available,
        time_back_to_base=original.time_back_to_base,
        # Copy odometer readings
        km_call_received=original.km_call_received,
        km_dispatched=original.km_dispatched,
        km_mobile=original.km_mobile,
        km_on_scene=original.km_on_scene,
        km_depart_scene=original.km_depart_scene,
        km_at_destination=original.km_at_destination,
        km_handover=original.km_handover,
        km_available=original.km_available,
        km_back_to_base=original.km_back_to_base,
        # Copy geo and billing
        geo_locations=original.geo_locations,
        billing_schema_code=original.billing_schema_code,
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
    from app.tasks.prf_processing import process_prf_submission
    process_prf_submission.delay(str(corrected_prf.id))

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

    # Reset processing state
    prf.status = PRFStatus.SUBMITTED
    prf.processing_error = None
    prf.processing_attempts = 0
    prf.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(prf)

    # Requeue for processing
    from app.tasks.prf_processing import process_prf_submission
    process_prf_submission.delay(str(prf.id))

    logger.info("PRF %s requeued for reprocessing", prf_id)
    return {"message": "PRF requeued for reprocessing", "prf_id": str(prf.id)}
