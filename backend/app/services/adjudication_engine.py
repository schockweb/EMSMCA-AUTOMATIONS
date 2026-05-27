"""
Adjudication Engine — Deterministic clinical rules engine.
Scrubs claims in real-time, performing concurrent validation checks
to achieve a "clean claim" state prior to dispatch.

Orchestrates:
1. BHF PCNS provider verification
2. PMB condition detection + modifier routing
3. ICD-10 ↔ CPT cross-walk validation
4. Benefit limit checks (stubbed for scheme API)
5. Completeness checks (pre-auth, signatures, etc.)
6. Automated RFI generation for failures
"""
import uuid
from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.claim import Claim, AdjudicationStatus
from app.models.claim_line import ClaimLine
from app.models.case import Case
from app.models.document import Document
from app.models.rfi import RFI, RFIStatus, RFIPriority
from app.services.bhf_verification import verify_provider_pcns
from app.services.pmb_routing import detect_pmb_from_icd10, detect_pmb_from_narrative
from app.services.icd10_cpt_crosswalk import (
    cross_walk_icd10_cpt,
    validate_icd10_code,
    validate_cpt_code,
    validate_nappi_code,
)
import json
import logging
from app.config import get_settings

logger = logging.getLogger(__name__)


# ── RFI Reason Codes ────────────────────────────────────
class RFIReasonCode:
    MISSING_PREAUTH = "MISSING_PREAUTH"
    INVALID_ICD10 = "INVALID_ICD10"
    INVALID_CPT = "INVALID_CPT"
    CLINICAL_MISMATCH = "CLINICAL_MISMATCH"
    MISSING_SIGNATURE = "MISSING_SIGNATURE"
    INVALID_PROVIDER = "INVALID_PROVIDER"
    MISSING_PATIENT_ID = "MISSING_PATIENT_ID"
    MISSING_SCHEME_INFO = "MISSING_SCHEME_INFO"
    BENEFIT_LIMIT_EXCEEDED = "BENEFIT_LIMIT_EXCEEDED"
    DUPLICATE_CLAIM = "DUPLICATE_CLAIM"
    UPCODING_SUSPECTED = "UPCODING_SUSPECTED"
    INVALID_NAPPI = "INVALID_NAPPI"
    POLICY_VIOLATION = "POLICY_VIOLATION"


@dataclass
class AdjudicationCheck:
    """Individual validation check result."""
    check_name: str
    passed: bool
    severity: str  # "error", "warning", "info"
    message: str
    rfi_reason: Optional[str] = None  # If failed, what RFI to generate


@dataclass
class AdjudicationResult:
    """Full adjudication result for a claim."""
    claim_id: str
    status: str = "pending"  # "clean", "rfi", "rejected"
    is_clean: bool = False
    is_pmb: bool = False
    pmb_details: Optional[dict] = None
    checks: list[AdjudicationCheck] = field(default_factory=list)
    rfis_generated: list[dict] = field(default_factory=list)
    modifiers_applied: list[str] = field(default_factory=list)
    total_checks: int = 0
    passed_checks: int = 0
    failed_checks: int = 0
    warning_count: int = 0

    @property
    def pass_rate(self) -> float:
        return self.passed_checks / max(self.total_checks, 1)


