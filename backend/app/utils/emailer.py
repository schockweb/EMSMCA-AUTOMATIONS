"""
SMTP email sending — global-settings default plus per-provider credentials.

Two modes:
  • send_email(...)             — global SMTP_* settings (legacy wrapper path).
  • send_email_via(...)         — explicit host/port/credentials, used for the
                                  per-provider "PRF to receiving facility"
                                  flow where each ServiceProvider sends from
                                  its own Gmail / Outlook account.

Known services map to their SMTP endpoints so providers only configure an
email + app password (Gmail and Outlook both require an app password for
SMTP — normal account passwords are rejected by both since basic-auth was
retired).
"""
from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage

logger = logging.getLogger(__name__)

# Attachment shape: {filename: str, content: bytes, mime_type: str}
Attachment = dict

SMTP_SERVICES: dict[str, tuple[str, int]] = {
    "gmail": ("smtp.gmail.com", 587),
    "outlook": ("smtp.office365.com", 587),
}


def resolve_service(service: str | None) -> tuple[str, int] | None:
    return SMTP_SERVICES.get((service or "").strip().lower())


def test_smtp_login(service: str | None, email: str, password: str) -> tuple[bool, str | None]:
    """Attempt a real SMTP login (no send) to validate a newly-entered app
    password at save time. A typo'd credential otherwise fails silently on
    every later PRF send. Auth rejection is definitive → (False,
    'smtp_auth_failed'). Network trouble fails OPEN → (True, 'unverified'),
    so a transient outage never blocks saving unrelated settings."""
    endpoint = resolve_service(service)
    if not endpoint:
        return False, "unknown_service"
    host, port = endpoint
    try:
        with smtplib.SMTP(host, port, timeout=15) as s:
            s.starttls()
            s.login(email, password)
        return True, None
    except smtplib.SMTPAuthenticationError:
        return False, "smtp_auth_failed"
    except Exception as exc:
        logger.warning("SMTP login test inconclusive for %s@%s: %s", email, host, exc)
        return True, "unverified"


def send_email_via(
    *,
    host: str,
    port: int,
    username: str,
    password: str,
    from_email: str,
    from_name: str | None,
    to: str,
    subject: str,
    body: str,
    attachments: list[Attachment] | None = None,
    use_tls: bool = True,
) -> tuple[bool, str | None]:
    """Send a plain-text email with optional binary attachments through the
    given SMTP account. Returns (sent, reason_if_failed). Auth failures are
    reported distinctly so callers can tell 'wrong app password' apart from
    a transient network problem (only the latter is worth retrying)."""
    msg = EmailMessage()
    msg["From"] = f"{from_name} <{from_email}>" if from_name else from_email
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)

    for att in (attachments or []):
        filename = att.get("filename") or "attachment.bin"
        content = att.get("content") or b""
        mime = att.get("mime_type") or "application/octet-stream"
        maintype, _, subtype = mime.partition("/")
        if not subtype:
            maintype, subtype = "application", "octet-stream"
        msg.add_attachment(content, maintype=maintype, subtype=subtype, filename=filename)

    try:
        if use_tls:
            with smtplib.SMTP(host, port, timeout=30) as s:
                s.starttls()
                if username:
                    s.login(username, password)
                s.send_message(msg)
        else:
            with smtplib.SMTP_SSL(host, port, timeout=30) as s:
                if username:
                    s.login(username, password)
                s.send_message(msg)
        return True, None
    except smtplib.SMTPAuthenticationError as exc:
        logger.warning("SMTP auth failed for %s@%s: %s", username, host, exc)
        return False, "smtp_auth_failed"
    except smtplib.SMTPRecipientsRefused as exc:
        logger.warning("SMTP recipient refused (%s): %s", to, exc)
        return False, "smtp_recipient_refused"
    except Exception as exc:
        logger.warning("SMTP send failed via %s: %s", host, exc)
        return False, "smtp_error"


def send_email(
    to: str,
    subject: str,
    body: str,
    attachments: list[Attachment] | None = None,
) -> tuple[bool, str | None]:
    """Legacy global-settings sender (SMTP_* env). Kept for the existing
    _send_email wrapper in api/digital_prf.py."""
    from app.config import get_settings
    settings = get_settings()
    if not settings.SMTP_HOST:
        return False, "smtp_not_configured"
    sender = settings.SMTP_FROM_EMAIL or settings.SMTP_USERNAME or "noreply@emsclaims.local"
    return send_email_via(
        host=settings.SMTP_HOST,
        port=settings.SMTP_PORT,
        username=settings.SMTP_USERNAME,
        password=settings.SMTP_PASSWORD,
        from_email=sender,
        from_name=settings.SMTP_FROM_NAME,
        to=to,
        subject=subject,
        body=body,
        attachments=attachments,
        use_tls=settings.SMTP_USE_TLS,
    )
