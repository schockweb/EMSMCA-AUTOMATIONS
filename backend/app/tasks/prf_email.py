"""
Email a submitted PRF PDF to the receiving facility — FROM the provider's
own Gmail / Outlook account (ServiceProvider.smtp_*).

Enqueued by POST /api/digital-prf/admin/by-case/{case_id}/email-facility,
which stores the client-rendered PDF on the shared uploads volume first.
On success the PRF row is stamped (facility_email_sent_to / _at) so the
UI shows "sent" and the duplicate-send guard holds.

Retry policy: transient failures (network / SMTP hiccups) retry with
exponential backoff. Authentication failures do NOT retry — a wrong app
password will not fix itself, and hammering Gmail with bad logins gets the
provider's account locked.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone

from celery import shared_task

import app.tasks.celery_app  # noqa: F401  — binds broker config; without this import enqueues fail

logger = logging.getLogger("ems.prf_email")

# Errors that retrying cannot fix.
_NO_RETRY_REASONS = {"smtp_auth_failed", "smtp_recipient_refused", "smtp_not_configured"}


def _make_celery_session():
    """Fresh async engine + session factory bound to this task's event loop
    (module-level engine is bound to the API's loop — see prf_processing)."""
    from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
    from app.config import get_settings

    settings = get_settings()
    eng = create_async_engine(
        settings.DATABASE_URL,
        echo=False,
        pool_size=2,
        max_overflow=0,
        pool_pre_ping=True,
    )
    factory = async_sessionmaker(eng, class_=AsyncSession, expire_on_commit=False)
    return eng, factory


@shared_task(
    bind=True,
    name="app.tasks.prf_email.send_prf_facility_email",
    max_retries=4,
    soft_time_limit=120,
    time_limit=180,
)
def send_prf_facility_email(self, prf_id: str, recipient: str, pdf_path: str, force: bool = False):
    """Send the PRF PDF at `pdf_path` to `recipient` via the provider's SMTP.

    `force` marks a deliberate resend (corrected recipient / explicit "send
    again"). Without it, an already-stamped PRF is SKIPPED — this is the
    duplicate guard for the race where the crew sends manually (stamping the
    PRF) while an earlier automatic attempt is still retrying in the
    background: the stale retry must abort, not deliver a second copy.
    """

    async def _run() -> tuple[bool, str | None]:
        from sqlalchemy import select
        from app.models.digital_prf import DigitalPRF
        from app.models.service_provider import ServiceProvider
        from app.utils.crypto import decrypt_str
        from app.utils.emailer import resolve_service, send_email_via

        eng, factory = _make_celery_session()
        try:
            async with factory() as db:
                prf_res = await db.execute(select(DigitalPRF).where(DigitalPRF.id == prf_id))
                prf = prf_res.scalar_one_or_none()
                if not prf:
                    return False, "prf_not_found"
                # Already sent (automatically or marked manual by the crew)
                # and this isn't a deliberate resend — abort without emailing.
                if prf.facility_email_sent_at and not force:
                    return True, "already_sent_skip"
                prov_res = await db.execute(
                    select(ServiceProvider).where(ServiceProvider.id == prf.provider_id)
                )
                provider = prov_res.scalar_one_or_none()
                if not provider or not (provider.smtp_email and provider.smtp_password_encrypted):
                    return False, "smtp_not_configured"

                endpoint = resolve_service(provider.smtp_service)
                if not endpoint:
                    return False, "smtp_not_configured"
                password = decrypt_str(provider.smtp_password_encrypted)
                if not password:
                    # Encrypted under a different key / corrupt — needs the
                    # admin to re-enter the app password. Not retryable.
                    return False, "smtp_auth_failed"

                try:
                    with open(pdf_path, "rb") as fh:
                        pdf_bytes = fh.read()
                except OSError:
                    return False, "pdf_missing"

                fd = prf.form_data or {}
                patient = " ".join(
                    p for p in [fd.get("patient_name"), fd.get("patient_surname")] if p
                ).strip() or "Patient"
                subject = f"Patient Report Form — {patient} — {prf.case_number or prf.prf_number}"
                body = (
                    f"Please find attached the Patient Report Form for {patient}, "
                    f"transported by {provider.name}.\n\n"
                    f"Case number: {prf.case_number or '—'}\n"
                    f"PRF number: {prf.prf_number}\n\n"
                    "This document contains confidential patient information intended "
                    "only for the receiving facility.\n\n"
                    f"Sent by {provider.name} via the EMS Claims Portal."
                )
                filename = f"PRF_{prf.case_number or prf.prf_number}.pdf"

                host, port = endpoint
                sent, reason = send_email_via(
                    host=host,
                    port=port,
                    username=provider.smtp_email,
                    password=password,
                    from_email=provider.smtp_email,
                    from_name=provider.name,
                    to=recipient,
                    subject=subject,
                    body=body,
                    attachments=[{
                        "filename": filename,
                        "content": pdf_bytes,
                        "mime_type": "application/pdf",
                    }],
                )
                if sent:
                    prf.facility_email_sent_to = recipient
                    prf.facility_email_sent_at = datetime.now(timezone.utc)
                    prf.facility_email_error = None
                    await db.commit()
                return sent, reason
        finally:
            await eng.dispose()

    async def _stamp_error(reason: str) -> None:
        """Persist a terminal failure on the PRF so the admin surfaces and the
        PRF view can show 'facility email failed: <reason>' — a silent
        logger-only failure behind the crew's success message is exactly the
        defect this stamp exists to prevent."""
        from sqlalchemy import select
        from app.models.digital_prf import DigitalPRF
        eng, factory = _make_celery_session()
        try:
            async with factory() as db:
                res = await db.execute(select(DigitalPRF).where(DigitalPRF.id == prf_id))
                prf = res.scalar_one_or_none()
                if prf:
                    prf.facility_email_error = (reason or "smtp_error")[:50]
                    await db.commit()
        finally:
            await eng.dispose()

    def _run_async(coro):
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()

    def _cleanup_pdf():
        try:
            os.remove(pdf_path)
        except OSError:
            pass

    sent, reason = _run_async(_run())

    if sent:
        _cleanup_pdf()
        if reason == "already_sent_skip":
            logger.info("PRF %s already sent — stale retry skipped (no duplicate)", prf_id)
            return {"sent": False, "reason": reason}
        logger.info("PRF %s emailed to facility %s", prf_id, recipient)
        return {"sent": True, "recipient": recipient}

    terminal = reason in _NO_RETRY_REASONS or reason in ("prf_not_found", "pdf_missing")
    # Out of retries? The next self.retry() would raise MaxRetriesExceeded —
    # treat as terminal so the failure is stamped and the spool file cleaned.
    if not terminal and self.request.retries >= (self.max_retries or 0):
        terminal = True
        reason = f"{reason or 'smtp_error'}_final"

    if terminal:
        _cleanup_pdf()
        if reason != "prf_not_found":
            try:
                _run_async(_stamp_error(reason or "smtp_error"))
            except Exception:
                logger.exception("PRF %s: could not stamp facility_email_error", prf_id)
        logger.warning("PRF %s facility email NOT sent (%s) — not retrying", prf_id, reason)
        return {"sent": False, "reason": reason}

    # Transient (network / smtp_error) — exponential backoff: 2, 4, 8, 16 min.
    # The spool file stays in place for the retry to attach.
    countdown = 120 * (2 ** self.request.retries)
    logger.warning(
        "PRF %s facility email failed (%s) — retry %d in %ds",
        prf_id, reason, self.request.retries + 1, countdown,
    )
    raise self.retry(countdown=countdown)
