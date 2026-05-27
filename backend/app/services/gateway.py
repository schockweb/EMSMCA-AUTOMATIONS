import httpx
import logging
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from app.models.api_audit_log import APIAuditLog
from app.services.adapters import get_scheme_adapter
from app.services.scheme_auth import (
    resolve_scheme_credentials,
    get_adapter_for_scheme,
)

logger = logging.getLogger("ems.gateway")

def sanitize_payload(payload: dict) -> dict:
    """Recursively strip POPIA-sensitive fields from a generic JSON dictionary."""
    sensitive_keys = {"id_number", "medical_aid_number", "icd10", "primary_icd10"}
    
    def mask_recursive(data):
        if isinstance(data, dict):
            new_data = {}
            for k, v in data.items():
                if k.lower() in sensitive_keys:
                    new_data[k] = "[REDACTED]"
                else:
                    new_data[k] = mask_recursive(v)
            return new_data
        elif isinstance(data, list):
            return [mask_recursive(i) for i in data]
        else:
            return data
            
    if not payload:
        return payload
    return mask_recursive(payload)

async def forward_to_scheme(
    db: AsyncSession,
    internal_claim_id: str,
    scheme_destination_code: str,
    action: str,
    payload_data: dict
) -> tuple[int, dict]:
    """
    Looks up the DB scheme credentials and forwards the payload using the 
    corresponding integration adapter. Logs everything to `api_audit_logs`.
    Returns (status_code, response_json).
    """
    # 1. Resolve scheme credentials from env via the rules registry
    adapter = get_adapter_for_scheme(scheme_destination_code)
    if adapter is None:
        # No rule module and/or SCHEME_<ID>_* env vars — fail closed with a
        # clear audit log entry rather than forwarding to a mock.
        audit_log = APIAuditLog(
            internal_claim_id=internal_claim_id,
            scheme_destination_code=scheme_destination_code,
            action=action,
            request_payload=sanitize_payload(payload_data),
            status_code=503,
            error_message=(
                f"No scheme credentials configured for '{scheme_destination_code}'. "
                f"Set SCHEME_<ID>_* env vars and add a module under backend/app/rules/."
            ),
        )
        db.add(audit_log)
        await db.commit()
        return 503, {"error": audit_log.error_message}

    # 2. Setup audit log entry
    audit_log = APIAuditLog(
        internal_claim_id=internal_claim_id,
        scheme_destination_code=scheme_destination_code,
        action=action,
        request_payload=sanitize_payload(payload_data)
    )

    try:
        # 3. Forward the payload via adapter
        response = await adapter.forward_payload(payload_data, action)
        
        # 4. Success / Expected Scheme responses
        # Attempt to parse json
        try:
            resp_json = response.json()
        except Exception:
            resp_json = {"raw_text": response.text[:500]}

        audit_log.status_code = response.status_code
        audit_log.response_payload = sanitize_payload(resp_json)
        
        # Ensure we commit the audit log before returning
        db.add(audit_log)
        await db.commit()

        return response.status_code, resp_json

    except httpx.TimeoutException as e:
        logger.error(f"Gateway timeout forwarding to {scheme_destination_code}: {e}")
        audit_log.status_code = 504
        audit_log.error_message = f"Timeout: {str(e)}"
        db.add(audit_log)
        await db.commit()
        return 504, {"error": "Gateway Timeout from Medical Scheme"}
        
    except httpx.ConnectError as e:
        logger.error(f"Gateway connection error bridging to {scheme_destination_code}: {e}")
        audit_log.status_code = 502
        audit_log.error_message = f"Connection Error: {str(e)}"
        db.add(audit_log)
        await db.commit()
        return 502, {"error": "Bad Gateway: Cannot connect to Medical Scheme API"}
        
    except Exception as e:
        logger.exception(f"Unexpected Gateway error forwarding to {scheme_destination_code}")
        audit_log.status_code = 500
        audit_log.error_message = f"Unexpected Error: {str(e)}"
        db.add(audit_log)
        await db.commit()
        return 500, {"error": "Internal Server Error in API Gateway"}
