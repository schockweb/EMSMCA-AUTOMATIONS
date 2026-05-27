"""
Claims API — Claim creation, listing, and status management.
"""
import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.claim import Claim, AdjudicationStatus
from app.models.claim_line import ClaimLine
from app.models.user import User
from app.schemas.claim import ClaimCreate, ClaimUpdate, ClaimResponse, ClaimLineResponse
from app.utils.security import get_current_user

router = APIRouter(prefix="/api/claims", tags=["Claims"])


@router.post("/", response_model=ClaimResponse, status_code=status.HTTP_201_CREATED)
async def create_claim(
    body: ClaimCreate,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Create a new claim with optional line items."""
    claim = Claim(
        case_id=uuid.UUID(body.case_id),
        target_scheme=body.target_scheme,
    )
    db.add(claim)
    await db.flush()

    total = 0
    for line_data in body.lines:
        line = ClaimLine(
            claim_id=claim.id,
            line_number=line_data.line_number,
            cpt_code=line_data.cpt_code,
            nappi_code=line_data.nappi_code,
            icd10_primary=line_data.icd10_primary,
            icd10_secondary=line_data.icd10_secondary,
            description=line_data.description,
            quantity=line_data.quantity,
            unit_price=line_data.unit_price,
            total_price=line_data.total_price,
            modifier=line_data.modifier,
        )
        db.add(line)
        total += line_data.total_price

    claim.total_amount = total
    await db.commit()
    await db.refresh(claim)

    # Load claim lines
    lines_result = await db.execute(
        select(ClaimLine).where(ClaimLine.claim_id == claim.id).order_by(ClaimLine.line_number)
    )
    lines = lines_result.scalars().all()

    return ClaimResponse(
        id=str(claim.id),
        case_id=str(claim.case_id),
        total_amount=float(claim.total_amount or 0),
        target_scheme=claim.target_scheme,
        dispatch_reference_number=claim.dispatch_reference_number,
        adjudication_status=claim.adjudication_status.value,
        submitted_at=claim.submitted_at,
        created_at=claim.created_at,
        claim_lines=[
            ClaimLineResponse(
                id=str(l.id),
                line_number=l.line_number,
                cpt_code=l.cpt_code,
                nappi_code=l.nappi_code,
                icd10_primary=l.icd10_primary,
                icd10_secondary=l.icd10_secondary,
                description=l.description,
                quantity=l.quantity,
                unit_price=float(l.unit_price),
                total_price=float(l.total_price),
                modifier=l.modifier,
            )
            for l in lines
        ],
    )


@router.get("/", response_model=list[ClaimResponse])
async def list_claims(
    skip: int = 0,
    limit: int = 50,
    status_filter: str | None = None,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """List claims with optional status filter."""
    query = select(Claim).order_by(Claim.created_at.desc()).offset(skip).limit(limit)
    if status_filter:
        query = query.where(Claim.adjudication_status == AdjudicationStatus(status_filter))

    result = await db.execute(query)
    claims = result.scalars().all()

    return [
        ClaimResponse(
            id=str(c.id),
            case_id=str(c.case_id),
            total_amount=float(c.total_amount or 0),
            target_scheme=c.target_scheme,
            dispatch_reference_number=c.dispatch_reference_number,
            adjudication_status=c.adjudication_status.value,
            submitted_at=c.submitted_at,
            created_at=c.created_at,
            claim_lines=[],
        )
        for c in claims
    ]


@router.get("/{claim_id}", response_model=ClaimResponse)
async def get_claim(
    claim_id: str,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Get a specific claim with its line items."""
    result = await db.execute(select(Claim).where(Claim.id == uuid.UUID(claim_id)))
    claim = result.scalar_one_or_none()
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")

    lines_result = await db.execute(
        select(ClaimLine).where(ClaimLine.claim_id == claim.id).order_by(ClaimLine.line_number)
    )
    lines = lines_result.scalars().all()

    return ClaimResponse(
        id=str(claim.id),
        case_id=str(claim.case_id),
        total_amount=float(claim.total_amount or 0),
        target_scheme=claim.target_scheme,
        dispatch_reference_number=claim.dispatch_reference_number,
        adjudication_status=claim.adjudication_status.value,
        submitted_at=claim.submitted_at,
        created_at=claim.created_at,
        claim_lines=[
            ClaimLineResponse(
                id=str(l.id),
                line_number=l.line_number,
                cpt_code=l.cpt_code,
                nappi_code=l.nappi_code,
                icd10_primary=l.icd10_primary,
                icd10_secondary=l.icd10_secondary,
                description=l.description,
                quantity=l.quantity,
                unit_price=float(l.unit_price),
                total_price=float(l.total_price),
                modifier=l.modifier,
            )
            for l in lines
        ],
    )


from app.schemas.claim import ClaimLinesUpdateBulk

@router.patch("/{claim_id}/lines", response_model=ClaimResponse)
async def update_claim_lines(
    claim_id: str,
    body: ClaimLinesUpdateBulk,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Bulk update claim lines explicitly setting quantities and total prices."""
    # Fetch claim to ensure it exists
    result = await db.execute(select(Claim).where(Claim.id == uuid.UUID(claim_id)))
    claim = result.scalar_one_or_none()
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")

    # Fetch all lines for this claim
    lines_result = await db.execute(
        select(ClaimLine).where(ClaimLine.claim_id == claim.id)
    )
    db_lines = lines_result.scalars().all()
    line_map = {str(l.id): l for l in db_lines}

    total_amount = 0.0

    for upd in body.lines:
        # Reject invalid quantities; keeps bad data out of billing.
        if upd.quantity < 1:
            raise HTTPException(
                status_code=400,
                detail=f"Line {upd.id}: quantity must be at least 1 (got {upd.quantity})",
            )
        if upd.total_price < 0:
            raise HTTPException(
                status_code=400,
                detail=f"Line {upd.id}: total_price cannot be negative",
            )
        if upd.id in line_map:
            line_map[upd.id].quantity = upd.quantity
            line_map[upd.id].total_price = upd.total_price

    # Recalculate claim total
    for l in db_lines:
        total_amount += float(l.total_price)

    claim.total_amount = total_amount

    # Persist dispatch reference on the same call (aggregator payer flow)
    if body.dispatch_reference_number is not None:
        claim.dispatch_reference_number = body.dispatch_reference_number.strip() or None

    await db.commit()
    
    # Return updated claim recursively
    return await get_claim(claim_id, db, _current)


# ── Void & Re-Bill Endpoints ───────────────────────────────

from datetime import datetime, timezone
from pydantic import BaseModel, Field
from app.models.user import UserRole
from app.utils.security import require_role
from app.models.audit_log import AuditLog


class VoidClaimBody(BaseModel):
    reason: str = Field(..., min_length=5, max_length=2000,
                        description="Mandatory reason for voiding this claim — required by audit policy")


@router.post("/{claim_id}/void")
async def void_claim(
    claim_id: str,
    body: VoidClaimBody,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    """Void a claim. Admin-only. Requires a mandatory reason.

    A voided claim cannot be un-voided — a new rebill must be created instead.
    """
    result = await db.execute(select(Claim).where(Claim.id == uuid.UUID(claim_id)))
    claim = result.scalar_one_or_none()
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")

    if claim.voided:
        raise HTTPException(status_code=400, detail="Claim is already voided")

    # Capture before state for audit
    before_state = {
        "total_amount": float(claim.total_amount or 0),
        "adjudication_status": claim.adjudication_status.value,
        "voided": False,
    }

    # Void the claim
    claim.voided = True
    claim.voided_at = datetime.now(timezone.utc)
    claim.voided_by = current_user.id
    claim.voided_reason = body.reason.strip()
    claim.updated_at = datetime.now(timezone.utc)

    # Audit log
    audit = AuditLog(
        user_id=current_user.id,
        action="VOIDED",
        entity_type="claim",
        entity_id=claim.id,
        before_state=before_state,
        after_state={
            "total_amount": float(claim.total_amount or 0),
            "adjudication_status": claim.adjudication_status.value,
            "voided": True,
            "voided_at": claim.voided_at.isoformat(),
        },
        notes=body.reason.strip(),
    )
    db.add(audit)

    await db.commit()

    return {
        "message": "Claim voided successfully",
        "claim_id": claim_id,
        "voided_at": claim.voided_at.isoformat(),
        "voided_by": str(current_user.id),
    }


@router.post("/{claim_id}/rebill")
async def rebill_claim(
    claim_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN)),
):
    """Re-bill a voided claim. Creates a new claim by reprocessing the PRF.

    Only allowed if the original claim is voided. The new claim is linked
    to the original via amended_by_id on the original claim.
    """
    result = await db.execute(select(Claim).where(Claim.id == uuid.UUID(claim_id)))
    claim = result.scalar_one_or_none()
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")

    if not claim.voided:
        raise HTTPException(status_code=400, detail="Only voided claims can be re-billed")

    if claim.amended_by_id:
        raise HTTPException(
            status_code=400,
            detail=f"This claim has already been re-billed (see claim {claim.amended_by_id})",
        )

    # Find the PRF linked to this claim's case
    from app.models.digital_prf import DigitalPRF
    from app.models.case import Case

    case_result = await db.execute(select(Case).where(Case.id == claim.case_id))
    case = case_result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Linked case not found")

    prf_result = await db.execute(
        select(DigitalPRF).where(DigitalPRF.case_id == case.id)
    )
    prf = prf_result.scalar_one_or_none()
    if not prf:
        raise HTTPException(
            status_code=400,
            detail="No PRF found for this claim's case — cannot re-bill",
        )

    # Reprocess through tariff engine
    from app.services.tariff_engine import generate_tariff_lines
    from app.api.digital_prf import flatten_prf_for_billing

    extracted_data = flatten_prf_for_billing(prf)
    scheme_name = claim.target_scheme or ""
    tariff_result = await generate_tariff_lines(extracted_data, scheme_name, db)

    if tariff_result.get("error"):
        raise HTTPException(
            status_code=422,
            detail=f"Re-billing failed: {tariff_result['error']}",
        )

    # Create new claim
    new_claim = Claim(
        case_id=claim.case_id,
        target_scheme=claim.target_scheme,
        total_amount=tariff_result["total_amount"],
        adjudication_status=AdjudicationStatus.PENDING,
        dispatch_reference_number=claim.dispatch_reference_number,
    )
    db.add(new_claim)
    await db.flush()

    # Create claim lines from tariff result
    for idx, line_data in enumerate(tariff_result.get("lines", []), start=1):
        line = ClaimLine(
            claim_id=new_claim.id,
            line_number=idx,
            cpt_code=line_data.get("cpt_code"),
            nappi_code=line_data.get("nappi_code"),
            icd10_primary=line_data.get("icd10_primary"),
            icd10_secondary=line_data.get("icd10_secondary"),
            description=line_data.get("description"),
            quantity=line_data.get("quantity", 1),
            unit_price=line_data.get("unit_price", 0),
            total_price=line_data.get("total_price", 0),
            modifier=line_data.get("modifier"),
        )
        db.add(line)

    # Link original claim → new claim
    claim.amended_by_id = new_claim.id

    # Audit log
    audit = AuditLog(
        user_id=current_user.id,
        action="AMENDED",
        entity_type="claim",
        entity_id=claim.id,
        before_state={
            "total_amount": float(claim.total_amount or 0),
            "voided": True,
            "voided_reason": claim.voided_reason,
        },
        after_state={
            "new_claim_id": str(new_claim.id),
            "new_total_amount": float(new_claim.total_amount or 0),
            "lines_count": len(tariff_result.get("lines", [])),
        },
        notes=f"Re-billed voided claim. New claim total: R{float(new_claim.total_amount or 0):.2f}",
    )
    db.add(audit)

    await db.commit()

    return {
        "message": "Claim re-billed successfully",
        "original_claim_id": claim_id,
        "new_claim_id": str(new_claim.id),
        "new_total_amount": float(new_claim.total_amount or 0),
        "lines_count": len(tariff_result.get("lines", [])),
    }
