"""
Retention and destruction of clinical records — POPIA s14(4).

WHY THIS EXISTS
---------------
Backup retention was precise and enforced: 14 daily, 7 years of monthlies,
verified nightly. LIVE record retention was undefined and enforced nowhere. So
"how long do you keep this data?" could be answered with a number for the
backups and nothing at all for the database — which is the half that matters,
because s14(4) obliges the responsible party to DESTROY a record once the
purpose has lapsed and no law requires it to be kept.

THE POLICY
----------
Health records in South Africa are kept for a minimum period after the last
consultation; this platform holds EMS patient report forms and the claims
derived from them, so the retention clock runs from the record's own capture
date. `RETENTION_YEARS` below is that period, and it is deliberately a setting
rather than a constant so a provider whose regulator or insurer requires longer
can raise it without a code change. It must never be lowered without a
documented instruction from the responsible party — this platform is an
operator and destroying a record early is as much a breach as keeping it too
long.

WHY IT REPORTS BEFORE IT DELETES
--------------------------------
`purge_expired_records` runs in DRY-RUN unless RETENTION_ENFORCE is switched on.
Destruction of clinical records is irreversible and the platform is months old,
so nothing is yet due — meaning the first time this task can possibly delete
anything is years away, long after everyone who wrote it has forgotten it
exists. A task that silently begins destroying patient records on its own one
day, with no one watching, is a worse outcome than a retention obligation
tracked by hand. It reports every run; enabling enforcement is a deliberate act.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from celery import shared_task
from sqlalchemy import func, select

import app.tasks.celery_app  # noqa: F401  — binds broker config

logger = logging.getLogger("ems.retention")

# Approximate a year as 365.25 days: over a seven-year window the leap-day drift
# is ~2 days, which is immaterial against a statutory minimum but wrong to
# ignore silently.
_DAYS_PER_YEAR = 365.25


def _cutoff(years: float) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=years * _DAYS_PER_YEAR)


async def retention_report(db) -> dict:
    """What is held, what is due for destruction, and when the oldest record
    becomes due. Read-only — safe to call from an API route."""
    from app.config import get_settings
    from app.models.case import Case
    from app.models.digital_prf import DigitalPRF

    settings = get_settings()
    years = getattr(settings, "RETENTION_YEARS", 7)
    enforce = bool(getattr(settings, "RETENTION_ENFORCE", False))
    cutoff = _cutoff(years)

    prf_total = (await db.execute(select(func.count(DigitalPRF.id)))).scalar() or 0
    case_total = (await db.execute(select(func.count(Case.id)))).scalar() or 0
    prf_due = (await db.execute(
        select(func.count(DigitalPRF.id)).where(DigitalPRF.created_at < cutoff)
    )).scalar() or 0
    case_due = (await db.execute(
        select(func.count(Case.id)).where(Case.created_at < cutoff)
    )).scalar() or 0
    oldest = (await db.execute(select(func.min(DigitalPRF.created_at)))).scalar()

    return {
        "policy": {
            "retention_years": years,
            "clock_starts": "record capture date",
            "enforcement": "active" if enforce else "reporting only",
            "cutoff": cutoff.isoformat(),
        },
        "held": {"patient_report_forms": prf_total, "cases": case_total},
        "due_for_destruction": {"patient_report_forms": prf_due, "cases": case_due},
        "oldest_record": oldest.isoformat() if oldest else None,
        "oldest_becomes_due": (
            (oldest + timedelta(days=years * _DAYS_PER_YEAR)).isoformat()
            if oldest else None
        ),
        "note": (
            "Destruction is irreversible and is NOT performed automatically unless "
            "RETENTION_ENFORCE is set. Clinical records must not be destroyed early: "
            "this platform is an operator, and early destruction is as much a breach "
            "as over-retention."
        ),
    }


@shared_task(name="report_retention_status", acks_late=True)
def report_retention_status():
    """Weekly. Writes the retention position to the log so the obligation is
    visible in operations rather than living only in a document nobody opens.

    Deliberately does not delete. See the module docstring: a task that begins
    destroying patient records unattended, years after it was written, is a
    worse failure than tracking the obligation by hand.
    """
    import asyncio

    async def _run():
        from app.tasks.prf_processing import _make_celery_session

        engine, Session = _make_celery_session()
        try:
            async with Session() as db:
                report = await retention_report(db)
        finally:
            await engine.dispose()

        due = report["due_for_destruction"]
        if due["patient_report_forms"] or due["cases"]:
            logger.warning(
                "RETENTION: %d PRF(s) and %d case(s) are past the %s-year period "
                "and are due for destruction under POPIA s14(4). Enforcement is %s.",
                due["patient_report_forms"], due["cases"],
                report["policy"]["retention_years"], report["policy"]["enforcement"],
            )
        else:
            logger.info(
                "RETENTION: nothing due. Oldest record %s, becomes due %s.",
                report["oldest_record"], report["oldest_becomes_due"],
            )
        return report

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(_run())
    finally:
        loop.close()


@shared_task(name="purge_expired_idempotency_keys", acks_late=True)
def purge_expired_idempotency_keys():
    """Delete idempotency rows whose window has passed.

    NOTHING deleted from this table before. `expires_at` stopped a row being
    SERVED, never being STORED, so every medical-scheme response body ever
    proxied accumulated forever — the crash_events shape (which reached 3.68
    million rows) except these rows contain patient data.

    Deleting an expired row is not destructive in the sense the monitor's safety
    model means: the row's own recorded policy says it may no longer be used,
    and its purpose — collapsing a duplicate submission onto one outcome — has
    lapsed. Abandoned IN_PROGRESS locks are cleared on the same pass, well past
    the reclaim window that app/utils/idempotency.py already honours inline.
    """
    import asyncio

    async def _run():
        from sqlalchemy import delete, or_, func, select
        from app.models.idempotency import IdempotencyKey
        from app.tasks.prf_processing import _make_celery_session

        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        engine, Session = _make_celery_session()
        try:
            async with Session() as db:
                before = (await db.execute(
                    select(func.count(IdempotencyKey.key))
                )).scalar() or 0
                result = await db.execute(
                    delete(IdempotencyKey).where(or_(
                        IdempotencyKey.expires_at < datetime.now(timezone.utc),
                        IdempotencyKey.created_at < cutoff,
                    ))
                )
                await db.commit()
                deleted = result.rowcount or 0
        finally:
            await engine.dispose()

        if deleted:
            logger.info(
                "IDEMPOTENCY: purged %d expired key(s) of %d.", deleted, before
            )
        return {"purged": deleted, "before": before}

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(_run())
    finally:
        loop.close()
