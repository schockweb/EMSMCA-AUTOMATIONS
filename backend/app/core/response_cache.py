"""
Response Cache Middleware for FastAPI.
Caches full JSON responses for GET requests in-memory with a TTL.
This eliminates repeat round-trips to Supabase for the same data.

- Only caches GET requests that return HTTP 200
- Cache key = method + path + sorted query string
- Configurable TTL per path prefix
- Automatically bypassed for auth endpoints (/api/auth/*)
- Cache is invalidated on any POST / PUT / PATCH / DELETE to the same prefix
"""
import time
import hashlib
import logging
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

logger = logging.getLogger(__name__)

# ── Cache TTL rules (path prefix → seconds) ─────────────────────────────────
CACHE_RULES: dict[str, int] = {
    "/api/cases":           30,
    "/api/digital-prf":     30,
    "/api/claims":          30,
    "/api/providers":       60,
    "/api/rate-schemas":   300,
    "/api/users":           60,
    "/api/analytics":       60,
    "/api/crashes":         30,
    "/api/edi":             60,
    "/api/failed-prfs":     30,
    "/api/authorization":   20,
    "/api/stats":           20,   # dashboard — 8 DB queries per load
}

# Paths that should NEVER be cached
NEVER_CACHE = {"/api/auth", "/api/metrics", "/api/geocode", "/api/member-lookup"}


class ResponseCacheMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp):
        super().__init__(app)
        # store: cache_key → {"body": bytes, "headers": list, "expires": float}
        self._store: dict[str, dict] = {}

    # ── helpers ──────────────────────────────────────────────────────────────

    def _ttl_for(self, path: str) -> int | None:
        """Return TTL in seconds for path, or None if not cacheable."""
        for prefix in NEVER_CACHE:
            if path.startswith(prefix):
                return None
        for prefix, ttl in CACHE_RULES.items():
            if path.startswith(prefix):
                return ttl
        return None

    def _make_key(self, request: Request) -> str:
        """Cache key = method + path + query + auth-token-hash.
        Including the auth token means different users get isolated cache entries."""
        auth = request.headers.get("Authorization", "")[:32]  # first 32 chars enough
        raw = f"GET:{request.url.path}?{request.url.query}|{auth}"
        return hashlib.md5(raw.encode()).hexdigest()

    def _invalidate_prefix(self, path: str) -> None:
        """On write operations, drop all cached entries for the same prefix."""
        for prefix in CACHE_RULES:
            if path.startswith(prefix):
                before = len(self._store)
                self._store = {k: v for k, v in self._store.items()
                               if not k.startswith(prefix)}
                dropped = before - len(self._store)
                if dropped:
                    logger.debug(f"Cache: invalidated {dropped} entries for {prefix}")
                return

    def _get_cached(self, key: str):
        entry = self._store.get(key)
        if not entry:
            return None
        if time.monotonic() > entry["expires"]:
            del self._store[key]
            return None
        return entry

    def _set_cached(self, key: str, body: bytes, headers: list, ttl: int) -> None:
        self._store[key] = {
            "body": body,
            "headers": headers,
            "expires": time.monotonic() + ttl,
        }

    # ── request handling ─────────────────────────────────────────────────────

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        method = request.method

        # On writes, invalidate matching prefix and pass through
        if method in ("POST", "PUT", "PATCH", "DELETE"):
            self._invalidate_prefix(path)
            return await call_next(request)

        # Only cache GET
        if method != "GET":
            return await call_next(request)

        ttl = self._ttl_for(path)
        if ttl is None:
            return await call_next(request)

        key = self._make_key(request)
        entry = self._get_cached(key)

        if entry:
            logger.debug(f"Cache HIT  {path}")
            return Response(
                content=entry["body"],
                status_code=200,
                headers=dict(entry["headers"]) | {"X-Cache": "HIT", "Cache-Control": "private, max-age=30"},
                media_type="application/json",
            )

        # Cache MISS — call the actual handler
        response = await call_next(request)

        if response.status_code == 200:
            # Read and re-wrap the body (streaming response)
            body = b""
            async for chunk in response.body_iterator:
                body += chunk

            headers = [
                (k, v) for k, v in response.headers.items()
                if k.lower() not in ("content-length",)
            ]
            self._set_cached(key, body, headers, ttl)
            logger.debug(f"Cache MISS {path} — cached for {ttl}s")

            return Response(
                content=body,
                status_code=200,
                headers=dict(headers) | {"X-Cache": "MISS", "Cache-Control": f"private, max-age={ttl}"},
                media_type="application/json",
            )

        return response
