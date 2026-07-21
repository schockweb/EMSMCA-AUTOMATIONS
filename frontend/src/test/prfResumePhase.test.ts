import { describe, it, expect } from 'vitest';
import { inferResumePhase } from '../utils/prfResumePhase';

// Hidden phase indices that must NEVER be returned (they aren't in the stepper).
const HIDDEN = new Set([1, 3, 6]);

describe('inferResumePhase', () => {
  describe('standard call types (Primary / Courtesy / IHT / RESUS / WCA_IOD)', () => {
    it('empty draft → DISP (0)', () => {
      expect(inferResumePhase({})).toBe(0);
    });
    it('dispatch only → DISP (0)', () => {
      expect(inferResumePhase({ time_dispatched: 't' })).toBe(0);
    });
    it('on-scene captured → DISP (0), NOT the old hidden Clinical (3)', () => {
      // This is the common Primary/Courtesy resume case the bug broke.
      expect(inferResumePhase({ time_dispatched: 't', time_on_scene: 't' })).toBe(0);
    });
    it('depart scene → TRANS (4)', () => {
      expect(inferResumePhase({ time_on_scene: 't', time_depart_scene: 't' })).toBe(4);
    });
    it('arrival → HNDVR (5)', () => {
      expect(inferResumePhase({ time_depart_scene: 't', time_at_destination: 't' })).toBe(5);
    });
    it('available → HNDVR (5), NOT the old hidden Complete (6)', () => {
      expect(inferResumePhase({ time_at_destination: 't', time_available: 't' })).toBe(5);
    });
  });

  describe('compressed call types (RHT / Declaration of Death)', () => {
    const c = { compressed: true };
    it('empty draft → DISP (0)', () => {
      expect(inferResumePhase({}, c)).toBe(0);
    });
    it('dispatch only → DISP (0)', () => {
      expect(inferResumePhase({ time_dispatched: 't' }, c)).toBe(0);
    });
    it('on-scene → PT INFO (2)', () => {
      expect(inferResumePhase({ time_dispatched: 't', time_on_scene: 't' }, c)).toBe(2);
    });
    it('available (captured inline on PT INFO) → PT INFO (2), never HNDVR/Complete', () => {
      expect(inferResumePhase({ time_on_scene: 't', time_available: 't' }, c)).toBe(2);
    });
  });

  it('NEVER returns a hidden phase (1/3/6) for any timestamp combination', () => {
    const keys = ['time_dispatched', 'time_on_scene', 'time_depart_scene', 'time_at_destination', 'time_available'] as const;
    // Every subset of captured timestamps, both compressed and not.
    for (let mask = 0; mask < (1 << keys.length); mask++) {
      const ts: Record<string, string> = {};
      keys.forEach((k, i) => { if (mask & (1 << i)) ts[k] = 't'; });
      for (const compressed of [false, true]) {
        const p = inferResumePhase(ts, { compressed });
        expect(HIDDEN.has(p), `hidden phase ${p} for ts=${JSON.stringify(ts)} compressed=${compressed}`).toBe(false);
        expect([0, 2, 4, 5]).toContain(p);
      }
    }
  });
});
