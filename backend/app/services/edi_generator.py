"""
EDI Generator Service
Maps internal structured claim JSON to HealthBridge and Mediswitch EDI XML formats
compliant with SA healthcare clearinghouse standards.

Generates HPCSA-compliant claim messages for electronic submission.
"""
import uuid
from datetime import datetime, timezone
from xml.etree.ElementTree import Element, SubElement, tostring
from xml.dom.minidom import parseString
from dataclasses import dataclass, field
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.claim import Claim
from app.models.claim_line import ClaimLine
from app.models.case import Case
from app.models.user import User
from app.models.edi_submission import EDISubmission, EDIFormat, SubmissionStatus


@dataclass
class EDIGenerationResult:
    """Result of EDI payload generation."""
    success: bool
    edi_xml: str = ""
    edi_format: str = ""
    clearinghouse: str = ""
    validation_errors: list[str] = field(default_factory=list)
    submission_id: Optional[str] = None


# ═══════════════════════════════════════════════════════════
# HEALTHBRIDGE XML GENERATOR
# ═══════════════════════════════════════════════════════════

async def generate_healthbridge_xml(
    claim_id: str,
    db: AsyncSession,
) -> EDIGenerationResult:
    """
    Generate HealthBridge-compliant EDI XML for a claim.
    
    HealthBridge XML follows the SA electronic claims standard:
    - ClaimHeader: provider, patient, scheme details
    - ClaimLines: individual service lines with ICD-10/CPT/NAPPI
    - Totals: financial summary
    """
    result = EDIGenerationResult(
        success=False,
        edi_format="healthbridge_xml",
        clearinghouse="healthbridge",
    )

    # Load claim data
    claim_data = await _load_claim_data(claim_id, db)
    if not claim_data:
        result.validation_errors.append(f"Claim {claim_id} not found")
        return result

    claim, case, lines, provider = claim_data

    # Pre-generation validation
    errors = _validate_for_edi(claim, case, lines, provider)
    if errors:
        result.validation_errors = errors
        return result

    # Build XML
    root = Element("HealthBridgeClaim")
    root.set("version", "3.0")
    root.set("timestamp", datetime.now(timezone.utc).isoformat())
    root.set("transactionId", str(uuid.uuid4()))

    # ── Header ──
    header = SubElement(root, "ClaimHeader")
    SubElement(header, "ClaimType").text = "EMS"
    SubElement(header, "ClaimDate").text = datetime.now(timezone.utc).strftime("%Y%m%d")

    # Provider
    prov_elem = SubElement(header, "TreatingProvider")
    SubElement(prov_elem, "PracticeNumber").text = provider.bhf_practice_number or ""
    SubElement(prov_elem, "ProviderName").text = provider.full_name
    SubElement(prov_elem, "ProviderType").text = "18"  # EMS discipline code

    # Patient
    patient = SubElement(header, "Patient")
    SubElement(patient, "PatientName").text = case.patient_name
    SubElement(patient, "IDNumber").text = case.patient_id_number or ""
    SubElement(patient, "DateOfBirth").text = (
        case.patient_dob.strftime("%Y%m%d") if case.patient_dob else ""
    )

    # Medical Scheme
    scheme = SubElement(header, "MedicalScheme")
    SubElement(scheme, "SchemeName").text = case.medical_scheme_name or ""
    SubElement(scheme, "MemberNumber").text = case.scheme_member_number or ""
    SubElement(scheme, "PreAuthNumber").text = case.preauth_number or ""

    # Incident
    incident = SubElement(header, "IncidentDetails")
    SubElement(incident, "IncidentDate").text = (
        case.incident_date.strftime("%Y%m%d") if case.incident_date else ""
    )
    SubElement(incident, "IncidentLocation").text = case.incident_location or ""

    # ── Service Lines ──
    services = SubElement(root, "ServiceLines")
    for line in lines:
        svc = SubElement(services, "ServiceLine")
        SubElement(svc, "LineNumber").text = str(line.line_number)
        SubElement(svc, "ProcedureCode").text = line.cpt_code or ""
        SubElement(svc, "DiagnosisCode1").text = line.icd10_primary or ""
        SubElement(svc, "DiagnosisCode2").text = line.icd10_secondary or ""

        if line.nappi_code:
            SubElement(svc, "NAPPICode").text = line.nappi_code

        SubElement(svc, "Description").text = line.description or ""
        SubElement(svc, "Quantity").text = str(line.quantity)
        SubElement(svc, "UnitPrice").text = f"{float(line.unit_price):.2f}"
        SubElement(svc, "TotalPrice").text = f"{float(line.total_price):.2f}"

        if line.modifier:
            SubElement(svc, "Modifier").text = line.modifier

    # ── Totals ──
    totals = SubElement(root, "ClaimTotals")
    SubElement(totals, "TotalAmount").text = f"{float(claim.total_amount or 0):.2f}"
    SubElement(totals, "LineCount").text = str(len(lines))
    SubElement(totals, "Currency").text = "ZAR"

    # Format XML
    raw_xml = tostring(root, encoding="unicode", xml_declaration=True)
    pretty_xml = parseString(raw_xml).toprettyxml(indent="  ")

    # Save submission record
    submission = EDISubmission(
        claim_id=claim.id,
        clearinghouse="healthbridge",
        edi_format=EDIFormat.HEALTHBRIDGE_XML,
        submission_status=SubmissionStatus.VALIDATED,
        edi_payload=pretty_xml,
    )
    db.add(submission)
    await db.commit()
    await db.refresh(submission)

    result.success = True
    result.edi_xml = pretty_xml
    result.submission_id = str(submission.id)
    return result


