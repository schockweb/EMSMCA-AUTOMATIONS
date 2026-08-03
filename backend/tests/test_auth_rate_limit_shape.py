"""
The auth limiter must let a shift start and still stop a password spray.

Measured on 2026-08-03: 200 crew signing in from one IP had **75% rejected**.
An ambulance base shares one station WiFi, and SA mobile carriers put many
subscribers behind one CGNAT address, so a whole shift change can arrive as a
single client IP. The limiter was locking out the people it exists to protect.

The fix counts the thing that actually separates them — a crew member SUCCEEDS,
an attacker FAILS — so these tests exist to prove the second half is still true.
A change that made sign-in pleasant and brute force cheap would pass a naive
"crews can log in" test and be strictly worse than what it replaced.
"""
import pytest

from app.middleware.rate_limit import RateLimitMiddleware, _is_auth_path

pytestmark = pytest.mark.asyncio


# ════════════════════════════════════════════════════════════════════
# Shape of the limits
# ════════════════════════════════════════════════════════════════════

def test_failures_are_limited_more_tightly_than_attempts():
    """Failures should cost more than successes — but both are FLOOD guards.

    An earlier version of this test asserted `auth_limit <= 20`, on the reasoning
    that the failed-attempt budget was the brute-force control. It is not, and
    the number that assertion demanded actively broke sign-in: after twenty
    mistyped passwords from one address, a crew member with the correct password
    is refused, which at a base of a hundred people on tablets is an ordinary
    morning. The credential control is the per-account lockout below.
    """
    mw = RateLimitMiddleware(app=None)
    assert mw.auth_limit < mw.auth_burst_limit, \
        "a failed attempt should cost at least as much as a successful one"


def test_a_whole_base_can_sign_on_within_the_burst_budget():
    """The number that failed in production. A station of ~100 crew arriving for
    a shift must not exhaust the per-IP allowance between them."""
    mw = RateLimitMiddleware(app=None)
    assert mw.auth_burst_limit >= 100, (
        f"auth_burst_limit={mw.auth_burst_limit} still throttles a shift change; "
        "200 crew from one IP measured 75% rejected at the old setting"
    )


def test_the_credential_endpoints_are_all_still_recognised_as_auth():
    """Relaxing the limit is only safe while every password path is still IN the
    auth bucket. If a path silently fell out it would inherit the ordinary
    600/min API budget instead."""
    for path in ("/api/auth/login", "/api/auth/refresh", "/api/crew/login",
                 "/api/crew/portal-unlock", "/api/crew/lookup-hpcsa",
                 "/api/crew/shift-start-by-id",
                 "/api/providers/jems/portal-login"):
        assert _is_auth_path(path), f"{path} is no longer rate-limited as an auth path"


def test_ordinary_paths_are_not_auth_paths():
    for path in ("/api/digital-prf", "/api/providers", "/health"):
        assert not _is_auth_path(path)


# ════════════════════════════════════════════════════════════════════
# Which responses count against the credential budget
# ════════════════════════════════════════════════════════════════════
#
# The middleware increments the failure bucket only for 401/403. These tests
# pin that rule by reading the source, because the alternative — standing up
# Redis, a real app and 150 requests — tests the same one-line decision far more
# slowly and far less clearly.

def _dispatch_source() -> str:
    import inspect
    return inspect.getsource(RateLimitMiddleware.dispatch)


def test_only_rejected_credentials_count_against_the_budget():
    src = _dispatch_source()
    assert "response.status_code in (401, 403)" in src, \
        "the failure bucket is no longer keyed on rejected-credential responses"


def test_a_malformed_body_or_a_429_does_not_count_as_a_guess():
    """422 is a malformed request, not a password attempt, and 429 is this
    limiter's own answer. Counting either would let a client lock itself out
    with requests that never tested a credential — and would make the block
    self-extending."""
    src = _dispatch_source()
    assert "422" not in src.split("response.status_code in")[1][:40], \
        "a validation error is being counted as a failed credential attempt"


def test_being_blocked_does_not_extend_the_block():
    """The pre-handler check must READ the failure counter, never increment it.
    An INCR there means a client that keeps retrying can never recover, because
    every rejection pushes the window forward."""
    src = _dispatch_source()
    head = src.split("response = await call_next")[0]
    assert "redis_client.get(fail_key)" in head, \
        "the pre-handler failure check should read the counter"
    assert "pipe.incr(fail_key)" not in head, (
        "the failure counter is incremented before the handler runs, so a "
        "blocked client extends its own block on every retry"
    )


def test_the_spray_is_stopped_before_bcrypt():
    """The rejection must happen in the middleware, not after the handler has
    already spent ~200 ms hashing. Otherwise the limiter caps damage but not
    cost, and the endpoint stays a CPU amplifier."""
    src = _dispatch_source()
    assert src.index("Too many failed sign-in attempts") < src.index("response = await call_next"), \
        "the failure-budget rejection happens after the handler has run"


# ════════════════════════════════════════════════════════════════════
# The controls this change relies on, which must still exist
# ════════════════════════════════════════════════════════════════════

def test_per_account_lockout_still_exists():
    """Relaxing the per-IP attempt count is only defensible because a single
    account still locks after a handful of failures, from ANY address. If that
    ever goes away, this change becomes a real weakening."""
    import inspect
    from app.api import crew_auth
    src = inspect.getsource(crew_auth)
    assert "MAX_FAILED_ATTEMPTS" in src and "locked_until" in src, \
        "per-account lockout is gone; the per-IP relaxation is no longer safe"
    assert crew_auth.MAX_FAILED_ATTEMPTS <= 10, \
        f"per-account lockout at {crew_auth.MAX_FAILED_ATTEMPTS} attempts is too loose"


def test_nginx_and_the_app_still_agree_on_the_credential_paths():
    """The nginx layer is what remains when Redis is down, because the app
    limiter fails open under exactly that condition. The two lists drifting
    apart is how /api/crew/portal-unlock ended up unprotected before."""
    from pathlib import Path
    conf = Path(__file__).resolve().parents[2] / "nginx" / "nginx.conf"
    if not conf.exists():
        pytest.skip("nginx.conf not present in this checkout")
    text = conf.read_text(encoding="utf-8")
    for fragment in ("portal-unlock", "lookup-hpcsa", "shift-start-by-id", "portal-login"):
        assert fragment in text, f"{fragment} has no nginx auth_limit location"
    assert "rate=100r/m" in text, \
        "nginx still throttles sign-in below what a shift change needs"
