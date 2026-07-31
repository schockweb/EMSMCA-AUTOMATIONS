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
async def test_invalidate_prf_still_busts_list_caches(fake_redis):
    """Pre-existing behaviour that must not be lost."""
    await cache_module.invalidate_prf(PRF_ID)
    assert "prf:list:*" in fake_redis["patterns"]


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
