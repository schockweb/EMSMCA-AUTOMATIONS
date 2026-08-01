"""
Publishing to a REAL broker must not be rejected.

THE OUTAGE THIS REPRODUCES (2026-08-01)
---------------------------------------
Crews could not submit a PRF. Every publish came back:

    Queue.declare: (406) PRECONDITION_FAILED - inequivalent arg
    'x-dead-letter-exchange' for queue 'ems_default': received none but
    current is the value 'ems_dlx'

The publish had been moved onto a worker thread so it would stop blocking the
event loop. That was right, but Celery resolves `current_app` PER THREAD, so
the offloaded call fell back to Celery's default app — which knows the broker
URL from the environment and connects happily, but does NOT know `task_queues`.
It therefore tried to declare an EXISTING queue without the dead-letter
arguments it was created with, and RabbitMQ refused.

WHY THIS FILE EXISTS ALONGSIDE test_celery_publish_binding.py
-------------------------------------------------------------
That file asserts the BINDING — which app a thread resolves — and needs no
broker, so it runs everywhere. It is the precise guard for the known defect.

This one asserts the OUTCOME: that a publish through the real code path is
actually accepted by a real RabbitMQ holding pre-existing queues. It is the
only thing here that can catch a *new* argument mismatch — someone editing
`task_queues`, adding a TTL or a max-length, or changing the dead-letter
routing key — against queues already live in production. An in-memory
transport cannot: it accepts anything.

IT MUST NOT BE ALLOWED TO SILENTLY VANISH
-----------------------------------------
Skipping when no broker is present is right for a laptop and lethal in CI: a
suite that quietly skips its only real-broker test looks exactly like one that
passes it. So CI sets EMS_TESTS_REQUIRE_BROKER=1, and under that flag an
absent or unreachable broker is a FAILURE.
"""
import os
import uuid

import pytest

from app.tasks.celery_app import celery_app

pytestmark = pytest.mark.asyncio

_REQUIRE_BROKER = os.getenv("EMS_TESTS_REQUIRE_BROKER") == "1"

# The queues the app routes to, with the arguments they must be declared with.
_ROUTED_QUEUES = ("ems_default", "ems_critical", "ems_batch")


def _broker_url() -> str:
    return str(celery_app.conf.broker_url or "")


def _is_real_broker() -> bool:
    """An in-memory or filesystem transport proves nothing here."""
    return _broker_url().startswith(("amqp://", "amqps://", "pyamqp://"))


def _skip_or_fail(reason: str):
    if _REQUIRE_BROKER:
        pytest.fail(
            f"EMS_TESTS_REQUIRE_BROKER=1 but {reason}. This is the only test that "
            f"exercises a real queue declaration — the 2026-08-01 submit outage was "
            f"invisible to every other test. Fix the broker; do not disable this."
        )
    pytest.skip(f"{reason} — set EMS_TESTS_REQUIRE_BROKER=1 in CI to make this fatal")


@pytest.fixture(scope="module")
def live_broker():
    """A connection to a real broker, with the app's queues already declared.

    Declaring them FIRST is the whole point: a 406 only happens against a queue
    that already exists. The original local reproduction of this bug published
    to a queue RabbitMQ had never seen, where declaring with wrong arguments
    simply succeeds — which is why it looked fine.
    """
    if not _is_real_broker():
        _skip_or_fail(f"broker is {_broker_url() or '(unset)'}, not a real AMQP broker")

    try:
        with celery_app.connection_for_write() as conn:
            conn.ensure_connection(max_retries=3, timeout=5)
            channel = conn.channel()
            for queue in celery_app.conf.task_queues:
                queue(channel).declare()
            yield conn
    except pytest.skip.Exception:
        raise
    except Exception as exc:  # noqa: BLE001 — any connection failure is the point
        _skip_or_fail(f"could not reach the broker at {_broker_url()}: {exc!r}")


async def test_publish_from_a_worker_thread_is_accepted(live_broker):
    """The exact failing operation: an offloaded publish onto a live queue.

    `publish_task` runs `apply_async` in a thread (so a hung broker cannot
    freeze the event loop) and calls `celery_app.set_current()` there. Remove
    that call and this raises 406 PRECONDITION_FAILED — which is what crews saw.
    """
    from app.tasks.prf_processing import process_prf_submission
    from app.tasks.publish import publish_task

    # A PRF id that cannot exist. If anything ever consumes this, the task's
    # first action is a lookup that returns {"error": "prf_not_found"}.
    result = await publish_task(
        process_prf_submission,
        args=[str(uuid.uuid4())],
        queue="ems_default",
    )
    assert result is not None, "apply_async returned nothing"


async def test_every_routed_queue_declares_with_the_configured_arguments(live_broker):
    """Re-declaring each queue with the app's own config must be idempotent.

    This is what breaks when someone edits `task_queues` — adds a TTL, renames
    the dead-letter routing key — while production queues already exist with
    the old arguments. RabbitMQ answers 406 and every publish to that queue
    fails from the moment the change ships.
    """
    configured = {q.name: q for q in celery_app.conf.task_queues}
    missing = [name for name in _ROUTED_QUEUES if name not in configured]
    assert not missing, f"routed queues absent from task_queues: {missing}"

    for name in _ROUTED_QUEUES:
        queue = configured[name]
        assert queue.queue_arguments.get("x-dead-letter-exchange") == "ems_dlx", (
            f"{name} would be declared without dead-lettering — a failed task "
            f"would be discarded instead of being kept for review"
        )
        # The declare itself is the assertion: a mismatch raises here.
        with celery_app.connection_for_write() as conn:
            queue(conn.channel()).declare()
