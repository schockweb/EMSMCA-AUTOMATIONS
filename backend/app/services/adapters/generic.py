import httpx
import logging
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Optional

from app.models.case import Case
from app.models.claim import Claim
from app.models.user import User
from app.services.adapters.base import BaseSchemeAdapter

logger = logging.getLogger("ems.adapters.generic")

class OAuth2SchemeAdapter(BaseSchemeAdapter):
    """
    Adapter for schemes using standard OAuth2 Client Credentials.
    Works for Discovery Health and Generic Mock Schemes.
    """
    def __init__(self, config):
        super().__init__(config)
        self._token: Optional[str] = None
        self._token_expires: Optional[datetime] = None
        
    async def test_connection(self) -> dict:
        """Ping the token endpoint."""
        token_url = f"{self.base_url}/oauth/token"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    token_url,
                    data={"grant_type": "client_credentials"},
                    auth=(self.config.client_id or "", self.config.client_secret or ""),
                )
            if response.status_code == 200:
                return {"success": True, "message": f"Connected to {self.config.scheme_id}. OAuth2 Token received."}
            return {"success": False, "message": f"Auth failed: HTTP {response.status_code} — {response.text[:200]}"}
        except Exception as e:
            return {"success": False, "message": f"Error: {str(e)}"}
            
    async def _get_access_token(self) -> str:
        """Obtain OAuth2 bearer token via client_credentials grant."""
        if self._token and self._token_expires and datetime.now(timezone.utc) < self._token_expires:
            return self._token

        auth_url = f"{self.base_url}/oauth/token"
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                auth_url,
                data={"grant_type": "client_credentials"},
                auth=(self.config.client_id or "", self.config.client_secret or ""),
            )

        if response.status_code == 200:
            data = response.json()
            self._token = data.get("access_token")
            expires_in = data.get("expires_in", 3600)
            self._token_expires = datetime.now(timezone.utc) + timedelta(seconds=max(expires_in - 60, 60))
            return self._token
            
        logger.error("API auth failed for %s: %s %s", self.config.scheme_id, response.status_code, response.text[:200])
        raise Exception(f"Failed to authenticate with {self.config.scheme_id} (HTTP {response.status_code})")

    async def request_authorization(
        self,
        case: Case,
        claim: Optional[Claim],
        claim_lines: list,
        provider: Optional[User],
        rules: dict,
    ) -> dict:
        """Full auth request flow for OAuth2 schemes."""
        errors = self._validate_prerequisites(case, claim_lines, rules)
        if errors:
            return {
                "status": "ERROR", "reason": "; ".join(errors),
                "auth_number": None, "approved_amount": None,
                "request_payload": None, "response_payload": None,
            }

        payload = self._build_auth_payload(case, claim_lines, provider)
        try:
            token = await self._get_access_token()
        except Exception as e:
            return {
                "status": "ERROR", "reason": str(e),
                "auth_number": None, "approved_amount": None,
                "request_payload": payload, "response_payload": None,
            }

        endpoint = f"{self.base_url}/authorizations/ems/request"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

        # Some generic schemes might still mandate extra headers
        if self.config.provider_practice_number:
            headers["X-Provider-Practice"] = self.config.provider_practice_number
        if self.config.extra_headers:
            headers.update(self.config.extra_headers)

        last_error = None
        for attempt in range(3):
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    response = await client.post(endpoint, headers=headers, json=payload)
                return self._handle_response(response, payload)
            except (httpx.TimeoutException, httpx.ConnectError) as e:
                last_error = e
                await asyncio.sleep(2 ** attempt)

        return {
            "status": "TIMEOUT", "reason": f"Scheme API unreachable: {last_error}",
            "auth_number": None, "approved_amount": None,
            "request_payload": payload, "response_payload": None,
        }

    async def forward_payload(self, payload_data: dict, action: str) -> httpx.Response:
        """Forward generic payload using OAuth2 token."""
        token = await self._get_access_token()
        
        # Determine endpoint based on action
        if action == "REQUEST_AUTH":
            endpoint = f"{self.base_url}/authorizations/ems/request"
        elif action == "SUBMIT_CLAIM":
            endpoint = f"{self.base_url}/b2b/claims"
        else:
            endpoint = f"{self.base_url}/gateway/{action.lower()}"

        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

        if self.config.provider_practice_number:
            headers["X-Provider-Practice"] = self.config.provider_practice_number
        if self.config.extra_headers:
            if "Ocp-Apim-Subscription-Key" in self.config.extra_headers:
                headers["Ocp-Apim-Subscription-Key"] = self.config.extra_headers["Ocp-Apim-Subscription-Key"]
            else:
                headers.update(self.config.extra_headers)

        async with httpx.AsyncClient(timeout=30.0) as client:
            return await client.post(endpoint, headers=headers, json=payload_data)
