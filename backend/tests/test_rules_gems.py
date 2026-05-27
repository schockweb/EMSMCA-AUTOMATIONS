"""Tests for the GEMS hardcoded rules module + registry dispatcher.

Source rules: 2023 GEMS EMS Claims Manual.
Pins rate values + verifies every rule fires only on the expected context.
"""
from __future__ import annotations

import pytest

from app.rules import get_rules_for_scheme, list_configured_schemes
from app.rules import gems as gems_module
from app.rules.base import (
    RuleAction,
    RuleSeverity,
    RuleType,
    TariffCategory,
    multi_patient_multiplier,
)
from app.services.rule_engine import evaluate_rules


# ═══════════════════════════════════════════════════════════════════════════
# Registry resolution
# ═══════════════════════════════════════════════════════════════════════════

def test_registry_exact_match():
    assert get_rules_for_scheme("gems") is gems_module
    assert get_rules_for_scheme("GEMS") is gems_module


def test_registry_fuzzy_match_full_name():
    assert get_rules_for_scheme("Government Employees Medical Scheme") is gems_module


def test_registry_unknown_scheme_returns_none():
    assert get_rules_for_scheme("Bonitas") is None
    assert get_rules_for_scheme(None) is None
    assert get_rules_for_scheme("") is None


def test_registry_lists_configured_schemes():
    schemes = list_configured_schemes()
    assert "gems" in schemes


# ═══════════════════════════════════════════════════════════════════════════
# PDF-grounded constant pins (§8.3, §8.2, §9, §10)
# ═══════════════════════════════════════════════════════════════════════════

def test_scene_caps_match_pdf_section_8_3():
    assert gems_module.SCENE_MAX_MIN_BLS == 15
    assert gems_module.SCENE_MAX_MIN_ILS == 20
    assert gems_module.SCENE_MAX_MIN_ALS == 30
    assert gems_module.SCENE_MAX_MIN_ICU == 30


def test_handover_caps_match_pdf_section_8_3():
    assert gems_module.HANDOVER_MAX_MIN_BLS == 15
    assert gems_module.HANDOVER_MAX_MIN_ILS == 15
    assert gems_module.HANDOVER_MAX_MIN_ALS == 20


def test_long_distance_threshold_is_100km():
    assert gems_module.LONG_DISTANCE_KM_THRESHOLD == 100


def test_stale_window_is_120_days():
    assert gems_module.STALE_DAYS_FROM_SERVICE == 120
    assert gems_module.RESUBMISSION_WINDOW_DAYS == 60


def test_call_out_fee_cap_is_1800():
    assert gems_module.CALL_OUT_FEE_MAX_RAND == 1800.00


def test_max_billable_patients_is_three():
    assert gems_module.MAX_BILLABLE_PATIENTS == 3


def test_double_bls_crew_disallowed():
    assert gems_module.ALLOW_DOUBLE_BLS_CREW is False


def test_vitals_minimum_is_two():
    assert gems_module.VITALS_SETS_MINIMUM == 2


# ═══════════════════════════════════════════════════════════════════════════
# Rate sanity
# ═══════════════════════════════════════════════════════════════════════════

def test_gems_rate_sanity_als_base_primary():
    assert gems_module.BY_CODE["131"].primary_rate == 5200.00
    assert gems_module.BY_CODE["131"].iht_rate == 5800.00


def test_gems_rate_sanity_ils_base_primary():
    assert gems_module.BY_CODE["125"].primary_rate == 3850.00


def test_gems_rate_sanity_bls_base_primary():
    assert gems_module.BY_CODE["100"].primary_rate == 2850.00


def test_gems_rate_sanity_callout_fees():
    assert gems_module.BY_CODE["104"].iht_rate == 450.00
    assert gems_module.BY_CODE["126"].iht_rate == 600.00
    assert gems_module.BY_CODE["134"].iht_rate == 750.00


def test_gems_rate_sanity_mileage_als():
    loaded = gems_module.mileage_row("ALS", loaded=True)
    assert loaded is not None and loaded.primary_rate == 50.00

    unloaded = gems_module.mileage_row("ALS", loaded=False)
    assert unloaded is not None and unloaded.primary_rate == 40.00


