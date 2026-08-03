"""
Celery application configuration.
"""
from __future__ import annotations
import traceback
from celery import Celery
from celery.signals import task_failure
from kombu import Queue, Exchange
from app.config import get_settings

settings = get_settings()

celery_app = Celery(
    "ems_claims",
    broker=settings.CELERY_BROKER_URL,
    include=[
        "app.tasks.preprocessing",
        "app.tasks.extraction",
        "app.tasks.prf_processing",
        "app.tasks.prf_email",
        "app.tasks.dlq_setup",
        # Without this the worker never REGISTERS report_retention_status, so
        # beat publishes it on schedule and the worker rejects every delivery as
        # an unregistered task — a scheduled job that looks configured and has
        # never once run. Any new task module must be added here.
        "app.tasks.retention",
        "app.tasks.monitoring",
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
    task_queues=(
        Queue("ems_default", Exchange("ems_default"), routing_key="ems_default", queue_arguments={
            "x-dead-letter-exchange": "ems_dlx",
            "x-dead-letter-routing-key": "ems_dead_letter",
        }),
        Queue("ems_critical", Exchange("ems_critical"), routing_key="ems_critical", queue_arguments={
            "x-dead-letter-exchange": "ems_dlx",
            "x-dead-letter-routing-key": "ems_dead_letter",
        }),
        Queue("ems_batch", Exchange("ems_batch"), routing_key="ems_batch", queue_arguments={
            "x-dead-letter-exchange": "ems_dlx",
            "x-dead-letter-routing-key": "ems_dead_letter",
        }),
    ),

    # ── Worker Heartbeat & Task Timeout (Item 8) ──────────
    # Hard kill after 120s — prevents hung workers consuming a slot forever.
    # Soft limit at 60s — raises SoftTimeLimitExceeded so the task can
    # mark the PRF as FAILED gracefully before the hard kill.
    # ── Bound how long a publish can take when the broker misbehaves ──
    #
    # RabbitMQ's real failure mode under a memory or disk alarm is to accept the
    # TCP connection and then HANG, not to refuse it. With no timeout, a publish
    # waits indefinitely. The submit path now offloads the publish to a thread so
    # the event loop stays free either way, but an unbounded wait still parks a
    # thread-pool slot and leaves the crew's request hanging with no answer.
    #
    # 2s to connect, one retry, then fail — the caller already handles a failed
    # enqueue properly (api/digital_prf.py reverts SUBMITTED -> DRAFT and returns
    # 503 so the crew can retry, rather than stranding the PRF).
    broker_connection_timeout=2,
    broker_connection_retry_on_startup=True,
    # DELIBERATELY no read_timeout / write_timeout here.
    #
    # They were added to stop a hung broker parking a publishing thread, and
    # they broke the connection outright: `read_timeout` applies to reads on the
    # persistent AMQP connection, so a normal declare-ok wait raised
    # `TimeoutError: timed out` and every publish failed. Caught by
    # tests/test_broker_queue_declare.py against a real RabbitMQ.
    #
    # The concern was genuine — a parked thread from the SHARED default executor
    # could starve bcrypt on the login path. That is now solved where it belongs,
    # in app/tasks/publish.py: publishes run on their own small executor, so a
    # blocked broker can exhaust only the publish pool and never logins.
    broker_transport_options={"max_retries": 1},
    task_time_limit=120,
    task_soft_time_limit=60,
    worker_send_task_events=True,
    task_send_sent_event=True,

    # ── Beat schedule (runs in the celery_beat container) ──
    # Watchdog for the "SUBMITTED black hole": the submit endpoint commits
    # SUBMITTED then enqueues — a lost message strands the PRF invisibly.
    # Every 5 minutes the watchdog re-enqueues PRFs stuck >10 min and
    # escalates ones stuck >60 min to FAILED for the admin Failed Forms page.
    # See requeue_stuck_prfs in app/tasks/prf_processing.py.
    beat_schedule={
        "requeue-stuck-prfs": {
            "task": "requeue_stuck_prfs",
            "schedule": 300.0,  # every 5 minutes
            "options": {"queue": "ems_default"},
        },
        # token_blacklist had no cleanup at all. Every logout and every
        # refresh-token rotation adds a row, and a row is worthless the moment
        # the token it revokes expires on its own `exp` claim — but nothing ever
        # deleted them. At the target scale (~1500 crew, two sessions a day
        # each, plus admin logins) that is on the order of 1.1M rows a year of
        # dead weight, on a table consulted by EVERY authenticated request.
        # Hourly is ample: the largest token lifetime is the 7-day refresh
        # token, so nothing accumulates meaningfully between runs.
        "purge-expired-blacklist": {
            "task": "purge_expired_blacklist",
            "schedule": 3600.0,  # hourly
            "options": {"queue": "ems_default"},
        },
        # The retention obligation is reported weekly so it lives in operations
        # rather than only in a policy document. It reports; it does not delete.
        "report-retention-status": {
            "task": "report_retention_status",
            "schedule": 604800.0,  # weekly
            "options": {"queue": "ems_default"},
        },
        # The email spool holds rendered patient PDFs — complete clinical
        # records — waiting to be attached. Every code path deletes its own
        # file, but a SIGKILLed worker (OOM) or a container replaced mid-deploy
        # abandons one, and nothing else has ever swept that directory. Left
        # alone it grows without bound and retains PHI indefinitely.
        "purge-prf-email-spool": {
            "task": "purge_prf_email_spool",
            "schedule": 3600.0,  # hourly
            "options": {"queue": "ems_default"},
        },
        # The fault sweep. Detection always runs; whether a fix is APPLIED
        # without a human is governed by MONITOR_AUTO_HEAL_ENABLED and the
        # safety gates in app/services/monitor/registry.py.
        "run-monitor-sweep": {
            "task": "run_monitor_sweep",
            "schedule": float(settings.MONITOR_SWEEP_SECONDS),
            "options": {"queue": "ems_default"},
        },
    },
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

