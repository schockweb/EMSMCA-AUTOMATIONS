"""
Discovery Health — hardcoded ambulance billing rules.

Source of truth:
    "Discovery Ambulance Guidelines — March 2023"
    Discovery Health (Pty) Ltd. Registration 1997/013480/07.

Discovery references the NHRPL 2006 (Section 32) for codes and rules. The
Scheme rules state that any provider claiming from a Discovery-administered
scheme is bound by those rates and rules. Discovery audits are retrospective
(3 years standard, 5 years if a concern is raised) under Section 59(3) of the
Medical Schemes Act — every rule in this module exists to keep the practice
*ahead* of that audit, not to react to it.

⚠️  RATE PLACEHOLDERS  ⚠️
The Rand values in `TARIFFS` below are NHRPL-2006-pattern testing rates. The
Discovery PDF defines rules and time/distance limits but does NOT publish a
fee schedule — rates come from the NHRPL 2006 government gazette. Replace
with the authoritative current rates from the gazette before production.

Description strings are load-bearing
------------------------------------
The tariff engine matches rows by phrases like "up to 45", "every 15",
"call out fee", "with patient", "loaded", "without patient", "return". Do
NOT paraphrase descriptions without updating tariff_engine.py in lockstep.
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
)

logger = logging.getLogger("ems.rules.discovery")


# ── Module identity ─────────────────────────────────────────────────────────
SCHEME_ID = "discovery"
SCHEME_KEYWORDS: tuple[str, ...] = (
    "discovery",
    "discovery health",
    "discovery health medical scheme",
    "dhms",
)
PAYER_TYPE: str = "SCHEME"


# ═══════════════════════════════════════════════════════════════════════════
# DISCOVERY-SPECIFIC LIMITS (PDF §"General standard guidelines")
# ═══════════════════════════════════════════════════════════════════════════
# Keep these as named constants so callers (rule_engine, adjudication) can
# reference them by name and so a PR diff makes any policy change explicit.

# Handover time caps
HANDOVER_MAX_MIN_BLS = 10
HANDOVER_MAX_MIN_ILS = 10
HANDOVER_MAX_MIN_ALS = 20

# Travel-time reasonableness (used to flag implausible scene/transport durations)
RESPONSE_AVG_KMH = 60   # 1 minute per km
TRANSFER_AVG_KMH = 40   # 1.5 minutes per km

# On-scene time cap (max billable scene minutes without motivation)
SCENE_MAX_MIN_DEFAULT = 20

# IFT pre-auth threshold
IFT_PREAUTH_KM_THRESHOLD = 100   # Any IFT > 100km requires pre-auth (Discovery 911 — 0860 999 911)

# NHRPL 2006 return-leg cap (codes 9112 / 9130 / 9142)
RETURN_LEG_BUFFER_KM = 20        # return km cannot exceed loaded km + 20 unless tracking proves otherwise
RETURN_LEG_CODES: frozenset[str] = frozenset({"9112", "9130", "9142"})

# Multi-patient multipliers (PDF: "Multiple patients treated and transported on one ambulance")
#   1st patient: 100% of rate
#   2nd patient: 75% of rate at that patient's level of care
#   3rd patient: 50% of rate at that patient's level of care
#   4th+:        not billable
MAX_BILLABLE_PATIENTS = 3


# ═══════════════════════════════════════════════════════════════════════════
# TARIFFS  —  NHRPL 2006 codes referenced in the Discovery PDF
# ═══════════════════════════════════════════════════════════════════════════
# Rates are placeholders. The PDF references these specific NHRPL 2006 codes:
#   125  — ILS up to 45min (used for "treated, transport refused once stable")
#   151  — Resuscitation/Paramedic intervention on scene
#   9112 — BLS return, not patient carrying
#   9130 — ILS return, not patient carrying
#   9142 — ALS return, not patient carrying

TARIFFS: tuple[TariffEntry, ...] = (
    # ────────── BLS Base Rates ──────────
    TariffEntry(
        tariff_code="100",
        description="BLS Base Rate [BLS] Up to 45 min",
        category=TariffCategory.BASE_RATE,
        primary_rate=2900.00, iht_rate=3200.00,
        unit="per call", level="BLS",
        keywords=("up to 45",),
    ),
    TariffEntry(
        tariff_code="103",
        description="BLS Every 15 min extension [BLS]",
        category=TariffCategory.BASE_RATE,
        primary_rate=720.00, iht_rate=820.00,
        unit="per 15 min", level="BLS",
        keywords=("every 15",),
    ),
    TariffEntry(
        tariff_code="104",
        description="BLS IHT Call Out Fee [BLS]",
        category=TariffCategory.BASE_RATE,
        primary_rate=0.00, iht_rate=480.00,
        unit="per call", level="BLS",
        keywords=("call out fee",),
    ),

    # ────────── ILS Base Rates ──────────
    TariffEntry(
        tariff_code="125",
        description="ILS Base Rate [ILS] Up to 45 min",
        category=TariffCategory.BASE_RATE,
        primary_rate=3950.00, iht_rate=4250.00,
        unit="per call", level="ILS",
        keywords=("up to 45",),
    ),
    TariffEntry(
        tariff_code="127",
        description="ILS Every 15 min extension [ILS]",
        category=TariffCategory.BASE_RATE,
        primary_rate=850.00, iht_rate=950.00,
        unit="per 15 min", level="ILS",
        keywords=("every 15",),
    ),
    TariffEntry(
        tariff_code="126",
        description="ILS IHT Call Out Fee [ILS]",
        category=TariffCategory.BASE_RATE,
        primary_rate=0.00, iht_rate=620.00,
        unit="per call", level="ILS",
        keywords=("call out fee",),
    ),

    # ────────── ALS Base Rates ──────────
    TariffEntry(
        tariff_code="131",
        description="ALS Base Rate [ALS] Up to 60 min",
        category=TariffCategory.BASE_RATE,
        primary_rate=5400.00, iht_rate=5950.00,
        unit="per call", level="ALS",
        keywords=("up to 60",),
    ),
    TariffEntry(
        tariff_code="133",
        description="ALS Every 15 min extension [ALS]",
        category=TariffCategory.BASE_RATE,
        primary_rate=1080.00, iht_rate=1200.00,
        unit="per 15 min", level="ALS",
        keywords=("every 15",),
    ),
    TariffEntry(
        tariff_code="134",
        description="ALS IHT Call Out Fee [ALS]",
        category=TariffCategory.BASE_RATE,
        primary_rate=0.00, iht_rate=780.00,
        unit="per call", level="ALS",
        keywords=("call out fee",),
    ),
    TariffEntry(
        tariff_code="151",
        description="ALS Paramedic intervention / Resuscitation on scene [ALS]",
        category=TariffCategory.PROCEDURE,
        primary_rate=2200.00, iht_rate=2200.00,
        unit="per call", level="ALS",
        keywords=("resuscitation",),
        notes="PDF: bill 151 when ALS-equivalent intervention is on scene, regardless of outcome",
    ),

    # ────────── BLS Mileage ──────────
    TariffEntry(
        tariff_code="9111",
        description="BLS Mileage with patient (loaded) [BLS]",
        category=TariffCategory.MILEAGE,
        primary_rate=40.00, iht_rate=44.00,
        unit="per km", level="BLS", loaded=True,
        keywords=("with patient", "loaded"),
    ),
    TariffEntry(
        tariff_code="9112",
        description="BLS Return without patient (callout / RTB) [BLS]",
        category=TariffCategory.MILEAGE,
        primary_rate=30.00, iht_rate=34.00,
        unit="per km", level="BLS", loaded=False,
        keywords=("without patient", "unloaded", "return", "callout"),
        notes="NHRPL return code — Discovery caps at loaded_km + 20km without tracking proof",
    ),

    # ────────── ILS Mileage ──────────
    TariffEntry(
        tariff_code="9128",
        description="ILS Mileage with patient (loaded) [ILS]",
        category=TariffCategory.MILEAGE,
        primary_rate=46.00, iht_rate=50.00,
        unit="per km", level="ILS", loaded=True,
        keywords=("with patient", "loaded"),
    ),
    TariffEntry(
        tariff_code="9130",
        description="ILS Return without patient (callout / RTB) [ILS]",
        category=TariffCategory.MILEAGE,
        primary_rate=36.00, iht_rate=40.00,
        unit="per km", level="ILS", loaded=False,
        keywords=("without patient", "unloaded", "return", "callout"),
        notes="NHRPL return code — Discovery caps at loaded_km + 20km without tracking proof",
    ),

    # ────────── ALS Mileage ──────────
    TariffEntry(
        tariff_code="9141",
        description="ALS Mileage with patient (loaded) [ALS]",
        category=TariffCategory.MILEAGE,
        primary_rate=52.00, iht_rate=56.00,
        unit="per km", level="ALS", loaded=True,
        keywords=("with patient", "loaded"),
    ),
    TariffEntry(
        tariff_code="9142",
        description="ALS Return without patient (callout / RTB) [ALS]",
        category=TariffCategory.MILEAGE,
        primary_rate=42.00, iht_rate=46.00,
        unit="per km", level="ALS", loaded=False,
        keywords=("without patient", "unloaded", "return", "callout"),
        notes="NHRPL return code — Discovery caps at loaded_km + 20km without tracking proof",
    ),
)


# ── Accessors used by tariff_engine (replaces DB queries) ───────────────────

def all_tariffs() -> list[TariffEntry]:
    return [t for t in TARIFFS if t.is_active]


def all_base_rates() -> list[TariffEntry]:
    return [t for t in TARIFFS if t.is_active and t.category == TariffCategory.BASE_RATE]


def all_mileage() -> list[TariffEntry]:
    return [t for t in TARIFFS if t.is_active and t.category == TariffCategory.MILEAGE]


def base_rates_for_level(level: str) -> list[TariffEntry]:
    tag = f"[{level.upper()}]"
    return [t for t in all_base_rates() if tag in (t.description or "").upper()]


def mileage_row(level: str, loaded: bool) -> TariffEntry | None:
    lvl = level.upper()
    for t in all_mileage():
        if t.level == lvl and t.loaded == loaded:
            return t
    return None


BY_CODE: dict[str, TariffEntry] = {t.tariff_code: t for t in TARIFFS}


# ═══════════════════════════════════════════════════════════════════════════
# RULES — evaluated by rule_engine.evaluate_rules() for each claim
# ═══════════════════════════════════════════════════════════════════════════
# Predicates work over the flat `claim_context` dict that
# rule_engine.build_claim_context produces. Field names available:
#   patient_id_number, scheme_member_number, dispatch_type, preauth_number,
#   referring_doctor_pr, level_of_care, icd10_primary, total_amount,
#   cpt_codes (list), icd10_codes (list), descriptions (list),
#   plus extracted_data passthroughs: scene_minutes, total_distance_km,
#   loaded_distance_km, rtb_distance_km, callout_distance_km, patient_count,
#   highest_crew_qual.

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


RULES: tuple[Rule, ...] = (
    # ── Pre-auth & transfers (PDF §"Inter-facility transfers") ──
    Rule(
        name="Discovery: IFT >100km requires pre-authorisation",
        description=(
            "Discovery Ambulance Guidelines March 2023, §Inter-facility transfers: "
            "Any inter-hospital transfer exceeding 100km travel must be pre-authorised "
            "via Discovery 911 (0860 999 911) with km and reason supplied beforehand."
        ),
        rule_type=RuleType.PREAUTH,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: (
            _is_iht(c)
            and _f(c, "total_distance_km") > IFT_PREAUTH_KM_THRESHOLD
            and not c.get("preauth_number")
        ),
        action=RuleAction.FLAG_RFI,
        reason="IFT > 100km requires Discovery 911 pre-authorisation",
        rfi_code="MISSING_PREAUTH",
    ),

    # ── Mandatory data fields ──
    Rule(
        name="Discovery: Member number required",
        description="Discovery requires a scheme membership number on every claim (Regulation 5).",
        rule_type=RuleType.VALIDATION,
        severity=RuleSeverity.CRITICAL,
        predicate=lambda c: not (c.get("scheme_member_number") or c.get("member_number")),
        action=RuleAction.FLAG_RFI,
        reason="Discovery member number is missing",
        rfi_code="MISSING_SCHEME_INFO",
    ),
    Rule(
        name="Discovery: Patient ID required",
        description="Discovery requires SA ID (or passport equivalent) on every claim.",
        rule_type=RuleType.VALIDATION,
        severity=RuleSeverity.CRITICAL,
        predicate=lambda c: not (c.get("patient_id_number") or c.get("patient_id")),
        action=RuleAction.FLAG_RFI,
        reason="Patient SA ID number is missing",
        rfi_code="MISSING_PATIENT_ID",
    ),

    # ── Two-BAA staffing rule (PDF §"Funding of BLS only service") ──
    Rule(
        name="Discovery: BLS-only ambulance must have a supervising practitioner",
        description=(
            "PDF §Funding of BLS only service: HPCSA General Board Rulings (June 2017 §2.1) "
            "prohibit two BAAs working independently. The supervising practitioner must be "
            "identified prospectively on the PRF — name + HPCSA registration number."
        ),
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: (
            _level(c) == "BLS"
            # If the highest crew qualification is also BLS and there's no
            # supervising-practitioner field, the claim doesn't satisfy HPCSA staffing rules.
            and (c.get("highest_crew_qual") or "").upper() == "BLS"
            and not c.get("supervising_practitioner_pr")
        ),
        action=RuleAction.FLAG_RFI,
        reason="BLS-only crew requires a supervising practitioner identified on the PRF",
        rfi_code="INVALID_PROVIDER",
    ),

    # ── ICD-10 / external cause for trauma claims ──
    Rule(
        name="Discovery: S/T ICD-10 requires external cause code",
        description=(
            "Discovery (NHRPL 2006 §General coding) requires an external cause code (V/W/X/Y) "
            "alongside any primary injury or poisoning code (S* / T*)."
        ),
        rule_type=RuleType.VALIDATION,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: (
            (c.get("icd10_primary") or "").strip().upper().startswith(("S", "T"))
            and not c.get("icd10_external_cause")
        ),
        action=RuleAction.FLAG_RFI,
        reason="Primary S/T ICD-10 requires an external cause code",
        rfi_code="MISSING_EXTERNAL_CAUSE",
    ),

    # ── Scene time motivation (PDF §"General standard guidelines") ──
    Rule(
        name="Discovery: Scene time over 20 min requires motivation",
        description=(
            "PDF §Time related codes: maximum on-scene billable time is 20 min for the "
            "presenting case. Anything beyond requires a written motivation on the PRF "
            "(retrospective audits will not accept non-clinical delays)."
        ),
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: (
            _f(c, "scene_minutes") > SCENE_MAX_MIN_DEFAULT
            and not (c.get("clinical_notes") or c.get("motivation_notes"))
        ),
        action=RuleAction.FLAG_RFI,
        reason=f"Scene time > {SCENE_MAX_MIN_DEFAULT} min requires written motivation on PRF",
        rfi_code="POLICY_VIOLATION",
    ),

    # ── Handover time motivation ──
    Rule(
        name="Discovery: BLS/ILS handover over 10 min requires motivation",
        description=(
            "PDF §Time related codes: BLS/ILS handover billed at no more than 10 min; "
            "anything beyond must be motivated on the PRF at claim submission."
        ),
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.LOW,
        predicate=lambda c: (
            _level(c) in ("BLS", "ILS")
            and _f(c, "handover_minutes") > HANDOVER_MAX_MIN_BLS
            and not (c.get("clinical_notes") or c.get("motivation_notes"))
        ),
        action=RuleAction.FLAG_RFI,
        reason="BLS/ILS handover > 10 min requires written motivation",
        rfi_code="POLICY_VIOLATION",
    ),
    Rule(
        name="Discovery: ALS handover over 20 min requires motivation",
        description="PDF §Time related codes: ALS handover billed at no more than 20 min.",
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.LOW,
        predicate=lambda c: (
            _level(c) == "ALS"
            and _f(c, "handover_minutes") > HANDOVER_MAX_MIN_ALS
            and not (c.get("clinical_notes") or c.get("motivation_notes"))
        ),
        action=RuleAction.FLAG_RFI,
        reason="ALS handover > 20 min requires written motivation",
        rfi_code="POLICY_VIOLATION",
    ),

    # ── Return-leg km cap (PDF §"Distance travelled with patient > 100km") ──
    Rule(
        name="Discovery: Return km capped at loaded km + 20",
        description=(
            "PDF §Distance travelled with patient > 100km: codes 9112/9130/9142 "
            "(return — not patient carrying) are retrospectively limited to a "
            "maximum of 20km more than the loaded leg, unless tracking reports "
            "are submitted to confirm the extra distance."
        ),
        rule_type=RuleType.PRICING,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: (
            _f(c, "rtb_distance_km") > _f(c, "loaded_distance_km") + RETURN_LEG_BUFFER_KM
            and not c.get("vehicle_tracking_report")
        ),
        action=RuleAction.FLAG_RFI,
        reason=(
            "Return km exceeds loaded km + 20. Attach vehicle tracking report or "
            "the excess will be capped retrospectively."
        ),
        rfi_code="POLICY_VIOLATION",
    ),

    # ── No-transport call-out (PDF §"Where a provider is called to a scene…") ──
    Rule(
        name="Discovery: No-transport call must be billed privately",
        description=(
            "PDF §Where a provider is called to a scene without valid medical need: "
            "no NHRPL 2006 code may be claimed from a Discovery scheme. The caller "
            "must be billed privately (refusal of transport, deceased on arrival "
            "without 151-qualifying resus, first-aid-only treatment)."
        ),
        rule_type=RuleType.EXCLUSION,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: (
            # No transport occurred
            _f(c, "loaded_distance_km") == 0
            and not c.get("receiving_facility")
            # No valid clinical need flagged
            and not c.get("ils_intervention_performed")
            and not c.get("als_intervention_performed")
            and not c.get("resuscitation_performed")
            # No code 151 (resuscitation) on the claim either
            and "151" not in (c.get("cpt_codes") or [])
        ),
        action=RuleAction.REJECT,
        reason=(
            "No clinical intervention and no transport — claim must be billed privately. "
            "Discovery does not pay NHRPL codes for no-medical-need call-outs."
        ),
        rfi_code="POLICY_VIOLATION",
    ),

    # ── ALS billing without intervention (PDF §"ALS treatment") ──
    Rule(
        name="Discovery: ALS billed without ALS intervention",
        description=(
            "PDF §ALS treatment: ALS may not be billed for prophylactic placement of "
            "12-lead ECG, prophylactic anti-emetics, low-dose sedatives without indication, "
            "or 'minimal analgesia with no clinical indication'. Where ALS rides along but "
            "delivers no ALS intervention, the lowest applicable level of care is to be billed."
        ),
        rule_type=RuleType.PRICING,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: (
            _level(c) == "ALS"
            and not c.get("als_intervention_performed")
            and not c.get("resuscitation_performed")
            # No mention of pain score, dosage justification, or motivation note
            and not (c.get("clinical_notes") or c.get("motivation_notes"))
        ),
        action=RuleAction.FLAG_RFI,
        reason=(
            "ALS billed without documented ALS intervention. Provide pain score, dosage, "
            "or referring practitioner motivation, or downgrade to ILS/BLS."
        ),
        rfi_code="UPCODING_SUSPECTED",
    ),

    # ── ILS billing on TKVO IV line (PDF §"Where transport occurs and an IV line is placed") ──
    Rule(
        name="Discovery: TKVO IV line must be billed BLS",
        description=(
            "PDF §Where transport occurs and an IV line is placed: an IV in situ TKVO "
            "(to keep vein open) without ILS-level medication or hypotension/hyperglycaemia "
            "must be billed BLS, not ILS."
        ),
        rule_type=RuleType.PRICING,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: (
            _level(c) == "ILS"
            and bool(c.get("iv_line_placed"))
            and bool(c.get("iv_tkvo"))
            and not c.get("ils_intervention_performed")
        ),
        action=RuleAction.APPLY_MODIFIER,
        reason="TKVO IV line without ILS intervention — downgrade to BLS",
        rfi_code="UPCODING_SUSPECTED",
        modifier="DOWNGRADE_BLS",
    ),

    # ── 4-patient cap (PDF §"Multiple patients treated and transported on one ambulance") ──
    Rule(
        name="Discovery: 4th patient on a single ambulance is not billable",
        description=(
            "PDF §Multiple patients: 1st patient at 100%, 2nd at 75%, 3rd at 50%. "
            "No charge may be raised for the 4th or any additional patients on the same vehicle."
        ),
        rule_type=RuleType.EXCLUSION,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: int(c.get("patient_count") or 1) > MAX_BILLABLE_PATIENTS,
        action=RuleAction.WARN,
        reason="Patients beyond the 3rd on a single ambulance are not billable.",
    ),
)


# ═══════════════════════════════════════════════════════════════════════════
# EXCLUSIONS + PRE-AUTH
# ═══════════════════════════════════════════════════════════════════════════

EXCLUSIONS: tuple[str, ...] = (
    "transfer to domiciliary facility",   # PDF §Social transfers — examples of member-liability scenarios
    "transfer for general follow-up consultation",
    "transfer for planned procedure or admission",
    "patient refused treatment",          # PDF §No medical need
    "first aid only",                     # PDF §No medical need
    "deceased on arrival",                # PDF §No medical need (unless 151 applies)
)

PREAUTH_CPT_CODES: frozenset[str] = frozenset({
    # Discovery does not enumerate procedure codes that always require pre-auth.
    # Pre-auth is triggered by the contextual rule (IFT > 100km) above.
})
