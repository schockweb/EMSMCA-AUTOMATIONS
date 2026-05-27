"""
Test suite for odometer_utils.py
Run from the backend directory:  python tests/test_odometer_utils.py
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.odometer_utils import (
    normalise_reading,
    detect_common_prefix,
    anchor_reading,
    validate_sequence,
    process_odometer_set,
)

# ---- Helpers -----------------------------------------------------------------

PASS = "[PASS]"
FAIL = "[FAIL]"
_results = {"pass": 0, "fail": 0}


def check(description, actual, expected):
    if actual == expected:
        _results["pass"] += 1
        print(f"  {PASS}  {description}")
    else:
        _results["fail"] += 1
        print(f"  {FAIL}  {description}")
        print(f"         Expected: {repr(expected)}")
        print(f"         Got:      {repr(actual)}")


def section(title):
    bar = "-" * (60 - len(title))
    print(f"\n== {title} {bar}")


# ---- 1. normalise_reading ----------------------------------------------------
section("normalise_reading")

check("Plain integer",            normalise_reading("534859"),     "534859")
check("Space-separated",          normalise_reading("534 859"),    "534859")
check("Pipe-separated",           normalise_reading("534|859"),    "534859")
check("Decimal-separated",        normalise_reading("534.859"),    "534859")
check("Dash-separated",           normalise_reading("534-859"),    "534859")
check("Leading/trailing spaces",  normalise_reading("  534859 "), "534859")
check("None input",               normalise_reading(None),         None)
check("Empty string",             normalise_reading(""),            None)
check("All non-digit chars",      normalise_reading("km only"),    None)
check("Mixed text + digits",      normalise_reading("KM: 534859"), "534859")


# ---- 2. detect_common_prefix -------------------------------------------------
section("detect_common_prefix")

# All correct -- unanimous on '534' at length 3, also unanimous on '5348' at length 4
# Tie-break: longest prefix when all counts are equal
check("All agree at '534' (with 535 roll-over, peak=4 at len3)",
    detect_common_prefix(["534859", "534871", "534891", "534915", "535004"]),
    "534")

# One bad (short) reading excluded -- remaining 4 agree on '534' at len 3
check("One short OCR fragment excluded -- '534' still found",
    detect_common_prefix(["534859", "534871", "71", "534915", "535004"]),
    "534")

# Two bad short readings excluded -- 3 agree on '534' at len 3, meets ceil(3/2)=2
# But '891' has 3 chars and votes for itself, raising n to 4, min_agreement=2
# '534' still gets >=2 votes and is returned
check("Two OCR misses -- majority (3/5 full-length) finds '534'",
    detect_common_prefix(["534859", "71", "891", "534915", "535004"]),
    "534")

check("All bad readings -- no prefix",
    detect_common_prefix(["11", "22", "33", "44", "55"]),
    None)

check("Empty list -- no prefix",
    detect_common_prefix([]),
    None)

check("All None -- no prefix",
    detect_common_prefix([None, None, None, None, None]),
    None)

# High-mileage fleet: all agree on '1204' at length 4 AND '120' at length 3
# Tie-break: longest prefix (most specific) is preferred
check("High-mileage fleet -- longest unanimous prefix '1204'",
    detect_common_prefix(["1204123", "1204245", "1204310", "1204401", "1204589"]),
    "1204")

# All all agree on '534', '5348', all the way -- longest unanimous wins
check("Tight readings -- longest unanimous prefix '5348'",
    detect_common_prefix(["534812", "534823", "534836", "534851", "534899"]),
    "5348")


# ---- 3. anchor_reading -------------------------------------------------------
section("anchor_reading")

check("Already starts with prefix -- unchanged",
    anchor_reading("534859", "534"),
    "534859")

# '859' is exactly 6-3=3 chars -> prepend '534'
check("Suffix only '859' (len=3) -> prepend '534' -> '*534859'",
    anchor_reading("859", "534", expected_length=6),
    "*534859")

# '594859' is 6 chars, wrong leading digits -> replace
check("Wrong leading digits '594859' -> replace -> '*534859'",
    anchor_reading("594859", "534", expected_length=6),
    "*534859")

# '71' is only 2 chars -- no rule can safely recover it
check("Too short to anchor '71' -- returned as-is",
    anchor_reading("71", "534", expected_length=6),
    "71")

check("None input -> None",
    anchor_reading(None, "534"),
    None)

# Roll-over: '535004' starts with '535' which is prefix '534' + 1
check("Roll-over '535004' with prefix '534' -- left unchanged",
    anchor_reading("535004", "534", expected_length=6),
    "535004")

check("Prefix len 4 -- already correct",
    anchor_reading("12041234", "1204", expected_length=8),
    "12041234")

check("Prefix len 4 -- prepend missing prefix",
    anchor_reading("1234", "1204", expected_length=8),
    "*12041234")


# ---- 4. validate_sequence ----------------------------------------------------
section("validate_sequence")

check("Perfect monotonic sequence -- no flags",
    validate_sequence(["534859", "534871", "534891", "534915", "535004"]),
    ["534859", "534871", "534891", "534915", "535004"])

seq = validate_sequence(["534859", "534871", "534800", "534915", "535004"])
check("Third reading drops -- flagged with '!'",
    seq[2].startswith("!"),
    True)

seq2 = validate_sequence(["534859", None, "534891", "534915", None])
check("None values skip cleanly without breaking sequence",
    seq2[2],
    "534891")

seq3 = validate_sequence(["534859", "*534871", "534891", "534915", "535004"])
check("'*'-prefixed values are compared numerically",
    seq3,
    ["534859", "*534871", "534891", "534915", "535004"])


# ---- 5. process_odometer_set (integration) -----------------------------------
section("process_odometer_set -- integration")

# Happy path: all readings present, correctly split by OCR artefacts
result = process_odometer_set({
    "odometer_dispatch":    "534 859",
    "odometer_at_scene":    "534.871",
    "odometer_departure":   "534|891",
    "odometer_destination": "534915",
    "odometer_rtb":         "535004",   # legitimate roll-over
})
check("Happy path -- prefix '534' detected",     result.prefix_detected,  "534")
check("Happy path -- no corrections needed",     result.corrections_made, [])
check("Happy path -- sequence valid",            result.sequence_valid,   True)
check("Happy path -- dispatch normalised",       result.dispatch,         "534859")
check("Happy path -- rtb unchanged (roll-over)", result.rtb,              "535004")

# One OCR miss: '71' is 2 chars -- too short to safely anchor
# It will be excluded from prefix detection, but anchor_reading cannot fix it
result2 = process_odometer_set({
    "odometer_dispatch":    "534859",
    "odometer_at_scene":    "71",        # Only 2 chars -- cannot anchor
    "odometer_departure":   "534891",
    "odometer_destination": "534915",
    "odometer_rtb":         "535004",
})
check("One 2-char OCR miss -- prefix '534' still detected",
    result2.prefix_detected, "534")
# '71' is 2 chars -- cannot be anchored (too short/ambiguous).
# validate_sequence then flags it because 71 < 534859.
# Correct behaviour: reviewer must fix it manually.
check("One 2-char OCR miss -- '71' unrecoverable, sequence-flags it",
    result2.at_scene, "!71")

# One OCR miss with recoverable suffix (3 chars): '871' -> '*534871'
result2b = process_odometer_set({
    "odometer_dispatch":    "534859",
    "odometer_at_scene":    "871",       # 3-char suffix -- can be anchored
    "odometer_departure":   "534891",
    "odometer_destination": "534915",
    "odometer_rtb":         "535004",
})
check("One 3-char OCR miss -- at_scene '871' corrected to '*534871'",
    result2b.at_scene, "*534871")
check("One 3-char OCR miss -- odometer_at_scene in corrections",
    "odometer_at_scene" in result2b.corrections_made, True)

# Two OCR misses (both full-length suffix)
result3 = process_odometer_set({
    "odometer_dispatch":    "534859",
    "odometer_at_scene":    "534871",
    "odometer_departure":   "891",       # 3-char suffix
    "odometer_destination": "915",       # 3-char suffix
    "odometer_rtb":         "535004",
})
# Two 3-char OCR misses:
# Valid pool (>=5 digits) = [534859, 534871, 535004] -> n=3, min_agreement=2
# At len3: 534x2, 535x1 -> peak=2; at len4: 5348x2, 5350x1 -> peak=2 (tie)
# Tie-break: longest -> prefix='5348'. Both '891'/'915' cannot be anchored
# to '5348' (suffix_len=2, but they are 3 digits) -> left unanchored.
# This is correct: the reviewer sees them flagged red and fixes manually.
check("Two 3-char OCR misses -- prefix detected (5348, longest tie-winner)",
    result3.prefix_detected, "5348")
check("Two 3-char OCR misses -- departure cannot be safely anchored (stays as-is)",
    result3.departure.lstrip("!"), "891")

# Sequence violation
result4 = process_odometer_set({
    "odometer_dispatch":    "534859",
    "odometer_at_scene":    "534871",
    "odometer_departure":   "534800",    # drops below scene
    "odometer_destination": "534915",
    "odometer_rtb":         "535004",
})
check("Sequence violation -- flagged_keys contains departure",
    "odometer_departure" in result4.flagged_keys, True)
check("Sequence violation -- sequence_valid is False",
    result4.sequence_valid, False)

# All None -- no crash
result5 = process_odometer_set({
    "odometer_dispatch":    None,
    "odometer_at_scene":    None,
    "odometer_departure":   None,
    "odometer_destination": None,
    "odometer_rtb":         None,
})
check("All None -- no crash, prefix is None",
    result5.prefix_detected, None)

# Custom config (high-mileage fleet, 4-digit prefix)
result6 = process_odometer_set(
    {
        "odometer_dispatch":    "1204123",
        "odometer_at_scene":    "1204245",
        "odometer_departure":   "1204310",
        "odometer_destination": "1204401",
        "odometer_rtb":         "1204589",
    },
    config={"expected_prefix_length": 4, "typical_trip_max_km": 150},
)
check("Custom config -- prefix '1204' detected",
    result6.prefix_detected, "1204")
check("Custom config -- sequence valid",
    result6.sequence_valid, True)

# as_dict() serialisation
d = result.as_dict()
check("as_dict() contains odometer_prefix_detected",
    "odometer_prefix_detected" in d, True)
check("as_dict() contains odometer_dispatch",
    "odometer_dispatch" in d, True)


# ---- Summary -----------------------------------------------------------------
total = _results["pass"] + _results["fail"]
print(f"\n{'=' * 60}")
print(f"  Results:  {_results['pass']}/{total} passed,  {_results['fail']} failed")
print(f"{'=' * 60}")
if _results["fail"]:
    sys.exit(1)
