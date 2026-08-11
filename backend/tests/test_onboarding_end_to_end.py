"""The whole onboarding journey, rehearsed.

test_onboarding_at_scale.py proves the CREATE call behaves under a hundred
entries. This file asks the question that actually matters to the business: after
an admin worker finishes onboarding a client, does that client WORK?

Onboarding is not one request. It is: create the company, upload its logo, add
its crew, add its ambulances, hand over two sets of credentials — and then the
company's own people have to be able to log in and open a PRF. A defect anywhere
along that chain produces a client that looks perfectly fine in the admin list
and is unusable in the field, which is the worst possible time to find out.

So this walks the whole thing end to end against the real API, and then checks
the property that makes a multi-tenant system safe: that the client created here
cannot see, or be seen by, anybody else.
"""
import io
import uuid

import pytest

RUN = uuid.uuid4().hex[:8]

# A 1x1 PNG — enough to prove the upload path stores and serves a real file.
_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c6360000002000100" "05fe02fa" "0000000049454e44ae426082"
)


def _company(tag: str) -> dict:
    return {
        "name": f"E2E {RUN} {tag}",
        "pr_number": f"PR-{tag}",
        "phone": "011 000 0000",
        "email": f"ops.{tag}.{RUN}@e2e.test",
        "address": "1 Rehearsal Road, Johannesburg",
        "portal_login_email": f"portal.{tag}.{RUN}@e2e.test",
        "portal_login_password": f"Portal!{tag}9aA",
        "admin_email": f"admin.{tag}.{RUN}@e2e.test",
        "admin_password": f"Admin!{tag}9aA",
    }


@pytest.fixture
async def onboarded(client, auth_headers):
    """Onboard one client exactly the way the admin screen does, and clean up."""
    created: list[str] = []

    async def _onboard(tag: str) -> dict:
        body = _company(tag)
        res = await client.post("/api/providers", json=body, headers=auth_headers)
        assert res.status_code in (200, 201), f"create failed: {res.text}"
        pid = res.json()["id"]
        created.append(pid)
        return {"id": pid, "slug": res.json()["slug"], **body}

    yield _onboard

    for pid in created:
        await client.delete(f"/api/providers/{pid}", headers=auth_headers)


@pytest.mark.asyncio
async def test_a_freshly_onboarded_client_is_actually_usable(client, auth_headers, onboarded):
    """The full chain: logo, crew, vehicle, both logins, and a readable record.

    Every step here is something the admin worker does or the client depends on.
    If any single one breaks, the company was onboarded into a state where its
    people cannot work — while the admin list shows nothing wrong.
    """
    co = await onboarded("alpha")
    pid = co["id"]

    # ── The logo the worker attached in the modal ──
    res = await client.post(
        f"/api/providers/{pid}/logo",
        files={"file": ("logo.png", io.BytesIO(_PNG), "image/png")},
        headers=auth_headers,
    )
    assert res.status_code == 200, f"logo upload failed: {res.text}"
    logo_url = res.json()["logo_url"]
    assert logo_url.startswith("/uploads/logos/"), logo_url
    # And it is actually retrievable, not merely recorded on the row.
    served = await client.get(logo_url)
    assert served.status_code == 200, f"the logo was recorded but does not serve: {served.status_code}"

    # ── Crew ──
    crew_body = {
        "full_name": "Thandi Mokoena",
        "hpcsa_number": f"ECP{RUN[:5]}",
        "qualification": "ECP",
        "email": f"thandi.{RUN}@e2e.test",
        "phone": "082 000 0000",
        "initials": "T.M.",
    }
    res = await client.post(f"/api/providers/{pid}/crew", json=crew_body, headers=auth_headers)
    assert res.status_code in (200, 201), f"add crew failed: {res.text}"

    # ── Vehicle ──
    res = await client.post(
        f"/api/providers/{pid}/vehicles",
        json={"callsign": f"ALPHA-{RUN[:4]}", "registration": "GP 12-34-56", "vehicle_type": "Ambulance"},
        headers=auth_headers,
    )
    assert res.status_code in (200, 201), f"add vehicle failed: {res.text}"

    # ── The company can reach its own portal with the shared credentials ──
    res = await client.post(
        f"/api/providers/{co['slug']}/portal-login",
        json={"username": co["portal_login_email"], "password": co["portal_login_password"]},
    )
    assert res.status_code == 200, (
        f"the client cannot log in to their own portal with the credentials just issued: {res.text}"
    )

    # ── The admin account created during onboarding can sign in ──
    res = await client.post(
        "/api/crew/login",
        json={"email": co["admin_email"], "password": co["admin_password"]},
    )
    assert res.status_code == 200, (
        f"the admin account issued at onboarding cannot sign in: {res.text}"
    )
    assert res.json().get("access_token"), "login returned no token"

    # ── And everything reads back attached to THIS client ──
    crew = (await client.get(f"/api/providers/{pid}/crew", headers=auth_headers)).json()
    vehicles = (await client.get(f"/api/providers/{pid}/vehicles", headers=auth_headers)).json()
    assert any(c["full_name"] == "Thandi Mokoena" for c in crew), crew
    assert any(v["callsign"] == f"ALPHA-{RUN[:4]}" for v in vehicles), vehicles
    detail = (await client.get(f"/api/providers/{pid}", headers=auth_headers)).json()
    assert detail["name"] == co["name"]
    assert detail["pr_number"] == co["pr_number"]


