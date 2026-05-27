"""
GEMS (Government Employees Medical Scheme) — hardcoded rules + tariff schedule.

Source of truth:
    "2023 GEMS EMS Claims Manual"
    Government Employees Medical Scheme. DSP for the EMED Centre is Europ
    Assistance (EASA). EMS providers must obtain a pre-authorisation /
    post-authorisation reference number from EMED before submitting any
    claim, and adjudication follows the Clinical Practice Guidelines (CPG)
    protocol along with HPCSA scopes of practice.

⚠️  TEST RATES  ⚠️
The Rand values in `TARIFFS` below are placeholders. The 2023 GEMS Manual
defines the rules + the documentation requirements but does not publish the
fee schedule. Replace with the gazetted GEMS rates before production.

Description strings are load-bearing
------------------------------------
The tariff engine's helpers match rows by keyword phrases — "up to 60",
"up to 45", "call out fee", "every 15", "with patient", "loaded", "without
patient", "unloaded", "callout". Do NOT paraphrase descriptions without
updating the engine in lockstep. Each row's `[LEVEL]` bracket tag drives the
level filter at the engine's level-bracket match.
"""
from __future__ import annotations

import logging

from app.rules.base import (
    Rule,
    RuleAction,
    RuleSeverity,
    RuleType,
    TariffCategory,
    TariffEntry,
    find_by_keywords,
)

logger = logging.getLogger("ems.rules.gems")


# ── Module identity ─────────────────────────────────────────────────────────
SCHEME_ID = "gems"
SCHEME_KEYWORDS: tuple[str, ...] = (
    "gems",
    "government employees medical scheme",
    "government employees",
)
PAYER_TYPE: str = "SCHEME"


# ═══════════════════════════════════════════════════════════════════════════
# GEMS-SPECIFIC LIMITS (from the 2023 GEMS EMS Claims Manual, §8.3 + §10)
# ═══════════════════════════════════════════════════════════════════════════
# Named so a PR diff makes any policy change explicit.

# §8.3 Allocated time guidelines — on-scene maxima per level of care
SCENE_MAX_MIN_BLS = 15
SCENE_MAX_MIN_ILS = 20
SCENE_MAX_MIN_ALS = 30
SCENE_MAX_MIN_ICU = 30

# §8.3 Hospital handover time
HANDOVER_MAX_MIN_BLS = 15
HANDOVER_MAX_MIN_ILS = 15
HANDOVER_MAX_MIN_ALS = 20
HANDOVER_MAX_MIN_ICU = 20

# §8.3 Travel-time reasonableness benchmarks
RESPONSE_AVG_KMH = 60     # 1 minute per km
TRANSFER_AVG_KMH = 40     # 1.5 minutes per km

# §8.3 Long-distance gate — claims over 100km loaded are billed by distance, not time
LONG_DISTANCE_KM_THRESHOLD = 100

# §5 Stale claim rules
STALE_DAYS_FROM_SERVICE = 120
RESUBMISSION_WINDOW_DAYS = 60

# §9 Call-out fee maximum
CALL_OUT_FEE_MAX_RAND = 1800.00

# §8.2 Multi-patient on one ambulance — 150% cap, P1 must be alone
# (1 patient: 100%, 2 patients: 75% each, 3 patients: 50% each, 4+: not billable)
MAX_BILLABLE_PATIENTS = 3
MULTI_PATIENT_TOTAL_CAP_PERCENT = 150

# §10.1.18 Vital signs minimum
VITALS_SETS_MINIMUM = 2

# §10.1 — A vehicle staffed with two BLS only is rejected outright
# (HPCSA "supervised practice" rule + DoH EMS Regs 2017 §7.2: ILS minimum)
ALLOW_DOUBLE_BLS_CREW = False


# ═══════════════════════════════════════════════════════════════════════════
# TARIFFS
# ═══════════════════════════════════════════════════════════════════════════
# Structure mirrors the old gems_tariffs table. Fields consumed by the engine:
#   tariff_code, description, primary_rate, iht_rate, category, notes
#
# `primary_rate` applies to Primary calls; `iht_rate` applies to IFT/IHT calls.
# When one column is R0, the engine falls back to the other (see _pick_rate).

