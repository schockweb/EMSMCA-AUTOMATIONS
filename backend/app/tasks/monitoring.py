"""
The scheduled probe sweep.

Runs in the Celery beat/worker pair rather than in the API process on purpose:
a sweep that lives inside the web app cannot detect the web app being wedged,
and several probes need to inspect the broker, which is work that has no
business happening on a request thread.
"""
from __future__ import annotations

import logging

from celery import shared_task

import app.tasks.celery_app  # noqa: F401  — binds broker config

logger = logging.getLogger("ems.monitor")


@shared_task(name="run_monitor_sweep", acks_late=True)
def run_monitor_sweep():
    """Check every registered condition; fix or escalate."""
    import asyncio

    async def _run():
        # Importing the probe module is what REGISTERS the probes. Without it
        # the registry is empty and the sweep cheerfully reports zero faults —
        # the same class of bug as a beat task whose module was never added to
        # Celery's include list, which shipped once already.
        import app.services.monitor.probes  # noqa: F401
        from app.services.monitor.engine import run_sweep
        from app.tasks.prf_processing import _make_celery_session

        engine, Session = _make_celery_session()
        try:
            async with Session() as db:
                return await run_sweep(db)
        finally:
            await engine.dispose()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        summary = loop.run_until_complete(_run())
    finally:
        loop.close()

    if summary["faults"]:
        logger.warning(
            "MONITOR: %d fault(s) — %d fixed automatically, %d waiting for approval "
            "(%d probes run, %d inconclusive, %d probe errors)",
            summary["faults"], summary["auto_healed"], summary["awaiting_approval"],
            summary["checked"], summary["inconclusive"], summary["probe_errors"],
        )
    else:
        logger.info(
            "MONITOR: all %d checks passed (%d inconclusive)",
            summary["checked"], summary["inconclusive"],
        )
    return summary
