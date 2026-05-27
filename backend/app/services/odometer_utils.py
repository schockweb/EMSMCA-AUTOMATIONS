"""
Odometer Reading Utility -- EMS PRF Extraction Pipeline
=======================================================
South African EMS ambulance odometers record 5 readings per trip:
  Dispatch -> At Scene -> Departure -> At Destination -> RTB

Because all readings come from the same vehicle on the same trip,
they share the same leading 2-4 digits (the "prefix").  OCR frequently
mistakes individual digits, but the shared prefix is a strong statistical
anchor that lets us detect and repair bad readings deterministically.

Public API
----------
    normalise_reading(raw)                -> str | None
    detect_common_prefix(readings, ...)   -> str | None
    anchor_reading(raw, prefix, ...)      -> str
    validate_sequence(readings)           -> list[str | None]
    process_odometer_set(raw_set, config) -> OdometerResult
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger("ems.odometer")

# --- Constants ----------------------------------------------------------------

DEFAULT_EXPECTED_LENGTH = 6       # Most SA EMS vehicles: 100,000-999,999 km
DEFAULT_MIN_PREFIX_LEN  = 3       # Minimum digits considered a valid prefix
DEFAULT_TRIP_MAX_KM     = 150     # Trip distance > this (km) triggers a warning
DEFAULT_RANGE_MIN       = 0
DEFAULT_RANGE_MAX       = 999_999


# --- Data class for final result ----------------------------------------------

@dataclass
class OdometerResult:
    """Result returned by process_odometer_set()."""
    dispatch:    Optional[str] = None
    at_scene:    Optional[str] = None
    departure:   Optional[str] = None
    destination: Optional[str] = None
    rtb:         Optional[str] = None

    prefix_detected:    Optional[str]  = None
    sequence_valid:     bool           = True
    flagged_keys:       list[str]      = field(default_factory=list)
    corrections_made:   list[str]      = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "odometer_dispatch":    self.dispatch,
            "odometer_at_scene":    self.at_scene,
            "odometer_departure":   self.departure,
            "odometer_destination": self.destination,
            "odometer_rtb":         self.rtb,
            "odometer_prefix_detected": self.prefix_detected,
        }


# --- Step 1: Normalise --------------------------------------------------------

def normalise_reading(raw: Optional[str]) -> Optional[str]:
    """Strip all non-digit characters. Returns None for empty / None input."""
    if raw is None:
        return None
    digits = re.sub(r"[^\d]", "", str(raw))
    return digits if digits else None


# --- Step 2: Detect common prefix --------------------------------------------

def detect_common_prefix(
    readings: list[Optional[str]],
    min_prefix_len: int = DEFAULT_MIN_PREFIX_LEN,
    min_agreement: Optional[int] = None,
) -> Optional[str]:
    """
    Find the prefix shared by the MAXIMUM number of readings (peak-vote model).

    Algorithm
    ---------
    1. Normalise all readings and keep only those >= min_prefix_len digits long.
       Short OCR fragments (e.g. '71', '891') are excluded from the candidate pool
       but their presence is tolerated.
    2. For each prefix length L from min_prefix_len up to min(shortest, 6):
       - Tally the most common L-digit prefix among valid readings.
       - Record (L, prefix, count).
    3. Select the entry with the highest count.  If there is a tie, pick the
       SHORTEST prefix (most conservative).
    4. Return the winner only if count >= min_agreement (default ceil(n/2)).

    Why peak-vote instead of longest-first?
    ----------------------------------------
    All 5 readings of a trip share the first ~3 digits.  But the RTB leg may
    cross an odometer boundary (e.g. 534xxx -> 535xxx).  In that case:
      - At length 3: '534' gets 4/5 votes, '535' gets 1/5.   COUNT=4
      - At length 4: '5348' gets 3/5 votes, different ones.  COUNT=3
    Peak vote is at length 3 ('534') and that is returned, correctly ignoring
    the roll-over reading.

    Returns None if no prefix meets the min_agreement threshold.
    """
    normalised = [normalise_reading(r) for r in readings]
    valid = [v for v in normalised if v and len(v) >= max(min_prefix_len + 2, 5)]

    if not valid:
        return None

    n = len(valid)
    if min_agreement is None:
        min_agreement = math.ceil(n / 2)

    max_possible_len = min(len(v) for v in valid)
    max_search_len   = min(max_possible_len, 6)

    # Collect results for each prefix length
    results = []   # list of (count, prefix_len, prefix_str)
    for prefix_len in range(min_prefix_len, max_search_len + 1):
        tally: dict[str, int] = {}
        for v in valid:
            pfx = v[:prefix_len]
            tally[pfx] = tally.get(pfx, 0) + 1
        top_pfx, top_count = max(tally.items(), key=lambda x: x[1])
        results.append((top_count, prefix_len, top_pfx))
        logger.debug(
            "[Odometer] Length %d: best='%s' count=%d/%d",
            prefix_len, top_pfx, top_count, n,
        )

    if not results:
        return None

    # Best = highest count; tie-break by shortest prefix length
    # Since we built results in ascending prefix_len order, we can sort by
    # (-count, prefix_len) to get the entry with the most votes and shortest len.
    results.sort(key=lambda r: (-r[0], -r[1]))
    best_count, best_len, best_prefix = results[0]

    if best_count < min_agreement:
        logger.debug(
            "[Odometer] Best count %d < min_agreement %d -- no prefix returned.",
            best_count, min_agreement,
        )
        return None

    logger.debug(
        "[Odometer] Prefix '%s' (len=%d) agreed on by %d/%d readings.",
        best_prefix, best_len, best_count, n,
    )
    return best_prefix


# --- Step 3: Anchor a single reading to the prefix ---------------------------

def anchor_reading(
    normalised: Optional[str],
    prefix: str,
    expected_length: int = DEFAULT_EXPECTED_LENGTH,
) -> Optional[str]:
    """
    Given a normalised reading and a known prefix, attempt to correct it.

    Rules (in order)
    ----------------
    1. Already starts with prefix -> return as-is.
    2. Roll-over: full-length reading whose leading digits are exactly 1 more
       than the prefix (e.g. prefix='534', reading='535004') -> leave unchanged.
    3. Reading length == expected_length - len(prefix): missing the prefix
       entirely (OCR only captured the suffix) -> prepend prefix.
    4. Reading length == expected_length but wrong leading digits -> replace
       the leading digits with the prefix.
    5. Anything else (too short/long to diagnose) -> return as-is.

    Corrected values are tagged with '*' so the UI can highlight them.
    """
    if not normalised:
        return None

    # Rule 1: already correct
    if normalised.startswith(prefix):
        return normalised

    plen = len(prefix)

    # Rule 2: legitimate roll-over (e.g. prefix=534, reading=535xxx)
    if len(normalised) >= expected_length:
        try:
            leading_prefix_val  = int(prefix)
            leading_reading_val = int(normalised[:plen])
            if leading_reading_val - leading_prefix_val == 1:
                return normalised   # roll-over reading, don't correct
        except (ValueError, TypeError):
            pass

    # Rule 3: reading is just the suffix (OCR missed the leading digits)
    expected_suffix_len = expected_length - plen
    if len(normalised) == expected_suffix_len:
        corrected = prefix + normalised
        logger.info(
            "[Odometer] Anchored '%s' -> '%s' (prepended missing prefix).",
            normalised, corrected,
        )
        return "*" + corrected

    # Rule 4: correct length but wrong leading digits
    if len(normalised) == expected_length:
        corrected = prefix + normalised[plen:]
        logger.info(
            "[Odometer] Anchored '%s' -> '%s' (replaced wrong leading digits).",
            normalised, corrected,
        )
        return "*" + corrected

    # Rule 5: can't resolve -- leave for manual review
    logger.warning(
        "[Odometer] Could not anchor '%s' to prefix '%s'.", normalised, prefix,
    )
    return normalised


# --- Step 4: Validate monotonic sequence -------------------------------------

def validate_sequence(readings: list[Optional[str]]) -> list[Optional[str]]:
    """
    Ensure the 5 odometer readings are monotonically non-decreasing.

    Any reading that is less than the previous valid reading is flagged
    by prepending '!' (e.g. '534800' -> '!534800').
    Already-corrected values (starting with '*') are compared numerically.
    """
    result: list[Optional[str]] = list(readings)
    last_valid: Optional[int] = None

    for i, raw in enumerate(result):
        if raw is None:
            continue
        digits = re.sub(r"[^\d]", "", raw)
        if not digits:
            continue
        val = int(digits)

        if last_valid is not None and val < last_valid:
            result[i] = "!" + raw
            logger.warning(
                "[Odometer] Reading #%d ('%s') < previous (%d) -- flagged.",
                i, raw, last_valid,
            )
        else:
            last_valid = val

    return result


# --- Public high-level entry point -------------------------------------------

def process_odometer_set(
    raw_set: dict,
    config: Optional[dict] = None,
) -> OdometerResult:
    """
    Full odometer processing pipeline for one set of 5 readings.

    Parameters
    ----------
    raw_set : dict
        Keys: odometer_dispatch, odometer_at_scene, odometer_departure,
              odometer_destination, odometer_rtb.
        Values: raw strings as returned by the LLM.

    config : dict (optional)
        From extraction_settings.json -> odometer_config:
          expected_prefix_length : int  (default 3)
          typical_trip_max_km    : int  (default 150)
    """
    cfg = config or {}
    expected_prefix_length = int(cfg.get("expected_prefix_length", DEFAULT_MIN_PREFIX_LEN))
    typical_trip_max_km    = int(cfg.get("typical_trip_max_km",    DEFAULT_TRIP_MAX_KM))

    keys = [
        "odometer_dispatch",
        "odometer_at_scene",
        "odometer_departure",
        "odometer_destination",
        "odometer_rtb",
    ]
    raw_values = [raw_set.get(k) for k in keys]

    # Step 1 -- Normalise
    normalised = [normalise_reading(r) for r in raw_values]

    # Step 2 -- Detect prefix
    prefix = detect_common_prefix(normalised, min_prefix_len=expected_prefix_length)

    corrections: list[str] = []

    # Step 3 -- Anchor each reading
    if prefix:
        anchored: list[Optional[str]] = []
        for raw_norm, orig_key in zip(normalised, keys):
            fixed = anchor_reading(raw_norm, prefix)
            if fixed and fixed != raw_norm and fixed.startswith("*"):
                corrections.append(orig_key)
            anchored.append(fixed)
    else:
        anchored = list(normalised)

    # Step 4 -- Validate monotonic sequence
    validated = validate_sequence(anchored)

    flagged = [keys[i] for i, v in enumerate(validated) if v and v.startswith("!")]

    result = OdometerResult(
        dispatch    = validated[0],
        at_scene    = validated[1],
        departure   = validated[2],
        destination = validated[3],
        rtb         = validated[4],
        prefix_detected  = prefix,
        sequence_valid   = len(flagged) == 0,
        flagged_keys     = flagged,
        corrections_made = corrections,
    )

    # Sanity check: total trip distance
    try:
        d_digits = re.sub(r"[^\d]", "", validated[0] or "")
        e_digits = re.sub(r"[^\d]", "", validated[3] or "")
        if d_digits and e_digits:
            trip_km = int(e_digits) - int(d_digits)
            if trip_km > typical_trip_max_km:
                logger.warning(
                    "[Odometer] Trip distance %d km exceeds typical max %d km -- review needed.",
                    trip_km, typical_trip_max_km,
                )
    except (ValueError, TypeError):
        pass

    logger.info(
        "[Odometer] Processed. Prefix='%s', Corrections=%s, Flagged=%s",
        prefix, corrections, flagged,
    )
    return result
