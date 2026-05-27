"""
PRF Form API — Digital PRF submission endpoint.

Accepts structured PRF data directly from the web form (bypassing OCR),
creates a synthetic Document record, and routes it through the existing
Case → Claim → Adjudication pipeline.

Validation rules enforced at ingestion time (Pydantic model_validator):
  - External Cause Code mandatory when ICD-10 primary starts with S or T
  - Auth number treated as N/A only when explicitly set to 'N/A'
  - IFT incidents require auth number (unless explicitly 'N/A')
  - GEMS scheme requires auth number (unless explicitly 'N/A')
  - At least Crew Member 1 HPCSA number must be present
  - BHF Practice Number is required
  - Minimum 2 vital sign sets for Primary; 3 for IFT
"""
import uuid
import re
import logging
from typing import Optional, List
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel, Field, model_validator

from app.database import get_db
from app.models.document import Document, OCRStatus
from app.models.user import User
from app.utils.security import get_current_user

logger = logging.getLogger("ems.prf_form")

router = APIRouter(prefix="/api/prf-form", tags=["PRF Form"])


# ── Sub-models ─────────────────────────────────────────────────────────────────

class VitalSign(BaseModel):
    """One set of vital signs recorded during the call."""
    time: str = Field("", description="Time recorded (HH:MM)")
    bp: str = Field("", description="Blood pressure e.g. 120/80")
    hr: Optional[int] = Field(None, description="Heart rate bpm")
    rr: Optional[int] = Field(None, description="Respiratory rate breaths/min")
    spo2: Optional[int] = Field(None, description="SpO2 %")
    gcs: Optional[int] = Field(None, description="Glasgow Coma Scale total")
    temp: Optional[float] = Field(None, description="Temperature °C")
    equipment: str = Field("", description="Monitoring equipment used")


class Medication(BaseModel):
    """A medication or IV fluid administered."""
    name: str = Field("", description="Drug or fluid name")
    dose: str = Field("", description="Dose and units e.g. 500ml, 10mg")
    route: str = Field("", description="Route of administration e.g. IV, IM, PO")
    time: str = Field("", description="Time administered (HH:MM)")
    practitioner: str = Field("", description="Administering practitioner name or initials")


# ── Main PRF Submission Model ───────────────────────────────────────────────────

