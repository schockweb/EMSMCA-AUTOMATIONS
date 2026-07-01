"""
Netcare 911 Case Management Guidelines - hardcoded validation rule module.

Source of truth:
    "Netcare 911 Case Management Guidelines v5.2" (Feb 2023)
    Document ref: NTC911-CM-WI-DC-001 V5.2

Backend safety-net counterpart to the crew-facing Netcare warnings in
frontend/src/pages/crew/prfValidation.ts (the 'netcare'-scoped rule set). It
re-checks Netcare claims that bypass the React gate (stale clients, direct-API
submissions, paper / OCR claims). Every predicate is None-safe.

PRICING
-------
Netcare is not priced through the hardcoded tariff path. ``PRICING_ENABLED =
False`` makes the tariff engine treat Netcare exactly as before this module
existed ("no pricing module configured"), so registering this module changes
ONLY adjudication / RFI generation - never pricing. HPCSA scope of practice is
enforced separately by app.rules.hpcsa_scope.
"""
from __future__ import annotations

import logging
import re

from app.rules.base import Rule, RuleAction, RuleSeverity, RuleType, TariffEntry

logger = logging.getLogger("ems.rules.netcare")


# ── Module identity ─────────────────────────────────────────────────────────
SCHEME_ID = "netcare"
SCHEME_KEYWORDS: tuple[str, ...] = ("netcare", "netcare 911", "ntc911", "ntc 911")
PAYER_TYPE: str = "SCHEME"

# Validation / documentation only - not priced through the hardcoded path.
PRICING_ENABLED: bool = False


# ── Netcare CMG limits ──────────────────────────────────────────────────────
PREAUTH_DIGITS = 13              # §3.2 IFT/IHT pre-auth number length
VITALS_SETS_MINIMUM = 3          # §3.7 minimum 3 sets of vitals
SCENE_MAX_MIN = 20               # §5.2.1 time at scene

_IFT_TYPES = {"IFT", "IHT", "TRANSFER", "RHT", "COURTESY"}
_IHT_STRICT = {"IFT", "IHT"}
_ICD10_RE = re.compile(r"^[A-Z]\d{2}(\.\d{1,3})?$")


# ── None-safe context helpers ───────────────────────────────────────────────
def _s(c: dict, key: str) -> str:
    return str(c.get(key) or "").strip()


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


def _is_iht_strict(c: dict) -> bool:
    return _s(c, "dispatch_type").upper() in _IHT_STRICT or _s(c, "call_type").upper() in _IHT_STRICT


def _valid_patient_id(v: str) -> bool:
    v = re.sub(r"\s", "", v)
    if not v:
        return False
    return bool(re.fullmatch(r"\d{13}", v) or re.fullmatch(r"[A-Za-z0-9]{6,15}", v))


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
            r"hypoglyc|haemodynam|hemodynam|iv inserted prior|prior to arrival|"
            r"unstable|deranged vital",
            _notes(c),
        )
    )


# ── Tariffs: Netcare is not priced here (see PRICING_ENABLED) ───────────────
TARIFFS: tuple[TariffEntry, ...] = ()


