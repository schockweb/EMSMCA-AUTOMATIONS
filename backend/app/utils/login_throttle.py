"""
Failed-credential throttling keyed on the SOURCE, not on the account.

WHY THIS EXISTS
---------------
Account-wide lockout is the right control for a personal password and the wrong
one for a SHARED password that gates clinical work.

The company portal password unlocks every crew tablet at an ambulance service,
and `GET /api/providers/public` publishes every active provider slug with no
authentication. Five wrong guesses against a slug locked that entire company out
for 45 minutes: no tablet could be unlocked, so a crew arriving on scene could
not start a shift or create a patient report form. Twenty-five anonymous HTTP
requests did that to five companies, and a loop re-running every 45 minutes kept
all ~105 of them out indefinitely. The control intended to stop an attacker was
the attacker's whole payload.

Removing the lockout is not an option either — it is the only thing between a
shared password and unlimited guessing.

THE SHAPE THAT WORKS
--------------------
Count failures per (credential, source IP) and block THAT PAIR. An attacker
still gets five guesses before their address is shut out of that provider for
the cool-off, so brute force is throttled exactly as before. A crew on a
different connection is unaffected, so the denial of service disappears.

A distributed attacker with many addresses defeats the per-IP block — that is
inherent, and it is why this is not the only control. Password complexity is
enforced on every set (12 characters, mixed classes), nginx caps each address at
10 r/s, the application limiter buckets anonymous callers by trusted IP, and
every failure is written to the audit log with its address so a spread attempt
is visible even when no single address trips the threshold.

STORAGE
-------
Redis when available, a bounded in-process dict otherwise. The fallback exists
so a single-container deployment still throttles; it is per-worker rather than
global, which is weaker but never weaker than having nothing.
"""
from __future__ import annotations

import logging
import time
from typing import Dict, Tuple

logger = logging.getLogger("ems.login_throttle")

MAX_SOURCE_FAILURES = 5
BLOCK_SECONDS = 45 * 60

# Fallback store: {(scope, identity, ip): (failure_count, first_failure_ts)}
_MEM: Dict[Tuple[str, str, str], Tuple[int, float]] = {}
_MEM_MAX = 10_000


def _key(scope: str, identity: str, ip: str) -> str:
    return f"throttle:{scope}:{identity}:{ip}"


def _prune_mem(now: float) -> None:
    """Drop expired entries, and the whole store if it is being flooded.

    An attacker rotating source addresses would otherwise grow this dict without
    bound — a memory-exhaustion vector introduced by the very thing meant to
    contain them.
    """
    expired = [k for k, (_, ts) in _MEM.items() if now - ts > BLOCK_SECONDS]
    for k in expired:
        _MEM.pop(k, None)
    if len(_MEM) > _MEM_MAX:
        _MEM.clear()
        logger.warning("Login throttle memory store flooded — cleared")


async def _redis():
    try:
        from app.cache import _get_redis
        return await _get_redis()
    except Exception:
        return None


async def is_source_blocked(scope: str, identity: str, ip: str) -> bool:
    """True when this source has already burned its attempts on this credential."""
    r = await _redis()
    if r is not None:
        try:
            raw = await r.get(_key(scope, identity, ip))
            return raw is not None and int(raw) >= MAX_SOURCE_FAILURES
        except Exception as exc:
            from app.cache import note_redis_failure
            note_redis_failure()
            logger.debug("throttle read failed, falling back to memory: %s", exc)

    now = time.time()
    _prune_mem(now)
    count, ts = _MEM.get((scope, identity, ip), (0, now))
    if now - ts > BLOCK_SECONDS:
        return False
    return count >= MAX_SOURCE_FAILURES


async def register_source_failure(scope: str, identity: str, ip: str) -> int:
    """Record one failed attempt; returns the running count for this source."""
    r = await _redis()
    if r is not None:
        try:
            key = _key(scope, identity, ip)
            count = await r.incr(key)
            if count == 1:
                await r.expire(key, BLOCK_SECONDS)
            return int(count)
        except Exception as exc:
            from app.cache import note_redis_failure
            note_redis_failure()
            logger.debug("throttle write failed, falling back to memory: %s", exc)

    now = time.time()
    _prune_mem(now)
    count, ts = _MEM.get((scope, identity, ip), (0, now))
    if now - ts > BLOCK_SECONDS:
        count, ts = 0, now
    count += 1
    _MEM[(scope, identity, ip)] = (count, ts)
    return count


async def clear_source_failures(scope: str, identity: str, ip: str) -> None:
    """Forget this source's failures — called on a successful authentication."""
    r = await _redis()
    if r is not None:
        try:
            await r.delete(_key(scope, identity, ip))
        except Exception:
            pass
    _MEM.pop((scope, identity, ip), None)