# ═══════════════════════════════════════════════════════════════════════════
# Accessor shape — matches tariff_engine expectations
# ═══════════════════════════════════════════════════════════════════════════

def test_base_rates_accessor_returns_all_three_levels():
    rows = gems_module.all_base_rates()
    codes = {r.tariff_code for r in rows}
    assert {"100", "125", "131"}.issubset(codes)


def test_all_mileage_returns_six_rows():
    rows = gems_module.all_mileage()
    assert len(rows) == 6
    assert all(r.category == TariffCategory.MILEAGE for r in rows)


def test_base_rates_for_level_filters_correctly():
    als_rows = gems_module.base_rates_for_level("ALS")
    assert all("[ALS]" in (r.description or "").upper() for r in als_rows)
    assert not any("[BLS]" in (r.description or "").upper() for r in als_rows)


# ═══════════════════════════════════════════════════════════════════════════
# Helper functions
# ═══════════════════════════════════════════════════════════════════════════

def test_scene_cap_helper():
    assert gems_module._scene_cap_for_level("BLS") == 15
    assert gems_module._scene_cap_for_level("ILS") == 20
    assert gems_module._scene_cap_for_level("ALS") == 30
    assert gems_module._scene_cap_for_level("ICU") == 30
    assert gems_module._scene_cap_for_level("UNKNOWN") == 15  # fallback


def test_handover_cap_helper():
    assert gems_module._handover_cap_for_level("BLS") == 15
    assert gems_module._handover_cap_for_level("ALS") == 20
    assert gems_module._handover_cap_for_level("ICU") == 20


# ═══════════════════════════════════════════════════════════════════════════
# Rule firing — clean baseline
# ═══════════════════════════════════════════════════════════════════════════

def _clean_primary_context() -> dict:
    """A complete, well-formed Primary call context that should pass every rule."""
    return {
        "dispatch_type": "Primary",
        "preauth_number": "EMED-REF-12345",
        "scheme_member_number": "201234567",
        "patient_id_number": "7506155012089",
        "dependant_code": "00",
        "icd10_primary": "I21.0",
        "icd10_external_cause": "",
        "level_of_care": "ILS",
        "highest_crew_qual": "ILS",
        "crew_member_2_qualification": "BLS",
        "scene_minutes": 15,
        "handover_minutes": 10,
        "vitals_count": 2,
        "loaded_distance_km": 14,
        "rtb_distance_km": 14,
        "ils_intervention_performed": True,
        "receiving_facility": "Capital Hospital",
        "patient_signature": "data:image/png;base64,...",
        "handover_signature": "data:image/png;base64,...",
        "patient_count": 1,
        "priority": "ORANGE",
        "cpt_codes": ["125"],
    }


@pytest.mark.asyncio
async def test_clean_primary_call_passes_all_rules():
    result = await evaluate_rules(_clean_primary_context(), db=None, scheme_name="gems")
    assert result.matched_rules == 0
    assert result.is_clean


# ═══════════════════════════════════════════════════════════════════════════
# Individual rule firing
# ═══════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_missing_emed_reference_is_critical():
    ctx = _clean_primary_context()
    ctx["preauth_number"] = ""
    ctx["emed_reference_number"] = ""
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    assert result.has_critical
    codes = [r.action.get("rfi_code") for r in result.results]
    assert "MISSING_PREAUTH" in codes


@pytest.mark.asyncio
async def test_missing_member_number_is_critical():
    ctx = _clean_primary_context()
    ctx["scheme_member_number"] = ""
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    assert result.has_critical
    codes = [r.action.get("rfi_code") for r in result.results]
    assert "MISSING_SCHEME_INFO" in codes


@pytest.mark.asyncio
async def test_missing_patient_id_and_dob_is_critical():
    ctx = _clean_primary_context()
    ctx["patient_id_number"] = ""
    ctx["patient_dob"] = ""
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    codes = [r.action.get("rfi_code") for r in result.results]
    assert "MISSING_PATIENT_ID" in codes


