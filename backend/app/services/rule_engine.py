"""
Rule Engine — Evaluates hardcoded scheme rules against a claim context.

The previous implementation loaded a JSON-logic AST from the `scheme_rules`
database table and interpreted it at runtime. That design let AI-extracted
rules silently mutate billing behaviour and was retired in favour of
code-defined rules under `app/rules/`.

Public API (signature preserved so callers don't change):
    build_claim_context(claim, case, claim_lines, provider, extracted_data) -> dict
    evaluate_rules(context, db=None, scheme_name=None) -> EngineResult
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger("ems.rule_engine")


# ═══════════════════════════════════════════════════════════════════════════
# DATA STRUCTURES  (unchanged — callers import these)
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class RuleResult:
    """Result of evaluating a single rule."""
    rule_id: str
    rule_name: str
    matched: bool
    severity: str
    action: dict           # {"type": "FLAG_RFI"|"REJECT"|"WARN"|"APPLY_MODIFIER", "reason": ..., "rfi_code": ..., "modifier": ...}
    message: str = ""


@dataclass
class EngineResult:
    """Aggregated result from evaluating all rules."""
    total_rules: int = 0
    matched_rules: int = 0
    results: list[RuleResult] = field(default_factory=list)
    actions: list[dict] = field(default_factory=list)
    has_critical: bool = False
    has_high: bool = False

    @property
    def is_clean(self) -> bool:
        return not self.has_critical and not self.has_high


# ═══════════════════════════════════════════════════════════════════════════
# CONTEXT BUILDER — flattens Claim + Case + Provider into a dict
# ═══════════════════════════════════════════════════════════════════════════

def build_claim_context(
    claim: Any = None,
    case: Any = None,
    claim_lines: Optional[list] = None,
    provider: Any = None,
    extracted_data: Optional[dict] = None,
) -> dict:
    """Build a flat 'world state' dict from all claim-related objects."""
    ctx: dict[str, Any] = {}

    # Case fields
    if case:
        ctx["patient_name"] = getattr(case, "patient_name", "") or ""
        ctx["patient_id_number"] = getattr(case, "patient_id_number", "") or ""
        ctx["scheme_name"] = (getattr(case, "medical_scheme_name", "") or "").strip()
        ctx["scheme_name_lower"] = ctx["scheme_name"].lower()
        ctx["member_number"] = getattr(case, "scheme_member_number", "") or ""
        ctx["scheme_member_number"] = ctx["member_number"]
        ctx["preauth_number"] = (getattr(case, "preauth_number", "") or "").strip()
        preauth_status = getattr(case, "preauth_status", None)
        ctx["preauth_status"] = (
            preauth_status.value if hasattr(preauth_status, "value")
            else (str(preauth_status) if preauth_status else None)
        )
        ctx["dispatch_type"] = getattr(case, "dispatch_type", "") or ""
        ctx["dependant_code"] = getattr(case, "dependant_code", "") or ""
        ctx["referring_doctor_pr"] = getattr(case, "referring_doctor_pr", "") or ""

    # Claim fields
    if claim:
        ctx["total_amount"] = float(claim.total_amount) if claim.total_amount else 0.0
        ctx["adjudication_status"] = (
            claim.adjudication_status.value if hasattr(claim.adjudication_status, "value")
            else str(claim.adjudication_status or "")
        )

    # Claim lines
    lines = claim_lines or []
    ctx["line_count"] = len(lines)
    ctx["icd10_codes"] = [l.icd10_primary for l in lines if getattr(l, "icd10_primary", None)]
    ctx["cpt_codes"] = [l.cpt_code for l in lines if getattr(l, "cpt_code", None)]
    ctx["nappi_codes"] = [l.nappi_code for l in lines if getattr(l, "nappi_code", None)]
    ctx["descriptions"] = [l.description for l in lines if getattr(l, "description", None)]
    ctx["line_amounts"] = [float(l.total_price) for l in lines if getattr(l, "total_price", None)]
    ctx["max_line_amount"] = max(ctx["line_amounts"], default=0.0)
    # Convenience: primary ICD-10 (first line) — used by scheme rules for S/T external-cause check
    ctx["icd10_primary"] = ctx["icd10_codes"][0] if ctx["icd10_codes"] else ""

    # Provider fields
    if provider:
        ctx["provider_name"] = getattr(provider, "full_name", "") or ""
        ctx["provider_pcns"] = getattr(provider, "bhf_practice_number", "") or ""
        ctx["provider_role"] = (
            provider.role.value if hasattr(provider, "role") and hasattr(provider.role, "value")
            else ""
        )

    # Extracted PRF data
    if extracted_data:
        ctx["level_of_care"] = (extracted_data.get("level_of_care") or "").strip().upper()
        ctx["chief_complaint"] = extracted_data.get("chief_complaint", "")
        ctx["clinical_notes"] = extracted_data.get("clinical_notes", "")
        ctx["procedures_performed"] = extracted_data.get("procedures_performed", "")
        ctx["medications_administered"] = extracted_data.get("medications_administered", "")
        ctx["icd10_external_cause"] = extracted_data.get("icd10_external_cause", "")

        # ── HPCSA scope inputs (consumed by app.rules.hpcsa_scope.evaluate) ──
        # Treating practitioner identified via the Phase 2 Clinical-phase gate;
        # interventions + meds arrays come straight from the Digital PRF form
        # state. Defensive about types — for paper-PRF / OCR flows these fields
        # may be missing entirely, in which case the scope rule short-circuits.
        ctx["treating_practitioner_category"] = (
            extracted_data.get("treating_practitioner_category") or ""
        )
        airway = extracted_data.get("airway_interventions") or []
        circ = extracted_data.get("circulation_interventions") or []
        ctx["airway_interventions"] = list(airway) if isinstance(airway, (list, tuple)) else []
        ctx["circulation_interventions"] = list(circ) if isinstance(circ, (list, tuple)) else []
        # `medications_administered` (string) is the existing flat narrative used
        # by other rules; the scope rule needs the structured row list separately
        # so it can resolve per-row administrators. Live under a distinct key to
        # avoid colliding with the legacy string.
        meds = extracted_data.get("medications") or extracted_data.get("medications_list") or []
        ctx["medications_list"] = list(meds) if isinstance(meds, (list, tuple)) else []

    return ctx


# ═══════════════════════════════════════════════════════════════════════════
# EVALUATOR — dispatches to hardcoded scheme modules via the rules registry
# ═══════════════════════════════════════════════════════════════════════════

async def evaluate_rules(
    context: dict,
    db: Any = None,                      # kept for signature compatibility
    scheme_name: Optional[str] = None,
) -> EngineResult:
    """Resolve the scheme's hardcoded rule module and evaluate every RULES entry.

    Returns an empty `EngineResult` when the scheme has no configured module —
    that signals to adjudication_engine.py that no rule-engine verdict exists
    (which the UI renders as a 'no rules configured' info notice).

    HPCSA scope-of-practice findings are appended ALWAYS — regardless of which
    scheme module resolves — because HPCSA scope is scheme-agnostic (every SA
    EMS submission has to satisfy HPCSA staffing rules). The scope evaluator
    lives in `app.rules.hpcsa_scope` and emits one finding per violation.
    """
    result = EngineResult()

    # Late import — avoids circular dep at module-load time.
    from app.rules import get_rules_for_scheme
    from app.rules.base import RuleAction, RuleSeverity
    from app.rules import hpcsa_scope as _hpcsa_scope

    module = get_rules_for_scheme(scheme_name)
    if module is None:
        logger.info(
            "Rule Engine: no hardcoded module for scheme '%s' — skipping scheme rules",
            scheme_name or "(unknown)",
        )
    else:
        rules = getattr(module, "RULES", ())
        result.total_rules = len(rules)

        for idx, rule in enumerate(rules):
            try:
                matched = bool(rule.predicate(context))
            except Exception as e:      # noqa: BLE001 — defensive around user predicates
                logger.error("Rule evaluation error for '%s': %s", rule.name, e)
                matched = False

            if not matched:
                continue

            result.matched_rules += 1

            # Build the action dict shape that adjudication_engine expects:
            #   {"type": "FLAG_RFI", "reason": "...", "rfi_code": "...", "modifier": "..."}
            action_dict: dict = {
                "type": rule.action.value if isinstance(rule.action, RuleAction) else str(rule.action),
                "reason": rule.reason,
            }
            if rule.rfi_code:
                action_dict["rfi_code"] = rule.rfi_code
            if rule.modifier:
                action_dict["modifier"] = rule.modifier

            severity_str = (
                rule.severity.value if isinstance(rule.severity, RuleSeverity)
                else str(rule.severity)
            )

            rule_result = RuleResult(
                rule_id=f"{module.SCHEME_ID}:{idx}",
                rule_name=rule.name,
                matched=True,
                severity=severity_str,
                action=action_dict,
                message=rule.reason or rule.description or rule.name,
            )
            result.results.append(rule_result)
            result.actions.append(action_dict)

            if severity_str == "critical":
                result.has_critical = True
            elif severity_str == "high":
                result.has_high = True

            logger.info(
                "Rule MATCHED: '%s' [%s/%s] — %s",
                rule.name,
                rule.rule_type.value if hasattr(rule.rule_type, "value") else rule.rule_type,
                severity_str,
                rule.reason,
            )

        logger.info(
            "Rule Engine: %d/%d rules matched for scheme '%s' (module=%s)",
            result.matched_rules, result.total_rules,
            scheme_name or "(global)", module.SCHEME_ID,
        )

    # ── HPCSA scope-of-practice (scheme-agnostic) ────────────────────────────
    # Walks recorded interventions + medications and emits one finding per
    # action that falls outside the treating practitioner's (or the per-row
    # administrator's) HPCSA scope. Runs whether or not a scheme module was
    # resolved — HPCSA staffing rules apply to every SA EMS claim.
    try:
        hpcsa_findings = _hpcsa_scope.evaluate(context)
    except Exception as e:      # noqa: BLE001
        logger.error("HPCSA scope evaluation error: %s", e)
        hpcsa_findings = []

    for finding in hpcsa_findings:
        result.matched_rules += 1
        result.results.append(finding)
        result.actions.append(finding.action)
        if finding.severity == "critical":
            result.has_critical = True
        elif finding.severity == "high":
            result.has_high = True

    return result
