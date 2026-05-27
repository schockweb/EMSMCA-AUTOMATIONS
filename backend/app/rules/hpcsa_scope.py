"""HPCSA scope-of-practice rule module.

Scheme-agnostic safety net: walks the recorded interventions + medications on
a submitted PRF and emits one RFI finding per action that falls outside the
treating practitioner's (or per-row administrator's) HPCSA scope.

This complements the Phase 4 frontend enforcement (filter / disable in the
crew UI) — the backend check catches the cases the UI can't:
  * stale clients running pre-Phase-4 JS
  * direct API calls bypassing the UI
  * off-catalogue free-text drug names that match a known drug after
    normalisation but slipped past the on-blur clear (e.g. typo, race)
  * paper-PRF / OCR flow which never runs the frontend gate at all

Per-row administrator vs. treating practitioner (decided 2026-05-17 D5=b):
  * Procedure checkboxes (airway, circulation) — checked against the treating
    practitioner. No per-action attribution is captured for these.
  * Medication / IV rows — prefer the row's `administered_by_qualification`
    when present (so a higher-scope partner who actually administered the drug
    doesn't generate a false-positive). Fall back to the treating practitioner.

Unlike the scheme rule modules (`gems.py`, `discovery.py`) this file exposes
an `evaluate(context)` function instead of a `RULES` tuple, because each
submission can produce multiple findings — one per violation — and the
standard one-Rule-per-Result model doesn't fit. The `rule_engine` calls
`evaluate(context)` after the scheme rules and merges the results in.
"""
from __future__ import annotations

import logging
from typing import Any

from app.services.rule_engine import RuleResult
from app.utils.hpcsa import (
    capability_for_form_label,
    condition_for,
    find_medication_by_name,
    get_capability,
    is_authorised,
    normalise_category,
)

logger = logging.getLogger("ems.rules.hpcsa_scope")


def _violation(rule_id: str, action_label: str, category: str, capability_key: str) -> RuleResult:
    """Build a single FLAG_RFI result for an out-of-scope action."""
    cap = get_capability(capability_key)
    cap_label = (cap or {}).get("label", capability_key)
    reason = (
        f"{action_label} recorded but not within {category} scope of practice "
        f"(HPCSA capability: {cap_label})."
    )
    return RuleResult(
        rule_id=f"hpcsa:scope:{capability_key}",
        rule_name="HPCSA scope-of-practice violation",
        matched=True,
        severity="high",
        action={
            "type": "FLAG_RFI",
            "reason": reason,
            "rfi_code": "POLICY_VIOLATION",
        },
        message=reason,
    )


def _consultation_warning(rule_id: str, action_label: str, category: str, capability_key: str, note: str) -> RuleResult:
    """Build an INFO-level reminder when a category may perform the action
    but only with Senior ECP / Supervising MO consultation. Action is WARN
    (not FLAG_RFI) so it surfaces in the UI without blocking the claim."""
    reason = (
        f"{action_label} requires {category} to document Senior ECP / "
        f"Supervising MO consultation. ({note})"
    )
    return RuleResult(
        rule_id=f"hpcsa:scope:consult:{capability_key}",
        rule_name="HPCSA consultation requirement",
        matched=True,
        severity="medium",
        action={
            "type": "WARN",
            "reason": reason,
            "rfi_code": "DOCUMENTATION_INCOMPLETE",
        },
        message=reason,
    )


def evaluate(context: dict) -> list[RuleResult]:
    """Walk the submitted PRF context and return zero or more scope findings.

    Expected context keys (populated by `rule_engine.build_claim_context`
    from the PRF's `form_data`):
      * `treating_practitioner_category` — HPCSA code (BAA/AEA/…)
      * `airway_interventions`           — list[str] of ticked checkbox labels
      * `circulation_interventions`      — list[str] of ticked checkbox labels
      * `medications_list`               — list[dict]; each has `type` (drug name)
                                           and optionally `administered_by_qualification`
                                           (the legacy `medications_administered` key
                                           is a flat narrative string used by other rules
                                           — distinct from the structured list this rule needs).
    """
    results: list[RuleResult] = []

    raw_treating = context.get("treating_practitioner_category") or ""
    treating = normalise_category(raw_treating)
    if not treating:
        # No treating practitioner identified — Phase 2 gate normally prevents
        # this. With nothing to check against, return empty rather than emit a
        # noisy "scope unknown" finding for every action; missing gate is its
        # own separate concern.
        return results

    # ── Airway + circulation checkbox interventions ──────────────────────────
    procedure_lists = (
        ("Airway intervention",      context.get("airway_interventions") or []),
        ("Circulation intervention", context.get("circulation_interventions") or []),
    )
    for _category_name, items in procedure_lists:
        if not isinstance(items, (list, tuple)):
            continue
        for label in items:
            if not isinstance(label, str) or not label.strip():
                continue
            cap_key = capability_for_form_label(label)
            if not cap_key:
                # Unmapped form label — fail-open at the rule level; means we
                # haven't catalogued this checkbox yet, not that anyone broke
                # scope.
                continue
            if not is_authorised(treating, cap_key):
                results.append(_violation(
                    f"hpcsa:scope:airway:{cap_key}",
                    label,
                    treating,
                    cap_key,
                ))
            else:
                cond = condition_for(treating, cap_key)
                if cond:
                    results.append(_consultation_warning(
                        f"hpcsa:scope:consult:{cap_key}",
                        label,
                        treating,
                        cap_key,
                        cond,
                    ))

    # ── Medication rows ──────────────────────────────────────────────────────
    # Per D5=b: prefer the per-row administrator's qualification (the partner
    # who actually administered the drug) over the treating practitioner.
    meds = context.get("medications_list") or []
    if isinstance(meds, (list, tuple)):
        for row in meds:
            if not isinstance(row, dict):
                continue
            drug_name = (row.get("type") or row.get("drug") or "").strip()
            if not drug_name:
                continue
            med = find_medication_by_name(drug_name)
            if med is None:
                # Off-catalogue free-text (brand name, abbreviation, missing
                # drug) — per D2=a, skip rather than flag.
                continue
            cap_key = med["key"]
            # Resolve scope check identity: administrator first, then treating
            # practitioner as fallback.
            row_qual = normalise_category(
                row.get("administered_by_qualification") or row.get("administered_by_category")
            )
            check_against = row_qual or treating
            if not is_authorised(check_against, cap_key):
                results.append(_violation(
                    f"hpcsa:scope:med:{cap_key}",
                    f"Medication: {med['label']}",
                    check_against,
                    cap_key,
                ))
            else:
                cond = condition_for(check_against, cap_key)
                if cond:
                    results.append(_consultation_warning(
                        f"hpcsa:scope:consult:med:{cap_key}",
                        f"Medication: {med['label']}",
                        check_against,
                        cap_key,
                        cond,
                    ))

    if results:
        logger.info(
            "HPCSA scope rule: %d finding(s) for treating practitioner %s",
            len(results), treating,
        )
    return results
