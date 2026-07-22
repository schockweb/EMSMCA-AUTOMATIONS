"""
E2E delivery-guarantee campaign for the Digital PRF pipeline (DEV stack only).

Proves that a submitted PRF ALWAYS reaches both dashboards — through the happy
path, duplicate submits, a worker outage (watchdog rescue), a >1h outage
(escalation to Failed Forms + admin Retry), and a broker outage (503 + revert
to DRAFT so nothing is stranded).

Run inside the backend container, orchestrated from the host:
    docker exec ems_backend python e2e_prf_pipeline_check.py <phase>

Phases: t1_happy, t2_race, t4_replay, prep_down (worker stopped), sweep_assert
(worker still stopped), after_up (worker running), t_broker_submit (rabbit
stopped), t_broker_recover (rabbit running), cleanup.

State is carried between phases in /tmp/e2e_state.json (container-local).
All records it creates are tagged patient "E2E" and are deleted by `cleanup`.
"""
from __future__ import annotations
import asyncio, json, sys, time, threading, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

STATE_PATH = "/tmp/e2e_state.json"
BASE = "http://localhost:8000"

PASS = []
FAIL = []


def check(name: str, cond: bool, detail: str = ""):
    (PASS if cond else FAIL).append(name)
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  [{detail}]" if detail else ""))


def load_state() -> dict:
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_state(st: dict):
    with open(STATE_PATH, "w") as f:
        json.dump(st, f)




def run_db(coro_factory):
    """Run a DB coroutine on a FRESH disposable engine bound to this call's
    event loop. The module-level engine in app.database pools connections on
    the first loop it sees; repeated asyncio.run() calls then die with
    "Future attached to a different loop" — same trap the Celery tasks hit,
    same fix (_make_celery_session)."""
    async def wrapper():
        from app.tasks.prf_processing import _make_celery_session
        engine, Session = _make_celery_session()
        try:
            async with Session() as db:
                return await coro_factory(db)
        finally:
            await engine.dispose()
    return asyncio.run(wrapper())

def http(method: str, path: str, token: str, body: dict | None = None, timeout: int = 20):
    req = urllib.request.Request(
        BASE + path, method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        data=(json.dumps(body).encode() if body is not None else None),
    )
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, json.load(r), dict(r.headers)
    except urllib.error.HTTPError as e:
        try:
            payload = json.load(e)
        except Exception:
            payload = {}
        return e.code, payload, dict(e.headers)


def tokens():
    async def factory(db):
        from sqlalchemy import select
        from app.models.user import User
        from app.models.crew_member import CrewMember
        from app.utils.security import create_access_token

        users = (await db.execute(select(User))).scalars().all()
        admin = next(u for u in users if "admin" in str(getattr(u, "role", "")).lower())
        crew = (await db.execute(
            select(CrewMember).where(CrewMember.is_active == True)  # noqa: E712
        )).scalars().first()
        assert crew, "no active crew member in dev DB"
        admin_tok = create_access_token({"sub": str(admin.id)})
        crew_tok = create_access_token({
            "sub": str(crew.id), "crew_id": str(crew.id),
            "provider_id": str(crew.provider_id), "token_scope": "crew",
        })
        return admin_tok, crew_tok, str(crew.provider_id)
    return run_db(factory)


def prf_row(prf_id: str):
    async def factory(db):
        from sqlalchemy import select
        from app.models.digital_prf import DigitalPRF
        p = (await db.execute(select(DigitalPRF).where(DigitalPRF.id == prf_id))).scalars().first()
        return {
            "status": p.status.value, "case_id": str(p.case_id) if p.case_id else None,
            "prf_number": p.prf_number, "error": p.processing_error,
        } if p else None
    return run_db(factory)


def wait_processed(prf_id: str, timeout_s: int = 45) -> dict | None:
    deadline = time.time() + timeout_s
    row = None
    while time.time() < deadline:
        row = prf_row(prf_id)
        if row and row["status"] == "processed" and row["case_id"]:
            return row
        time.sleep(2)
    return row


def make_prf(crew_tok: str, tag: str) -> dict:
    st, body, _ = http("POST", "/api/digital-prf", crew_tok, {})
    assert st == 201, f"create failed: {st} {body}"
    prf_id = body["id"] if "id" in body else body.get("prf_id")
    fd = {
        "call_type": "PRIMARY",
        "patient_name": "E2E",
        "patient_surname": f"Test {tag}",
        "medical_scheme": "Discovery Health",
        "priority": "P2",
    }
    st2, body2, _ = http("PATCH", f"/api/digital-prf/{prf_id}", crew_tok, {"form_data": fd})
    assert st2 == 200, f"save failed: {st2} {body2}"
    return {"id": prf_id, "prf_number": body.get("prf_number")}