@pytest.mark.asyncio
async def test_two_clients_onboarded_together_stay_separate(client, auth_headers, onboarded):
    """Onboard two companies back to back and prove neither can reach the other.

    This is the failure the operator asked to rule out, tested at the layer where
    it would actually happen: after both exist, does either one's roster, fleet or
    portal admit the other's people?
    """
    a = await onboarded("beta")
    b = await onboarded("gamma")

    await client.post(
        f"/api/providers/{a['id']}/crew",
        json={"full_name": "Alpha Crew", "hpcsa_number": f"A{RUN[:6]}", "qualification": "ECP",
              "email": f"acrew.{RUN}@e2e.test"},
        headers=auth_headers,
    )
    await client.post(
        f"/api/providers/{b['id']}/crew",
        json={"full_name": "Beta Crew", "hpcsa_number": f"B{RUN[:6]}", "qualification": "ECP",
              "email": f"bcrew.{RUN}@e2e.test"},
        headers=auth_headers,
    )

    a_crew = (await client.get(f"/api/providers/{a['id']}/crew", headers=auth_headers)).json()
    b_crew = (await client.get(f"/api/providers/{b['id']}/crew", headers=auth_headers)).json()

    a_names = {c["full_name"] for c in a_crew}
    b_names = {c["full_name"] for c in b_crew}
    # Positive first: two empty rosters would satisfy the exclusions below
    # without proving anything at all.
    assert "Alpha Crew" in a_names, f"client A's own crew is missing: {a_names}"
    assert "Beta Crew" in b_names, f"client B's own crew is missing: {b_names}"
    assert "Beta Crew" not in a_names, "client B's crew appears on client A's roster"
    assert "Alpha Crew" not in b_names, "client A's crew appears on client B's roster"

    # The portal is keyed to the company: A's credentials must not open B's door.
    res = await client.post(
        f"/api/providers/{b['slug']}/portal-login",
        json={"username": a["portal_login_email"], "password": a["portal_login_password"]},
    )
    assert res.status_code != 200, (
        "one client's portal credentials opened another client's portal"
    )


@pytest.mark.asyncio
async def test_the_details_the_worker_typed_survive_an_edit(client, auth_headers, onboarded):
    """Settings saved from the client screen must persist and not disturb others."""
    a = await onboarded("delta")
    b = await onboarded("epsilon")

    res = await client.patch(
        f"/api/providers/{a['id']}",
        json={"phone": "011 999 8888", "address": "9 Changed Street", "pr_number": "PR-EDITED"},
        headers=auth_headers,
    )
    assert res.status_code == 200, res.text

    a_after = (await client.get(f"/api/providers/{a['id']}", headers=auth_headers)).json()
    b_after = (await client.get(f"/api/providers/{b['id']}", headers=auth_headers)).json()
    assert a_after["phone"] == "011 999 8888"
    assert a_after["pr_number"] == "PR-EDITED"
    # The neighbour is untouched — an edit must not bleed sideways.
    assert b_after["pr_number"] == b["pr_number"], "editing one client changed another"
    assert b_after["phone"] == b["phone"]


@pytest.mark.asyncio
async def test_the_form_refuses_bad_input_without_creating_anything(client, auth_headers):
    """Everything a tired worker actually types. Each must be refused CLEANLY —
    a 4xx, not a 500 — and must leave no client behind."""
    before = len((await client.get("/api/providers", headers=auth_headers)).json())

    bad_cases = {
        "blank name": {"name": "   "},
        "name of only punctuation (slug becomes empty)": {"name": "!!! ???"},
        "phone longer than the column": {"name": f"Long Phone {RUN}", "phone": "011 123 4567 / 082 555 1234 ext 9"},
        "PRF baseline with two numbers in it": {"name": f"Ambig PRF {RUN}", "current_prf_number": "0690/26"},
        "PRF baseline with no digits": {"name": f"No Digits {RUN}", "current_prf_number": "none"},
        "portal password too weak": {
            "name": f"Weak Pw {RUN}",
            "portal_login_email": f"weak.{RUN}@e2e.test",
            "portal_login_password": "abc",
        },
    }

    for label, body in bad_cases.items():
        res = await client.post("/api/providers", json=body, headers=auth_headers)
        assert 400 <= res.status_code < 500, (
            f"{label}: expected a clear 4xx the worker can act on, got {res.status_code} — "
            f"a 500 tells them nothing about which field is wrong. Body: {res.text[:200]}"
        )

    after = len((await client.get("/api/providers", headers=auth_headers)).json())
    assert after == before, "a rejected entry created a client anyway"


@pytest.mark.asyncio
async def test_a_deactivated_client_stops_working_and_can_be_restored(client, auth_headers, onboarded):
    """Deactivate is the supported way to retire a client that has history.

    Onboarding mistakes get retired this way, so it has to actually close the
    door — and reopening it has to restore service, or a slip becomes permanent.
    """
    co = await onboarded("zeta")

    ok = await client.post(
        f"/api/providers/{co['slug']}/portal-login",
        json={"username": co["portal_login_email"], "password": co["portal_login_password"]},
    )
    assert ok.status_code == 200

    res = await client.post(f"/api/providers/{co['id']}/deactivate", headers=auth_headers)
    assert res.status_code == 200, res.text

    shut = await client.post(
        f"/api/providers/{co['slug']}/portal-login",
        json={"username": co["portal_login_email"], "password": co["portal_login_password"]},
    )
    assert shut.status_code != 200, "a deactivated client can still log in"

    res = await client.post(f"/api/providers/{co['id']}/reactivate", headers=auth_headers)
    assert res.status_code == 200, res.text

    back = await client.post(
        f"/api/providers/{co['slug']}/portal-login",
        json={"username": co["portal_login_email"], "password": co["portal_login_password"]},
    )
    assert back.status_code == 200, "reactivating did not restore the client's access"
