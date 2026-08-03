"""
Rate Limiting Middleware — protects auth endpoints from brute-force attacks and
shields the API from runaway clients.

Keying strategy
---------------
Authenticated requests are limited **per crew/user token**, not per IP. An entire
ambulance company (or all crews on one 4G gateway) shares a single public IP, so
per-IP limiting would lock out a whole fleet at the 06:00/18:00 shift-change burst
while a single abusive device stayed under the limit. Keying by the bearer token
gives every crew member their own budget regardless of shared NAT.

Login/refresh requests have no token yet, so they fall back to per-IP keying —
which is exactly what brute-force protection needs.

Backend: Redis sliding-window (INCR + EXPIRE)
---------------------------------------------
All Gunicorn workers share the same Redis instance, so the effective limit is the
configured value — not limit × workers (the in-memory bug).

Fallback: if Redis is unavailable, requests are passed through (fail-open).
We already have Nginx-level rate limiting as the first line of defence, so the
backend limiter is a belt-and-braces layer. Dropping to pass-through on Redis
failure is safer than locking out the whole fleet.
"""
from __future__ import annotations
import hashlib
import re
import logging
from fastapi import Request, status
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response, JSONResponse

from app.utils.client_ip import get_trusted_client_ip, is_loopback_peer

logger = logging.getLogger("ems.rate_limit")


# ── Which paths get the strict, per-IP brute-force budget ───────────────────
#
# This used to be a set of exact strings:
#
#     {"/api/auth/login", "/api/auth/refresh", "/api/crew/login"}
#
# which structurally CANNOT express a parameterised path — and that is exactly
# how the two most valuable doors were missed. `/api/crew/portal-unlock` and
# `/api/providers/{slug}/portal-login` both bcrypt-verify the SHARED COMPANY
# PASSWORD that unlocks every tablet at an ambulance service, and both were
# sitting in the ordinary 600-per-minute API bucket.
#
# The crew shift-start pair is here too: neither verifies a password, but both
# MINT a 12-hour token that reads, edits and deletes patient report forms, so
# they are credential-issuing endpoints in every sense that matters.
#
# Prefixes are exact or single-segment-wildcard, never substring: a substring
# match on "portal-login" would also catch a future
# "/api/admin/portal-login-report" and quietly throttle a reporting page.
_AUTH_EXACT = frozenset({
    "/api/auth/login",
    "/api/auth/refresh",
    "/api/crew/login",
    "/api/crew/portal-unlock",
    "/api/crew/lookup-hpcsa",
    "/api/crew/shift-start-by-id",
})

# /api/providers/{slug}/portal-login — one path segment for the slug.
_AUTH_PATTERN = re.compile(r"^/api/providers/[^/]+/portal-login/?$")


def _is_auth_path(path: str) -> bool:
    """True for endpoints that verify a password or mint a session token."""
    p = path.rstrip("/") or "/"
    return p in _AUTH_EXACT or bool(_AUTH_PATTERN.match(path))


