"""
Locust load + burst harness for the Digital PRF.

Each simulated user is a crew member who logs in once and then repeatedly runs a
realistic PRF lifecycle:

    create draft → several autosaves (with optimistic-concurrency token)
                 → mark timestamps (with GPS) → final autosave with vitals
                 → submit

This mirrors what an ambulance crew actually does on a call, so the numbers you
get back reflect real-world load, not just a flat hammering of one endpoint.

USAGE
-----
1. Seed fixtures first (see seed_loadtest_data.py), which writes
   loadtest_fixtures.json next to this file.
2. Point at your STAGING stack and run the web UI:

       export LOADTEST_FIXTURES=./loadtest_fixtures.json
       locust -f locustfile.py --host https://staging.your-emr.co.za

   Then open http://localhost:8089 and set users / spawn rate.

3. Headless, with the built-in shift-change burst shape:

       USE_SHAPE=1 locust -f locustfile.py --host https://staging.your-emr.co.za \
           --headless --csv results

ENV VARS
--------
  LOADTEST_FIXTURES   path to fixtures JSON (default ./loadtest_fixtures.json)
  USE_SHAPE           "1" to enable the ShiftChangeShape below
  AUTOSAVES_PER_PRF   autosaves per call before submit (default 6)
  SUBMIT_RATIO        fraction of PRFs that get submitted vs left as draft (default 0.85)
  Shape tuning: SUSTAINED_USERS, BURST_USERS, BURST_AFTER_S, BURST_FOR_S, SPAWN_RATE
"""
from __future__ import annotations

import json
import os
import random
import time
from datetime import datetime, timezone
from pathlib import Path

from locust import HttpUser, task, between, events, LoadTestShape

# ── Config ──────────────────────────────────────────────────────────────────
FIXTURES_PATH = Path(os.getenv("LOADTEST_FIXTURES", Path(__file__).resolve().parent / "loadtest_fixtures.json"))
AUTOSAVES_PER_PRF = int(os.getenv("AUTOSAVES_PER_PRF", "6"))
SUBMIT_RATIO = float(os.getenv("SUBMIT_RATIO", "0.85"))

_CREWS: list[dict] = []


