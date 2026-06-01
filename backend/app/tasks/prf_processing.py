"""
Asynchronous PRF submission processing — Celery task.

Moves the heavy billing pipeline (mileage engine → tariff engine → Case/Claim
creation) out of the HTTP request handler. The submit endpoint now returns
202 Accepted immediately, and this task runs in the background.

This prevents long-running tariff calculations from blocking Uvicorn workers
(critical when 500+ ambulances may submit PRFs concurrently at shift change).
"""
from __future__ import annotations
import uuid
import logging
from datetime import datetime, timezone

from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded

logger = logging.getLogger("ems.prf_processing")


# ── Celery-safe async DB session ─────────────────────────────────────────────
# The module-level `engine` in app.database is bound to the event loop that
# was active when the module was first imported. Celery tasks create a NEW
# event loop for each invocation (asyncio.new_event_loop()), so the pooled
# connections are attached to a stale loop → "Future attached to a different
# loop" crash. We solve this by creating a *disposable* engine + session
# factory inside each task, bound to the task's own event loop, and disposing
# it when the task finishes.

def _make_celery_session():
    """Create a fresh async engine + session factory for use inside a Celery task.

    Returns (engine, sessionmaker). Caller MUST call `await engine.dispose()`
    when done to release all connections.
    """
    from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
    from app.config import get_settings

    settings = get_settings()
    eng = create_async_engine(
        settings.DATABASE_URL,
        echo=False,
        pool_size=2,          # Celery tasks are sequential — small pool is fine
        max_overflow=0,
        pool_pre_ping=True,
    )
    factory = async_sessionmaker(eng, class_=AsyncSession, expire_on_commit=False)
    return eng, factory


async def _mark_attempt(prf_id: str, error_msg: str, attempt: int):
    """Record a processing attempt on the PRF (regardless of retry outcome)."""
    from sqlalchemy import select
    from app.models.digital_prf import DigitalPRF

    engine, Session = _make_celery_session()
    try:
        async with Session() as db:
            result = await db.execute(select(DigitalPRF).where(DigitalPRF.id == uuid.UUID(prf_id)))
            prf = result.scalar_one_or_none()
            if prf:
                prf.processing_error = error_msg[:2000]
                prf.processing_attempts = attempt
                prf.last_processing_at = datetime.now(timezone.utc)
                await db.commit()
    finally:
        await engine.dispose()


async def _mark_failed(prf_id: str, error_msg: str):
    """Mark a PRF as FAILED after all Celery retries are exhausted."""
    from sqlalchemy import select
    from app.models.digital_prf import DigitalPRF, PRFStatus

    engine, Session = _make_celery_session()
    try:
        async with Session() as db:
            result = await db.execute(select(DigitalPRF).where(DigitalPRF.id == uuid.UUID(prf_id)))
            prf = result.scalar_one_or_none()
            if prf:
                prf.status = PRFStatus.FAILED
                prf.processing_error = error_msg[:2000]
                prf.last_processing_at = datetime.now(timezone.utc)
                await db.commit()
                logger.error(
                    "PRF %s marked as FAILED after %d attempts: %s",
                    prf_id, prf.processing_attempts, error_msg[:200],
                )
    finally:
        await engine.dispose()

