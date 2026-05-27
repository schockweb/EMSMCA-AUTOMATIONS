"""
Shared rule-engine types and global constants.

Every scheme module under `app/rules/{scheme}.py` imports from here so the
downstream adjudication engine can consume them uniformly. Nothing in this
module touches the database — it is pure data + types.

Why hardcoded constants instead of SystemSettings rows?
-------------------------------------------------------
The previous design stored rule toggles and thresholds in a `system_settings`
table, editable through the admin Settings UI. In practice the AI-driven
extraction pipeline could write hallucinated values there, silently altering
pricing and RFI generation. These constants are now the single source of
truth — version-controlled, PR-reviewable, diff-able.
"""
from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any, Callable, Optional, Protocol, runtime_checkable


# ── Enums ────────────────────────────────────────────────────────────────────

class RuleSeverity(str, enum.Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class RuleAction(str, enum.Enum):
    REJECT = "REJECT"
    FLAG_RFI = "FLAG_RFI"
    APPLY_MODIFIER = "APPLY_MODIFIER"
    WARN = "WARN"


class RuleType(str, enum.Enum):
    VALIDATION = "validation"
    PRICING = "pricing"
    ROUTING = "routing"
    MODIFIER = "modifier"
    EXCLUSION = "exclusion"
    PREAUTH = "preauth"
    DOCUMENTATION = "documentation"
    GENERAL = "general"


class TariffCategory(str, enum.Enum):
    BASE_RATE = "base_rate"
    MILEAGE = "mileage"
    PROCEDURE = "procedure"
    MEDICATION = "medication"
    CONSUMABLE = "consumable"
    EQUIPMENT = "equipment"
    ADMIN = "admin"
    OTHER = "other"


# ── Dataclasses ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Rule:
    """A single billing/validation rule expressed as a Python predicate."""
    name: str
    description: str
    rule_type: RuleType
    severity: RuleSeverity
    predicate: Callable[[dict], bool]
    action: RuleAction
    reason: str
    rfi_code: Optional[str] = None
    modifier: Optional[str] = None


@dataclass
class RuleResult:
    """Output of a single rule evaluation — matches the shape that
    adjudication_engine.py expects so no caller changes are needed."""
    rule_name: str
    matched: bool
    severity: str
    action: dict  # {"type": "REJECT", "reason": "...", "rfi_code": "..."}
    message: str


@dataclass(frozen=True)
class TariffEntry:
    """A single tariff code + rate entry.

    Field names intentionally mirror the ORM `GemsTariff` model so the
    `tariff_engine` helpers can swap DB queries for in-memory iteration
    with zero attribute-access changes.
    """
    # Engine-consumed fields (match GemsTariff model):
    tariff_code: str
    description: str
    primary_rate: float
    iht_rate: float
    category: TariffCategory
    notes: Optional[str] = None
    unit: str = "per call"
    is_active: bool = True

    # Module-level metadata for helper filters:
    level: Optional[str] = None          # "ALS" | "ILS" | "BLS" | None
    loaded: Optional[bool] = None        # True=with patient, False=callout/RTB, None=N/A
    keywords: tuple[str, ...] = field(default_factory=tuple)


# ── Module protocol ──────────────────────────────────────────────────────────

@runtime_checkable
class SchemeRuleModule(Protocol):
    """Structural type that every scheme module (e.g. gems.py) satisfies.

    The registry dispatcher uses this to resolve any scheme module without
    hardcoded imports — as long as the module exposes these names.
    """
    SCHEME_ID: str
    SCHEME_KEYWORDS: tuple[str, ...]
    PAYER_TYPE: str  # "SCHEME" | "AGGREGATOR"
    TARIFFS: tuple[TariffEntry, ...]
    RULES: tuple[Rule, ...]
    EXCLUSIONS: tuple[str, ...]
    PREAUTH_CPT_CODES: frozenset[str]


# ═══════════════════════════════════════════════════════════════════════════
# Global constants (previously SystemSettings rows)
# ═══════════════════════════════════════════════════════════════════════════

# ── RFI Validation Rules (previously SystemSettings category="rfi_settings") ─
# These drive the "must-have" completeness checks in adjudication_engine.py.
# Flip to False to relax a requirement. Requires code deploy — intentionally so.
REQUIRE_PATIENT_ID: bool = True
REQUIRE_SCHEME: bool = True
REQUIRE_PROVIDER_PCNS: bool = True
REQUIRE_PATIENT_SIGNATURE: bool = False  # Paper PRFs only; digital PRFs are signed in-app

# ── Authorisation defaults (previously SystemSettings category="auth_rules") ─
IHT_REQUIRES_REFERRING_DR: bool = True
DEFAULT_DISPATCH_TYPE: str = "Primary"  # Fallback when PRF doesn't specify

# ── Clinical validation thresholds ──
OCR_CONFIDENCE_HITL_THRESHOLD: float = 0.75   # Below this, needs human review
MILEAGE_METROPOLITAN_THRESHOLD_KM: float = 100.0  # GEMS 100km rule
MILEAGE_MAX_CALLOUT_KM: float = 200.0
MILEAGE_MAX_LOADED_KM: float = 300.0
MILEAGE_MAX_RTB_KM: float = 200.0
SCENE_MAX_MINUTES: float = 180.0

# ── Crew qualification hierarchy (used by qualification cap) ──
LEVEL_RANK: dict[str, int] = {"BLS": 0, "ILS": 1, "ALS": 2}

# ── Multi-patient multipliers (NHRPL) ──
MULTI_PATIENT_MULTIPLIERS: dict[int, float] = {
    1: 1.00,
    2: 0.75,
    3: 0.50,  # 3 or more patients
}


def multi_patient_multiplier(patient_count: int) -> float:
    """Return the base-rate multiplier for a given patient count."""
    if patient_count >= 3:
        return MULTI_PATIENT_MULTIPLIERS[3]
    return MULTI_PATIENT_MULTIPLIERS.get(patient_count, 1.00)


# ── Time windows (base-rate minutes before extension code applies) ──
TIME_WINDOW_MINUTES: dict[str, int] = {
    "ALS": 60,
    "ILS": 45,
    "BLS": 45,
}

EXTENSION_INTERVAL_MINUTES: int = 15


# ── Common helper: keyword search over tariff entries ──
def find_by_keywords(rows: list[TariffEntry], *keywords: str) -> Optional[TariffEntry]:
    """Return the first row whose description contains ALL keywords (case-insensitive)."""
    kws = [k.lower() for k in keywords]
    for r in rows:
        desc = (r.description or "").lower()
        if all(k in desc for k in kws):
            return r
    return None
