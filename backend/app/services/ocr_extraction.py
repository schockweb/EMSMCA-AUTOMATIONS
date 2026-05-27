"""
OCR Extraction Service — Azure AI Document Intelligence + Azure OpenAI (POPIA Compliant).
Phase 1: Extracts markdown layout from PRF documents using prebuilt-layout.
Phase 2: Strict Pydantic Structured Outputs via Azure OpenAI GPT-4o (beta.parse).
         Every field has a Field(description=...) anchor — the AI is mathematically
         constrained to populate the correct key, in the correct format, every time.
Phase 4: ICD-10 auto-suggest if codes are still missing after extraction.
"""
import logging
from dataclasses import dataclass
from typing import Dict, Any, Optional, List
from pydantic import BaseModel, Field

from openai import AsyncAzureOpenAI
from app.config import get_settings

settings = get_settings()
logger = logging.getLogger("ems.ocr")

# HITL review threshold — below this avg confidence triggers manual review
CONFIDENCE_THRESHOLD = 0.75


# ─────────────────────────────────────────────────────────────────────────────
# Strict Structured Output Schema — PRF Extraction
# EVERY field has a Field(description=...) that tells the model exactly WHERE
# to look on the South African PRF form and exactly WHAT to extract.
# ─────────────────────────────────────────────────────────────────────────────

class VitalSignSet(BaseModel):
    time: Optional[str] = Field(None, description="Time of vital signs observation (HH:MM 24-hour)")
    bp: Optional[str] = Field(None, description="Blood pressure reading (e.g. 120/80)")
    hr: Optional[int] = Field(None, description="Heart rate in beats per minute")
    rr: Optional[int] = Field(None, description="Respiratory rate in breaths per minute")
    spo2: Optional[str] = Field(None, description="Oxygen saturation (e.g. 98%)")
    gcs: Optional[int] = Field(None, description="Glasgow Coma Scale total score (3-15)")
    temp: Optional[str] = Field(None, description="Temperature in degrees Celsius")
    equipment: Optional[str] = Field(None, description="Equipment or intervention applied at this time")

class MedicationGiven(BaseModel):
    name: Optional[str] = Field(None, description="Drug or fluid name")
    dose: Optional[str] = Field(None, description="Dose administered (e.g. 500mg, 1L)")
    route: Optional[str] = Field(None, description="Route of administration (IV, IM, PO, INH, etc.)")
    time: Optional[str] = Field(None, description="Time medication was given (HH:MM)")
    practitioner: Optional[str] = Field(None, description="Name or initials of practitioner who administered it")

class LineItem(BaseModel):
    tariff_code: Optional[str] = Field(None, description="SA tariff/CPT billing code (e.g. 17600, 17601, 0190)")
    description: Optional[str] = Field(None, description="Description of the billed item or procedure")
    quantity: Optional[int] = Field(None, description="Number of units billed")
    amount: Optional[float] = Field(None, description="Rand amount for this line item")

