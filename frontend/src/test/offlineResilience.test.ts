/**
 * Offline ePRF: the server-reachability breaker and the shift-start cache.
 *
 * The failure these exist for is NOT "the phone has no signal" — that case was
 * already handled. It is "the phone has four bars and the portal is dead",
 * where `navigator.onLine` is true, every offline guard in the app evaluates
 * false, and each request runs to the service worker's 10-second NetworkFirst
 * timeout before failing.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  shouldSkipNetwork,
  reportSuccess,
  reportFailure,
  isTransportFailure,
  getServerState,
  onServerStateChange,
  __resetServerHealth,
} from '../services/serverHealth';
import {
  cacheCrewRoster,
  getCachedCrewRoster,
  cacheVehicles,
  getCachedVehicles,
  readJwtExpiry,
  isUsableOffline,
  formatRemaining,
  canStartShiftOffline,
  __clearOfflineShiftCache,
} from '../services/offlineShiftCache';

const SLUG = 'test-provider';

/** Build an unsigned JWT with the given expiry. Signature is irrelevant — the
 *  device never verifies it and must never be given the key to try. */
function jwtExpiringIn(ms: number): string {
  const payload = { exp: Math.floor((Date.now() + ms) / 1000), token_scope: 'portal_grant' };
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.signature-not-checked`;
}

describe('server reachability breaker', () => {
  beforeEach(() => {
    __resetServerHealth();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('does not open on a single blip', () => {
    reportFailure({ code: 'ERR_NETWORK' });
    expect(shouldSkipNetwork()).toBe(false);
  });

  it('opens after consecutive transport failures', () => {
    reportFailure({ code: 'ERR_NETWORK' });
    reportFailure({ code: 'ERR_NETWORK' });
    expect(getServerState()).toBe('down');
    expect(shouldSkipNetwork()).toBe(true);
  });

  it('a success between failures resets the count', () => {
    reportFailure({ code: 'ERR_NETWORK' });
    reportSuccess();
    reportFailure({ code: 'ERR_NETWORK' });
    expect(shouldSkipNetwork()).toBe(false);
  });

  it('an HTTP error is NOT a transport failure', () => {
    // The distinction that matters: a 500 means the server ANSWERED. Treating
    // it as unreachable would push the whole app offline because one endpoint
    // is broken, hiding the real error.
    for (const status of [400, 401, 403, 404, 409, 422, 500, 502, 503]) {
      expect(isTransportFailure({ response: { status } })).toBe(false);
    }
    reportFailure({ response: { status: 500 } });
    reportFailure({ response: { status: 500 } });
    reportFailure({ response: { status: 500 } });
    expect(shouldSkipNetwork()).toBe(false);
  });

  it('recognises the real transport failure shapes', () => {
    expect(isTransportFailure({ code: 'ERR_NETWORK' })).toBe(true);
    expect(isTransportFailure({ code: 'ECONNABORTED' })).toBe(true);
    expect(isTransportFailure({ message: 'Network Error' })).toBe(true);
    expect(isTransportFailure(null)).toBe(false);
  });

  it('skips the network when the device itself is offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(shouldSkipNetwork()).toBe(true);
  });

  it('notifies subscribers when reachability changes', () => {
    const seen: string[] = [];
    onServerStateChange((s) => seen.push(s));
    reportFailure({ code: 'ERR_NETWORK' });
    reportFailure({ code: 'ERR_NETWORK' });
    expect(seen).toContain('down');
    reportSuccess();
    expect(seen).toContain('up');
  });
});

describe('shift-start cache', () => {
  beforeEach(() => {
    localStorage.clear();
    __clearOfflineShiftCache(SLUG);
  });

  it('serves the crew roster back after caching', () => {
    const crew = [{ id: '1', name: 'A Medic', full_name: 'A Medic', hpcsa_number: 'X1', qualification: 'ECP' }];
    cacheCrewRoster(SLUG, crew as any);
    expect(getCachedCrewRoster(SLUG)).toHaveLength(1);
  });

  it('serves the vehicle roster back after caching', () => {
    cacheVehicles(SLUG, [{ id: 'v1', callsign: 'A1', registration: 'CA 1', vehicle_type: 'Ambulance' }] as any);
    expect(getCachedVehicles(SLUG)).toHaveLength(1);
  });

  it('never returns another provider’s roster', () => {
    cacheCrewRoster(SLUG, [{ id: '1', name: 'A', full_name: 'A', hpcsa_number: null, qualification: 'ECP' }] as any);
    expect(getCachedCrewRoster('a-different-provider')).toBeNull();
  });

  it('refuses a roster older than the freshness window', () => {
    cacheCrewRoster(SLUG, [{ id: '1', name: 'A', full_name: 'A', hpcsa_number: null, qualification: 'ECP' }] as any);
    // Age it past seven days — a stale roster can offer someone who has left.
    const k = Object.keys(localStorage).find((x) => x.includes('crew'))!;
    const v = JSON.parse(localStorage.getItem(k)!);
    v.cachedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem(k, JSON.stringify(v));

    expect(getCachedCrewRoster(SLUG)).toBeNull();
  });

  it('ignores corrupt cache entries instead of throwing', () => {
    localStorage.setItem(`offline_shift_crew_${SLUG}_v1`, '{not json');
    expect(getCachedCrewRoster(SLUG)).toBeNull();
  });
});

describe('local grant expiry', () => {
  it('reads exp without needing the signing key', () => {
    const t = jwtExpiringIn(60 * 60 * 1000);
    expect(readJwtExpiry(t)).toBeGreaterThan(Date.now());
  });

  it('accepts a grant with time left', () => {
    expect(isUsableOffline(jwtExpiringIn(6 * 60 * 60 * 1000))).toBe(true);
  });

  it('REFUSES an expired grant — offline must not extend its own access', () => {
    expect(isUsableOffline(jwtExpiringIn(-1000))).toBe(false);
  });

  it('refuses a grant about to expire mid-call', () => {
    // A 45-minute call must not start on a token with 30 seconds left.
    expect(isUsableOffline(jwtExpiringIn(30_000))).toBe(false);
  });

  it('refuses an unparseable token rather than guessing', () => {
    expect(isUsableOffline('not-a-jwt')).toBe(false);
    expect(isUsableOffline(null)).toBe(false);
    expect(readJwtExpiry('a.b.c')).toBeNull();
  });

  it('formats the remaining time for the shift banner', () => {
    // A JWT `exp` is whole SECONDS, so 90 minutes from now serialises to
    // 89m59s and floors to "1h 29m". Assert the shape and allow the one-minute
    // truncation rather than pinning an exact string — the alternative is a
    // test that fails on a boundary the code is right about.
    expect(formatRemaining(jwtExpiringIn(90 * 60 * 1000))).toMatch(/^1h (29|30)m$/);
    expect(formatRemaining(jwtExpiringIn(20 * 60 * 1000))).toMatch(/^(19|20) min$/);
    expect(formatRemaining(jwtExpiringIn(61 * 60 * 1000))).toMatch(/^1h( \d+m)?$/);
    expect(formatRemaining(jwtExpiringIn(-1000))).toBeNull();
  });
});

describe('can a shift start with no server', () => {
  beforeEach(() => {
    localStorage.clear();
    __clearOfflineShiftCache(SLUG);
  });

  it('yes, with a live grant and a cached roster', () => {
    cacheCrewRoster(SLUG, [{ id: '1', name: 'A', full_name: 'A', hpcsa_number: 'X', qualification: 'ECP' }] as any);
    expect(canStartShiftOffline(SLUG, jwtExpiringIn(6 * 60 * 60 * 1000))).toEqual({ ok: true });
  });

  it('no, when the device was never unlocked', () => {
    cacheCrewRoster(SLUG, [{ id: '1', name: 'A', full_name: 'A', hpcsa_number: 'X', qualification: 'ECP' }] as any);
    expect(canStartShiftOffline(SLUG, null)).toEqual({ ok: false, reason: 'no-grant' });
  });

  it('no, when the grant has expired', () => {
    cacheCrewRoster(SLUG, [{ id: '1', name: 'A', full_name: 'A', hpcsa_number: 'X', qualification: 'ECP' }] as any);
    expect(canStartShiftOffline(SLUG, jwtExpiringIn(-1000)))
      .toEqual({ ok: false, reason: 'grant-expired' });
  });

  it('no, when this device has never seen the roster', () => {
    expect(canStartShiftOffline(SLUG, jwtExpiringIn(6 * 60 * 60 * 1000)))
      .toEqual({ ok: false, reason: 'no-roster' });
  });
});