@pytest.mark.asyncio
async def test_dob_alone_satisfies_patient_id_rule():
    ctx = _clean_primary_context()
    ctx["patient_id_number"] = ""
    ctx["patient_dob"] = "1975-06-15"
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    codes = [r.action.get("rfi_code") for r in result.results]
    assert "MISSING_PATIENT_ID" not in codes


@pytest.mark.asyncio
async def test_missing_dependent_code_flags():
    ctx = _clean_primary_context()
    ctx["dependant_code"] = ""
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert any("Dependent code" in n for n in matched)


@pytest.mark.asyncio
async def test_two_bls_crew_rejected():
    ctx = _clean_primary_context()
    ctx["level_of_care"] = "BLS"
    ctx["highest_crew_qual"] = "BLS"
    ctx["crew_member_2_qualification"] = "BLS"
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    actions = [r.action.get("type") for r in result.results]
    assert "REJECT" in actions


@pytest.mark.asyncio
async def test_two_bls_crew_with_supervisor_not_rejected():
    """HPCSA Jun 2017 §2.1: an identified supervising practitioner satisfies
    the staffing requirement, so a BLS-only crew with a named supervisor on
    the PRF must NOT be rejected by GEMS §10.1."""
    ctx = _clean_primary_context()
    ctx["level_of_care"] = "BLS"
    ctx["highest_crew_qual"] = "BLS"
    ctx["crew_member_2_qualification"] = "BLS"
    ctx["supervising_practitioner_pr"] = "MP0123456"
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    # The two-BLS rule (rejection) must not fire when a supervisor is present.
    two_bls_rule_results = [r for r in result.results if "Two BLS crew" in r.rule_name]
    assert all(r.action.get("type") != "REJECT" for r in two_bls_rule_results), (
        "Two-BLS rejection rule fired despite supervising_practitioner_pr being set"
    )


@pytest.mark.asyncio
async def test_missing_patient_signature_flags():
    ctx = _clean_primary_context()
    ctx["patient_signature"] = ""
    ctx["witness_signature"] = ""
    ctx["signature_refused_reason"] = ""
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    codes = [r.action.get("rfi_code") for r in result.results]
    assert "MISSING_SIGNATURE" in codes


@pytest.mark.asyncio
async def test_documented_signature_refusal_with_witness_passes():
    ctx = _clean_primary_context()
    ctx["patient_signature"] = ""
    ctx["witness_signature"] = "data:image/png;base64,..."
    ctx["signature_refused_reason"] = "Patient unconscious — witnessed by daughter"
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert not any("Patient (or guardian) signature" in n for n in matched)


@pytest.mark.asyncio
async def test_missing_handover_signature_on_transport_flags():
    ctx = _clean_primary_context()
    ctx["handover_signature"] = ""
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert any("Handover signature" in n for n in matched)


@pytest.mark.asyncio
async def test_only_one_set_of_vitals_flags():
    ctx = _clean_primary_context()
    ctx["vitals_count"] = 1
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert any("Two sets of vitals" in n for n in matched)


@pytest.mark.asyncio
async def test_st_icd10_without_external_cause_flags():
    ctx = _clean_primary_context()
    ctx["icd10_primary"] = "S72.0"
    ctx["icd10_external_cause"] = ""
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    codes = [r.action.get("rfi_code") for r in result.results]
    assert "MISSING_EXTERNAL_CAUSE" in codes


@pytest.mark.asyncio
async def test_z_code_as_primary_diagnosis_flags():
    ctx = _clean_primary_context()
    ctx["icd10_primary"] = "Z00.0"
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    codes = [r.action.get("rfi_code") for r in result.results]
    assert "INVALID_ICD10" in codes


@pytest.mark.asyncio
async def test_ift_without_preauth_flags():
    ctx = _clean_primary_context()
    ctx["dispatch_type"] = "IFT"
    ctx["preauth_number"] = ""
    ctx["referring_doctor_pr"] = "MP0001234"
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert any("IFT requires pre-authorisation" in n for n in matched)


@pytest.mark.asyncio
async def test_ift_without_referring_doctor_flags():
    ctx = _clean_primary_context()
    ctx["dispatch_type"] = "IFT"
    ctx["referring_doctor_pr"] = ""
    ctx["referring_doctor"] = ""
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    codes = [r.action.get("rfi_code") for r in result.results]
    assert "MISSING_REFERRING_DR" in codes


