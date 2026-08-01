/**
 * Everything the shift-start flow needs, cached so it works with no server.
 *
 * THE PROBLEM
 * -----------
 * A crew arriving at shift change during an outage could not start at all.
 * Three server calls stood between them and a usable PRF:
 *
 *   POST /api/crew/portal-unlock                  — exchange company password
 *   GET  /api/providers/{slug}/public-crew        — the name dropdown
 *   GET  /api/providers/{slug}/public-vehicles    — the vehicle dropdown
 *   POST /api/crew/lookup-hpcsa                   — mint the 12h crew token
 *
 * Everything AFTER that point already worked offline — creating a PRF, editing
 * it, saving, submitting, syncing later. The door was the only broken part.
 *
 * WHAT THIS DOES
 * --------------
 * Caches the two rosters on every successful online load, and validates the
 * portal grant's expiry locally so a device that was unlocked while the server
 * was up can still start a shift while it is down.
 *
 * THE SECURITY TRADE, STATED PLAINLY
 * ----------------------------------
 * Offline shift start trusts a signed grant WITHOUT asking the server whether
 * it has been revoked. A revoked grant would therefore keep working offline
 * until its own `exp` passes.
 *
 * This is a bounded extension of a trade already made. The grant is a 12-hour
 * JWT; once issued, the server cannot reach the device to withdraw it mid-window
 * either. Revocation was always "wait for expiry, or catch them on their next
 * online call" — and the next online call still checks the blacklist, so a
 * revoked grant stops working the moment connectivity returns.
 *
 * What we gain is that a paramedic is never locked out of the clinical record
 * at the start of a call. For an EMS product that is the correct side of the
 * trade, and it is the reason this file exists rather than being a shortcut.
 *
 * We do NOT extend the window. An expired grant is refused offline exactly as
 * it would be online — expiry is checked from the token's own `exp` claim.
 */

import type { CrewMemberProfile, ActiveVehicle } from '../utils/crewSession';

const CACHE_VERSION = 1;
const key = (slug: string, what: string) => `offline_shift_${what}_${slug}_v${CACHE_VERSION}`;

/** Rosters older than this are refused for offline start — a stale roster can
 *  offer a crew member who has since left the company. Seven days comfortably
 *  covers a shift pattern while bounding how wrong the list can be. */
const ROSTER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedRoster<T> {
  cachedAt: number;
  items: T[];
}

function read<T>(k: string): CachedRoster<T> | null {
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.cachedAt !== 'number' || !Array.isArray(parsed.items)) {
      return null;
    }
    return parsed as CachedRoster<T>;
  } catch {
    return null;
  }
}

function write<T>(k: string, items: T[]): void {
  try {
    localStorage.setItem(k, JSON.stringify({ cachedAt: Date.now(), items }));
  } catch {
    /* quota or private mode — caching is best-effort by design */
  }
}

// ── Crew roster ────────────────────────────────────────────────────────────

export function cacheCrewRoster(slug: string | undefined, crew: CrewMemberProfile[]): void {
  if (!slug || !Array.isArray(crew) || crew.length === 0) return;
  write(key(slug, 'crew'), crew);
}

export function getCachedCrewRoster(slug: string | undefined): CrewMemberProfile[] | null {
  if (!slug) return null;
  const c = read<CrewMemberProfile>(key(slug, 'crew'));
  if (!c) return null;
  if (Date.now() - c.cachedAt > ROSTER_MAX_AGE_MS) return null;
  return c.items;
}

// ── Vehicle roster ─────────────────────────────────────────────────────────

export function cacheVehicles(slug: string | undefined, vehicles: ActiveVehicle[]): void {
  if (!slug || !Array.isArray(vehicles) || vehicles.length === 0) return;
  write(key(slug, 'vehicles'), vehicles);
}

export function getCachedVehicles(slug: string | undefined): ActiveVehicle[] | null {
  if (!slug) return null;
  const c = read<ActiveVehicle>(key(slug, 'vehicles'));
  if (!c) return null;
  if (Date.now() - c.cachedAt > ROSTER_MAX_AGE_MS) return null;
  return c.items;
}

/** Age of the cached rosters in ms, or null when nothing is cached. Used to
 *  tell the crew how old the list they are looking at actually is. */
export function getRosterAge(slug: string | undefined): number | null {
  if (!slug) return null;
  const c = read<CrewMemberProfile>(key(slug, 'crew'));
  return c ? Date.now() - c.cachedAt : null;
}

// ── Local JWT expiry ───────────────────────────────────────────────────────

/**
 * Read a JWT's `exp` without verifying its signature.
 *
 * Signature verification is deliberately NOT attempted. The device does not
 * hold the signing key and must never be given it — a client-side "check" would
 * be theatre. The server is the only thing that can authenticate the token, and
 * it does so on the next online call.
 *
 * What this buys is the honest half: a token that has already expired is
 * refused locally, so an offline device cannot extend its own access. A forged
 * token would pass this check and then fail the moment it reached the server —
 * which is the same position the app is in for the whole 12-hour window anyway.
 */
export function readJwtExpiry(token: string | null | undefined): number | null {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')),
    );
    if (typeof payload?.exp !== 'number') return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

/** Milliseconds until the token expires. Negative when already expired. */
export function msUntilExpiry(token: string | null | undefined): number | null {
  const exp = readJwtExpiry(token);
  return exp === null ? null : exp - Date.now();
}

/**
 * True when this token can still be used offline.
 *
 * A small safety margin is subtracted so a token that expires in the next
 * minute is not handed to a crew who is about to start a 45-minute call.
 */
export function isUsableOffline(token: string | null | undefined, marginMs = 60_000): boolean {
  const remaining = msUntilExpiry(token);
  if (remaining === null) return false; // unparseable — refuse rather than guess
  return remaining > marginMs;
}

/** Human-readable time remaining, for the shift banner. */
export function formatRemaining(token: string | null | undefined): string | null {
  const ms = msUntilExpiry(token);
  if (ms === null || ms <= 0) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
}

/**
 * Can this device start a shift with no server?
 *
 * Requires a grant that was obtained while online AND has not expired, plus a
 * cached crew roster to pick a name from. Both conditions are real: without the
 * grant there is no proof the company password was ever entered on this device,
 * and without the roster there is nothing to choose.
 */
export function canStartShiftOffline(slug: string | undefined, grant: string | null): {
  ok: boolean;
  reason?: 'no-grant' | 'grant-expired' | 'no-roster';
} {
  if (!grant) return { ok: false, reason: 'no-grant' };
  if (!isUsableOffline(grant)) return { ok: false, reason: 'grant-expired' };
  const roster = getCachedCrewRoster(slug);
  if (!roster || roster.length === 0) return { ok: false, reason: 'no-roster' };
  return { ok: true };
}

/** Test seam. */
export function __clearOfflineShiftCache(slug: string | undefined): void {
  if (!slug) return;
  try {
    localStorage.removeItem(key(slug, 'crew'));
    localStorage.removeItem(key(slug, 'vehicles'));
  } catch {
    /* ignore */
  }
}
