"""
Every scheduled task must actually be registered with the worker.

Celery's `beat_schedule` and its `include` list are independent. Add a task to
the schedule and forget to add its MODULE to `include`, and the result is
silent: beat publishes the message on time, every time, and the worker rejects
each one as an unregistered task. The schedule looks configured, the code
exists, and the job has never once run.

That happened here — `report_retention_status` was scheduled weekly while
`app.tasks.retention` was absent from `include`, so the retention obligation
would have been reported by a job that could not execute. Found by reading the
worker's startup banner rather than by trusting the config.
"""
import importlib

import pytest

from app.tasks.celery_app import celery_app


def _load_included_modules():
    """Import exactly what the worker imports at startup."""
    for module in celery_app.conf.include or ():
        importlib.import_module(module)


def test_every_scheduled_task_is_registered():
    _load_included_modules()

    scheduled = {name: entry["task"] for name, entry in celery_app.conf.beat_schedule.items()}
    missing = {
        name: task for name, task in scheduled.items()
        if task not in celery_app.tasks
    }
    assert not missing, (
        f"scheduled but NOT registered: {missing}. Beat will publish these on "
        f"schedule and the worker will reject every delivery as an unregistered "
        f"task — a job that looks configured and can never run. Add the owning "
        f"module to celery_app's `include` list."
    )


def test_the_schedule_is_not_empty():
    """A guard against the guard: if beat_schedule were ever emptied, the test
    above would pass vacuously while every background job silently stopped."""
    assert celery_app.conf.beat_schedule, "no scheduled tasks at all"


@pytest.mark.parametrize("expected", [
    "requeue_stuck_prfs",            # the SUBMITTED black-hole watchdog
    "purge_expired_blacklist",       # token table growth
    "purge_prf_email_spool",         # abandoned patient PDFs
    "report_retention_status",       # POPIA s14 obligation
])
def test_the_jobs_we_rely_on_are_scheduled(expected):
    """Named explicitly, so deleting one from the schedule is a decision rather
    than an accident."""
    tasks = {entry["task"] for entry in celery_app.conf.beat_schedule.values()}
    assert expected in tasks, f"{expected} is no longer scheduled"