@pytest.mark.asyncio
async def test_scene_time_over_ils_cap_without_motivation_flags():
    ctx = _clean_primary_context()
    ctx["scene_minutes"] = 35
    ctx["motivation_notes"] = ""
    ctx["clinical_notes"] = ""
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert any("Scene time exceeds level cap" in n for n in matched)


@pytest.mark.asyncio
async def test_scene_time_over_cap_with_motivation_passes():
    ctx = _clean_primary_context()
    ctx["scene_minutes"] = 35
    ctx["motivation_notes"] = "Patient extricated from vehicle by Jaws of Life — fire dept on scene"
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert not any("Scene time exceeds level cap" in n for n in matched)


@pytest.mark.asyncio
async def test_handover_over_cap_without_motivation_flags():
    ctx = _clean_primary_context()
    ctx["handover_minutes"] = 25
    ctx["motivation_notes"] = ""
    ctx["clinical_notes"] = ""
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert any("Handover time exceeds" in n for n in matched)


@pytest.mark.asyncio
async def test_four_patients_warns():
    ctx = _clean_primary_context()
    ctx["patient_count"] = 4
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    warns = [r for r in result.results if r.action.get("type") == "WARN"]
    assert any("4th patient" in r.rule_name for r in warns)


@pytest.mark.asyncio
async def test_p1_with_multiple_patients_flags():
    ctx = _clean_primary_context()
    ctx["priority"] = "RED"
    ctx["patient_count"] = 2
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert any("Priority 1 patient must be transported alone" in n for n in matched)


@pytest.mark.asyncio
async def test_pre_planned_event_rejected():
    ctx = _clean_primary_context()
    ctx["pre_planned_event"] = True
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    actions = [r.action.get("type") for r in result.results]
    assert "REJECT" in actions


@pytest.mark.asyncio
async def test_direct_admission_without_emed_or_lifesaving_flags():
    ctx = _clean_primary_context()
    ctx["direct_admission"] = True
    ctx["emed_notified"] = False
    ctx["lifesaving_intervention_required"] = False
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert any("Direct admission" in n for n in matched)


@pytest.mark.asyncio
async def test_direct_admission_with_lifesaving_passes():
    ctx = _clean_primary_context()
    ctx["direct_admission"] = True
    ctx["lifesaving_intervention_required"] = True
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert not any("Direct admission" in n for n in matched)


@pytest.mark.asyncio
async def test_ils_billed_without_intervention_flags_upcoding():
    ctx = _clean_primary_context()
    ctx["level_of_care"] = "ILS"
    ctx["ils_intervention_performed"] = False
    ctx["als_intervention_performed"] = False
    ctx["resuscitation_performed"] = False
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    codes = [r.action.get("rfi_code") for r in result.results]
    assert "UPCODING_SUSPECTED" in codes


@pytest.mark.asyncio
async def test_resus_fee_with_transport_requires_rosc():
    ctx = _clean_primary_context()
    ctx["cpt_codes"] = ["131", "151"]
    ctx["loaded_distance_km"] = 18
    ctx["rosc_achieved"] = False
    ctx["perfusing_rhythm_on_handover"] = False
    ctx["level_of_care"] = "ALS"
    ctx["highest_crew_qual"] = "ALS"
    ctx["als_intervention_performed"] = True
    ctx["resuscitation_performed"] = True
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert any("ROSC + perfusing rhythm" in n for n in matched)


@pytest.mark.asyncio
async def test_resus_fee_below_ils_flagged_as_upcoding():
    ctx = _clean_primary_context()
    ctx["cpt_codes"] = ["100", "151"]
    ctx["level_of_care"] = "BLS"
    ctx["highest_crew_qual"] = "BLS"
    ctx["crew_member_2_qualification"] = "ILS"  # avoid two-BLS rejection rule
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    codes = [r.action.get("rfi_code") for r in result.results]
    assert "UPCODING_SUSPECTED" in codes


