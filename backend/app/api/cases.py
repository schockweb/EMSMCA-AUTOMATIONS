"""
Cases API — CRUD operations for EMS cases / pre-authorizations.
"""
from __future__ import annotations
import uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, func, or_
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.case import Case, PreAuthStatus
from app.models.digital_prf import DigitalPRF
from app.models.user import User, UserRole
from app.schemas.case import CaseCreate, CaseUpdate, CaseResponse
from app.utils.security import get_current_user, require_role

router = APIRouter(prefix="/api/cases", tags=["Cases"])


def _prf_display_name(provider_name, prf_number, form_data) -> Optional[str]:
    """Canonical PRF name — "{PREFIX}{prf_number} PRF {scheme} {call_type}",
    e.g. "JEMS EMERGENCY106 PRF Discovery Health IHT". Kept in sync with the
    exported-PDF filename (buildPrfFileName in PRFView.tsx). Prefix = the
    provider's admin-chosen `prf_name` when set, else the full provider name
    (alphanumerics + spaces), uppercased. Empty parts are dropped;
    returns None when there's nothing meaningful to show."""
    fd = form_data or {}
    prefix = "".join(ch for ch in str(provider_name or "") if ch.isalnum() or ch == " ").strip().upper()
    head = f"{prefix}{prf_number}".strip() if prf_number is not None else prefix.strip()
    tail = [str(fd.get("medical_scheme") or "").strip(), str(fd.get("call_type") or "").strip()]
    tail = [t for t in tail if t]
    if not head and not tail:
        return None
    return " ".join(([head] if head else []) + ["PRF"] + tail)


async def _display_names_for(db: AsyncSession, case_ids: list) -> dict:
    """Map case_id -> PRF display name, sourced from each case's DigitalPRF +
    provider. When a case has multiple PRFs (e.g. corrections) the newest wins."""
    if not case_ids:
        return {}
    rows = (await db.execute(
        select(DigitalPRF)
        .options(selectinload(DigitalPRF.provider))
        .where(DigitalPRF.case_id.in_(case_ids))
        .order_by(DigitalPRF.created_at.asc())
    )).scalars().all()
    names: dict = {}
    for p in rows:
        nm = _prf_display_name(
            (p.provider.prf_name or p.provider.name) if p.provider else None,
            p.prf_number, p.form_data,
        )
        if nm:
            names[p.case_id] = nm  # asc order → later (newer) row overwrites
    return names


def _case_to_response(c: Case, display_name: Optional[str] = None) -> CaseResponse:
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
        display_name=display_name,
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


def _build_case_filter(queue: Optional[str], search: Optional[str]) -> list:
    """WHERE conditions shared by the list and count endpoints, so the
    dashboard's "showing N of M" always counts exactly what the list returns.
    Both the queue routing and the free-text search live here."""
    conditions: list = []

    if queue == 'era':
        # ERA queue: auth number obtained, ready for invoice submission
        conditions.append(Case.preauth_number.is_not(None))
    elif queue == 'management':
        # Management queue: cases linked to at least one HITL-cleared document
        from app.models.document import Document
        reviewed_case_ids = select(Document.case_id).where(
            Document.needs_hitl_review == False,
            Document.case_id.is_not(None),
        ).scalar_subquery()
        conditions.append(Case.id.in_(reviewed_case_ids))
    # No queue param → no queue restriction (admin overview)

    if search and search.strip():
        # Server-side search so records beyond the page limit stay reachable —
        # essential now that PRFs are retained for 7 years. patient_id_number is
        # encrypted at rest and is deliberately excluded (can't be ilike-matched).
        term = f"%{search.strip()}%"
        conditions.append(or_(
            Case.patient_name.ilike(term),
            Case.medical_scheme_name.ilike(term),
            Case.preauth_number.ilike(term),
            Case.scheme_member_number.ilike(term),
            Case.custom_display_name.ilike(term),
        ))

    return conditions


