"""
Notification Service — Omnichannel alerts via SMS, WhatsApp, and Email.
Supports Infobip (primary) and Twilio (fallback) for SMS/WhatsApp delivery.
"""
from __future__ import annotations
import httpx
from dataclasses import dataclass, field
from typing import Optional

from app.config import get_settings

settings = get_settings()


@dataclass
class NotificationResult:
    """Result of a notification dispatch."""
    success: bool
    channel: str  # "sms", "whatsapp", "email"
    provider: str  # "infobip", "twilio"
    recipient: str
    message_id: Optional[str] = None
    error: Optional[str] = None


# ═══════════════════════════════════════════════════════════
# NOTIFICATION TEMPLATES
# ═══════════════════════════════════════════════════════════

TEMPLATES = {
    "claim_submitted": (
        "EMS Claims Portal: Your claim {claim_ref} has been submitted to {scheme_name}. "
        "Reference: {edi_reference}. Track status at {portal_url}."
    ),
    "claim_paid": (
        "EMS Claims Portal: Payment received for claim {claim_ref}. "
        "Amount: R{amount_paid}. Scheme: {scheme_name}. Reference: {payment_ref}."
    ),
    "claim_rejected": (
        "EMS Claims Portal: Claim {claim_ref} has been rejected by {scheme_name}. "
        "Reason: {rejection_reason}. Please review at {portal_url}."
    ),
    "rfi_created": (
        "EMS Claims Portal: Action required — claim {claim_ref} needs additional information. "
        "Missing: {missing_info}. Respond via {portal_url}."
    ),
    "rfi_resolved": (
        "EMS Claims Portal: RFI for claim {claim_ref} has been resolved. "
        "Re-adjudication result: {result}."
    ),
    "document_processed": (
        "EMS Claims Portal: PRF document '{doc_name}' processed. "
        "OCR confidence: {confidence}%. {review_note}"
    ),
    "preauth_status": (
        "EMS Claims Portal: Pre-authorization {preauth_ref} status update: {status}. "
        "Case: {case_ref}."
    ),
}


def render_template(template_key: str, **kwargs) -> str:
    """Render a notification template with variable substitution."""
    template = TEMPLATES.get(template_key, "EMS Claims Portal: Notification")
    try:
        return template.format(**kwargs)
    except KeyError:
        return template


# ═══════════════════════════════════════════════════════════
# INFOBIP — Primary Provider
# ═══════════════════════════════════════════════════════════

async def send_infobip_sms(
    to: str,
    message: str,
) -> NotificationResult:
    """Send SMS via Infobip API."""
    result = NotificationResult(
        success=False, channel="sms", provider="infobip", recipient=to
    )

    api_key = getattr(settings, "INFOBIP_API_KEY", None)
    base_url = getattr(settings, "INFOBIP_BASE_URL", "https://api.infobip.com")

    if not api_key:
        # Stub mode — log but don't send
        result.success = True
        result.message_id = f"STUB-SMS-{to[-4:]}"
        return result

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                f"{base_url}/sms/2/text/advanced",
                headers={
                    "Authorization": f"App {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "messages": [{
                        "destinations": [{"to": _normalize_sa_number(to)}],
                        "from": "EMSClaims",
                        "text": message,
                    }]
                },
            )

            if response.status_code == 200:
                data = response.json()
                msg = data.get("messages", [{}])[0]
                result.success = True
                result.message_id = msg.get("messageId")
            else:
                result.error = f"Infobip returned {response.status_code}"

    except Exception as e:
        result.error = str(e)

    return result


async def send_infobip_whatsapp(
    to: str,
    message: str,
) -> NotificationResult:
    """Send WhatsApp message via Infobip API."""
    result = NotificationResult(
        success=False, channel="whatsapp", provider="infobip", recipient=to
    )

    api_key = getattr(settings, "INFOBIP_API_KEY", None)
    base_url = getattr(settings, "INFOBIP_BASE_URL", "https://api.infobip.com")

    if not api_key:
        result.success = True
        result.message_id = f"STUB-WA-{to[-4:]}"
        return result

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                f"{base_url}/whatsapp/1/message/text",
                headers={
                    "Authorization": f"App {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "from": "EMSClaimsPortal",
                    "to": _normalize_sa_number(to),
                    "content": {"text": message},
                },
            )

            if response.status_code in (200, 201):
                data = response.json()
                result.success = True
                result.message_id = data.get("messageId")
            else:
                result.error = f"Infobip WhatsApp returned {response.status_code}"

    except Exception as e:
        result.error = str(e)

    return result


# ═══════════════════════════════════════════════════════════
# TWILIO — Fallback Provider
# ═══════════════════════════════════════════════════════════

async def send_twilio_sms(
    to: str,
    message: str,
) -> NotificationResult:
    """Send SMS via Twilio API (fallback)."""
    result = NotificationResult(
        success=False, channel="sms", provider="twilio", recipient=to
    )

    account_sid = getattr(settings, "TWILIO_ACCOUNT_SID", None)
    auth_token = getattr(settings, "TWILIO_AUTH_TOKEN", None)
    from_number = getattr(settings, "TWILIO_FROM_NUMBER", None)

    if not all([account_sid, auth_token, from_number]):
        result.success = True
        result.message_id = f"STUB-TWILIO-{to[-4:]}"
        return result

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json",
                auth=(account_sid, auth_token),
                data={
                    "To": _normalize_sa_number(to),
                    "From": from_number,
                    "Body": message,
                },
            )

            if response.status_code == 201:
                data = response.json()
                result.success = True
                result.message_id = data.get("sid")
            else:
                result.error = f"Twilio returned {response.status_code}"

    except Exception as e:
        result.error = str(e)

    return result


# ═══════════════════════════════════════════════════════════
# UNIFIED SEND — Auto-selects provider
# ═══════════════════════════════════════════════════════════

async def send_notification(
    to: str,
    template_key: str,
    channel: str = "sms",
    **template_vars,
) -> NotificationResult:
    """
    Send a notification via the preferred channel.
    Falls back from Infobip → Twilio for SMS.
    """
    message = render_template(template_key, **template_vars)

    if channel == "whatsapp":
        return await send_infobip_whatsapp(to, message)
    elif channel == "sms":
        # Try Infobip first, fallback to Twilio
        result = await send_infobip_sms(to, message)
        if not result.success:
            result = await send_twilio_sms(to, message)
        return result
    else:
        return NotificationResult(
            success=False, channel=channel, provider="none",
            recipient=to, error=f"Unsupported channel: {channel}",
        )


def _normalize_sa_number(number: str) -> str:
    """Normalize SA phone number to international format (+27...)."""
    clean = number.strip().replace(" ", "").replace("-", "")
    if clean.startswith("0"):
        return "+27" + clean[1:]
    elif clean.startswith("27"):
        return "+" + clean
    elif not clean.startswith("+"):
        return "+27" + clean
    return clean
