"""
Cases API — CRUD operations for EMS cases / pre-authorizations.
"""
import uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.case import Case, PreAuthStatus
from app.models.user import User
from app.schemas.case import CaseCreate, CaseUpdate, CaseResponse
from app.utils.security import get_current_user

router = APIRouter(prefix="/api/cases", tags=["Cases"])


def _case_to_response(c: Case) -> CaseResponse:
    """Helper to convert a Case ORM instance to a CaseResponse."""
    docs = getattr(c, 'documents', None)
    has_docs = docs and len(docs) > 0
    file_name = docs[0].original_filename if has_docs else 'Unknown File'
    original_filename = docs[0].original_filename if has_docs else None
    extracted_data = docs[0].extracted_data if has_docs else None
    document_id = str(docs[0].id) if has_docs else None

    claim_id = None
    adjudication_status = None
    if getattr(c, 'claims', None) and len(c.claims) > 0:
        latest_claim = sorted(c.claims, key=lambda x: x.created_at, reverse=True)[0]
        claim_id = str(latest_claim.id)
        adjudication_status = latest_claim.adjudication_status.value

    return CaseResponse(
        id=str(c.id),
        file_name=file_name,
        original_filename=original_filename,
        document_id=document_id,
        extracted_data=extracted_data,
        patient_name=c.patient_name,
        patient_id_number=c.patient_id_number,
        patient_dob=c.patient_dob,
        medical_scheme_name=c.medical_scheme_name,
        scheme_member_number=c.scheme_member_number,
        incident_date=c.incident_date,
        incident_location=c.incident_location,
        preauth_number=c.preauth_number,
        preauth_status=c.preauth_status.value,
        dependant_code=c.dependant_code,
        dispatch_type=c.dispatch_type,
        referring_doctor_pr=c.referring_doctor_pr,
        auth_flag=c.auth_flag,
        auth_flag_reason=c.auth_flag_reason,
        claim_id=claim_id,
        adjudication_status=adjudication_status,
        created_at=c.created_at,
    )