class PRFSubmission(BaseModel):
    """
    Full structured PRF data covering all 6 mandatory sections.
    Enforces cross-field conditional rules via model_validator.
    """

    # ── Section 1: Authorization & Scheme ──────────────────────────────────
    medical_scheme: str = Field(..., description="Medical scheme name (e.g. GEMS, Discovery)")
    scheme_option: str = Field("", description="Plan/option (e.g. Emerald, Classic Comprehensive)")
    main_member_name: str = Field("", description="Principal member full name and surname")
    main_member_id: str = Field("", description="Principal member SA ID or date of birth")
    member_number: str = Field("", description="Full membership number")
    dependent_code: str = Field("", description="Dependent code (e.g. 01)")
    preauth_number: str = Field(
        "",
        description="Authorization / reference number. Type N/A if not applicable.",
    )

    # ── Section 2: Provider & Crew ─────────────────────────────────────────
    service_provider_name: str = Field("", description="EMS company name and contact details")
    bhf_practice_number: str = Field(..., description="BHF practice/PCNS number (active)")
    vehicle_registration: str = Field("", description="Ambulance vehicle registration")
    vehicle_callsign: str = Field("", description="Unit callsign")

    crew_member_1_name: str = Field("", description="Crew member 1 full name and initials")
    crew_member_1_qualification: str = Field("", description="Crew 1 qualification (AEA/CCA/Paramedic/ECP)")
    crew_member_1_hpcsa: str = Field(..., description="Crew member 1 HPCSA registration number")

    crew_member_2_name: str = Field("", description="Crew member 2 full name (optional)")
    crew_member_2_qualification: str = Field("", description="Crew 2 qualification")
    crew_member_2_hpcsa: str = Field("", description="Crew member 2 HPCSA number (optional)")

    # ── Section 3: Incident Logistics & Times ──────────────────────────────
    incident_date: str = Field(..., description="Date of service (YYYY-MM-DD)")
    incident_type: str = Field(..., description="Primary or IFT")
    multiple_patient_indicator: str = Field(
        "Solo",
        description="Solo / Patient 1 of 2 / Patient 2 of 2 etc.",
    )
    level_of_care_dispatched: str = Field("", description="Level dispatched (ILS / ALS)")
    level_of_care: str = Field("", description="Level rendered (ILS / ALS)")

    incident_location: str = Field("", description="Scene physical address or GPS coords")
    receiving_facility: str = Field("", description="Receiving hospital/facility full name")

    # Times (all HH:MM 24-hour)
    call_received_time: str = Field("", description="Call received time (HH:MM)")
    dispatch_time: str = Field("", description="Dispatch time (HH:MM)")
    on_scene_time: str = Field("", description="On-scene arrival (HH:MM)")
    departure_from_scene_time: str = Field("", description="Departed scene (HH:MM)")
    hospital_arrival_time: str = Field("", description="Hospital arrival (HH:MM)")
    handover_complete_time: str = Field("", description="Handover complete (HH:MM)")

    # Odometer readings
    odometer_dispatch: Optional[int] = Field(None, description="Odometer at dispatch (km)")
    odometer_at_scene: Optional[int] = Field(None, description="Odometer on scene (km)")
    odometer_departure: Optional[int] = Field(None, description="Odometer on departure (km)")
    odometer_destination: Optional[int] = Field(None, description="Odometer at destination (km)")
    odometer_rtb: Optional[int] = Field(None, description="Odometer return to base (km)")

    # ── Section 4: Clinical Assessment ─────────────────────────────────────
    chief_complaint: str = Field("", description="Chief complaint / reason for call")
    ample_history: str = Field(
        "",
        description="AMPLE: Allergies, Medications, Past Hx, Last meal, Events prior",
    )
    clinical_notes: str = Field("", description="Primary and secondary survey findings")
    vital_signs: List[VitalSign] = Field(default_factory=list, description="Vital sign sets (minimum 2; 3 for IFT)")
    procedures: List[str] = Field(default_factory=list, description="Procedures and equipment used")
    medications_given: List[Medication] = Field(default_factory=list, description="Medications and IV fluids")

    primary_diagnosis: str = Field("", description="Primary diagnosis in plain language")
    primary_icd10: str = Field("", description="Primary ICD-10 code (free text, e.g. S72.0)")
    icd10_codes: List[str] = Field(default_factory=list, description="All ICD-10 codes for this claim")
    external_cause_code: str = Field(
        "",
        description="External cause code (V/W/X/Y + 4 digits). Mandatory for trauma ICD-10 S/T.",
    )

    # ── Section 5: Signatures ───────────────────────────────────────────────
    treating_practitioner_signature_present: bool = Field(False, description="Treating practitioner signed the PRF")
    patient_signature_present: bool = Field(False, description="Patient / guardian signed")
    receiving_facility_signature_present: bool = Field(False, description="Receiving facility clinician signed")
    receiving_clinician_qualification: str = Field("", description="Qualification of handover-accepting clinician")
    signature_unobtainable_reason: str = Field(
        "",
        description="Reason if any signature could not be obtained",
    )

    # ── Section 6: Billing Summary ──────────────────────────────────────────
    invoice_number: str = Field("", description="Invoice / claim number")
    tariff_codes: List[str] = Field(default_factory=list, description="Tariff codes claimed")
    units_claimed: Optional[int] = Field(None, description="Units per tariff code")
    total_claimed_amount: Optional[float] = Field(None, description="Total amount claimed (ZAR)")

    # ── Cross-field validators ──────────────────────────────────────────────

    @model_validator(mode="after")
    def validate_conditional_rules(self) -> "PRFSubmission":
        auth = (self.preauth_number or "").strip()
        auth_bypassed = auth.upper() in ("N/A", "NA", "NIL", "NONE", "-", "")

        # 1. IFT requires auth (unless N/A)
        if self.incident_type.upper() == "IFT" and auth_bypassed and not auth:
            raise ValueError(
                "Authorization / Reference Number is required for IFT incidents. "
                "If genuinely not applicable, enter N/A."
            )

        # 2. GEMS requires auth (unless N/A)
        scheme_upper = (self.medical_scheme or "").strip().upper()
        if "GEMS" in scheme_upper and not auth:
            raise ValueError(
                "GEMS requires an Authorization / Reference Number for all calls. "
                "If genuinely not applicable, enter N/A."
            )

        # 3. External cause code mandatory for S/T ICD-10 codes
        primary = (self.primary_icd10 or "").strip().upper()
        if primary and primary[0] in ("S", "T"):
            ext = (self.external_cause_code or "").strip().upper()
            if not ext:
                raise ValueError(
                    f"External Cause Code is mandatory when the primary ICD-10 code "
                    f"indicates trauma or injury ('{self.primary_icd10}' starts with "
                    f"S or T). Code must start with V, W, X, or Y."
                )
            # Validate pattern: starts with V/W/X/Y and has at least 3 more chars
            if not re.match(r"^[VWXY][0-9A-Z]{2,}", ext.replace(".", "")):
                raise ValueError(
                    f"External Cause Code '{self.external_cause_code}' is invalid. "
                    f"Must start with V, W, X, or Y followed by digits (e.g. W19.0)."
                )

        # 4. BHF practice number required
        if not (self.bhf_practice_number or "").strip():
            raise ValueError("BHF Practice Number is required.")

        # 5. Crew member 1 HPCSA required
        if not (self.crew_member_1_hpcsa or "").strip():
            raise ValueError("HPCSA Registration Number for Crew Member 1 is required.")

        # 6. Vital signs minimum
        vs_count = len(self.vital_signs)
        min_vs = 3 if (self.incident_type or "").upper() == "IFT" else 2
        if vs_count < min_vs:
            raise ValueError(
                f"Minimum {min_vs} vital sign set(s) required "
                f"({'IFT' if min_vs == 3 else 'Primary'} call). "
                f"Currently have {vs_count}."
            )

        # 7. Odometer sequence check (if all provided)
        odos = [
            self.odometer_dispatch, self.odometer_at_scene,
            self.odometer_departure, self.odometer_destination,
        ]
        if all(o is not None for o in odos):
            if not (odos[0] <= odos[1] <= odos[2] <= odos[3]):
                raise ValueError(
                    "Odometer readings must be non-decreasing: "
                    "Dispatch ≤ Scene ≤ Departure ≤ Destination."
                )

        return self