@events.test_start.add_listener
def _load_fixtures(environment, **_kwargs):
    global _CREWS
    if not FIXTURES_PATH.exists():
        raise SystemExit(
            f"Fixtures not found at {FIXTURES_PATH}. Run seed_loadtest_data.py first "
            f"or set LOADTEST_FIXTURES."
        )
    data = json.loads(FIXTURES_PATH.read_text())
    _CREWS = data.get("crews", [])
    if not _CREWS:
        raise SystemExit("No crews in fixtures file.")
    print(f"[loadtest] Loaded {len(_CREWS)} crew credential(s) from {FIXTURES_PATH}")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class CrewUser(HttpUser):
    """One simulated ambulance crew member working through PRFs."""
    # Think-time between full PRF cycles (a crew doesn't start a new call instantly).
    wait_time = between(2, 6)

    def on_start(self):
        cred = random.choice(_CREWS)
        self.cred = cred
        self.token = None
        with self.client.post(
            "/api/crew/login",
            json={"email": cred["email"], "password": cred["password"]},
            name="POST /api/crew/login",
            catch_response=True,
        ) as resp:
            if resp.status_code == 200:
                self.token = resp.json().get("access_token")
                self.client.headers.update({"Authorization": f"Bearer {self.token}"})
                resp.success()
            else:
                resp.failure(f"login failed: {resp.status_code} {resp.text[:200]}")

    # ── Helpers ───────────────────────────────────────────────────────────────
    def _km(self, base: int, leg: int) -> str:
        return f"{base + leg * 3}.{random.randint(0, 9)}"

    @task
    def full_prf_lifecycle(self):
        if not self.token:
            return  # login failed; nothing to do

        cred = self.cred
        # 1. Create draft
        with self.client.post(
            "/api/digital-prf",
            json={"vehicle_id": cred.get("vehicle_id")},
            name="POST /api/digital-prf (create)",
            catch_response=True,
        ) as resp:
            if resp.status_code != 201:
                resp.failure(f"create failed: {resp.status_code} {resp.text[:200]}")
                return
            prf_id = resp.json()["id"]
            resp.success()

        # Fetch the optimistic-concurrency token.
        base_updated_at = None
        with self.client.get(
            f"/api/digital-prf/{prf_id}",
            name="GET /api/digital-prf/[id]",
            catch_response=True,
        ) as resp:
            if resp.status_code == 200:
                base_updated_at = resp.json().get("updated_at")
                resp.success()
            else:
                resp.failure(f"get failed: {resp.status_code}")

        base_km = random.randint(20000, 80000)

        # 2. Mark a couple of real-time timestamps with GPS (like the crew taps).
        for i, field in enumerate(("time_dispatched", "time_on_scene")):
            payload = {
                "field": field,
                "km": self._km(base_km, i),
                "latitude": -26.2041 + random.uniform(-0.2, 0.2),
                "longitude": 28.0473 + random.uniform(-0.2, 0.2),
                "accuracy_m": random.randint(5, 30),
            }
            with self.client.post(
                f"/api/digital-prf/{prf_id}/mark-time",
                json=payload,
                name="POST /api/digital-prf/[id]/mark-time",
                catch_response=True,
            ) as resp:
                if resp.status_code != 200:
                    resp.failure(f"mark-time failed: {resp.status_code} {resp.text[:150]}")
                else:
                    resp.success()

        # 3. Autosaves — the form PATCHes every few seconds as the crew types.
        for n in range(AUTOSAVES_PER_PRF):
            form_data = {
                "call_type": "PRIMARY",
                "patient_name": "Load",
                "patient_surname": f"Test{n}",
                "medical_scheme": "GEMS",
                "events_hpi": "Simulated narrative " * (n + 1),
                "vitals_sets": [
                    {"hr": "80", "bp": "120/80", "spo2": "98", "resp": "16", "temp": "36.8",
                     "gcs_e": "4", "gcs_v": "5", "gcs_m": "6", "time": _now_iso()}
                ],
            }
            payload = {"form_data": form_data}
            if base_updated_at:
                payload["client_base_updated_at"] = base_updated_at
            with self.client.patch(
                f"/api/digital-prf/{prf_id}",
                json=payload,
                name="PATCH /api/digital-prf/[id] (autosave)",
                catch_response=True,
            ) as resp:
                if resp.status_code == 200:
                    base_updated_at = resp.json().get("updated_at") or base_updated_at
                    resp.success()
                elif resp.status_code == 409:
                    # Concurrency guard fired — refresh token and continue.
                    resp.success()
                    with self.client.get(
                        f"/api/digital-prf/{prf_id}", name="GET /api/digital-prf/[id]",
                        catch_response=True,
                    ) as g:
                        if g.status_code == 200:
                            base_updated_at = g.json().get("updated_at")
                            g.success()
                        else:
                            g.failure(f"refetch failed: {g.status_code}")
                else:
                    resp.failure(f"autosave failed: {resp.status_code} {resp.text[:150]}")
            time.sleep(random.uniform(0.2, 0.6))  # spacing between keystroke bursts

        # 4. Submit (most calls) or leave as draft.
        if random.random() <= SUBMIT_RATIO:
            with self.client.post(
                f"/api/digital-prf/{prf_id}/submit",
                name="POST /api/digital-prf/[id]/submit",
                catch_response=True,
            ) as resp:
                if resp.status_code in (200, 202):
                    resp.success()
                else:
                    resp.failure(f"submit failed: {resp.status_code} {resp.text[:200]}")


# ── Optional shift-change burst shape ────────────────────────────────────────
# Models a steady mid-shift load, then a sharp 06:00/18:00 spike, then recovery.
# Enable with USE_SHAPE=1. Tune via env vars.
class ShiftChangeShape(LoadTestShape):
    use_shape = os.getenv("USE_SHAPE") == "1"

    sustained = int(os.getenv("SUSTAINED_USERS", "60"))
    burst = int(os.getenv("BURST_USERS", "400"))
    burst_after_s = int(os.getenv("BURST_AFTER_S", "120"))
    burst_for_s = int(os.getenv("BURST_FOR_S", "120"))
    spawn_rate = int(os.getenv("SPAWN_RATE", "50"))
    total_s = burst_after_s + burst_for_s + 120

    def tick(self):
        if not self.use_shape:
            return None  # fall back to CLI -u/-r control
        run_time = self.get_run_time()
        if run_time > self.total_s:
            return None  # stop
        if run_time < self.burst_after_s:
            return (self.sustained, self.spawn_rate)
        if run_time < self.burst_after_s + self.burst_for_s:
            return (self.burst, self.spawn_rate)
        return (self.sustained, self.spawn_rate)
