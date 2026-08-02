"""
Publishing a Celery task from an async request handler, safely.

TWO CONSTRAINTS THAT FIGHT EACH OTHER
-------------------------------------
1. `apply_async` / `delay` are kombu's SYNCHRONOUS publisher. Called bare inside
   `async def` they block the uvicorn event loop, stalling every concurrent
   request — RabbitMQ's failure mode under a memory or disk alarm is to accept
   the connection and HANG, which was measured at 4.09s of total freeze. So the
   publish has to leave the event loop.

2. Celery resolves `current_app` from a THREAD-LOCAL. The
   `import app.tasks.celery_app` at the top of each task module sets it for the
   thread that runs the import — the main thread. Move the publish to a worker
   thread and that thread-local is empty, so Celery silently falls back to its
   default app. That app knows the broker URL from the environment but NOT our
   `task_queues`, so it declares `ems_default` WITHOUT the dead-letter arguments
   the real queue was created with, and RabbitMQ rejects it:

       406 PRECONDITION_FAILED - inequivalent arg 'x-dead-letter-exchange'
       for queue 'ems_default': received none but current is 'ems_dlx'

   Which surfaces to a paramedic as "Could not queue PRF for processing."

Satisfying (1) by itself breaks (2). This helper satisfies both: it re-binds the
configured app inside the worker thread before publishing.

Always publish through here from async code. Never call `.delay()` or
`.apply_async()` directly in an `async def` — tests/test_no_blocking_in_async.py
enforces the first half of that, and this module is what makes the fix correct
rather than merely non-blocking.
"""
from __future__ import annotations

import asyncio
import functools
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from app.tasks.celery_app import celery_app


def _publish_sync(task: Any, *args: Any, **kwargs: Any) -> Any:
    """Bind the configured app to THIS thread, then publish.

    `set_current()` writes the app into Celery's thread-local state. Without it
    a worker thread publishes via the fallback default app and the queue declare
    is rejected — see the module docstring.
    """
    celery_app.set_current()
    return task.apply_async(*args, **kwargs)


# Hard ceiling on a single publish.
#
# Offloading to a thread stops a hung broker freezing the event loop, but the
# THREAD still blocks — indefinitely, because kombu's socket has no read timeout
# of its own. RabbitMQ's real failure mode under a memory or disk alarm is to
# accept the connection and then never answer.
#
# 10s is well beyond a healthy publish (single-digit milliseconds) and well
# inside the crew's patience. On timeout the caller sees an ordinary exception,
# which every call site already handles: the submit path reverts
# SUBMITTED -> DRAFT and returns an actionable 503 rather than stranding the PRF.
PUBLISH_TIMEOUT_SECONDS = 10

# A DEDICATED pool, not asyncio.to_thread's.
#
# `asyncio.to_thread` uses the interpreter's DEFAULT executor, shared by every
# other to_thread caller in the process — including bcrypt password hashing on
# the login path. asyncio.wait_for below unblocks the CALLER on timeout, but it
# cannot cancel a thread that is blocked in a socket read: that thread stays
# parked until the OS gives up. So a broker alarm would slowly consume the
# shared executor and logins would stop working across the instance, for a fault
# that has nothing to do with logging in.
#
# Giving publishes their own small pool contains the damage: a wedged broker can
# exhaust only this pool, and every other offloaded operation is unaffected.
# Bounding the broker's own socket instead was tried and reverted — read_timeout
# applies to the persistent AMQP connection and broke normal publishing (see the
# note in celery_app.py).
_PUBLISH_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="celery-publish")


async def _offload(fn, *args, **kwargs):
    loop = asyncio.get_running_loop()
    return await asyncio.wait_for(
        loop.run_in_executor(_PUBLISH_POOL, functools.partial(fn, *args, **kwargs)),
        timeout=PUBLISH_TIMEOUT_SECONDS,
    )


async def publish_task(task: Any, *args: Any, **kwargs: Any) -> Any:
    """Publish a Celery task without blocking the event loop, with a deadline.

    Mirrors `task.apply_async(...)`: pass `args=[...]` and `queue="..."` exactly
    as you would to apply_async.

    Exceptions propagate unchanged, because every caller already handles a
    failed enqueue deliberately — the PRF submit path reverts SUBMITTED -> DRAFT
    and returns 503 so the crew can retry, rather than stranding the record.
    `asyncio.TimeoutError` is an ordinary Exception, so those handlers cover a
    timeout too without needing to know about it.
    """
    return await _offload(_publish_sync, task, *args, **kwargs)


async def publish_delay(task: Any, *args: Any) -> Any:
    """Equivalent of `task.delay(*args)`, off the event loop and app-bound."""
    return await _offload(_publish_sync, task, args=list(args))