# ═══════════════════════════════════════════════════════════════════════════
# RULES  (predicate TRUE == rule MATCHES == finding raised)
# ═══════════════════════════════════════════════════════════════════════════
RULES: tuple[Rule, ...] = (
    # ── §3.2: IFT/IHT requires a 13-digit pre-authorisation number ───────
    Rule(
        name="Netcare: IFT/IHT 13-digit pre-authorisation",
        description=(
            "Netcare CMG §3.2 - all IFTs/IHTs require a 13-digit pre-auth "
            "number obtained before transport, failing which the claim is "
            "immediately rejected."
        ),
        rule_type=RuleType.PREAUTH,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: _is_iht_strict(c)
        and len(re.sub(r"\D", "", _s(c, "preauth_number"))) != PREAUTH_DIGITS,
        action=RuleAction.FLAG_RFI,
        reason="Netcare IFT/IHT requires a 13-digit pre-authorisation number",
        rfi_code="MISSING_PREAUTH",
    ),
    # ── §3.7 / §4: Patient identity ──────────────────────────────────────
    Rule(
        name="Netcare: Valid patient ID / passport",
        description=(
            "Netcare CMG §3.7 + §4 - a valid 13-digit SA ID or passport number "
            "is required for claim submission."
        ),
        rule_type=RuleType.VALIDATION,
        severity=RuleSeverity.HIGH,
        predicate=lambda c: not _valid_patient_id(_s(c, "patient_id_number")),
        action=RuleAction.FLAG_RFI,
        reason="Patient ID number is missing or not a valid SA ID / passport",
        rfi_code="MISSING_PATIENT_ID",
    ),
    # ── §3.7: Minimum 3 sets of vitals ───────────────────────────────────
    Rule(
        name="Netcare: Minimum 3 vitals sets",
        description="Netcare CMG §3.7 - a minimum of 3 sets of vital signs must be submitted on the PRF.",
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: int(c.get("vitals_count") or 0) < VITALS_SETS_MINIMUM,
        action=RuleAction.FLAG_RFI,
        reason="Fewer than 3 vitals sets recorded on the PRF",
        rfi_code="POLICY_VIOLATION",
    ),
    # ── §4: ICD-10 coding ────────────────────────────────────────────────
    Rule(
        name="Netcare: Valid primary ICD-10",
        description="Netcare CMG §4 - correct ICD-10 coding must be used on every claim.",
        rule_type=RuleType.VALIDATION,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: not _ICD10_RE.match(_s(c, "icd10_primary").upper()),
        action=RuleAction.FLAG_RFI,
        reason="Primary ICD-10 code is missing or not in standard format",
        rfi_code="INVALID_ICD10",
    ),
    # ── §3.7: Receiving facility ─────────────────────────────────────────
    Rule(
        name="Netcare: Receiving facility required",
        description="Netcare CMG §3.7 - the receiving facility full physical address is required.",
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: bool(
            c.get("receiving_facility") is not None or c.get("dispatch_type")
        )
        and not _s(c, "receiving_facility")
        and _s(c, "call_type").upper() not in ("DOD", "RHT"),
        action=RuleAction.FLAG_RFI,
        reason="Receiving facility is missing on a transport claim",
        rfi_code="DOCUMENTATION_INCOMPLETE",
    ),
    # ── §3.7: ILS IV must meet one of the accepted indications ───────────
    Rule(
        name="Netcare: ILS IV justification",
        description=(
            "Netcare CMG §3.7 - an IV line at ILS level is billable only for "
            "50% dextrose hypoglycaemia, fluid for haemodynamic compromise, an "
            "IV sited prior to arrival, or an unstable patient with deranged "
            "vitals. Otherwise the claim is downgraded to BLS."
        ),
        rule_type=RuleType.MODIFIER,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: _has_iv(c) and _level(c) == "ILS" and not _iv_justified(c),
        action=RuleAction.WARN,
        reason="ILS IV without an accepted indication - Netcare downgrades to BLS",
        rfi_code="LEVEL_DOWNGRADE",
    ),
    # ── §3.5: Resuscitation fee needs an ALS practitioner ────────────────
    Rule(
        name="Netcare: Resuscitation fee requires ALS",
        description=(
            "Netcare CMG §3.5 - the resuscitation fee requires an ALS "
            "practitioner on scene (plus a second vehicle and an ALS "
            "intervention). A resuscitation billed below ALS is queried."
        ),
        rule_type=RuleType.VALIDATION,
        severity=RuleSeverity.MEDIUM,
        predicate=lambda c: bool(c.get("resuscitation_attempted"))
        and _level(c) not in ("ALS", "ICU"),
        action=RuleAction.WARN,
        reason="Resuscitation fee claimed without an ALS-level practitioner",
        rfi_code="POLICY_VIOLATION",
    ),
    # ── §5.2.1: Scene time over 20 minutes needs motivation ──────────────
    Rule(
        name="Netcare: Scene time exceeds 20 minutes",
        description=(
            "Netcare CMG §5.2.1 - time at scene is capped at 20 minutes; "
            "extended time requires a case-manager motivation on the PRF."
        ),
        rule_type=RuleType.DOCUMENTATION,
        severity=RuleSeverity.LOW,
        predicate=lambda c: (_num(c, "scene_minutes") or 0) > SCENE_MAX_MIN and not _has_motivation(c),
        action=RuleAction.WARN,
        reason="On-scene time exceeds 20 minutes with no motivation documented",
        rfi_code="DOCUMENTATION_INCOMPLETE",
    ),
)


# ── Exclusions + pre-auth ───────────────────────────────────────────────────
EXCLUSIONS: tuple[str, ...] = (
    "inter-facility transfer without 13-digit pre-authorisation",
    "transport with no clinical need documented",
    "scene time beyond 20 minutes without motivation",
)

PREAUTH_CPT_CODES: frozenset[str] = frozenset()