TARIFFS: tuple[TariffEntry, ...] = (
    # ────────── BLS Base Rates ──────────
    TariffEntry(
        tariff_code="100",
        description="BLS Base Rate [BLS] Up to 45 min",
        category=TariffCategory.BASE_RATE,
        primary_rate=2850.00, iht_rate=3150.00,
        unit="per call", level="BLS",
        keywords=("up to 45",),
    ),
    TariffEntry(
        tariff_code="103",
        description="BLS Every 15 min extension [BLS]",
        category=TariffCategory.BASE_RATE,
        primary_rate=720.00, iht_rate=800.00,
        unit="per 15 min", level="BLS",
        keywords=("every 15",),
    ),
    TariffEntry(
        tariff_code="104",
        description="BLS IHT Call Out Fee [BLS]",
        category=TariffCategory.BASE_RATE,
        primary_rate=0.00, iht_rate=450.00,
        unit="per call", level="BLS",
        keywords=("call out fee",),
    ),

    # ────────── ILS Base Rates ──────────
    TariffEntry(
        tariff_code="125",
        description="ILS Base Rate [ILS] Up to 45 min",
        category=TariffCategory.BASE_RATE,
        primary_rate=3850.00, iht_rate=4200.00,
        unit="per call", level="ILS",
        keywords=("up to 45",),
    ),
    TariffEntry(
        tariff_code="127",
        description="ILS Every 15 min extension [ILS]",
        category=TariffCategory.BASE_RATE,
        primary_rate=820.00, iht_rate=920.00,
        unit="per 15 min", level="ILS",
        keywords=("every 15",),
    ),
    TariffEntry(
        tariff_code="126",
        description="ILS IHT Call Out Fee [ILS]",
        category=TariffCategory.BASE_RATE,
        primary_rate=0.00, iht_rate=600.00,
        unit="per call", level="ILS",
        keywords=("call out fee",),
    ),

    # ────────── ALS Base Rates ──────────
    TariffEntry(
        tariff_code="131",
        description="ALS Base Rate [ALS] Up to 60 min",
        category=TariffCategory.BASE_RATE,
        primary_rate=5200.00, iht_rate=5800.00,
        unit="per call", level="ALS",
        keywords=("up to 60",),
    ),
    TariffEntry(
        tariff_code="133",
        description="ALS Every 15 min extension [ALS]",
        category=TariffCategory.BASE_RATE,
        primary_rate=1050.00, iht_rate=1180.00,
        unit="per 15 min", level="ALS",
        keywords=("every 15",),
    ),
    TariffEntry(
        tariff_code="134",
        description="ALS IHT Call Out Fee [ALS]",
        category=TariffCategory.BASE_RATE,
        primary_rate=0.00, iht_rate=750.00,
        unit="per call", level="ALS",
        keywords=("call out fee",),
    ),

    # ────────── BLS Mileage ──────────
    TariffEntry(
        tariff_code="110",
        description="BLS Mileage with patient (loaded) [BLS]",
        category=TariffCategory.MILEAGE,
        primary_rate=38.00, iht_rate=42.00,
        unit="per km", level="BLS", loaded=True,
        keywords=("with patient", "loaded"),
    ),
    TariffEntry(
        tariff_code="112",
        description="BLS Mileage without patient (callout / RTB) [BLS]",
        category=TariffCategory.MILEAGE,
        primary_rate=28.00, iht_rate=32.00,
        unit="per km", level="BLS", loaded=False,
        keywords=("without patient", "unloaded", "callout"),
    ),

    # ────────── ILS Mileage ──────────
    TariffEntry(
        tariff_code="128",
        description="ILS Mileage with patient (loaded) [ILS]",
        category=TariffCategory.MILEAGE,
        primary_rate=44.00, iht_rate=48.00,
        unit="per km", level="ILS", loaded=True,
        keywords=("with patient", "loaded"),
    ),
    TariffEntry(
        tariff_code="129",
        description="ILS Mileage without patient (callout / RTB) [ILS]",
        category=TariffCategory.MILEAGE,
        primary_rate=34.00, iht_rate=38.00,
        unit="per km", level="ILS", loaded=False,
        keywords=("without patient", "unloaded", "callout"),
    ),

    # ────────── ALS Mileage ──────────
    TariffEntry(
        tariff_code="141",
        description="ALS Mileage with patient (loaded) [ALS]",
        category=TariffCategory.MILEAGE,
        primary_rate=50.00, iht_rate=54.00,
        unit="per km", level="ALS", loaded=True,
        keywords=("with patient", "loaded"),
    ),
    TariffEntry(
        tariff_code="142",
        description="ALS Mileage without patient (callout / RTB) [ALS]",
        category=TariffCategory.MILEAGE,
        primary_rate=40.00, iht_rate=44.00,
        unit="per km", level="ALS", loaded=False,
        keywords=("without patient", "unloaded", "callout"),
    ),
)