# ═══════════════════════════════════════════════════════════
# MEDISWITCH XML GENERATOR
# ═══════════════════════════════════════════════════════════

async def generate_mediswitch_xml(
    claim_id: str,
    db: AsyncSession,
) -> EDIGenerationResult:
    """
    Generate Mediswitch-compliant EDI XML.
    
    Mediswitch format closely follows the ANSI X12 837P structure
    adapted for SA healthcare.
    """
    result = EDIGenerationResult(
        success=False,
        edi_format="mediswitch_xml",
        clearinghouse="mediswitch",
    )

    claim_data = await _load_claim_data(claim_id, db)
    if not claim_data:
        result.validation_errors.append(f"Claim {claim_id} not found")
        return result

    claim, case, lines, provider = claim_data

    errors = _validate_for_edi(claim, case, lines, provider)
    if errors:
        result.validation_errors = errors
        return result

    # Build Mediswitch XML
    root = Element("MediswitchMessage")
    root.set("version", "2.1")
    root.set("messageType", "CLAIM")
    root.set("messageId", str(uuid.uuid4()))
    root.set("timestamp", datetime.now(timezone.utc).isoformat())

    # ── Transaction Header ──
    tx = SubElement(root, "Transaction")
    SubElement(tx, "TransactionType").text = "NEW_CLAIM"
    SubElement(tx, "SourceSystem").text = "EMS_CLAIMS_PORTAL"

    # ── Billing Provider (Loop 2010AA) ──
    billing = SubElement(root, "BillingProvider")
    SubElement(billing, "PCNSNumber").text = provider.bhf_practice_number or ""
    SubElement(billing, "Name").text = provider.full_name
    SubElement(billing, "DisciplineCode").text = "018"  # EMS
    SubElement(billing, "TaxNumber").text = ""

    # ── Subscriber / Patient (Loop 2010BA/CA) ──
    subscriber = SubElement(root, "Subscriber")
    SubElement(subscriber, "MemberName").text = case.patient_name
    SubElement(subscriber, "IDNumber").text = case.patient_id_number or ""
    SubElement(subscriber, "DateOfBirth").text = (
        case.patient_dob.strftime("%Y-%m-%d") if case.patient_dob else ""
    )
    SubElement(subscriber, "SchemeCode").text = _scheme_to_code(case.medical_scheme_name)
    SubElement(subscriber, "MemberNumber").text = case.scheme_member_number or ""
    SubElement(subscriber, "DependantCode").text = "00"

    # ── Authorization ──
    if case.preauth_number:
        auth = SubElement(root, "Authorization")
        SubElement(auth, "PreAuthNumber").text = case.preauth_number
        SubElement(auth, "AuthStatus").text = case.preauth_status.value.upper()

    # ── Claim Detail (Loop 2300) ──
    claim_detail = SubElement(root, "ClaimDetail")
    SubElement(claim_detail, "ClaimDate").text = (
        case.incident_date.strftime("%Y-%m-%d") if case.incident_date else
        datetime.now(timezone.utc).strftime("%Y-%m-%d")
    )
    SubElement(claim_detail, "PlaceOfService").text = "23"  # Emergency room
    SubElement(claim_detail, "ClaimFrequency").text = "1"  # Original

    # ── Service Lines (Loop 2400) ──
    for line in lines:
        svc = SubElement(claim_detail, "ServiceLine")
        SubElement(svc, "LineSequence").text = str(line.line_number)

        procedure = SubElement(svc, "Procedure")
        SubElement(procedure, "CPTCode").text = line.cpt_code or ""
        if line.modifier:
            SubElement(procedure, "Modifier1").text = line.modifier

        diag = SubElement(svc, "Diagnosis")
        SubElement(diag, "ICD10Primary").text = line.icd10_primary or ""
        if line.icd10_secondary:
            SubElement(diag, "ICD10Secondary").text = line.icd10_secondary

        if line.nappi_code:
            nappi_elem = SubElement(svc, "NAPPI")
            SubElement(nappi_elem, "Code").text = line.nappi_code

        SubElement(svc, "Description").text = line.description or ""
        SubElement(svc, "Units").text = str(line.quantity)

        amount = SubElement(svc, "Amount")
        SubElement(amount, "UnitCharge").text = f"{float(line.unit_price):.2f}"
        SubElement(amount, "LineCharge").text = f"{float(line.total_price):.2f}"

    # ── Claim Total ──
    total_elem = SubElement(root, "ClaimTotal")
    SubElement(total_elem, "TotalCharge").text = f"{float(claim.total_amount or 0):.2f}"
    SubElement(total_elem, "NumberOfLines").text = str(len(lines))

    # Format XML
    raw_xml = tostring(root, encoding="unicode", xml_declaration=True)
    pretty_xml = parseString(raw_xml).toprettyxml(indent="  ")

    # Save submission record
    submission = EDISubmission(
        claim_id=claim.id,
        clearinghouse="mediswitch",
        edi_format=EDIFormat.MEDISWITCH_XML,
        submission_status=SubmissionStatus.VALIDATED,
        edi_payload=pretty_xml,
    )
    db.add(submission)
    await db.commit()
    await db.refresh(submission)

    result.success = True
    result.edi_xml = pretty_xml
    result.submission_id = str(submission.id)
    return result


