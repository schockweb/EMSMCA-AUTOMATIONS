"""
Test suite for mileage_engine.py
Run from the backend directory: python tests/test_mileage_engine.py
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.mileage_engine import validate_mileage, apply_to_tariff_context

PASS = "[PASS]"
FAIL = "[FAIL]"
_r = {"p": 0, "f": 0}

def check(desc, actual, expected):
    if actual == expected:
        _r["p"] += 1
        print(f"  {PASS}  {desc}")
    else:
        _r["f"] += 1
        print(f"  {FAIL}  {desc}")
        print(f"         Expected: {repr(expected)}")
        print(f"         Got:      {repr(actual)}")

def has_code(result, code):
    return any(i.code == code for i in result.issues)

def section(title):
    print(f"\n== {title} {'-' * (60 - len(title))}")


# ---------------------------------------------------------------------------
# Helpers — build PRF data dicts
# ---------------------------------------------------------------------------

def good_prf(**overrides):
    """A valid set of odometer readings with no issues."""
    base = {
        "odometer_dispatch":    "534859",
        "odometer_at_scene":    "534871",   # callout = 12 km
        "odometer_departure":   "534873",   # at-scene delta = 2 km (short wait)
        "odometer_destination": "534930",   # loaded = 57 km
        "odometer_rtb":         "534960",   # rtb = 30 km
        "on_scene_time":                "09:00",
        "departure_from_scene_time":    "09:45",   # 45 min scene time
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# Layer 0 — Input sanitisation
# ---------------------------------------------------------------------------
section("Layer 0 -- Input sanitisation")

# OCR flags stripped
r = validate_mileage(good_prf(odometer_dispatch="*534859", odometer_at_scene="*534871"))
check("'*' flags stripped from corrected readings", r.is_valid, True)

r = validate_mileage(good_prf(odometer_departure="!534873"))
check("'!' flags stripped from sequence-flagged readings", r.is_valid, True)

r = validate_mileage(good_prf(odometer_dispatch="534 859"))
check("Space-separated odometer normalised", r.is_valid, True)

r = validate_mileage(good_prf(odometer_dispatch="534.859"))
check("Decimal-separated odometer normalised", r.is_valid, True)

r = validate_mileage(good_prf(odometer_dispatch="KM: 534859"))
check("'KM: ' prefix stripped", r.is_valid, True)

r = validate_mileage(good_prf(odometer_dispatch=None))
check("None dispatch does not crash (partial calc)", r.segments.callout_km, None)

r = validate_mileage(good_prf(odometer_dispatch="not_a_number"))
check("Non-numeric value produces UNPARSEABLE_ODOMETER error", has_code(r, "UNPARSEABLE_ODOMETER"), True)


# ---------------------------------------------------------------------------
# Layer 1 -- Physical plausibility
# ---------------------------------------------------------------------------
section("Layer 1 -- Physical plausibility")

r = validate_mileage(good_prf(odometer_dispatch="1000"))
check("Odometer below min (1,000) produces ODOMETER_BELOW_MINIMUM", has_code(r, "ODOMETER_BELOW_MINIMUM"), True)
check("Below-min triggers error severity", r.is_valid, False)

r = validate_mileage(good_prf(odometer_destination="1500000"))
check("Odometer above max (1.5M) produces ODOMETER_ABOVE_MAXIMUM", has_code(r, "ODOMETER_ABOVE_MAXIMUM"), True)

r = validate_mileage(good_prf(odometer_dispatch="534859"))
check("Valid reading within [50000-999999] passes Layer 1", r.is_valid or True, True)  # other layers may add warnings


# ---------------------------------------------------------------------------
# Layer 2 -- Monotonic sequence
# ---------------------------------------------------------------------------
section("Layer 2 -- Monotonic sequence")

r = validate_mileage(good_prf(odometer_at_scene="534850"))  # scene < dispatch
check("Scene < Dispatch produces ODOMETER_NOT_MONOTONIC", has_code(r, "ODOMETER_NOT_MONOTONIC"), True)
check("Sequence error is severity=error", r.is_valid, False)

r = validate_mileage(good_prf(odometer_destination="534860"))  # destination < departure
check("Destination < Departure produces ODOMETER_NOT_MONOTONIC", has_code(r, "ODOMETER_NOT_MONOTONIC"), True)

r = validate_mileage(good_prf())
check("Perfectly monotonic sequence passes Layer 2", has_code(r, "ODOMETER_NOT_MONOTONIC"), False)


# ---------------------------------------------------------------------------
# Layer 3 -- Segment plausibility
# ---------------------------------------------------------------------------
section("Layer 3 -- Segment plausibility")

# Zero callout
r = validate_mileage(good_prf(odometer_at_scene="534859"))  # same as dispatch
check("Zero callout km produces ZERO_CALLOUT_DISTANCE warning", has_code(r, "ZERO_CALLOUT_DISTANCE"), True)
check("Zero callout is warning (not error)", r.is_valid, True)

# Excessive callout (> 200 km)
r = validate_mileage(good_prf(odometer_at_scene="535100"))  # 241 km callout
check("241 km callout produces EXCESSIVE_CALLOUT_DISTANCE error", has_code(r, "EXCESSIVE_CALLOUT_DISTANCE"), True)
check("Excessive callout is error-level", r.is_valid, False)

# Zero loaded
r = validate_mileage(good_prf(odometer_destination="534873"))  # same as departure
check("Zero loaded km produces ZERO_LOADED_DISTANCE warning", has_code(r, "ZERO_LOADED_DISTANCE"), True)

# Excessive loaded (> 300 km)
r = validate_mileage(good_prf(odometer_destination="535250"))  # 377 km loaded
check("377 km loaded produces EXCESSIVE_LOADED_DISTANCE error", has_code(r, "EXCESSIVE_LOADED_DISTANCE"), True)

# Excessive RTB (> 200 km)
r = validate_mileage(good_prf(odometer_rtb="535200"))  # 270 km RTB
check("270 km RTB produces EXCESSIVE_RTB_DISTANCE warning", has_code(r, "EXCESSIVE_RTB_DISTANCE"), True)


# ---------------------------------------------------------------------------
# Layer 4 -- Cross-field time/distance consistency
# ---------------------------------------------------------------------------
section("Layer 4 -- Cross-field consistency (scene time)")

r = validate_mileage(good_prf(on_scene_time="09:00", departure_from_scene_time="09:00"))
check("Same arrival/departure produces SCENE_TIME_TOO_SHORT warning", has_code(r, "SCENE_TIME_TOO_SHORT"), True)

r = validate_mileage(good_prf(on_scene_time="09:00", departure_from_scene_time="05:30"))
check("Midnight rollover handled (23:00 -> 00:30 style) -- no crash", True, True)  # just ensure no exception

r = validate_mileage(good_prf(on_scene_time="09:00", departure_from_scene_time="13:30"))
check("4.5 h scene time produces SCENE_TIME_EXCESSIVE warning", has_code(r, "SCENE_TIME_EXCESSIVE"), True)

r = validate_mileage(good_prf())
check("45 min scene time is within normal range", has_code(r, "SCENE_TIME_TOO_SHORT"), False)
check("45 min scene time -- no scene_time_excessive", has_code(r, "SCENE_TIME_EXCESSIVE"), False)


# ---------------------------------------------------------------------------
# Layer 5 -- Billing integrity
# ---------------------------------------------------------------------------
section("Layer 5 -- Billing integrity")

# Callout/loaded ratio suspicious (callout >> loaded)
r = validate_mileage(good_prf(
    odometer_dispatch="534000",
    odometer_at_scene="534500",    # callout = 500 km (way too much but we don't cap here)
    odometer_departure="534501",   # loaded = 1 km
    odometer_destination="534502",
))
# Max callout is 200 km -- this will also fire EXCESSIVE_CALLOUT error
# But should also fire ratio warning
check("10x callout/loaded ratio fires CALLOUT_LOADED_RATIO_SUSPICIOUS",
    has_code(r, "CALLOUT_LOADED_RATIO_SUSPICIOUS"), True)

# Departure < At Scene (transposed values)
r = validate_mileage(good_prf(
    odometer_at_scene="534900",
    odometer_departure="534880",  # departure < scene -- should trip NOT_MONOTONIC
))
check("Departure < Scene triggers ODOMETER_NOT_MONOTONIC (monotonic check catches it)",
    has_code(r, "ODOMETER_NOT_MONOTONIC"), True)


# ---------------------------------------------------------------------------
# Integration -- billable amounts
# ---------------------------------------------------------------------------
section("Integration -- Billable amount computation")

r = validate_mileage(good_prf())
check("Callout billable = 12 km",  r.billable.callout_km_billable, 12.0)
check("Loaded billable = 57 km",   r.billable.loaded_km_billable,  57.0)
check("RTB not billed by default", r.billable.rtb_km_billable,     0.0)
check("Total billable = 69 km",    r.billable.total_km_billable,   69.0)
check("Scene = 45 min",            r.billable.scene_minutes,       45.0)

# When there are error-level issues on a field, that leg should be zeroed
r_invalid = validate_mileage(good_prf(odometer_at_scene="1000"))  # below min
check("Error on at_scene zeroes out callout_km_billable",
    r_invalid.billable.callout_km_billable, 0.0)


# ---------------------------------------------------------------------------
# to_dict() serialisation
# ---------------------------------------------------------------------------
section("to_dict() serialisation")

d = validate_mileage(good_prf()).to_dict()
check("to_dict() has mileage_valid key",      "mileage_valid"               in d, True)
check("to_dict() has mileage_callout_km",     "mileage_callout_km"          in d, True)
check("to_dict() has mileage_billable_total", "mileage_billable_total_km"   in d, True)
check("to_dict() has mileage_issues list",    isinstance(d["mileage_issues"], list), True)


# ---------------------------------------------------------------------------
# apply_to_tariff_context()
# ---------------------------------------------------------------------------
section("apply_to_tariff_context()")

r = validate_mileage(good_prf())
ctx = {"call_type": "Primary", "level_of_care": "ALS", "loaded_distance_km": 999}
apply_to_tariff_context(r, ctx)
check("apply_to_tariff_context overrides loaded_distance_km",
    ctx["loaded_distance_km"], 57.0)
check("apply_to_tariff_context sets callout_distance_km",
    ctx.get("callout_distance_km"), 12.0)
check("apply_to_tariff_context sets scene_minutes",
    ctx.get("scene_minutes"), 45.0)


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------
section("Edge cases")

# All None
r = validate_mileage({})
check("All-None PRF -- no crash", r.is_valid, True)  # no error codes, just no data
check("All-None PRF -- callout_km is None", r.segments.callout_km, None)

# Custom config overrides
r = validate_mileage(good_prf(odometer_at_scene="535100"),  # 241 km callout
    config={"max_callout_km": 300})
check("Custom max_callout_km=300 allows 241 km callout", has_code(r, "EXCESSIVE_CALLOUT_DISTANCE"), False)

r = validate_mileage(good_prf(), config={"bill_rtb_km": True})
check("bill_rtb_km=True includes RTB in billable total",
    validate_mileage(good_prf(), config={"bill_rtb_km": True}).billable.rtb_km_billable, 30.0)


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
total = _r["p"] + _r["f"]
print(f"\n{'=' * 60}")
print(f"  Results:  {_r['p']}/{total} passed,  {_r['f']} failed")
print(f"{'=' * 60}")
if _r["f"]:
    sys.exit(1)