# ── Accessors used by tariff_engine (replaces DB queries) ───────────────────

def all_tariffs() -> list[TariffEntry]:
    """All active tariff entries — the equivalent of a full gems_tariffs scan."""
    return [t for t in TARIFFS if t.is_active]


def all_base_rates() -> list[TariffEntry]:
    """Replaces `select(GemsTariff).where(category == BASE_RATE)`."""
    return [t for t in TARIFFS if t.is_active and t.category == TariffCategory.BASE_RATE]


def all_mileage() -> list[TariffEntry]:
    """Replaces `select(GemsTariff).where(category == MILEAGE)`."""
    return [t for t in TARIFFS if t.is_active and t.category == TariffCategory.MILEAGE]


def base_rates_for_level(level: str) -> list[TariffEntry]:
    """Filter base-rate rows by `[LEVEL]` bracket tag in description."""
    tag = f"[{level.upper()}]"
    return [t for t in all_base_rates() if tag in (t.description or "").upper()]


def mileage_row(level: str, loaded: bool) -> TariffEntry | None:
    """Direct-match mileage lookup (level + loaded flag) — preferred over keyword hunt."""
    lvl = level.upper()
    for t in all_mileage():
        if t.level == lvl and t.loaded == loaded:
            return t
    return None


# By-code index for O(1) lookups
BY_CODE: dict[str, TariffEntry] = {t.tariff_code: t for t in TARIFFS}


# ═══════════════════════════════════════════════════════════════════════════
# RULES — evaluated by rule_engine.evaluate_rules() for each claim
# ═══════════════════════════════════════════════════════════════════════════
# Predicates work over the flat `claim_context` dict that
# rule_engine.build_claim_context produces. Field names available include:
#   patient_id_number, scheme_member_number, dispatch_type, preauth_number,
#   referring_doctor_pr, level_of_care, icd10_primary, icd10_external_cause,
#   cpt_codes (list), descriptions (list), plus passthroughs from
#   extracted_data: scene_minutes, handover_minutes, total_distance_km,
#   loaded_distance_km, rtb_distance_km, callout_distance_km, patient_count,
#   highest_crew_qual, vitals_count, has_ecg_attached, patient_signature,
#   handover_signature, ils_intervention_performed, als_intervention_performed,
#   resuscitation_performed, rosc_achieved, iv_line_placed, iv_active_infusion,
#   ventilator_in_use, ventilator_settings_recorded, blood_gas_attached,
#   pre_planned_event, deceased_on_scene, declaration_of_death_completed,
#   call_out_fee_dispatched_by_emed, vehicle_tracking_report.

# ── Predicate helpers ───────────────────────────────────────────────────────

def _level(c: dict) -> str:
    return (c.get("level_of_care") or "").strip().upper()


def _f(c: dict, key: str) -> float:
    try:
        return float(c.get(key) or 0)
    except (TypeError, ValueError):
        return 0.0


def _is_iht(c: dict) -> bool:
    return (c.get("dispatch_type") or "").strip().upper() in (
        "IFT", "IHT", "TRANSFER", "RHT", "COURTESY",
    )


