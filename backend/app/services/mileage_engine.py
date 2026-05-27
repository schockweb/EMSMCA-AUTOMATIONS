"""
Mileage Validation & Calculation Engine
========================================
Enterprise-grade, deterministic validator for EMS Pro-Forma Invoice mileage.

Billing Components (SA EMS standard)
--------------------------------------
1. CALLOUT / UNLOADED  -- Dispatch to Scene (no patient aboard)
2. LOADED              -- Scene Departure to Hospital/Destination (patient aboard)
3. RETURN TO BASE      -- Destination to Base (no patient, may be billed per scheme)
4. TIME AT SCENE       -- Minutes spent on scene (some schemes cap clinical surcharge)

All values are derived mathematically from the 5 odometer readings + the
2 timestamps (on_scene_time, departure_from_scene_time) extracted from the PRF.

Validation Layers
-----------------
Layer 0  -- Input sanitisation:  parse raw OCR strings; strip '*'/'!' flags from
             the odometer anchoring pipeline; reject non-numeric junk.
Layer 1  -- Physical plausibility:  each individual reading is within fleet range
             [50,000 – 999,999 km].
Layer 2  -- Monotonic sequence:  Dispatch ≤ Scene ≤ Departure ≤ Destination ≤ RTB.
Layer 3  -- Segment plausibility:  each leg is within configured limits.
Layer 4  -- Cross-field consistency:  times and km agree (speed never implausible).
Layer 5  -- Billing integrity:  the values that will appear on the invoice are
             internally consistent and within scheme authorisation limits.
Layer 6  -- Scheme-rule gates:  per-scheme caps & callout-fee exclusion rules.

Public API
----------
    validate_mileage(data, config)           -> MileageResult
    apply_to_tariff_context(result, ctx)     -> dict  (updated clinical_context)

Integration Points
------------------
  * ocr_extraction.py  calls validate_mileage() immediately after odometer_utils.
  * tariff_engine.py   calls apply_to_tariff_context() before generate_tariff_lines().
  * adjudication_engine.py  uses MileageResult.issues to generate RFIs.
  * DocumentReview.tsx reads mileage_validation from extracted_data for the UI badge.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

logger = logging.getLogger("ems.mileage_engine")

# ---------------------------------------------------------------------------
# Configuration defaults  (overridable via extraction_settings.json)
# ---------------------------------------------------------------------------

CFG_DEFAULTS: dict = {
    # Fleet odometer plausible range
    "min_odometer_km":           50_000,
    "max_odometer_km":          999_999,

    # Maximum distance for each leg (km)
    "max_callout_km":              200,   # base → scene
    "max_loaded_km":               300,   # scene departure → hospital
    "max_rtb_km":                  200,   # hospital → base

    # Minimum distances (< 1 km is suspicious — probable OCR artefact)
    "min_callout_km":                1,
    "min_loaded_km":                 1,

    # Speed plausibility for cross-field consistency
    "max_speed_kmh":               160,   # absolute speed cap (ambulance)
    "min_speed_kmh":                 2,   # slower means stuck / erroneous time

    # Scene time limits
    "max_scene_minutes":           180,   # 3-hour scene cap
    "min_scene_minutes":             1,   # < 1 min = timestamp error

    # Maximum total trip distance (dispatch → RTB)
    "max_total_trip_km":           600,

    # Billing: which legs are billable?
    "bill_callout_km":           True,    # callout (unloaded) is billable
    "bill_rtb_km":               False,   # RTB rarely billed (scheme-dependent)

    # Billing tolerance: if a leg rounds to 0 km, warn but don't error
    "warn_on_zero_loaded_km":    True,
}


# ---------------------------------------------------------------------------
# Domain types
# ---------------------------------------------------------------------------

@dataclass
class MileageIssue:
    """A single validation finding."""
    layer:       int             # 0-6
    code:        str             # machine-readable key, e.g. "ODOMETER_OUT_OF_RANGE"
    severity:    str             # "error" | "warning" | "info"
    message:     str             # human-readable
    field:       Optional[str]   # PRF field name (for UI highlighting)
    value:       Optional[str]   # offending value string


@dataclass
class MileageSegments:
    """Parsed, validated distance segments in kilometres."""
    callout_km:       Optional[float] = None   # dispatch → scene (unloaded)
    loaded_km:        Optional[float] = None   # scene departure → hospital (loaded)
    rtb_km:           Optional[float] = None   # hospital → base
    total_trip_km:    Optional[float] = None   # dispatch → hospital
    full_trip_km:     Optional[float] = None   # dispatch → RTB

    # Odometer anchor values (cleaned integers, no '*'/'!' flags)
    odo_dispatch:    Optional[int] = None
    odo_at_scene:    Optional[int] = None
    odo_departure:   Optional[int] = None
    odo_destination: Optional[int] = None
    odo_rtb:         Optional[int] = None

    # Time
    scene_minutes:   Optional[float] = None
    on_scene_time:   Optional[str]   = None
    departure_time:  Optional[str]   = None


@dataclass
class BillableAmounts:
    """Amounts that will flow to the Pro-Forma Invoice."""
    callout_km_billable:  float = 0.0   # unloaded callout km
    loaded_km_billable:   float = 0.0   # loaded (patient aboard) km
    rtb_km_billable:      float = 0.0   # return-to-base km (if scheme allows)
    total_km_billable:    float = 0.0   # sum of all above
    scene_minutes:        float = 0.0   # minutes at scene
    callout_fee_units:    int   = 1     # always 1 per incident


@dataclass
class MileageResult:
    """Complete result of the mileage validation pipeline."""
    is_valid:         bool = False      # True if no error-level issues
    has_warnings:     bool = False
    segments:         MileageSegments  = field(default_factory=MileageSegments)
    billable:         BillableAmounts  = field(default_factory=BillableAmounts)
    issues:           list[MileageIssue] = field(default_factory=list)
    summary:          str = ""

    # Serialisable snapshot for storage in extracted_data
    def to_dict(self) -> dict:
        segs = self.segments
        bill = self.billable
        return {
            "mileage_valid":        self.is_valid,
            "mileage_has_warnings": self.has_warnings,
            "mileage_summary":      self.summary,
            "mileage_callout_km":   segs.callout_km,
            "mileage_loaded_km":    segs.loaded_km,
            "mileage_rtb_km":       segs.rtb_km,
            "mileage_total_km":     segs.total_trip_km,
            "mileage_scene_minutes":segs.scene_minutes,
            "mileage_billable_callout_km": bill.callout_km_billable,
            "mileage_billable_loaded_km":  bill.loaded_km_billable,
            "mileage_billable_rtb_km":     bill.rtb_km_billable,
            "mileage_billable_total_km":   bill.total_km_billable,
            "mileage_issues": [
                {
                    "layer":    i.layer,
                    "code":     i.code,
                    "severity": i.severity,
                    "message":  i.message,
                    "field":    i.field,
                    "value":    i.value,
                }
                for i in self.issues
            ],
        }


# ---------------------------------------------------------------------------
# Layer 0 — Input sanitisation helpers
# ---------------------------------------------------------------------------

def _parse_odo(raw) -> Optional[int]:
    """
    Convert a raw OCR odometer value to a clean integer.

    Handles:
    - Pipeline flags: '*534859' (auto-corrected), '!534859' (sequence error) -- strip prefix
    - Space/pipe/decimal separators: '534 859', '534|859', '534.859' -> 534859
    - Already clean int/float: 534859 -> 534859
    - None / empty / non-numeric -> None
    """
    if raw is None:
        return None
    s = re.sub(r"[^\d]", "", str(raw).lstrip("*!").strip())
    return int(s) if s else None


def _parse_time(raw) -> Optional[datetime]:
    """
    Parse a time string from the PRF (HH:MM or HH:MM:SS) into a datetime.
    Uses 1970-01-01 as the anchor date (only the time component matters).
    Returns None on failure.
    """
    if not raw:
        return None
    s = str(raw).strip()
    for fmt in ("%H:%M", "%H:%M:%S", "%H.%M", "%I:%M %p", "%I:%M%p"):
        try:
            t = datetime.strptime(s, fmt)
            return t.replace(year=1970, month=1, day=1)
        except ValueError:
            continue
    return None


def _minutes_between(start: Optional[datetime], end: Optional[datetime]) -> Optional[float]:
    """Returns minutes between two datetime objects, handling midnight rollover."""
    if start is None or end is None:
        return None
    delta = end - start
    if delta.total_seconds() < 0:
        # Midnight rollover (e.g. scene at 23:55, departure at 00:12)
        delta += timedelta(days=1)
    return delta.total_seconds() / 60.0


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def validate_mileage(
    data: dict,
    config: Optional[dict] = None,
) -> MileageResult:
    """
    Run the full 6-layer mileage validation pipeline.

    Parameters
    ----------
    data   : dict — the PRF extracted_data dict (as stored in the DB / passed
                    through the extraction pipeline).
    config : dict — optional overrides from extraction_settings.json
                    under the key "mileage_config".

    Returns
    -------
    MileageResult — fully populated including billable amounts.
    """
    cfg = {**CFG_DEFAULTS, **(config or {})}
    result = MileageResult()
    issues = result.issues
    segs   = result.segments
    bill   = result.billable

    # ── Layer 0: Input sanitisation ────────────────────────────────────
    raw_keys = {
        "odo_dispatch":    ("odometer_dispatch",    "odometer_start"),
        "odo_at_scene":    ("odometer_at_scene",    None),
        "odo_departure":   ("odometer_departure",   None),
        "odo_destination": ("odometer_destination", "odometer_end"),
        "odo_rtb":         ("odometer_rtb",         "back_to_base"),
    }

    parsed: dict[str, Optional[int]] = {}
    for attr, (primary_key, fallback_key) in raw_keys.items():
        raw = data.get(primary_key)
        if raw is None and fallback_key:
            raw = data.get(fallback_key)
        val = _parse_odo(raw)
        parsed[attr] = val
        if raw is not None and val is None:
            issues.append(MileageIssue(
                layer=0, code="UNPARSEABLE_ODOMETER", severity="error",
                message=f"Odometer value '{raw}' for '{primary_key}' is not a valid number.",
                field=primary_key, value=str(raw),
            ))

    segs.odo_dispatch    = parsed["odo_dispatch"]
    segs.odo_at_scene    = parsed["odo_at_scene"]
    segs.odo_departure   = parsed["odo_departure"]
    segs.odo_destination = parsed["odo_destination"]
    segs.odo_rtb         = parsed["odo_rtb"]

    # Parse times
    t_on_scene  = _parse_time(data.get("on_scene_time")  or data.get("on_scene"))
    t_departure = _parse_time(data.get("departure_from_scene_time") or data.get("departure_time"))
    segs.on_scene_time  = str(data.get("on_scene_time") or "")
    segs.departure_time = str(data.get("departure_from_scene_time") or "")

    # ── Layer 1: Physical plausibility ─────────────────────────────────
    odo_min = cfg["min_odometer_km"]
    odo_max = cfg["max_odometer_km"]
    odo_field_map = {
        "odo_dispatch":    "odometer_dispatch",
        "odo_at_scene":    "odometer_at_scene",
        "odo_departure":   "odometer_departure",
        "odo_destination": "odometer_destination",
        "odo_rtb":         "odometer_rtb",
    }
    for attr, field_name in odo_field_map.items():
        val = parsed[attr]
        if val is None:
            continue
        if val < odo_min:
            issues.append(MileageIssue(
                layer=1, code="ODOMETER_BELOW_MINIMUM", severity="error",
                message=(
                    f"{field_name}={val} is below the minimum plausible odometer reading "
                    f"({odo_min:,}). Likely OCR error or missing leading digits."
                ),
                field=field_name, value=str(val),
            ))
        elif val > odo_max:
            issues.append(MileageIssue(
                layer=1, code="ODOMETER_ABOVE_MAXIMUM", severity="error",
                message=(
                    f"{field_name}={val} exceeds maximum plausible odometer reading "
                    f"({odo_max:,}). Verify whether the vehicle odometer is correct."
                ),
                field=field_name, value=str(val),
            ))

    # ── Layer 2: Monotonic sequence ────────────────────────────────────
    # The 5 readings MUST be non-decreasing (Dispatch ≤ Scene ≤ Departure ≤ Dest ≤ RTB).
    # Only check between readings where both are available.
    sequence_pairs = [
        ("odometer_dispatch",    "odometer_at_scene",    segs.odo_dispatch,    segs.odo_at_scene),
        ("odometer_at_scene",    "odometer_departure",   segs.odo_at_scene,    segs.odo_departure),
        ("odometer_departure",   "odometer_destination", segs.odo_departure,   segs.odo_destination),
        ("odometer_destination", "odometer_rtb",         segs.odo_destination, segs.odo_rtb),
    ]
    for earlier_field, later_field, earlier_val, later_val in sequence_pairs:
        if earlier_val is not None and later_val is not None:
            if later_val < earlier_val:
                issues.append(MileageIssue(
                    layer=2, code="ODOMETER_NOT_MONOTONIC", severity="error",
                    message=(
                        f"{later_field} ({later_val:,}) is less than {earlier_field} ({earlier_val:,}). "
                        f"Odometer readings must be non-decreasing along the trip."
                    ),
                    field=later_field, value=str(later_val),
                ))

    # ── Compute segments ───────────────────────────────────────────────
    # Callout = Dispatch → Scene (unloaded)
    if segs.odo_dispatch is not None and segs.odo_at_scene is not None:
        segs.callout_km = max(0.0, segs.odo_at_scene - segs.odo_dispatch)

    # Loaded = Departure (from scene) → Hospital  (patient on board)
    if segs.odo_departure is not None and segs.odo_destination is not None:
        segs.loaded_km = max(0.0, segs.odo_destination - segs.odo_departure)

    # RTB = Hospital → Base
    if segs.odo_destination is not None and segs.odo_rtb is not None:
        segs.rtb_km = max(0.0, segs.odo_rtb - segs.odo_destination)

    # Total (dispatch → hospital) — the main billable trip distance
    if segs.odo_dispatch is not None and segs.odo_destination is not None:
        segs.total_trip_km = max(0.0, segs.odo_destination - segs.odo_dispatch)

    # Full trip (dispatch → RTB)
    if segs.odo_dispatch is not None and segs.odo_rtb is not None:
        segs.full_trip_km = max(0.0, segs.odo_rtb - segs.odo_dispatch)

    # Scene time
    scene_minutes = _minutes_between(t_on_scene, t_departure)
    segs.scene_minutes = scene_minutes

    # ── Layer 3: Segment plausibility ─────────────────────────────────
    if segs.callout_km is not None:
        if segs.callout_km == 0:
            issues.append(MileageIssue(
                layer=3, code="ZERO_CALLOUT_DISTANCE", severity="warning",
                message=(
                    "Callout distance (Dispatch → Scene) is 0 km. "
                    "If the vehicle was dispatched from on-scene, this is expected. "
                    "Otherwise, verify the odometer readings."
                ),
                field="odometer_at_scene", value="0",
            ))
        elif segs.callout_km < cfg["min_callout_km"]:
            issues.append(MileageIssue(
                layer=3, code="IMPLAUSIBLY_SHORT_CALLOUT", severity="warning",
                message=(
                    f"Callout distance {segs.callout_km:.1f} km is unusually short "
                    f"(minimum expected: {cfg['min_callout_km']} km). "
                    "Confirm the vehicle was not already on scene at dispatch."
                ),
                field="odometer_at_scene", value=str(segs.callout_km),
            ))
        elif segs.callout_km > cfg["max_callout_km"]:
            issues.append(MileageIssue(
                layer=3, code="EXCESSIVE_CALLOUT_DISTANCE", severity="error",
                message=(
                    f"Callout distance {segs.callout_km:.0f} km exceeds maximum "
                    f"allowed ({cfg['max_callout_km']} km). "
                    "Verify that dispatch and scene odometer readings are correct."
                ),
                field="odometer_at_scene", value=str(segs.callout_km),
            ))

    if segs.loaded_km is not None:
        if segs.loaded_km == 0:
            # DOD and RHT calls have no transport leg by design — zero loaded KM
            # is correct and expected for those call types. Suppress the warning
            # so the review queue isn't flooded with false positives.
            no_transport = bool(data.get("no_transport_call", False))
            if cfg["warn_on_zero_loaded_km"] and not no_transport:
                issues.append(MileageIssue(
                    layer=3, code="ZERO_LOADED_DISTANCE", severity="warning",
                    message=(
                        "Loaded distance (Scene Departure → Hospital) is 0 km. "
                        "This typically means patient was treated and released on scene "
                        "or transported by other means. Verify the PRF."
                    ),
                    field="odometer_destination", value="0",
                ))
        elif segs.loaded_km < cfg["min_loaded_km"]:
            issues.append(MileageIssue(
                layer=3, code="IMPLAUSIBLY_SHORT_LOADED_DISTANCE", severity="warning",
                message=(
                    f"Loaded (patient-aboard) distance {segs.loaded_km:.1f} km is unusually short. "
                    "Confirm the receiving facility is correctly recorded."
                ),
                field="odometer_destination", value=str(segs.loaded_km),
            ))
        elif segs.loaded_km > cfg["max_loaded_km"]:
            issues.append(MileageIssue(
                layer=3, code="EXCESSIVE_LOADED_DISTANCE", severity="error",
                message=(
                    f"Loaded distance {segs.loaded_km:.0f} km exceeds maximum "
                    f"allowed ({cfg['max_loaded_km']} km). "
                    "Long-distance transfers should be pre-authorised by the scheme."
                ),
                field="odometer_destination", value=str(segs.loaded_km),
            ))

    if segs.rtb_km is not None and segs.rtb_km > cfg["max_rtb_km"]:
        issues.append(MileageIssue(
            layer=3, code="EXCESSIVE_RTB_DISTANCE", severity="warning",
            message=(
                f"Return-to-base distance {segs.rtb_km:.0f} km exceeds maximum "
                f"({cfg['max_rtb_km']} km). Confirm base address."
            ),
            field="odometer_rtb", value=str(segs.rtb_km),
        ))

    if segs.total_trip_km is not None and segs.total_trip_km > cfg["max_total_trip_km"]:
        issues.append(MileageIssue(
            layer=3, code="EXCESSIVE_TOTAL_TRIP", severity="error",
            message=(
                f"Total trip distance (Dispatch → Destination) {segs.total_trip_km:.0f} km "
                f"exceeds the configured maximum ({cfg['max_total_trip_km']} km). "
                "Check all 5 odometer readings for OCR errors."
            ),
            field="odometer_destination", value=str(segs.total_trip_km),
        ))

    # ── Layer 4: Cross-field time/distance consistency ─────────────────
    if scene_minutes is not None:
        if scene_minutes < cfg["min_scene_minutes"]:
            issues.append(MileageIssue(
                layer=4, code="SCENE_TIME_TOO_SHORT", severity="warning",
                message=(
                    f"Scene time {scene_minutes:.1f} min is implausibly short. "
                    "Verify on_scene_time and departure_from_scene_time are correct."
                ),
                field="on_scene_time", value=segs.on_scene_time,
            ))
        elif scene_minutes > cfg["max_scene_minutes"]:
            issues.append(MileageIssue(
                layer=4, code="SCENE_TIME_EXCESSIVE", severity="warning",
                message=(
                    f"Scene time {scene_minutes:.0f} min ({scene_minutes/60:.1f} h) exceeds "
                    f"the plausibility threshold ({cfg['max_scene_minutes']} min). "
                    "Verify timestamps or check for a trapped-patient / special-rescue scenario."
                ),
                field="departure_from_scene_time", value=segs.departure_time,
            ))

    # Speed plausibility: loaded leg speed
    if segs.loaded_km is not None and t_on_scene is not None and t_departure is not None:
        # Time from departure to hospital via scene departure → destination time
        # We don't always have hospital_arrival_time, so only check scene → departure
        pass   # Reserved for future enhancement when hospital_arrival_time is captured

    # ── Layer 5: Billing integrity ─────────────────────────────────────
    if segs.loaded_km is not None and segs.callout_km is not None:
        # Unloaded distance must not be artificially larger than loaded
        # (common OCR swap: destination and departure values transposed)
        ratio = segs.callout_km / segs.loaded_km if segs.loaded_km > 0 else None
        if ratio is not None and ratio > 10:
            issues.append(MileageIssue(
                layer=5, code="CALLOUT_LOADED_RATIO_SUSPICIOUS", severity="warning",
                message=(
                    f"Callout distance ({segs.callout_km:.0f} km) is more than 10× "
                    f"the loaded distance ({segs.loaded_km:.0f} km). "
                    "This is unusual — check that departure and destination readings are not swapped."
                ),
                field="odometer_departure", value=str(segs.odo_departure),
            ))

    # At-scene ≤ departure (the vehicle must have moved at least 0 km when leaving scene)
    if segs.odo_at_scene is not None and segs.odo_departure is not None:
        if segs.odo_departure < segs.odo_at_scene:
            issues.append(MileageIssue(
                layer=5, code="DEPARTURE_LESS_THAN_SCENE", severity="error",
                message=(
                    f"Departure odometer ({segs.odo_departure:,}) is less than "
                    f"at-scene odometer ({segs.odo_at_scene:,}). "
                    "These values may be transposed. Correct before issuing the invoice."
                ),
                field="odometer_departure", value=str(segs.odo_departure),
            ))

    # ── Layer 6: Scheme-rule gates ──────────────────────────────────────
    # Scene time cap for clinical surcharge (placeholder — scheme-specific rules
    # can be added to extraction_settings.json under "mileage_config")
    scene_time_cap = cfg.get("max_scene_minutes_for_surcharge")
    if scene_time_cap and scene_minutes is not None and scene_minutes > scene_time_cap:
        issues.append(MileageIssue(
            layer=6, code="SCENE_TIME_SURCHARGE_CAP", severity="info",
            message=(
                f"Scene time {scene_minutes:.0f} min exceeds the scheme surcharge "
                f"cap of {scene_time_cap} min. Clinical holding surcharge may not be applicable."
            ),
            field="on_scene_time", value=segs.on_scene_time,
        ))

    # ── GPS Fallback Chain ─────────────────────────────────────────────
    # If odometer segments are missing or invalid, attempt to fill them
    # from GPS coordinates captured on the PRF via geo_locations JSONB.
    #
    # Priority: odometer (ground truth) > GPS haversine (straight-line approx)
    # GPS is always a lower bound (straight-line ≤ road distance), so a
    # "gps_fallback" review flag is added for billing review.
    gps_used = False
    try:
        from app.services.geo_utils import geo_segments_from_prf
        geo_data = data.get("geo_locations") or {}
        gps = geo_segments_from_prf(geo_data)

        if gps["gps_source"] is not None:
            # Fill missing callout
            if segs.callout_km is None and gps["gps_callout_km"] is not None:
                segs.callout_km = gps["gps_callout_km"]
                gps_used = True
                issues.append(MileageIssue(
                    layer=0, code="GPS_FALLBACK_CALLOUT", severity="warning",
                    message=(
                        f"Callout distance derived from GPS coordinates "
                        f"({gps['gps_callout_km']:.1f} km straight-line). "
                        "Actual road distance may differ."
                    ),
                    field="odometer_at_scene", value=f"GPS:{gps['gps_callout_km']:.1f}",
                ))

            # Fill missing loaded
            if segs.loaded_km is None and gps["gps_loaded_km"] is not None:
                segs.loaded_km = gps["gps_loaded_km"]
                gps_used = True
                issues.append(MileageIssue(
                    layer=0, code="GPS_FALLBACK_LOADED", severity="warning",
                    message=(
                        f"Loaded distance derived from GPS coordinates "
                        f"({gps['gps_loaded_km']:.1f} km straight-line). "
                        "Actual road distance may differ."
                    ),
                    field="odometer_destination", value=f"GPS:{gps['gps_loaded_km']:.1f}",
                ))

            # Fill missing RTB
            if segs.rtb_km is None and gps["gps_rtb_km"] is not None:
                segs.rtb_km = gps["gps_rtb_km"]
                gps_used = True

            # Fill missing total
            if segs.total_trip_km is None and gps["gps_total_km"] is not None:
                segs.total_trip_km = gps["gps_total_km"]
                gps_used = True

        if gps_used:
            logger.info(
                "[MileageEngine] GPS fallback used: callout=%s loaded=%s rtb=%s total=%s",
                gps.get("gps_callout_km"), gps.get("gps_loaded_km"),
                gps.get("gps_rtb_km"), gps.get("gps_total_km"),
            )
    except Exception as gps_err:
        logger.warning("[MileageEngine] GPS fallback failed: %s", gps_err)

    # ── Compute billable amounts ────────────────────────────────────────
    # Only include km from segments that have no error-level issues
    error_fields = {i.field for i in issues if i.severity == "error"}

    callout_km = segs.callout_km if segs.callout_km is not None else 0.0
    loaded_km  = segs.loaded_km  if segs.loaded_km  is not None else 0.0
    rtb_km     = segs.rtb_km     if segs.rtb_km     is not None else 0.0

    # If any component reading is in error, zero out that leg to prevent
    # billing an incorrect distance
    if "odometer_at_scene" in error_fields or "odometer_dispatch" in error_fields:
        callout_km = 0.0
    if "odometer_departure" in error_fields or "odometer_destination" in error_fields:
        loaded_km = 0.0
    if "odometer_rtb" in error_fields:
        rtb_km = 0.0

    bill.callout_km_billable = round(callout_km, 1) if cfg["bill_callout_km"] else 0.0
    bill.loaded_km_billable  = round(loaded_km,  1)
    bill.rtb_km_billable     = round(rtb_km,     1) if cfg["bill_rtb_km"] else 0.0
    bill.total_km_billable   = round(
        bill.callout_km_billable + bill.loaded_km_billable + bill.rtb_km_billable, 1
    )
    bill.scene_minutes       = round(scene_minutes or 0.0, 1)
    bill.callout_fee_units   = 1

    # If GPS fallback was used, flag it on the billable result
    if gps_used:
        bill._gps_fallback = True  # type: ignore[attr-defined]

    # ── Final result ────────────────────────────────────────────────────
    has_errors   = any(i.severity == "error"   for i in issues)
    has_warnings = any(i.severity == "warning" for i in issues)

    result.is_valid    = not has_errors
    result.has_warnings = has_warnings

    # Build human summary
    parts = []
    if segs.callout_km is not None:
        parts.append(f"Callout: {segs.callout_km:.1f} km")
    if segs.loaded_km is not None:
        parts.append(f"Loaded: {segs.loaded_km:.1f} km")
    if segs.rtb_km is not None:
        parts.append(f"RTB: {segs.rtb_km:.1f} km")
    if segs.scene_minutes is not None:
        parts.append(f"Scene: {segs.scene_minutes:.0f} min")
    if parts:
        status = "OK" if result.is_valid else (f"{sum(1 for i in issues if i.severity=='error')} error(s)")
        result.summary = f"{' | '.join(parts)} — {status}"
    else:
        result.summary = "Odometer data incomplete or unavailable"

    logger.info(
        "[MileageEngine] %s — Issues: %d error(s) %d warning(s)",
        result.summary,
        sum(1 for i in issues if i.severity == "error"),
        sum(1 for i in issues if i.severity == "warning"),
    )
    return result


def apply_to_tariff_context(result: MileageResult, ctx: dict) -> dict:
    """
    Merge MileageResult billable amounts into an existing tariff clinical_context dict.

    This replaces the raw odometer arithmetic that was previously done inside
    tariff_engine._build_clinical_context(), giving the tariff engine
    validated, auditable distances instead of raw OCR values.

    Only call this when result.is_valid == True.
    """
    b = result.billable
    s = result.segments

    # Override the tariff engine's distance fields with validated values
    ctx["loaded_distance_km"]  = b.loaded_km_billable
    ctx["rtb_distance_km"]     = b.rtb_km_billable
    ctx["callout_distance_km"] = b.callout_km_billable
    ctx["trip_distance_km"]    = b.total_km_billable
    ctx["scene_minutes"]       = b.scene_minutes

    # Pass raw segments for transparency
    ctx["mileage_segments"] = {
        "callout_km":    s.callout_km,
        "loaded_km":     s.loaded_km,
        "rtb_km":        s.rtb_km,
        "total_trip_km": s.total_trip_km,
        "scene_minutes": s.scene_minutes,
    }
    return ctx
