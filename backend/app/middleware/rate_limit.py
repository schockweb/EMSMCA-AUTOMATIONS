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
import logging
from fastapi import Request, status
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response, JSONResponse

logger = logging.getLogger("ems.rate_limit")


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
        auth_limit: int = 100,        # 100 login attempts per window
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

    def _get_client_ip(self, request: Request) -> str:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    def _get_identity_key(self, request: Request) -> str:
        """Per-token identity when authenticated, else per-IP.

        We hash the token so raw credentials never become Redis keys / log lines.
        """
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
            if token:
                return "tok:" + hashlib.sha256(token.encode()).hexdigest()[:16]
        return "ip:" + self._get_client_ip(request)

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
        # by the internal-IP shortcut below: client_ip is derived from the
        # attacker-controlled X-Forwarded-For header, so a spoofed
        # `X-Forwarded-For: 127.0.0.1` (or 172.x / 192.168.x) would otherwise skip
        # all rate limiting on /login. Decide auth-strict first, then bypass.
        AUTH_STRICT_PATHS = {"/api/auth/login", "/api/auth/refresh", "/api/crew/login"}
        is_auth = path in AUTH_STRICT_PATHS

        # Skip rate limiting for localhost / loopback — docker health checks, CI,
        # dev logins — but only for non-auth paths (see note above).
        client_ip = self._get_client_ip(request)
        if not is_auth and (
            client_ip in ("127.0.0.1", "::1", "localhost")
            or client_ip.startswith("172.")
            or client_ip.startswith("192.168.")
        ):
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
            bucket_key = f"rl:auth:{self._get_client_ip(request)}"
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
