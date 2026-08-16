"""
Drive N complete PRFs through the LIVE ePRF system and verify every one.

    # 1. isolated tenant (crew to authenticate as)
    python loadtest_provision.py --setup --crew 250

    # 2. the campaign
    python eprf_journey_campaign.py --count 3000 --concurrency 10 --run

    # 3. remove everything it created
    python loadtest_provision.py --teardown --yes

WHY THIS EXISTS, AND WHAT IT IS *NOT*
-------------------------------------
`seed_demo_prfs.py` writes records straight into the database. That is the right
tool for "does the portal hold and list 15,000 records", and it is the WRONG
evidence for "the ePRF was exercised": nothing it produces has passed through
the form, the API, or the pipeline. The distinction matters because it is the
first thing a scheme auditor pulls on — "walk me through how one of those was
created" — and "a script inserted it" ends the conversation.

This drives the real thing. For every PRF, over public HTTPS, with a real crew
token, through nginx and the real authentication:

    POST   /api/digital-prf              -> a draft, numbered under the
                                            per-provider lock
    PATCH  /api/digital-prf/{id}         -> the full capture: form_data, the
                                            nine timestamps, the nine odometer
                                            readings, every signature
    POST   /api/digital-prf/{id}/submit  -> queues the billing pipeline (202)

and then VERIFIES the record actually arrived: status PROCESSED, a case, a
document, and a documents row with needs_hitl_review=false, which is the
subquery the Cases page's management queue actually filters on. A PRF that
submits and never processes is invisible in exactly the way this is meant to
catch, so "submitted 3,000" is not the number worth reporting — "3,000 arrived"
is.

THE DATA IS NOT INVENTED
------------------------
Payloads are built by seed_demo_prfs.build_from_template, which clones one of
the seven reference PRFs a crew actually captured (Primary, IFT/IHT, RHT,
WCA/IOD, Courtesy, RESUS, DOD) and varies the patient, times, kilometres,
clinical values, scheme and crew. Every field a real capture carries is present
because it is a copy of one. See that module for why generating from field
names produced visibly hollow records.

BLAST RADIUS
------------
Everything is created by crew belonging to the throwaway provider that
loadtest_provision.py makes, so it is one tenant and one teardown. Tenant
isolation is enforced and tested, so these crew cannot reach another client's
data. Real providers are counted before and after and must not move.
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import json
import random
import sys
import time
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import httpx
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.database import engine
from app.models.case import Case
from app.models.crew_member import CrewMember
from app.models.digital_prf import DigitalPRF
from app.models.service_provider import ServiceProvider
from app.utils.security import create_access_token

from seed_demo_prfs import (
    TEMPLATE_NAMES, TEMPLATE_MIX, TIME_COLS, KM_COLS, SIG_COLS,
    DENSITY_BANDS, DENSITY_MIX, DENSITY_MIX_HUNT, DONOR,
    _collect_donors, build_from_template, shift_times, shift_kms,
)

LOAD_SLUG = "zzz-loadtest-temporary"
SOURCE_PROVIDER = "EMSMCA"
BASE_URL = "https://portal.emsmca.co.za"


# ── setup: templates + tokens ───────────────────────────────────────────────
async def load_context(source: str, load_slug: str, n_tokens: int):
    S = async_sessionmaker(engine, expire_on_commit=False)
    async with S() as db:
        src = (await db.execute(select(ServiceProvider).where(
            (ServiceProvider.prf_name == source) | (ServiceProvider.slug == source)
            | (ServiceProvider.name == source)))).scalars().first()
        if not src:
            raise SystemExit(f"No provider matches '{source}'.")

        # Filter to the seven reference cases IN SQL. Selecting every PRF on the
        # provider and picking them out in Python was fine when EMSMCA held
        # 3,500 records and OOM-killed the container at 13,500: each row drags
        # its full form_data, so the query grew to roughly 880MB of blobs to
        # find seven of them. It failed with exit 137 and no output at all,
        # which reads like the script never ran rather than like a memory limit.
        rows = (await db.execute(
            select(DigitalPRF, Case.custom_display_name)
            .join(Case, Case.id == DigitalPRF.case_id)
            .where(DigitalPRF.provider_id == src.id,
                   Case.custom_display_name.in_(TEMPLATE_NAMES)))).all()
        templates = {}
        for prf, label in rows:
            name = (label or "").strip()
            if name in TEMPLATE_NAMES and name not in templates:
                templates[name] = prf
        missing = [n for n in TEMPLATE_NAMES if n not in templates]
        if missing:
            raise SystemExit(f"Missing reference PRFs on {src.name}: {', '.join(missing)}")

        # WITHOUT THIS EVERY MEDICATION TABLE COMES OUT EMPTY.
        # _fit grows a repeating table by cloning a row that already exists, and
        # falls back to a donor shape when the template captured none. The
        # donors are collected here, and the campaign was never calling it —
        # seed_demo_prfs.run() does, so seeded records were fine and driven ones
        # were not. Of the seven references only Courtesy has a medication row
        # and only three have an IV row, so with no donors a Primary call
        # rendered a full IV column beside a blank Medication column, on every
        # sheet, all the way to "page 5 of 5". Spotted on a printed export.
        _collect_donors(templates)
        if not DONOR.get("medications"):
            raise SystemExit("No medication row anywhere in the reference PRFs to clone from.")

        # Detach: the loop below runs long after this session closes.
        tpl = {}
        for n, p in templates.items():
            tpl[n] = {
                "prf_number": p.prf_number,
                "form_data": copy.deepcopy(p.form_data or {}),
                "times": {c: getattr(p, c) for c in TIME_COLS},
                "kms": {c: getattr(p, c) for c in KM_COLS},
                "sigs": {c: getattr(p, c) for c in SIG_COLS},
                "obj": p,
            }

        load = (await db.execute(select(ServiceProvider).where(
            ServiceProvider.slug == load_slug))).scalar_one_or_none()
        if not load:
            raise SystemExit(
                f"No '{load_slug}' provider. Run: python loadtest_provision.py --setup --crew 250")
        crew = (await db.execute(select(CrewMember)
                                 .where(CrewMember.provider_id == load.id)
                                 .limit(n_tokens))).scalars().all()
        if not crew:
            raise SystemExit(f"'{load_slug}' has no crew.")
        tokens = [create_access_token({
            "sub": str(c.id), "crew_id": str(c.id),
            "provider_id": str(load.id), "provider_slug": load.slug,
            "role": c.role, "token_scope": "crew",
        }) for c in crew]

        real_prfs = (await db.execute(select(func.count()).select_from(DigitalPRF)
                                      .where(DigitalPRF.provider_id != load.id))).scalar()
    return tpl, tokens, str(load.id), real_prfs


# ── pacing ──────────────────────────────────────────────────────────────────
class Pacer:
    """Global token bucket, because nginx limits by CLIENT IP.

    `limit_req_zone $binary_remote_addr ... rate=10r/s` with burst=20 — a flood
    guard sized for one device. This campaign is thousands of journeys from ONE
    address, which that limiter is right to refuse and which no real deployment
    produces: 3,000 PRFs come from 3,000 tablets on different connections.

    So the ceiling here is an artefact of running the fleet from a single host,
    not a system limit, and the harness paces itself under it rather than
    measuring nginx's willingness to be flooded. Retries on 503 stay in as
    well — that is what the real client does, and it keeps the campaign honest
    about the full path instead of stepping around nginx to avoid the problem.
    """

    def __init__(self, rps: float):
        self.interval = 1.0 / rps if rps > 0 else 0.0
        self.next_at = 0.0
        self.lock = asyncio.Lock()

    async def take(self):
        if self.interval <= 0:
            return
        async with self.lock:
            now = asyncio.get_running_loop().time()
            wait = max(0.0, self.next_at - now)
            self.next_at = max(now, self.next_at) + self.interval
        if wait:
            await asyncio.sleep(wait)


async def req(client, pacer, method, url, out, **kw):
    """One request, paced, retrying only what a real client would retry.

    503 is nginx shedding load and 429 is the app's own limiter; both are
    "come back shortly", not "this failed". Anything else is returned as-is —
    a 4xx must surface, not be papered over by a retry loop.
    """
    last_exc = None
    for attempt in range(6):
        await pacer.take()
        try:
            r = await client.request(method, url, **kw)
        except httpx.TransportError as e:
            # The connection itself failed — no response to inspect. A crew on
            # a moving vehicle gets these constantly, and so does anything
            # running while the ingress is recreated, which is exactly how this
            # gap surfaced: a deploy mid-run turned recoverable blips into
            # journeys abandoned halfway, leaving half-saved records that read
            # as layout faults later. Retried like any other transient.
            last_exc = e
            out["throttled"] += 1
            await asyncio.sleep(min(6.0, 0.5 * (2 ** attempt)) * (0.7 + random.random() * 0.6))
            continue
        if r.status_code not in (429, 503):
            return r
        out["throttled"] += 1
        await asyncio.sleep(min(4.0, 0.25 * (2 ** attempt)) * (0.7 + random.random() * 0.6))
    if last_exc is not None:
        raise last_exc
    return r


# ── one complete journey ────────────────────────────────────────────────────
def iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else (None if v is None else str(v))


async def one_journey(client, pacer, token, tpl, tname, band, when, out):
    """create -> save -> submit. Records where it got to, and why if it stopped."""
    h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    t0 = time.perf_counter()

    # 1. CREATE. client_id is what a device supplies when it started the PRF
    #    offline, and makes the call idempotent — a retry after a lost response
    #    returns the same row instead of a duplicate patient record.
    cid = str(uuid.uuid4())
    r = await req(client, pacer, "POST", f"{BASE_URL}/api/digital-prf", out,
                  headers=h, json={"client_id": cid})
    if r.status_code != 201:
        out["fail"].append(("create", r.status_code, r.text[:120]))
        return None
    body = r.json()
    prf_id = body.get("id") or body.get("prf_id")
    out["t_create"].append(time.perf_counter() - t0)

    # 2. SAVE the whole capture, exactly as the form's autosave does.
    fd, _mirror = build_from_template(tpl["form_data"], when, band, tname)
    payload = {"form_data": fd}
    for col, v in shift_times(tpl["obj"], when).items():
        payload[col] = iso(v)
    for col, v in shift_kms(tpl["obj"], random.randint(40_000, 260_000)).items():
        payload[col] = str(v)
    for col, v in tpl["sigs"].items():
        if v:
            payload[col] = v
    t1 = time.perf_counter()
    r = await req(client, pacer, "PATCH", f"{BASE_URL}/api/digital-prf/{prf_id}", out,
                  headers=h, json=payload)
    if r.status_code != 200:
        out["fail"].append(("save", r.status_code, r.text[:120]))
        return {"id": prf_id, "stage": "created"}
    out["t_save"].append(time.perf_counter() - t1)

    # 3. SUBMIT — 202, the pipeline runs in Celery.
    t2 = time.perf_counter()
    r = await req(client, pacer, "POST", f"{BASE_URL}/api/digital-prf/{prf_id}/submit", out,
                  headers=h)
    if r.status_code not in (200, 202):
        out["fail"].append(("submit", r.status_code, r.text[:120]))
        return {"id": prf_id, "stage": "saved"}
    out["t_submit"].append(time.perf_counter() - t2)
    out["ok"] += 1
    return {"id": prf_id, "stage": "submitted", "template": tname,
            "band": band, "prf_number": body.get("prf_number")}


async def run(args):
    random.seed(args.rand_seed)
    tpl, tokens, load_pid, real_before = await load_context(
        args.source, args.load_slug, args.tokens)

    names = list(TEMPLATE_MIX)
    picks = random.choices(names, weights=[TEMPLATE_MIX[n] for n in names], k=args.count)
    # --hunt weights the run past every layout budget, which is what finds
    # faults; the default mix looks like real work, which does not.
    mix = DENSITY_MIX_HUNT if args.hunt else DENSITY_MIX
    bnames = list(mix)
    bands = random.choices(bnames, weights=[mix[b] for b in bnames], k=args.count)

    print(f"\n  Target        : {BASE_URL}  (public HTTPS, through nginx)")
    print(f"  Journey       : POST create -> PATCH full capture -> POST submit -> verify")
    print(f"  Count         : {args.count}   concurrency {args.concurrency}   paced {args.rps} req/s")
    print(f"  Crew tokens   : {len(tokens)} (spreads the 600/min per-token API limit)")
    print(f"  Tenant        : {args.load_slug}  ({load_pid})")
    print(f"  Templates     : " + ", ".join(f"{n}x{picks.count(n)}" for n in names))
    print(f"  Fill bands    : " + ", ".join(f"{b}x{bands.count(b)}" for b in bnames))
    print(f"  Real PRFs now : {real_before}  (must not move)")
    if args.plan:
        print("\n  --plan: nothing was sent.\n")
        await engine.dispose()
        return

    out = {"ok": 0, "fail": [], "throttled": 0,
           "t_create": [], "t_save": [], "t_submit": []}
    pacer = Pacer(args.rps)
    created: list[dict] = []
    sem = asyncio.Semaphore(args.concurrency)
    now = datetime.now(timezone.utc)
    started = time.perf_counter()

    limits = httpx.Limits(max_connections=args.concurrency + 4,
                          max_keepalive_connections=args.concurrency + 4)
    async with httpx.AsyncClient(timeout=60.0, limits=limits, http2=False) as client:
        async def worker(i: int):
            async with sem:
                when = now - __import__("datetime").timedelta(
                    days=random.uniform(0, args.spread_days), hours=random.uniform(0, 24))
                try:
                    rec = await one_journey(
                        client, pacer, tokens[i % len(tokens)], tpl[picks[i]],
                        picks[i], bands[i], when, out)
                except Exception as e:            # noqa: BLE001 - one journey, not the run
                    out["fail"].append(("transport", 0, str(e)[:110]))
                    rec = None
                if rec:
                    created.append(rec)
                done = len(created) + len(out["fail"])
                if done % 250 == 0:
                    el = time.perf_counter() - started
                    print(f"    ... {done}/{args.count}  {done/el:.1f}/s  ok={out['ok']} fail={len(out['fail'])}")

        await asyncio.gather(*(worker(i) for i in range(args.count)))

    wall = time.perf_counter() - started
    manifest = {
        "created_at": now.isoformat(), "base_url": BASE_URL,
        "load_provider_id": load_pid, "count_requested": args.count,
        "records": created,
    }
    Path(args.manifest).write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    def pct(xs, p):
        if not xs:
            return 0.0
        s = sorted(xs)
        return s[min(len(s) - 1, int(len(s) * p / 100))]

    print(f"\n  ── delivery ──")
    print(f"  submitted            {out['ok']}/{args.count}")
    print(f"  failed               {len(out['fail'])}")
    print(f"  throttled+retried    {out['throttled']}  (nginx 10r/s per IP — one host, not 3,000 devices)")
    print(f"  wall                 {wall:.1f}s   ({args.count/wall:.1f} PRF/s)")
    for stage in ("create", "save", "submit"):
        xs = out[f"t_{stage}"]
        print(f"  {stage:20} p50 {pct(xs,50)*1000:7.0f}ms   p95 {pct(xs,95)*1000:7.0f}ms")
    if out["fail"]:
        print("\n  failure modes:")
        for k, v in Counter((s, c) for s, c, _ in out["fail"]).most_common(8):
            print(f"    {k[0]:8} HTTP {k[1]}  x{v}")
        for s, c, t in out["fail"][:3]:
            print(f"      e.g. {s} {c}: {t}")
    print(f"\n  Manifest: {Path(args.manifest).resolve()}")
    await engine.dispose()
    return manifest


# ── verification: did they ARRIVE, not just submit ──────────────────────────
async def verify(args):
    man = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    ids = [r["id"] for r in man["records"] if r.get("stage") == "submitted"]
    pid = man["load_provider_id"]
    print(f"\n  Verifying {len(ids)} submitted PRFs (waiting up to {args.wait}s for the pipeline)\n")

    S = async_sessionmaker(engine, expire_on_commit=False)
    deadline = time.time() + args.wait
    last = None
    while True:
        async with S() as db:
            row = (await db.execute(text("""
                select
                  count(*)                                          as total,
                  count(*) filter (where p.status = 'PROCESSED')    as processed,
                  count(*) filter (where p.case_id is not null)     as with_case,
                  count(*) filter (where p.document_id is not null) as with_doc,
                  count(*) filter (where p.processing_error is not null) as errored
                from digital_prfs p
                where p.id = any(cast(:i as uuid[]))"""), {"i": ids})).mappings().first()
        last = dict(row)
        print(f"    processed {last['processed']}/{last['total']}   "
              f"case {last['with_case']}   doc {last['with_doc']}   errors {last['errored']}")
        if last["processed"] >= last["total"] or time.time() > deadline:
            break
        await asyncio.sleep(10)

    async with S() as db:
        visible = (await db.execute(text("""
            select count(*) from documents d
            where d.needs_hitl_review = false
              and d.case_id in (select case_id from digital_prfs
                                where id = any(cast(:i as uuid[])) and case_id is not null)
            """), {"i": ids})).scalar()
        real = (await db.execute(text(
            "select count(*) from digital_prfs where provider_id <> cast(:p as uuid)"),
            {"p": pid})).scalar()
        by_tpl = (await db.execute(text("""
            select form_data::jsonb ->> 'call_type' ct, count(*)
            from digital_prfs where id = any(cast(:i as uuid[]))
            group by 1 order by 2 desc"""), {"i": ids})).all()

    print(f"\n  ── arrival ──")
    print(f"  submitted                 {last['total']}")
    print(f"  PROCESSED                 {last['processed']}")
    print(f"  has a case                {last['with_case']}")
    print(f"  has a document            {last['with_doc']}")
    print(f"  visible in case mgmt      {visible}")
    print(f"  processing errors         {last['errored']}")
    print(f"\n  by call type:")
    for ct, n in by_tpl:
        print(f"    {str(ct):12} {n}")
    print(f"\n  real-provider PRFs        {real}   (unchanged from the pre-run count?)")
    ok = (last["processed"] == last["total"] and visible == last["total"]
          and last["errored"] == 0)
    print(f"\n  RESULT: {'ALL ARRIVED' if ok else 'INCOMPLETE — see above'}\n")
    await engine.dispose()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=3000)
    ap.add_argument("--concurrency", type=int, default=10)
    ap.add_argument("--hunt", action="store_true",
                    help="weight the run past every layout budget (fault hunting)")
    ap.add_argument("--rps", type=float, default=8.0,
                    help="global request pacing; nginx allows 10r/s per client IP")
    ap.add_argument("--tokens", type=int, default=250)
    ap.add_argument("--spread-days", type=int, default=90)
    ap.add_argument("--rand-seed", type=int, default=20260816)
    ap.add_argument("--source", default=SOURCE_PROVIDER)
    ap.add_argument("--load-slug", default=LOAD_SLUG)
    ap.add_argument("--manifest", default="/tmp/eprf_journey_manifest.json")
    ap.add_argument("--wait", type=int, default=900)
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--verify", action="store_true")
    a = ap.parse_args()
    if a.verify:
        asyncio.run(verify(a))
    elif a.run or a.plan:
        asyncio.run(run(a))
    else:
        ap.error("pass --plan, --run or --verify")


if __name__ == "__main__":
    main()
