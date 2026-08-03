"""
Seed the load-test database to the scale the platform is actually aimed at.

    docker cp loadtest/seed_scale.py lt_backend:/tmp/seed_scale.py
    docker exec -e PYTHONPATH=/app lt_backend python /tmp/seed_scale.py

Target, from the 2026-07-31 readiness scan: ~105 providers, ~1500 crew, 500+
ambulances. Production today is 3 providers / 13 crew / 105 PRFs, so a benchmark
against production-sized data would measure nothing: every query is fast when the
table fits in a couple of pages.

form_data SIZES MATTER MORE THAN ROW COUNT HERE. Provider PRF search does
`cast(form_data, Text).ilike(...)` over the whole blob, so the cost is driven by
the bytes detoasted, not by the number of rows. Production blobs run from about
1 KB to 1.1 MB. Seeding 10,000 uniformly tiny rows would produce a comfortable
number that means nothing.

Built through the ORM, not raw INSERTs. Several NOT NULL columns here
(service_providers.updated_at, vehicles.vehicle_type) take their value from a
PYTHON-side default on the model rather than a server default, so a hand-written
INSERT fails on a different column each time you fix the last one. The models
already know the answer.

Writes ONLY to the isolated load-test database; it refuses to run anywhere else.
"""
from __future__ import annotations

import asyncio
import os
import random
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, "/app")

from sqlalchemy import text                                   # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker         # noqa: E402

from app.database import engine                               # noqa: E402
from app.utils.security import hash_password                  # noqa: E402
from app.models.service_provider import ServiceProvider       # noqa: E402
from app.models.vehicle import Vehicle                        # noqa: E402
from app.models.crew_member import CrewMember                 # noqa: E402
from app.models.digital_prf import DigitalPRF                 # noqa: E402

PROVIDERS = int(os.getenv("LT_PROVIDERS", "105"))
CREW_PER_PROVIDER = int(os.getenv("LT_CREW_PER_PROVIDER", "14"))          # ~1470 crew
VEHICLES_PER_PROVIDER = int(os.getenv("LT_VEHICLES_PER_PROVIDER", "5"))   # ~525
PRFS = int(os.getenv("LT_PRFS", "10000"))
CREW_PASSWORD = os.getenv("LT_CREW_PASSWORD", "LoadTest-Crew-Pw-2026!")

SAFE_DB_MARKER = "ems_loadtest"

# CALIBRATED AGAINST PRODUCTION, 2026-08-03:
#   105 PRFs, avg form_data 150,260 bytes logical, 347,574 bytes on disk per row.
#
# The first version of this generator built its narrative by repeating one
# sentence, and produced 31 KB rows that TOAST squeezed to 1.5 KB on disk. That
# is 230x less I/O per row than production, and an ILIKE benchmark over it would
# have reported a comfortable number that meant nothing at all.
#
# Real PRFs are big and largely INCOMPRESSIBLE: crew and patient signatures, ID
# document captures and scene photos are base64 blobs. So the bulk here is
# random bytes, which TOAST cannot shrink either. Sizes below are chosen so the
# mean lands near production's 150 KB with a comparable long tail.
_IMG_BYTES = {"small": 12_000, "medium": 70_000, "large": 220_000, "huge": 650_000}
_VITALS = {"small": 2, "medium": 4, "large": 8, "huge": 14}

# Bucket mix chosen so the mean approximates production's 150 KB average.
BUCKETS = ["small"] * 40 + ["medium"] * 38 + ["large"] * 18 + ["huge"] * 4


