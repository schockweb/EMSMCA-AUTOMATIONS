"""
Celery application configuration.
"""
from __future__ import annotations
import traceback
from celery import Celery
from celery.signals import task_failure
from app.config import get_settings

settings = get_settings()

celery_app = Celery(
    "ems_claims",
    broker=settings.CELERY_BROKER_URL,
    include=[
        "app.tasks.preprocessing",
        "app.tasks.extraction",
        "app.tasks.prf_processing",
        "app.tasks.dlq_setup",
    ],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Africa/Johannesburg",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,

    # ── Dead Letter Queue (Item 7) ────────────────────────
    # Messages that are rejected, nacked, or expire are routed to
    # the ems_dead_letter queue via the ems_dlx exchange.
    task_default_queue="ems_default",
    task_default_exchange="ems_default",
    task_default_routing_key="ems_default",
    task_queues={
        "ems_default": {
            "exchange": "ems_default",
            "routing_key": "ems_default",
            "queue_arguments": {
                "x-dead-letter-exchange": "ems_dlx",
                "x-dead-letter-routing-key": "ems_dead_letter",
            },
        },
    },

    # ── Worker Heartbeat & Task Timeout (Item 8) ──────────
    # Hard kill after 120s — prevents hung workers consuming a slot forever.
    # Soft limit at 60s — raises SoftTimeLimitExceeded so the task can
    # mark the PRF as FAILED gracefully before the hard kill.
    task_time_limit=120,
    task_soft_time_limit=60,
    worker_send_task_events=True,
    task_send_sent_event=True,
)


# ── Crash Monitoring: Capture all Celery task failures ──

@task_failure.connect
def on_task_failure(sender=None, task_id=None, exception=None,
                    args=None, kwargs=None, traceback=None, einfo=None, **kw):
    """
    Signal handler: fires whenever ANY Celery task raises an unhandled exception.
    Persists a CrashEvent record (source=celery) for the System Health dashboard.
    """
    import asyncio

    async def _persist():
        from app.database import AsyncSessionLocal
        from app.models.crash_event import CrashEvent, CrashSource, CrashSeverity

        # Determine severity
        exc_type_name = type(exception).__name__ if exception else "Unknown"
        severity = CrashSeverity.ERROR
        critical_types = {"SystemExit", "MemoryError", "DatabaseError", "OperationalError"}
        if exc_type_name in critical_types:
            severity = CrashSeverity.CRITICAL

        # Build traceback string
        tb_str = ""
        if einfo:
            tb_str = str(einfo)[:10000]
        elif traceback:
            tb_str = str(traceback)[:10000]

        task_name = sender.name if sender else "unknown_task"

        try:
            async with AsyncSessionLocal() as db:
                crash = CrashEvent(
                    source=CrashSource.CELERY,
                    severity=severity,
                    error_type=exc_type_name,
                    message=str(exception)[:2000] if exception else "Unknown error",
                    stacktrace=tb_str,
                    endpoint=task_name,
                    metadata_blob={
                        "task_id": task_id,
                        "task_args": str(args)[:500] if args else None,
                        "task_kwargs": str(kwargs)[:500] if kwargs else None,
                    },
                )
                db.add(crash)
                await db.commit()
        except Exception as db_err:
            import logging
            logging.getLogger("ems.celery_crash").critical(
                "Failed to persist Celery crash event: %s | Task: %s | Error: %s",
                str(db_err), task_name, str(exception),
            )

    # Run in a new event loop since Celery signal handlers are synchronous
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(_persist())
        loop.close()
    except Exception:
        pass  # Don't crash the crash handler

