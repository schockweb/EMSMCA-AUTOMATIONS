"""
ER24 Case Management Rules - hardcoded validation / documentation rule module.

Source of truth:
    "ER24 Case Management Rules" (ER24 guidelines for assessing patient report
    forms / deciding the billable level of care for each case).

This is the backend safety-net counterpart to the crew-facing ER24 warnings in
frontend/src/pages/crew/prfValidation.ts. It catches what the in-form guidance
cannot: stale clients running old JS, direct-API submissions, and paper / OCR
claims that never run the React gate at all. Every predicate is None-safe so a
sparsely-populated context (e.g. an OCR claim) can never raise.

PRICING
-------
ER24 has no gazetted fee schedule encoded here. ``PRICING_ENABLED = False`` tells
the tariff engine to treat ER24 exactly as it did before this module existed
("no pricing module configured") so registering the module changes ONLY
adjudication / RFI generation - never pricing. The HPCSA capability matrix (what
each crew qualification may DO) is enforced separately by app.rules.hpcsa_scope.
"""
from __future__ import annotations

import logging
import re

from app.rules.base import Rule, RuleAction, RuleSeverity, RuleType, TariffEntry

logger = logging.getLogger("ems.rules.er24")


# ── Module identity ─────────────────────────────────────────────────────────
SCHEME_ID = "er24"
SCHEME_KEYWORDS: tuple[str, ...] = ("er24", "er 24", "emergency response 24")
PAYER_TYPE: str = "SCHEME"

# Validation / documentation only - ER24 is NOT priced through the hardcoded
# path. The tariff engine checks this flag and falls back to its prior
# "not configured" behaviour, so no pricing regression is introduced.
PRICING_ENABLED: bool = False


# ── ER24 limits (from the ER24 Case Management Rules) ───────────────────────
VITALS_MIN_PRIMARY = 2            # minimum 2 sets of vitals on all patients
VITALS_MIN_IFT = 3               # 3 sets for IFTs (first at referring hospital)
SCENE_MAX_MIN = 20               # primary + routine IFT scene-time allowance
SCENE_MAX_MIN_ICU = 45           # ICU transfers (with motivation)

_IFT_TYPES = {"IFT", "IHT", "TRANSFER", "RHT", "COURTESY"}
_ICD10_RE = re.compile(r"^[A-Z]\d{2}(\.\d{1,3})?$")


# ── None-safe context helpers ───────────────────────────────────────────────
def _s(c: dict, key: str) -> str:
    return str(c.get(key) or "").strip()


def _is_ift(c: dict) -> bool:
    return _s(c, "dispatch_type").upper() in _IFT_TYPES or _s(c, "call_type").upper() in _IFT_TYPES


def _level(c: dict) -> str:
    return _s(c, "level_of_care").upper()


def _num(c: dict, key: str):
    try:
        return float(str(c.get(key)).replace(" ", ""))
    except (TypeError, ValueError):
        return None


def _notes(c: dict) -> str:
    return " ".join(
        _s(c, k) for k in ("clinical_notes", "management_notes", "events_hpi", "findings_on_arrival")
    ).lower()


def _has_motivation(c: dict) -> bool:
    return bool(re.search(r"motivat|extricat|entrap|delay|analges|difficult|complex|prolong", _notes(c)))


def _has_iv(c: dict) -> bool:
    blob = (_s(c, "procedures_performed") + " " + _notes(c)).lower()
    if re.search(r"\biv\b|cannula|intravenous|drip|infus", blob):
        return True
    try:
        return int(c.get("iv_count") or 0) > 0
    except (TypeError, ValueError):
        return False


def _iv_justified(c: dict) -> bool:
    meds = _s(c, "medications_administered").lower()
    return bool(
        "dextrose" in meds
        or re.search(
            r"fluid replac|iv medication|iv drug|during transport|rapidly deterior|"
            r"rapid deterior|abnormal vital|unstable|deranged",
            _notes(c),
        )
    )


# ── Tariffs: ER24 is not priced here (see PRICING_ENABLED) ──────────────────
TARIFFS: tuple[TariffEntry, ...] = ()