async def adjudicate_claim(
    claim_id: str,
    db: AsyncSession,
    auto_generate_rfis: bool = True,
) -> AdjudicationResult:
    """
    Run the full adjudication matrix on a claim.
    Returns detailed results with pass/fail for each check.
    """
    result = AdjudicationResult(claim_id=claim_id)

    # ── Load RFI Rules Settings ──
    # These were previously editable through the Settings UI via the
    # `system_settings` table. They are now hardcoded constants in
    # `app/rules/base.py` so they can only change via a code release + PR.
    from app.rules.base import (
        REQUIRE_PATIENT_ID as req_patient_id,
        REQUIRE_SCHEME as req_scheme,
        REQUIRE_PROVIDER_PCNS as req_provider,
    )

    # ── Load claim with related data ──
    claim_result = await db.execute(
        select(Claim).where(Claim.id == uuid.UUID(claim_id))
    )
    claim = claim_result.scalar_one_or_none()
    if not claim:
        result.status = "rejected"
        result.checks.append(AdjudicationCheck(
            check_name="CLAIM_EXISTS", passed=False, severity="error",
            message=f"Claim {claim_id} not found",
        ))
        return result

    # Load case
    case_result = await db.execute(
        select(Case).where(Case.id == claim.case_id)
    )
    case = case_result.scalar_one_or_none()

    # Load claim lines
    lines_result = await db.execute(
        select(ClaimLine).where(ClaimLine.claim_id == claim.id).order_by(ClaimLine.line_number)
    )
    claim_lines = lines_result.scalars().all()

    # Load documents for the case
    docs = []
    if case:
        docs_result = await db.execute(
            select(Document).where(Document.case_id == case.id)
        )
        docs = docs_result.scalars().all()

    # ═══════════════════════════════════════════════════════
    # RUN ALL CHECKS CONCURRENTLY
    # ═══════════════════════════════════════════════════════

    # ── CHECK 1: Patient Demographics ──
    if case:
        if not case.patient_name or case.patient_name.strip() == "":
            result.checks.append(AdjudicationCheck(
                check_name="PATIENT_NAME", passed=False, severity="error",
                message="Patient name is missing",
                rfi_reason=RFIReasonCode.MISSING_PATIENT_ID,
            ))
        else:
            result.checks.append(AdjudicationCheck(
                check_name="PATIENT_NAME", passed=True, severity="info",
                message=f"Patient: {case.patient_name} ✓",
            ))

        if not case.patient_id_number:
            if req_patient_id:
                result.checks.append(AdjudicationCheck(
                    check_name="PATIENT_ID", passed=False, severity="error",
                    message="SA ID number missing",
                    rfi_reason=RFIReasonCode.MISSING_PATIENT_ID,
                ))
            else:
                result.checks.append(AdjudicationCheck(
                    check_name="PATIENT_ID", passed=False, severity="warning",
                    message="SA ID number missing — skipped by user preference",
                ))
        else:
            result.checks.append(AdjudicationCheck(
                check_name="PATIENT_ID", passed=True, severity="info",
                message="SA ID number present ✓",
            ))
    else:
        result.checks.append(AdjudicationCheck(
            check_name="CASE_EXISTS", passed=False, severity="error",
            message="No case linked to this claim",
        ))

    # ── CHECK 2: Scheme / Membership ──
    if case:
        if not case.medical_scheme_name:
            if req_scheme:
                result.checks.append(AdjudicationCheck(
                    check_name="SCHEME_NAME", passed=False, severity="error",
                    message="Medical scheme name is missing",
                    rfi_reason=RFIReasonCode.MISSING_SCHEME_INFO,
                ))
            else:
                result.checks.append(AdjudicationCheck(
                    check_name="SCHEME_NAME", passed=False, severity="warning",
                    message="Medical scheme name is missing — skipped by user preference",
                ))
        else:
            result.checks.append(AdjudicationCheck(
                check_name="SCHEME_NAME", passed=True, severity="info",
                message=f"Scheme: {case.medical_scheme_name} ✓",
            ))

        if not case.scheme_member_number:
            if req_scheme:
                result.checks.append(AdjudicationCheck(
                    check_name="MEMBER_NUMBER", passed=False, severity="warning",
                    message="Scheme member number is missing",
                    rfi_reason=RFIReasonCode.MISSING_SCHEME_INFO,
                ))
            else:
                result.checks.append(AdjudicationCheck(
                    check_name="MEMBER_NUMBER", passed=False, severity="warning",
                    message="Scheme member number is missing — skipped by user preference",
                ))
        else:
            result.checks.append(AdjudicationCheck(
                check_name="MEMBER_NUMBER", passed=True, severity="info",
                message=f"Member #: {case.scheme_member_number} ✓",
            ))

    # ── CHECK 3: Pre-authorization ──
    if case:
        scheme_name = (case.medical_scheme_name or "").strip().lower()
        preauth = (case.preauth_number or "").strip()
        if preauth.lower() in ["none", "n/a", "na", "nil", "null", "-", ""]:
            preauth = ""

        if not preauth and scheme_name not in ["private", "cash", "account", "wca", "raf", "none", "n/a", "na"]:
            # ── AUTO-REQUEST: Try to get auth number from scheme API ──
            auto_result = None
            try:
                from app.api.authorization import auto_request_authorization
                auto_result = await auto_request_authorization(case.id, db)
                # Refresh the case object to pick up any write-back
                await db.refresh(case)
                preauth = (case.preauth_number or "").strip()
            except Exception as auto_err:
                logger.warning("Auto-auth attempt failed for case %s: %s", case.id, auto_err)

            if preauth:
                # Auto-request succeeded!
                result.checks.append(AdjudicationCheck(
                    check_name="PREAUTH", passed=True, severity="info",
                    message=f"Pre-auth auto-obtained from scheme API: {preauth} ✓",
                ))
            elif auto_result and auto_result.get("status") == "DECLINED":
                result.checks.append(AdjudicationCheck(
                    check_name="PREAUTH", passed=False, severity="error",
                    message=f"Scheme DECLINED authorization: {auto_result.get('reason', 'No reason given')}",
                    rfi_reason=RFIReasonCode.MISSING_PREAUTH,
                ))
            elif auto_result and auto_result.get("status") in ("TIMEOUT", "ERROR"):
                # Non-blocking: auth request failed transiently — flag the case and continue
                # The case will appear in the Cases section with auth_flag=True, awaiting auth number
                try:
                    case.auth_flag = True
                    case.auth_flag_reason = f"Auto-auth {auto_result.get('status', 'ERROR')} — awaiting auth number from scheme"
                    from app.models.case import PreAuthStatus
                    case.preauth_status = PreAuthStatus.PENDING
                except Exception:
                    pass
                result.checks.append(AdjudicationCheck(
                    check_name="PREAUTH", passed=True, severity="warning",
                    message="Auth request sent to scheme — awaiting response. Case queued in Cases section.",
                ))
            else:
                result.checks.append(AdjudicationCheck(
                    check_name="PREAUTH", passed=True, severity="info",
                    message="Pre-authorization is missing but managed by case flag instead of RFI.",
                ))
        elif not preauth:
            result.checks.append(AdjudicationCheck(
                check_name="PREAUTH", passed=True, severity="info",
                message="Pre-authorization constraint bypassed (Private/IOD/Fixed-Account).",
            ))
        else:
            result.checks.append(AdjudicationCheck(
                check_name="PREAUTH", passed=True, severity="info",
                message=f"Pre-auth: {preauth} ✓",
            ))

    # ── CHECK 4: BHF Provider Verification ──
    if case and case.assigned_provider_id:
        from app.models.user import User
        provider_result = await db.execute(
            select(User).where(User.id == case.assigned_provider_id)
        )
        provider = provider_result.scalar_one_or_none()
        if provider and provider.bhf_practice_number:
            bhf_result = await verify_provider_pcns(provider.bhf_practice_number)
            if bhf_result.is_valid:
                result.checks.append(AdjudicationCheck(
                    check_name="BHF_PROVIDER", passed=True, severity="info",
                    message=f"Provider PCNS {provider.bhf_practice_number} valid ✓ ({bhf_result.discipline})",
                ))
            else:
                if req_provider:
                    result.checks.append(AdjudicationCheck(
                        check_name="BHF_PROVIDER", passed=False, severity="error",
                        message=f"Provider PCNS invalid: {bhf_result.error}",
                        rfi_reason=RFIReasonCode.INVALID_PROVIDER,
                    ))
                else:
                    result.checks.append(AdjudicationCheck(
                        check_name="BHF_PROVIDER", passed=False, severity="warning",
                        message=f"Provider PCNS invalid: {bhf_result.error} — skipped by user preference",
                    ))
        else:
            if req_provider:
                result.checks.append(AdjudicationCheck(
                    check_name="BHF_PROVIDER", passed=False, severity="error",
                    message="Provider has no BHF practice number on file",
                    rfi_reason=RFIReasonCode.INVALID_PROVIDER,
                ))
            else:
                result.checks.append(AdjudicationCheck(
                    check_name="BHF_PROVIDER", passed=False, severity="warning",
                    message="Provider has no BHF practice number on file — skipped by user preference",
                ))

    # ── CHECK 5: Claim Lines — ICD-10, CPT, NAPPI validation ──
    if not claim_lines:
        result.checks.append(AdjudicationCheck(
            check_name="CLAIM_LINES", passed=False, severity="error",
            message="Claim has no billing lines",
        ))
    else:
        for line in claim_lines:
            # ICD-10 validation
            icd_primary_clean = str(line.icd10_primary).strip().upper() if line.icd10_primary else ""
            if icd_primary_clean and icd_primary_clean not in ("N/A", "NA", "NONE", "-", "NIL", "NULL", ""):
                icd_info = validate_icd10_code(line.icd10_primary)
                if icd_info["valid"]:
                    result.checks.append(AdjudicationCheck(
                        check_name=f"ICD10_L{line.line_number}", passed=True, severity="info",
                        message=f"L{line.line_number}: ICD-10 {line.icd10_primary} valid — {icd_info['description']} ✓",
                    ))
                else:
                    result.checks.append(AdjudicationCheck(
                        check_name=f"ICD10_L{line.line_number}", passed=False, severity="error",
                        message=f"L{line.line_number}: Invalid ICD-10 code: {line.icd10_primary}",
                        rfi_reason=RFIReasonCode.INVALID_ICD10,
                    ))
            elif not icd_primary_clean or icd_primary_clean in ("N/A", "NA", "NONE", "-", "NIL", "NULL", ""):
                result.checks.append(AdjudicationCheck(
                    check_name=f"ICD10_L{line.line_number}", passed=False, severity="error",
                    message=f"L{line.line_number}: Primary ICD-10 code is missing or N/A",
                    rfi_reason=RFIReasonCode.INVALID_ICD10,
                ))

            # CPT validation
            cpt_clean = str(line.cpt_code).strip().upper() if line.cpt_code else ""
            if cpt_clean and cpt_clean not in ("N/A", "NA", "NONE", "-", "NIL", "NULL", ""):
                cpt_info = validate_cpt_code(line.cpt_code)
                if cpt_info["valid"]:
                    result.checks.append(AdjudicationCheck(
                        check_name=f"CPT_L{line.line_number}", passed=True, severity="info",
                        message=f"L{line.line_number}: CPT {line.cpt_code} valid — {cpt_info['description']} ✓",
                    ))
                else:
                    result.checks.append(AdjudicationCheck(
                        check_name=f"CPT_L{line.line_number}", passed=False, severity="error",
                        message=f"L{line.line_number}: Invalid CPT code: {line.cpt_code}",
                        rfi_reason=RFIReasonCode.INVALID_CPT,
                    ))

            # Cross-walk
            icd_clean = str(line.icd10_primary).strip().upper() if line.icd10_primary else ""
            if icd_clean and icd_clean not in ("N/A", "NA", "NONE", "-", "NIL", "NULL", "") and cpt_clean and cpt_clean not in ("N/A", "NA", "NONE", "-", "NIL", "NULL", ""):
                xwalk = cross_walk_icd10_cpt(line.icd10_primary, line.cpt_code)
                if xwalk.warnings:
                    for w in xwalk.warnings:
                        result.checks.append(AdjudicationCheck(
                            check_name=f"XWALK_L{line.line_number}", passed=True, severity="warning",
                            message=f"L{line.line_number}: {w}",
                            rfi_reason=RFIReasonCode.CLINICAL_MISMATCH,
                        ))
                if xwalk.is_pmb:
                    result.is_pmb = True

            # NAPPI validation
            if line.nappi_code:
                nappi_info = validate_nappi_code(line.nappi_code)
                if not nappi_info["valid"]:
                    result.checks.append(AdjudicationCheck(
                        check_name=f"NAPPI_L{line.line_number}", passed=False, severity="warning",
                        message=f"L{line.line_number}: Invalid NAPPI code: {line.nappi_code}",
                        rfi_reason=RFIReasonCode.INVALID_NAPPI,
                    ))

    # ── CHECK 6: PMB Detection ──
    for line in claim_lines:
        if line.icd10_primary:
            pmb = detect_pmb_from_icd10(line.icd10_primary, line.icd10_secondary)
            if pmb.is_pmb:
                result.is_pmb = True
                result.pmb_details = {
                    "type": pmb.pmb_type,
                    "condition": pmb.pmb_condition,
                    "code": pmb.pmb_code,
                    "modifier": pmb.modifier_to_append,
                    "legal_mandate": pmb.legal_mandate,
                }
                result.modifiers_applied.append(pmb.modifier_to_append or "")
                result.checks.append(AdjudicationCheck(
                    check_name=f"PMB_L{line.line_number}", passed=True, severity="info",
                    message=f"L{line.line_number}: PMB detected — {pmb.pmb_condition}. Modifier: {pmb.modifier_to_append}",
                ))
                break

    # ── CHECK 7: Document Completeness ──
    if docs:
        completed_docs = [d for d in docs if d.ocr_status.value == "completed"]
        hitl_docs = [d for d in docs if d.needs_hitl_review]

        result.checks.append(AdjudicationCheck(
            check_name="DOCUMENTS", passed=True, severity="info",
            message=f"{len(completed_docs)}/{len(docs)} documents processed ✓",
        ))

        if hitl_docs:
            result.checks.append(AdjudicationCheck(
                check_name="HITL_REVIEW", passed=True, severity="warning",
                message=f"{len(hitl_docs)} document(s) flagged for manual review (low AI confidence)",
            ))

        # Patient signature check removed per user preference.
    else:
        result.checks.append(AdjudicationCheck(
            check_name="DOCUMENTS", passed=False, severity="warning",
            message="No documents attached to this case",
        ))

    # ── CHECK 7.5: Clinical Validation Scrub ──
    extracted = {}
    if docs:
        # Use extracted data from the primary document or first available
        primary_doc = next((d for d in docs if d.is_group_primary), docs[0])
        extracted = primary_doc.extracted_data or {}

    procedures = str(extracted.get("procedures_performed", "")).upper()
    
    # 1. CPR Checked -> ALS Vehicle
    if "CPR" in procedures:
        # crew qual may be an HPCSA category (BAA/AEA/…/ANT/ECP) post-migration or
        # a legacy BLS/ILS/ALS tier from OCR. Normalise both into a tier before
        # checking — otherwise "ANT"/"ECP" crew get incorrectly flagged here.
        from app.utils.hpcsa import to_tier as _qual_to_tier
        has_als_crew = _qual_to_tier(extracted.get("crew_member_1_qualification")) == "ALS" or \
                       _qual_to_tier(extracted.get("crew_member_2_qualification")) == "ALS"
        has_als_line = any("151" in str(line.cpt_code) or "ALS" in str(line.description).upper() for line in claim_lines)
        if not (has_als_crew or has_als_line):
            result.checks.append(AdjudicationCheck(
                check_name="CPR_VALIDATION", passed=False, severity="error",
                message="CPR performed but no Assisting ALS Vehicle/Crew or ALS code documented on claim.",
                rfi_reason=RFIReasonCode.CLINICAL_MISMATCH,
            ))
        else:
            result.checks.append(AdjudicationCheck(
                check_name="CPR_VALIDATION", passed=True, severity="info",
                message="CPR validated: Assisting ALS Vehicle/Crew verified ✓",
            ))

    # 2. S/T ICD-10 -> External Cause Code & 3. Consumables
    for line in claim_lines:
        icd_primary = str(line.icd10_primary).strip().upper()
        if icd_primary.startswith("S") or icd_primary.startswith("T"):
            icd_sec = str(line.icd10_secondary).strip().upper()
            if not icd_sec or not (icd_sec.startswith("V") or icd_sec.startswith("W") or icd_sec.startswith("X") or icd_sec.startswith("Y")):
                result.checks.append(AdjudicationCheck(
                    check_name=f"EXTERNAL_CAUSE_L{line.line_number}", passed=False, severity="error",
                    message=f"L{line.line_number}: Injury code {icd_primary} requires an External Cause Code (V, W, X, Y).",
                    rfi_reason=RFIReasonCode.INVALID_ICD10,
                ))
            else:
                result.checks.append(AdjudicationCheck(
                    check_name=f"EXTERNAL_CAUSE_L{line.line_number}", passed=True, severity="info",
                    message=f"L{line.line_number}: Injury code {icd_primary} validated with External Cause {icd_sec} ✓",
                ))
                
        if line.nappi_code:
            desc = str(line.description).upper()
            if any(k in desc for k in ["BANDAGE", "SYRINGE", "GLOVE", "STANDARD", "PLASTER"]):
                result.checks.append(AdjudicationCheck(
                    check_name=f"CONSUMABLE_L{line.line_number}", passed=False, severity="warning",
                    message=f"L{line.line_number}: Standard consumable '{line.description}' stripped (inclusive in base rate).",
                    rfi_reason=RFIReasonCode.UPCODING_SUSPECTED,
                ))
            elif "SPECIAL" in desc:
                if not (case and case.preauth_number):
                    result.checks.append(AdjudicationCheck(
                        check_name=f"CONSUMABLE_AUTH_L{line.line_number}", passed=False, severity="error",
                        message=f"L{line.line_number}: Special consumable requires pre-authorization.",
                        rfi_reason=RFIReasonCode.MISSING_PREAUTH,
                    ))

    # ── CHECK 8: Deterministic Rule Engine ──
    # Evaluates all active SchemeRules from the database against the claim context.
    # Zero API cost, sub-millisecond, 100% deterministic and reproducible.
    from app.services.rule_engine import build_claim_context, evaluate_rules as run_rule_engine

    scheme = (case.medical_scheme_name.strip() if case and case.medical_scheme_name else "")

    # Build the flat context dictionary that rules evaluate against
    provider = None
    if case and case.assigned_provider_id:
        from app.models.user import User as _User
        _prov_result = await db.execute(select(_User).where(_User.id == case.assigned_provider_id))
        provider = _prov_result.scalar_one_or_none()

    claim_context = build_claim_context(
        claim=claim, case=case, claim_lines=claim_lines, provider=provider,
    )

    engine_result = await run_rule_engine(claim_context, db, scheme_name=scheme)

    if engine_result.total_rules > 0:
        if engine_result.matched_rules == 0:
            # All rules passed — clean
            result.checks.append(AdjudicationCheck(
                check_name="RULE_ENGINE", passed=True, severity="info",
                message=f"{engine_result.total_rules} business rules verified for '{scheme}' ✓",
            ))
        else:
            # Some rules matched (violations detected)
            for rr in engine_result.results:
                action_type = rr.action.get("type", "WARN")
                rfi_code = rr.action.get("rfi_code")

                if action_type in ("REJECT", "FLAG_RFI"):
                    result.checks.append(AdjudicationCheck(
                        check_name=f"RULE_{rr.rule_name[:30].replace(' ', '_').upper()}",
                        passed=False,
                        severity="error" if rr.severity in ("critical", "high") else "warning",
                        message=rr.message,
                        rfi_reason=rfi_code or RFIReasonCode.POLICY_VIOLATION,
                    ))
                elif action_type == "WARN":
                    result.checks.append(AdjudicationCheck(
                        check_name=f"RULE_{rr.rule_name[:30].replace(' ', '_').upper()}",
                        passed=True,
                        severity="warning",
                        message=rr.message,
                    ))
                elif action_type == "APPLY_MODIFIER":
                    modifier = rr.action.get("modifier", "")
                    result.modifiers_applied.append(modifier)
                    result.checks.append(AdjudicationCheck(
                        check_name=f"RULE_MODIFIER_{modifier}",
                        passed=True,
                        severity="info",
                        message=f"Auto-applied modifier: {modifier} — {rr.message}",
                    ))
                else:
                    result.checks.append(AdjudicationCheck(
                        check_name=f"RULE_{rr.rule_name[:30].replace(' ', '_').upper()}",
                        passed=True,
                        severity="info",
                        message=rr.message,
                    ))
    else:
        result.checks.append(AdjudicationCheck(
            check_name="RULE_ENGINE", passed=True, severity="warning",
            message=f"No business rules configured{' for scheme ' + repr(scheme) if scheme else ''}. Add a hardcoded module under backend/app/rules/.",
        ))

    # ── CHECK 9: Scheme Authorization Status ──
    if case:
        from app.models.case import PreAuthStatus
        preauth_status = case.preauth_status
        preauth_number = (case.preauth_number or "").strip()

        if preauth_status == PreAuthStatus.APPROVED and preauth_number:
            result.checks.append(AdjudicationCheck(
                check_name="SCHEME_AUTH", passed=True, severity="info",
                message=f"Scheme authorization confirmed: {preauth_number} ✓",
            ))
        elif preauth_status == PreAuthStatus.DENIED:
            result.checks.append(AdjudicationCheck(
                check_name="SCHEME_AUTH", passed=False, severity="error",
                message="Scheme authorization was DENIED. Resubmit with corrected clinical data.",
                rfi_reason=RFIReasonCode.MISSING_PREAUTH,
            ))
        elif preauth_status == PreAuthStatus.PENDING:
            result.checks.append(AdjudicationCheck(
                check_name="SCHEME_AUTH", passed=True, severity="warning",
                message="Scheme authorization pending — use 'Request Authorization' to submit.",
            ))

    # ── CHECK 10: Universal PRF Clinical SCRUB Rules ──────────────────────
    # These run against the raw extracted_data from the PRF document(s).
    # They apply to both scanned-then-extracted PRFs and direct digital submissions.

    prf_data: dict = {}
    if docs:
        # Use the primary (or first completed) document's extracted_data
        primary_doc = next(
            (d for d in docs if d.is_group_primary and d.extracted_data),
            next((d for d in docs if d.extracted_data), None),
        )
        if primary_doc and primary_doc.extracted_data:
            prf_data = primary_doc.extracted_data

    if prf_data:
        _primary_icd10 = (prf_data.get("primary_icd10") or "").strip().upper()
        _incident_type = (prf_data.get("incident_type") or "").strip().upper()
        _scheme_name = (prf_data.get("medical_scheme") or (case.medical_scheme_name if case else "") or "").strip().upper()
        _auth_raw = (prf_data.get("preauth_number") or (case.preauth_number if case else "") or "").strip()
        _auth_bypassed = _auth_raw.upper() in ("N/A", "NA", "NIL", "NONE", "-", "")
        _auth_present = bool(_auth_raw) and not _auth_bypassed

        # ── 10a: External Cause Code (mandatory for S/T ICD-10) ──
        if _primary_icd10 and _primary_icd10[0] in ("S", "T"):
            import re as _re
            ext_cause = (prf_data.get("external_cause_code") or "").strip().upper()
            if not ext_cause:
                result.checks.append(AdjudicationCheck(
                    check_name="EXT_CAUSE_REQUIRED",
                    passed=False, severity="error",
                    message=(
                        f"External Cause Code is mandatory for trauma/injury ICD-10 "
                        f"'{_primary_icd10}' (starts with S/T). "
                        f"Must start with V, W, X, or Y (e.g. W19.0)."
                    ),
                    rfi_reason=RFIReasonCode.INVALID_ICD10,
                ))
            elif not _re.match(r"^[VWXY][0-9A-Z]{2,}", ext_cause.replace(".", "")):
                result.checks.append(AdjudicationCheck(
                    check_name="EXT_CAUSE_REQUIRED",
                    passed=False, severity="error",
                    message=(
                        f"External Cause Code '{ext_cause}' is invalid. "
                        f"Must start with V, W, X, or Y followed by at least 2 digits."
                    ),
                    rfi_reason=RFIReasonCode.INVALID_ICD10,
                ))
            else:
                result.checks.append(AdjudicationCheck(
                    check_name="EXT_CAUSE_REQUIRED",
                    passed=True, severity="info",
                    message=f"External Cause Code '{ext_cause}' present ✓",
                ))

        # ── 10b: Auth Required — IFT ──
        if _incident_type == "IFT":
            if not _auth_present and not _auth_bypassed:
                result.checks.append(AdjudicationCheck(
                    check_name="AUTH_REQUIRED_IFT",
                    passed=False, severity="error",
                    message="Authorization / Reference Number is required for all IFT incidents.",
                    rfi_reason=RFIReasonCode.MISSING_PREAUTH,
                ))
            elif _auth_bypassed:
                result.checks.append(AdjudicationCheck(
                    check_name="AUTH_REQUIRED_IFT",
                    passed=True, severity="warning",
                    message="IFT auth marked N/A by clinician — manually verify authorization status.",
                ))
            else:
                result.checks.append(AdjudicationCheck(
                    check_name="AUTH_REQUIRED_IFT",
                    passed=True, severity="info",
                    message=f"IFT Authorization present ✓",
                ))

        # ── 10c: Auth Required — GEMS ──
        if "GEMS" in _scheme_name:
            if not _auth_present and not _auth_bypassed:
                result.checks.append(AdjudicationCheck(
                    check_name="AUTH_REQUIRED_GEMS",
                    passed=False, severity="error",
                    message="GEMS requires an Authorization / Reference Number for all calls.",
                    rfi_reason=RFIReasonCode.MISSING_PREAUTH,
                ))
            elif _auth_bypassed:
                result.checks.append(AdjudicationCheck(
                    check_name="AUTH_REQUIRED_GEMS",
                    passed=True, severity="warning",
                    message="GEMS auth marked N/A — confirm waiver reference exists.",
                ))
            else:
                result.checks.append(AdjudicationCheck(
                    check_name="AUTH_REQUIRED_GEMS",
                    passed=True, severity="info",
                    message="GEMS Authorization present ✓",
                ))

        # ── 10d: HPCSA Registration — Crew Member 1 ──
        _hpcsa = (prf_data.get("crew_member_1_hpcsa") or prf_data.get("crew1_hpcsa_number") or prf_data.get("provider_practice_number") or "").strip()
        if not _hpcsa:
            result.checks.append(AdjudicationCheck(
                check_name="HPCSA_REQUIRED",
                passed=False, severity="error",
                message="HPCSA Registration Number for Crew Member 1 (treating practitioner) is missing.",
                rfi_reason=RFIReasonCode.INVALID_PROVIDER,
            ))
        else:
            result.checks.append(AdjudicationCheck(
                check_name="HPCSA_REQUIRED",
                passed=True, severity="info",
                message=f"Crew HPCSA: {_hpcsa} ✓",
            ))

        # ── 10e: BHF Practice Number on PRF ──
        _bhf_prf = (prf_data.get("bhf_practice_number") or "").strip()
        if not _bhf_prf:
            result.checks.append(AdjudicationCheck(
                check_name="BHF_PRF_REQUIRED",
                passed=True, severity="warning",
                message="BHF Practice/PCNS Number is absent from the PRF document (Using system-assigned provider).",
            ))
        else:
            result.checks.append(AdjudicationCheck(
                check_name="BHF_PRF_REQUIRED",
                passed=True, severity="info",
                message=f"BHF Practice number on PRF: {_bhf_prf} ✓",
            ))

        # ── 10f: Vital Signs Count ──
        _vs = prf_data.get("vital_signs") or []
        if isinstance(_vs, list):
            vs_count = len(_vs)
            if vs_count > 0:
                result.checks.append(AdjudicationCheck(
                    check_name="VITAL_SIGNS",
                    passed=True, severity="info",
                    message=f"{vs_count} vital sign set(s) recorded ✓",
                ))

        # ── 10g: Multiple Patient — 150% Billing Flag ──
        _multi = (prf_data.get("multiple_patient_indicator") or "Solo").strip()
        if _multi.upper() not in ("", "SOLO", "SINGLE"):
            result.checks.append(AdjudicationCheck(
                check_name="MULTI_PATIENT_150",
                passed=True, severity="warning",
                message=(
                    f"Multiple patient indicator: '{_multi}'. "
                    f"Verify 150% billing rule is applied correctly before submission."
                ),
            ))

        # ── 10h: Odometer Sequence Validation ──
        _odo_d = prf_data.get("odometer_dispatch")
        _odo_s = prf_data.get("odometer_at_scene")
        _odo_p = prf_data.get("odometer_departure") or prf_data.get("odometer_departure_scene")
        _odo_h = prf_data.get("odometer_destination") or prf_data.get("odometer_arrival_destination")
        if all(v is not None for v in [_odo_d, _odo_s, _odo_p, _odo_h]):
            try:
                odos = [int(_odo_d), int(_odo_s), int(_odo_p), int(_odo_h)]
                if not (odos[0] <= odos[1] <= odos[2] <= odos[3]):
                    result.checks.append(AdjudicationCheck(
                        check_name="ODOMETER_SEQUENCE",
                        passed=False, severity="error",
                        message=(
                            f"Odometer readings out of sequence: "
                            f"Dispatch={odos[0]} Scene={odos[1]} "
                            f"Departure={odos[2]} Destination={odos[3]}."
                        ),
                    ))
                else:
                    km_total = odos[3] - odos[0]
                    result.checks.append(AdjudicationCheck(
                        check_name="ODOMETER_SEQUENCE",
                        passed=True, severity="info",
                        message=f"Odometer sequence valid — total distance: {km_total} km ✓",
                    ))
            except (ValueError, TypeError):
                pass  # Non-numeric odometers — skip silently

    # ═══════════════════════════════════════════════════════
    # CALCULATE RESULT
    # ═══════════════════════════════════════════════════════
    result.total_checks = len(result.checks)
    result.passed_checks = sum(1 for c in result.checks if c.passed)
    result.failed_checks = sum(1 for c in result.checks if not c.passed and c.severity == "error")
    result.warning_count = sum(1 for c in result.checks if c.severity == "warning")

    # Determine final status
    if result.failed_checks > 0:
        result.status = "rfi"
        result.is_clean = False
        claim.adjudication_status = AdjudicationStatus.RFI
    elif result.warning_count > 2:
        result.status = "rfi"
        result.is_clean = False
        claim.adjudication_status = AdjudicationStatus.RFI
    else:
        result.status = "clean"
        result.is_clean = True
        claim.adjudication_status = AdjudicationStatus.CLEAN

    # ── Handle RFIs (Generate new, Resolve fixed) ──
    if auto_generate_rfis:
        failed_checks = [c for c in result.checks if not c.passed and c.rfi_reason]
        active_rfi_reasons = set(c.rfi_reason for c in failed_checks)

        # Get existing OPEN RFIs for this claim
        existing_rfis_result = await db.execute(
            select(RFI).where(RFI.claim_id == claim.id, RFI.rfi_status == RFIStatus.OPEN)
        )
        existing_rfis = existing_rfis_result.scalars().all()
        existing_rfi_reasons = {rfi.reason_code: rfi for rfi in existing_rfis}

        # 1. Auto-resolve RFIs that are NO LONGER failing
        for rfi in existing_rfis:
            if rfi.reason_code not in active_rfi_reasons:
                rfi.rfi_status = RFIStatus.RESOLVED
                rfi.resolved_at = datetime.now(timezone.utc)

        # 2. Generate RFIs for NEW failures
        seen_reasons = set()
        for check in failed_checks:
            if check.rfi_reason in seen_reasons:
                continue
            seen_reasons.add(check.rfi_reason)

            # Skip if an OPEN RFI for this reason already exists
            if check.rfi_reason in existing_rfi_reasons:
                continue

            # Map RFI reason to actual extraction field name
            field_name = check.check_name.lower()
            if check.rfi_reason == RFIReasonCode.MISSING_SIGNATURE:
                field_name = "patient_signature_present"
            elif check.rfi_reason == RFIReasonCode.MISSING_PREAUTH:
                field_name = "preauth_number"
            elif check.rfi_reason == RFIReasonCode.INVALID_PROVIDER:
                field_name = "provider_practice_number"
            elif check.rfi_reason == RFIReasonCode.INVALID_ICD10:
                field_name = "icd10_primary"
            elif check.rfi_reason == RFIReasonCode.INVALID_CPT:
                field_name = "cpt_code"
            elif check.rfi_reason == RFIReasonCode.INVALID_NAPPI:
                field_name = "nappi_code"
            elif check.rfi_reason == RFIReasonCode.MISSING_PATIENT_ID:
                field_name = "patient_id_number"
            elif check.rfi_reason == RFIReasonCode.MISSING_SCHEME_INFO:
                if field_name == "scheme_name":
                    field_name = "medical_scheme"
                elif field_name == "member_number":
                    field_name = "member_number"
                    
            priority = RFIPriority.HIGH if check.severity == "error" else RFIPriority.MEDIUM
            rfi = RFI(
                claim_id=claim.id,
                rfi_status=RFIStatus.OPEN,
                priority=priority,
                reason_code=check.rfi_reason,
                reason_description=check.message,
                missing_fields={field_name: check.message},
            )
            db.add(rfi)
            result.rfis_generated.append({
                "reason_code": check.rfi_reason,
                "description": check.message,
                "priority": priority.value,
                "missing_fields": {field_name: check.message},
            })

    await db.commit()
    return result
