"""
The in-process response cache must not grow without bound.

Entries expire logically, but expiry was only ever ACTED ON in `_get_cached` —
that is, when the very same key is requested a second time. A key never asked
for again was never freed.

The cache key includes a fingerprint of the caller's token, and crew tokens
rotate every 12 hours. So each shift change mints a fresh set of keys across
every cached prefix, and the previous shift's entries — full JSON bodies: PRF
lists, case lists, patient names — stayed resident for the life of the worker
process. Unbounded memory growth, and PHI held far past its TTL.
"""
import time

import pytest

from app.core import response_cache as rc
from app.core.response_cache import ResponseCacheMiddleware


def _middleware() -> ResponseCacheMiddleware:
    # The middleware's own __init__ only needs an app object for super(); the
    # store logic under test never touches it.
    return ResponseCacheMiddleware(app=lambda *a, **k: None)


def _fill(mw: ResponseCacheMiddleware, n: int, ttl: int, prefix: str = "k") -> None:
    for i in range(n):
        mw._set_cached(f"{prefix}{i}", b'{"x":1}', [], ttl,
                       path="/api/cases", auth_fp=f"session-{i}")


def test_expired_entries_are_reclaimed_without_being_re_requested():
    """The leak itself: 12 hours of rotated sessions, none revisited."""
    mw = _middleware()

    # A shift's worth of entries, already past their TTL.
    _fill(mw, 500, ttl=-1, prefix="old")
    assert len(mw._store) > 0

    # The next shift starts writing. Nothing ever re-reads the old keys.
    _fill(mw, rc.SWEEP_EVERY_N_WRITES, ttl=60, prefix="new")

    stale = [k for k in mw._store if k.startswith("old")]
    assert stale == [], (
        f"{len(stale)} expired entries still resident. Nothing re-requests these "
        f"keys, so without a sweep they are held — with their response bodies — "
        f"until the worker restarts."
    )


def test_the_store_is_hard_capped():
    """Even with everything unexpired, the store cannot exceed its bound."""
    mw = _middleware()
    _fill(mw, rc.MAX_ENTRIES + 750, ttl=3600)

    assert len(mw._store) <= rc.MAX_ENTRIES, (
        f"store grew to {len(mw._store)}, past the {rc.MAX_ENTRIES} cap"
    )


def test_eviction_keeps_the_longest_lived_entries():
    """When live entries must be dropped, drop the ones expiring soonest."""
    mw = _middleware()

    mw._set_cached("keep-me", b"{}", [], 3600, path="/api/cases", auth_fp="a")
    # Fill past the cap with entries that expire much sooner.
    for i in range(rc.MAX_ENTRIES + 100):
        mw._set_cached(f"short{i}", b"{}", [], 5, path="/api/cases", auth_fp="b")

    assert len(mw._store) <= rc.MAX_ENTRIES
    assert "keep-me" in mw._store, (
        "evicted the longest-lived entry while keeping ones about to expire"
    )


def test_a_live_entry_is_still_served():
    """Bounding must not break the cache's actual job."""
    mw = _middleware()
    mw._set_cached("live", b'{"hello":1}', [], 60, path="/api/cases", auth_fp="a")

    entry = mw._get_cached("live")
    assert entry is not None and entry["body"] == b'{"hello":1}'


def test_an_expired_entry_is_never_served():
    mw = _middleware()
    mw._set_cached("dead", b"{}", [], 60, path="/api/cases", auth_fp="a")
    mw._store["dead"]["expires"] = time.monotonic() - 1

    assert mw._get_cached("dead") is None