@router.get("/", response_model=list[CaseResponse])
async def list_cases(
    queue: Optional[str] = None,
    search: Optional[str] = None,
    skip: int = 0,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """List cases by queue + optional server-side search.

    Returns a bare list (two consumers: Cases and ERA tracking — the shape must
    not change). Pair with GET /api/cases/count using the same queue/search for
    an honest "showing N of M": records past `limit` stay reachable via search
    or by paging with `skip`, so 7 years of history never goes dark."""
    conditions = _build_case_filter(queue, search)
    query = (
        select(Case)
        .options(selectinload(Case.documents), selectinload(Case.claims))
        .where(*conditions)
        .order_by(Case.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    result = await db.execute(query)
    cases = result.scalars().all()
    names = await _display_names_for(db, [c.id for c in cases])
    # Manual rename override (custom_display_name) wins over the computed name.
    return [_case_to_response(c, (c.custom_display_name or names.get(c.id))) for c in cases]


@router.get("/count")
async def count_cases(
    queue: Optional[str] = None,
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Total cases matching the same queue/search filter as the list endpoint,
    so the dashboard can show how many records exist beyond the current page
    rather than a silently-truncated count. Declared before /{case_id} so this
    literal path wins over the UUID route."""
    conditions = _build_case_filter(queue, search)
    result = await db.execute(
        select(func.count()).select_from(Case).where(*conditions)
    )
    return {"total": int(result.scalar() or 0)}


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
    names = await _display_names_for(db, [case.id])
    return _case_to_response(case, (case.custom_display_name or names.get(case.id)))


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
        elif field == "custom_display_name":
            # Explicit rename. Empty/whitespace clears the override (revert to computed).
            cleaned = (value or "").strip()
            case.custom_display_name = cleaned or None
        elif value is not None:
            setattr(case, field, value)

    await db.commit()
    await db.refresh(case)
    names = await _display_names_for(db, [case.id])
    return _case_to_response(case, (case.custom_display_name or names.get(case.id)))


@router.delete("/all", status_code=status.HTTP_204_NO_CONTENT)
async def delete_all_cases(
    queue: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(require_role(UserRole.SUPER_ADMIN)),
):
    """Hard-delete all cases, or scope bounds by the queue (e.g. only cases in management queue).

    SUPER_ADMIN only. This is the single most destructive route in the API — it
    wipes every case, claim, claim line, RFI, scheme auth request and document
    on the instance, and unlinks the PDFs from disk. It ran on bare
    get_current_user, so any authenticated account (default role PARAMEDIC)
    could empty a client's entire claim history in one request.
    """
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

    # Collect the file paths NOW, but do not unlink anything yet. Unlinking ran
    # before the transaction, so any failure in the DB wipe below rolled the
    # rows back and left the case pointing at PDFs that no longer exist —
    # unrecoverable, because a rollback cannot restore a file. Files are removed
    # only after the commit succeeds.
    chunk_size = 500
    doomed_paths: list[str] = []
    for i in range(0, len(case_ids), chunk_size):
        chunk = case_ids[i:i + chunk_size]
        docs_result = await db.execute(select(Document).where(Document.case_id.in_(chunk)))
        docs = docs_result.scalars().all()
        for doc in docs:
            for uri in [doc.storage_uri, doc.processed_uri]:
                if uri:
                    doomed_paths.append(get_full_path(uri))

    # Wipe tables (order matters for FKs) scoped to these case IDs
    # Process in chunks of 500 to avoid PostgreSQL's 32,767 parameter limit (TooManyParametersError)
    chunk_size = 500
    for i in range(0, len(case_ids), chunk_size):
        chunk_cases = case_ids[i:i + chunk_size]
        
        # Get all claim IDs tied to these chunked cases
        claims_result = await db.execute(select(Claim.id).where(Claim.case_id.in_(chunk_cases)))
        chunk_claims = claims_result.scalars().all()

        if chunk_claims:
            for j in range(0, len(chunk_claims), chunk_size):
                sub_claims = chunk_claims[j:j + chunk_size]
                await db.execute(delete(RFI).where(RFI.claim_id.in_(sub_claims)))
                await db.execute(delete(SchemeAuthRequest).where(SchemeAuthRequest.claim_id.in_(sub_claims)))
                await db.execute(delete(ClaimLine).where(ClaimLine.claim_id.in_(sub_claims)))
                await db.execute(delete(Claim).where(Claim.id.in_(sub_claims)))

        # Scheme Auth requests can also be tied to case directly
        await db.execute(delete(SchemeAuthRequest).where(SchemeAuthRequest.case_id.in_(chunk_cases)))
        await db.execute(delete(Document).where(Document.case_id.in_(chunk_cases)))
        await db.execute(delete(Case).where(Case.id.in_(chunk_cases)))

    await db.commit()

    # Rows are gone and committed — now the files are safe to unlink.
    for full_path in doomed_paths:
        if os.path.exists(full_path):
            try:
                os.remove(full_path)
            except OSError:
                pass



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