def dashboards_have(admin_tok: str, provider_id: str, tag: str, case_id: str, prf_number: int, label: str):
    # EMSMCA staff dashboard (Cases, management queue)
    st, cases, _ = http("GET", f"/api/cases/?queue=management&search=E2E&limit=200", admin_tok)
    ids = [c["id"] for c in cases] if st == 200 else []
    check(f"{label}: EMSMCA Cases list contains the case", st == 200 and case_id in ids, f"status={st}")
    st2, cnt, _ = http("GET", "/api/cases/count?queue=management&search=E2E", admin_tok)
    check(f"{label}: EMSMCA Cases count >= 1", st2 == 200 and (cnt.get("total") or 0) >= 1, f"total={cnt.get('total')}")
    # Client (provider admin) dashboard
    st3, items, hdrs = http("GET", f"/api/providers/{provider_id}/prfs?search=E2E&limit=200", admin_tok)
    rows = items if isinstance(items, list) else items.get("items", [])
    mine = [r for r in rows if r["prf_number"] == prf_number]
    check(f"{label}: client dashboard lists the PRF", st3 == 200 and len(mine) == 1, f"status={st3}")
    if mine:
        check(f"{label}: client row is processed + viewable", mine[0]["status"] == "processed" and mine[0]["case_id"] == case_id)
    check(f"{label}: client list X-Total-Count present", "X-Total-Count" in hdrs or "x-total-count" in hdrs)


# ── Phases ──────────────────────────────────────────────────────────────────

def t1_happy():
    admin_tok, crew_tok, pid = tokens()
    prf = make_prf(crew_tok, "Alpha")
    st, body, _ = http("POST", f"/api/digital-prf/{prf['id']}/submit", crew_tok)
    check("T1: submit accepted (202)", st == 202, f"status={st} {body.get('message','')}")
    row = wait_processed(prf["id"])
    check("T1: PRF processed with a case", bool(row and row["status"] == "processed" and row["case_id"]), f"row={row}")
    if row and row["case_id"]:
        dashboards_have(admin_tok, pid, "Alpha", row["case_id"], row["prf_number"], "T1")
    stt = load_state(); stt["t1"] = {"prf_id": prf["id"], "case_id": row and row["case_id"]}; save_state(stt)


def t2_race():
    admin_tok, crew_tok, pid = tokens()
    prf = make_prf(crew_tok, "Race")
    results = []

    def fire():
        results.append(http("POST", f"/api/digital-prf/{prf['id']}/submit", crew_tok))

    th = [threading.Thread(target=fire) for _ in range(2)]
    [t.start() for t in th]; [t.join() for t in th]
    codes = sorted(r[0] for r in results)
    check("T2: both concurrent submits handled (202/202)", codes == [202, 202], f"codes={codes}")
    row = wait_processed(prf["id"])
    check("T2: race PRF processed", bool(row and row["case_id"]), f"row={row}")

    async def counts(db):
        from sqlalchemy import select, func
        from app.models.claim import Claim
        from app.models.case import Case
        ncase = (await db.execute(select(func.count()).select_from(Case).where(Case.id == row["case_id"]))).scalar()
        nclaims = (await db.execute(select(func.count()).select_from(Claim).where(Claim.case_id == row["case_id"]))).scalar()
        return ncase, nclaims
    ncase, nclaims = run_db(counts)
    check("T2: exactly ONE case for the PRF", ncase == 1, f"cases={ncase}")
    check("T2: exactly ONE claim (no double billing)", nclaims == 1, f"claims={nclaims}")
    stt = load_state(); stt["t2"] = {"prf_id": prf["id"], "case_id": row and row["case_id"]}; save_state(stt)


def t4_replay():
    _, crew_tok, _ = tokens()
    stt = load_state()
    prf_id = stt["t1"]["prf_id"]
    st, body, _ = http("POST", f"/api/digital-prf/{prf_id}/submit", crew_tok)
    check("T4: re-submit of processed PRF is an idempotent replay",
          st == 202 and body.get("status") == "processed" and body.get("tariff_engine", {}).get("idempotent_replay") is True,
          f"status={st} body_status={body.get('status')}")
    check("T4: replay returns the SAME case", body.get("case_id") == stt["t1"]["case_id"])


