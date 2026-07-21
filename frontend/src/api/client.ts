/**
 * API Client — Axios wrapper with JWT interceptors.
 */
import axios from 'axios';
import { reportCrash } from '../components/ErrorBoundary';

const API_BASE = '';

const api = axios.create({
  baseURL: API_BASE,
  headers: {
    'Content-Type': 'application/json'
  },
});

// Request interceptor — attach JWT token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
    // Stash the token this request was sent with, so the response interceptor's
    // fan-out guard can detect whether a refresh already happened mid-flight.
    (config as any).__accessTokenUsed = token;
  }
  return config;
});

// ── Single-flight refresh ────────────────────────────────────────────────
// The backend ROTATES and BLACKLISTS the refresh token on every /refresh call
// (see backend/app/api/auth.py). If several requests 401 at the same moment —
// which happens whenever the access token has just expired and the user clicks
// around or lands on a data-heavy page that fires many requests at once — each
// one would independently POST /refresh with the SAME refresh token. The first
// call rotates the token and blacklists the old one; every other concurrent
// call is then using a just-revoked token, gets 401 "revoked", and kicks the
// user out to /login. That is the intermittent "I navigated too quickly and got
// logged out" bug.
//
// Fix (part 1): collapse all *concurrent* refreshes into ONE in-flight promise.
// Every request that 401s while a refresh is already in flight awaits the same
// refresh, then retries with the new token.
//
// Fix (part 2 — the "fan-out guard" in the response interceptor): single-flight
// alone is NOT enough. It only dedups refreshes that overlap in time. Requests
// that were in flight with the OLD token and 401 a moment AFTER the shared
// refresh has already settled and cleared (`refreshPromise = null`) each start
// yet ANOTHER /refresh. Because the backend rotates + blacklists on every call,
// a wave of these "stragglers" became an observed storm of 27 /refresh calls,
// ending when one straggler used a just-revoked token → 401 → logout. The guard
// makes a straggler retry with the already-refreshed token instead of refreshing
// again, so exactly ONE /refresh runs per expiry.
let refreshPromise: Promise<string> | null = null;
// Guard so a failed refresh redirects to /login exactly once, even when a whole
// batch of requests fails together.
let isRedirectingToLogin = false;

function performRefresh(): Promise<string> {
  const refreshToken = localStorage.getItem('refresh_token');
  if (!refreshToken) {
    return Promise.reject(new Error('no_refresh_token'));
  }
  // Use the bare axios (not `api`) so the refresh call itself never re-enters
  // this interceptor and recurses.
  return axios
    .post(`${API_BASE}/api/auth/refresh`, { refresh_token: refreshToken })
    .then((res) => {
      localStorage.setItem('access_token', res.data.access_token);
      localStorage.setItem('refresh_token', res.data.refresh_token);
      return res.data.access_token as string;
    });
}

/**
 * Refresh the access token, deduplicating concurrent callers. The first caller
 * kicks off the network request; everyone else awaits the same promise.
 */
function refreshAccessToken(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = performRefresh().finally(() => {
      // Clear the shared promise once settled so the NEXT expiry starts a fresh
      // refresh (with the newly-rotated token).
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

/**
 * True when the current URL is a crew / service-provider route
 * (`/<slug>/login`, `/<slug>/crew/*`, `/<slug>/admin/*`). Those pages run the
 * SEPARATE crew_token auth system with their own raw-axios Bearer header. The
 * admin session machinery in this module (and AuthContext) must never redirect
 * or probe on them: a stale admin access_token left in the same browser would
 * otherwise hijack an active crew session and bounce it to the admin login. The
 * top-level admin app (`/`, `/dashboard`, …) does not match.
 */
export function isCrewRoute(): boolean {
  return /^\/[^/]+\/(crew|admin|login)(\/|$)/.test(window.location.pathname);
}

function forceLogin() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  // On a crew/provider route, clearing the stale admin tokens above is enough —
  // do NOT hard-redirect to the admin /login, which would yank an active crew
  // member out of their shift. Their crew_token is a separate session and is
  // still valid; the crew page's own raw-axios 401 handling manages it.
  if (isCrewRoute()) return;
  if (!isRedirectingToLogin) {
    isRedirectingToLogin = true;
    window.location.href = '/login';
  }
}

/**
 * True only when the server actively REJECTED the refresh (expired/revoked
 * refresh token). A network error, timeout, or 5xx during refresh has no
 * response and must NOT end the session — otherwise a transient blip (e.g. a
 * backend restart during a deploy) logs everyone out AND deletes a still-valid
 * refresh token, so the user can't even retry.
 */
function isSessionEndingRefreshError(err: any): boolean {
  if (err?.message === 'no_refresh_token') return true;
  const s = err?.response?.status;
  return s === 401 || s === 403;
}

// Response interceptor — handle 401 + report 5xx crashes
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error.response?.status;

    // ── Report 5xx server errors to crash monitoring ──
    if (status && status >= 500) {
      try {
        reportCrash({
          error_type: `HTTP_${status}`,
          message: error.response?.data?.detail || error.message || `Server error ${status}`,
          stacktrace: JSON.stringify({
            url: error.config?.url,
            method: error.config?.method,
            status: status,
            response_data: error.response?.data,
          }, null, 2),
          endpoint: error.config?.url,
          severity: status === 503 ? 'critical' : 'error',
          metadata: {
            request_method: error.config?.method,
            request_url: error.config?.url,
            crash_id: error.response?.data?.crash_id,
          },
        });
      } catch {
        // Don't let crash reporting break the app
      }
    }

    // ── Handle 401 — token refresh flow ──
    if (status === 401) {
      const originalRequest = error.config;

      // Do not intercept if the request itself was a login attempt, or if this
      // request has already been retried once after a refresh (prevents an
      // infinite refresh→retry→401 loop when the endpoint 401s for a reason
      // other than an expired token, e.g. a permission check).
      if (
        originalRequest.url?.includes('/api/auth/login') ||
        originalRequest.url?.includes('/api/auth/refresh') ||
        originalRequest._retry
      ) {
        if (originalRequest.url?.includes('/api/auth/refresh')) {
          // The refresh token itself is dead — session is truly over.
          forceLogin();
        }
        return Promise.reject(error);
      }

      if (!localStorage.getItem('refresh_token')) {
        forceLogin();
        return Promise.reject(error);
      }

      originalRequest._retry = true;

      // ── Fan-out guard ──
      // If a refresh has ALREADY happened while this request was in flight, the
      // token it was sent with no longer matches what's now stored. Retry it (the
      // request interceptor re-attaches the current token) instead of starting
      // ANOTHER /refresh — this stops a wave of stragglers from each rotating the
      // token, and stops one of them landing on a just-revoked token → spurious
      // logout. Only requests that 401 while their token is still the current one
      // fall through to the single-flight refresh below.
      const usedToken = (originalRequest as any).__accessTokenUsed;
      const storedToken = localStorage.getItem('access_token');
      if (storedToken && usedToken && storedToken !== usedToken) {
        return api(originalRequest);
      }

      try {
        const newToken = await refreshAccessToken();
        originalRequest.headers = originalRequest.headers || {};
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return api(originalRequest);
      } catch (refreshErr) {
        // End the session ONLY when the refresh was genuinely rejected by the
        // server (expired/revoked refresh token). On a network error / timeout /
        // 5xx we keep the stored tokens intact so the next request can retry —
        // a transient outage must not log the user out or destroy a valid token.
        if (isSessionEndingRefreshError(refreshErr)) {
          forceLogin();
        }
        return Promise.reject(error);
      }
    }
    return Promise.reject(error);
  }
);

export default api;
