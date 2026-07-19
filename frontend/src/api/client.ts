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
// Fix: collapse all concurrent refreshes into ONE in-flight promise. Every
// request that 401s awaits the same refresh and then retries with the new
// token. Only one /refresh hits the server per expiry, so nothing gets
// spuriously revoked.
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

function forceLogin() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  if (!isRedirectingToLogin) {
    isRedirectingToLogin = true;
    window.location.href = '/login';
  }
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
      try {
        const newToken = await refreshAccessToken();
        originalRequest.headers = originalRequest.headers || {};
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return api(originalRequest);
      } catch {
        // The shared refresh failed (expired/revoked refresh token, or network).
        // Every concurrent caller lands here, but forceLogin() only redirects once.
        forceLogin();
        return Promise.reject(error);
      }
    }
    return Promise.reject(error);
  }
);

export default api;
