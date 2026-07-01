"""
Unit tests for the ER24 + Netcare backend rule modules (app/rules/er24.py,
app/rules/netcare.py) and their registration / pricing-safety contract.

Pure-function tests: a rule's `predicate(context)` returns True when the rule
MATCHES (a finding is raised). No DB, no FastAPI, no network.
"""
from app.rules import get_rules_for_scheme, list_configured_schemes
from app.rules import er24, netcare


def _fires(module, context):
    """Return the set of rule names that match for a given context."""
    return {r.name for r in module.RULES if r.predicate(context)}


# ── Registration + pricing-safety contract ──────────────────────────────────

def test_all_four_schemes_registered():
    assert set(list_configured_schemes()) >= {"gems", "discovery", "er24", "netcare"}


def test_resolves_by_name_and_keyword():
    assert get_rules_for_scheme("ER24").SCHEME_ID == "er24"
    assert get_rules_for_scheme("Netcare 911 (Pty) Ltd").SCHEME_ID == "netcare"
    assert get_rules_for_scheme("emergency response 24 hour").SCHEME_ID == "er24"


def test_er24_netcare_are_pricing_disabled():
    # Critical no-regression contract: these modules must NOT be priced through
    # the hardcoded path, so the tariff engine treats them as unconfigured.
    assert er24.PRICING_ENABLED is False
    assert netcare.PRICING_ENABLED is False


def test_gems_discovery_still_priced():
    # GEMS/Discovery must keep the default (priced) behaviour.
    assert getattr(get_rules_for_scheme("GEMS"), "PRICING_ENABLED", True) is True
    assert getattr(get_rules_for_scheme("Discovery Health"), "PRICING_ENABLED", True) is True


# ── None-safety: sparse / empty contexts must never raise ────────────────────

def test_predicates_are_none_safe():
    for module in (er24, netcare):
        for ctx in ({}, {"dispatch_type": None}, {"icd10_primary": None, "vitals_count": None}):
            for rule in module.RULES:
                # Must return a bool and not raise on missing keys.
                assert isinstance(rule.predicate(ctx), bool)


# ── ER24 rule behaviour ──────────────────────────────────────────────────────

def test_er24_member_number_required():
    assert "ER24: Member number required" in _fires(er24, {"icd10_primary": "I21.0"})
    assert "ER24: Member number required" not in _fires(er24, {"medical_aid_number": "MA1", "icd10_primary": "I21.0"})


def test_er24_diagnosis_icd10():
    assert "ER24: Diagnosis ICD-10 required" in _fires(er24, {"icd10_primary": "heart attack"})
    assert "ER24: Diagnosis ICD-10 required" not in _fires(er24, {"icd10_primary": "I21.0"})


def test_er24_min_vitals_ift_needs_three():
    ift = {"dispatch_type": "IFT", "vitals_count": 2}
    assert "ER24: Minimum vitals sets" in _fires(er24, ift)
    ift3 = {"dispatch_type": "IFT", "vitals_count": 3}
    assert "ER24: Minimum vitals sets" not in _fires(er24, ift3)
    prim2 = {"dispatch_type": "Primary", "vitals_count": 2}
    assert "ER24: Minimum vitals sets" not in _fires(er24, prim2)


def test_er24_iv_downgrade_unless_justified():
    unjust = {"level_of_care": "ILS", "procedures_performed": "IV cannula left ACF", "clinical_notes": "stable"}
    assert "ER24: IV access not justified - downgrade to BLS" in _fires(er24, unjust)
    just = {"level_of_care": "ILS", "procedures_performed": "IV cannula", "clinical_notes": "fluid replacement for hypovolaemia"}
    assert "ER24: IV access not justified - downgrade to BLS" not in _fires(er24, just)


def test_er24_scene_time():
    over = {"scene_minutes": 35, "level_of_care": "ALS", "clinical_notes": "routine"}
    assert "ER24: Scene time exceeds allowance without motivation" in _fires(er24, over)
    icu_ok = {"scene_minutes": 35, "level_of_care": "ICU"}
    assert "ER24: Scene time exceeds allowance without motivation" not in _fires(er24, icu_ok)
    motivated = {"scene_minutes": 35, "level_of_care": "ALS", "clinical_notes": "prolonged extrication by fire dept"}
    assert "ER24: Scene time exceeds allowance without motivation" not in _fires(er24, motivated)


def test_er24_clean_context_silent():
    clean = {
        "dispatch_type": "Primary", "scheme_member_number": "123456789",
        "icd10_primary": "I21.0", "vitals_count": 3, "level_of_care": "BLS",
    }
    assert _fires(er24, clean) == set()


# ── Netcare rule behaviour ───────────────────────────────────────────────────

def test_netcare_13_digit_preauth():
    bad = {"dispatch_type": "IHT", "preauth_number": "12345"}
    assert "Netcare: IFT/IHT 13-digit pre-authorisation" in _fires(netcare, bad)
    ok = {"dispatch_type": "IHT", "preauth_number": "1234567890123"}
    assert "Netcare: IFT/IHT 13-digit pre-authorisation" not in _fires(netcare, ok)
    primary = {"dispatch_type": "Primary"}
    assert "Netcare: IFT/IHT 13-digit pre-authorisation" not in _fires(netcare, primary)


def test_netcare_patient_id():
    assert "Netcare: Valid patient ID / passport" in _fires(netcare, {"patient_id_number": "abc"})
    assert "Netcare: Valid patient ID / passport" not in _fires(netcare, {"patient_id_number": "9001015009087"})
    assert "Netcare: Valid patient ID / passport" not in _fires(netcare, {"patient_id_number": "AB123456"})


def test_netcare_three_vitals():
    assert "Netcare: Minimum 3 vitals sets" in _fires(netcare, {"vitals_count": 2})
    assert "Netcare: Minimum 3 vitals sets" not in _fires(netcare, {"vitals_count": 3})


def test_netcare_receiving_facility_skips_dod():
    transport = {"dispatch_type": "Primary", "receiving_facility": ""}
    assert "Netcare: Receiving facility required" in _fires(netcare, transport)
    dod = {"call_type": "DOD", "dispatch_type": "Primary", "receiving_facility": ""}
    assert "Netcare: Receiving facility required" not in _fires(netcare, dod)


def test_netcare_resus_requires_als():
    assert "Netcare: Resuscitation fee requires ALS" in _fires(netcare, {"resuscitation_attempted": True, "level_of_care": "ILS"})
    assert "Netcare: Resuscitation fee requires ALS" not in _fires(netcare, {"resuscitation_attempted": True, "level_of_care": "ALS"})


def test_netcare_clean_context_silent():
    clean = {
        "dispatch_type": "Primary", "preauth_number": "", "patient_id_number": "9001015009087",
        "vitals_count": 3, "icd10_primary": "J18.9", "receiving_facility": "City Hospital",
        "level_of_care": "BLS",
    }
    assert _fires(netcare, clean) == set()
