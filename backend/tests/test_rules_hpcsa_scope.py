"""Tests for the HPCSA scope-of-practice rule module.

Covers the Phase 5a backend safety net: every clinical action recorded on a
submitted PRF is cross-checked against the treating practitioner's (or the
per-row administrator's) HPCSA scope, and any out-of-scope entry generates an
RFI finding the adjudication team reviews before the claim ships.
"""
from app.rules.hpcsa_scope import evaluate


def _ctx(**overrides) -> dict:
    """Minimal valid context — defaults to a clean PRF with no actions."""
    base = {
        "treating_practitioner_category": "AEA",
        "airway_interventions": [],
        "circulation_interventions": [],
        "medications_list": [],
    }
    base.update(overrides)
    return base


# ─────────────────────────────────────────────────────────────────────────────
# No treating practitioner → no findings (fail-open; gate is separate concern)
# ─────────────────────────────────────────────────────────────────────────────

def test_no_treating_practitioner_short_circuits():
    findings = evaluate(_ctx(
        treating_practitioner_category="",
        airway_interventions=["Intubation"],   # would be ECP-only if checked
    ))
    assert findings == []


def test_unrecognised_practitioner_category_short_circuits():
    findings = evaluate(_ctx(
        treating_practitioner_category="WIZARD",
        medications_list=[{"type": "Adrenaline"}],
    ))
    assert findings == []


# ─────────────────────────────────────────────────────────────────────────────
# Airway / circulation procedure violations
# ─────────────────────────────────────────────────────────────────────────────

def test_baa_attempting_iv_cannulation_flagged():
    findings = evaluate(_ctx(
        treating_practitioner_category="BAA",
        circulation_interventions=["Periph. IV Line"],
    ))
    assert len(findings) == 1
    assert findings[0].action["type"] == "FLAG_RFI"
    assert findings[0].action["rfi_code"] == "POLICY_VIOLATION"
    assert "BAA" in findings[0].action["reason"]
    assert "Periph. IV Line" in findings[0].action["reason"]


def test_ant_attempting_drug_facilitated_intubation_flagged():
    # ANT can do supraglottic; drug-facilitated ETT (RSI) is ECP-only.
    findings = evaluate(_ctx(
        treating_practitioner_category="ANT",
        airway_interventions=["Intubation"],
    ))
    assert len(findings) == 1
    assert "ANT" in findings[0].action["reason"]


def test_ecp_doing_rsi_clean():
    findings = evaluate(_ctx(
        treating_practitioner_category="ECP",
        airway_interventions=["Intubation", "Suction", "Supraglottic Airway"],
    ))
    assert findings == []


def test_baa_cpr_is_authorised():
    # CPR (cardiac arrest management) is authorised for ALL categories.
    findings = evaluate(_ctx(
        treating_practitioner_category="BAA",
        circulation_interventions=["CPR"],
    ))
    assert findings == []


def test_multiple_violations_each_produce_own_finding():
    findings = evaluate(_ctx(
        treating_practitioner_category="BAA",
        airway_interventions=["Intubation", "Surg. Airway"],
        circulation_interventions=["Periph. IV Line", "Pacing"],
    ))
    # Four separate out-of-scope actions → four findings (one each, not lumped).
    assert len(findings) == 4
    labels_in_reasons = " ".join(f.action["reason"] for f in findings)
    assert "Intubation" in labels_in_reasons
    assert "Surg. Airway" in labels_in_reasons
    assert "Periph. IV Line" in labels_in_reasons
    assert "Pacing" in labels_in_reasons


def test_eca_can_tick_io_line():
    # IO Line maps to circ_intraosseous_adult (most permissive — ECA is
    # authorised for adult IO).
    findings = evaluate(_ctx(
        treating_practitioner_category="ECA",
        circulation_interventions=["IO Line"],
    ))
    assert findings == []


