from __future__ import annotations
import abc
import logging
from typing import Optional
from datetime import datetime, timezone
import httpx

from app.models.case import Case
from app.models.claim import Claim
from app.models.user import User
from app.config import SchemeCredentials

logger = logging.getLogger("ems.adapters.base")

class BaseSchemeAdapter(abc.ABC):
    """
    Abstract Base Class for integrating with different medical scheme B2B APIs.
    Accepts a `SchemeCredentials` (env-driven) rather than the old SchemeConfig ORM.
    """
    def __init__(self, config: SchemeCredentials):
        self.config = config
        self.base_url = config.base_url.rstrip("/")
        
    @abc.abstractmethod
    async def test_connection(self) -> dict:
        """
        Tests connectivity to the scheme's API using the provided credentials.
        Returns a dict: {"success": bool, "message": str}
        """
        pass
        
    @abc.abstractmethod
    async def request_authorization(
        self,
        case: Case,
        claim: Optional[Claim],
        claim_lines: list,
        provider: Optional[User],
        rules: Optional[dict] = None,   # retained for backwards compat; ignored
    ) -> dict:
        """
        Builds the payload and hits the authorization endpoint.
        Returns standard AuthRequest dictionary with 'status', 'reason', etc.

        The legacy `rules` parameter is ignored — the checks formerly driven by
        it (IHT referring doctor, dependant code requirement) are now driven by
        hardcoded constants in `app.rules.base`.
        """
        pass

    @abc.abstractmethod
    async def forward_payload(self, payload_data: dict, action: str) -> httpx.Response:
        """
        Directly forwards a pre-built payload to the external scheme API
        using the adapter's token/auth strategy.
        Returns the raw httpx.Response.
        """
        pass

    def _validate_prerequisites(self, case: Case, claim_lines: list, rules: Optional[dict] = None) -> list[str]:
        """Check pre-submission prerequisites before hitting the scheme API.

        The optional `rules` dict is retained for backward compatibility but
        ignored — the gates below are now driven by hardcoded constants in
        `app.rules.base`.
        """
        from app.rules.base import IHT_REQUIRES_REFERRING_DR

        errors = []
        if not case.scheme_member_number:
            errors.append("Scheme member number is required")

        has_icd10 = any(line.icd10_primary for line in claim_lines)
        if not has_icd10:
            errors.append("At least one ICD-10 code is required")

        if IHT_REQUIRES_REFERRING_DR:
            dispatch = (case.dispatch_type or "").upper()
            if dispatch in ("IHT", "IFT") and not case.referring_doctor_pr:
                errors.append("IFT/IHT dispatch requires a referring doctor PR number")

        return errors
    
    def _build_auth_payload(self, case: Case, claim_lines: list, provider: Optional[User]) -> dict:
        """Construct the structured JSON payload expected by most schemes (FHIR-ish format)."""
        primary_icd10 = None
        tariff_code = None
        for line in claim_lines:
            if line.icd10_primary:
                primary_icd10 = line.icd10_primary
            if line.cpt_code:
                tariff_code = line.cpt_code

        return {
            "provider": {
                "practice_number": self.config.provider_practice_number or (provider.bhf_practice_number if provider else "N/A"),
                "treating_provider_name": provider.full_name if provider else "N/A",
            },
            "beneficiary": {
                "medical_aid_number": case.scheme_member_number or "",
                "dependant_code": case.dependant_code or "00",
                "id_number": case.patient_id_number or "",
            },
            "clinical_details": {
                "request_type": case.dispatch_type or "Primary",
                "primary_icd10": primary_icd10 or "",
                "requested_level_of_care": tariff_code or "",
                "referring_doctor_pr_number": case.referring_doctor_pr or "N/A",
                "incident_date_time": (
                    case.incident_date.isoformat() if case.incident_date
                    else datetime.now(timezone.utc).isoformat()
                ),
            },
        }

    def _handle_response(self, response: httpx.Response, request_payload: dict) -> dict:
        """Parse the generic scheme API response format into status."""
        try:
            response_data = response.json()
        except Exception:
            response_data = {"raw": response.text[:500]}

        if response.status_code in [200, 201]:
            return {
                "status": "APPROVED",
                "auth_number": response_data.get("authorization_number"),
                "approved_amount": response_data.get("financial_limit"),
                "reason": None,
                "request_payload": request_payload,
                "response_payload": response_data,
            }
        elif response.status_code == 422:
            return {
                "status": "DECLINED",
                "auth_number": None,
                "approved_amount": None,
                "reason": response_data.get("decline_reason", "Clinical criteria not met."),
                "request_payload": request_payload,
                "response_payload": response_data,
            }
        else:
            return {
                "status": "ERROR",
                "auth_number": None,
                "approved_amount": None,
                "reason": f"API Error: HTTP {response.status_code} — {response_data}",
                "request_payload": request_payload,
                "response_payload": response_data,
            }
