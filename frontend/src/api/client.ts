/**
 * API Client — Axios wrapper with JWT interceptors.
 */
import axios from 'axios';
import { reportCrash } from '../components/ErrorBoundary';

const API_BASE = '';

const api = axios.create({
  baseURL: API_BASE,
  headers: {
    'Content-Type': 'application/json',
    'ngrok-skip-browser-warning': 'true'
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

      // Do not intercept if the request itself was a login attempt
      if (originalRequest.url?.includes('/api/auth/login')) {
        return Promise.reject(error);
      }

      const refreshToken = localStorage.getItem('refresh_token');
      if (refreshToken) {
        try {
          const res = await axios.post(`${API_BASE}/api/auth/refresh`, {
            refresh_token: refreshToken,
          });
          localStorage.setItem('access_token', res.data.access_token);
          localStorage.setItem('refresh_token', res.data.refresh_token);
          originalRequest.headers.Authorization = `Bearer ${res.data.access_token}`;
          return api(originalRequest);
        } catch {
          localStorage.removeItem('access_token');
          localStorage.removeItem('refresh_token');
          window.location.href = '/login';
        }
      } else {
        localStorage.removeItem('access_token');
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default api;

