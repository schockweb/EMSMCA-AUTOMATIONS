"""
EDI API — Electronic Data Interchange endpoints for claim submission.
"""
from __future__ import annotations
import uuid
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from typing import Optional

from app.database import get_db
from app.models.user import User
from app.models.edi_submission import EDISubmission, SubmissionStatus
from app.utils.security import get_current_user
from app.services.edi_generator import (
    generate_healthbridge_xml,
    generate_mediswitch_xml,
    submit_to_clearinghouse,
    poll_submission_status,
)

router = APIRouter(prefix="/api/edi", tags=["EDI"])


# ── Schemas ────────────────────────────────────────

class GenerateEDIRequest(BaseModel):
    claim_id: str
    clearinghouse: str = "healthbridge"  # "healthbridge" or "mediswitch"


class SubmitEDIRequest(BaseModel):
    submission_id: str


class EDISubmissionResponse(BaseModel):
    id: str
    claim_id: str
    clearinghouse: str
    edi_format: str
    status: str
    edi_reference: Optional[str] = None
    submitted_at: Optional[str] = None
    created_at: str

    class Config:
        from_attributes = True


# ── Endpoints ──────────────────────────────────────

@router.post("/generate")
async def generate_edi(
    body: GenerateEDIRequest,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """
    Generate EDI XML payload for a clean claim.
    Supports HealthBridge and Mediswitch formats.
    """
    if body.clearinghouse == "healthbridge":
        result = await generate_healthbridge_xml(body.claim_id, db)
    elif body.clearinghouse == "mediswitch":
        result = await generate_mediswitch_xml(body.claim_id, db)
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported clearinghouse: {body.clearinghouse}. Use 'healthbridge' or 'mediswitch'."
        )

    if not result.success:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "EDI generation failed — claim data incomplete",
                "validation_errors": result.validation_errors,
            },
        )

    return {
        "success": True,
        "submission_id": result.submission_id,
        "clearinghouse": result.clearinghouse,
        "edi_format": result.edi_format,
        "edi_xml_preview": result.edi_xml[:2000] if len(result.edi_xml) > 2000 else result.edi_xml,
        "xml_length": len(result.edi_xml),
    }


@router.post("/submit")
async def submit_edi(
    request: Request,
    body: SubmitEDIRequest,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """
    Submit a generated EDI payload to the target clearinghouse (Idempotent lock applied).
    """
    from app.utils.idempotency import process_idempotent_request

    async def _execute():
        result = await submit_to_clearinghouse(body.submission_id, db)
        if not result.get("success"):
            raise HTTPException(
                status_code=422,
                detail=result.get("error", "Submission failed"),
            )
        return result

    return await process_idempotent_request(request, db, _execute)


@router.get("/submissions")
async def list_submissions(
    claim_id: Optional[str] = None,
    status_filter: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """List EDI submissions with optional filters."""
    from sqlalchemy import func

    query = select(EDISubmission).order_by(EDISubmission.created_at.desc())

    if claim_id:
        query = query.where(EDISubmission.claim_id == uuid.UUID(claim_id))
    if status_filter:
        query = query.where(EDISubmission.submission_status == SubmissionStatus(status_filter))

    # Count total
    count_query = select(func.count(EDISubmission.id))
    if claim_id:
        count_query = count_query.where(EDISubmission.claim_id == uuid.UUID(claim_id))
    if status_filter:
        count_query = count_query.where(EDISubmission.submission_status == SubmissionStatus(status_filter))

    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0

    # Paginate
    query = query.offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(query)
    submissions = result.scalars().all()

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "submissions": [
            {
                "id": str(s.id),
                "claim_id": str(s.claim_id),
                "clearinghouse": s.clearinghouse,
                "edi_format": s.edi_format.value,
                "status": s.submission_status.value,
                "edi_reference": s.edi_reference,
                "submitted_at": s.submitted_at.isoformat() if s.submitted_at else None,
                "acknowledged_at": s.acknowledged_at.isoformat() if s.acknowledged_at else None,
                "retry_count": s.retry_count,
                "created_at": s.created_at.isoformat(),
            }
            for s in submissions
        ],
    }


@router.get("/submissions/{submission_id}")
async def get_submission(
    submission_id: str,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Get full details for a specific EDI submission, including the XML payload."""
    result = await db.execute(
        select(EDISubmission).where(EDISubmission.id == uuid.UUID(submission_id))
    )
    submission = result.scalar_one_or_none()
    if not submission:
        raise HTTPException(status_code=404, detail="Submission not found")

    return {
        "id": str(submission.id),
        "claim_id": str(submission.claim_id),
        "clearinghouse": submission.clearinghouse,
        "edi_format": submission.edi_format.value,
        "status": submission.submission_status.value,
        "edi_reference": submission.edi_reference,
        "edi_payload": submission.edi_payload,
        "response_payload": submission.response_payload,
        "response_code": submission.response_code,
        "rejection_reasons": submission.rejection_reasons,
        "submitted_at": submission.submitted_at.isoformat() if submission.submitted_at else None,
        "acknowledged_at": submission.acknowledged_at.isoformat() if submission.acknowledged_at else None,
        "retry_count": submission.retry_count,
        "created_at": submission.created_at.isoformat(),
    }


@router.post("/submissions/{submission_id}/poll")
async def poll_status(
    submission_id: str,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Poll clearinghouse for latest status of a submission."""
    result = await poll_submission_status(submission_id, db)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.get("/submissions/{submission_id}/xml")
async def download_edi_xml(
    submission_id: str,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Download the raw EDI XML payload for a submission."""
    from fastapi.responses import Response

    result = await db.execute(
        select(EDISubmission).where(EDISubmission.id == uuid.UUID(submission_id))
    )
    submission = result.scalar_one_or_none()
    if not submission:
        raise HTTPException(status_code=404, detail="Submission not found")
    if not submission.edi_payload:
        raise HTTPException(status_code=404, detail="No EDI payload generated")

    filename = f"{submission.clearinghouse}_{submission.edi_reference or submission.id}.xml"

    return Response(
        content=submission.edi_payload,
        media_type="application/xml",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
