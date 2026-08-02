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
# NOTE ON THE TWO ABSENTEES — /api/cases and /api/digital-prf.
#
# Both used to be cached here for 30s. They are the routes that disclose
# patient records, and this middleware answers a repeated GET from memory
# WITHOUT running the route — so the PHI access log those routes now write was
# simply skipped on every cache hit. An access log with holes in it cannot
# scope a breach under POPIA s22, which is the entire reason it exists.
#
# Caching a PHI read and auditing it are mutually exclusive at this layer, and
# the audit wins. The cost is bounded: the PRF detail route still has its own
# Redis cache (and now logs BEFORE consulting it), and the case list is a
# 50-row admin page on an indexed sort.
#
# Do not add them back without moving the audit into the middleware itself.
CACHE_RULES: dict[str, int] = {
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

# Suffix-matched exemptions for micro-poll endpoints that live under an
# otherwise-cached prefix. /case-status exists precisely because the crew app
# polls it right after submit for the async pipeline's case_id — serving a
# 30s-stale null would defeat its purpose.
NEVER_CACHE_SUFFIXES = ("/case-status",)

# ── Store bounds ────────────────────────────────────────────────────────────
# The store was an unbounded dict. Entries expire logically, but expiry was
# only ever ACTED ON in `_get_cached` — i.e. when the very same key is asked
# for again. A key that is never requested a second time is never freed.
#
# The cache key includes a fingerprint of the caller's token, so every session
# gets its own namespace, and crew tokens rotate every 12 hours. Each shift
# change therefore mints a fresh set of keys for every cached prefix, and the
# previous shift's entries — full JSON bodies: PRF lists, case lists, patient
# names — stay resident in the worker for as long as the process lives. That
# is both an unbounded memory leak and PHI retained far past its TTL.
#
# 2000 entries is generous for the working set (12 cacheable prefixes × active
# sessions) while capping worst-case residency.
MAX_ENTRIES = 2000

# Sweep expired entries every N insertions. Amortises the cost instead of
# walking the store on every request.
SWEEP_EVERY_N_WRITES = 200


class ResponseCacheMiddleware(BaseHTTPMiddleware):
    # Set on construction so logout can purge a session's entries. The cache is
    # per-worker and in-memory, so this reference is per-worker too.
    _instance: "ResponseCacheMiddleware | None" = None

    def __init__(self, app: ASGIApp):
        super().__init__(app)
        # store: cache_key → {"body", "headers", "expires", "path", "auth_fp"}
        self._store: dict[str, dict] = {}
        self._writes_since_sweep = 0
        ResponseCacheMiddleware._instance = self

    # ── helpers ──────────────────────────────────────────────────────────────

    def _ttl_for(self, path: str) -> int | None:
        """Return TTL in seconds for path, or None if not cacheable."""
        if path.endswith(NEVER_CACHE_SUFFIXES):
            return None
        for prefix in NEVER_CACHE:
            if path.startswith(prefix):
                return None
        for prefix, ttl in CACHE_RULES.items():
            if path.startswith(prefix):
                return ttl
        return None

    def _make_key(self, request: Request) -> str:
        """Cache key = method + path + query + FULL-auth-token fingerprint.

        The token fingerprint MUST vary per user/session. A previous version
        used Authorization[:32] — but that only captures 'Bearer ' + the JWT
        header, which is byte-identical for every HS256 token. Every user
        therefore collided onto ONE cache entry, so a per-crew list like
        GET /api/digital-prf could serve another session's data for the TTL
        (drafts "disappearing" until the 30s entry expired — and a
        cross-tenant leak). Hashing the whole token gives each session its
        own namespace.
        """
        auth = request.headers.get("Authorization", "")
        auth_fp = hashlib.sha256(auth.encode()).hexdigest() if auth else "anon"
        raw = f"GET:{request.url.path}?{request.url.query}|{auth_fp}"
        return hashlib.md5(raw.encode()).hexdigest()

    @staticmethod
    def auth_fingerprint(authorization_header: str) -> str:
        """Fingerprint used to namespace cache entries by session."""
        return hashlib.sha256((authorization_header or "").encode()).hexdigest()

    def _invalidate_prefix(self, path: str) -> None:
        """On write operations, drop all cached entries whose stored path shares
        the same API prefix. Cache keys are MD5 hashes so we cannot match on
        the key itself — we match on the 'path' field stored in each entry."""
        for prefix in CACHE_RULES:
            if path.startswith(prefix):
                before = len(self._store)
                self._store = {
                    k: v for k, v in self._store.items()
                    if not v.get("path", "").startswith(prefix)
                }
                dropped = before - len(self._store)
                logger.debug(f"Cache: invalidated {dropped} entries for prefix '{prefix}' (triggered by {path})")
                return

    def _get_cached(self, key: str):
        entry = self._store.get(key)
        if not entry:
            return None
        if time.monotonic() > entry["expires"]:
            del self._store[key]
            return None
        return entry

    def _sweep_expired(self) -> int:
        """Drop every entry whose TTL has passed. Returns the count."""
        now = time.monotonic()
        before = len(self._store)
        self._store = {
            k: v for k, v in self._store.items() if v["expires"] > now
        }
        return before - len(self._store)

    def _enforce_bound(self) -> None:
        """Keep the store under MAX_ENTRIES, evicting nearest-to-expiry first.

        Runs only after a sweep has already removed everything expired, so this
        evicts entries that are still live — the least valuable ones being those
        about to expire anyway.
        """
        overflow = len(self._store) - MAX_ENTRIES
        if overflow <= 0:
            return
        doomed = sorted(self._store.items(), key=lambda kv: kv[1]["expires"])[:overflow]
        for k, _ in doomed:
            self._store.pop(k, None)
        logger.warning(
            "Response cache hit its %d-entry bound; evicted %d entries. If this "
            "recurs the working set has outgrown the cap.", MAX_ENTRIES, len(doomed),
        )

    def _set_cached(self, key: str, body: bytes, headers: list, ttl: int,
                    path: str = "", auth_fp: str = "") -> None:
        self._writes_since_sweep += 1
        if self._writes_since_sweep >= SWEEP_EVERY_N_WRITES or len(self._store) >= MAX_ENTRIES:
            self._writes_since_sweep = 0
            self._sweep_expired()

        self._store[key] = {
            "body": body,
            "headers": headers,
            "expires": time.monotonic() + ttl,
            "path": path,       # stored so invalidation can match by prefix
            "auth_fp": auth_fp, # stored so logout can purge one session
        }
        self._enforce_bound()

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
            self._set_cached(key, body, headers, ttl, path=path,
                             auth_fp=self.auth_fingerprint(request.headers.get("Authorization", "")))
            logger.debug(f"Cache MISS {path} — cached for {ttl}s")

            return Response(
                content=body,
                status_code=200,
                headers=dict(headers) | {"X-Cache": "MISS", "Cache-Control": f"private, max-age={ttl}"},
                media_type="application/json",
            )

        return response


# ── Revocation support ───────────────────────────────────────────────────
#
# This middleware answers a cache HIT *before* the route runs, which means the
# route's auth dependency never executes. A token that has just been logged out
# (or whose account was deactivated) therefore kept reading cached data until the
# entry expired — up to 5 minutes on some prefixes. Purging the session's entries
# on logout forces a MISS, so the next request reaches the dependency and is
# correctly refused.

def purge_session_cache(authorization_header: str) -> int:
    """Drop every cached entry belonging to one session. Returns the count."""
    inst = ResponseCacheMiddleware._instance
    if inst is None:
        return 0
    fp = ResponseCacheMiddleware.auth_fingerprint(authorization_header)
    before = len(inst._store)
    inst._store = {k: v for k, v in inst._store.items() if v.get("auth_fp") != fp}
    return before - len(inst._store)


def purge_all_cached_responses() -> int:
    """Empty the whole response cache. Returns the count dropped.

    For events where the sessions to invalidate are not in our hand. Bulk
    revocation is exactly that case: an administrator revokes every session for
    a lost tablet, and the entries to drop are keyed by a fingerprint of tokens
    we never see. Purging selectively is impossible; leaving them means the
    revoked token keeps getting cached 200s until the entry expires.

    Cheap enough to be the right answer: the store is in-process, bounded, and
    holds at most a few minutes of GETs. The cost is a brief cache-miss burst;
    the alternative is a revocation that does not take effect for five minutes.
    """
    inst = ResponseCacheMiddleware._instance
    if inst is None:
        return 0
    dropped = len(inst._store)
    inst._store = {}
    return dropped