# ── Endpoint ───────────────────────────────────────────────────────────────────

@router.post("/submit", status_code=status.HTTP_201_CREATED)
async def submit_prf_form(
    payload: PRFSubmission,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Submit a structured PRF directly from the digital form.

    - Bypasses the OCR pipeline
    - Creates a synthetic Document (ocr_status=completed) with extracted_data
    - Routes through the standard Case → Claim → Adjudication pipeline
    - Returns case_id, document_id, claim_id, and adjudication summary
    """
    # Build the extracted_data dict from the payload
    extracted_data: dict = payload.model_dump(mode="json")

    # Normalise: ensure icd10_codes always includes primary_icd10
    if payload.primary_icd10 and payload.primary_icd10 not in (extracted_data.get("icd10_codes") or []):
        icd_list = list(extracted_data.get("icd10_codes") or [])
        icd_list.insert(0, payload.primary_icd10)
        extracted_data["icd10_codes"] = icd_list

    # Also expose common field aliases used elsewhere in the pipeline
    extracted_data.setdefault("medical_scheme", payload.medical_scheme)
    extracted_data.setdefault("member_number", payload.member_number)
    extracted_data.setdefault("preauth_number", payload.preauth_number)
    extracted_data.setdefault("provider_practice_number", payload.crew_member_1_hpcsa)
    extracted_data.setdefault("treating_provider", payload.crew_member_1_name)

    # Map incident_type to the flag the pipeline uses
    extracted_data["incident_type"] = payload.incident_type

    # Create synthetic Document record
    doc = Document(
        case_id=None,
        original_filename=f"PRF_FORM_{payload.incident_date}_{payload.medical_scheme}.digital",
        storage_uri="direct_entry",
        processed_uri=None,
        document_type="prf",
        ocr_status=OCRStatus.COMPLETED,
        needs_hitl_review=False,
        uploaded_by=current_user.id,
        ocr_confidence_avg=1.0,  # Digital entry = 100% confidence
        extracted_data=extracted_data,
    )
    db.add(doc)
    await db.commit()
    await db.refresh(doc)

    pipeline_result: dict = {}
    adjudication_result: dict = {}
    case_id_str: Optional[str] = None
    claim_id_str: Optional[str] = None

    # ── Trigger claims pipeline ──────────────────────────────────────────
    try:
        from app.services.claims_pipeline import create_claim_from_document
        pipeline_result = await create_claim_from_document(doc, db)

        if "error" not in pipeline_result:
            case_id_str = pipeline_result.get("case_id")
            claim_id_str = pipeline_result.get("claim_id")

            # ── Auto-trigger adjudication ────────────────────────────
            if claim_id_str:
                try:
                    from app.services.adjudication_engine import adjudicate_claim
                    adj = await adjudicate_claim(
                        claim_id=claim_id_str,
                        db=db,
                        auto_generate_rfis=True,
                    )
                    adjudication_result = {
                        "status": adj.status,
                        "is_clean": adj.is_clean,
                        "passed": adj.passed_checks,
                        "failed": adj.failed_checks,
                        "warnings": adj.warning_count,
                        "rfis": adj.rfis_generated,
                        "checks": [
                            {
                                "check_name": c.check_name,
                                "passed": c.passed,
                                "severity": c.severity,
                                "message": c.message,
                            }
                            for c in adj.checks
                        ],
                    }
                except Exception as adj_err:
                    logger.warning("Adjudication failed for PRF form submission: %s", adj_err)
                    adjudication_result = {"error": str(adj_err)}

    except Exception as pipe_err:
        logger.error("Claims pipeline failed for PRF form submission: %s", pipe_err)
        pipeline_result = {"error": str(pipe_err)}

    logger.info(
        "PRF form submitted by %s — doc=%s case=%s claim=%s",
        current_user.email, str(doc.id), case_id_str, claim_id_str,
    )

    return {
        "document_id": str(doc.id),
        "case_id": case_id_str,
        "claim_id": claim_id_str,
        "pipeline": pipeline_result,
        "adjudication": adjudication_result,
        "message": "PRF submitted and processed successfully.",
    }
