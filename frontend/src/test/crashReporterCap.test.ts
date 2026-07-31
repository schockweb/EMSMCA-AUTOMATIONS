/**
 * The crash reporter must not be able to author unbounded reports.
 *
 * reportCrash is wired to window.onerror and onunhandledrejection, and the API
 * client reports every 5xx. All three fire repeatedly for a single underlying
 * fault. The development database reached 3.68 MILLION crash rows in 27 days —
 * 99.2% of the whole database — of which 3,679,048 were the SAME message,
 * peaking at 8,166 rows per minute.
 *
 * Two independent limits, because either alone is escapable:
 *   - a fingerprint set, so a repeating fault reports ONCE per session;
 *   - a hard per-session ceiling, so a fault whose message varies (an embedded
 *     timestamp or changing id) still cannot report without bound.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { shouldReportCrash, __resetCrashReporterState } from '../components/ErrorBoundary';

describe('crash reporter rate limiting', () => {
  beforeEach(() => {
    __resetCrashReporterState();
  });

  it('reports a given fault exactly once per session', () => {
    const fp = 'TypeError|Cannot read properties of undefined|/crew/prf';

    expect(shouldReportCrash(fp)).toBe(true);
    for (let i = 0; i < 500; i++) {
      expect(shouldReportCrash(fp)).toBe(false);
    }
  });

  it('still reports genuinely different faults', () => {
    expect(shouldReportCrash('TypeError|a|/x')).toBe(true);
    expect(shouldReportCrash('TypeError|b|/x')).toBe(true);
    expect(shouldReportCrash('RangeError|a|/x')).toBe(true);
    // Same error, different screen — two problems for whoever fixes it.
    expect(shouldReportCrash('TypeError|a|/y')).toBe(true);
  });

  it('hard-caps the session even when every message is unique', () => {
    // This is the case the fingerprint set alone does NOT catch: a render loop
    // whose message embeds a timestamp or a changing id produces a new
    // fingerprint every time.
    let sent = 0;
    for (let i = 0; i < 10_000; i++) {
      if (shouldReportCrash(`TypeError|failure at ${Date.now()}-${i}|/crew/prf`)) sent++;
    }
    expect(sent).toBeLessThanOrEqual(20);
    expect(sent).toBeGreaterThan(0);
  });

  it('the cap survives a mix of repeated and unique faults', () => {
    let sent = 0;
    for (let i = 0; i < 1000; i++) {
      if (shouldReportCrash('TypeError|repeating|/x')) sent++;
      if (shouldReportCrash(`TypeError|unique ${i}|/x`)) sent++;
    }
    expect(sent).toBeLessThanOrEqual(20);
  });

  it('resets for a genuinely new session', () => {
    const fp = 'TypeError|boom|/x';
    expect(shouldReportCrash(fp)).toBe(true);
    expect(shouldReportCrash(fp)).toBe(false);

    __resetCrashReporterState();

    expect(shouldReportCrash(fp)).toBe(true);
  });
});
