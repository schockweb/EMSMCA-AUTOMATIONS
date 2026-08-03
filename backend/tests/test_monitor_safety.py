"""
The rules that decide what the platform is allowed to do to itself, unattended.

This is the highest-consequence code in the monitoring system. A bug in a probe
means a missed alert; a bug HERE means the platform takes an action nobody
sanctioned against a database of patient records. So the safety gate is tested
as a truth table rather than by example, and every gate is verified to be load-
bearing on its own — a gate that is redundant today is one somebody deletes.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.models.system_fault import FaultSeverity, FaultStatus, SystemFault
from app.services.monitor.registry import (
    Probe, ProbeResult, Remedy, RemedyResult, static_auto_eligibility,
)

pytestmark = pytest.mark.asyncio


async def _noop() -> RemedyResult:
    return RemedyResult(ok=True, detail="did nothing")


def _remedy(**over) -> Remedy:
    base = dict(
        key="r", description="d", run=_noop,
        touches_patient_data=False, idempotent=True, destructive=False,
        blast_radius="one background worker",
    )
    base.update(over)
    return Remedy(**base)


def _probe(**over) -> Probe:
    base = dict(
        key="p", title="t", severity=FaultSeverity.HIGH,
        check=lambda: None, rationale="r", deterministic=True, remedy=_remedy(),
    )
    base.update(over)
    return Probe(**base)


# ════════════════════════════════════════════════════════════════════
# The truth table
# ════════════════════════════════════════════════════════════════════

def test_the_only_fully_safe_combination_is_eligible():
    ok, reason = static_auto_eligibility(_probe())
    assert ok is True
    assert "blast radius" in reason.lower()


@pytest.mark.parametrize("field,value,must_mention", [
    ("touches_patient_data", True, "patient"),
    ("destructive", True, "cannot be undone"),
    ("idempotent", False, "idempotent"),
])
def test_each_remedy_property_alone_blocks_automation(field, value, must_mention):
    """Every gate is load-bearing on its own.

    Parameterised deliberately: if a refactor makes one of these redundant, this
    test goes red rather than the gate silently ceasing to matter.
    """
    ok, reason = static_auto_eligibility(_probe(remedy=_remedy(**{field: value})))
    assert ok is False, f"{field}={value} did not block unattended execution"
    assert must_mention in reason.lower()


def test_a_statistical_probe_never_triggers_an_action():
    """The gate people leave out.

    A remedy can be perfectly safe and still be the wrong thing to do, because
    the DETECTION was an inference. "PHI reads are 5x baseline" is a real signal
    and is also true the Monday after a public holiday.
    """
    ok, reason = static_auto_eligibility(_probe(deterministic=False))
    assert ok is False
    assert "statistical" in reason.lower()


def test_no_remedy_means_no_automation():
    ok, reason = static_auto_eligibility(_probe(remedy=None))
    assert ok is False
    assert "no automatic remedy" in reason.lower()


def test_patient_data_gate_cannot_be_outvoted():
    """There is no combination of other virtues that unlocks patient data.

    The intended failure this guards against is a future refactor turning the
    gates into a score — at which point "idempotent and non-destructive and
    tiny blast radius" would outweigh "touches patient records", which is
    exactly the reasoning that must never be available.
    """
    ok, _ = static_auto_eligibility(_probe(remedy=_remedy(
        touches_patient_data=True, idempotent=True, destructive=False,
        blast_radius="a single row",
    )))
    assert ok is False


# ════════════════════════════════════════════════════════════════════
# Runtime gates
# ════════════════════════════════════════════════════════════════════

def _fault(**over) -> SystemFault:
    base = dict(
        fault_key="p", title="t", severity=FaultSeverity.HIGH,
        status=FaultStatus.DETECTED, attempts=0, occurrences=1,
        first_seen_at=datetime.now(timezone.utc),
        last_seen_at=datetime.now(timezone.utc),
    )
    base.update(over)
    return SystemFault(**base)


class _FakeDB:
    """Just enough session for _decide: it only ever counts prior auto-heals."""

    def __init__(self, recent_heals: int = 0):
        self._n = recent_heals

    async def execute(self, *_a, **_k):
        rows = [object()] * self._n

        class R:
            def scalars(self_inner):
                class S:
                    def all(s2):
                        return rows
                return S()
        return R()


async def test_attempt_cap_stops_pointless_retrying(monkeypatch):
    from app.services.monitor import engine
    monkeypatch.setattr(engine, "_auto_heal_enabled", lambda: True)

    probe = _probe(remedy=_remedy(max_attempts=3))
    run_it, reason = await engine._decide(_FakeDB(), probe, _fault(attempts=3))
    assert run_it is False
    assert "already been attempted" in reason


async def test_cooldown_blocks_an_immediate_second_run(monkeypatch):
    from app.services.monitor import engine
    monkeypatch.setattr(engine, "_auto_heal_enabled", lambda: True)

    probe = _probe(remedy=_remedy(cooldown_minutes=15))
    fault = _fault(last_attempt_at=datetime.now(timezone.utc) - timedelta(minutes=2))
    run_it, reason = await engine._decide(_FakeDB(), probe, fault)
    assert run_it is False
    assert "cooling off" in reason.lower()


async def test_cooldown_expires(monkeypatch):
    from app.services.monitor import engine
    monkeypatch.setattr(engine, "_auto_heal_enabled", lambda: True)

    probe = _probe(remedy=_remedy(cooldown_minutes=15))
    fault = _fault(last_attempt_at=datetime.now(timezone.utc) - timedelta(minutes=30))
    run_it, _ = await engine._decide(_FakeDB(), probe, fault)
    assert run_it is True


async def test_a_repeatedly_successful_repair_is_treated_as_a_failure(monkeypatch):
    """The counter-intuitive rule, and the one that matters most.

    A remedy that keeps SUCCEEDING on a condition that keeps RETURNING has not
    fixed anything — it is holding the system in a degraded state where the real
    cause never gets looked at, and for some faults (a consumer dying on a
    poison message) the repair is what causes the recurrence. So repeated
    success escalates to a human, which is the opposite of what a naive
    implementation does.
    """
    from app.services.monitor import engine
    monkeypatch.setattr(engine, "_auto_heal_enabled", lambda: True)

    probe = _probe(remedy=_remedy(flap_limit=3, flap_window_hours=6))
    run_it, reason = await engine._decide(_FakeDB(recent_heals=3), probe, _fault())
    assert run_it is False
    assert "keeps returning" in reason
    assert "masking" in reason


async def test_below_the_flap_limit_still_heals(monkeypatch):
    from app.services.monitor import engine
    monkeypatch.setattr(engine, "_auto_heal_enabled", lambda: True)

    probe = _probe(remedy=_remedy(flap_limit=3))
    run_it, _ = await engine._decide(_FakeDB(recent_heals=2), probe, _fault())
    assert run_it is True


async def test_kill_switch_defaults_to_off_and_stops_everything(monkeypatch):
    """Unattended repair must be opt-IN.

    A monitoring system that starts acting on production the moment it is
    deployed, before anyone has watched what it would have done, is not
    something to ship into a platform holding clinical records.
    """
    from app.config import get_settings
    from app.services.monitor import engine

    assert getattr(get_settings(), "MONITOR_AUTO_HEAL_ENABLED", False) is False, \
        "unattended self-healing must default to OFF"

    run_it, reason = await engine._decide(_FakeDB(), _probe(), _fault())
    assert run_it is False
    assert "switched off" in reason


# ════════════════════════════════════════════════════════════════════
# Verification after the fix
# ════════════════════════════════════════════════════════════════════

async def test_a_remedy_that_lies_about_success_is_not_recorded_as_healed():
    """"The remedy returned ok" and "the fault is gone" are different claims.

    Only the second is worth recording. Without the re-probe, a remedy with a
    bug that always returns success would clear every fault it touched and the
    dashboard would go green while nothing worked.
    """
    from app.services.monitor import engine

    async def still_broken():
        return ProbeResult.faulty(reason="unchanged")

    probe = _probe(check=still_broken, remedy=_remedy(
        run=lambda: _noop(),
    ))
    fault = _fault()
    await engine._run_remedy(_FakeDB(), probe, fault)

    assert fault.status == FaultStatus.REMEDY_FAILED
    assert "still failing" in (fault.outcome or "")
    assert fault.attempts == 1


async def test_a_genuinely_fixed_fault_is_recorded_as_healed():
    from app.services.monitor import engine

    async def now_fine():
        return ProbeResult.healthy()

    probe = _probe(check=now_fine)
    fault = _fault()
    await engine._run_remedy(_FakeDB(), probe, fault)

    assert fault.status == FaultStatus.AUTO_HEALED
    assert fault.resolved_at is not None


async def test_a_remedy_that_raises_is_caught_and_reported():
    """A crashing repair must not take the monitoring loop down with it."""
    from app.services.monitor import engine

    async def boom():
        raise RuntimeError("could not reach the broker")

    probe = _probe(remedy=_remedy(run=boom))
    fault = _fault()
    await engine._run_remedy(_FakeDB(), probe, fault)

    assert fault.status == FaultStatus.REMEDY_FAILED
    assert "could not reach the broker" in (fault.outcome or "")


async def test_an_inconclusive_recheck_is_not_treated_as_success():
    """A probe that cannot tell must not be read as "fixed".

    Inconclusive means the broker was unreachable, or the check itself could not
    run. Counting that as a pass is how a system reports itself healthy during
    precisely the outage it exists to catch.
    """
    from app.services.monitor import engine

    async def cannot_tell():
        return ProbeResult.unknown(reason="broker unreachable")

    probe = _probe(check=cannot_tell)
    fault = _fault()
    await engine._run_remedy(_FakeDB(), probe, fault)

    assert fault.status == FaultStatus.REMEDY_FAILED


# ════════════════════════════════════════════════════════════════════
# Probe correctness — the false positives found on the first live run
# ════════════════════════════════════════════════════════════════════

async def test_task_registration_probe_does_not_false_positive_outside_the_worker():
    """The first end-to-end sweep raised a CRITICAL about a healthy system.

    A worker imports everything in Celery's `include` list at startup, but the
    sweep can also be triggered from the API process where those modules have
    never been imported — so comparing beat_schedule against `celery_app.tasks`
    reported every scheduled task as unregistered.

    A monitoring system that cries wolf gets muted, and a muted monitor is worse
    than none because it still looks like coverage.
    """
    import app.services.monitor.probes  # noqa: F401  — registers
    from app.services.monitor.registry import get_probe

    probe = get_probe("scheduled_task_not_registered")
    result = await probe.check()
    assert result.ok, (
        f"the task-registration probe reports a fault on a healthy build: "
        f"{result.evidence}"
    )


async def test_task_registration_probe_still_catches_a_real_omission(monkeypatch):
    """...and the fix must not have made it vacuous."""
    import app.services.monitor.probes  # noqa: F401
    from app.services.monitor.registry import get_probe
    from app.tasks.celery_app import celery_app

    schedule = dict(celery_app.conf.beat_schedule or {})
    schedule["ghost-job"] = {"task": "a_task_no_worker_has_ever_registered",
                             "schedule": 60.0}
    monkeypatch.setattr(celery_app.conf, "beat_schedule", schedule)

    result = await get_probe("scheduled_task_not_registered").check()
    assert not result.ok, "an unregistered scheduled task was not detected"
    assert "a_task_no_worker_has_ever_registered" in str(result.evidence)


async def test_a_statistical_probe_is_declared_as_such():
    """phi_read_volume_spike must never be able to trigger an action.

    It is the one probe here whose detection is an inference, and the safety
    gate keys off the `deterministic` flag — so the flag being right is what
    keeps a busy Monday morning from triggering an automated response.
    """
    import app.services.monitor.probes  # noqa: F401
    from app.services.monitor.registry import get_probe, static_auto_eligibility

    probe = get_probe("phi_read_volume_spike")
    assert probe.deterministic is False
    ok, reason = static_auto_eligibility(probe)
    assert ok is False
    assert "statistical" in reason.lower() or "no automatic remedy" in reason.lower()


async def test_no_probe_offers_an_unattended_fix_that_touches_patient_data():
    """The invariant, asserted across the whole catalogue at once.

    Any future probe that declares an auto-safe remedy touching clinical data
    fails here rather than in production.
    """
    import app.services.monitor.probes  # noqa: F401
    from app.services.monitor.registry import all_probes, static_auto_eligibility

    offenders = [
        p.key for p in all_probes()
        if static_auto_eligibility(p)[0] and p.remedy and p.remedy.touches_patient_data
    ]
    assert not offenders, f"these would act on patient data unattended: {offenders}"


async def test_a_probe_error_clears_once_the_probe_runs_again():
    """Stale probe-error rows must not accumulate.

    A failing probe raises a fault keyed "probe_error::<key>". That is not a
    registered probe key, so nothing in the normal clear path ever matched it —
    the row survived the fix forever. A queue that fills with stale CRITICALs
    teaches the operator to ignore the queue, which costs more than the missing
    check did.
    """
    from app.models.system_fault import FaultStatus
    from app.services.monitor import engine

    cleared = {}

    class _Fault:
        def __init__(self, key):
            self.fault_key = key
            self.status = FaultStatus.AWAITING_APPROVAL
            self.resolved_at = None
            self.outcome = None
            self.occurrences = 1
            self.last_seen_at = None

    stale = _Fault("probe_error::p")

    async def fake_open_fault(_db, key):
        return stale if key == "probe_error::p" else None

    async def healthy():
        return ProbeResult.healthy()

    probe = _probe(check=healthy)

    class _DB:
        async def commit(self): pass

    monkey_probe = [probe]
    orig_all, orig_open = engine.all_probes, engine._open_fault
    engine.all_probes = lambda: monkey_probe
    engine._open_fault = fake_open_fault
    try:
        await engine.run_sweep(_DB())
    finally:
        engine.all_probes, engine._open_fault = orig_all, orig_open

    assert stale.status == FaultStatus.CLEARED, \
        "the probe recovered but its probe_error fault stayed open forever"
    assert stale.resolved_at is not None


async def test_an_asynchronous_remedy_is_not_reported_as_failed():
    """Found by running the thing rather than reading it.

    `rerun_blacklist_purge` ENQUEUES a task. Re-probing in the same breath sees
    the unchanged condition every time, so a fix that was working perfectly was
    stamped REMEDY_FAILED — which also stops it being retried. "The queued job
    has not finished yet" and "the fix did not work" are different claims.
    """
    from app.models.system_fault import FaultStatus
    from app.services.monitor import engine

    async def still_failing():
        return ProbeResult.faulty(reason="task has not run yet")

    probe = _probe(check=still_failing, remedy=_remedy(
        settle_seconds=0, verification_is_deferred=True,
    ))
    fault = _fault()
    await engine._run_remedy(_FakeDB(), probe, fault)

    assert fault.status == FaultStatus.DETECTED, (
        "an asynchronous fix was recorded as failed before it could take effect"
    )
    assert "asynchronously" in (fault.outcome or "")

    # ...and a SYNCHRONOUS remedy must still be judged immediately.
    sync_fault = _fault()
    await engine._run_remedy(_FakeDB(), _probe(check=still_failing), sync_fault)
    assert sync_fault.status == FaultStatus.REMEDY_FAILED