def _incompressible(n: int) -> str:
    """base64 of random bytes: what a signature or photo actually looks like on
    disk, and immune to TOAST compression the way real image data is."""
    import base64
    return base64.b64encode(os.urandom(max(1, n * 3 // 4))).decode()


def _blob(bucket: str) -> dict:
    """A form_data payload of realistic shape and size."""
    narrative = "Patient found supine, alert and oriented, complaining of chest pain. "
    n_vitals = _VITALS[bucket]
    img = _IMG_BYTES[bucket]
    return {
        # The three fields that dominate a real PRF's size.
        "crew_signature": _incompressible(img // 6),
        "patient_signature": _incompressible(img // 6),
        "scene_photos": [_incompressible(img // 3), _incompressible(img // 3)],
        "call_type": random.choice(["PRIMARY", "TRANSFER", "RHT", "STANDBY"]),
        "patient_name": random.choice(["Thabo", "Anele", "Johan", "Priya", "Sipho", "Marike"]),
        "patient_surname": random.choice(["Nkosi", "Botha", "Naidoo", "Dlamini", "Van Wyk"]),
        "patient_id_number": (f"{random.randint(60, 99)}{random.randint(1, 12):02d}"
                              f"{random.randint(1, 28):02d}{random.randint(1000000, 9999999)}"),
        "medical_scheme": random.choice(["GEMS", "Discovery", "Bonitas", "Momentum", "PRIVATE"]),
        "chief_complaint": random.choice(["Chest pain", "MVA", "Seizure", "Shortness of breath"]),
        # Real narrative: repetitive enough to compress somewhat, but varied.
        "events_hpi": " ".join(random.sample(narrative.split() * 40, 200)),
        "vitals_sets": [
            {"hr": str(random.randint(50, 130)),
             "bp": f"{random.randint(90, 180)}/{random.randint(50, 110)}",
             "spo2": str(random.randint(88, 100)), "resp": str(random.randint(10, 30)),
             "temp": f"{random.uniform(35.5, 39.5):.1f}",
             "gcs_e": "4", "gcs_v": "5", "gcs_m": "6",
             "time": (datetime.now(timezone.utc) - timedelta(minutes=i * 5)).isoformat()}
            for i in range(n_vitals)
        ],
        "interventions": [{"name": f"IV line {i}", "time": f"10:0{i}", "by": "AEA"}
                          for i in range(n_vitals)],
    }


async def main() -> None:
    url = str(engine.url)
    if SAFE_DB_MARKER not in url:
        raise SystemExit(
            "REFUSING: this seeds tens of thousands of fake patient records and the "
            f"database is not the isolated load-test one (looking for '{SAFE_DB_MARKER}')."
        )
    print(f"seeding {url.split('@')[-1]}")

    Session = async_sessionmaker(engine, expire_on_commit=False)

    # One bcrypt, reused. Hashing 1,470 crew individually at ~200 ms each would
    # take five minutes and prove nothing; the hash is not what is under test.
    pw = hash_password(CREW_PASSWORD)

    veh_ids: dict = {}
    crew_ids: dict = {}

    async with Session() as db:
        print(f"providers: {PROVIDERS}")
        provs = [ServiceProvider(name=f"LoadTest EMS {p:03d}", slug=f"loadtest-{p:03d}",
                                 is_active=True) for p in range(PROVIDERS)]
        db.add_all(provs)
        await db.commit()
        prov_ids = [p.id for p in provs]

        print(f"vehicles:  {PROVIDERS * VEHICLES_PER_PROVIDER}")
        vehicles = []
        for pid in prov_ids:
            for v in range(VEHICLES_PER_PROVIDER):
                vehicles.append(Vehicle(provider_id=pid, callsign=f"A{v:02d}",
                                        registration=f"LT{uuid.uuid4().hex[:6].upper()}GP",
                                        is_active=True))
        db.add_all(vehicles)
        await db.commit()
        for v in vehicles:
            veh_ids.setdefault(v.provider_id, []).append(v.id)

        print(f"crew:      {PROVIDERS * CREW_PER_PROVIDER}")
        crews = []
        for n, pid in enumerate(prov_ids):
            for c in range(CREW_PER_PROVIDER):
                crews.append(CrewMember(provider_id=pid,
                                        email=f"crew{n:03d}-{c:02d}@loadtest.local",
                                        hashed_password=pw,
                                        full_name=f"Crew {n:03d}-{c:02d}",
                                        is_active=True))
        db.add_all(crews)
        await db.commit()
        for c in crews:
            crew_ids.setdefault(c.provider_id, []).append(c.id)

    print(f"PRFs:      {PRFS} (realistic size spread)")
    per_provider_seq = {p: 0 for p in prov_ids}
    done = 0
    BATCH = 500
    while done < PRFS:
        async with Session() as db:
            batch = []
            for _ in range(min(BATCH, PRFS - done)):
                pid = random.choice(prov_ids)
                per_provider_seq[pid] += 1
                ts = datetime.now(timezone.utc) - timedelta(days=random.randint(0, 365))
                batch.append(DigitalPRF(
                    provider_id=pid,
                    vehicle_id=random.choice(veh_ids[pid]),
                    crew_member_1_id=random.choice(crew_ids[pid]),
                    prf_number=per_provider_seq[pid],
                    status=random.choice(["DRAFT", "SUBMITTED", "PROCESSED",
                                          "PROCESSED", "PROCESSED"]),
                    form_data=_blob(random.choice(BUCKETS)),
                    created_at=ts, updated_at=ts,
                ))
                done += 1
            db.add_all(batch)
            await db.commit()
        if done % 2000 == 0:
            print(f"  {done}/{PRFS}")

    async with engine.connect() as c:
        size = (await c.execute(text(
            "select pg_size_pretty(pg_total_relation_size('digital_prfs'))"))).scalar()
        avg = (await c.execute(text(
            "select round(avg(length(form_data::text))) from digital_prfs"))).scalar()
        mx = (await c.execute(text(
            "select max(length(form_data::text)) from digital_prfs"))).scalar()
        print(f"\ndigital_prfs total size {size}, avg form_data {avg} bytes, max {mx} bytes")

    await engine.dispose()
    print("\nDONE")
    print(f"crew login: crew000-00@loadtest.local .. "
          f"crew{PROVIDERS - 1:03d}-{CREW_PER_PROVIDER - 1:02d}@loadtest.local")


asyncio.run(main())
