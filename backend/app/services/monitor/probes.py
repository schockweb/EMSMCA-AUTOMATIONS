"""
The conditions this platform is checked against, and what it may do about them.

Every probe here corresponds to a way this system has ACTUALLY failed, or to an
invariant whose violation would be silent. Generic SRE checklist items are
deliberately absent: a check nobody believes gets muted, and a muted check is
worse than no check because it looks like coverage.

Importing this module is what REGISTERS the probes. `app/tasks/monitoring.py`
imports it explicitly before sweeping — an empty registry would cheerfully
report zero faults, which is the same shape as the beat task that was scheduled
but never registered.
"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, text

from app.models.system_fault import FaultSeverity
from app.services.monitor.registry import (
    Probe, ProbeResult, Remedy, RemedyResult, register,
)

logger = logging.getLogger("ems.monitor")


async def _session():
    """A session independent of any request. Probes run from Celery."""
    from app.database import AsyncSessionLocal
    return AsyncSessionLocal()


# ════════════════════════════════════════════════════════════════════════════
# 1. Redis is down — three security controls degrade silently
# ════════════════════════════════════════════════════════════════════════════

async def _check_redis() -> ProbeResult:
    from app.config import get_settings
    url = get_settings().REDIS_URL
    if not url:
        return ProbeResult.unknown(reason="REDIS_URL is not configured")
    try:
        import redis.asyncio as aioredis
    except ImportError:
        return ProbeResult.unknown(reason="redis client library not installed")

    client = aioredis.from_url(url, socket_connect_timeout=2, socket_timeout=2)
    try:
        started = time.monotonic()
        await client.ping()
        return ProbeResult.healthy(ping_ms=round((time.monotonic() - started) * 1000, 1))
    except Exception as exc:
        return ProbeResult.faulty(
            severity=FaultSeverity.HIGH,
            error=f"{type(exc).__name__}: {exc}",
            consequence=(
                "The application rate limiter fails OPEN, the per-source login "
                "throttle falls back to per-worker memory, and cross-worker "
                "session revocation stops propagating."
            ),
        )
    finally:
        try:
            await client.aclose()
        except Exception:
            pass


async def _reconnect_redis() -> RemedyResult:
    """Drop the cached client so the next caller dials a fresh connection.

    The usual cause is not Redis being gone but the pooled client holding a
    socket that died under it — a container restart, a network blip. Nothing is
    created or destroyed; the next use reconnects.
    """
    import app.cache as cache_mod
    cache_mod._redis = None
    result = await _check_redis()
    if result.ok:
        return RemedyResult(ok=True, detail="Reconnected to Redis.")
    return RemedyResult(ok=False, detail="Redis is still unreachable after reconnecting.")


register(Probe(
    key="redis_unavailable",
    title="Redis is unreachable — rate limiting and throttling are degraded",
    severity=FaultSeverity.HIGH,
    rationale=(
        "A single PING with a 2s timeout. There is no threshold to tune: Redis "
        "either answers or it does not. This matters more than it looks because "
        "the rate limiter is deliberately fail-open (nginx is the hard edge), so "
        "the failure mode is silent — throughput limits simply stop applying and "
        "nothing in /health mentions it."
    ),
    check=_check_redis,
    remedy=Remedy(
        key="reconnect_redis",
        description="Drop the cached Redis client so the next request reconnects.",
        run=_reconnect_redis,
        touches_patient_data=False,
        idempotent=True,
        destructive=False,
        blast_radius="One connection pool inside this worker. Nothing is written or deleted.",
        cooldown_minutes=5,
        max_attempts=3,
    ),
))


# ════════════════════════════════════════════════════════════════════════════
# 2. A scheduled job has stopped running
# ════════════════════════════════════════════════════════════════════════════
#
# Only jobs that are pure operational sweeps may be restarted unattended.
# `requeue_stuck_prfs` is excluded on purpose: it can stamp a PRF FAILED, which
# is a change to a clinical record's state and belongs to a human.
_AUTO_RERUNNABLE = {
    "purge_expired_blacklist": 3600,
    "report_retention_status": 604800,
}
_NEVER_AUTO_RERUN = {"requeue_stuck_prfs", "purge_prf_email_spool"}


async def _check_beat_liveness() -> ProbeResult:
    """Has beat produced any work recently?

    Inferred from the blacklist purge, which runs hourly and is the most
    frequent job with an observable effect on the database. If beat has been
    dead for hours, expired rows accumulate past the point the hourly sweep
    would ever leave them.
    """
    from app.models.token_blacklist import TokenBlacklist

    session = await _session()
    async with session as db:
        stale_cutoff = datetime.now(timezone.utc) - timedelta(hours=3)
        expired_left = (await db.execute(
            select(func.count(TokenBlacklist.jti)).where(
                TokenBlacklist.expires_at < stale_cutoff
            )
        )).scalar() or 0

    if expired_left == 0:
        return ProbeResult.healthy(expired_blacklist_rows=0)
    return ProbeResult.faulty(
        severity=FaultSeverity.HIGH if expired_left > 500 else FaultSeverity.MEDIUM,
        expired_blacklist_rows=expired_left,
        consequence=(
            "Rows that expired more than 3 hours ago are still present, so the "
            "hourly purge has not run. If beat is dead, the stuck-PRF watchdog "
            "is dead too — and that one is what rescues a patient record whose "
            "submission was lost."
        ),
    )


async def _rerun_blacklist_purge() -> RemedyResult:
    from app.tasks.celery_app import celery_app
    celery_app.send_task("purge_expired_blacklist", queue="ems_default")
    return RemedyResult(ok=True, detail="Re-queued the expired-token purge.")


register(Probe(
    key="scheduled_jobs_not_running",
    title="Scheduled maintenance has stopped running — Celery beat may be dead",
    severity=FaultSeverity.HIGH,
    rationale=(
        "Any token-blacklist row that expired more than 3 HOURS ago proves the "
        "hourly purge has missed at least two runs. One missed run is a blip; "
        "three is a dead scheduler. The blacklist is used as the signal because "
        "it is the most frequent job whose effect is visible in the database "
        "without asking the broker anything."
    ),
    check=_check_beat_liveness,
    remedy=Remedy(
        key="rerun_blacklist_purge",
        description=(
            "Re-queue the expired-token purge. If it completes, the worker is "
            "alive and only the scheduler is at fault."
        ),
        run=_rerun_blacklist_purge,
        touches_patient_data=False,
        idempotent=True,
        destructive=False,
        blast_radius=(
            "Deletes only token-blacklist rows whose own expiry has already "
            "passed — they are dead weight by definition."
        ),
        cooldown_minutes=30,
        max_attempts=2,
    ),
))


# ════════════════════════════════════════════════════════════════════════════
# 3. An ambulance service is locked out of starting shifts
# ════════════════════════════════════════════════════════════════════════════

async def _check_provider_lockouts() -> ProbeResult:
    from app.models.service_provider import ServiceProvider

    session = await _session()
    async with session as db:
        now = datetime.now(timezone.utc)
        locked = (await db.execute(
            select(ServiceProvider.slug, ServiceProvider.locked_until).where(
                ServiceProvider.locked_until.isnot(None),
                ServiceProvider.locked_until > now,
            )
        )).all()

    if not locked:
        return ProbeResult.healthy(locked_providers=0)
    return ProbeResult.faulty(
        severity=FaultSeverity.HIGH,
        locked_providers=len(locked),
        slugs=[s for s, _ in locked][:20],
        consequence=(
            "Crews at these companies cannot unlock a tablet, so they cannot "
            "start a shift or create a patient report form. Provider-wide locks "
            "are legacy: throttling is now per source address, so a lock set "
            "this way is either stale or the result of anonymous guessing."
        ),
    )


async def _clear_provider_lockouts() -> RemedyResult:
    from app.models.service_provider import ServiceProvider

    session = await _session()
    async with session as db:
        now = datetime.now(timezone.utc)
        rows = (await db.execute(
            select(ServiceProvider).where(
                ServiceProvider.locked_until.isnot(None),
                ServiceProvider.locked_until > now,
            )
        )).scalars().all()
        for p in rows:
            p.locked_until = None
            p.failed_login_attempts = 0
        await db.commit()
    return RemedyResult(ok=True, detail=f"Cleared {len(rows)} provider lockout(s).")


register(Probe(
    key="provider_locked_out_of_shift_start",
    title="An ambulance service is locked out of starting shifts",
    severity=FaultSeverity.HIGH,
    rationale=(
        "Any provider inside its lockout window at all. There is no tolerance "
        "threshold because the consequence is clinical: a crew on scene cannot "
        "open a patient report form. The brute-force protection this replaces "
        "is not lost — throttling is now keyed on the guessing SOURCE, so "
        "clearing the provider-wide flag restores availability without giving "
        "an attacker anything."
    ),
    check=_check_provider_lockouts,
    remedy=Remedy(
        key="clear_provider_lockouts",
        description=(
            "Clear the provider-wide lock so crews can start shifts. Per-source "
            "throttling stays in force."
        ),
        run=_clear_provider_lockouts,
        touches_patient_data=False,
        idempotent=True,
        destructive=False,
        blast_radius=(
            "Two counter columns on the provider row. No credential is changed "
            "and no patient data is touched."
        ),
        cooldown_minutes=10,
        max_attempts=5,
    ),
))


# ════════════════════════════════════════════════════════════════════════════
# 4. Beat is publishing a task no worker has registered
# ════════════════════════════════════════════════════════════════════════════

async def _check_task_registration() -> ProbeResult:
    """This exact failure shipped once: a scheduled job that never ran.

    THE MODULES ARE IMPORTED FIRST, and that is not incidental. A worker loads
    everything in `include` at startup, but this sweep can also be triggered
    from the API process (`POST /api/system-faults/sweep`), where those modules
    have never been imported — so a naive comparison reports every scheduled
    task as unregistered and raises a CRITICAL fault about a system that is
    fine. Caught on the first end-to-end run of this probe.

    Importing exactly what the worker imports means the check answers the real
    question — "would a worker built from this code know these tasks?" —
    instead of "does this particular process happen to have loaded them?".
    """
    import importlib

    from app.tasks.celery_app import celery_app

    failed_imports = {}
    for module in (celery_app.conf.include or []):
        try:
            importlib.import_module(module)
        except Exception as exc:      # a task module that cannot import is its own fault
            failed_imports[module] = f"{type(exc).__name__}: {exc}"

    scheduled = {
        name: entry["task"]
        for name, entry in (celery_app.conf.beat_schedule or {}).items()
    }
    missing = {n: t for n, t in scheduled.items() if t not in celery_app.tasks}
    if failed_imports and not missing:
        return ProbeResult.faulty(
            severity=FaultSeverity.CRITICAL,
            unimportable_task_modules=failed_imports,
            consequence=(
                "A module listed in Celery's include list cannot be imported, so "
                "the worker will start without the tasks it defines."
            ),
        )
    if not missing:
        return ProbeResult.healthy(scheduled_tasks=len(scheduled))
    return ProbeResult.faulty(
        severity=FaultSeverity.CRITICAL,
        missing=missing,
        consequence=(
            "Beat publishes these on schedule and the worker rejects every "
            "delivery as unregistered. The job looks configured and has never "
            "run. Usually the task's module is missing from the `include` list "
            "in app/tasks/celery_app.py."
        ),
    )


register(Probe(
    key="scheduled_task_not_registered",
    title="A scheduled job is published but no worker knows how to run it",
    severity=FaultSeverity.CRITICAL,
    rationale=(
        "Exact set comparison — every task named in beat_schedule must exist in "
        "the worker's registry. No threshold: one missing entry is one job that "
        "has never run. This is checked at import time by a unit test as well, "
        "but only the running worker can prove its own registry."
    ),
    check=_check_task_registration,
    manual_guidance=(
        "Add the task's module to the `include` list in app/tasks/celery_app.py "
        "and redeploy the worker. A code change — nothing can fix this at runtime."
    ),
))


# ════════════════════════════════════════════════════════════════════════════
# 5. The database schema does not match the code
# ════════════════════════════════════════════════════════════════════════════

async def _check_alembic_head() -> ProbeResult:
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    here = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ini = os.path.join(os.path.dirname(here), "alembic.ini")
    if not os.path.exists(ini):
        return ProbeResult.unknown(reason="alembic.ini not found in this image")

    script = ScriptDirectory.from_config(Config(ini))
    code_heads = set(script.get_heads())

    session = await _session()
    async with session as db:
        try:
            applied = {
                r[0] for r in (await db.execute(text("SELECT version_num FROM alembic_version"))).all()
            }
        except Exception as exc:
            return ProbeResult.unknown(reason=f"cannot read alembic_version: {exc}")

    if applied == code_heads:
        return ProbeResult.healthy(revision=list(applied))
    return ProbeResult.faulty(
        severity=FaultSeverity.CRITICAL,
        applied=sorted(applied),
        expected=sorted(code_heads),
        consequence=(
            "The deployed code expects a schema the database does not have. "
            "Typically a column the ORM selects is missing, which surfaces as a "
            "500 on every request that touches the table."
        ),
    )


register(Probe(
    key="database_schema_behind_code",
    title="A migration in this build has not been applied to the database",
    severity=FaultSeverity.CRITICAL,
    rationale=(
        "Exact comparison of alembic's head revisions against the applied ones. "
        "No tolerance — a schema one revision behind is a schema that is wrong, "
        "and the failure it produces (a missing column on a hot path) looks "
        "like a total outage rather than a partial one."
    ),
    check=_check_alembic_head,
    manual_guidance=(
        "Run `alembic upgrade head` against production. NOT done automatically: "
        "a migration alters the schema of a database holding patient records, "
        "and the safe order is to run it from a one-off container built on the "
        "new image BEFORE the application containers are recreated."
    ),
))


# ════════════════════════════════════════════════════════════════════════════
# 6. A national identifier is sitting in plaintext
# ════════════════════════════════════════════════════════════════════════════

async def _check_plaintext_identifiers() -> ProbeResult:
    """The regression check for the encryption work.

    Scans for a bare 13-digit value in either JSON blob. It is how the last two
    omissions were found, and a new crew form field carrying an identifier is
    exactly the way another one gets introduced.
    """
    session = await _session()
    async with session as db:
        rows = (await db.execute(text("""
            SELECT 'digital_prfs' AS tbl, key, count(*) AS n
              FROM digital_prfs, LATERAL jsonb_each_text(form_data::jsonb)
             WHERE value ~ '^[0-9]{13}$'
             GROUP BY key
            UNION ALL
            SELECT 'documents', key, count(*)
              FROM documents, LATERAL jsonb_each_text(extracted_data::jsonb)
             WHERE value ~ '^[0-9]{13}$'
             GROUP BY key
        """))).all()

    # Practice and BHF registration numbers are 13 digits in this data and are
    # business registrations, not personal identifiers — verified against the SA
    # ID date prefix and Luhn checksum on 2026-08-03 (0 of 16 were valid IDs).
    ignore = {"provider_practice_number", "bhf_practice_number", "practice_number"}
    offenders = [
        {"table": t, "field": k, "rows": n} for t, k, n in rows if k not in ignore
    ]
    if not offenders:
        return ProbeResult.healthy(plaintext_identifier_fields=0)
    return ProbeResult.faulty(
        severity=FaultSeverity.CRITICAL,
        fields=offenders,
        consequence=(
            "A field holding what looks like an SA ID number is stored in clear "
            "in a column the platform describes as encrypted. Usually a new form "
            "field that was not added to ENCRYPTED_FORM_KEYS."
        ),
    )


register(Probe(
    key="plaintext_identifier_at_rest",
    title="A national identifier is stored in plaintext",
    severity=FaultSeverity.CRITICAL,
    rationale=(
        "Any bare 13-digit value in either JSON blob, excluding the three "
        "practice-number fields confirmed to be business registrations. One row "
        "is a fault: the claim made to a medical scheme is that the identifier "
        "is encrypted, and that claim is either true or it is not."
    ),
    check=_check_plaintext_identifiers,
    manual_guidance=(
        "Add the field to _EXTRA_ID_KEYS in app/utils/encrypted_types.py, deploy, "
        "then run `python encrypt_patient_ids.py --apply` so existing rows are "
        "converted. NOT done automatically: it rewrites patient records in place, "
        "and the established procedure is to rehearse it against a restored "
        "backup first."
    ),
))


# ════════════════════════════════════════════════════════════════════════════
# 7. Patient report forms are stranded
# ════════════════════════════════════════════════════════════════════════════

async def _check_stranded_prfs() -> ProbeResult:
    from app.models.digital_prf import DigitalPRF, PRFStatus

    session = await _session()
    async with session as db:
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=90)
        ref = func.coalesce(
            DigitalPRF.submitted_at, DigitalPRF.updated_at, DigitalPRF.created_at
        )
        stranded = (await db.execute(
            select(func.count(DigitalPRF.id)).where(
                DigitalPRF.status == PRFStatus.SUBMITTED,
                DigitalPRF.case_id.is_(None),
                ref < cutoff,
            )
        )).scalar() or 0
        failed_recent = (await db.execute(
            select(func.count(DigitalPRF.id)).where(
                DigitalPRF.status == PRFStatus.FAILED,
                DigitalPRF.updated_at >= datetime.now(timezone.utc) - timedelta(hours=1),
            )
        )).scalar() or 0

    if stranded == 0 and failed_recent < 5:
        return ProbeResult.healthy(stranded=0, failed_last_hour=failed_recent)
    return ProbeResult.faulty(
        severity=FaultSeverity.CRITICAL if stranded else FaultSeverity.HIGH,
        stranded_over_90_min=stranded,
        newly_failed_last_hour=failed_recent,
        consequence=(
            "A submitted patient report form has no case and the watchdog has "
            "not rescued it, or the watchdog is mass-failing forms — which turns "
            "an infrastructure outage into a manual back-office backlog. Either "
            "way a completed clinical record is not reaching billing."
        ),
    )


register(Probe(
    key="prfs_stranded_after_submit",
    title="Submitted patient report forms are not being processed",
    severity=FaultSeverity.CRITICAL,
    rationale=(
        "90 minutes, deliberately longer than the watchdog's own 60-minute "
        "escalation: anything still stranded at 90 means the WATCHDOG has "
        "failed, not merely the pipeline, so this does not just restate what "
        "requeue_stuck_prfs already handles. The five-failures-an-hour arm "
        "catches the opposite fault, where the watchdog is over-firing."
    ),
    check=_check_stranded_prfs,
    manual_guidance=(
        "Check the worker and broker first — a stranded form usually means "
        "publishing is failing. Retry from the Failed Forms page once the "
        "pipeline is healthy. NOT retried automatically: re-processing changes "
        "the state of a clinical record and can raise a duplicate claim."
    ),
))


# ════════════════════════════════════════════════════════════════════════════
# 8. Rendered patient PDFs are accumulating on disk
# ════════════════════════════════════════════════════════════════════════════

async def _check_email_spool() -> ProbeResult:
    from app.config import get_settings

    spool = os.path.join(getattr(get_settings(), "UPLOAD_DIR", "/app/uploads"), "prf_email_spool")
    if not os.path.isdir(spool):
        return ProbeResult.healthy(spool_files=0, note="spool directory not present")

    cutoff = time.time() - 2 * 3600
    stale = []
    for name in os.listdir(spool)[:5000]:
        path = os.path.join(spool, name)
        try:
            if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                stale.append(name)
        except OSError:
            continue

    if not stale:
        return ProbeResult.healthy(stale_spool_files=0)
    return ProbeResult.faulty(
        severity=FaultSeverity.HIGH if len(stale) > 20 else FaultSeverity.MEDIUM,
        stale_spool_files=len(stale),
        consequence=(
            "These are rendered patient report forms — complete clinical records "
            "as PDFs — abandoned on disk. The hourly purge should have removed "
            "anything older than two hours, so either it is not running or the "
            "email path is failing and leaving files behind."
        ),
    )


register(Probe(
    key="patient_pdfs_abandoned_on_disk",
    title="Rendered patient PDFs are accumulating in the email spool",
    severity=FaultSeverity.HIGH,
    rationale=(
        "Files older than 2 hours, against a purge that runs hourly — so one "
        "missed run is tolerated and two is not. Any file at all older than that "
        "is PHI on disk beyond the moment it was needed."
    ),
    check=_check_email_spool,
    manual_guidance=(
        "Run the spool purge from the worker, then find out why the email path "
        "abandoned them. NOT purged automatically: these files ARE patient "
        "clinical records, and nothing that deletes patient data runs unattended "
        "on this platform."
    ),
))


# ════════════════════════════════════════════════════════════════════════════
# 9. The backup is stale
# ════════════════════════════════════════════════════════════════════════════

async def _check_backup_freshness() -> ProbeResult:
    """Read-only check of the dump directory, if this container can see it."""
    candidates = ["/opt/backups/db", "/backups/db", "/app/backups"]
    found = next((d for d in candidates if os.path.isdir(d)), None)
    if not found:
        return ProbeResult.unknown(
            reason="backup directory not visible from this container",
            note="Backup freshness is checked on the host by deploy/ops/backup-verify.sh",
        )

    try:
        dumps = [
            (n, os.path.getmtime(os.path.join(found, n)))
            for n in os.listdir(found) if n.endswith(".sql.gz")
        ]
    except OSError as exc:
        return ProbeResult.unknown(reason=str(exc))

    if not dumps:
        return ProbeResult.faulty(severity=FaultSeverity.CRITICAL,
                                  reason="no database dump found at all", directory=found)

    newest_name, newest_at = max(dumps, key=lambda kv: kv[1])
    age_hours = (time.time() - newest_at) / 3600.0
    if age_hours <= 26:
        return ProbeResult.healthy(newest=newest_name, age_hours=round(age_hours, 1))
    return ProbeResult.faulty(
        severity=FaultSeverity.CRITICAL,
        newest=newest_name,
        age_hours=round(age_hours, 1),
        consequence="The nightly dump has not run. Every hour past this widens the recovery gap.",
    )


register(Probe(
    key="database_backup_stale",
    title="The nightly database backup has not run",
    severity=FaultSeverity.CRITICAL,
    rationale=(
        "26 hours, not 24: the dump runs at 02:00, so a 24-hour threshold would "
        "alert every night in the minutes before it fires. Two hours of slack "
        "absorbs a slow dump without hiding a missed one."
    ),
    check=_check_backup_freshness,
    manual_guidance=(
        "On the VM: `sudo /opt/ems/backup_ems.sh` and check /var/log/ems-backup.log. "
        "Cannot be run from inside a container — the script is a host cron job "
        "with its own credentials."
    ),
))


# ════════════════════════════════════════════════════════════════════════════
# 10. An insider is reading far more patient records than usual
# ════════════════════════════════════════════════════════════════════════════

async def _check_phi_read_volume() -> ProbeResult:
    """Statistical, and therefore never a trigger for an automatic action.

    The PHI read log exists so a breach can be scoped. Nothing has ever LOOKED
    at it, which means the exfiltration shape it was built to expose — one
    account reading far more records than it normally does — has never been
    visible to anyone.
    """
    from app.models.audit_log import AuditLog

    session = await _session()
    async with session as db:
        now = datetime.now(timezone.utc)
        recent = (await db.execute(
            select(AuditLog.user_id, AuditLog.crew_member_id, func.count(AuditLog.id))
            .where(
                AuditLog.action.in_(["READ", "TRANSMIT"]),
                AuditLog.created_at >= now - timedelta(hours=1),
            )
            .group_by(AuditLog.user_id, AuditLog.crew_member_id)
        )).all()
        if not recent:
            return ProbeResult.healthy(actors=0)

        baseline_rows = (await db.execute(
            select(func.count(AuditLog.id)).where(
                AuditLog.action.in_(["READ", "TRANSMIT"]),
                AuditLog.created_at >= now - timedelta(days=14),
            )
        )).scalar() or 0

    hourly_baseline = max(baseline_rows / (14 * 24), 1.0)
    # 20 reads AND 10x the platform's own hourly average. Both, because either
    # alone fires constantly on a young system with almost no traffic.
    spikes = [
        {"user_id": str(u) if u else None, "crew_id": str(c) if c else None, "reads_last_hour": n}
        for u, c, n in recent if n >= 20 and n >= hourly_baseline * 10
    ]
    if not spikes:
        return ProbeResult.healthy(
            actors=len(recent), hourly_baseline=round(hourly_baseline, 1)
        )
    return ProbeResult.faulty(
        severity=FaultSeverity.HIGH,
        actors=spikes,
        hourly_baseline=round(hourly_baseline, 1),
        consequence=(
            "One account read far more patient records in an hour than this "
            "platform normally serves. That is the shape of an insider "
            "exfiltration, and it is also the shape of a legitimate bulk export "
            "or a busy Monday — which is exactly why this only ever reports."
        ),
    )


register(Probe(
    key="phi_read_volume_spike",
    title="An account is reading far more patient records than usual",
    severity=FaultSeverity.HIGH,
    deterministic=False,   # ← statistical: may report, may never act
    rationale=(
        "At least 20 reads in an hour AND at least 10x the platform's own "
        "14-day hourly average. Both conditions, because on a system this young "
        "the multiplier alone fires on any normal working morning and an "
        "absolute count alone fires on a genuine busy period. Deliberately "
        "marked non-deterministic so it can never trigger an automatic action."
    ),
    check=_check_phi_read_volume,
    manual_guidance=(
        "Look at audit_logs for that actor. If it was not a legitimate export, "
        "POST /api/account-security/revoke-sessions to end their sessions, then "
        "scope which patients were read — that is what the log is for."
    ),
))
