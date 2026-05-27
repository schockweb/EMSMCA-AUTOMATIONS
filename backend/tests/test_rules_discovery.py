"""Tests for the Discovery hardcoded rules module.

Source rules: Discovery Ambulance Guidelines March 2023.
Pins rate values + verifies every rule fires only on the expected context.
"""
from __future__ import annotations

import pytest

from app.rules import get_rules_for_scheme, list_configured_schemes
from app.rules import discovery as discovery_module
from app.rules.base import (
    RuleAction,
    RuleSeverity,
    RuleType,
    TariffCategory,
)
from app.services.rule_engine import evaluate_rules


# ═══════════════════════════════════════════════════════════════════════════
# Registry resolution
# ═══════════════════════════════════════════════════════════════════════════

def test_discovery_resolves_via_exact_match():
    assert get_rules_for_scheme("discovery") is discovery_module
    assert get_rules_for_scheme("Discovery") is discovery_module


def test_discovery_resolves_via_full_name():
    assert get_rules_for_scheme("Discovery Health Medical Scheme") is discovery_module
    assert get_rules_for_scheme("DHMS") is discovery_module


def test_discovery_appears_in_configured_schemes():
    assert "discovery" in list_configured_schemes()


def test_unrelated_scheme_does_not_resolve_to_discovery():
    assert get_rules_for_scheme("Bonitas") is not discovery_module
    assert get_rules_for_scheme("Momentum") is not discovery_module


# ═══════════════════════════════════════════════════════════════════════════
# Rate sanity — pin so accidental edits fail loud
# ═══════════════════════════════════════════════════════════════════════════

def test_rate_sanity_als_base():
    assert discovery_module.BY_CODE["131"].primary_rate == 5400.00


def test_rate_sanity_ils_base():
    assert discovery_module.BY_CODE["125"].primary_rate == 3950.00


def test_rate_sanity_bls_base():
    assert discovery_module.BY_CODE["100"].primary_rate == 2900.00


def test_rate_sanity_callout_fees_iht_only():
    # IFT call-out fees: primary R0 (IFT-only); iht_rate set
    assert discovery_module.BY_CODE["104"].primary_rate == 0.00
    assert discovery_module.BY_CODE["104"].iht_rate == 480.00
    assert discovery_module.BY_CODE["126"].iht_rate == 620.00
    assert discovery_module.BY_CODE["134"].iht_rate == 780.00


def test_rate_sanity_resuscitation_code_151_present():
    assert "151" in discovery_module.BY_CODE
    assert discovery_module.BY_CODE["151"].category == TariffCategory.PROCEDURE


def test_return_leg_codes_match_pdf():
    # PDF lists 9112 / 9130 / 9142 as return-not-patient-carrying codes
    assert discovery_module.RETURN_LEG_CODES == frozenset({"9112", "9130", "9142"})
    for code in ("9112", "9130", "9142"):
        assert code in discovery_module.BY_CODE
        assert discovery_module.BY_CODE[code].loaded is False


def test_handover_caps_match_pdf():
    assert discovery_module.HANDOVER_MAX_MIN_BLS == 10
    assert discovery_module.HANDOVER_MAX_MIN_ILS == 10
    assert discovery_module.HANDOVER_MAX_MIN_ALS == 20


def test_ift_preauth_threshold_is_100km():
    assert discovery_module.IFT_PREAUTH_KM_THRESHOLD == 100


def test_return_leg_buffer_is_20km():
    assert discovery_module.RETURN_LEG_BUFFER_KM == 20


# ═══════════════════════════════════════════════════════════════════════════
# Accessor shape — what tariff_engine consumes
# ═══════════════════════════════════════════════════════════════════════════

def test_base_rates_cover_all_three_levels():
    rows = discovery_module.all_base_rates()
    codes = {r.tariff_code for r in rows}
    assert {"100", "125", "131"}.issubset(codes)


def test_mileage_six_rows_three_loaded_three_unloaded():
    rows = discovery_module.all_mileage()
    assert len(rows) == 6
    loaded = [r for r in rows if r.loaded is True]
    unloaded = [r for r in rows if r.loaded is False]
    assert len(loaded) == 3 and len(unloaded) == 3


def test_mileage_row_direct_lookup():
    als_loaded = discovery_module.mileage_row("ALS", loaded=True)
    assert als_loaded is not None and als_loaded.tariff_code == "9141"

    bls_unloaded = discovery_module.mileage_row("BLS", loaded=False)
    assert bls_unloaded is not None and bls_unloaded.tariff_code == "9112"


def test_base_rates_for_level_filters_by_bracket_tag():
    als_rows = discovery_module.base_rates_for_level("ALS")
    assert all("[ALS]" in (r.description or "").upper() for r in als_rows)
    assert not any("[BLS]" in (r.description or "").upper() for r in als_rows)


