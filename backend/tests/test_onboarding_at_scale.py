"""Onboarding 100 clients by hand, which is what an admin worker is about to be
trained to do.

The bar this file defends is not "the endpoint returns 200". It is:

  * every provider gets back EXACTLY the details that were sent for it, and
    never another provider's — the failure the operator specifically fears;
  * a rejected entry leaves NOTHING behind, so the worker can correct the form
    and retry without a half-created client sitting in the list;
  * the identifiers that route a crew to a tenant (slug, portal login) and the
    identifier that names a logo on disk stay unique across the whole batch.

These run against the API, not the helpers, because the mistakes that actually
happen at 100 entries are ordering and state mistakes between the layers.
"""
import uuid

import pytest

# Every run gets its own namespace. Without it the second run collides with the
# first on the unique slug — these tests create real rows, and the suite must be
# repeatable rather than passing only against a pristine database.
RUN = uuid.uuid4().hex[:8]


@pytest.fixture
async def cleanup_providers(client, auth_headers):
    """Delete what the test created, so the dev database does not accumulate a
    hundred fake clients every time this runs."""
    created: list[str] = []
    yield created
    for pid in created:
        await client.delete(f"/api/providers/{pid}", headers=auth_headers)


def _payload(i: int) -> dict:
    """One realistic client. Distinct in every field, so a value belonging to a
    different provider is recognisable on sight rather than merely wrong."""
    return {
        "name": f"Scale {RUN} EMS {i:03d}",
        "pr_number": f"PR{i:05d}",
        "pty_reg_number": f"2026/{i:06d}/07",
        "phone": f"011000{i:04d}",
        "email": f"ops{i:03d}.{RUN}@scale.test",
        "address": f"{i} Scale Road, Johannesburg",
        "portal_login_email": f"client{i:03d}.{RUN}@scale.test",
        "portal_login_password": f"ScaleTest!{i:03d}aA",
        "admin_email": f"admin{i:03d}.{RUN}@scale.test",
        "admin_password": f"AdminTest!{i:03d}aA",
    }


@pytest.mark.asyncio
async def test_hundred_clients_keep_their_own_details(client, auth_headers, cleanup_providers):
    """Create a full batch, then read every one back and compare field by field.

    A cross-provider mix-up does not announce itself — the request succeeds and
    the wrong value is simply stored. Only a read-back of the whole batch after
    it is finished can see it, which is why this asserts at the end rather than
    per-iteration.
    """
    N = 100
    created: dict[str, dict] = {}

    for i in range(N):
        body = _payload(i)
        res = await client.post("/api/providers", json=body, headers=auth_headers)
        assert res.status_code in (200, 201), f"client {i} failed: {res.status_code} {res.text}"
        created[res.json()["id"]] = body
        cleanup_providers.append(res.json()["id"])

    assert len(created) == N, "two entries returned the same provider id"

    listed = (await client.get("/api/providers", headers=auth_headers)).json()
    by_id = {p["id"]: p for p in listed}

    for pid, sent in created.items():
        assert pid in by_id, f"provider {sent['name']} is missing from the list"
        got = by_id[pid]
        # Field-by-field, naming the provider in the message: a mismatch here is
        # one client's details attached to another's record.
        for field in ("name", "pr_number", "phone", "email", "address"):
            assert got.get(field) == sent[field], (
                f"{sent['name']}: {field} came back as {got.get(field)!r}, "
                f"expected {sent[field]!r}"
            )

    slugs = [by_id[pid]["slug"] for pid in created]
    assert len(set(slugs)) == len(slugs), "two providers share a slug — their logos would collide"


@pytest.mark.asyncio
async def test_a_rejected_client_leaves_nothing_behind(client, auth_headers, cleanup_providers):
    """A duplicate entry must not half-create.

    The admin crew member is added after db.flush(), so a clash there happens
    with the provider row already pending. If that path committed the provider
    anyway, the worker would see a new client in the list that they were just
    told was rejected — and would have no way to tell which of the two is real.
    """
    first = _payload(500)
    r1 = await client.post("/api/providers", json=first, headers=auth_headers)
    assert r1.status_code in (200, 201)
    cleanup_providers.append(r1.json()["id"])

    before = len((await client.get("/api/providers", headers=auth_headers)).json())

    # Same admin email, everything else different — rejected AFTER the provider
    # row is flushed.
    clash = _payload(501)
    clash["admin_email"] = first["admin_email"]
    res = await client.post("/api/providers", json=clash, headers=auth_headers)
    assert res.status_code == 400, f"expected a clean rejection, got {res.status_code}"

    after = (await client.get("/api/providers", headers=auth_headers)).json()
    assert len(after) == before, "the rejected entry left a provider behind"
    assert not any(p["name"] == clash["name"] for p in after), (
        "the rejected client is in the list"
    )