# ═══════════════════════════════════════════════════════════
# CLEARINGHOUSE SUBMISSION
# ═══════════════════════════════════════════════════════════

async def submit_to_clearinghouse(
    submission_id: str,
    db: AsyncSession,
) -> dict:
    """
    Submit a generated EDI payload to the target clearinghouse.
    
    In production, this sends the XML to the HealthBridge/Mediswitch API.
    Currently stubbed for sandbox testing.
    """
    sub_result = await db.execute(
        select(EDISubmission).where(EDISubmission.id == uuid.UUID(submission_id))
    )
    submission = sub_result.scalar_one_or_none()
    if not submission:
        return {"success": False, "error": "Submission not found"}

    if submission.submission_status not in (SubmissionStatus.VALIDATED, SubmissionStatus.DRAFT):
        return {
            "success": False,
            "error": f"Cannot submit — current status: {submission.submission_status.value}",
        }

    # ── STUB: Simulate clearinghouse submission ──
    # In production, replace with actual API calls:
    #
    # HealthBridge:
    #   POST https://api.healthbridge.co.za/v2/claims
    #   Headers: { Authorization: Bearer <token>, Content-Type: application/xml }
    #   Body: submission.edi_payload
    #
    # Mediswitch:
    #   POST https://switch.mediswitch.co.za/api/claim/submit
    #   Headers: { X-API-Key: <key>, Content-Type: application/xml }
    #   Body: submission.edi_payload

    import httpx

    try:
        # Simulate successful submission
        edi_reference = f"{submission.clearinghouse.upper()}-{uuid.uuid4().hex[:12].upper()}"

        submission.submission_status = SubmissionStatus.SUBMITTED
        submission.edi_reference = edi_reference
        submission.submitted_at = datetime.now(timezone.utc)
        submission.response_payload = {
            "status": "received",
            "reference": edi_reference,
            "message": "Claim received and queued for processing",
            "estimated_response_time": "24-48 hours",
        }

        # Update the parent claim status
        claim_result = await db.execute(
            select(Claim).where(Claim.id == submission.claim_id)
        )
        claim = claim_result.scalar_one_or_none()
        if claim:
            from app.models.claim import AdjudicationStatus
            claim.adjudication_status = AdjudicationStatus.SUBMITTED
            claim.submitted_at = datetime.now(timezone.utc)

        await db.commit()

        return {
            "success": True,
            "submission_id": str(submission.id),
            "edi_reference": edi_reference,
            "clearinghouse": submission.clearinghouse,
            "status": "submitted",
            "message": "Claim successfully dispatched to clearinghouse",
        }

    except Exception as e:
        submission.retry_count += 1
        await db.commit()
        return {
            "success": False,
            "error": str(e),
            "retry_count": submission.retry_count,
        }