# ═══════════════════════════════════════════════════════════════════════════
# Rule firing
# ═══════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_clean_primary_call_passes_all_rules():
    ctx = {
        "dispatch_type": "Primary",
        "scheme_member_number": "555000111",
        "patient_id_number": "7506155012089",
        "icd10_primary": "I21.0",
        "level_of_care": "ILS",
        "highest_crew_qual": "ILS",
        "scene_minutes": 12,
        "handover_minutes": 5,
        "loaded_distance_km": 14,
        "rtb_distance_km": 14,
        "ils_intervention_performed": True,
        "receiving_facility": "Capital Hospital",
        "patient_count": 1,
    }
    result = await evaluate_rules(ctx, db=None, scheme_name="discovery")
    assert result.matched_rules == 0
    assert result.is_clean


@pytest.mark.asyncio
async def test_ift_over_100km_without_preauth_fires_rfi():
    ctx = {
        "dispatch_type": "IFT",
        "scheme_member_number": "555000111",
        "patient_id_number": "7506155012089",
        "icd10_primary": "I21.0",
        "level_of_care": "ALS",
        "highest_crew_qual": "ALS",
        "total_distance_km": 145,
        "preauth_number": "",
        "loaded_distance_km": 130,
        "rtb_distance_km": 130,
        "als_intervention_performed": True,
        "patient_count": 1,
    }
    result = await evaluate_rules(ctx, db=None, scheme_name="discovery")
    codes = [r.action.get("rfi_code") for r in result.results]
    assert "MISSING_PREAUTH" in codes


@pytest.mark.asyncio
async def test_missing_member_number_is_critical():
    ctx = {
        "dispatch_type": "Primary",
        "scheme_member_number": "",
        "patient_id_number": "7506155012089",
        "level_of_care": "BLS",
        "icd10_primary": "I21.0",
    }
    result = await evaluate_rules(ctx, db=None, scheme_name="discovery")
    assert result.has_critical
    codes = [r.action.get("rfi_code") for r in result.results]
    assert "MISSING_SCHEME_INFO" in codes


@pytest.mark.asyncio
async def test_missing_patient_id_is_critical():
    ctx = {
        "dispatch_type": "Primary",
        "scheme_member_number": "555000111",
        "patient_id_number": "",
        "level_of_care": "ILS",
        "icd10_primary": "I21.0",
    }
    result = await evaluate_rules(ctx, db=None, scheme_name="discovery")
    codes = [r.action.get("rfi_code") for r in result.results]
    assert "MISSING_PATIENT_ID" in codes


@pytest.mark.asyncio
async def test_st_icd10_without_external_cause_flags():
    ctx = {
        "dispatch_type": "Primary",
        "scheme_member_number": "555000111",
        "patient_id_number": "7506155012089",
        "icd10_primary": "S72.0",          # Fracture of femur
        "icd10_external_cause": "",
        "level_of_care": "ILS",
    }
    result = await evaluate_rules(ctx, db=None, scheme_name="discovery")
    codes = [r.action.get("rfi_code") for r in result.results]
    assert "MISSING_EXTERNAL_CAUSE" in codes


@pytest.mark.asyncio
async def test_bls_only_crew_without_supervisor_flags():
    ctx = {
        "dispatch_type": "Primary",
        "scheme_member_number": "555000111",
        "patient_id_number": "7506155012089",
        "icd10_primary": "I21.0",
        "level_of_care": "BLS",
        "highest_crew_qual": "BLS",
        "supervising_practitioner_pr": "",
    }
    result = await evaluate_rules(ctx, db=None, scheme_name="discovery")
    codes = [r.action.get("rfi_code") for r in result.results]
    assert "INVALID_PROVIDER" in codes


@pytest.mark.asyncio
async def test_scene_time_over_20min_without_motivation_flags():
    ctx = {
        "dispatch_type": "Primary",
        "scheme_member_number": "555000111",
        "patient_id_number": "7506155012089",
        "icd10_primary": "I21.0",
        "level_of_care": "ILS",
        "highest_crew_qual": "ILS",
        "scene_minutes": 45,
        "clinical_notes": "",
        "motivation_notes": "",
        "ils_intervention_performed": True,
    }
    result = await evaluate_rules(ctx, db=None, scheme_name="discovery")
    matched = [r.rule_name for r in result.results]
    assert any("Scene time over 20 min" in n for n in matched)


@pytest.mark.asyncio
async def test_return_km_capped_without_tracking_flags():
    # Loaded 100km, RTB 130km — exceeds loaded + 20 buffer (120km)
    ctx = {
        "dispatch_type": "IFT",
        "scheme_member_number": "555000111",
        "patient_id_number": "7506155012089",
        "icd10_primary": "I21.0",
        "level_of_care": "ALS",
        "highest_crew_qual": "ALS",
        "preauth_number": "AUTH-123",
        "total_distance_km": 230,
        "loaded_distance_km": 100,
        "rtb_distance_km": 130,
        "vehicle_tracking_report": False,
        "als_intervention_performed": True,
    }
    result = await evaluate_rules(ctx, db=None, scheme_name="discovery")
    matched = [r.rule_name for r in result.results]
    assert any("Return km capped" in n for n in matched)


