"""
Scheme Member Lookup API
Provides a pluggable adapter framework for looking up patient/member details
from medical scheme APIs.

Currently supports:
- GEMS (Government Employees Medical Scheme) — STUB, ready for live credentials
- Generic fallback — returns "not available"

When GEMS provides API credentials, fill in GemsMemberAdapter.lookup() below.
"""
import logging
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.models.user import User
from app.utils.security import get_current_user
from app.config import get_settings

logger = logging.getLogger("ems.member_lookup")
settings = get_settings()

router = APIRouter(prefix="/api/member-lookup", tags=["Member Lookup"])


# ── Response Schema ────────────────────────────────────────────────────────────

class MemberLookupResult(BaseModel):
    found: bool
    scheme: str
    member_number: str
    dependent_code: str

    # Patient / Principal details returned by scheme
    patient_name: Optional[str] = None
    patient_id_number: Optional[str] = None
    patient_dob: Optional[str] = None
    patient_phone: Optional[str] = None         # may be the main member's if patient is a minor
    main_member_name: Optional[str] = None
    main_member_phone: Optional[str] = None
    scheme_option: Optional[str] = None

    source: str = "not_available"               # "scheme_api" | "cache" | "not_available"
    message: Optional[str] = None


# ── GEMS Adapter ──────────────────────────────────────────────────────────────

class GemsMemberAdapter:
    """
    GEMS B2B Member Lookup Adapter.
    Implements the Government Employees Medical Scheme member search endpoint.

    ─────────────────────────────────────────────────────────────────────────
    HOW TO ACTIVATE:
    1. Obtain API credentials from GEMS developer portal
    2. Add to .env:
           GEMS_API_BASE_URL=https://api.gems.gov.za
           GEMS_API_KEY=your_api_key_here
    3. Replace the stub body in lookup() with actual API call
    4. Remove the "not_implemented" return below
    ─────────────────────────────────────────────────────────────────────────
    """

    SCHEME_NAME = "GEMS"

    async def lookup(self, member_number: str, dependent_code: str) -> MemberLookupResult:
        base_url = getattr(settings, "GEMS_API_BASE_URL", None)
        api_key  = getattr(settings, "GEMS_API_KEY", None)

        if not base_url or not api_key:
            return MemberLookupResult(
                found=False,
                scheme=self.SCHEME_NAME,
                member_number=member_number,
                dependent_code=dependent_code,
                source="not_available",
                message=(
                    "GEMS API credentials are not yet configured. "
                    "When GEMS provides your API key, add GEMS_API_BASE_URL and GEMS_API_KEY to .env "
                    "and this button will auto-fill patient details."
                ),
            )

        # ── ACTIVATE THIS BLOCK WHEN CREDENTIALS ARE PROVIDED ──────────────
        # import httpx
        # try:
        #     async with httpx.AsyncClient(timeout=10) as client:
        #         r = await client.get(
        #             f"{base_url}/members/{member_number}/dependants/{dependent_code}",
        #             headers={"Authorization": f"Bearer {api_key}"},
        #         )
        #         r.raise_for_status()
        #         raw = r.json()
        #         return MemberLookupResult(
        #             found=True,
        #             scheme=self.SCHEME_NAME,
        #             member_number=member_number,
        #             dependent_code=dependent_code,
        #             patient_name=raw.get("dependantName"),
        #             patient_id_number=raw.get("dependantIdNo"),
        #             patient_phone=raw.get("contactNumber") or raw.get("mainMemberContactNumber"),
        #             main_member_name=raw.get("mainMemberName"),
        #             main_member_phone=raw.get("mainMemberContactNumber"),
        #             scheme_option=raw.get("plan"),
        #             source="scheme_api",
        #         )
        # except Exception as e:
        #     logger.warning("[GEMS Lookup] API call failed: %s", e)
        #     return MemberLookupResult(
        #         found=False, scheme=self.SCHEME_NAME,
        #         member_number=member_number, dependent_code=dependent_code,
        #         source="not_available", message=str(e),
        #     )
        # ── END ACTIVATE BLOCK ──────────────────────────────────────────────

        return MemberLookupResult(
            found=False,
            scheme=self.SCHEME_NAME,
            member_number=member_number,
            dependent_code=dependent_code,
            source="not_available",
            message="GEMS API stub — credentials found but live calls are not yet enabled.",
        )


# ── Adapter registry ──────────────────────────────────────────────────────────

_ADAPTERS = {
    "gems": GemsMemberAdapter(),
}


async def _lookup_member(scheme: str, member_number: str, dependent_code: str) -> MemberLookupResult:
    adapter = _ADAPTERS.get(scheme.strip().lower())
    if adapter:
        return await adapter.lookup(member_number, dependent_code)
    return MemberLookupResult(
        found=False,
        scheme=scheme,
        member_number=member_number,
        dependent_code=dependent_code,
        source="not_available",
        message=f"No lookup adapter configured for scheme '{scheme}'. Contact your system administrator.",
    )


# ── Endpoint ───────────────────────────────────────────────────────────────────

@router.get("/{scheme}/{member_number}")
async def lookup_member(
    scheme: str,
    member_number: str,
    dependent_code: str = "00",
    _: User = Depends(get_current_user),
):
    """
    Look up patient / member details from a medical scheme's API.

    - `scheme`         — scheme name, e.g. 'gems', 'discovery'
    - `member_number`  — the scheme membership number
    - `dependent_code` — dependant code (default '00' = main member)

    Returns patient contact details, name, ID number, and scheme option
    if the scheme API is configured and the member is found.
    """
    result = await _lookup_member(scheme, member_number, dependent_code)
    return result