@shared_task(
    name="process_prf_submission",
    bind=True,
    max_retries=3,
    default_retry_delay=15,
    acks_late=True,
)
def process_prf_submission(self, prf_id: str):
    """Process a submitted Digital PRF: run mileage + tariff engines,
    create Case → Document → Claim → ClaimLines.

    Runs inside a Celery worker so it doesn't block the web server.
    Retries up to 3 times with 15s delay on transient failures.
    """
    import asyncio

    async def _process():
        from sqlalchemy import select
        from app.models.digital_prf import DigitalPRF, PRFStatus
        from app.models.case import Case
        from app.models.claim import Claim, AdjudicationStatus
        from app.models.document import Document, OCRStatus
        from app.models.claim_line import ClaimLine
        from app.models.crew_member import CrewMember
        from app.models.service_provider import ServiceProvider

        engine, Session = _make_celery_session()
        try:
            async with Session() as db:
                # ── Load PRF ──
                result = await db.execute(
                    select(DigitalPRF).where(DigitalPRF.id == uuid.UUID(prf_id))
                )
                prf = result.scalar_one_or_none()
                if not prf:
                    logger.error("PRF %s not found for processing", prf_id)
                    return {"error": "prf_not_found"}

                # Already processed (idempotent)
                if prf.status == PRFStatus.PROCESSED:
                    logger.info("PRF #%d already processed, skipping", prf.prf_number)
                    return {"status": "already_processed", "prf_number": prf.prf_number}

                fd: dict = prf.form_data or {}
                now = datetime.now(timezone.utc)

                # ── Resolve crew and provider ──
                crew1 = None
                if prf.crew_member_1_id:
                    crew_res = await db.execute(
                        select(CrewMember).where(CrewMember.id == prf.crew_member_1_id)
                    )
                    crew1 = crew_res.scalar_one_or_none()

                provider = None
                if prf.provider_id:
                    provider_res = await db.execute(
                        select(ServiceProvider).where(ServiceProvider.id == prf.provider_id)
                    )
                    provider = provider_res.scalar_one_or_none()

                # ── Stage 0: adapt digital form into extracted_data shape ──
                # Import the adapter from the API module (it's a pure function)
                from app.api.digital_prf import _adapt_prf_to_extracted_data
                extracted_data = _adapt_prf_to_extracted_data(prf, crew1, provider)

                # ── Stage 1: run mileage validation ──
                try:
                    from app.services.mileage_engine import validate_mileage
                    mileage_result = validate_mileage(extracted_data)
                    b = mileage_result.billable
                    extracted_data["mileage_billable_callout_km"] = b.callout_km_billable
                    extracted_data["mileage_billable_loaded_km"]  = b.loaded_km_billable
                    extracted_data["mileage_billable_rtb_km"]     = b.rtb_km_billable
                    extracted_data["mileage_billable_total_km"]   = b.total_km_billable
                    extracted_data["mileage_scene_minutes"]       = b.scene_minutes
                    extracted_data["mileage_validation"] = {
                        "is_valid":     mileage_result.is_valid,
                        "has_warnings": mileage_result.has_warnings,
                        "summary":      mileage_result.summary,
                        "issues": [
                            {"layer": i.layer, "code": i.code, "severity": i.severity, "message": i.message}
                            for i in mileage_result.issues
                        ],
                    }
                except Exception as me:
                    logger.warning("PRF #%d: mileage validation failed: %s", prf.prf_number, me)

                # ── Case ──
                from sqlalchemy import func
                full_name = extracted_data.get("patient_name") or "Unknown Patient"
                call_raw = (fd.get("call_type") or "").upper()
                dispatch_type = "IFT" if call_raw in ("TRANSFER", "IHT", "IFT", "RHT", "COURTESY") else "Primary"
                incident_date = prf.time_call_received.date() if prf.time_call_received else now.date()

                case = Case(
                    patient_name=full_name,
                    patient_id_number=(fd.get("patient_id_number") or None),
                    medical_scheme_name=(fd.get("medical_scheme") or None),
                    scheme_member_number=(fd.get("medical_aid_number") or None),
                    incident_date=incident_date,
                    incident_location=(fd.get("incident_location") or None),
                    preauth_number=(fd.get("preauth_number") or None),
                    dependant_code=(fd.get("dependent_number") or None),
                    dispatch_type=dispatch_type,
                    referring_doctor_pr=(fd.get("referring_doctor") or None),
                )
                db.add(case)
                await db.flush()

                # ── Document ──
                document = Document(
                    case_id=case.id,
                    original_filename=f"PRF-{prf.prf_number}.json",
                    storage_uri=f"digital-prf://{prf.id}",
                    document_type="Digital PRF",
                    ocr_status=OCRStatus.COMPLETED,
                    ocr_confidence_avg=1.0,
                    extracted_data=extracted_data,
                    needs_hitl_review=False,
                )
                db.add(document)
                await db.flush()

                # ── Claim ──
                scheme_name = fd.get("medical_scheme") or ""
                claim = Claim(
                    case_id=case.id,
                    total_amount=0,
                    target_scheme=scheme_name or None,
                    adjudication_status=AdjudicationStatus.PENDING,
                )
                db.add(claim)
                await db.flush()

                # ── Stage 2: run the tariff engine ──
                tariff_meta: dict = {}
                line_count = 0
                try:
                    from app.services.tariff_engine import generate_tariff_lines
                    tariff = await generate_tariff_lines(extracted_data, scheme_name, db)
                    for idx, item in enumerate(tariff.get("lines", []), start=1):
                        db.add(ClaimLine(
                            claim_id=claim.id,
                            line_number=idx,
                            cpt_code=item.get("cpt_code"),
                            nappi_code=item.get("nappi_code"),
                            icd10_primary=item.get("icd10_primary"),
                            icd10_secondary=item.get("icd10_secondary"),
                            description=item.get("description"),
                            modifier=item.get("modifier"),
                            quantity=int(item.get("quantity") or 1),
                            unit_price=float(item.get("unit_price") or 0.0),
                            total_price=float(item.get("total_price") or 0.0),
                        ))
                        line_count += 1
                    claim.total_amount = float(tariff.get("total_amount") or 0.0)
                    tariff_meta = {
                        "scheme_matched": tariff.get("scheme_matched"),
                        "rules_used":     tariff.get("rules_used", 0),
                        "ai_powered":     tariff.get("ai_powered", False),
                        "error":          tariff.get("error"),
                    }
                except Exception as te:
                    logger.error("PRF #%d: tariff engine failed: %s", prf.prf_number, te)
                    tariff_meta = {"error": f"Tariff engine failed: {te}"}

                # ── Finalise PRF ──
                prf.case_id = case.id
                prf.document_id = document.id
                prf.status = PRFStatus.PROCESSED
                prf.submitted_at = now

                await db.commit()

                logger.info(
                    "PRF #%d processed → Case %s, Claim %s (%d lines, R%.2f, scheme=%s)",
                    prf.prf_number, case.id, claim.id,
                    line_count, float(claim.total_amount), scheme_name or "—",
                )

                return {
                    "status": "processed",
                    "prf_number": prf.prf_number,
                    "case_id": str(case.id),
                    "claim_id": str(claim.id),
                    "line_count": line_count,
                    "claim_total": float(claim.total_amount),
                }
        finally:
            await engine.dispose()

    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(_process())
        loop.close()
        return result
    except SoftTimeLimitExceeded:
        # Task exceeded the soft time limit (60s) — mark as FAILED immediately
        # before the hard kill at 120s terminates the worker process.
        error_msg = (
            "Task timed out after 60 seconds (soft limit). "
            "This PRF may require manual investigation."
        )
        logger.error("PRF %s: %s", prf_id, error_msg)
        try:
            loop_timeout = asyncio.new_event_loop()
            loop_timeout.run_until_complete(_mark_failed(prf_id, error_msg))
            loop_timeout.close()
        except Exception:
            pass
        return {"status": "failed", "prf_id": prf_id, "error": error_msg}
    except Exception as exc:
        attempt = (self.request.retries or 0) + 1
        logger.error(
            "PRF %s processing failed (attempt %d/%d): %s",
            prf_id, attempt, self.max_retries + 1, exc, exc_info=True,
        )

        # Record the attempt on the PRF record
        try:
            loop2 = asyncio.new_event_loop()
            loop2.run_until_complete(_mark_attempt(prf_id, str(exc), attempt))
            loop2.close()
        except Exception:
            pass  # Don't crash the error handler

        if self.request.retries >= self.max_retries:
            # All retries exhausted — mark as FAILED for admin review
            try:
                loop3 = asyncio.new_event_loop()
                loop3.run_until_complete(_mark_failed(prf_id, str(exc)))
                loop3.close()
            except Exception:
                pass
            return {"status": "failed", "prf_id": prf_id, "error": str(exc)[:500]}

        raise self.retry(exc=exc)