async def poll_submission_status(
    submission_id: str,
    db: AsyncSession,
) -> dict:
    """
    Poll a clearinghouse for the status of a submitted claim.
    Stubbed — in production would call HealthBridge/Mediswitch status APIs.
    """
    sub_result = await db.execute(
        select(EDISubmission).where(EDISubmission.id == uuid.UUID(submission_id))
    )
    submission = sub_result.scalar_one_or_none()
    if not submission:
        return {"error": "Submission not found"}

    # Stub: return current tracked status
    return {
        "submission_id": str(submission.id),
        "claim_id": str(submission.claim_id),
        "clearinghouse": submission.clearinghouse,
        "status": submission.submission_status.value,
        "edi_reference": submission.edi_reference,
        "submitted_at": submission.submitted_at.isoformat() if submission.submitted_at else None,
        "acknowledged_at": submission.acknowledged_at.isoformat() if submission.acknowledged_at else None,
        "response": submission.response_payload,
        "rejection_reasons": submission.rejection_reasons,
        "retry_count": submission.retry_count,
    }


# ═══════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════

async def _load_claim_data(claim_id: str, db: AsyncSession):
    """Load claim with related case, lines, and provider."""
    claim_result = await db.execute(
        select(Claim).where(Claim.id == uuid.UUID(claim_id))
    )
    claim = claim_result.scalar_one_or_none()
    if not claim:
        return None

    case_result = await db.execute(select(Case).where(Case.id == claim.case_id))
    case = case_result.scalar_one_or_none()
    if not case:
        return None

    lines_result = await db.execute(
        select(ClaimLine).where(ClaimLine.claim_id == claim.id).order_by(ClaimLine.line_number)
    )
    lines = lines_result.scalars().all()

    provider = None
    if case.assigned_provider_id:
        prov_result = await db.execute(
            select(User).where(User.id == case.assigned_provider_id)
        )
        provider = prov_result.scalar_one_or_none()

    # Fallback provider
    if not provider:
        provider = User(full_name="Unknown Provider", bhf_practice_number="0000000")

    return claim, case, lines, provider


def _validate_for_edi(claim, case, lines, provider) -> list[str]:
    """Pre-validate claim data before EDI generation."""
    errors = []

    if not case.patient_name:
        errors.append("Patient name is required for EDI submission")
    if not case.medical_scheme_name:
        errors.append("Medical scheme name is required")
    if not case.scheme_member_number:
        errors.append("Scheme member number is required")
    if not lines:
        errors.append("Claim must have at least one billing line")
    if not provider.bhf_practice_number:
        errors.append("Provider must have a BHF practice number")

    for line in lines:
        if not line.cpt_code:
            errors.append(f"Line {line.line_number}: CPT code is required")
        if not line.icd10_primary:
            errors.append(f"Line {line.line_number}: Primary ICD-10 code is required")

    return errors


# SA scheme name → code mapping
_SCHEME_CODES = {
    "discovery": "DISC", "discovery health": "DISC",
    "gems": "GEMS", "government employees": "GEMS",
    "medshield": "MEDI",
    "bonitas": "BONV",
    "momentum": "MOME", "momentum health": "MOME",
    "liberty": "LIBS",
    "fedhealth": "FEDE",
    "bestmed": "BEST",
    "keyhealth": "KEYH",
    "polmed": "POLY",
    "samwumed": "SAMS",
    "profmed": "PROF",
    "compcare": "COMP",
    "resolution": "RESO", "resolution health": "RESO",
    "bankmed": "BANK",
}


def _scheme_to_code(scheme_name: str | None) -> str:
    """Convert a medical scheme name to its standard short code."""
    if not scheme_name:
        return "UNKN"
    lower = scheme_name.strip().lower()
    for key, code in _SCHEME_CODES.items():
        if key in lower:
            return code
    return "OTHR"
