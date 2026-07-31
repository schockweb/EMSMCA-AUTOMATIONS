"""
The /uploads static mount is UNAUTHENTICATED. It must serve web assets only.

StaticFiles does not run route dependencies, and nginx proxies the whole
`^~ /uploads/` prefix, so anything reachable under this mount is world-readable
to anyone holding the URL.

It used to be a DENYLIST that blocked exactly one prefix — `prf_email/` — and
served everything else on the same volume. That included `raw/`, the scanned
patient PRFs (66 of them on the dev machine at the time this was found; the
production volume happened to hold only logos, so the exposure was latent there
rather than live). A denylist over a directory other code writes into is
guaranteed to fall behind: the next subdirectory anyone adds is public by
default.
"""
import os
import uuid

import pytest
import pytest_asyncio

from app.config import get_settings


PUBLIC_DIRS = ["logos", "crew", "vehicles"]

# Everything else on the volume. raw/ and guidelines/ hold patient documents;
# prf_email/ is the worker spool of full PRF PDFs awaiting the email task.
PRIVATE_DIRS = ["raw", "guidelines", "prf_email", "processed", "exports", "backups"]

_CANARY = b"%PDF-1.4 CANARY-PATIENT-RECORD-MUST-NOT-BE-SERVED"


@pytest_asyncio.fixture
async def planted_files():
    """Write a REAL file into each directory, then remove it.

    Without this the private-directory tests are vacuous: a request for a file
    that does not exist 404s whether the guard blocks the prefix or StaticFiles
    simply cannot find it. Reverting the allowlist to the old denylist left
    every one of those tests passing. They only mean something when the bytes
    are actually on disk and still are not served.
    """
    root = get_settings().UPLOAD_DIR or "./uploads"
    written = []
    for d in PRIVATE_DIRS + PUBLIC_DIRS:
        target_dir = os.path.join(root, d)
        try:
            os.makedirs(target_dir, exist_ok=True)
            path = os.path.join(target_dir, f"canary-{uuid.uuid4().hex[:8]}.pdf")
            with open(path, "wb") as fh:
                fh.write(_CANARY)
            written.append((d, os.path.basename(path)))
        except OSError:
            continue
    yield dict(written)
    for d, name in written:
        try:
            os.remove(os.path.join(root, d, name))
        except OSError:
            pass


@pytest.mark.asyncio
@pytest.mark.parametrize("d", PRIVATE_DIRS)
async def test_private_upload_dirs_do_not_serve_a_real_file(client, planted_files, d):
    """The file EXISTS on disk and must still not be served."""
    name = planted_files.get(d)
    if name is None:
        pytest.skip(f"could not plant a file in {d}")

    resp = await client.get(f"/uploads/{d}/{name}")
    assert resp.status_code == 404, (
        f"/uploads/{d}/{name} returned {resp.status_code} for a file that is "
        f"really on disk — this mount is unauthenticated, so that content is "
        f"public to anyone with the URL"
    )
    assert _CANARY not in resp.content, f"/uploads/{d}/ served real file bytes"


@pytest.mark.asyncio
async def test_a_planted_public_asset_IS_served(client, planted_files):
    """The counterpart: proves the guard is not simply blocking everything, and
    that the private-directory assertions above are meaningful rather than a
    blanket 404."""
    name = planted_files.get("logos")
    if name is None:
        pytest.skip("could not plant a file in logos")

    resp = await client.get(f"/uploads/logos/{name}")
    assert resp.status_code == 200, (
        f"/uploads/logos/{name} returned {resp.status_code}; the SPA cannot "
        f"load provider logos"
    )
    assert resp.content == _CANARY


@pytest.mark.asyncio
@pytest.mark.parametrize("d", PUBLIC_DIRS)
async def test_public_asset_dirs_are_still_reachable(client, d):
    """The allowlist must not break the SPA's <img> tags.

    A missing file 404s too, so status alone cannot tell "blocked by the prefix
    guard" from "reached StaticFiles and the file isn't there". The two are
    distinguishable by the response the app actually produces:

      blocked prefix  -> our PlainTextResponse: text/plain, body "Not Found"
      allowed prefix  -> Starlette's own 404:   application/json, {"detail": ...}

    Asserting on the content type is what makes this non-vacuous. An earlier
    version ended in `or d in PUBLIC_DIRS`, which is always true for a
    parametrised PUBLIC_DIR and therefore asserted nothing at all.
    """
    resp = await client.get(f"/uploads/{d}/does-not-exist.png")
    assert resp.status_code == 404
    assert resp.headers.get("content-type", "").startswith("application/json"), (
        f"/uploads/{d}/ was rejected by the prefix guard (got "
        f"{resp.headers.get('content-type')!r}) instead of reaching StaticFiles — "
        f"the SPA cannot load its {d} assets"
    )


@pytest.mark.asyncio
async def test_bare_uploads_root_is_not_a_listing(client):
    resp = await client.get("/uploads/")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_prefix_confusion_does_not_bypass_the_allowlist(client):
    """`logos` is allowed; `logos-private` and `raw` must not ride on it.

    str.startswith("logos/") is prefix matching, so the trailing slash is what
    stops a sibling directory whose name merely begins with an allowed one.
    """
    for path in [
        "raw/patient.pdf",
        "logos-private/secret.pdf",
        "crewdata/roster.csv",
        "../raw/patient.pdf",
        "prf_email/../raw/patient.pdf",
    ]:
        resp = await client.get(f"/uploads/{path}")
        assert resp.status_code == 404, f"/uploads/{path} returned {resp.status_code}"


def test_the_guard_is_an_allowlist_not_a_denylist():
    """Pin the design. A denylist here silently re-exposes every new directory."""
    from app.main import _HardenedUploads

    assert hasattr(_HardenedUploads, "_PUBLIC_PREFIXES"), (
        "the uploads guard is no longer an allowlist"
    )
    assert not hasattr(_HardenedUploads, "_PRIVATE_PREFIXES"), (
        "a denylist has been reintroduced alongside the allowlist"
    )
    for p in _HardenedUploads._PUBLIC_PREFIXES:
        assert p.endswith("/"), (
            f"allowlist entry {p!r} has no trailing slash, so a sibling "
            f"directory whose name merely starts with it would be served"
        )
