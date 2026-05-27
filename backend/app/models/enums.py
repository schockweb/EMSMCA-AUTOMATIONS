"""
Shared enumerations used across models, services, and schemas.

Import from here to guarantee a single source of truth for all call types
and other categorical values that appear in multiple layers of the stack.
"""
import enum


class CallType(str, enum.Enum):
    """
    SA EMS call classification used in both:
      - cases.dispatch_type  (DB column)
      - extracted_data["incident_type"]  (PRF JSON blob)

    Canonical values deliberately use the standard SA EMS terminology.
    Legacy variants ("IHT", "Inter-Facility Transfer", "Primary Response", etc.)
    are normalised to these values at ingestion time via normalise_call_type().
    """
    PRIMARY = "Primary"
    IFT = "IFT"   # Inter-Facility Transfer (previously also stored as "IHT")


def normalise_call_type(raw: str) -> str:
    """
    Normalise any known call-type string to the canonical CallType value.

    Handles:
      PRIMARY → "Primary"
        - "primary", "PRIMARY", "primary response", "emergency", "scene"
      IFT → "IFT"
        - "IFT", "IHT", "Inter-Facility Transfer", "inter-hospital transfer",
          "interfacility", "transfer"

    Returns the canonical string value (not the enum object) so it can be
    stored directly in the DB without requiring an enum column type change.
    Unrecognised values are left as-is (empty string → empty string).
    """
    if not raw:
        return ""

    normalised = raw.strip().lower()

    IFT_VARIANTS = {
        "ift", "iht",
        "inter-facility transfer", "inter-facility",
        "inter-hospital transfer", "inter-hospital",
        "interfacility", "interhospital",
        "transfer",
        "rht", "returned home transfer", "return home transfer",
        "courtesy", "courtesy transfer",
    }

    PRIMARY_VARIANTS = {
        "primary", "primary response",
        "emergency", "scene", "scene response",
    }

    if normalised in IFT_VARIANTS:
        return CallType.IFT.value

    if normalised in PRIMARY_VARIANTS:
        return CallType.PRIMARY.value

    # Partial-match fallback (catches "inter facility" with a space, etc.)
    if (
        "transfer" in normalised
        or "ift" in normalised
        or "iht" in normalised
        or "rht" in normalised
        or "courtesy" in normalised
    ):
        return CallType.IFT.value

    if "primary" in normalised:
        return CallType.PRIMARY.value

    return raw  # Unknown — return unchanged so nothing is silently dropped
