"""
Golden-claims replay — field-fidelity verification for the Digital PRF pipeline.

Feed it real, already-paid claims (CSV) and it replays each one through the
REAL pipeline exactly as a crew submission would travel:

    create PRF (API) -> save form_data (API) -> set times/kms -> submit (API)
    -> Celery worker -> Case/Document/Claim -> provider dashboard API
    -> EMSMCA cases API

then diffs what came OUT against what went IN, field by field, and prints a
per-claim report. Any dropped, mutated, or truncated field is a DIFF.

DEV STACK ONLY. Run inside the backend container:

    docker exec ems_backend python golden_claims_replay.py run [csv_path]
    docker exec ems_backend python golden_claims_replay.py cleanup

CSV format (header row required, UTF-8):
  * Any column whose name is a Digital-PRF form_data key is passed straight
    into the form (patient_name, patient_surname, patient_id_number,
    patient_dob, gender, age, medical_scheme, medical_aid_number,
    dependent_number, main_member_id, scheme_option, call_type, priority,
    assessment_level, billing_type, incident_location, suburb_ward,
    receiving_facility, ward, chief_complaint, preauth_number,
    transfer_subtype, ...).
  * incident_date (YYYY-MM-DD) — the calendar date the times below fall on.
  * time_call_received / time_dispatched / time_on_scene / time_depart_scene /
    time_at_destination / time_handover / time_available / time_back_to_base —
    "HH:MM" on incident_date (or full ISO).
  * km_dispatched / km_on_scene / km_depart_scene / km_at_destination /
    km_back_to_base — odometer readings.

Default CSV path: /app/golden_claims.csv  (backend/golden_claims.csv on host —
git-ignored; NEVER commit real patient data).

Replayed PRFs are tagged form_data.golden_replay=true so `cleanup` can remove
every record (PRF + Case + Document + Claim) in one pass. They are left in
place after `run` ON PURPOSE so you can open the dashboards and the PDF view
and eyeball the real thing.
"""
from __future__ import annotations
import csv
import json
import sys
import time
from datetime import datetime, timezone

# Reuse the proven plumbing from the E2E delivery harness (same directory).
from e2e_prf_pipeline_check import run_db, tokens, http, prf_row

TIME_KEYS = [
    "time_call_received", "time_dispatched", "time_on_scene",
    "time_depart_scene", "time_at_destination", "time_handover",
    "time_available", "time_back_to_base",
]
KM_KEYS = [
    "km_call_received", "km_dispatched", "km_on_scene", "km_depart_scene",
    "km_at_destination", "km_handover", "km_available", "km_back_to_base",
]
SPECIAL = set(TIME_KEYS) | set(KM_KEYS) | {"incident_date"}

DIFFS: list[str] = []
OKS: list[int] = [0]


def note(claim_no: str, level: str, field: str, detail: str):
    if level == "OK":
        OKS[0] += 1
        return
    line = f"  {level:9} {claim_no:>10}  {field:28} {detail}"
    DIFFS.append(line)
    print(line)


def eq(a, b) -> bool:
    """Loose equality: compare as trimmed strings; None == ''. """
    sa = "" if a is None else str(a).strip()
    sb = "" if b is None else str(b).strip()
    return sa == sb


def parse_when(incident_date: str, value: str) -> datetime | None:
    v = (value or "").strip()
    if not v:
        return None
    if "T" in v:  # full ISO
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    d = (incident_date or "").strip() or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    hh, mm = v.split(":")[:2]
    return datetime.fromisoformat(f"{d}T{int(hh):02d}:{int(mm):02d}:00+00:00")


def load_rows(path: str) -> list[dict]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        return [dict(r) for r in csv.DictReader(f)]


