"""
Editing a PRF must invalidate its cached detail response.

The detail cache is written PER CREW MEMBER — digital_prf.py builds the key as
`prf:detail:{prf_id}:crew:{crew.id}` so two crew on the same call get their own
entry. invalidate_prf() deleted the un-suffixed `prf:detail:{prf_id}`, a key
nothing ever writes, so the delete matched zero entries and the detail cache was
never actually invalidated.

A submitted PRF is cached for CACHE_TTL_PRF_SUBMITTED_SECONDS (3600), so an edit
could keep serving the pre-edit clinical record for a full hour. That is a
correctness problem with patient data, not a performance one.
"""
import pytest

import app.cache as cache_module


@pytest.fixture
def fake_redis(monkeypatch):
    """Record what invalidate_prf actually asks Redis to delete.

    The real Redis is absent in the isolated test environment (cache.py degrades
    to a no-op), which is precisely why this bug survived — so the calls are
    captured at the module boundary instead.
    """
    deleted_keys: list[str] = []
    deleted_patterns: list[str] = []

    async def fake_delete_cache(key: str) -> None:
        deleted_keys.append(key)

    async def fake_delete_pattern(pattern: str) -> int:
        deleted_patterns.append(pattern)
        return 0

    monkeypatch.setattr(cache_module, "delete_cache", fake_delete_cache)
    monkeypatch.setattr(cache_module, "delete_cache_pattern", fake_delete_pattern)
    return {"keys": deleted_keys, "patterns": deleted_patterns}


PRF_ID = "11111111-2222-3333-4444-555555555555"
CREW_ID = "99999999-8888-7777-6666-555555555555"


@pytest.mark.asyncio
async def test_invalidate_prf_covers_the_crew_suffixed_detail_key(fake_redis):
    """The regression itself."""
    await cache_module.invalidate_prf(PRF_ID)

    written_key = f"prf:detail:{PRF_ID}:crew:{CREW_ID}"
    covered = any(
        p.rstrip("*") and written_key.startswith(p.rstrip("*"))
        for p in fake_redis["patterns"]
    ) or written_key in fake_redis["keys"]

    assert covered, (
        f"invalidate_prf did not cover {written_key!r}, the key digital_prf.py "
        f"actually writes. It issued keys={fake_redis['keys']} "
        f"patterns={fake_redis['patterns']}"
    )


@pytest.mark.asyncio
async def test_invalidate_prf_does_not_sweep_the_whole_keyspace(fake_redis):
    """No unscoped wildcard on the autosave path.

    This test previously asserted the OPPOSITE — that invalidate_prf issued
    `prf:list:*` — and so pinned behaviour that was pure waste: nothing in the
    codebase has ever written a `prf:list:` key, so the sweep matched zero
    entries every time while still costing a full pass over the keyspace. On
    the crew autosave path, which is the hottest write in the product.

    A pattern with no owning prefix is the shape to watch for: it makes the
    cost proportional to everything cached on the instance rather than to the
    thing being invalidated.
    """
    await cache_module.invalidate_prf(PRF_ID)

    for pattern in fake_redis["patterns"]:
        prefix = pattern.split("*")[0]
        assert PRF_ID in prefix, (
            f"invalidation pattern {pattern!r} is not anchored to this PRF — it "
            f"walks keys belonging to every other record on the instance"
        )


@pytest.mark.asyncio
async def test_invalidation_is_scoped_to_this_prf(fake_redis):
    """It must not wipe every PRF's detail cache on one edit."""
    await cache_module.invalidate_prf(PRF_ID)
    for p in fake_redis["patterns"]:
        if p.startswith("prf:detail:"):
            assert PRF_ID in p, (
                f"detail invalidation pattern {p!r} is not scoped to this PRF — "
                f"one edit would flush every cached PRF on the instance"
            )


class _FakeRedis:
    """A Redis that refuses the blocking command.

    `KEYS` walks the entire keyspace in one pass and Redis is single-threaded,
    so every other client — including session lookups on the request path —
    stalls for its duration. Raising here means any return to KEYS fails the
    test rather than quietly degrading production under load.
    """

    def __init__(self, keyspace: list[str]):
        self.keyspace = keyspace
        self.unlinked: list[str] = []
        self.scan_calls = 0

    async def keys(self, pattern):  # noqa: ARG002
        raise AssertionError(
            "delete_cache_pattern used KEYS. It runs on every PRF autosave; "
            "use SCAN so Redis is not blocked for the length of the keyspace."
        )

    async def scan_iter(self, match=None, count=None):  # noqa: ARG002
        self.scan_calls += 1
        prefix = (match or "*").split("*")[0]
        for key in list(self.keyspace):
            if key.startswith(prefix):
                yield key

    async def unlink(self, *keys):
        self.unlinked.extend(keys)
        return len(keys)


@pytest.mark.asyncio
async def test_pattern_delete_scans_instead_of_blocking_redis(monkeypatch):
    fake = _FakeRedis([
        f"prf:detail:{PRF_ID}:crew:{CREW_ID}",
        f"prf:detail:{PRF_ID}:crew:other",
        "prf:detail:some-other-prf:crew:x",
        "provider:abc",
    ])

    async def _fake_get_redis():
        return fake

    monkeypatch.setattr(cache_module, "_get_redis", _fake_get_redis)

    deleted = await cache_module.delete_cache_pattern(f"prf:detail:{PRF_ID}:*")

    assert fake.scan_calls == 1, "expected a single SCAN traversal"
    assert deleted == 2, f"expected the 2 matching keys, got {deleted}"
    assert sorted(fake.unlinked) == sorted([
        f"prf:detail:{PRF_ID}:crew:{CREW_ID}",
        f"prf:detail:{PRF_ID}:crew:other",
    ]), f"deleted the wrong keys: {fake.unlinked}"


@pytest.mark.asyncio
async def test_pattern_delete_batches_rather_than_deleting_one_at_a_time(monkeypatch):
    """A large match must not become one round-trip per key."""
    keys = [f"prf:detail:{PRF_ID}:crew:{i}" for i in range(1200)]
    fake = _FakeRedis(keys)
    calls = {"n": 0}

    original_unlink = fake.unlink

    async def counting_unlink(*batch):
        calls["n"] += 1
        return await original_unlink(*batch)

    fake.unlink = counting_unlink

    async def _fake_get_redis():
        return fake

    monkeypatch.setattr(cache_module, "_get_redis", _fake_get_redis)

    deleted = await cache_module.delete_cache_pattern(f"prf:detail:{PRF_ID}:*")

    assert deleted == 1200
    # 1200 keys at a 500 batch size = 3 calls. Anything near 1200 means the
    # batching is gone; 1 means a single unbounded command was issued.
    assert 2 <= calls["n"] <= 5, f"expected a handful of batched deletes, got {calls['n']}"


def test_the_write_key_shape_still_matches_what_we_invalidate():
    """Pin the coupling.

    The two live in different modules, which is how they drifted apart. If the
    key shape in digital_prf.py changes again, this fails instead of silently
    disabling invalidation.
    """
    import inspect
    import app.api.digital_prf as dp

    src = inspect.getsource(dp)
    assert 'f"prf:detail:{prf_id}:crew:{crew.id}"' in src, (
        "the PRF detail cache key shape changed; update invalidate_prf in "
        "app/cache.py to match, or invalidation silently stops working"
    )