@pytest.mark.asyncio
async def test_cardiac_icd_without_ecg_attached_flags():
    ctx = _clean_primary_context()
    ctx["icd10_primary"] = "I21.0"
    ctx["has_ecg_attached"] = False
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert any("Cardiac incident requires ECG" in n for n in matched)


@pytest.mark.asyncio
async def test_cardiac_with_ecg_attached_passes():
    ctx = _clean_primary_context()
    ctx["icd10_primary"] = "I21.0"
    ctx["has_ecg_attached"] = True
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert not any("Cardiac incident requires ECG" in n for n in matched)


@pytest.mark.asyncio
async def test_ventilated_ift_without_settings_or_blood_gas_flags():
    ctx = _clean_primary_context()
    ctx["dispatch_type"] = "IFT"
    ctx["referring_doctor_pr"] = "MP0001234"
    ctx["ventilator_in_use"] = True
    ctx["ventilator_settings_recorded"] = False
    ctx["blood_gas_attached"] = False
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert any("Ventilated IFT requires" in n for n in matched)


@pytest.mark.asyncio
async def test_self_sourced_call_out_fee_rejected():
    ctx = _clean_primary_context()
    ctx["call_out_fee_claimed"] = True
    ctx["call_out_fee_dispatched_by_emed"] = False
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    actions = [(r.rule_name, r.action.get("type")) for r in result.results]
    rejected = [n for n, a in actions if a == "REJECT"]
    assert any("Call-out fee only for EMED-dispatched" in n for n in rejected)


@pytest.mark.asyncio
async def test_call_out_fee_without_tracking_flags():
    ctx = _clean_primary_context()
    ctx["call_out_fee_claimed"] = True
    ctx["call_out_fee_dispatched_by_emed"] = True
    ctx["vehicle_tracking_report"] = False
    ctx["tracking_error_letter"] = False
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert any("Call-out fee requires PRF + tracking" in n for n in matched)


@pytest.mark.asyncio
async def test_call_out_fee_with_tracking_error_letter_passes():
    ctx = _clean_primary_context()
    ctx["call_out_fee_claimed"] = True
    ctx["call_out_fee_dispatched_by_emed"] = True
    ctx["vehicle_tracking_report"] = False
    ctx["tracking_error_letter"] = True
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert not any("tracking" in n.lower() for n in matched)


@pytest.mark.asyncio
async def test_closest_facility_bypassed_without_motivation_flags():
    ctx = _clean_primary_context()
    ctx["closest_facility_bypassed"] = True
    ctx["motivation_notes"] = ""
    ctx["clinical_notes"] = ""
    result = await evaluate_rules(ctx, db=None, scheme_name="gems")
    matched = [r.rule_name for r in result.results]
    assert any("Bypassing closest" in n for n in matched)


# ═══════════════════════════════════════════════════════════════════════════
# Global helpers
# ═══════════════════════════════════════════════════════════════════════════

def test_multi_patient_multiplier_values():
    assert multi_patient_multiplier(1) == 1.00
    assert multi_patient_multiplier(2) == 0.75
    assert multi_patient_multiplier(3) == 0.50
    assert multi_patient_multiplier(5) == 0.50


# ═══════════════════════════════════════════════════════════════════════════
# Rule shape contract — every rule satisfies the protocol
# ═══════════════════════════════════════════════════════════════════════════

def test_every_gems_rule_has_required_shape():
    for rule in gems_module.RULES:
        assert isinstance(rule.severity, RuleSeverity)
        assert isinstance(rule.action, RuleAction)
        assert isinstance(rule.rule_type, RuleType)
        assert callable(rule.predicate)
        assert rule.name and rule.reason


def test_every_gems_tariff_has_required_shape():
    for t in gems_module.TARIFFS:
        assert t.tariff_code
        assert t.description
        assert isinstance(t.category, TariffCategory)
        assert t.iht_rate >= 0
        assert t.primary_rate >= 0


def test_pdf_grounded_rule_count():
    """Sanity check: the PDF translates to the documented set of rules."""
    # Should be ≥ 20 — bumps loud if rules go missing in a future refactor
    assert len(gems_module.RULES) >= 20
