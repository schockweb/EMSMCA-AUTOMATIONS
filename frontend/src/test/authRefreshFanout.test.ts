// @vitest-environment jsdom
/**
 * Regression test for the /api/auth/refresh fan-out.
 *
 * A single expired access token, followed by a WAVE of requests that were all
 * in flight with that old token and 401 at staggered times, must trigger EXACTLY
 * ONE /api/auth/refresh — not one per straggler. The mock backend rotates and
 * blacklists the refresh token on every call (like the real server), so a
 * fan-out would additionally risk a straggler landing on a revoked token.
 *
 * Before the fan-out guard in client.ts this wave produced N refreshes (observed
 * as a storm of 27 in the browser); after it, it produces 1.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import axios from 'axios';
import api from '../api/client';

// ── Mock backend state (mimics auth.py rotate + blacklist) ──
let refreshCount = 0;
let currentAccess = '__none_valid__'; // nothing holds this yet → the stale token 401s
let currentRefresh = 'refresh-0';
const revokedRefresh = new Set<string>();

function readHeader(config: any, name: string): string | undefined {
  const h = config.headers;
  if (!h) return undefined;
  if (typeof h.get === 'function') return h.get(name); // AxiosHeaders
  return h[name] ?? h[name.toLowerCase()];
}

// A custom axios adapter must settle non-2xx itself (axios does NOT re-apply
// validateStatus to custom adapters), so 4xx is rejected with an AxiosError-shaped
// error carrying `.response` — exactly what the interceptor inspects.
function mockAdapter(config: any): Promise<any> {
  const url: string = config.url || '';
  const settle = (status: number, data: any) => {
    const response = { data, status, statusText: '', headers: {}, config };
    if (status >= 200 && status < 300) return Promise.resolve(response);
    const err: any = new Error(`Request failed with status ${status}`);
    err.config = config;
    err.response = response;
    err.isAxiosError = true;
    return Promise.reject(err);
  };

  // Refresh endpoint — rotate + blacklist, exactly like the backend.
  if (url.includes('/api/auth/refresh')) {
    refreshCount++;
    const presented = JSON.parse(config.data).refresh_token;
    if (presented !== currentRefresh || revokedRefresh.has(presented)) {
      return settle(401, { detail: 'Refresh token has been revoked' });
    }
    revokedRefresh.add(currentRefresh);
    currentAccess = `access-${refreshCount}`;
    currentRefresh = `refresh-${refreshCount}`;
    return settle(200, { access_token: currentAccess, refresh_token: currentRefresh });
  }

  // Protected endpoint — 401 unless the presented bearer is the current access
  // token. `x-test-delay` staggers the 401s so they land at different times,
  // defeating the single-flight window (which only dedups truly-concurrent 401s).
  const delay = Number(readHeader(config, 'x-test-delay') || 0);
  return new Promise((resolve) => {
    setTimeout(() => {
      const token = String(readHeader(config, 'Authorization') || '').replace(/^Bearer\s+/i, '');
      resolve(token === currentAccess ? settle(200, { ok: true }) : settle(401, { detail: 'expired' }));
    }, delay);
  });
}

describe('api/client refresh fan-out guard', () => {
  beforeEach(() => {
    refreshCount = 0;
    currentAccess = '__none_valid__';
    currentRefresh = 'refresh-0';
    revokedRefresh.clear();
    localStorage.clear();
    localStorage.setItem('access_token', 'stale-access'); // expired → every request 401s first
    localStorage.setItem('refresh_token', 'refresh-0');    // valid → refresh rotates it
    (api.defaults as any).adapter = mockAdapter;
    (axios.defaults as any).adapter = mockAdapter; // performRefresh uses bare axios
  });

  it('fires exactly ONE /refresh for a staggered wave of 401s, and all requests succeed', async () => {
    const N = 8;
    // All 8 are sent NOW (concurrently) with the stale token; their 401s arrive
    // staggered (0,8,16,… ms) so most land after the shared refresh has settled.
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        api.get('/api/protected', { headers: { 'x-test-delay': i * 8 } }).then((r) => r.data),
      ),
    );

    expect(refreshCount).toBe(1);                            // ← the fix: one refresh, not N
    expect(results.every((r) => r.ok === true)).toBe(true); // no request spuriously failed
    expect(localStorage.getItem('access_token')).toBe('access-1'); // rotated exactly once
  });

  it('sanity: a lone expired request triggers exactly one refresh', async () => {
    const r = await api.get('/api/protected').then((x) => x.data);
    expect(r.ok).toBe(true);
    expect(refreshCount).toBe(1);
  });
});