def _has_motivation(c: dict) -> bool:
    return bool(
        (c.get("motivation_notes") or c.get("clinical_notes") or "").strip()
    )


def _scene_cap_for_level(level: str) -> int:
    if level == "ALS" or level == "ICU":
        return SCENE_MAX_MIN_ALS
    if level == "ILS":
        return SCENE_MAX_MIN_ILS
    return SCENE_MAX_MIN_BLS


def _handover_cap_for_level(level: str) -> int:
    if level in ("ALS", "ICU"):
        return HANDOVER_MAX_MIN_ALS
    return HANDOVER_MAX_MIN_BLS


# ── The PDF-grounded rule set ───────────────────────────────────────────────

RULES: tuple[Rule, ...] = (

    # ── §3-§5: Reference number + claim window ──────────────────────────
    Rule(
        name="GEMS: EMED reference number required",
        description=(
            "GEMS Claims Manual §3-§5: every claim must carry an EMED pre- or "
            "post-authorisation reference number. Claims without a reference "
            "are not adjudicated."
        ),
        rule_type=RuleType.VALIDATION,
        severity=RuleSeverity.CRITICAL,
        predicate=lambda c: not (
            c.get("preauth_number") or c.get("emed_reference_number")
        ),
        action=RuleAction.FLAG_RFI,
        reason="GEMS EMED reference number is missing — claim cannot be adjudicated",
        rfi_code="MISSING_PREAUTH",
    ),

    # ── §5.2 / §8.1: Mandatory invoice + PRF data fields ────────────────
    Rule(
        name="GEMS: Member number required",
        description="GEMS Manual §5.2 + §8.1: full 9-digit membership number must appear on every claim.",
        rule_type=RuleType.VALIDATION,
        severity=RuleSeverity.CRITICAL,
        predicate=lambda c: not (c.get("scheme_member_number") or c.get("medical_aid_number")),
        action=RuleAction.FLAG_RFI,
        reason="GEMS member number is missing",
        rfi_code="MISSING_SCHEME_INFO",
    ),
    Rule(
        name="GEMS: Patient ID or DOB required",
        description="GEMS Manual §5.2 + §8.1: patient date of birth or ID number is mandatory.",
        rule_type=RuleType.VALIDATION,
        severity=RuleSeverity.CRITICAL,
        predicate=lambda c: not (
            c.get("patient_id_number") or c.get("patient_id") or c.get("patient_dob")
        ),
        action=RuleAction.FLAG_RFI,
        reason="Patient ID number or date of birth is missing",
        rfi_code="MISSING_PATIENT_ID",
    ),
    Rule(
        name="GEMS: Dependent code required",
        description="GEMS Manual §5.2 + §8.1: dependent code as it appears on the membership card is required.",
        rule_type=RuleType.VALIDATION,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: not (
            c.get("dependant_code") or c.get("dependent_number")
        ),
        action=RuleAction.FLAG_RFI,
        reason="Dependent code is missing",
        rfi_code="MISSING_SCHEME_INFO",
    ),

    # ── §10.1: Crew composition (Reg 11 + HPCSA + DoH EMS Regs 2017) ────
    Rule(
        name="GEMS: Two BLS crew is not billable",
        description=(
            "GEMS Manual §10.1: claims completed with two BLS crew only are rejected. "
            "All vehicles must be crewed to a minimum of ILS or include an independent "
            "supervising practitioner identified on the PRF "
            "(HPCSA Jun 2017 §2.1; DoH EMS Regs 1 Dec 2017 §7.2). "
            "An identified supervising practitioner satisfies the staffing requirement "
            "and the claim is NOT rejected."
        ),
        rule_type=RuleType.VALIDATION,
        severity=RuleSeverity.CRITICAL,
        predicate=lambda c: (
            (c.get("highest_crew_qual") or "").upper() == "BLS"
            and (c.get("crew_member_2_qualification") or "").upper() == "BLS"
            # Softened 2026-05-16: an identified supervising practitioner
            # (HPCSA Jun 2017 §2.1) satisfies the staffing requirement, so
            # the rejection only fires when no supervisor is on the PRF.
            and not (c.get("supervising_practitioner_pr") or "").strip()
        ),
        action=RuleAction.REJECT,
        reason="Two BLS-only crew on one ambulance with no supervising practitioner — claim rejected.",
        rfi_code="INVALID_PROVIDER",
    ),

    # ── §10.1: Patient signature for transport / refusal ────────────────
    Rule(
        name="GEMS: Patient (or guardian) signature required",
        description=(
            "GEMS Manual §10.1.23: patient or guardian signature acknowledges "
            "transportation. Where unobtainable, a documented reason and a "
            "witness signature are required."
        ),
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: (
            not c.get("patient_signature")
            and not c.get("witness_signature")
            and not (c.get("signature_refused_reason") or "").strip()
        ),
        action=RuleAction.FLAG_RFI,
        reason="Patient/guardian signature missing without documented reason",
        rfi_code="MISSING_SIGNATURE",
    ),

    # ── §10.1.24: Handover signature required ───────────────────────────
    Rule(
        name="GEMS: Handover signature required for transport",
        description=(
            "GEMS Manual §10.1.24: receiving practitioner's signature and "
            "qualification acknowledges receipt of patient. Failure to submit "
            "signed handover documentation results in claim rejection."
        ),
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: (
            _f(c, "loaded_distance_km") > 0
            and bool(c.get("receiving_facility"))
            and not c.get("handover_signature")
        ),
        action=RuleAction.FLAG_RFI,
        reason="Handover signature is missing on a transported patient",
        rfi_code="MISSING_SIGNATURE",
    ),

    # ── §10.1.18: Two sets of vitals minimum ────────────────────────────
    Rule(
        name="GEMS: Two sets of vitals minimum",
        description=(
            "GEMS Manual §10.1.18: vitals must be documented at intervals "
            "determined by patient priority (minimum 2 sets), with equipment "
            "used clearly indicated."
        ),
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: int(c.get("vitals_count") or 0) < VITALS_SETS_MINIMUM,
        action=RuleAction.FLAG_RFI,
        reason=f"Fewer than {VITALS_SETS_MINIMUM} vitals sets recorded on the PRF",
        rfi_code="POLICY_VIOLATION",
    ),

    # ── §10.1.16: External cause code for S/T ICD-10 ────────────────────
    Rule(
        name="GEMS: S/T ICD-10 needs external cause code",
        description=(
            "GEMS Manual §10.1.16: injury / poisoning ICD-10 codes (S* / T*) "
            "must be accompanied by an external cause code beginning with V, "
            "W, X, or Y. Z codes cannot be used as a diagnosis."
        ),
        rule_type=RuleType.VALIDATION,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: (
            (c.get("icd10_primary") or "").strip().upper().startswith(("S", "T"))
            and not c.get("icd10_external_cause")
        ),
        action=RuleAction.FLAG_RFI,
        reason="Primary S/T ICD-10 requires an external cause code (V/W/X/Y, 5 digits)",
        rfi_code="MISSING_EXTERNAL_CAUSE",
    ),
    Rule(
        name="GEMS: External cause must start V/W/X/Y, not Z",
        description="GEMS Manual §10.1.16: codes starting with Z cannot be used as a diagnosis.",
        rule_type=RuleType.VALIDATION,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: (c.get("icd10_primary") or "").strip().upper().startswith("Z"),
        action=RuleAction.FLAG_RFI,
        reason="Z-codes are not acceptable as a primary diagnosis on a GEMS EMS claim",
        rfi_code="INVALID_ICD10",
    ),

    # ── §10: IFT pre-authorisation ──────────────────────────────────────
    Rule(
        name="GEMS: IFT requires pre-authorisation",
        description=(
            "GEMS Manual §10: inter-facility transfers without pre-authorisation "
            "are excluded from cover."
        ),
        rule_type=RuleType.PREAUTH,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: (_is_iht(c) and not c.get("preauth_number")),
        action=RuleAction.FLAG_RFI,
        reason="GEMS IFT requires pre-authorisation",
        rfi_code="MISSING_PREAUTH",
    ),
    Rule(
        name="GEMS: IFT requires referring doctor",
        description=(
            "GEMS Manual §10.2: both referring and receiving doctors must be "
            "noted on the PRF for inter-facility transfers."
        ),
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: (
            _is_iht(c)
            and not (c.get("referring_doctor_pr") or c.get("referring_doctor"))
        ),
        action=RuleAction.FLAG_RFI,
        reason="IFT call requires referring doctor PR / name on the PRF",
        rfi_code="MISSING_REFERRING_DR",
    ),

    # ── §8.3: Scene-time caps with motivation override ──────────────────
    Rule(
        name="GEMS: Scene time exceeds level cap without motivation",
        description=(
            "GEMS Manual §8.3: BLS 15 min, ILS 20 min, ALS/ICU 30 min on-scene "
            "caps. Prolonged bedside time is acknowledged only when motivation "
            "accompanies initial submission."
        ),
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: (
            _f(c, "scene_minutes") > _scene_cap_for_level(_level(c))
            and not _has_motivation(c)
        ),
        action=RuleAction.FLAG_RFI,
        reason="On-scene time exceeds the per-level cap without a written motivation",
        rfi_code="POLICY_VIOLATION",
    ),

    # ── §8.3: Handover time caps with motivation override ───────────────
    Rule(
        name="GEMS: Handover time exceeds level cap without motivation",
        description=(
            "GEMS Manual §8.3: BLS/ILS handover ≤15 min, ALS/ICU ≤20 min. "
            "Extended treatment time is only acknowledged with motivation at "
            "initial submission."
        ),
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.LOW,
        predicate=lambda c: (
            _f(c, "handover_minutes") > _handover_cap_for_level(_level(c))
            and not _has_motivation(c)
        ),
        action=RuleAction.FLAG_RFI,
        reason="Handover time exceeds the per-level cap without a written motivation",
        rfi_code="POLICY_VIOLATION",
    ),

    # ── §8.2: Multi-patient cap (4+ not billable) ──────────────────────
    Rule(
        name="GEMS: 4th patient on a single ambulance is not billable",
        description=(
            "GEMS Manual §8.2: 1 P1 alone, or up to 3 P2/P3 patients capped "
            "at 150% total. The 4th and any extra parties are not billable."
        ),
        rule_type=RuleType.EXCLUSION,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: int(c.get("patient_count") or 1) > MAX_BILLABLE_PATIENTS,
        action=RuleAction.WARN,
        reason="Patients beyond the 3rd on a single ambulance are not billable.",
    ),
    Rule(
        name="GEMS: Priority 1 patient must be transported alone",
        description=(
            "GEMS Manual §8.2: only one P1 patient per ambulance is accepted "
            "and paid; no other patients may be billed alongside a P1."
        ),
        rule_type=RuleType.PRICING,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: (
            (c.get("priority") or "").strip().upper() == "RED"
            and int(c.get("patient_count") or 1) > 1
        ),
        action=RuleAction.FLAG_RFI,
        reason="P1 (RED) patients must be transported alone — additional patients are not billable",
        rfi_code="POLICY_VIOLATION",
    ),

    # ── §10: Excluded scenarios — non-emergency / pre-planned ──────────
    Rule(
        name="GEMS: Pre-planned events not covered",
        description=(
            "GEMS Manual §10: transportation for pre-planned events "
            "(including renal dialysis and oncology transfers) is not covered."
        ),
        rule_type=RuleType.EXCLUSION,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: bool(c.get("pre_planned_event")),
        action=RuleAction.REJECT,
        reason="Pre-planned event transportation is excluded under GEMS EMS benefit",
        rfi_code="POLICY_VIOLATION",
    ),
    Rule(
        name="GEMS: Direct admission bypassing casualty requires lifesaving justification",
        description=(
            "GEMS Manual §10: direct admission (where casualty is bypassed and "
            "EMED is not notified) is not covered, except where lifesaving "
            "interventions occur (e.g. direct Cath Lab delivery)."
        ),
        rule_type=RuleType.PREAUTH,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: (
            bool(c.get("direct_admission"))
            and not c.get("emed_notified")
            and not c.get("lifesaving_intervention_required")
        ),
        action=RuleAction.FLAG_RFI,
        reason="Direct admission without EMED notification or lifesaving justification",
        rfi_code="POLICY_VIOLATION",
    ),

    # ── §10.1: ILS only with valid IV justification ─────────────────────
    Rule(
        name="GEMS: ILS billed without ILS-justifying IV intervention",
        description=(
            "GEMS Manual §10.1: ILS level may be billed only where IV access is "
            "used for fluid replacement in a fluid-depleted/hemodynamically "
            "compromised patient, ILS-scope medication administration, or a "
            "compromised patient with abnormal vitals at acute deterioration risk."
        ),
        rule_type=RuleType.PRICING,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: (
            _level(c) == "ILS"
            and not c.get("ils_intervention_performed")
            and not c.get("als_intervention_performed")
            and not c.get("resuscitation_performed")
        ),
        action=RuleAction.FLAG_RFI,
        reason="ILS billed without documented ILS-scope IV intervention",
        rfi_code="UPCODING_SUSPECTED",
    ),

    # ── §10.1.26: Resuscitation fee criteria ────────────────────────────
    Rule(
        name="GEMS: Resus fee + transport requires ROSC + perfusing rhythm at handover",
        description=(
            "GEMS Manual §10.1.26: ALS/ILS transport fee may be charged WITH a "
            "resuscitation fee only when ROSC is achieved post-CPR and the "
            "patient is handed over with a perfusing ECG rhythm."
        ),
        rule_type=RuleType.PRICING,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: (
            "151" in (c.get("cpt_codes") or [])
            and _f(c, "loaded_distance_km") > 0
            and not (c.get("rosc_achieved") and c.get("perfusing_rhythm_on_handover"))
        ),
        action=RuleAction.FLAG_RFI,
        reason=(
            "Resus fee billed with transport but ROSC + perfusing rhythm at "
            "handover not documented"
        ),
        rfi_code="POLICY_VIOLATION",
    ),
    Rule(
        name="GEMS: Resus fee requires ACLS-class intervention",
        description=(
            "GEMS Manual §10.1.26: resus fee may only be billed when an ILS/ALS "
            "vehicle attempts resuscitation using ACLS interventions (advanced "
            "cardiac drugs, defibrillation/cardioversion, external cardiac "
            "pacing, or endotracheal intubation with assisted ventilation)."
        ),
        rule_type=RuleType.PRICING,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: (
            "151" in (c.get("cpt_codes") or [])
            and _level(c) not in ("ILS", "ALS")
        ),
        action=RuleAction.FLAG_RFI,
        reason="Resus fee (code 151) requires ILS or ALS level of care.",
        rfi_code="UPCODING_SUSPECTED",
    ),

    # ── §10.1.25: Cardiac case requires ECG attachment ──────────────────
    Rule(
        name="GEMS: Cardiac incident requires ECG / rhythm strip",
        description=(
            "GEMS Manual §10.1.25: where a cardiac incident is documented, "
            "diagnosed, or where cardiac-specific ALS medication is "
            "administered, a 12-lead ECG or rhythm strip must accompany the "
            "PRF submission. Same applies to unsuccessful resuscitation / "
            "Declaration of Death."
        ),
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: (
            (
                bool(c.get("cardiac_incident"))
                or (c.get("icd10_primary") or "").strip().upper().startswith("I")
                or bool(c.get("declaration_of_death_completed"))
            )
            and not c.get("has_ecg_attached")
        ),
        action=RuleAction.FLAG_RFI,
        reason="Cardiac case / Declaration of Death without 12-lead ECG or rhythm strip",
        rfi_code="POLICY_VIOLATION",
    ),

    # ── §10.2: Ventilator IFT must include settings + blood gas ─────────
    Rule(
        name="GEMS: Ventilated IFT requires settings + blood gas",
        description=(
            "GEMS Manual §10.2: where a ventilator is used, all ventilator "
            "settings must be detailed on the PRF and at minimum one Blood Gas "
            "Analysis must accompany the documentation."
        ),
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: (
            bool(c.get("ventilator_in_use"))
            and not (c.get("ventilator_settings_recorded") and c.get("blood_gas_attached"))
        ),
        action=RuleAction.FLAG_RFI,
        reason="Ventilated IFT missing ventilator settings or blood gas attachment",
        rfi_code="POLICY_VIOLATION",
    ),

    # ── §9: Call-out fee gates ──────────────────────────────────────────
    Rule(
        name="GEMS: Call-out fee only for EMED-dispatched cases",
        description=(
            "GEMS Manual §9: only Contracted Network Providers may claim "
            "call-out fees, and only for cases dispatched by EMED. Self-sourced "
            "calls are ineligible."
        ),
        rule_type=RuleType.PRICING,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: (
            bool(c.get("call_out_fee_claimed"))
            and not c.get("call_out_fee_dispatched_by_emed")
        ),
        action=RuleAction.REJECT,
        reason="Call-out fee claimed on a self-sourced (non-EMED-dispatched) call",
        rfi_code="POLICY_VIOLATION",
    ),
    Rule(
        name="GEMS: Call-out fee requires PRF + tracking report",
        description=(
            "GEMS Manual §9 (point 6): all call-out fee claims must be "
            "accompanied by a PRF and a vehicle tracking report. If a tracking "
            "error occurred, the tracking company must supply a letter on "
            "official letterhead confirming the date/time/reason."
        ),
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: (
            bool(c.get("call_out_fee_claimed"))
            and not (c.get("vehicle_tracking_report") or c.get("tracking_error_letter"))
        ),
        action=RuleAction.FLAG_RFI,
        reason="Call-out fee claimed without tracking report (or tracking-error letter)",
        rfi_code="POLICY_VIOLATION",
    ),

    # ── §10.1: Closest appropriate facility ─────────────────────────────
    Rule(
        name="GEMS: Bypassing closest appropriate facility requires motivation",
        description=(
            "GEMS Manual §10 + §10.1: patient must be transported to the "
            "closest and most appropriate facility per scheme rules. "
            "Non-compliance is repriced to the nearest capable facility unless "
            "a medically-justifiable reason is documented at initial submission."
        ),
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: (
            bool(c.get("closest_facility_bypassed"))
            and not _has_motivation(c)
        ),
        action=RuleAction.FLAG_RFI,
        reason="Closest appropriate facility bypassed without documented motivation",
        rfi_code="POLICY_VIOLATION",
    ),
)


# ═══════════════════════════════════════════════════════════════════════════
# EXCLUSIONS + PRE-AUTH (PDF §10)
# ═══════════════════════════════════════════════════════════════════════════

EXCLUSIONS: tuple[str, ...] = (
    # Non-life-threatening / non-hospital destinations (Manual §10)
    "transport to doctor's rooms",
    "transport to clinic without 24-hour trauma facility",
    "transport home without authorisation",
    "transport to non-clinical residence without authorisation",
    "transport to old age home",

    # Pre-planned events (Manual §10)
    "renal dialysis transfer",
    "oncology transfer",
    "follow-up consultation transfer",
    "planned procedure transfer",
    "planned admission transfer",

    # Bypass / direct admission (Manual §10)
    "direct admission bypassing casualty without EMED notification",
    "transport to specialist without pre-authorisation",
    "inter-facility transfer without pre-authorisation",
    "bypassing closest appropriate facility",
)

PREAUTH_CPT_CODES: frozenset[str] = frozenset({
    # GEMS does not enumerate procedure codes that always require pre-auth in
    # the 2023 Manual — pre-auth is contextual (any IFT requires EMED reference,
    # all calls require an EMED reference). Keep this set empty until a
    # gazetted code-level pre-auth list is published.
})