@router.post("/", response_model=CaseResponse, status_code=status.HTTP_201_CREATED)
async def create_case(
    body: CaseCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new EMS case / pre-authorization."""
    case = Case(
        patient_name=body.patient_name,
        patient_id_number=body.patient_id_number,
        patient_dob=body.patient_dob,
        medical_scheme_name=body.medical_scheme_name,
        scheme_member_number=body.scheme_member_number,
        incident_date=body.incident_date,
        incident_location=body.incident_location,
        preauth_number=body.preauth_number,
        dependant_code=body.dependant_code,
        dispatch_type=body.dispatch_type,
        referring_doctor_pr=body.referring_doctor_pr,
        assigned_provider_id=current_user.id,
    )
    db.add(case)
    await db.commit()
    result = await db.execute(
        select(Case).options(selectinload(Case.documents), selectinload(Case.claims)).where(Case.id == case.id)
    )
    case = result.scalar_one()
    return _case_to_response(case)


@router.get("/", response_model=list[CaseResponse])
async def list_cases(
    queue: Optional[str] = None,
    skip: int = 0,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """List all cases, filtered by queue logic."""
    query = select(Case).options(selectinload(Case.documents), selectinload(Case.claims)).order_by(Case.created_at.desc())
    
    if queue == 'era':
        # ERA queue: auth number obtained, ready for invoice submission
        query = query.where(Case.preauth_number.is_not(None))
    elif queue == 'management':
        # Management queue: all confirmed cases (HITL review cleared)
        # Show everything — both pending-auth and auth-obtained cases
        # Filter for cases linked to at least one reviewed document
        from app.models.document import Document
        reviewed_case_ids = select(Document.case_id).where(
            Document.needs_hitl_review == False,
            Document.case_id.is_not(None),
        ).scalar_subquery()
        query = query.where(Case.id.in_(reviewed_case_ids))
    # No queue param → return all cases (admin overview)

    result = await db.execute(query.offset(skip).limit(limit))
    cases = result.scalars().all()
    return [_case_to_response(c) for c in cases]


@router.get("/{case_id}", response_model=CaseResponse)
async def get_case(
    case_id: str,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Get a specific case by ID."""
    result = await db.execute(
        select(Case)
        .options(selectinload(Case.documents), selectinload(Case.claims))
        .where(Case.id == uuid.UUID(case_id))
    )
    case = result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    return _case_to_response(case)


@router.patch("/{case_id}", response_model=CaseResponse)
async def update_case(
    case_id: str,
    body: CaseUpdate,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Update a case."""
    result = await db.execute(
        select(Case)
        .options(selectinload(Case.documents), selectinload(Case.claims))
        .where(Case.id == uuid.UUID(case_id))
    )
    case = result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")

    for field, value in body.model_dump(exclude_unset=True).items():
        if field == "preauth_status" and value is not None:
            setattr(case, field, PreAuthStatus(value))
        elif value is not None:
            setattr(case, field, value)

    await db.commit()
    await db.refresh(case)
    return _case_to_response(case)


@router.delete("/all", status_code=status.HTTP_204_NO_CONTENT)
async def delete_all_cases(
    queue: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Hard-delete all cases, or scope bounds by the queue (e.g. only cases in management queue)."""
    import os
    from sqlalchemy import delete
    from app.models.document import Document
    from app.models.claim import Claim
    from app.models.claim_line import ClaimLine
    from app.models.rfi import RFI
    from app.models.auth_request import SchemeAuthRequest
    from app.models.case import Case
    from app.utils.storage import get_full_path

    # First determine which cases we are deleting
    query = select(Case.id)
    if queue == 'era':
        query = query.where(Case.preauth_number.is_not(None))
    elif queue == 'management':
        reviewed_case_ids = select(Document.case_id).where(
            Document.needs_hitl_review == False,
            Document.case_id.is_not(None),
        ).scalar_subquery()
        query = query.where(Case.id.in_(reviewed_case_ids))
        
    result = await db.execute(query)
    case_ids = result.scalars().all()

    if not case_ids:
        return

    # Delete physical files
    docs_result = await db.execute(select(Document).where(Document.case_id.in_(case_ids)))
    docs = docs_result.scalars().all()
    for doc in docs:
        for uri in [doc.storage_uri, doc.processed_uri]:
            if uri:
                full_path = get_full_path(uri)
                if os.path.exists(full_path):
                    try:
                        os.remove(full_path)
                    except OSError:
                        pass

    # Wipe tables (order matters for FKs) scoped to these case IDs
    # Get all claim IDs tied to these cases
    claims_result = await db.execute(select(Claim.id).where(Claim.case_id.in_(case_ids)))
    claim_ids = claims_result.scalars().all()

    if claim_ids:
        await db.execute(delete(RFI).where(RFI.claim_id.in_(claim_ids)))
        await db.execute(delete(SchemeAuthRequest).where(SchemeAuthRequest.claim_id.in_(claim_ids)))
        await db.execute(delete(ClaimLine).where(ClaimLine.claim_id.in_(claim_ids)))
        await db.execute(delete(Claim).where(Claim.id.in_(claim_ids)))

    # Scheme Auth requests can also be tied to case directly
    await db.execute(delete(SchemeAuthRequest).where(SchemeAuthRequest.case_id.in_(case_ids)))
    await db.execute(delete(Document).where(Document.case_id.in_(case_ids)))
    await db.execute(delete(Case).where(Case.id.in_(case_ids)))
    
    await db.commit()



@router.delete("/{case_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_case(
    case_id: str,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Delete a case and all of its associated documents, claims, lines, and RFIs."""
    from sqlalchemy import delete, update
    from app.models.document import Document
    from app.models.claim import Claim
    from app.models.claim_line import ClaimLine
    from app.models.rfi import RFI
    from app.models.auth_request import SchemeAuthRequest
    from app.models.digital_prf import DigitalPRF

    # Load case with claims
    result = await db.execute(select(Case).options(selectinload(Case.claims)).where(Case.id == uuid.UUID(case_id)))
    case = result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")

    claim_ids = [c.id for c in case.claims]

    if claim_ids:
        # Delete RFIs
        await db.execute(delete(RFI).where(RFI.claim_id.in_(claim_ids)))
        # Delete Scheme Auth Requests tied to claims
        await db.execute(delete(SchemeAuthRequest).where(SchemeAuthRequest.claim_id.in_(claim_ids)))
        # Delete ClaimLines
        await db.execute(delete(ClaimLine).where(ClaimLine.claim_id.in_(claim_ids)))
        # Delete Claims
        await db.execute(delete(Claim).where(Claim.case_id == case.id))

    # Also delete any Scheme Auth Requests tied directly to case
    await db.execute(delete(SchemeAuthRequest).where(SchemeAuthRequest.case_id == case.id))

    # Unlink any DigitalPRF rows that reference this case's documents or
    # the case itself. Submitted Digital PRFs hold FKs to documents.id and
    # cases.id; without nulling them first the Document delete below trips
    # the digital_prfs_document_id_fkey constraint. We keep the PRF row
    # itself (it's a billing-history record) — just sever the link.
    await db.execute(
        update(DigitalPRF)
        .where(DigitalPRF.case_id == case.id)
        .values(case_id=None, document_id=None)
    )

    # Delete Documents
    await db.execute(delete(Document).where(Document.case_id == case.id))

    # Delete Case
    await db.execute(delete(Case).where(Case.id == case.id))

    await db.commit()