# ═══════════════════════════════════════════════════════════════════════════
# RULES  (predicate TRUE == rule MATCHES == finding raised)
# ═══════════════════════════════════════════════════════════════════════════
RULES: tuple[Rule, ...] = (
    # ── Medical Schemes Act 1998 mandatory account fields ────────────────
    Rule(
        name="ER24: Member number required",
        description=(
            "ER24 Case Management Rules - Medical Schemes Act 1998 mandatory "
            "fields: an account without the member's membership number is "
            "rejected immediately."
        ),
        rule_type=RuleType.VALIDATION,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: not (
            c.get("scheme_member_number") or c.get("member_number") or c.get("medical_aid_number")
        ),
        action=RuleAction.FLAG_RFI,
        reason="ER24 claim is missing the member (medical scheme) number",
        rfi_code="MISSING_SCHEME_INFO",
    ),
    Rule(
        name="ER24: Diagnosis ICD-10 required",
        description=(
            "ER24 Case Management Rules - a diagnosis with the relevant ICD-10 "
            "code is a mandatory account field under the Medical Schemes Act."
        ),
        rule_type=RuleType.VALIDATION,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: not _ICD10_RE.match(_s(c, "icd10_primary").upper()),
        action=RuleAction.FLAG_RFI,
        reason="Primary ICD-10 diagnosis code is missing or invalid",
        rfi_code="INVALID_ICD10",
    ),
    # ── Minimum vitals: 2 (3 for IFT, first at referring hospital) ───────
    Rule(
        name="ER24: Minimum vitals sets",
        description=(
            "ER24 Case Management Rules - minimum 2 sets of vitals on all "
            "patients, and 3 sets for inter-facility transfers (the first "
            "recorded at the referring hospital)."
        ),
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: int(c.get("vitals_count") or 0)
        < (VITALS_MIN_IFT if _is_ift(c) else VITALS_MIN_PRIMARY),
        action=RuleAction.FLAG_RFI,
        reason="Fewer than the required vitals sets recorded (2 primary / 3 IFT)",
        rfi_code="POLICY_VIOLATION",
    ),
    # ── IV access must be clinically justified, else downgrade to BLS ────
    Rule(
        name="ER24: IV access not justified - downgrade to BLS",
        description=(
            "ER24 Case Management Rules - IV access is established only for "
            "fluid replacement, IV medication during transport, or a patient "
            "who can rapidly deteriorate with abnormal vitals. Outside these "
            "guidelines it is deemed unnecessary and downgraded to BLS."
        ),
        rule_type=RuleType.MODIFIER,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: (
            _has_iv(c) and _level(c) in ("ILS", "ALS", "ICU") and not _iv_justified(c)
        ),
        action=RuleAction.WARN,
        reason="IV access without a documented indication - ER24 downgrades to BLS",
        rfi_code="LEVEL_DOWNGRADE",
    ),
    # ── Scene time allowance: 20 min (ICU 45) ────────────────────────────
    Rule(
        name="ER24: Scene time exceeds allowance without motivation",
        description=(
            "ER24 Case Management Rules - scene-time allowance is 20 minutes "
            "(primary and most IFTs) or 45 minutes for ICU transfers. Extra "
            "time is cut unless a motivation accompanies the submission."
        ),
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.LOW,
        predicate=lambda c: (
            (_num(c, "scene_minutes") or 0)
            > (SCENE_MAX_MIN_ICU if _level(c) == "ICU" else SCENE_MAX_MIN)
            and not _has_motivation(c)
        ),
        action=RuleAction.WARN,
        reason="On-scene time exceeds the ER24 allowance with no motivation documented",
        rfi_code="DOCUMENTATION_INCOMPLETE",
    ),
    # ── IFT reference number should be noted ─────────────────────────────
    Rule(
        name="ER24: Inter-facility transfer reference number",
        description=(
            "ER24 Case Management Rules - an ER24 reference number should be "
            "noted; level-of-care transfers outside scope must be approved by "
            "the ER24 Contact Centre and the reference recorded on the PRF."
        ),
        rule_type=RuleType.PREAUTH,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: _is_ift(c)
        and not (c.get("preauth_number") or c.get("emed_reference_number")),
        action=RuleAction.WARN,
        reason="Inter-facility transfer has no ER24 reference number recorded",
        rfi_code="MISSING_PREAUTH",
    ),
    # ── Closest most appropriate facility ────────────────────────────────
    Rule(
        name="ER24: Closest appropriate facility bypassed",
        description=(
            "ER24 Case Management Rules - patients are transported to the "
            "closest most appropriate facility; any deviation is for the "
            "patient's / service provider's own account unless justified."
        ),
        rule_type=RuleType.VALIDATION,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: bool(c.get("closest_facility_bypassed")) and not _has_motivation(c),
        action=RuleAction.WARN,
        reason="Closest appropriate facility bypassed without a documented reason",
        rfi_code="POLICY_VIOLATION",
    ),
)


# ── Exclusions + pre-auth ───────────────────────────────────────────────────
EXCLUSIONS: tuple[str, ...] = (
    "declaration of death (non-chargeable)",
    "futile resuscitation attempt (non-chargeable)",
    "non-client call taken on risk (onward bill the patient)",
    "consumables and medication billed separately",
)

PREAUTH_CPT_CODES: frozenset[str] = frozenset()
