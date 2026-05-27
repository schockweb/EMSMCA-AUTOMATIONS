"""
Geospatial Utilities — Haversine, Google Polyline decoding, distance calculation.

Used by:
  * mileage_engine.py  — GPS fallback when odometer readings are missing/invalid.
  * digital_prf.py     — GPS spoofing detection (replaces inline haversine).

All functions are pure — no I/O, no DB access, no side effects.
"""
from __future__ import annotations

import math
from typing import Optional

# WGS-84 mean Earth radius in kilometres
EARTH_RADIUS_KM = 6371.0


def haversine_km(
    lat1: float, lon1: float,
    lat2: float, lon2: float,
) -> float:
    """Great-circle distance between two (lat, lon) points in kilometres.

    Uses the Haversine formula. Accurate to ~0.3% for typical EMS distances
    (< 300 km), which is well within billing tolerance.

    >>> round(haversine_km(-26.2041, 28.0473, -33.9249, 18.4241), 1)
    1262.6
    """
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)

    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return EARTH_RADIUS_KM * c


def decode_polyline(encoded: str) -> list[tuple[float, float]]:
    """Decode a Google Encoded Polyline string into a list of (lat, lng) tuples.

    Implements the algorithm documented at:
    https://developers.google.com/maps/documentation/utilities/polylinealgorithm

    Returns:
        List of (latitude, longitude) tuples in decimal degrees.

    >>> decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
    [(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]
    """
    points: list[tuple[float, float]] = []
    index = 0
    lat = 0
    lng = 0
    length = len(encoded)

    while index < length:
        # Decode latitude
        shift = 0
        result = 0
        while True:
            b = ord(encoded[index]) - 63
            index += 1
            result |= (b & 0x1F) << shift
            shift += 5
            if b < 0x20:
                break
        lat += (~(result >> 1) if (result & 1) else (result >> 1))

        # Decode longitude
        shift = 0
        result = 0
        while True:
            b = ord(encoded[index]) - 63
            index += 1
            result |= (b & 0x1F) << shift
            shift += 5
            if b < 0x20:
                break
        lng += (~(result >> 1) if (result & 1) else (result >> 1))

        points.append((lat / 1e5, lng / 1e5))

    return points


def polyline_distance_km(encoded: str) -> float:
    """Decode a Google Encoded Polyline and return its total distance in km.

    Sums haversine distances between consecutive decoded points.

    Returns 0.0 if the polyline has fewer than 2 points.
    """
    points = decode_polyline(encoded)
    if len(points) < 2:
        return 0.0

    total = 0.0
    for i in range(1, len(points)):
        total += haversine_km(
            points[i - 1][0], points[i - 1][1],
            points[i][0], points[i][1],
        )
    return total


def gps_distance_from_coords(
    coords: list[dict],
    key_lat: str = "lat",
    key_lng: str = "lng",
) -> float:
    """Calculate total distance in km from a list of coordinate dicts.

    Each dict must have keys for latitude and longitude (default: "lat", "lng").
    Points with missing coordinates are skipped.

    Returns 0.0 if fewer than 2 valid points.
    """
    valid = [
        (c[key_lat], c[key_lng])
        for c in coords
        if c.get(key_lat) is not None and c.get(key_lng) is not None
    ]
    if len(valid) < 2:
        return 0.0

    total = 0.0
    for i in range(1, len(valid)):
        total += haversine_km(
            valid[i - 1][0], valid[i - 1][1],
            valid[i][0], valid[i][1],
        )
    return total


def geo_segments_from_prf(
    geo_locations: dict | None,
) -> dict[str, Optional[float]]:
    """Extract mileage segments from a PRF's geo_locations JSONB.

    The geo_locations dict is keyed by timestamp field name:
        {
          "time_dispatched":   {"lat": -26.1, "lng": 28.0, ...},
          "time_on_scene":     {"lat": -26.2, "lng": 28.1, ...},
          "time_depart_scene": {"lat": -26.2, "lng": 28.1, ...},
          "time_at_destination":{"lat": -26.3, "lng": 28.2, ...},
          "time_available":    {"lat": -26.3, "lng": 28.2, ...},
        }

    Returns:
        {
            "gps_callout_km":  float | None,  # dispatched → on_scene
            "gps_loaded_km":   float | None,  # depart_scene → at_destination
            "gps_rtb_km":      float | None,  # at_destination → available (approx)
            "gps_total_km":    float | None,  # dispatched → at_destination
            "gps_source":      "prf_geo_locations",
        }
    """
    if not geo_locations:
        return {
            "gps_callout_km": None,
            "gps_loaded_km": None,
            "gps_rtb_km": None,
            "gps_total_km": None,
            "gps_source": None,
        }

    def _get(key: str) -> Optional[tuple[float, float]]:
        entry = geo_locations.get(key)
        if entry and entry.get("lat") is not None and entry.get("lng") is not None:
            return (entry["lat"], entry["lng"])
        return None

    dispatch = _get("time_dispatched")
    scene = _get("time_on_scene")
    depart = _get("time_depart_scene")
    dest = _get("time_at_destination")
    available = _get("time_available")

    callout = None
    loaded = None
    rtb = None
    total = None

    if dispatch and scene:
        callout = round(haversine_km(*dispatch, *scene), 1)
    if depart and dest:
        loaded = round(haversine_km(*depart, *dest), 1)
    if dest and available:
        rtb = round(haversine_km(*dest, *available), 1)
    if dispatch and dest:
        total = round(haversine_km(*dispatch, *dest), 1)

    return {
        "gps_callout_km": callout,
        "gps_loaded_km": loaded,
        "gps_rtb_km": rtb,
        "gps_total_km": total,
        "gps_source": "prf_geo_locations",
    }
