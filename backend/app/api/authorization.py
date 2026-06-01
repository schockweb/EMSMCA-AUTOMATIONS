"""
Authorization API — Submit, track, and retry scheme authorization requests.
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.case import Case, PreAuthStatus
from app.models.claim import Claim
from app.models.claim_line import ClaimLine
from app.models.user import User
from app.models.auth_request import SchemeAuthRequest, AuthRequestStatus
from app.models.system_settings import SystemSettings
from app.schemas.authorization import AuthRequestResponse, AuthHistoryResponse, AuthRequestCreate
from app.services.scheme_auth import (
    resolve_scheme_credentials,
    get_adapter_for_scheme,
)
from app.utils.security import get_current_user

router = APIRouter(prefix="/api/authorization", tags=["Authorization"])


def _auth_to_response(a: SchemeAuthRequest) -> AuthRequestResponse:
    return AuthRequestResponse(
        id=str(a.id),
        case_id=str(a.case_id),
        claim_id=str(a.claim_id) if a.claim_id else None,
        scheme_name=a.scheme_name,
        status=a.status.value,
        auth_number=a.auth_number,
        approved_amount=float(a.approved_amount) if a.approved_amount else None,
        decline_reason=a.decline_reason,
        requested_at=a.requested_at,
        responded_at=a.responded_at,
        request_payload=a.request_payload,
        response_payload=a.response_payload,
    )


@router.post("/request/{case_id}", response_model=AuthRequestResponse)
async def request_authorization(
    case_id: str,
    body: AuthRequestCreate = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Submit an authorization request to the medical scheme for a case."""
    # Load case
    case_result = await db.execute(
        select(Case).where(Case.id == uuid.UUID(case_id))
    )
    case = case_result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")

    # Apply overrides from request body
    if body:
        if body.dispatch_type:
            case.dispatch_type = body.dispatch_type
        if body.referring_doctor_pr:
            case.referring_doctor_pr = body.referring_doctor_pr
        if body.dependant_code:
            case.dependant_code = body.dependant_code

    # Load claim + lines
    claim_result = await db.execute(
        select(Claim).where(Claim.case_id == case.id).limit(1)
    )
    claim = claim_result.scalar_one_or_none()

    claim_lines = []
    if claim:
        lines_result = await db.execute(
            select(ClaimLine).where(ClaimLine.claim_id == claim.id)
        )
        claim_lines = lines_result.scalars().all()

    # Load provider
    provider = None
    if case.assigned_provider_id:
        provider_result = await db.execute(
            select(User).where(User.id == case.assigned_provider_id)
        )
        provider = provider_result.scalar_one_or_none()

    # Authorization rules are hardcoded in app.rules.base now — no DB lookup.
    rules: dict = {}

    # Build structured request payload from §08 form data
    structured_payload: dict = {}
    if body and body.member_data:
        structured_payload["member"] = body.member_data
    if body and body.clinical_data:
        structured_payload["clinical"] = body.clinical_data

    # Create audit record
    auth_req = SchemeAuthRequest(
        case_id=case.id,
        claim_id=claim.id if claim else None,
        scheme_name=case.medical_scheme_name,
        status=AuthRequestStatus.PENDING,
        requested_by=current_user.id,
        request_payload=structured_payload if structured_payload else None,
    )
    db.add(auth_req)
    await db.flush()

    # Execute the authorization request
    try:
        # Resolve credentials from SCHEME_<ID>_* env vars via the rules registry
        creds = resolve_scheme_credentials(case.medical_scheme_name)

        if creds is None:
            # No hardcoded rule module OR no env vars set → pin the case to the
            # top of the queue with a clear reason for ops to action.
            case.auth_flag = True
            case.auth_flag_reason = (
                f"No API credentials configured for scheme "
                f"'{case.medical_scheme_name}'. Contact engineering to set "
                f"SCHEME_<ID>_* env vars and add a rule module under "
                f"backend/app/rules/."
            )
            await db.commit()
            await db.refresh(auth_req)

            auth_req.status = AuthRequestStatus.ERROR
            auth_req.decline_reason = case.auth_flag_reason
            auth_req.responded_at = datetime.now(timezone.utc)
            await db.commit()
            await db.refresh(auth_req)
            return _auth_to_response(auth_req)

        # Clear any previous flag and dispatch to the right adapter
        case.auth_flag = False
        case.auth_flag_reason = None
        integration = get_adapter_for_scheme(case.medical_scheme_name)
        auth_req.scheme_name = creds.scheme_id

        result = await integration.request_authorization(
            case=case,
            claim=claim,
            claim_lines=claim_lines,
            provider=provider,
            rules=rules,
        )
    except Exception as e:
        auth_req.status = AuthRequestStatus.ERROR
        auth_req.decline_reason = str(e)
        auth_req.responded_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(auth_req)
        return _auth_to_response(auth_req)

    # Update audit record with result
    status_map = {
        "APPROVED": AuthRequestStatus.APPROVED,
        "DECLINED": AuthRequestStatus.DECLINED,
        "ERROR": AuthRequestStatus.ERROR,
        "TIMEOUT": AuthRequestStatus.TIMEOUT,
    }
    auth_req.status = status_map.get(result["status"], AuthRequestStatus.ERROR)
    auth_req.auth_number = result.get("auth_number")
    auth_req.approved_amount = result.get("approved_amount")
    auth_req.decline_reason = result.get("reason")
    auth_req.request_payload = result.get("request_payload")
    auth_req.response_payload = result.get("response_payload")
    auth_req.responded_at = datetime.now(timezone.utc)

    # Update case with authorization result
    if result["status"] == "APPROVED":
        case.preauth_number = result["auth_number"]
        case.preauth_status = PreAuthStatus.APPROVED
    elif result["status"] == "DECLINED":
        case.preauth_status = PreAuthStatus.DENIED

    await db.commit()
    await db.refresh(auth_req)
    return _auth_to_response(auth_req)


