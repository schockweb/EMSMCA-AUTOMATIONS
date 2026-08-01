/**
 * Server-reachability circuit breaker.
 *
 * WHY THIS EXISTS
 * ---------------
 * `navigator.onLine` answers "does this device have a network interface", NOT
 * "can I reach the portal". The two come apart in exactly the case that matters
 * to a crew: the phone shows four bars of 4G, and the server is down, or the
 * ambulance is in a basement where the radio is attached but nothing routes.
 *
 * In that state every `!navigator.onLine` guard in the app evaluates FALSE, so
 * the offline paths never trigger. Each request instead runs to its timeout —
 * and the service worker's API strategy is NetworkFirst with a 10-second
 * network timeout, so the app spends ten seconds per call discovering something
 * it already knows. Autosave, draft loading and the crew roster each pay it.
 * The app is not broken, but to a paramedic mid-call it is indistinguishable
 * from broken.
 *
 * This module keeps a single piece of state — is the portal reachable — and
 * lets callers skip the network entirely while it is not. It fails CLOSED
 * toward offline behaviour: when in doubt, use the local copy and queue the
 * write. For an EMS app, working from cached data is always better than a
 * spinner.
 *
 * DESIGN NOTES
 * ------------
 * - Opening the breaker takes CONSECUTIVE failures, not one. A single dropped
 *   request during a lift-shaft transit must not flip the whole app into
 *   offline mode.
 * - Only transport-level failures count. An HTTP 4xx means the server answered
 *   and is emphatically alive; treating a 404 or a 403 as "server down" would
 *   be a bug that hides real errors.
 * - Recovery is by probe, not by hope. Once open, a lightweight `/health` call
 *   runs on a backoff, and the first success closes the breaker and drains the
 *   outbox.
 */

export type ServerState = 'up' | 'down' | 'checking';

/** Consecutive transport failures before the breaker opens. */
const FAILURE_THRESHOLD = 2;

/** Probe backoff while the breaker is open (ms). Caps so recovery stays quick. */
const PROBE_SCHEDULE_MS = [5_000, 10_000, 20_000, 30_000, 60_000];

/** Probe timeout — deliberately short. A slow answer is a down server here. */
const PROBE_TIMEOUT_MS = 4_000;

let state: ServerState = 'up';
let consecutiveFailures = 0;
let probeAttempt = 0;
let probeTimer: ReturnType<typeof setTimeout> | null = null;

type Listener = (s: ServerState) => void;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) {
    try {
      l(state);
    } catch {
      /* a broken subscriber must not break the breaker */
    }
  }
}

/** Subscribe to reachability changes. Returns an unsubscribe function. */
export function onServerStateChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getServerState(): ServerState {
  return state;
}

/**
 * True when the app should not attempt a network call.
 *
 * Covers BOTH senses of offline: no radio at all, and a radio that cannot reach
 * the portal. Callers use this to go straight to the local copy.
 */
export function shouldSkipNetwork(): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return state === 'down';
}

/**
 * Classify a failure as transport-level (server unreachable) or not.
 *
 * An HTTP status of any kind means the server answered, so it is NOT a
 * reachability failure — even a 500. A 500 is a bug; a missing response is an
 * outage. Conflating them would open the breaker on a single broken endpoint
 * and push the whole app offline.
 */
export function isTransportFailure(err: any): boolean {
  if (!err) return false;
  if (err.response) return false; // server answered — not a transport failure
  const code = err.code;
  if (code === 'ERR_NETWORK' || code === 'ECONNABORTED' || code === 'ETIMEDOUT') return true;
  // axios sets neither response nor a recognised code on some aborts.
  if (err.message === 'Network Error') return true;
  return false;
}

/** Record a successful round-trip. Closes the breaker if it was open. */
export function reportSuccess(): void {
  consecutiveFailures = 0;
  if (state !== 'up') {
    state = 'up';
    probeAttempt = 0;
    cancelProbe();
    emit();
  }
}

/**
 * Record a failure. Only transport failures count toward opening the breaker.
 * Returns true when this failure opened it.
 */
export function reportFailure(err: any): boolean {
  if (!isTransportFailure(err)) return false;

  consecutiveFailures += 1;
  if (state === 'up' && consecutiveFailures >= FAILURE_THRESHOLD) {
    state = 'down';
    probeAttempt = 0;
    emit();
    scheduleProbe();
    return true;
  }
  return false;
}

function cancelProbe() {
  if (probeTimer !== null) {
    clearTimeout(probeTimer);
    probeTimer = null;
  }
}

function scheduleProbe() {
  cancelProbe();
  const delay = PROBE_SCHEDULE_MS[Math.min(probeAttempt, PROBE_SCHEDULE_MS.length - 1)];
  probeAttempt += 1;
  probeTimer = setTimeout(() => {
    void probeNow();
  }, delay);
}

/**
 * Probe the portal once. Exposed so the UI can offer a "try again" button and
 * so a returning-to-foreground handler can check immediately rather than
 * waiting out the backoff.
 */
export async function probeNow(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    // No radio at all — no point spending a request, just keep waiting.
    scheduleProbe();
    return false;
  }

  const previous = state;
  if (previous === 'down') {
    state = 'checking';
    emit();
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    // fetch, not axios: no interceptors, no auth header, no retry. `/health` is
    // deliberately unauthenticated and cheap (it is cached server-side for 5s).
    const res = await fetch('/health', {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timer);

    // Any answer at all means reachable. A 503 from a degraded backend still
    // means the network path works and requests will be answered.
    if (res) {
      reportSuccess();
      return true;
    }
    return false;
  } catch {
    state = 'down';
    emit();
    scheduleProbe();
    return false;
  }
}

/**
 * Wire the breaker to browser connectivity events.
 *
 * Coming back onto the radio is a strong hint the portal may be reachable
 * again, so probe immediately rather than waiting out the backoff. Same on
 * returning to the foreground: a crew unlocking their phone expects the app to
 * have caught up by the time they look at it.
 */
export function startServerHealthMonitor(): () => void {
  const onOnline = () => {
    if (state !== 'up') void probeNow();
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible' && state !== 'up') void probeNow();
  };

  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    cancelProbe();
  };
}

/** Test seam — resets all module state. */
export function __resetServerHealth(): void {
  state = 'up';
  consecutiveFailures = 0;
  probeAttempt = 0;
  cancelProbe();
  listeners.clear();
}
