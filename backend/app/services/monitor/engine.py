"""
Run every probe, fold the results into faults, and either fix or ask.

THE LOOP
--------
    for each probe:
        result = await probe.check()
        if inconclusive  -> do nothing at all
        if ok            -> close any open fault for this key (CLEARED)
        if not ok        -> fold into one open row, then decide:
                              eligible + within limits -> run the remedy
                              otherwise                -> AWAITING_APPROVAL

A probe raising an exception is itself reported as a fault rather than being
swallowed — a monitoring system that silently stops monitoring is the worst
possible failure, because the absence of alerts reads as health.
"""
from __future__ import annotations

import logging
import traceback
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select

from app.models.system_fault import (
    OPEN_STATUSES, FaultSeverity, FaultStatus, SystemFault,
)
from app.services.monitor.registry import (
    Probe, ProbeResult, all_probes, static_auto_eligibility,
)

logger = logging.getLogger("ems.monitor")


def _auto_heal_enabled() -> bool:
    """Global kill switch.

    Deliberately read fresh on every sweep rather than cached at import: the
    moment an operator wants unattended repair OFF is the moment something is
    going wrong, and that must not require a deploy to take effect.
    """
    from app.config import get_settings
    return bool(getattr(get_settings(), "MONITOR_AUTO_HEAL_ENABLED", False))


async def _open_fault(db, key: str) -> Optional[SystemFault]:
    return (await db.execute(
        select(SystemFault)
        .where(SystemFault.fault_key == key, SystemFault.status.in_(OPEN_STATUSES))
        .order_by(SystemFault.first_seen_at.desc())
        .limit(1)
    )).scalar_one_or_none()


async def _recent_auto_heals(db, key: str, hours: int) -> int:
    """How many times this exact condition has been auto-healed recently.

    This is the flap detector. A condition that keeps coming back after a
    successful repair does not have a working remedy — it has a remedy that
    masks it. Counting them is what turns "self-healing" from a way to hide
    problems into a way to surface the ones that need a person.
    """
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows = (await db.execute(
        select(SystemFault).where(
            SystemFault.fault_key == key,
            SystemFault.status == FaultStatus.AUTO_HEALED,
            SystemFault.resolved_at >= since,
        )
    )).scalars().all()
    return len(rows)


