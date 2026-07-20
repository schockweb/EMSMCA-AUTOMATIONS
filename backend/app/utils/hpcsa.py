"""HPCSA registration-category helpers + scope-of-practice matrix accessor.

`CrewMember.qualification` stores the practitioner's HPCSA registration
category (BAA, AEA, ECT, ECA, ANT, ECP) — the same six codes the frontend
scope matrix at `frontend/src/data/hpcsaScope.ts` is keyed by.

The rules and tariff engines, however, still need to reason about the legacy
SAPAESA billing tier (BLS / ILS / ALS) since that's what the published tariff
codes (121, 125, 131) are pegged to. This module is the single boundary that
translates from category → tier so the rest of the billing pipeline doesn't
have to learn the new taxonomy.

Source of truth for the tier mapping:
  BAA → BLS    (Basic Ambulance Assistant)
  AEA → ILS    (Ambulance Emergency Assistant)
  ECT → ILS    (Emergency Care Technician — HPCSA scope sits above AEA but
                below ANT/ECP; SAPAESA only recognises BLS/ILS/ALS so we
                bill at ILS. Subject to regulatory confirmation.)
  ECA → ILS    (Emergency Care Assistant — same reasoning as ECT.)
  ANT → ALS    (CCA — Critical Care Assistant)
  ECP → ALS    (Emergency Care Practitioner)

──────────────────────────────────────────────────────────────────────────────
SCOPE-OF-PRACTICE MATRIX
──────────────────────────────────────────────────────────────────────────────
The full HPCSA scope matrix (171 capabilities incl. 78 medications) is loaded
at import time from `app/data/hpcsa_scope.json`. That JSON is auto-generated
from the canonical TypeScript matrix — DO NOT edit it directly. Regenerate
after a matrix change with:

    cd frontend && npm run export-scope

This module exposes:
  * `is_authorised(category, capability_key)`
  * `condition_for(category, capability_key)`  — e.g. consultation-required note
  * `find_medication_by_name(name)`            — case-insensitive lookup
  * `scope_for_form_label(label, category)`    — mirrors frontend `scopeForFormLabel`
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger("ems.hpcsa")

# ── Categories ───────────────────────────────────────────────────────────────

HPCSA_CATEGORIES: frozenset[str] = frozenset({
    "BAA", "AEA", "ECT", "ECA", "ANT", "ECP", "DR",
})

DEFAULT_CATEGORY = "AEA"

CATEGORY_TIER: dict[str, str] = {
    "BAA": "BLS",
    "AEA": "ILS",
    "ECT": "ILS",
    "ECA": "ILS",
    "ANT": "ALS",
    "ECP": "ALS",
    "DR":  "ALS",   # Doctor — highest profession; bills at the top tier.
}

# Human labels — kept in sync with `CATEGORY_META` in
# `frontend/src/data/hpcsaScope.ts`. Used in seed/admin tooling.
CATEGORY_LABELS: dict[str, str] = {
    "BAA": "Basic Ambulance Assistant",
    "AEA": "Ambulance Emergency Assistant",
    "ECT": "Emergency Care Technician",
    "ECA": "Emergency Care Assistant",
    "ANT": "Critical Care Assistant",
    "ECP": "Emergency Care Practitioner",
    "DR":  "Doctor",
}

# ── Translation helpers ──────────────────────────────────────────────────────

# Legacy and free-text inputs we may see on existing PRFs, OCR output, or
# anything submitted before the migration. Keys are uppercased / normalised.
_LEGACY_TO_CATEGORY: dict[str, str] = {
    # Legacy SAPAESA tiers — best-effort 1:1 map.
    "BLS": "BAA",
    "ILS": "AEA",
    "ALS": "ECP",   # See `to_tier`'s docstring + migration notes.
    "ICU": "ECP",
    # Free-text variants that have appeared in OCR / paper PRFs.
    "PARAMEDIC":  "ECP",
    "EMT-B":      "BAA",
    "EMT-I":      "AEA",
    "EMT-P":      "ECP",
    "CCA":        "ANT",
    "BASIC":      "BAA",
    "DOCTOR":     "DR",
    "MD":         "DR",
}


def normalise_category(value: str | None) -> str | None:
    """Best-effort normalisation of an input string to an HPCSA category code.

    Returns the canonical category code (one of `HPCSA_CATEGORIES`) when the
    input is recognised, or `None` when it isn't. Callers that want a safe
    fallback should chain ` or DEFAULT_CATEGORY`.
    """
    if not value:
        return None
    key = value.strip().upper()
    if key in HPCSA_CATEGORIES:
        return key
    return _LEGACY_TO_CATEGORY.get(key)


def to_tier(value: str | None, default: str = "ILS") -> str:
    """Translate any practitioner-qualification string to a billing tier.

    Accepts (in order of precedence):
      • A canonical HPCSA category code     → translated via `CATEGORY_TIER`.
      • A legacy SAPAESA tier (BLS/ILS/ALS) → returned as-is (uppercased).
      • Free-text variants the OCR might produce — best-effort.
      • Empty / unrecognised                → `default` (defaults to "ILS").

    Used at the boundary where crew identity feeds into the rules + tariff
    engines, which compare against `LEVEL_RANK = {"BLS":0,"ILS":1,"ALS":2}`
    for billing-cap and two-BLS-crew rejection logic.
    """
    if not value:
        return default
    key = value.strip().upper()
    # Legacy tier — pass through unchanged.
    if key in ("BLS", "ILS", "ALS"):
        return key
    # ICU is a sometimes-seen synonym for the highest tier.
    if key == "ICU":
        return "ALS"
    # Canonical HPCSA category.
    if key in HPCSA_CATEGORIES:
        return CATEGORY_TIER[key]
    # Free-text — try to normalise to a category first, then to tier.
    cat = _LEGACY_TO_CATEGORY.get(key)
    if cat:
        return CATEGORY_TIER[cat]
    return default


# ─────────────────────────────────────────────────────────────────────────────
# Scope-of-practice matrix accessor
# ─────────────────────────────────────────────────────────────────────────────

_SCOPE_PATH = Path(__file__).resolve().parents[1] / "data" / "hpcsa_scope.json"

# Loaded once at module import. The frontend regen script (`npm run
# export-scope`) is the only writer; this module only reads.
_SCOPE: dict
try:
    with _SCOPE_PATH.open("r", encoding="utf-8") as fp:
        _SCOPE = json.load(fp)
    _expected_version = 1
    if _SCOPE.get("version") != _expected_version:
        logger.warning(
            "hpcsa_scope.json version %s — expected %s. Regenerate via `npm run export-scope`.",
            _SCOPE.get("version"), _expected_version,
        )
    logger.info(
        "Loaded HPCSA scope matrix: %d capabilities, %d form-label mappings",
        len(_SCOPE.get("capabilities", {})),
        len(_SCOPE.get("form_label_to_capability", {})),
    )
except FileNotFoundError:
    logger.error(
        "hpcsa_scope.json not found at %s — scope enforcement disabled. "
        "Generate it with `cd frontend && npm run export-scope`.",
        _SCOPE_PATH,
    )
    _SCOPE = {
        "version": 1,
        "consultation_required_text": "",
        "form_label_to_capability": {},
        "capabilities": {},
    }


CONSULTATION_REQUIRED_TEXT: str = _SCOPE.get("consultation_required_text", "")
_CAPABILITIES: dict[str, dict] = _SCOPE.get("capabilities", {})
_FORM_LABEL_TO_CAPABILITY: dict[str, str] = _SCOPE.get("form_label_to_capability", {})

# Lower-cased label index for medication lookups (matches frontend behaviour).
_MED_LABEL_INDEX: dict[str, str] = {
    cap["label"].strip().lower(): key
    for key, cap in _CAPABILITIES.items()
    if cap.get("section", "").startswith("List of Medications")
}


def get_capability(capability_key: str) -> Optional[dict]:
    """Return the capability dict for `capability_key`, or None if unknown."""
    return _CAPABILITIES.get(capability_key)


def is_authorised(category: str, capability_key: str) -> bool:
    """True when `category` may perform the capability per HPCSA.

    Forbidden capabilities (HPCSA "NOT TO BE PERFORMED") always return False.
    Unknown capability keys return False (fail-closed at the helper level —
    callers that want fail-open semantics must check `get_capability()` first).
    """
    cap = _CAPABILITIES.get(capability_key)
    if cap is None:
        return False
    if cap.get("forbidden"):
        return False
    # Doctor: full scope — the generated JSON's `authorised` arrays stay
    # six-category EMS taxonomy; DR bypasses them (mirrors the frontend).
    if category == "DR":
        return True
    return category in cap.get("authorised", ())


def condition_for(category: str, capability_key: str) -> Optional[str]:
    """Per-category qualifier text (e.g. consultation-required note), if any."""
    cap = _CAPABILITIES.get(capability_key)
    if cap is None:
        return None
    return cap.get("conditions", {}).get(category)


def find_medication_by_name(name: Optional[str]) -> Optional[dict]:
    """Case-insensitive medication lookup. Returns the full capability dict
    (with `key` attached) or None when no catalogue entry matches."""
    if not name:
        return None
    key = _MED_LABEL_INDEX.get(name.strip().lower())
    if not key:
        return None
    cap = dict(_CAPABILITIES[key])
    cap["key"] = key
    return cap


def capability_for_form_label(label: str) -> Optional[str]:
    """Capability key for a Digital PRF checkbox label, or None when unmapped."""
    return _FORM_LABEL_TO_CAPABILITY.get(label)


def scope_for_form_label(label: str, category: Optional[str]) -> dict:
    """Mirrors the frontend `scopeForFormLabel`. Returns:
       * {"kind": "unmapped"}                                — no matrix mapping
       * {"kind": "authorised", "capability_key": ..., "condition": ...?}
       * {"kind": "unauthorised", "capability_key": ...}
    """
    key = _FORM_LABEL_TO_CAPABILITY.get(label)
    if not key:
        return {"kind": "unmapped"}
    cat = normalise_category(category) if category else None
    if not cat:
        # No treating practitioner identified — fail-open at the predicate
        # layer; the rule's caller decides whether to skip the check entirely.
        return {"kind": "authorised", "capability_key": key}
    if not is_authorised(cat, key):
        return {"kind": "unauthorised", "capability_key": key}
    cond = condition_for(cat, key)
    return {"kind": "authorised", "capability_key": key, "condition": cond} if cond \
        else {"kind": "authorised", "capability_key": key}
