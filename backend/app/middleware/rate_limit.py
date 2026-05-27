"""
Rate Limiting Middleware — Protects auth endpoints from brute-force attacks.
Uses in-memory sliding window; for multi-instance, swap to Redis.
"""
import time
from collections import defaultdict
from dataclasses import dataclass, field
from fastapi import Request, HTTPException, status
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
    Per-IP rate limiting middleware.

    Rules:
    - Auth endpoints (/api/auth/login, /api/auth/refresh): 10 req / 60s
    - General API: 120 req / 60s
    - Static / health: unlimited
    """

    def __init__(self, app, auth_limit: int = 60, api_limit: int = 600, window: int = 60):
        super().__init__(app)
        self.auth_limit = auth_limit
        self.api_limit = api_limit
        self.window = window
        self._buckets: dict[str, RateBucket] = defaultdict(RateBucket)

    def _get_client_ip(self, request: Request) -> str:
        # Respect X-Forwarded-For from reverse proxy
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        path = request.url.path

        # Skip rate limiting for health checks and docs
        if path in ("/", "/health", "/docs", "/openapi.json") or path.startswith("/static"):
            return await call_next(request)

        client_ip = self._get_client_ip(request)

        # Determine which limit applies
        # Only apply strict auth limits to brute-force-sensitive endpoints
        AUTH_STRICT_PATHS = {"/api/auth/login", "/api/auth/refresh"}
        is_auth = path in AUTH_STRICT_PATHS
        bucket_key = f"{'auth' if is_auth else 'api'}:{client_ip}"
        limit = self.auth_limit if is_auth else self.api_limit

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

        response = await call_next(request)
        # Add rate limit headers
        response.headers["X-RateLimit-Limit"] = str(limit)
        response.headers["X-RateLimit-Remaining"] = str(max(limit - bucket.count(), 0))
        response.headers["X-RateLimit-Reset"] = str(int(time.time()) + self.window)

        return response
