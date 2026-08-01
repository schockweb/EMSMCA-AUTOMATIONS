"""
A publish offloaded to a thread must still use OUR Celery app.

THE INCIDENT THIS GUARDS (2026-08-01)
-------------------------------------
Crews could not submit: "Could not queue PRF for processing." The broker was
healthy and the queue arguments were correct on both sides, but every publish
was rejected:

    Queue.declare: (406) PRECONDITION_FAILED - inequivalent arg
    'x-dead-letter-exchange' for queue 'ems_default': received none but
    current is the value 'ems_dlx'

Moving the publish onto a worker thread (to stop it blocking the event loop)
was correct, but Celery resolves `current_app` PER THREAD. The
`import app.tasks.celery_app` at the top of each task module binds only the
thread that runs the import. Measured inside the production container:

    main thread         -> ('ems_claims', task_queues=True)
    to_thread worker    -> ('default',    task_queues=False)   <-- the bug
    after set_current() -> ('ems_claims', task_queues=True)    <-- the fix

The fallback app knows the broker URL from the environment, so it connects
happily — it just does not know `task_queues`, so it declares the queue without
the dead-letter arguments the live queue was created with.

WHY EXISTING TESTS DID NOT CATCH IT
-----------------------------------
* test_no_blocking_in_async.py checks the SHAPE (no bare publish in an async
  handler). It cannot see which app the offloaded call resolves.
* The isolated test environment has no broker, so the four submit-path tests
  were already failing on DNS and could not reach a queue declare.
* The local reproduction published to `ems_batch`, which does not exist in
  RabbitMQ — declaring a NEW queue with default arguments succeeds. Only an
  EXISTING queue conflicts.

These assertions need no broker: they check the binding, which is the actual
defect, rather than the publish, which is what happened to fail.
"""
import asyncio

import pytest

from app.tasks.celery_app import celery_app
from app.tasks.publish import _publish_sync, publish_task, publish_delay


def _app_seen_in_this_thread():
    from celery import current_app
    return current_app.main, bool(current_app.conf.task_queues)


@pytest.mark.asyncio
async def test_a_bare_thread_really_does_lose_our_app():
    """Characterise the trap itself, so the guard below cannot be vacuous.

    If this ever fails, Celery has started resolving `current_app` correctly in
    a fresh thread and the set_current() workaround can be removed — which is
    worth knowing, rather than carrying the workaround forever with nobody
    remembering why.
    """
    name, has_queues = await asyncio.to_thread(_app_seen_in_this_thread)

    assert (name, has_queues) == ('default', False), (
        f"expected a bare worker thread to resolve Celery's fallback app, got "
        f"{name!r}/task_queues={has_queues}. If Celery fixed this, delete the "
        f"set_current() call in app/tasks/publish.py and this test with it."
    )


@pytest.mark.asyncio
async def test_publish_task_binds_our_app_where_the_publish_ACTUALLY_runs():
    """THE regression guard for the 2026-08-01 incident.

    The observer records which app is current at the moment apply_async is
    called — inside the worker thread, through the real publish_task path.
    Remove set_current() from _publish_sync and this sees ('default', False),
    which is precisely the state that produced the 406 in production.

    An earlier version of this file called _publish_sync directly from the MAIN
    thread, where the app is already bound, so deleting the fix changed nothing
    and every test still passed. The thread is the whole point.
    """
    seen = {}

    class AppObserver:
        def apply_async(self, *a, **k):
            from celery import current_app
            seen['app'] = current_app.main
            seen['task_queues'] = bool(current_app.conf.task_queues)
            return 'task-id'

    result = await publish_task(AppObserver(), args=['x'], queue='ems_default')

    assert result == 'task-id'
    assert seen.get('app') == celery_app.main, (
        f"the publish ran under Celery app {seen.get('app')!r}, not "
        f"{celery_app.main!r}. That app does not know task_queues, so it "
        f"declares ems_default WITHOUT the dead-letter arguments the live queue "
        f"was created with, and RabbitMQ rejects it: 406 PRECONDITION_FAILED."
    )
    assert seen.get('task_queues') is True


@pytest.mark.asyncio
async def test_publish_delay_binds_the_app_too():
    """The other entry point — same failure mode if it skips the binding."""
    seen = {}

    class AppObserver:
        def apply_async(self, *a, **k):
            from celery import current_app
            seen['app'] = current_app.main
            return 'ok'

    await publish_delay(AppObserver(), 'arg-one')

    assert seen.get('app') == celery_app.main


@pytest.mark.asyncio
async def test_publish_task_passes_arguments_through_unchanged():
    """Signature compatibility with apply_async — a silently dropped queue= would
    route every task to the default queue."""
    seen = {}

    class FakeTask:
        def apply_async(self, *a, **k):
            seen.update(k)
            seen['positional'] = a
            return 'ok'

    await publish_task(FakeTask(), args=['abc'], queue='ems_critical')

    assert seen['args'] == ['abc']
    assert seen['queue'] == 'ems_critical', "the queue argument was lost"


@pytest.mark.asyncio
async def test_publish_delay_maps_positional_args_to_args_list():
    seen = {}

    class FakeTask:
        def apply_async(self, *a, **k):
            seen.update(k)
            return 'ok'

    await publish_delay(FakeTask(), 'one', 'two')

    assert seen['args'] == ['one', 'two'], (
        "publish_delay must mirror task.delay(a, b) -> apply_async(args=[a, b])"
    )


@pytest.mark.asyncio
async def test_publish_failures_propagate():
    """Every caller handles a failed enqueue deliberately — the submit path
    reverts SUBMITTED -> DRAFT and returns 503. Swallowing the error here would
    strand the PRF in SUBMITTED with no task ever running."""
    class Boom:
        def apply_async(self, *a, **k):
            raise RuntimeError("broker unreachable")

    with pytest.raises(RuntimeError, match="broker unreachable"):
        await publish_task(Boom(), args=['x'], queue='ems_default')


def test_the_configured_app_declares_the_dead_letter_arguments():
    """Pin what the fallback app was missing.

    If task_queues ever loses these, publishes start being rejected by the live
    queue again — with the same opaque 406.
    """
    queues = {q.name: dict(q.queue_arguments or {}) for q in celery_app.conf.task_queues}

    for name in ("ems_default", "ems_critical", "ems_batch"):
        assert name in queues, f"{name} is no longer declared in task_queues"
        assert queues[name].get("x-dead-letter-exchange") == "ems_dlx", (
            f"{name} lost its dead-letter exchange; the live RabbitMQ queue has "
            f"it, so declares will be rejected with 406 PRECONDITION_FAILED"
        )