def replay_one(idx: int, row: dict, crew_tok: str, admin_tok: str, provider_id: str) -> dict | None:
    claim_no = row.get("claim_ref") or f"row{idx + 1}"

    # ── 1. Build form_data from the row ──
    fd = {k: v.strip() for k, v in row.items()
          if k and k not in SPECIAL and k != "claim_ref" and v and str(v).strip()}
    fd["golden_replay"] = True
    if not fd.get("call_type"):
        fd["call_type"] = "PRIMARY"

    # ── 2. Create + save via the real crew API ──
    st, body, _ = http("POST", "/api/digital-prf", crew_tok, {})
    if st != 201:
        note(claim_no, "FAIL", "create", f"HTTP {st}")
        return None
    prf_id = body["id"]
    st2, _, _ = http("PATCH", f"/api/digital-prf/{prf_id}", crew_tok, {"form_data": fd})
    if st2 != 200:
        note(claim_no, "FAIL", "save", f"HTTP {st2}")
        return None

    # ── 3. Times + kms straight onto the columns (historic values can't go
    #       through /mark-time, which always stamps NOW — the mark-time
    #       mechanism itself is covered by the E2E delivery campaign). ──
    incident_date = row.get("incident_date", "")

    async def set_times(db):
        from sqlalchemy import update
        from app.models.digital_prf import DigitalPRF
        vals: dict = {}
        for tk in TIME_KEYS:
            dt = parse_when(incident_date, row.get(tk, ""))
            if dt:
                vals[tk] = dt
        for kk in KM_KEYS:
            v = (row.get(kk) or "").strip()
            if v:
                vals[kk] = float(v)
        if vals:
            await db.execute(update(DigitalPRF).where(DigitalPRF.id == prf_id).values(**vals))
            await db.commit()
        return list(vals.keys())
    run_db(set_times)

    # ── 4. Submit through the real endpoint, wait for the worker ──
    st3, sub, _ = http("POST", f"/api/digital-prf/{prf_id}/submit", crew_tok)
    if st3 != 202:
        note(claim_no, "FAIL", "submit", f"HTTP {st3}: {json.dumps(sub)[:120]}")
        return None
    deadline = time.time() + 60
    state = None
    while time.time() < deadline:
        state = prf_row(prf_id)
        if state and state["status"] in ("processed", "failed") and (state["case_id"] or state["status"] == "failed"):
            break
        time.sleep(2)
    if not state or state["status"] != "processed" or not state["case_id"]:
        note(claim_no, "FAIL", "delivery", f"state={state}")
        return None

    # ── 5. Diff — DB layer (form_data round-trip, Case, Document adapter) ──
    async def diff_db(db):
        from sqlalchemy import select
        from app.models.digital_prf import DigitalPRF
        from app.models.case import Case
        from app.models.document import Document
        from app.models.claim import Claim

        p = (await db.execute(select(DigitalPRF).where(DigitalPRF.id == prf_id))).scalars().first()
        c = (await db.execute(select(Case).where(Case.id == p.case_id))).scalars().first()
        doc = (await db.execute(select(Document).where(Document.case_id == p.case_id))).scalars().first()
        nclaims = len((await db.execute(select(Claim.id).where(Claim.case_id == p.case_id))).scalars().all())

        # 5a. form_data round-trip: every input key must come back verbatim
        stored = p.form_data or {}
        for k, v in fd.items():
            if k == "golden_replay":
                continue
            if not eq(stored.get(k), v):
                note(claim_no, "MUTATED", f"form_data.{k}", f"in={v!r} out={stored.get(k)!r}")
            else:
                note(claim_no, "OK", k, "")

        # 5b. Case fields (what EMSMCA staff and the EDI layer see)
        full_name = " ".join(filter(None, [fd.get("patient_name"), fd.get("patient_surname")])).strip()
        if full_name and not eq(c.patient_name, full_name):
            note(claim_no, "MUTATED", "case.patient_name", f"in={full_name!r} out={c.patient_name!r}")
        pid_in = (fd.get("patient_id_number") or "").strip()
        if pid_in:
            if len(pid_in) <= 13:
                if not eq(c.patient_id_number, pid_in):
                    note(claim_no, "MUTATED", "case.patient_id_number", f"in={pid_in!r} out={c.patient_id_number!r}")
            else:
                # By design: invalid-length ID is dropped + review-flagged
                flags = [f.get("type") for f in (p.review_flags or [])]
                if c.patient_id_number is not None or "invalid_field_length" not in flags:
                    note(claim_no, "MUTATED", "case.patient_id_number",
                         f"over-length ID should be dropped+flagged; out={c.patient_id_number!r} flags={flags}")
                else:
                    note(claim_no, "OK", "id-guard", "")
        if fd.get("patient_dob") and c.patient_dob is None:
            note(claim_no, "MISSING", "case.patient_dob", f"in={fd.get('patient_dob')!r} parsed to None")
        if fd.get("medical_scheme") and not eq(c.medical_scheme_name, fd.get("medical_scheme")):
            note(claim_no, "MUTATED", "case.medical_scheme_name",
                 f"in={fd.get('medical_scheme')!r} out={c.medical_scheme_name!r}")
        if fd.get("medical_aid_number") and not eq(c.scheme_member_number, fd.get("medical_aid_number")):
            note(claim_no, "MUTATED", "case.scheme_member_number",
                 f"in={fd.get('medical_aid_number')!r} out={c.scheme_member_number!r}")
        if fd.get("dependent_number") and not eq(c.dependant_code, fd.get("dependent_number")):
            note(claim_no, "MUTATED", "case.dependant_code",
                 f"in={fd.get('dependent_number')!r} out={c.dependant_code!r}")
        if fd.get("preauth_number") and not eq(c.preauth_number, fd.get("preauth_number")):
            note(claim_no, "MUTATED", "case.preauth_number",
                 f"in={fd.get('preauth_number')!r} out={c.preauth_number!r}")
        if fd.get("incident_location") and not eq(c.incident_location, fd.get("incident_location")):
            note(claim_no, "MUTATED", "case.incident_location", "changed")
        # incident_date derives from time_call_received
        tcr = parse_when(incident_date, row.get("time_call_received", ""))
        if tcr and c.incident_date and c.incident_date != tcr.date():
            note(claim_no, "MUTATED", "case.incident_date", f"in={tcr.date()} out={c.incident_date}")
        # dispatch_type mapping
        ct = (fd.get("call_type") or "").upper()
        want_dispatch = "IFT" if ct in ("TRANSFER", "IHT", "IFT", "RHT", "COURTESY") else "Primary"
        if not eq(c.dispatch_type, want_dispatch):
            note(claim_no, "MUTATED", "case.dispatch_type", f"want={want_dispatch} out={c.dispatch_type}")

        # 5c. Document.extracted_data (adapter output)
        ed = (doc.extracted_data or {}) if doc else {}
        if full_name and not eq(ed.get("patient_name"), full_name):
            note(claim_no, "MUTATED", "extracted.patient_name", f"out={ed.get('patient_name')!r}")
        if fd.get("patient_dob") and not eq(ed.get("patient_dob"), fd.get("patient_dob")):
            note(claim_no, "MISSING", "extracted.patient_dob", f"out={ed.get('patient_dob')!r}")
        if fd.get("medical_aid_number") and not eq(ed.get("member_number"), fd.get("medical_aid_number")):
            note(claim_no, "MUTATED", "extracted.member_number", f"out={ed.get('member_number')!r}")
        for kk, ek in [("km_dispatched", "odometer_dispatch"), ("km_on_scene", "odometer_at_scene"),
                       ("km_depart_scene", "odometer_departure"), ("km_at_destination", "odometer_destination"),
                       ("km_back_to_base", "odometer_rtb")]:
            v = (row.get(kk) or "").strip()
            if v and (ed.get(ek) is None or abs(float(ed.get(ek)) - float(v)) > 0.01):
                note(claim_no, "MISSING", f"extracted.{ek}", f"in={v} out={ed.get(ek)}")

        # 5d. timestamps survived onto the PRF columns (what the PDF times band reads)
        for tk in TIME_KEYS:
            want = parse_when(incident_date, row.get(tk, ""))
            got = getattr(p, tk)
            if want and (not got or got.replace(tzinfo=timezone.utc).strftime("%H:%M")
                         != want.strftime("%H:%M")):
                note(claim_no, "MISSING", f"prf.{tk}", f"in={want} out={got}")

        if nclaims != 1:
            note(claim_no, "FAIL", "claims", f"expected exactly 1 claim, found {nclaims}")
        return str(p.case_id)
    case_id = run_db(diff_db)

    # ── 6. Diff — the two dashboards (the exact APIs the UIs call) ──
    st4, items, _ = http("GET",
                         f"/api/providers/{provider_id}/prfs?search={fd.get('patient_surname') or fd.get('patient_name') or ''}&limit=200",
                         admin_tok)
    rows = items if isinstance(items, list) else items.get("items", [])
    mine = [r for r in rows if r.get("case_id") == case_id]
    if st4 != 200 or not mine:
        note(claim_no, "MISSING", "provider-dashboard", f"HTTP {st4}; row for case not returned by search")
    else:
        full_name = " ".join(filter(None, [fd.get("patient_name"), fd.get("patient_surname")])).strip()
        if full_name and not eq(mine[0].get("patient_name"), full_name):
            note(claim_no, "MUTATED", "provider.patient_name", f"out={mine[0].get('patient_name')!r}")
        if not eq(mine[0].get("call_type"), fd.get("call_type")):
            note(claim_no, "MUTATED", "provider.call_type", f"out={mine[0].get('call_type')!r}")

    st5, cases, _ = http("GET",
                         f"/api/cases/?queue=management&search={fd.get('patient_surname') or ''}&limit=200",
                         admin_tok)
    found = [c for c in cases if c["id"] == case_id] if st5 == 200 else []
    if not found:
        note(claim_no, "MISSING", "emsmca-dashboard", f"HTTP {st5}; case not in management queue search")

    print(f"  done      {claim_no:>10}  case={case_id}")
    return {"claim": claim_no, "prf_id": prf_id, "case_id": case_id}