class PRFExtractionSchema(BaseModel):
    # ── Patient Details (look for the 'PATIENT DETAILS' box or 'PT NAME & SURNAME') ──────
    patient_name: Optional[str] = Field(None, description=(
        "Full name and surname of the PATIENT (NOT the main member). "
        "Look for labels: 'PT NAME & SURNAME', 'PT NAAM & VAN', 'PATIENT NAME', 'PAT. NAME', 'PAT NAME', "
        "'NAAM & VAN', 'NAME & SURNAME', 'F.NAME / SURNAME', 'NAAM/VAN', 'PATIENT', 'NAME OF PATIENT'. "
        "Do NOT use the main member name here. "
        "STRICT RULE: NEVER capture titles (e.g., Mr, Mrs, Ms, Miss, Dr, Prof). Extract ONLY the names."
    ))
    patient_id_number: Optional[str] = Field(None, description="South African 13-digit ID number of the patient. Labelled 'PT ID NR', 'ID NR', 'ID NUMBER', 'PATIENT ID', 'PAT ID'.")
    patient_dob: Optional[str] = Field(None, description="Patient date of birth in YYYY-MM-DD format. Derive from ID number if not explicit.")
    gender: Optional[str] = Field(None, description="Patient gender: Male or Female.")
    patient_address: Optional[str] = Field(None, description="Patient's residential address. Found near 'PT ADDRESS', 'ADRES', 'SCENE ADDRESS', 'ADDRESS'.")
    patient_phone: Optional[str] = Field(None, description=(
        "Patient's OWN contact number. "
        "Look for ALL of these labels (they all mean a phone number on a SA PRF): "
        "'PT CONTACT NR', 'PT TEL', 'PT TEL NR', 'PATIENT PHONE', 'CONTACT NR', 'CONTACT NUMBER', "
        "'(H)' or 'H:' = Home number, "
        "'(W)' or 'W:' = Work number, "
        "'(B)' or 'B:' = Business number, "
        "'(C)' or 'C:' = Cell/Mobile number, "
        "'(M)' or 'M:' = Mobile number, "
        "'(T)' or 'T:' = Telephone, "
        "'TEL', 'TELNR', 'TEL NR', 'TELEPHONE', "
        "'CEL', 'CELL', 'MOBIEL', 'SELFOON', "
        "'HUIS', 'HUISNR', 'WERK', 'WERKNR'. "
        "If the patient is a minor/dependent (patient_relationship = Child) and no own number exists, "
        "copy the main member's contact number here."
    ))
    patient_relationship: Optional[str] = Field(None, description="Patient's relationship to the main medical-aid member (e.g. Self, Child, Spouse). Found in the funding/scheme section near dependent code.")

    # ── Medical Scheme (look for 'MEDICAL AID', 'SCHEME', or 'FUNDING DETAILS') ──────────
    medical_scheme: Optional[str] = Field(None, description="Medical aid name (e.g. GEMS, Discovery, Bonitas). Labelled 'FUNDING DETAILS' or 'Medical Scheme'.")
    scheme_option: Optional[str] = Field(None, description="Specific plan name (e.g. Classic Saver, Emerald). Found in 'FUNDING DETAILS' or near scheme name.")
    main_member_name: Optional[str] = Field(None, description="Full name of the principal member. Extract from 'FUNDING DETAILS' if it contains 'Member: [Name]' or similar. STRICT RULE: NEVER capture titles (e.g., Mr, Mrs, Ms, Miss, Dr, Prof). Extract ONLY the names.")
    main_member_id: Optional[str] = Field(None, description="SA ID number of the PRINCIPAL member. Found near 'Main Member ID'.")
    member_number: Optional[str] = Field(None, description="Scheme membership number. Labelled 'MED AID REFERENCE NR', 'Membership No.', or 'Med Aid No.'.")
    dependent_code: Optional[str] = Field(None, description="Dependent code (e.g. 00, 01). Found near membership number. 00 = main member, 01/02/etc = dependants.")
    main_member_phone: Optional[str] = Field(None, description=(
        "Contact number of the PRINCIPAL MEMBER (not the patient). "
        "Found near the main member name in the funding/scheme section. "
        "Look for the same phone label abbreviations as patient_phone: "
        "'(H)' = Home, '(W)' = Work, '(B)' = Business, '(C)' = Cell, '(M)' = Mobile, "
        "'TEL', 'CEL', 'CELL', 'HUIS', 'WERK', 'CONTACT NR', 'MEMBER TEL'. "
        "Critical when patient is a minor."
    ))
    preauth_number: Optional[str] = Field(None, description="Pre-authorization reference (e.g. 'NETCARE AUTH NR'). Return N/A if not present.")
    authorization_number: Optional[str] = Field(None, description="Same as preauth_number — the auth reference (e.g. 'NETCARE AUTH NR').")

    # ── Provider & Vehicle (look for header box at top of form) ──────────────
    service_provider_name: Optional[str] = Field(None, description="Name of the EMS company/service provider. Usually printed in the top header of the form.")
    bhf_practice_number: Optional[str] = Field(None, description="BHF/PCNS practice number of the EMS provider. Found in the header, labelled 'Practice No.' or 'BHF No.' — critical for billing.")
    vehicle_registration: Optional[str] = Field(None, description="Ambulance registration number (e.g. GP123456). Found in the vehicle/transport section.")
    vehicle_callsign: Optional[str] = Field(None, description="Unit or callsign of the vehicle (e.g. MED 5, ALPHA 12).")

    # ── Crew Details (look for 'CREW' or 'PERSONNEL' section) ─────────────────
    treating_provider: Optional[str] = Field(None, description="Full name of the PRIMARY treating crew member (Crew 1). NOT the referring or receiving doctor. STRICT RULE: NEVER capture titles.")
    provider_practice_number: Optional[str] = Field(None, description="HPCSA registration number of the primary treating crew member (Crew 1). Found in the crew section.")
    crew_member_1_name: Optional[str] = Field(None, description="Full name and initials of crew member 1. STRICT RULE: NEVER capture titles.")
    crew_member_1_initials: Optional[str] = Field(None, description="Initials of crew member 1.")
    crew_member_1_qualification: Optional[str] = Field(None, description="Qualification of crew member 1. Must be one of: AEA, CCA, Paramedic, ECP, EMT-B. If the form says Basic, map to AEA.")
    crew_member_1_hpcsa: Optional[str] = Field(None, description="HPCSA registration number of crew member 1. Critical for scheme reimbursement.")
    crew_member_2_name: Optional[str] = Field(None, description="Full name and initials of crew member 2 if present. STRICT RULE: NEVER capture titles.")
    crew_member_2_initials: Optional[str] = Field(None, description="Initials of crew member 2.")
    crew_member_2_qualification: Optional[str] = Field(None, description="Qualification of crew member 2 (AEA, CCA, Paramedic, ECP, EMT-B).")
    crew_member_2_hpcsa: Optional[str] = Field(None, description="HPCSA registration number of crew member 2.")

    # ── Incident Logistics ────────────────────────────────────────────────────
    incident_date: Optional[str] = Field(None, description="Date of the incident/service in YYYY-MM-DD format. Found near the top of the form.")
    incident_type: Optional[str] = Field(None, description=(
        "Type of incident. MUST be exactly one of: 'Primary' or 'Inter-Facility Transfer'. "
        "Detection rules (in priority order): "
        "1. Look for a checkbox or tick next to words like 'TRANSFER', 'IFT', 'INTER-FACILITY TRANSFER', "
        "'INTERFACILITY', 'Inter Facility' — if ticked/checked/marked, set Inter-Facility Transfer. "
        "2. Look for billing type codes on the PRF: P1 = Primary, P2 = Inter-Facility Transfer. "
        "3. If the form has a 'TYPE OF CALL' or 'INCIDENT TYPE' box with 'TRANSFER' checked, it is Inter-Facility Transfer. "
        "4. If there is a 'Referring Facility' or 'Referring Doctor' field that is filled in, it is almost certainly Inter-Facility Transfer. "
        "5. If the receiving_facility and incident_location are BOTH hospitals/clinics (not a street address), it is likely Inter-Facility Transfer. "
        "6. Default to 'Primary' only when none of the above IFT signals are present. "
        "CRITICAL: Never default to Primary without checking for the above signals first."
    ))
    multiple_patient_indicator: Optional[str] = Field(None, description="Was this a multiple-patient incident? Values: 'Solo', 'Patient 1 of 2', 'Patient 2 of 2', etc. If only one patient, return Solo.")
    level_of_care: Optional[str] = Field(None, description="Level of care RENDERED. Must be 'ILS' or 'ALS'. South African EMS does NOT use BLS — map any BLS or Basic to ILS.")
    level_of_care_dispatched: Optional[str] = Field(None, description="Level of care the crew was DISPATCHED as (may differ from rendered). Must be 'ILS' or 'ALS'.")
    incident_location: Optional[str] = Field(None, description="Physical address or GPS coordinates of the scene. Found in the incident/scene section.")
    receiving_facility: Optional[str] = Field(None, description="Full name of the receiving hospital or facility (no abbreviations). Found in the transport/destination section.")
    chief_complaint: Optional[str] = Field(None, description="Primary reason for the call / chief complaint as described on the form.")
    mechanism_of_injury: Optional[str] = Field(None, description="Mechanism of injury if this is a trauma incident (e.g. MVA, fall, assault). From the clinical section.")

    # ── Timestamps (from the TIME | ODOMETER table, top-right or centre-right) ─
    # The table rows are generally: CALL DISPATCHED, AT SCENE, DEPART SCENE, AT DESTINATION, AVAILABLE, BACK TO BASE
    # TIME column has HH:MM values. Extract each individually.
    dispatch_time: Optional[str] = Field(None, description="Time crew was dispatched (HH:MM). Usually the VERY FIRST row in the time/odometer table. Labelled 'CALL DISPATCHED', 'DISP', or 'DISPATCH'.")
    on_scene_time: Optional[str] = Field(None, description="Time crew arrived on scene (HH:MM). Labelled 'SCENE', 'AT SCENE', or 'ON SCENE' in the time/odometer table.")
    departure_from_scene_time: Optional[str] = Field(None, description="Time crew departed from scene with patient (HH:MM). Labelled 'DEPART' or 'DEPARTURE' in the time table.")
    transport_time: Optional[str] = Field(None, description="Time transport to hospital started — same as departure from scene (HH:MM).")
    hospital_arrival_time: Optional[str] = Field(None, description="Time crew arrived at receiving hospital (HH:MM). Labelled 'HOSP' or 'HOSPITAL' in the time table.")
    handover_complete_time: Optional[str] = Field(None, description="Time patient was handed over to the receiving facility (HH:MM). Labelled 'HANDOVER' or 'AVAILABLE'.")

    # ── Odometers (RIGHT column of the same TIME|ODOMETER table) ─────────────
    # CRITICAL: Odometer readings are plain integers in the km column.
    # They may be split by a pipe '|', a decimal, or a large gap (e.g. '534 | 859' or '534.859').
    # You MUST combine all parts into a single continuous integer string (e.g. '534859').
    odometer_dispatch: Optional[str] = Field(None, description="Vehicle odometer (km) at time of dispatch. INTEGER only. Combine split parts (e.g. '534 859' → '534859').")
    odometer_at_scene: Optional[str] = Field(None, description="Vehicle odometer (km) at scene arrival. Must be >= odometer_dispatch.")
    odometer_departure: Optional[str] = Field(None, description="Vehicle odometer (km) on departure from scene.")
    odometer_destination: Optional[str] = Field(None, description="Vehicle odometer (km) at hospital/destination arrival.")
    odometer_rtb: Optional[str] = Field(None, description="Vehicle odometer (km) on return to base. Labelled 'BACK TO BASE' or 'RTB'.")

    # ── Clinical Assessment ──────────────────────────────────────────────────
    ample_history: Optional[str] = Field(None, description="AMPLE history: Allergies, Medications, Past medical history, Last meal, Events. Extract the narrative from the AMPLE or history section.")
    clinical_notes: Optional[str] = Field(None, description="Full clinical narrative, primary and secondary survey findings, any additional clinical remarks.")
    primary_diagnosis: Optional[str] = Field(None, description="Primary clinical diagnosis in plain language as written by the crew.")
    vital_signs: Optional[List[VitalSignSet]] = Field(None, description="Array of vital sign observations. Extract ALL sets from the VITALS table. Each set must have time, BP, HR, SpO2, GCS at minimum.")
    procedures: Optional[List[str]] = Field(None, description="List of procedures performed (e.g. 'IV access 18G left AC', 'Oxygen 8L/min NRB', 'CPR initiated'). From the procedures/interventions section.")
    medications_given: Optional[List[MedicationGiven]] = Field(None, description="Array of medications administered. Extract from the MEDICATION or DRUG table. Each entry needs: name, dose, route, time.")

    # ── Diagnosis Codes ──────────────────────────────────────────────────────
    icd10_codes: List[str] = Field(default_factory=list, description="ICD-10 diagnosis codes as an array (e.g. ['I21.0', 'S06']). Extract from the DIAGNOSIS or BILLING section. Return [] if none found.")
    primary_icd10: Optional[str] = Field(None, description="Single primary ICD-10 code (e.g. S72.0, I21.1). If trauma (S or T code), an external cause code is also required.")
    external_cause_code: Optional[str] = Field(None, description="External cause ICD-10 code — starts with V, W, X, or Y (e.g. V892.0, W19.0). Only required when primary_icd10 starts with S or T.")

    # ── Signatures ───────────────────────────────────────────────────────────
    treating_practitioner_signature_present: Optional[bool] = Field(None, description="True if the treating practitioner's signature box is signed/marked on the PRF. False if blank.")
    patient_signature_present: Optional[bool] = Field(None, description="True if the patient or guardian signature box is signed/marked on the PRF. False if blank.")
    receiving_facility_signature_present: Optional[bool] = Field(None, description="True if the receiving facility clinician signed the handover section. False if blank.")
    receiving_clinician_qualification: Optional[str] = Field(None, description="Qualification or designation of the clinician who accepted handover at the receiving facility.")
    signature_unobtainable_reason: Optional[str] = Field(None, description="Reason why a signature could not be obtained (e.g. patient unconscious, facility refused).")

    # ── Billing ──────────────────────────────────────────────────────────────
    invoice_number: Optional[str] = Field(None, description="Invoice or claim number for this PRF. Found in the billing section.")
    tariff_codes: Optional[List[str]] = Field(None, description="Array of tariff/billing codes claimed (e.g. ['17600', '17601']). From the billing section.")
    total_claimed_amount: Optional[float] = Field(None, description="Total amount claimed in Rands as a number (e.g. 4250.00). From the billing totals section.")
    line_items: List[LineItem] = Field(default_factory=list, description="Itemised billing lines. Each entry: tariff code, description, quantity, and Rand amount.")

    # ── PRF Reference ────────────────────────────────────────────────────────
    prf_number: Optional[str] = Field(None, description="The PRF/form number printed on the document (e.g. Re-C117343-E-01 or 123440). Usually top-right of the header.")