@pytest.mark.asyncio
async def test_return_km_with_tracking_proof_passes():
    # Same setup but with tracking report — rule should NOT fire
    ctx = {
        "dispatch_type": "IFT",
        "scheme_member_number": "555000111",
        "patient_id_number": "7506155012089",
        "icd10_primary": "I21.0",
        "level_of_care": "ALS",
        "highest_crew_qual": "ALS",
        "preauth_number": "AUTH-123",
        "total_distance_km": 230,
        "loaded_distance_km": 100,
        "rtb_distance_km": 130,
        "vehicle_tracking_report": True,
        "als_intervention_performed": True,
    }
    result = await evaluate_rules(ctx, db=None, scheme_name="discovery")
    matched = [r.rule_name for r in result.results]
    assert not any("Return km capped" in n for n in matched)


@pytest.mark.asyncio
async def test_no_transport_no_intervention_rejects():
    ctx = {
        "dispatch_type": "Primary",
        "scheme_member_number": "555000111",
        "patient_id_number": "7506155012089",
        "icd10_primary": "I21.0",
        "level_of_care": "BLS",
        "loaded_distance_km": 0,
        "receiving_facility": "",
        "ils_intervention_performed": False,
        "als_intervention_performed": False,
        "resuscitation_performed": False,
        "cpt_codes": [],
    }
    result = await evaluate_rules(ctx, db=None, scheme_name="discovery")
    matched = [(r.rule_name, r.action.get("type")) for r in result.results]
    rejected = [name for name, action in matched if action == "REJECT"]
    assert any("No-transport call" in n for n in rejected)


@pytest.mark.asyncio
async def test_resuscitation_with_code_151_does_not_reject_no_transport():
    # PDF: code 151 valid even when no transport occurred (DOA with active resus)
    ctx = {
        "dispatch_type": "Primary",
        "scheme_member_number": "555000111",
        "patient_id_number": "7506155012089",
        "icd10_primary": "I46.0",
        "level_of_care": "ALS",
        "loaded_distance_km": 0,
        "receiving_facility": "",
        "resuscitation_performed": True,
        "cpt_codes": ["151"],
        "als_intervention_performed": True,
    }
    result = await evaluate_rules(ctx, db=None, scheme_name="discovery")
    rejected = [r for r in result.results if r.action.get("type") == "REJECT"]
    assert not rejected


@pytest.mark.asyncio
async def test_als_billed_without_intervention_flags_upcoding():
    ctx = {
        "dispatch_type": "Primary",
        "scheme_member_number": "555000111",
        "patient_id_number": "7506155012089",
        "icd10_primary": "I21.0",
        "level_of_care": "ALS",
        "highest_crew_qual": "ALS",
        "als_intervention_performed": False,
        "resuscitation_performed": False,
        "clinical_notes": "",
        "motivation_notes": "",
        "loaded_distance_km": 14,
    }
    result = await evaluate_rules(ctx, db=None, scheme_name="discovery")
    codes = [r.action.get("rfi_code") for r in result.results]
    assert "UPCODING_SUSPECTED" in codes


@pytest.mark.asyncio
async def test_tkvo_iv_at_ils_downgrades_to_bls():
    ctx = {
        "dispatch_type": "IFT",
        "scheme_member_number": "555000111",
        "patient_id_number": "7506155012089",
        "icd10_primary": "I21.0",
        "level_of_care": "ILS",
        "highest_crew_qual": "ILS",
        "iv_line_placed": True,
        "iv_tkvo": True,
        "ils_intervention_performed": False,
        "preauth_number": "AUTH-123",
        "loaded_distance_km": 14,
    }
    result = await evaluate_rules(ctx, db=None, scheme_name="discovery")
    actions = [r.action for r in result.results]
    downgrade = [a for a in actions if a.get("type") == "APPLY_MODIFIER" and a.get("modifier") == "DOWNGRADE_BLS"]
    assert downgrade


@pytest.mark.asyncio
async def test_four_or_more_patients_warns():
    ctx = {
        "dispatch_type": "Primary",
        "scheme_member_number": "555000111",
        "patient_id_number": "7506155012089",
        "icd10_primary": "I21.0",
        "level_of_care": "ILS",
        "highest_crew_qual": "ILS",
        "patient_count": 4,
        "loaded_distance_km": 14,
        "ils_intervention_performed": True,
    }
    result = await evaluate_rules(ctx, db=None, scheme_name="discovery")
    warns = [r for r in result.results if r.action.get("type") == "WARN"]
    assert any("4th patient" in r.rule_name for r in warns)


# ═══════════════════════════════════════════════════════════════════════════
# Rule shape contract
# ═══════════════════════════════════════════════════════════════════════════

def test_every_rule_satisfies_contract():
    for rule in discovery_module.RULES:
        assert isinstance(rule.severity, RuleSeverity)
        assert isinstance(rule.action, RuleAction)
        assert isinstance(rule.rule_type, RuleType)
        assert callable(rule.predicate)
        assert rule.name and rule.reason


def test_every_tariff_satisfies_contract():
    for t in discovery_module.TARIFFS:
        assert t.tariff_code
        assert t.description
        assert isinstance(t.category, TariffCategory)
        assert t.iht_rate >= 0
        assert t.primary_rate >= 0