@router.get("/status/{case_id}", response_model=AuthRequestResponse)
async def get_authorization_status(
    case_id: str,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Get the latest authorization request status for a case."""
    result = await db.execute(
        select(SchemeAuthRequest)
        .where(SchemeAuthRequest.case_id == uuid.UUID(case_id))
        .order_by(SchemeAuthRequest.requested_at.desc())
        .limit(1)
    )
    auth_req = result.scalar_one_or_none()
    if not auth_req:
        raise HTTPException(status_code=404, detail="No authorization requests found for this case")
    return _auth_to_response(auth_req)


@router.get("/history/{case_id}", response_model=AuthHistoryResponse)
async def get_authorization_history(
    case_id: str,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Get the full audit trail of authorization requests for a case."""
    case_result = await db.execute(
        select(Case).where(Case.id == uuid.UUID(case_id))
    )
    case = case_result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")

    result = await db.execute(
        select(SchemeAuthRequest)
        .where(SchemeAuthRequest.case_id == case.id)
        .order_by(SchemeAuthRequest.requested_at.desc())
    )
    requests = result.scalars().all()

    return AuthHistoryResponse(
        case_id=str(case.id),
        patient_name=case.patient_name,
        scheme_name=case.medical_scheme_name,
        preauth_number=case.preauth_number,
        preauth_status=case.preauth_status.value,
        requests=[_auth_to_response(r) for r in requests],
    )


@router.post("/retry/{request_id}", response_model=AuthRequestResponse)
async def retry_authorization(
    request_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Retry a failed or timed-out authorization request."""
    result = await db.execute(
        select(SchemeAuthRequest).where(SchemeAuthRequest.id == uuid.UUID(request_id))
    )
    original = result.scalar_one_or_none()
    if not original:
        raise HTTPException(status_code=404, detail="Authorization request not found")

    if original.status not in (AuthRequestStatus.ERROR, AuthRequestStatus.TIMEOUT):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot retry a request with status '{original.status.value}'"
        )

    # Delegate to the main request endpoint
    return await request_authorization(
        case_id=str(original.case_id),
        db=db,
        current_user=current_user,
    )


# ═══════════════════════════════════════════════════════════
# AUTHORIZATION QUEUE — Cases awaiting Pre-Auth
# ═══════════════════════════════════════════════════════════

@router.get("/queue")
async def get_auth_queue(
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """
    Return all cases that need a pre-authorization number.
    Includes: no preauth_number, scheme is not cash/private/raf/wca.
    """
    from sqlalchemy import func as sa_func, or_, and_

    excluded_schemes = ["private", "cash", "account", "wca", "raf", "none", "n/a", "na"]

    # All cases where preauth is empty/null and scheme is medical (not cash/private/raf)
    result = await db.execute(
        select(Case)
        .where(
            and_(
                or_(
                    Case.preauth_number == None,
                    Case.preauth_number == "",
                ),
                Case.medical_scheme_name != None,
                Case.medical_scheme_name != "",
                sa_func.lower(Case.medical_scheme_name).notin_(excluded_schemes),
            )
        )
        .order_by(Case.created_at.desc())
    )
    cases = result.scalars().all()

    # For each case, get the latest auth request status
    queue_items = []
    for c in cases:
        # Lookup the latest auth request for this case
        auth_result = await db.execute(
            select(SchemeAuthRequest)
            .where(SchemeAuthRequest.case_id == c.id)
            .order_by(SchemeAuthRequest.requested_at.desc())
            .limit(1)
        )
        latest_auth = auth_result.scalar_one_or_none()

        queue_items.append({
            "case_id": str(c.id),
            "patient_name": c.patient_name,
            "medical_scheme": c.medical_scheme_name,
            "member_number": c.scheme_member_number,
            "preauth_status": c.preauth_status.value,
            "preauth_number": c.preauth_number,
            "auth_flag": c.auth_flag,
            "auth_flag_reason": c.auth_flag_reason,
            "created_at": c.created_at.isoformat() if c.created_at else None,
            "latest_request": {
                "id": str(latest_auth.id),
                "status": latest_auth.status.value,
                "auth_number": latest_auth.auth_number,
                "decline_reason": latest_auth.decline_reason,
                "requested_at": latest_auth.requested_at.isoformat() if latest_auth.requested_at else None,
                "responded_at": latest_auth.responded_at.isoformat() if latest_auth.responded_at else None,
            } if latest_auth else None,
        })

    return queue_items


async def auto_request_authorization(case_id: uuid.UUID, db: AsyncSession) -> dict | None:
    """
    Internal function called by the adjudication engine to automatically
    fire an authorization request when a missing preauth is detected.
    Returns the result dict or None if it can't proceed.
    """
    import logging
    logger = logging.getLogger("ems.auto_auth")

    case_result = await db.execute(select(Case).where(Case.id == case_id))
    case = case_result.scalar_one_or_none()
    if not case or not case.medical_scheme_name:
        return None

    # Don't re-request if already approved
    if case.preauth_status == PreAuthStatus.APPROVED and case.preauth_number:
        return None

    # Resolve scheme credentials from env via the rules registry
    creds = resolve_scheme_credentials(case.medical_scheme_name)
    if creds is None:
        logger.info(
            "Auto-auth skipped: No scheme credentials for '%s' "
            "(no rule module or SCHEME_<ID>_* env vars)",
            case.medical_scheme_name,
        )
        return None

    adapter = get_adapter_for_scheme(case.medical_scheme_name)

    # Load claim + lines
    from app.models.claim_line import ClaimLine
    claim_result = await db.execute(select(Claim).where(Claim.case_id == case.id).limit(1))
    claim = claim_result.scalar_one_or_none()
    claim_lines = []
    if claim:
        lines_result = await db.execute(select(ClaimLine).where(ClaimLine.claim_id == claim.id))
        claim_lines = lines_result.scalars().all()

    # Load provider
    provider = None
    if case.assigned_provider_id:
        provider_result = await db.execute(select(User).where(User.id == case.assigned_provider_id))
        provider = provider_result.scalar_one_or_none()

    # Authorization rules are hardcoded in app.rules.base now
    rules: dict = {}

    # Create audit record
    auth_req = SchemeAuthRequest(
        case_id=case.id,
        claim_id=claim.id if claim else None,
        scheme_name=creds.scheme_id,
        status=AuthRequestStatus.PENDING,
        requested_by=None,  # System-initiated
    )
    db.add(auth_req)
    await db.flush()

    try:
        result = await adapter.request_authorization(
            case=case, claim=claim, claim_lines=claim_lines,
            provider=provider, rules=rules,
        )
    except Exception as e:
        auth_req.status = AuthRequestStatus.ERROR
        auth_req.decline_reason = str(e)
        auth_req.responded_at = datetime.now(timezone.utc)
        await db.commit()
        logger.error("Auto-auth failed for case %s: %s", case_id, e)
        return {"status": "ERROR", "reason": str(e)}

    # Map result
    status_map = {
        "APPROVED": AuthRequestStatus.APPROVED,
        "DECLINED": AuthRequestStatus.DECLINED,
        "ERROR": AuthRequestStatus.ERROR,
        "TIMEOUT": AuthRequestStatus.TIMEOUT,
    }
    auth_req.status = status_map.get(result["status"], AuthRequestStatus.ERROR)
    auth_req.auth_number = result.get("auth_number")
    auth_req.approved_amount = result.get("approved_amount")
    auth_req.decline_reason = result.get("reason")
    auth_req.request_payload = result.get("request_payload")
    auth_req.response_payload = result.get("response_payload")
    auth_req.responded_at = datetime.now(timezone.utc)

    # Write back to case
    if result["status"] == "APPROVED" and result.get("auth_number"):
        case.preauth_number = result["auth_number"]
        case.preauth_status = PreAuthStatus.APPROVED
        logger.info("Auto-auth APPROVED for case %s: %s", case_id, result["auth_number"])
    elif result["status"] == "DECLINED":
        case.preauth_status = PreAuthStatus.DENIED
        logger.info("Auto-auth DECLINED for case %s", case_id)

    await db.commit()
    return result


# ═══════════════════════════════════════════════════════════
# EMAIL DRAFT — Pre-formatted auth request for manual email
# ═══════════════════════════════════════════════════════════

@router.get("/email-draft/{case_id}")
async def get_auth_email_draft(
    case_id: str,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """
    Generate a pre-formatted email body for manual auth requests
    to schemes that don't have a B2B API adapter configured.
    Returns: { to, subject, body, scheme_name, contact_email }
    """
    # Load case
    case_result = await db.execute(select(Case).where(Case.id == uuid.UUID(case_id)))
    case = case_result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")

    # Try to get latest auth request for payload
    auth_result = await db.execute(
        select(SchemeAuthRequest)
        .where(SchemeAuthRequest.case_id == case.id)
        .order_by(SchemeAuthRequest.requested_at.desc())
        .limit(1)
    )
    latest_auth = auth_result.scalar_one_or_none()
    payload = (latest_auth.request_payload or {}) if latest_auth else {}
    member = payload.get("member", {})
    clinical = payload.get("clinical", {})

    # Resolve scheme contact email from SCHEME_<ID>_CONTACT_EMAIL env var
    creds = resolve_scheme_credentials(case.medical_scheme_name)
    contact_email = getattr(creds, "contact_email", None) or ""
    scheme_display = case.medical_scheme_name or "Medical Scheme"

    subject = (
        f"Pre-Authorization Request — "
        f"{case.patient_name} — "
        f"{case.scheme_member_number or member.get('membership_number', 'N/A')}"
    )

    lines = [
        f"Dear {scheme_display} Authorizations Department,",
        "",
        "Please find below a pre-authorization request for an emergency medical services claim.",
        "",
        "═" * 60,
        "MEMBER / PATIENT DETAILS",
        "═" * 60,
        f"Medical Scheme       : {case.medical_scheme_name or member.get('scheme', 'N/A')}",
        f"Scheme Option / Plan : {member.get('scheme_option', 'N/A')}",
        f"Membership Number    : {case.scheme_member_number or member.get('membership_number', 'N/A')}",
        f"Dependant Code       : {case.dependant_code or member.get('dependant_code', '00')}",
        f"Patient Name         : {case.patient_name}",
        f"Patient ID Number    : {case.patient_id_number or member.get('patient_id', 'N/A')}",
        f"Patient Date of Birth: {member.get('patient_dob', 'N/A')}",
        "",
        "═" * 60,
        "INCIDENT & CLINICAL DETAILS",
        "═" * 60,
        f"Date of Incident     : {case.incident_date or clinical.get('incident_date', 'N/A')}",
        f"Incident Type        : {clinical.get('incident_type', 'N/A')}",
        f"Level of Care        : {clinical.get('level_of_care', 'N/A')}",
        f"Scene Address        : {case.incident_location or clinical.get('transport_from', 'N/A')}",
        f"Receiving Facility   : {clinical.get('transport_to', 'N/A')}",
        f"Transport Distance   : {clinical.get('distance_km', 'N/A')} km",
        f"Chief Complaint      : {clinical.get('chief_complaint', 'N/A')}",
        f"Primary Diagnosis    : {clinical.get('primary_diagnosis', 'N/A')}",
        f"ICD-10 Code(s)       : {clinical.get('icd10', 'N/A')}",
        f"Procedures Performed : {clinical.get('procedures', 'N/A')}",
        f"Referring Doctor PR #: {case.referring_doctor_pr or clinical.get('referring_doctor_pr', 'N/A')}",
        "",
        "═" * 60,
        "PROVIDER DETAILS",
        "═" * 60,
        f"BHF Practice Number  : {clinical.get('bhf_practice_number', 'N/A')}",
        f"HPCSA Number         : {clinical.get('hpcsa_number', 'N/A')}",
        "",
        "═" * 60,
        "CLINICAL MOTIVATION",
        "═" * 60,
        clinical.get("motivation", "Emergency medical transport was clinically necessary."),
        "",
        "Please process this authorization request urgently.",
        "Kindly respond with your authorization number to enable submission of the invoice.",
        "",
        "Kind regards,",
        "EMS Claims Administration Team",
    ]

    body_text = "\n".join(lines)

    return {
        "to": contact_email,
        "subject": subject,
        "body": body_text,
        "scheme_name": scheme_display,
        "contact_email": contact_email,
        "has_contact_email": bool(contact_email),
    }
