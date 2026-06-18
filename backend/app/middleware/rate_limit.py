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

Note: buckets are in-memory and per-process. With multiple workers each holds its
own buckets, so the effective limit is `limit × workers`. For strict cluster-wide
limiting, back this with Redis. Per-token keying (the important correctness fix)
works the same either way.
"""
from __future__ import annotations
import time
import hashlib
from collections import defaultdict
from dataclasses import dataclass, field
from fastapi import Request, status
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response, JSONResponse


@dataclass
class RateBucket:
    """Sliding window rate limiter bucket."""
    timestamps: list[float] = field(default_factory=list)

    def prune(self, window: float):
        cutoff = time.time() - window
        self.timestamps = [t for t in self.timestamps if t > cutoff]

    def count(self) -> int:
        return len(self.timestamps)

    def add(self):
        self.timestamps.append(time.time())


class RateLimitMiddleware(BaseHTTPMiddleware):
    """
    Per-identity rate limiting + request body size cap.

    Rules:
    - Auth endpoints (/api/auth/login, /api/auth/refresh): `auth_limit` / window, per IP
    - General API: `api_limit` / window, per crew/user token (falls back to IP)
    - Static / health: unlimited
    - Any request whose Content-Length exceeds `max_body_bytes` → 413
    """

    def __init__(
        self,
        app,
        auth_limit: int = 60,
        api_limit: int = 600,
        window: int = 60,
        max_body_bytes: int = 15 * 1024 * 1024,  # 15 MB — allows photo/sticker captures
    ):
        super().__init__(app)
        self.auth_limit = auth_limit
        self.api_limit = api_limit
        self.window = window
        self.max_body_bytes = max_body_bytes
        self._buckets: dict[str, RateBucket] = defaultdict(RateBucket)
        self._sweep_counter = 0

    def _get_client_ip(self, request: Request) -> str:
        # Respect X-Forwarded-For from reverse proxy
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    def _get_identity_key(self, request: Request) -> str:
        """Per-token identity when authenticated, else per-IP.

        We hash the token so raw credentials never become dict keys / log lines.
        """
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
            if token:
                return "tok:" + hashlib.sha256(token.encode()).hexdigest()[:16]
        return "ip:" + self._get_client_ip(request)

    def _maybe_evict(self):
        """Periodically drop empty buckets so memory doesn't grow unbounded."""
        self._sweep_counter += 1
        if self._sweep_counter < 500:
            return
        self._sweep_counter = 0
        for key in list(self._buckets.keys()):
            self._buckets[key].prune(self.window)
            if self._buckets[key].count() == 0:
                del self._buckets[key]

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        path = request.url.path

        # Skip rate limiting for health checks and docs
        if path in ("/", "/health", "/docs", "/openapi.json") or path.startswith("/static"):
            return await call_next(request)

        # ── Request body size cap (cheap header check; stops oversized uploads) ──
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

        # Determine which limit applies. Strict, per-IP limits only for the
        # brute-force-sensitive auth endpoints; everything else per-token.
        AUTH_STRICT_PATHS = {"/api/auth/login", "/api/auth/refresh"}
        is_auth = path in AUTH_STRICT_PATHS
        if is_auth:
            bucket_key = "auth:ip:" + self._get_client_ip(request)
            limit = self.auth_limit
        else:
            bucket_key = "api:" + self._get_identity_key(request)
            limit = self.api_limit

        bucket = self._buckets[bucket_key]
        bucket.prune(self.window)

        if bucket.count() >= limit:
            retry_after = int(self.window - (time.time() - bucket.timestamps[0]))
            return JSONResponse(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                content={
                    "detail": f"Rate limit exceeded. Try again in {max(retry_after, 1)}s.",
                    "retry_after": max(retry_after, 1),
                },
                headers={"Retry-After": str(max(retry_after, 1))},
            )

        bucket.add()
        self._maybe_evict()

        response = await call_next(request)
        # Add rate limit headers
        response.headers["X-RateLimit-Limit"] = str(limit)
        response.headers["X-RateLimit-Remaining"] = str(max(limit - bucket.count(), 0))
        response.headers["X-RateLimit-Reset"] = str(int(time.time()) + self.window)

        return response