async def _decide(db, probe: Probe, fault: SystemFault) -> tuple[bool, str]:
    """Act now, or wait for a human? Returns (run_it, reason)."""
    eligible, reason = static_auto_eligibility(probe)
    if not eligible:
        return False, reason

    if not _auto_heal_enabled():
        return False, (
            "Unattended repair is switched off (MONITOR_AUTO_HEAL_ENABLED is not "
            "set). The fix below is ready to run on approval."
        )

    r = probe.remedy
    if fault.attempts >= r.max_attempts:
        return False, (
            f"The automatic fix has already been attempted {fault.attempts} times "
            f"without clearing the fault. Further unattended retries would just "
            f"repeat a failure — this needs a person."
        )

    if fault.last_attempt_at is not None:
        elapsed = datetime.now(timezone.utc) - fault.last_attempt_at
        if elapsed < timedelta(minutes=r.cooldown_minutes):
            wait = r.cooldown_minutes - int(elapsed.total_seconds() // 60)
            return False, f"Cooling off — the fix was tried recently ({wait} min remaining)."

    flaps = await _recent_auto_heals(db, probe.key, r.flap_window_hours)
    if flaps >= r.flap_limit:
        return False, (
            f"This fault has been repaired automatically {flaps} times in the last "
            f"{r.flap_window_hours} hours and keeps returning. The repair is "
            f"masking a cause that has not been addressed, so it has been stopped "
            f"and handed to you deliberately."
        )

    return True, reason


async def _run_remedy(db, probe: Probe, fault: SystemFault) -> None:
    """Execute the remedy and record honestly what happened."""
    r = probe.remedy
    fault.attempts += 1
    fault.last_attempt_at = datetime.now(timezone.utc)

    try:
        result = await r.run()
    except Exception as exc:
        logger.exception("Remedy %s raised", r.key)
        fault.status = FaultStatus.REMEDY_FAILED
        fault.outcome = f"The fix raised an error: {type(exc).__name__}: {exc}"[:2000]
        return

    if not result.ok:
        fault.status = FaultStatus.REMEDY_FAILED
        fault.outcome = f"The fix ran but did not succeed: {result.detail}"[:2000]
        return

    # Re-probe. "The remedy returned success" and "the fault is gone" are
    # different claims, and only the second one is worth recording as healed —
    # this is the same discipline as verifying a deploy instead of trusting it.
    try:
        recheck = await probe.check()
    except Exception as exc:
        fault.status = FaultStatus.REMEDY_FAILED
        fault.outcome = (
            f"The fix ran ({result.detail}) but re-checking the condition raised "
            f"{type(exc).__name__}: {exc}"
        )[:2000]
        return

    if recheck.ok and not recheck.inconclusive:
        fault.status = FaultStatus.AUTO_HEALED
        fault.resolved_at = datetime.now(timezone.utc)
        fault.outcome = f"Fixed automatically. {result.detail}"[:2000]
        logger.warning("SELF-HEALED %s — %s", probe.key, result.detail)
    else:
        fault.status = FaultStatus.REMEDY_FAILED
        fault.outcome = (
            f"The fix reported success ({result.detail}) but the condition is "
            f"still failing. Not retried automatically."
        )[:2000]
        logger.error("Remedy %s reported success but fault persists", r.key)


async def _record(db, probe: Probe, result: ProbeResult) -> SystemFault:
    """Fold this observation into the one open row for the key."""
    fault = await _open_fault(db, probe.key)
    now = datetime.now(timezone.utc)
    severity = result.severity_override or probe.severity

    if fault is None:
        fault = SystemFault(
            fault_key=probe.key,
            title=probe.title,
            severity=severity,
            status=FaultStatus.DETECTED,
            evidence=result.evidence,
            remedy_key=probe.remedy.key if probe.remedy else None,
            remedy_description=(
                probe.remedy.description if probe.remedy else probe.manual_guidance
            ),
            first_seen_at=now,
            last_seen_at=now,
        )
        db.add(fault)
        await db.flush()
        logger.warning("FAULT DETECTED %s (%s)", probe.key, severity.value)
    else:
        fault.occurrences += 1
        fault.last_seen_at = now
        fault.evidence = result.evidence
        fault.severity = severity
    return fault


async def run_sweep(db) -> dict:
    """One pass over every registered probe. Returns a summary for the caller."""
    summary = {
        "checked": 0, "healthy": 0, "inconclusive": 0,
        "faults": 0, "auto_healed": 0, "awaiting_approval": 0, "probe_errors": 0,
    }

    for probe in all_probes():
        summary["checked"] += 1
        try:
            result = await probe.check()
        except Exception as exc:
            # A broken probe is itself a fault. Reporting it as one means the
            # monitoring going blind is visible in the same place everything
            # else is, rather than only in a log nobody reads.
            summary["probe_errors"] += 1
            logger.exception("Probe %s raised", probe.key)
            existing = await _open_fault(db, f"probe_error::{probe.key}")
            if existing is None:
                db.add(SystemFault(
                    fault_key=f"probe_error::{probe.key}",
                    title=f"Health check '{probe.title}' is failing to run",
                    severity=FaultSeverity.MEDIUM,
                    status=FaultStatus.AWAITING_APPROVAL,
                    evidence={"error": f"{type(exc).__name__}: {exc}",
                              "traceback": traceback.format_exc()[-2000:]},
                    remedy_description=(
                        "This check itself is erroring, so the condition it "
                        "watches is currently unmonitored. Needs a code fix."
                    ),
                    auto_eligible=False,
                    decision_reason="A failing probe cannot be repaired automatically.",
                ))
            else:
                existing.occurrences += 1
                existing.last_seen_at = datetime.now(timezone.utc)
            continue

        if result.inconclusive:
            summary["inconclusive"] += 1
            continue

        if result.ok:
            summary["healthy"] += 1
            open_fault = await _open_fault(db, probe.key)
            if open_fault is not None:
                open_fault.status = FaultStatus.CLEARED
                open_fault.resolved_at = datetime.now(timezone.utc)
                open_fault.outcome = (
                    open_fault.outcome or "The condition resolved on its own "
                    "before anyone acted."
                )
                logger.info("Fault %s cleared on its own", probe.key)
            continue

        summary["faults"] += 1
        fault = await _record(db, probe, result)

        # A fault a human has already been asked about stays asked. Re-deciding
        # every five minutes would let a remedy that was ruled out sneak back
        # in as soon as a cooldown expired.
        if fault.status == FaultStatus.AWAITING_APPROVAL:
            summary["awaiting_approval"] += 1
            continue

        run_it, reason = await _decide(db, probe, fault)
        fault.auto_eligible = run_it
        fault.decision_reason = reason

        if run_it:
            await _run_remedy(db, probe, fault)
            if fault.status == FaultStatus.AUTO_HEALED:
                summary["auto_healed"] += 1
            else:
                # A failed unattended repair becomes a human's problem
                # immediately rather than being retried on the next sweep.
                fault.status = FaultStatus.AWAITING_APPROVAL
                summary["awaiting_approval"] += 1
        else:
            fault.status = FaultStatus.AWAITING_APPROVAL
            summary["awaiting_approval"] += 1

    await db.commit()
    return summary


async def apply_remedy_by_id(db, fault_id, user) -> SystemFault:
    """Run the proposed fix for a fault a human has just approved.

    The same execution path as the unattended one, deliberately — an approved
    fix is verified by re-probing exactly like an automatic one, so "approved"
    never means "assumed to have worked".
    """
    from fastapi import HTTPException

    fault = (await db.execute(
        select(SystemFault).where(SystemFault.id == fault_id)
    )).scalar_one_or_none()
    if fault is None:
        raise HTTPException(404, "Fault not found")
    if fault.status not in OPEN_STATUSES:
        raise HTTPException(409, f"This fault is already {fault.status.value}.")

    from app.services.monitor.registry import get_probe
    probe = get_probe(fault.fault_key)
    if probe is None or probe.remedy is None:
        raise HTTPException(
            400,
            "There is no automatic fix for this fault — it has to be done by hand.",
        )

    fault.approved_by = getattr(user, "id", None)
    fault.approved_at = datetime.now(timezone.utc)

    await _run_remedy(db, probe, fault)
    if fault.status == FaultStatus.AUTO_HEALED:
        # Distinguish "a person authorised this" from "the machine did it".
        fault.status = FaultStatus.RESOLVED
        fault.outcome = (fault.outcome or "").replace(
            "Fixed automatically.", "Fixed after approval."
        )
    await db.commit()
    await db.refresh(fault)
    return fault