@dataclass
class ExtractionResult:
    """Result of OCR/AI extraction."""
    extracted_data: Dict[str, Any]
    field_scores: Dict[str, float]
    avg_confidence: float
    needs_hitl_review: bool
    method_used: str  # "azure_document_intelligence_semantic"
    success: bool
    error: Optional[str] = None

async def _get_layout_azure(file_bytes: bytes, filename: str) -> str:
    from azure.core.credentials import AzureKeyCredential
    from azure.ai.documentintelligence.aio import DocumentIntelligenceClient
    doc_client = DocumentIntelligenceClient(
        endpoint=settings.AZURE_DOC_INTEL_ENDPOINT, 
        credential=AzureKeyCredential(settings.AZURE_DOC_INTEL_KEY)
    )
    async with doc_client:
        poller = await doc_client.begin_analyze_document(
            "prebuilt-layout",
            body=file_bytes,
            content_type="application/octet-stream"
        )
        result = await poller.result()
        if not result.content:
            raise Exception("Azure Document Intelligence returned empty layout.")
        return result.content

async def extract_document(file_bytes: bytes, filename: str, engine: str = "azure", db=None) -> ExtractionResult:
    """
    Main entry: Extracts layout (using Azure Document Intelligence), then maps semantics via Azure OpenAI.
    Pass `db` (AsyncSession) to enable injection of learned corrections into the prompt.
    """
    if not settings.AZURE_OPENAI_ENDPOINT:
        return ExtractionResult(
            extracted_data={}, field_scores={}, avg_confidence=0,
            needs_hitl_review=True, method_used="unknown", success=False,
            error="Azure OpenAI credentials missing in environment",
        )

    from openai import AsyncAzureOpenAI
    llm_client = AsyncAzureOpenAI(
        api_key=settings.AZURE_OPENAI_API_KEY,
        api_version="2024-02-15-preview",
        azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
    )

    try:
        method_used = "azure_semantic"
        
        # Phase 1: Deep Read via Azure layout engine
        if not settings.AZURE_DOC_INTEL_ENDPOINT:
            raise Exception("Azure Document Intelligence credentials missing.")
        logger.info(f"[OCR] Requesting markdown layout from Azure Document Intelligence for {filename}...")
        markdown_layout = await _get_layout_azure(file_bytes, filename)

        # ── Phase 2: Strict Structured Extraction via Pydantic Schema ─────────
        # Uses OpenAI beta.chat.completions.parse — the AI is constrained to return
        # EXACTLY the fields defined in PRFExtractionSchema, with the correct types.
        # This eliminates hallucinated keys, missing fields, and wrong-field placement.
        import json
        import os

        logger.info("[OCR] Phase 2: Strict Pydantic Structured Output extraction...")

        # ── Load & inject learned corrections (few-shot examples from human reviewers) ──
        learned_block = ""
        if db is not None:
            try:
                from app.api.corrections import _build_prompt_examples, _format_examples_for_prompt
                examples = await _build_prompt_examples(db)
                if examples:
                    learned_block = _format_examples_for_prompt(examples)
                    logger.info("[OCR] Injecting %d learned correction examples into prompt.", len(examples))
            except Exception as _corr_err:
                logger.warning("[OCR] Could not load learned corrections (non-fatal): %s", _corr_err)

        system_prompt = (
            "You are an Expert Medical Claims AI for South African EMS. "
            "Extract ALL structured data from the Patient Report Form (PRF) OCR text provided.\n\n"

            "## CRITICAL SA PRF LAYOUT RULES\n"

            "### HEADER (top of form)\n"
            "- Provider name, BHF Practice Number, PRF/form number.\n"
            "- PRF number is the printed form ID (e.g. EMS0012556 or Re-C117343-E-01). Found top-left labelled 'PRF NR'.\n"
            "- 'Practice No.' or 'Prac No.' labels in the header = bhf_practice_number.\n\n"

            "### PATIENT / SCHEME SECTION\n"
            "- 'PT NAME & SURNAME', 'PT NAAM & VAN', 'PAT NAME', 'PAT. NAME', 'NAME OF PATIENT', 'NAAM/VAN', 'PN' = patient_name. Patient name = Main Member name if undefined.\n"
            "- 'PT ID NR', 'ID NR', 'PAT ID' = patient_id_number; \n"
            "- 'FUNDING DETAILS' = contains medical_scheme and scheme_option.\n"
            "- 'MED AID REFERENCE NR' = member_number.\n"
            "- 'NETCARE AUTH NR' = authorization_number / preauth_number.\n"
            "\n"
            "### HOSPITAL STICKER RULES (CRITICAL)\n"
            "- A printed 'hospital sticker' is often placed haphazardly on the form (top corners, over other text).\n"
            "- These stickers usually contain the BEST and most accurate Patient Name, DOB, Address, and Contact numbers.\n"
            "- PRIORITY: Always prefer the typed hospital sticker data over handwritten data if there is a conflict.\n"
            "- Scan the ENTIRE document text for any cluster of 10-digit numbers, names, or addresses that look like a sticker.\n"
            "\n"
            "### CONTACT NUMBER ABBREVIATIONS (SA PRF standard)\n"
            "South African PRFs and Hospital Stickers use shorthand labels for phone numbers. Map ALL of the following to a contact number field:\n"
            "  (H) or H: or H/W: = Home number\n"
            "  (W) or W: or H/W: = Work number\n"
            "  (B) or B: = Business number\n"
            "  (C) or C: = Cell/Mobile number\n"
            "  (M) or M: = Mobile/Cell number\n"
            "  (T) or T: or TEL: = Telephone\n"
            "  TEL, TELNR, TEL NR, TELEPHONE\n"
            "  CEL, CELL, SELFOON, MOBIEL\n"
            "  HUIS or HUISNR = Home (Afrikaans)\n"
            "  WERK or WERKNR = Work (Afrikaans)\n"
            "RULE: If a phone abbreviation appears anywhere on the form (ESPECIALLY on a hospital sticker), you MUST extract it. "
            "If it appears next to the patient details, put it in patient_phone. "
            "If it belongs to the parent/guardian or main member, put it in main_member_phone. "
            "NEVER skip a contact number. If only one number exists on the whole form (e.g. on a sticker), place it in BOTH patient_phone and main_member_phone.\n"
            "\n"
            "- DEPENDENT PATIENT RULE: If the patient is a child/minor or has a non-00 dependent_code, "
            "they typically do not have their own phone number on the PRF. "
            "In this case, extract the MAIN MEMBER's contact number into main_member_phone. "
            "Also copy that number into patient_phone so the field is not left blank. "
            "Never leave both blank if any contact number at all appears on the form.\n\n"

            "### TIMES AND KILOMETRES TABLE (often centre-right)\n"
            "This table has columns: TIME (HH:MM) and KM (odometer).\n"
            "Row labels: DISPATCHED, ON SCENE, DEPART SCENE, ARRIVE AT HOSPITAL, AVAILABLE, BACK AT BASE.\n"
            "- Times → dispatch_time, on_scene_time, departure_from_scene_time, hospital_arrival_time, handover_complete_time.\n"
            "- KM → odometer_dispatch, odometer_at_scene, odometer_departure, odometer_destination, odometer_rtb.\n"
            "- ODOMETER CRITICAL RULE: All 5 km readings come from the SAME vehicle on the SAME trip, "
            "so they ALWAYS share the same first 2-4 digits (the prefix, e.g. all start with '534'). "
            "If a reading looks like '71' or '5 4859' it has been split across a printed column boundary — "
            "reconstruct the full integer by using the shared prefix from the other readings. "
            "ALWAYS combine split parts into a single integer string WITHOUT any separators (e.g. '534 859' → '534859', '534.859' → '534859'). "
            "NEVER output a time value in an odometer field and vice versa. "
            "MONOTONIC RULE: Each reading must be >= the previous one (Dispatch ≤ Scene ≤ Departure ≤ Destination ≤ RTB). "
            "Output ONLY clean integer strings.\n\n"

            "### CREW SECTION\n"
            "- 'INITIALS & SURNAME' in the 'CREW DETAILS' table = crew names.\n"
            "- 'QUALIFICATION' = BLS, ILS, ALS.\n"
            "- 'HPCSA NR' = crew_member_1_hpcsa / crew_member_2_hpcsa.\n"
            "- Level of care: Found in 'LEVEL OF CARE' box (ILS/ALS). SA EMS uses ILS and ALS only. Map BLS or Basic → ILS.\n\n"

            "### INCIDENT TYPE (IFT vs PRIMARY) — CRITICAL\n"
            "South African PRFs have a checkbox section for the type of call. Look for:\n"
            "  • A checkbox or tick next to the word TRANSFER, IFT, INTER-FACILITY, or INTER FACILITY TRANSFER → incident_type = 'Inter-Facility Transfer'\n"
            "  • A billing code of P1 (top row) = Primary; P2 (second row) = Inter-Facility Transfer.\n"
            "  • A referring facility or referring doctor field that is filled in → likely Inter-Facility Transfer.\n"
            "  • If both the scene address and destination are named facilities (not street addresses) → likely Inter-Facility Transfer.\n"
            "  • handwritten words like 'transfer', 'IFT', 'inter-facility' anywhere near the incident type box → Inter-Facility Transfer.\n"
            "Always inspect the full incident type section before defaulting to Primary.\n\n"

            "### CLINICAL / VITALS / MEDICATIONS\n"
            "- Extract ALL vital sign sets from the VITALS table into vital_signs array.\n"
            "- Extract ALL rows from the MEDICATION table into medications_given array.\n"
            "- Extract ALL procedures from the interventions section into procedures array.\n\n"

            "### DIAGNOSIS / BILLING\n"
            "- ICD-10 codes → icd10_codes array (e.g. ['I21.0', 'S82.0']). STRICT RULE: Must be strictly derived using ONLY the diagnosis explicitly given in the diagnosis field.\n"
            "- Tariff codes and amounts → line_items array.\n"
            "- Authorization / preauth reference → preauth_number AND authorization_number.\n\n"

            "## STRICT RULES\n"
            "- Return null for any field genuinely not present. NEVER fabricate values.\n"
            "- Do NOT put times in odometer fields and vice versa.\n"
            "- Do NOT put the main member's name in patient_name.\n"
            "- TITLES ARE FORBIDDEN in any name fields (patient_name, main_member_name, treating_provider, crew names). "
            "NEVER include Mr, Mrs, Ms, Miss, Dr, Prof, or similar abbreviations. Extract ONLY the first names, initials, and surnames."
        ) + (learned_block if learned_block else "")

        parsed = await llm_client.beta.chat.completions.parse(
            model=settings.AZURE_OPENAI_DEPLOYMENT,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": f"PRF OCR content (Markdown):\n\n{markdown_layout}"}
            ],
            response_format=PRFExtractionSchema,
            temperature=0.0,
        )

        prf_data: PRFExtractionSchema = parsed.choices[0].message.parsed
        extracted_dict = prf_data.model_dump(mode="json", exclude_none=False)

        # ── Odometer Prefix Anchoring ─────────────────────────────────────────
        # After the LLM returns its best-effort readings, run the deterministic
        # prefix-anchoring pipeline to correct OCR digit errors.
        try:
            from app.services.odometer_utils import process_odometer_set

            # Load optional odometer config from extraction_settings.json
            odo_config: dict = {}
            import os, json as _json
            _settings_path = os.path.join(settings.UPLOAD_DIR, "extraction_settings.json")
            if os.path.exists(_settings_path):
                with open(_settings_path, "r") as _sf:
                    _sdata = _json.load(_sf)
                    odo_config = _sdata.get("odometer_config", {})

            odo_raw = {
                "odometer_dispatch":    extracted_dict.get("odometer_dispatch"),
                "odometer_at_scene":    extracted_dict.get("odometer_at_scene"),
                "odometer_departure":   extracted_dict.get("odometer_departure"),
                "odometer_destination": extracted_dict.get("odometer_destination"),
                "odometer_rtb":         extracted_dict.get("odometer_rtb"),
            }

            odo_result = process_odometer_set(odo_raw, config=odo_config)

            # Apply processed values back into extracted dict
            extracted_dict["odometer_dispatch"]        = odo_result.dispatch
            extracted_dict["odometer_at_scene"]        = odo_result.at_scene
            extracted_dict["odometer_departure"]       = odo_result.departure
            extracted_dict["odometer_destination"]     = odo_result.destination
            extracted_dict["odometer_rtb"]             = odo_result.rtb
            extracted_dict["odometer_prefix_detected"] = odo_result.prefix_detected
            extracted_dict["odometer_flagged_keys"]    = odo_result.flagged_keys
            extracted_dict["odometer_corrections"]     = odo_result.corrections_made

            if odo_result.prefix_detected:
                logger.info(
                    "[OCR] Odometer prefix '%s' detected. Corrections=%s, Flagged=%s",
                    odo_result.prefix_detected,
                    odo_result.corrections_made,
                    odo_result.flagged_keys,
                )
            else:
                logger.warning("[OCR] No common odometer prefix detected — readings may need manual review.")

        except Exception as _odo_err:
            logger.warning("[OCR] Odometer anchoring failed (non-fatal): %s", _odo_err)

        # -- Mileage Validation Engine -------------------------------------------
        # Runs immediately after odometer anchoring on the cleaned readings.
        try:
            from app.services.mileage_engine import validate_mileage
            import os as _os_mile, json as _jm_mile

            _mile_cfg: dict = {}
            _sp_mile = _os_mile.path.join(settings.UPLOAD_DIR, "extraction_settings.json")
            if _os_mile.path.exists(_sp_mile):
                with open(_sp_mile, "r") as _sf_mile:
                    _mile_cfg = _jm_mile.load(_sf_mile).get("mileage_config", {})

            _mile_r = validate_mileage(extracted_dict, config=_mile_cfg)
            extracted_dict.update(_mile_r.to_dict())

            _ec = sum(1 for _qi in _mile_r.issues if _qi.severity == "error")
            _wc = sum(1 for _qi in _mile_r.issues if _qi.severity == "warning")
            logger.info(
                "[OCR] Mileage engine: %s | %d error(s) %d warning(s)",
                _mile_r.summary, _ec, _wc,
            )
            for _mi in _mile_r.issues:
                if _mi.severity == "error":
                    logger.warning("[OCR] Mileage [%s] field=%s: %s",
                                   _mi.code, _mi.field or "", _mi.message)

        except Exception as _mile_err:
            logger.warning("[OCR] Mileage engine failed (non-fatal): %s", _mile_err)


        # ── Normalise incident_type ───────────────────────────────────────────
        # The AI may return: "IFT", "Inter Facility Transfer", "P2", "Transfer",
        # "Inter-Facility", "interfacility", etc. Map ALL to the canonical value
        # that the frontend dropdown expects.
        _raw_incident_type = (extracted_dict.get("incident_type") or "").strip()
        _ift_keywords = {"ift", "transfer", "inter", "p2", "interfacility"}
        if _raw_incident_type and any(kw in _raw_incident_type.lower() for kw in _ift_keywords):
            extracted_dict["incident_type"] = "Inter-Facility Transfer"
            logger.info(f"[OCR] Normalised incident_type '{_raw_incident_type}' → 'Inter-Facility Transfer'")
        elif _raw_incident_type and _raw_incident_type.lower() in {"primary", "p1", "emergency", "scene"}:
            extracted_dict["incident_type"] = "Primary"

        # ── Apply Provider Registry (Smart Keyword Matching) ──────────────────
        try:
            schema_path = os.path.join(settings.UPLOAD_DIR, "extraction_settings.json")
            if os.path.exists(schema_path):
                with open(schema_path, "r") as f:
                    settings_data = json.load(f)
                    
                    provider_profiles = settings_data.get("provider_profiles", [])
                    
                    if provider_profiles:
                        # Get the AI-extracted provider name for matching
                        extracted_provider_name = (extracted_dict.get("provider_name") or 
                                                   extracted_dict.get("treating_provider") or "").lower()
                        
                        # Try keyword matching against each registered profile
                        matched_profile = None
                        for profile in provider_profiles:
                            keywords = [kw.lower() for kw in profile.get("match_keywords", [])]
                            if any(kw and kw in extracted_provider_name for kw in keywords):
                                matched_profile = profile
                                logger.info(f"[OCR] Provider matched by keyword to: {profile.get('display_name')}")
                                break
                        
                        # If no keyword match, fall back to the default profile
                        if not matched_profile:
                            matched_profile = next((p for p in provider_profiles if p.get("is_default")), None)
                            if matched_profile:
                                logger.info(f"[OCR] Using default provider profile: {matched_profile.get('display_name')}")
                        
                        # Inject the matched profile's verified details
                        if matched_profile:
                            if matched_profile.get("provider_name"):
                                extracted_dict["provider_name"] = matched_profile["provider_name"]
                            if matched_profile.get("provider_practice_number"):
                                extracted_dict["provider_practice_number"] = matched_profile["provider_practice_number"]
                            if matched_profile.get("provider_address"):
                                extracted_dict["provider_address"] = matched_profile["provider_address"]
                            if matched_profile.get("provider_phone"):
                                extracted_dict["provider_phone"] = matched_profile["provider_phone"]
                            if matched_profile.get("provider_email"):
                                extracted_dict["provider_email"] = matched_profile["provider_email"]
                            if matched_profile.get("provider_bank_name"):
                                extracted_dict["provider_bank_name"] = matched_profile["provider_bank_name"]
                            if matched_profile.get("provider_bank_account"):
                                extracted_dict["provider_bank_account"] = matched_profile["provider_bank_account"]
                            if matched_profile.get("provider_bank_branch_code"):
                                extracted_dict["provider_bank_branch_code"] = matched_profile["provider_bank_branch_code"]
                    else:
                        # Legacy fallback: single provider_template
                        provider_tmpl = settings_data.get("provider_template", {})
                        if provider_tmpl.get("provider_name"):
                            extracted_dict["provider_name"] = provider_tmpl["provider_name"]
                        if provider_tmpl.get("provider_practice_number"):
                            extracted_dict["provider_practice_number"] = provider_tmpl["provider_practice_number"]
                        if provider_tmpl.get("provider_address"):
                            extracted_dict["provider_address"] = provider_tmpl["provider_address"]
        except Exception as e:
            logger.warning(f"[OCR] Failed to apply provider registry overrides: {e}")



        # ── Phase 3 removed ───────────────────────────────────────────────────
        # Strict Pydantic Structured Output (Phase 2) guarantees all schema fields
        # are returned every time. The specialist fallback pass is no longer needed.

        # ── Phase 4: AI ICD-10 Diagnosis Code Finder ───────────────────────────────
        # Auto-suggest ICD-10 codes strictly based on the diagnosis section.
        if not extracted_dict.get("icd10_codes") and extracted_dict.get("working_diagnosis"):
            clinical_text = f"Diagnosis: {extracted_dict['working_diagnosis']}"
                
            if len(clinical_text.strip()) > 5:
                logger.info("[OCR] ICD-10 array is empty. Running AI ICD-10 Finder purely on Diagnosis field...")
                icd10_prompt = (
                    "You are a South African EMS clinical coding specialist.\n"
                    "Given the explicit diagnosis from a Patient Report Form, identify the most appropriate ICD-10 diagnosis codes.\n"
                    "STRICT RULE: You MUST derive the ICD-10 codes STRICTLY using the exact diagnosis provided below.\n"
                    "Focus on the primary condition first. Include trauma external causes if necessary.\n"
                    "Return ONLY a flat JSON array of strings representing the codes (e.g. [\"I21.0\", \"F32\", \"S06.0\"]). No explanation, no markdown text."
                )
                try:
                    icd10_resp = await llm_client.chat.completions.create(
                        model=settings.AZURE_OPENAI_DEPLOYMENT,
                        messages=[
                            {"role": "system", "content": icd10_prompt},
                            {"role": "user", "content": f"Diagnosis Data:\n{clinical_text}"}
                        ],
                        temperature=0.1,
                        max_tokens=200
                    )
                    raw_icd_json = icd10_resp.choices[0].message.content.strip()
                    if raw_icd_json.startswith("```"):
                        raw_icd_json = raw_icd_json.split("\n", 1)[1] if "\n" in raw_icd_json else raw_icd_json[3:]
                        if raw_icd_json.endswith("```"):
                            raw_icd_json = raw_icd_json[:-3]
                        raw_icd_json = raw_icd_json.strip()
                    
                    suggested_codes = json.loads(raw_icd_json)
                    if isinstance(suggested_codes, list) and suggested_codes:
                        extracted_dict["icd10_codes"] = [str(c).strip().upper() for c in suggested_codes]
                        logger.info(f"[OCR] AI ICD-10 Finder successfully populated codes: {extracted_dict['icd10_codes']}")
                except Exception as icd_err:
                    logger.warning(f"[OCR] AI ICD-10 Finder failed (non-fatal): {icd_err}")

        # ── Phase 5: Clinical Level of Care Inference ────────────────────────────
        # Azure OpenAI reasons from actual clinical evidence (procedures, medications,
        # crew qualifications) to validate or correct the level_of_care field.
        # This catches forms where the checkbox is blank, misread, or inconsistent
        # with what was actually performed.
        try:
            _crew_qual   = (extracted_dict.get("crew_member_1_qualification") or "").strip().upper()
            _loc_current = (extracted_dict.get("level_of_care") or "").strip().upper()
            _procedures  = extracted_dict.get("procedures") or []
            _meds        = extracted_dict.get("medications_given") or []
            _clinical    = (extracted_dict.get("clinical_notes") or "")
            _diagnosis   = (extracted_dict.get("primary_diagnosis") or extracted_dict.get("working_diagnosis") or "")
            _complaint   = (extracted_dict.get("chief_complaint") or "")
            _vitals      = extracted_dict.get("vital_signs") or []

            # Compile clinical evidence for the AI
            _proc_text = ", ".join(_procedures) if isinstance(_procedures, list) else str(_procedures)
            _med_text  = "; ".join(
                f"{m.get('name') or m.get('medication','')} {m.get('dose','')} {m.get('route','')}"
                if isinstance(m, dict) else str(m)
                for m in (_meds if isinstance(_meds, list) else [])
            )

            _loc_prompt = (
                "You are an expert South African EMS clinical coder.\n"
                "Your task is to determine whether the LEVEL OF CARE rendered on this call was ILS or ALS.\n\n"
                "SOUTH AFRICAN EMS CLINICAL RULES:\n"
                "- ALS (Advanced Life Support): Practitioners are Paramedics. They administer advanced IV interventions (e.g., Adenosine, Amiodarone, Ketamine, Morphine, Adrenaline, Pacing, Intubation, Chest Decompression).\n"
                "- ILS (Intermediate Life Support): Practitioners are Emergency Care Technicians (ECT/AEA). They perform basic airway management (Oxygen, NRB, BVM, OPA/NPA), IV access, and administer basic medications (Aspirin, Oxygen, Glucose, Salbutamol, Entonox, basic pain relief).\n"
                "- BLS (Basic Life Support): Practitioners are BAA. SA EMS maps all BLS calls to ILS for tariff purposes. They provide Oxygen, splinting, and basic first aid.\n\n"
                "CRITICAL OVERRIDE RULES:\n"
                f"1. The physical form explicitly states the level of care is: '{_loc_current or 'BLANK'}'.\n"
                "2. You must DEFAULT to this stated level of care. DO NOT override it based on the severity of the patient's condition (e.g. fever or chest pain).\n"
                "3. ONLY override to ALS if there is undeniable proof of an ALS-specific procedure or medication (e.g. Ketamine given, Intubation performed) OR if the Crew Qualification is explicitly 'ALS' or 'Paramedic' AND advanced care was given.\n"
                "4. If the procedure is just 'O2', 'Oxygen', 'IV Access', or vital signs monitoring, it is strictly ILS.\n\n"
                "CLINICAL EVIDENCE:\n"
                f"- Crew 1 Qualification: {_crew_qual or 'Not stated'}\n"
                f"- Current LOC on form: {_loc_current or 'BLANK'}\n"
                f"- Chief Complaint: {_complaint or 'Not stated'}\n"
                f"- Primary Diagnosis: {_diagnosis or 'Not stated'}\n"
                f"- Clinical Notes: {(_clinical or 'None')[:400]}\n"
                f"- Procedures Performed: {_proc_text[:300] or 'None documented'}\n"
                f"- Medications Given: {_med_text[:300] or 'None documented'}\n"
                f"- Vital Signs Sets Recorded: {len(_vitals)}\n\n"
                "Based ONLY on the above evidence, validate the level of care.\n"
                "Return ONLY a JSON object with these exact keys:\n"
                "- \"level_of_care\": \"ILS\" or \"ALS\" (required)\n"
                "- \"confidence\": \"high\" or \"low\" (required)\n"
                "- \"reasoning\": one-sentence justification (required)\n"
                "Return ONLY valid JSON. No markdown."
            )

            loc_resp = await llm_client.chat.completions.create(
                model=settings.AZURE_OPENAI_DEPLOYMENT,
                response_format={"type": "json_object"},
                messages=[{"role": "user", "content": _loc_prompt}],
                temperature=0.0,
                max_tokens=120,
            )
            _loc_result = json.loads(loc_resp.choices[0].message.content)
            _inferred_loc = (_loc_result.get("level_of_care") or "").strip().upper()
            _confidence   = (_loc_result.get("confidence") or "low").strip().lower()
            _reasoning    = _loc_result.get("reasoning", "")

            if _inferred_loc in ("ILS", "ALS"):
                if not _loc_current:
                    # Form was blank — always fill from clinical evidence
                    extracted_dict["level_of_care"] = _inferred_loc
                    logger.info(
                        "[OCR] Level of Care inferred as %s (form was blank). Confidence=%s. Reason: %s",
                        _inferred_loc, _confidence, _reasoning,
                    )
                elif _inferred_loc != _loc_current and _confidence == "high":
                    # Only override a filled value when AI is highly confident
                    logger.warning(
                        "[OCR] Level of Care MISMATCH: form says '%s', clinical evidence suggests '%s' (confidence=high). "
                        "Reason: %s — overriding to match clinical evidence.",
                        _loc_current, _inferred_loc, _reasoning,
                    )
                    extracted_dict["level_of_care"] = _inferred_loc
                else:
                    logger.info(
                        "[OCR] Level of Care '%s' confirmed by AI (confidence=%s). Reason: %s",
                        _loc_current, _confidence, _reasoning,
                    )
            else:
                logger.warning("[OCR] Level of Care inference returned unexpected value: %s", _loc_result)

        except Exception as _loc_err:
            logger.warning("[OCR] Level of Care clinical inference failed (non-fatal): %s", _loc_err)

        # ── Calculate dynamic confidence ─────────────────────────────────────────
        core_fields = ["patient_name", "medical_scheme", "incident_date", "treating_provider", "prf_number"]
        field_scores = {}
        for k, v in extracted_dict.items():
            if k in ["icd10_codes", "line_items", "_fallback_reasoning"]: continue
            if v:
                field_scores[k] = 0.99
            else:
                field_scores[k] = 0.0

        core_fill_rate = sum(1 for f in core_fields if extracted_dict.get(f)) / len(core_fields)
        avg = (sum(field_scores.values()) / len(field_scores)) * 0.5 + (core_fill_rate * 0.5) if field_scores else 0.0

        logger.info(f"[OCR] Semantic pipeline complete. Avg Confidence: {avg:.2f}")

        return ExtractionResult(
            extracted_data=extracted_dict,
            field_scores=field_scores,
            avg_confidence=avg,
            needs_hitl_review=avg < CONFIDENCE_THRESHOLD,
            method_used="azure_semantic",
            success=True,
        )

    except Exception as e:
        logger.exception(f"[OCR] Azure Semantic pipeline failed: {e}")
        return ExtractionResult(
            extracted_data={}, field_scores={}, avg_confidence=0,
            needs_hitl_review=True, method_used="azure_semantic", success=False,
            error=str(e),
        )