@pytest.mark.asyncio
async def test_duplicate_company_name_is_refused_not_merged(client, auth_headers, cleanup_providers):
    """Two clients with the same name resolve to the same slug.

    Refusing is correct — the slug routes crews to a tenant and names the logo
    file on disk, so silently reusing it would point one company's crews at
    another company's PRFs. What matters is that it is refused CLEANLY, and that
    the second attempt does not overwrite the first.
    """
    body = _payload(600)
    r = await client.post("/api/providers", json=body, headers=auth_headers)
    assert r.status_code in (200, 201)
    cleanup_providers.append(r.json()["id"])

    dup = _payload(601)
    dup["name"] = body["name"]                     # same name -> same slug
    res = await client.post("/api/providers", json=dup, headers=auth_headers)
    assert res.status_code == 400
    assert "slug" in res.text.lower() or "taken" in res.text.lower(), (
        f"the message does not tell the worker what went wrong: {res.text}"
    )

    listed = (await client.get("/api/providers", headers=auth_headers)).json()
    matches = [p for p in listed if p["name"] == body["name"]]
    assert len(matches) == 1, "the duplicate was created as well"
    # The survivor must be the FIRST one, untouched.
    assert matches[0]["pr_number"] == body["pr_number"], (
        "the second attempt overwrote the first client's details"
    )


@pytest.mark.asyncio
async def test_reusing_another_clients_login_is_refused_clearly(client, auth_headers, cleanup_providers):
    """Pasting one client's credentials onto another is the ordinary slip when
    working down a spreadsheet of 100. Both columns are DB-unique, so before
    this was pre-checked the worker got a bare 500 naming neither the field nor
    the client that already owned it — and could not tell whether the save had
    partly applied.
    """
    a = _payload(700)
    b = _payload(701)
    ra = await client.post("/api/providers", json=a, headers=auth_headers)
    rb = await client.post("/api/providers", json=b, headers=auth_headers)
    assert ra.status_code in (200, 201) and rb.status_code in (200, 201)
    b_id = rb.json()["id"]
    cleanup_providers.extend([ra.json()["id"], b_id])

    # A's portal login onto B.
    res = await client.patch(
        f"/api/providers/{b_id}",
        json={"portal_login_username": a["portal_login_email"]},
        headers=auth_headers,
    )
    assert res.status_code == 400, f"expected a clean 400, got {res.status_code}: {res.text[:200]}"
    assert a["portal_login_email"] in res.text, "the message does not name the offending value"

    # A's admin email onto B.
    res = await client.patch(
        f"/api/providers/{b_id}",
        json={"admin_email": a["admin_email"], "admin_password": "AdminTest!999aA"},
        headers=auth_headers,
    )
    assert res.status_code == 400, f"expected a clean 400, got {res.status_code}: {res.text[:200]}"

    # And B is untouched by either rejection.
    listed = (await client.get("/api/providers", headers=auth_headers)).json()
    b_row = next(p for p in listed if p["id"] == b_id)
    assert b_row["name"] == b["name"]


@pytest.mark.asyncio
async def test_a_client_can_still_edit_its_own_login(client, auth_headers, cleanup_providers):
    """The uniqueness guard must not block a client re-saving its OWN login —
    the settings dialog submits every field on every save, so a self-match would
    make the form permanently unsaveable.
    """
    body = _payload(800)
    res = await client.post("/api/providers", json=body, headers=auth_headers)
    pid = res.json()["id"]
    cleanup_providers.append(pid)

    same = await client.patch(
        f"/api/providers/{pid}",
        json={"portal_login_username": body["portal_login_email"], "phone": "0110000999"},
        headers=auth_headers,
    )
    assert same.status_code == 200, f"a client could not re-save its own login: {same.text[:200]}"


def test_branch_names_do_not_collide_on_case_number():
    """Two regional branches of one client must not generate the same case number.

    case_number is GLOBALLY unique but its readable part came from a 35-char
    truncation of the slug, so these two — which onboard perfectly happily,
    because their slugs differ — produced identical case numbers for the same
    PRF number in the same month. The second client's crew then could not open
    a PRF at all: _next_prf_number is deterministic, so every retry collided
    again.
    """
    import uuid as _uuid
    from app.api.digital_prf import _generate_case_number

    north = "gauteng-emergency-medical-services-north"
    south = "gauteng-emergency-medical-services-south"
    assert north[:35] == south[:35], "fixture no longer exercises the truncation"

    id_n, id_s = _uuid.uuid4(), _uuid.uuid4()
    cn = _generate_case_number(north, 1, id_n)
    cs = _generate_case_number(south, 1, id_s)

    assert cn != cs, f"both branches generated {cn}"
    assert len(cn) <= 50 and len(cs) <= 50, "case_number is a VARCHAR(50)"


def test_short_slugs_keep_their_existing_case_number_shape():
    """A slug of 35 chars or fewer cannot lose information to truncation, and
    slugs are unique — so those case numbers were never ambiguous and must not
    change appearance. JEMS-2026-08-000001 is what a scheme already sees."""
    import uuid as _uuid
    from datetime import datetime, timezone
    from app.api.digital_prf import _generate_case_number

    now = datetime.now(timezone.utc)
    cn = _generate_case_number("jems", 1730, _uuid.uuid4())
    assert cn == f"JEMS-{now.year}-{now.month:02d}-001730", cn