# ─────────────────────────────────────────────────────────────────────────────
# Medication scope checks (D2=a free-text passthrough, D5=b admin-fallback)
# ─────────────────────────────────────────────────────────────────────────────

def test_baa_giving_adrenaline_flagged():
    findings = evaluate(_ctx(
        treating_practitioner_category="BAA",
        medications_list=[{"type": "Adrenaline"}],
    ))
    assert len(findings) == 1
    assert "Adrenaline" in findings[0].action["reason"]
    assert "BAA" in findings[0].action["reason"]


def test_baa_giving_aspirin_authorised():
    # Acetyl Salicylic Acid is one of the eight BAA-authorised meds.
    findings = evaluate(_ctx(
        treating_practitioner_category="BAA",
        medications_list=[{"type": "Acetyl Salicylic Acid"}],
    ))
    assert findings == []


def test_off_catalogue_freetext_drug_skipped():
    # Per D2=a: typed drugs that don't match any catalogue entry pass through
    # without an RFI (brand name, abbreviation, missing drug).
    findings = evaluate(_ctx(
        treating_practitioner_category="BAA",
        medications_list=[
            {"type": "SomeBrandName"},
            {"type": "AdrenLine"},    # typo — close to Adrenaline but not exact
        ],
    ))
    assert findings == []


def test_administrator_qualification_overrides_treating_practitioner():
    # Per D5=b: BAA-treating call where ECP partner gave Adrenaline. Per-row
    # `administered_by_qualification` takes precedence — no RFI.
    findings = evaluate(_ctx(
        treating_practitioner_category="BAA",
        medications_list=[{
            "type": "Adrenaline",
            "administered_by_qualification": "ECP",
        }],
    ))
    assert findings == []


def test_administrator_with_insufficient_scope_still_flagged():
    # Per-row administrator is BAA. Even though treating is ECP, the actual
    # administrator can't legitimately give Adrenaline.
    findings = evaluate(_ctx(
        treating_practitioner_category="ECP",
        medications_list=[{
            "type": "Adrenaline",
            "administered_by_qualification": "BAA",
        }],
    ))
    assert len(findings) == 1
    assert "BAA" in findings[0].action["reason"]


def test_legacy_tier_in_administrator_normalises():
    # Pre-migration data may have administered_by_qualification = "ALS".
    # Normaliser maps ALS→ECP so the check passes.
    findings = evaluate(_ctx(
        treating_practitioner_category="BAA",
        medications_list=[{
            "type": "Adrenaline",
            "administered_by_qualification": "ALS",
        }],
    ))
    assert findings == []


# ─────────────────────────────────────────────────────────────────────────────
# Consultation-required warnings (not FLAG_RFI)
# ─────────────────────────────────────────────────────────────────────────────

def test_ect_morphine_emits_consultation_warning():
    # ECT can administer Morphine but only with Senior ECP / MO consultation.
    findings = evaluate(_ctx(
        treating_practitioner_category="ECT",
        medications_list=[{"type": "Morphine Sulphate"}],
    ))
    assert len(findings) == 1
    assert findings[0].action["type"] == "WARN"
    assert "consultation" in findings[0].action["reason"].lower()


# ─────────────────────────────────────────────────────────────────────────────
# Defensive: malformed input shouldn't crash the evaluator
# ─────────────────────────────────────────────────────────────────────────────

def test_non_list_inputs_handled_safely():
    findings = evaluate(_ctx(
        airway_interventions="not a list",         # type: ignore[arg-type]
        circulation_interventions=None,             # type: ignore[arg-type]
        medications_list={"not": "a list"},         # type: ignore[arg-type]
    ))
    assert findings == []


def test_unmapped_form_label_skipped():
    # A label not in FORM_LABEL_TO_CAPABILITY (e.g. a future addition not yet
    # mapped) should pass through without a finding rather than crash.
    findings = evaluate(_ctx(
        airway_interventions=["TotallyMadeUpIntervention"],
    ))
    assert findings == []