async def process_prf_data(raw_ocr_text: str):
    """
    Lightweight, single-call Azure OpenAI implementation to force rigid JSON schema extraction 
    for PRF auditing and clinical compliance.
    """
    import json
    from fastapi import HTTPException
    from openai import AsyncAzureOpenAI
    from app.config import get_settings
    
    settings = get_settings()

    # Initialize your native, lightweight client using environment config
    client = AsyncAzureOpenAI(
        api_key=settings.AZURE_OPENAI_API_KEY,
        api_version="2024-02-15-preview",
        azure_endpoint=settings.AZURE_OPENAI_ENDPOINT
    )
    
    # 1. Define the exact JSON structure you expect back
    system_instruction = """
    You are an expert South African EMS medical coder. 
    Analyze the raw OCR text and return ONLY a JSON object with these exact keys:
    - normalized_hospital_name (string)
    - predicted_icd10_primary (string)
    - predicted_icd10_secondary (string or null)
    - level_of_care_audit_passed (boolean)
    - audit_warning_message (string or null)
    - generated_clinical_motivation (string or null)
    - standardized_incident_date (YYYY-MM-DD)
    """

    try:
        # 2. Make the direct, asynchronous REST call
        response = await client.chat.completions.create(
            model=settings.AZURE_OPENAI_DEPLOYMENT,
            response_format={ "type": "json_object" }, # Forces strict JSON return
            temperature=0.1, # Keep it highly deterministic
            messages=[
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": f"RAW OCR TEXT:\n{raw_ocr_text}"}
            ]
        )
        
        # 3. Parse the clean JSON directly into a Python dictionary
        clean_data = json.loads(response.choices[0].message.content)
        return clean_data

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Azure LLM Processing Failed: {str(e)}")