def prep_down():
    """Run with celery_worker STOPPED: submissions must not be lost."""
    _, crew_tok, _ = tokens()
    c = make_prf(crew_tok, "Rescue")
    e = make_prf(crew_tok, "Escalate")
    stc, _, _ = http("POST", f"/api/digital-prf/{c['id']}/submit", crew_tok)
    ste, _, _ = http("POST", f"/api/digital-prf/{e['id']}/submit", crew_tok)
    check("DOWN: submits still 202 while worker is down", stc == 202 and ste == 202, f"{stc},{ste}")
    rc, re_ = prf_row(c["id"]), prf_row(e["id"])
    check("DOWN: both sit at SUBMITTED with no case (the black-hole state)",
          rc["status"] == "submitted" and rc["case_id"] is None and re_["status"] == "submitted" and re_["case_id"] is None)

    async def backdate(db):
        from sqlalchemy import update
        from app.models.digital_prf import DigitalPRF
        now = datetime.now(timezone.utc)
        await db.execute(update(DigitalPRF).where(DigitalPRF.id == c["id"]).values(submitted_at=now - timedelta(minutes=15)))
        await db.execute(update(DigitalPRF).where(DigitalPRF.id == e["id"]).values(submitted_at=now - timedelta(minutes=70)))
        await db.commit()
    run_db(backdate)
    stt = load_state(); stt["down"] = {"c": c, "e": e}; save_state(stt)


def sweep_assert():
    """Still worker-down: watchdog must requeue C and escalate E; admins must SEE both."""
    admin_tok, _, _ = tokens()
    stt = load_state(); c, e = stt["down"]["c"], stt["down"]["e"]

    st, lst, _ = http("GET", "/api/failed-prfs", admin_tok)
    stuck_nums = [r["prf_number"] for r in lst if r.get("status") == "submitted"] if st == 200 else []
    check("DOWN: stuck submissions visible on Failed Forms BEFORE any rescue",
          c["prf_number"] in stuck_nums and e["prf_number"] in stuck_nums, f"stuck={stuck_nums}")
    st2, stats, _ = http("GET", "/api/failed-prfs/stats", admin_tok)
    check("DOWN: triangle feed shows stuck>0", st2 == 200 and (stats.get("total_stuck") or 0) >= 2, f"stats={stats}")

    from app.tasks.prf_processing import requeue_stuck_prfs
    res = requeue_stuck_prfs.apply().result
    check("DOWN: watchdog requeued the 15-min PRF", res.get("requeued", 0) >= 1, f"res={res}")
    check("DOWN: watchdog escalated the 70-min PRF to FAILED", res.get("escalated", 0) >= 1, f"res={res}")

    re_ = prf_row(e["id"])
    check("DOWN: escalated PRF is FAILED with a clear reason",
          re_["status"] == "failed" and "never" in (re_["error"] or ""), f"row={re_}")
    # /api/failed-prfs sits behind a 30s response cache, and the watchdog's DB
    # write (worker process) cannot invalidate the backend's in-memory cache —
    # so this list can lag an escalation by up to 30s. Bust the cache with a
    # unique query param so we assert against a fresh read. (Documented
    # characteristic: admins may see the escalation up to 30s late.)
    st3, lst2, _ = http("GET", f"/api/failed-prfs?cb={int(time.time())}", admin_tok)
    failed_nums = [r["prf_number"] for r in lst2 if r.get("status") == "failed"]
    check("DOWN: escalated PRF listed as FAILED for admins (fresh read)", e["prf_number"] in failed_nums)