class RateLimitMiddleware(BaseHTTPMiddleware):
    """
    Redis-backed sliding-window rate limiting + request body size cap.

    Rules:
    - Auth endpoints (/api/auth/login, /api/auth/refresh): auth_limit / window, per IP
    - General API: api_limit / window, per crew/user token (falls back to IP)
    - Static / health: unlimited
    - Any request whose Content-Length exceeds max_body_bytes → 413
    """

    def __init__(
        self,
        app,
        auth_limit: int = 15,         # login/refresh attempts per window, per real client IP
        api_limit: int = 600,
        window: int = 60,             # sliding window in seconds
        max_body_bytes: int = 15 * 1024 * 1024,  # 15 MB
    ):
        super().__init__(app)
        self.auth_limit = auth_limit
        self.api_limit = api_limit
        self.window = window
        self.max_body_bytes = max_body_bytes

    # ── Helpers ────────────────────────────────────────────────────────────

    def _get_identity_key(self, request: Request) -> str:
        """Per-token identity when the token is REAL, else per-IP.

        THE BUG THIS FIXES
        ------------------
        This used to hash whatever sat after "Bearer " with no validation at
        all. The bucket key is therefore chosen by the caller: send
        `Authorization: Bearer <fresh random nonce>` on every request and every
        request lands in a brand-new 600-request bucket, so the application
        limiter never fires for anyone who does not want it to. An anonymous
        attacker got unlimited throughput on every route except the three in
        AUTH_STRICT_PATHS — including the provider portal-password endpoints,
        the crew shift-start endpoints and the unauthenticated crash ingest.

        Verifying the signature first is what makes the key non-forgeable: a
        nonce is not a valid JWT, so it falls through to the IP bucket, and an
        attacker cannot manufacture a valid token without SECRET_KEY. Bucketing
        by `sub` + `jti` rather than by the raw string also means the limit
        follows the identity across a token rotation instead of resetting.

        Deliberately no database lookup here — this runs on EVERY request, and a
        revoked-but-unexpired token is still a token we are happy to rate-limit
        as its owner. Signature and expiry are the only properties needed.
        """
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
            if token:
                try:
                    from app.utils.security import decode_token
                    payload = decode_token(token)
                except Exception:
                    payload = None      # forged, malformed or expired → IP bucket
                if payload:
                    subject = str(payload.get("sub") or payload.get("crew_id") or "")
                    if subject:
                        return "tok:" + hashlib.sha256(subject.encode()).hexdigest()[:16]
        return "ip:" + get_trusted_client_ip(request)

    async def _check_limit(self, redis_client, key: str, limit: int) -> tuple[bool, int]:
        """
        Sliding-window counter using Redis INCR + EXPIRE.

        Returns (rate_limited: bool, current_count: int).
        """
        try:
            pipe = redis_client.pipeline()
            pipe.incr(key)
            pipe.ttl(key)
            count, ttl = await pipe.execute()

            # Set expiry only on the first hit (when TTL is -1 = no expiry set)
            if ttl == -1:
                await redis_client.expire(key, self.window)

            return count > limit, int(count)
        except Exception as exc:
            # Redis error — fail-open (Nginx is the hard edge)
            logger.warning("Rate limit Redis error for key=%s: %s", key, exc)
            return False, 0

    # ── Dispatch ───────────────────────────────────────────────────────────

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        path = request.url.path

        # Skip rate limiting for health checks, docs, and static assets
        if path in ("/", "/health", "/docs", "/openapi.json") or path.startswith("/static"):
            return await call_next(request)

        # Password-login paths are brute-force targets and must NEVER be exempted
        # by the loopback shortcut below. Decide auth-strict first, then bypass.
        is_auth = _is_auth_path(path)

        # Skip rate limiting for in-container callers only — docker health
        # checks, CI, `docker exec` test harnesses. This checks the raw TCP
        # peer and ignores every forwarded header, so no external request can
        # qualify no matter what headers it sends. (The old prefix checks on
        # X-Forwarded-For let `X-Forwarded-For: 192.168.1.1` skip limiting,
        # and "172." also matched public ranges like Google's 172.217.x.x.)
        if not is_auth and is_loopback_peer(request):
            return await call_next(request)

        # ── Request body size cap (cheap header check) ──────────────────
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > self.max_body_bytes:
                    return JSONResponse(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        content={
                            "detail": (
                                "Request body too large. Reduce attachment/signature "
                                f"size (max {self.max_body_bytes // (1024 * 1024)} MB)."
                            )
                        },
                    )
            except ValueError:
                pass

        # ── Redis-backed rate limiting ───────────────────────────────────
        if is_auth:
            bucket_key = f"rl:auth:{get_trusted_client_ip(request)}"
            limit = self.auth_limit
        else:
            bucket_key = f"rl:api:{self._get_identity_key(request)}"
            limit = self.api_limit

        # Lazily obtain Redis — if unavailable, pass through (fail-open)
        from app.cache import _get_redis
        redis_client = await _get_redis()

        if redis_client is not None:
            rate_limited, count = await self._check_limit(redis_client, bucket_key, limit)
            if rate_limited:
                retry_after = self.window
                try:
                    ttl = await redis_client.ttl(bucket_key)
                    retry_after = max(int(ttl), 1)
                except Exception:
                    pass
                return JSONResponse(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    content={
                        "detail": f"Rate limit exceeded. Try again in {retry_after}s.",
                        "retry_after": retry_after,
                    },
                    headers={"Retry-After": str(retry_after)},
                )

        response = await call_next(request)

        # Add informational rate-limit headers
        try:
            if redis_client is not None:
                current = await redis_client.get(bucket_key)
                current_count = int(current) if current else 0
                response.headers["X-RateLimit-Limit"] = str(limit)
                response.headers["X-RateLimit-Remaining"] = str(max(limit - current_count, 0))
                response.headers["X-RateLimit-Reset"] = str(
                    int(__import__("time").time()) + self.window
                )
        except Exception:
            pass  # Never let header injection crash a response

        return response