def cmd_run(csv_path: str):
    rows = load_rows(csv_path)
    print(f"golden replay: {len(rows)} claim(s) from {csv_path}\n")
    admin_tok, crew_tok, provider_id = tokens()
    results = []
    for i, row in enumerate(rows):
        results.append(replay_one(i, row, crew_tok, admin_tok, provider_id))
    done = [r for r in results if r]
    print(f"\n══ SUMMARY ═══════════════════════════════════════════")
    print(f"claims replayed : {len(done)}/{len(rows)}")
    print(f"field checks OK : {OKS[0]}")
    print(f"diffs/failures  : {len(DIFFS)}")
    if DIFFS:
        print("\nALL DIFFS:")
        for d in DIFFS:
            print(d)
    print("\nRecords are kept for eyeballing (dashboards + PDF view).")
    print("Remove them with:  python golden_claims_replay.py cleanup")
    sys.exit(1 if DIFFS else 0)


def cmd_cleanup():
    async def run(db):
        from sqlalchemy import select, delete
        from app.models.digital_prf import DigitalPRF
        from app.models.case import Case
        from app.models.claim import Claim
        from app.models.claim_line import ClaimLine
        from app.models.document import Document
        prfs = (await db.execute(
            select(DigitalPRF).where(DigitalPRF.form_data["golden_replay"].as_boolean() == True)  # noqa: E712
        )).scalars().all()
        case_ids = [p.case_id for p in prfs if p.case_id]
        claim_ids = (await db.execute(select(Claim.id).where(Claim.case_id.in_(case_ids)))).scalars().all() if case_ids else []
        if claim_ids:
            await db.execute(delete(ClaimLine).where(ClaimLine.claim_id.in_(claim_ids)))
            await db.execute(delete(Claim).where(Claim.id.in_(claim_ids)))
        for p in prfs:
            p.case_id = None
            p.document_id = None
        await db.flush()
        if case_ids:
            await db.execute(delete(Document).where(Document.case_id.in_(case_ids)))
            await db.execute(delete(Case).where(Case.id.in_(case_ids)))
        for p in prfs:
            await db.delete(p)
        await db.commit()
        print(f"cleanup: removed {len(prfs)} golden-replay PRFs, {len(case_ids)} cases, {len(claim_ids)} claims")
    run_db(run)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "cleanup":
        cmd_cleanup()
    else:
        path = sys.argv[2] if len(sys.argv) > 2 else "/app/golden_claims.csv"
        cmd_run(path)