def after_up():
    """Worker running again: the queued rescue must complete; admin Retry must recover the FAILED one."""
    admin_tok, _, pid = tokens()
    stt = load_state(); c, e = stt["down"]["c"], stt["down"]["e"]

    row_c = wait_processed(c["id"], 60)
    check("UP: rescued PRF processed after worker returned",
          bool(row_c and row_c["status"] == "processed" and row_c["case_id"]), f"row={row_c}")
    if row_c and row_c["case_id"]:
        dashboards_have(admin_tok, pid, "Rescue", row_c["case_id"], row_c["prf_number"], "UP-rescue")

    # The escalated PRF's ORIGINAL submit message is still queued in RabbitMQ,
    # so the moment the worker returns it may self-heal to PROCESSED before an
    # admin ever clicks Retry (by design: FAILED doesn't block late delivery).
    # The contract is therefore: Retry returns 200 (requeue) OR 409 (already
    # processed — the guard that stops a re-Retry stranding it). Both are wins.
    st, body, _ = http("POST", f"/api/failed-prfs/{e['id']}/reprocess", admin_tok)
    row_now = prf_row(e["id"])
    ok = st == 200 or (st == 409 and row_now["status"] == "processed" and row_now["case_id"])
    check("UP: admin Retry accepted OR correctly refused (self-healed first)", bool(ok),
          f"status={st} row={row_now}")
    row_e = wait_processed(e["id"], 60)
    check("UP: escalated PRF ends PROCESSED (via Retry or self-heal)",
          bool(row_e and row_e["status"] == "processed" and row_e["case_id"]), f"row={row_e}")
    if row_e and row_e["case_id"]:
        dashboards_have(admin_tok, pid, "Escalate", row_e["case_id"], row_e["prf_number"], "UP-escalate")
    stt["down"]["c_case"] = row_c and row_c["case_id"]; stt["down"]["e_case"] = row_e and row_e["case_id"]
    save_state(stt)


def t_broker_submit():
    """Run with rabbitmq STOPPED: submit must 503 and revert to DRAFT (nothing stranded)."""
    _, crew_tok, _ = tokens()
    f = make_prf(crew_tok, "Broker")
    st, body, _ = http("POST", f"/api/digital-prf/{f['id']}/submit", crew_tok, timeout=60)
    row = prf_row(f["id"])
    check("BROKER-DOWN: submit rejected with 503 (crew told to retry)", st == 503, f"status={st} {body}")
    check("BROKER-DOWN: PRF reverted to editable DRAFT (not stranded in SUBMITTED)",
          row["status"] == "draft" and row["case_id"] is None, f"row={row}")
    stt = load_state(); stt["broker"] = f; save_state(stt)


def t_broker_recover():
    admin_tok, crew_tok, pid = tokens()
    f = load_state()["broker"]
    st, _, _ = http("POST", f"/api/digital-prf/{f['id']}/submit", crew_tok)
    check("BROKER-UP: resubmit accepted", st == 202, f"status={st}")
    row = wait_processed(f["id"], 60)
    check("BROKER-UP: PRF processed after broker recovery", bool(row and row["case_id"]), f"row={row}")
    if row and row["case_id"]:
        dashboards_have(admin_tok, pid, "Broker", row["case_id"], row["prf_number"], "BROKER")
    stt = load_state(); stt["broker_case"] = row and row["case_id"]; save_state(stt)


def cleanup():
    async def run(db):
        from sqlalchemy import select, delete
        from app.models.digital_prf import DigitalPRF
        from app.models.case import Case
        from app.models.claim import Claim
        from app.models.claim_line import ClaimLine
        from app.models.document import Document
        prfs = (await db.execute(
            select(DigitalPRF).where(DigitalPRF.form_data["patient_name"].as_string() == "E2E")
        )).scalars().all()
        case_ids = [p.case_id for p in prfs if p.case_id]
        claim_ids = (await db.execute(select(Claim.id).where(Claim.case_id.in_(case_ids)))).scalars().all() if case_ids else []
        if claim_ids:
            await db.execute(delete(ClaimLine).where(ClaimLine.claim_id.in_(claim_ids)))
            await db.execute(delete(Claim).where(Claim.id.in_(claim_ids)))
        for p in prfs:
            p.case_id = None; p.document_id = None
        await db.flush()
        if case_ids:
            await db.execute(delete(Document).where(Document.case_id.in_(case_ids)))
            await db.execute(delete(Case).where(Case.id.in_(case_ids)))
        for p in prfs:
            await db.delete(p)
        await db.commit()
        print(f"cleanup: removed {len(prfs)} E2E PRFs, {len(case_ids)} cases, {len(claim_ids)} claims")
    run_db(run)


PHASES = {
    "t1_happy": t1_happy, "t2_race": t2_race, "t4_replay": t4_replay,
    "prep_down": prep_down, "sweep_assert": sweep_assert, "after_up": after_up,
    "t_broker_submit": t_broker_submit, "t_broker_recover": t_broker_recover,
    "cleanup": cleanup,
}

if __name__ == "__main__":
    phase = sys.argv[1]
    PHASES[phase]()
    print(f"== {phase}: {len(PASS)} passed, {len(FAIL)} failed ==")
    sys.exit(1 if FAIL else 0)
