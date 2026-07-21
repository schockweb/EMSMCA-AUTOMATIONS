/**
 * Which VISIBLE phase to resume a Digital PRF draft onto, derived from its
 * captured leg timestamps.
 *
 * Used when a PRF is loaded by id WITHOUT a local autosave present. (The local
 * draft path restores the exact saved `phase` instead, which is always a visible
 * phase because the crew is only ever ON visible phases.)
 *
 * The form keeps a 7-entry PHASES array, but three are hidden/embedded for every
 * call type — En Route (1), Clinical (3), Complete (6) — so the crew only ever
 * SEES DISP (0), PT INFO (2), TRANS (4), HNDVR (5). The previous logic returned
 * those hidden indices (e.g. on-scene → 3), which resumed the crew onto a
 * standalone hidden screen with no active node in the stepper. This maps every
 * draft to a VISIBLE phase.
 *
 * Time capture per phase (non-compressed call types):
 *   Dispatch + On Scene → DISP (0)   Depart → TRANS (4)   Arrival / Available → HNDVR (5)
 *
 * "Compressed" call types — Declaration of Death and RHT — hide TRANS + HNDVR as
 * well; they capture every leg inline on the first two screens, so they only ever
 * resume to DISP (0) or PT INFO (2).
 */
export interface PrfLegTimestamps {
  time_dispatched?: string | null;
  time_on_scene?: string | null;
  time_depart_scene?: string | null;
  time_at_destination?: string | null;
  time_available?: string | null;
}

/** Visible phase indices — kept in sync with the PHASES array in DigitalPRFForm. */
export const RESUME_PHASE = {
  DISP: 0,
  PT_INFO: 2,
  TRANS: 4,
  HNDVR: 5,
} as const;

export function inferResumePhase(
  ts: PrfLegTimestamps,
  opts: { compressed?: boolean } = {},
): number {
  if (opts.compressed) {
    // RHT / DoD capture dispatch + on-scene (+ available) all on DISP / PT INFO.
    return ts.time_on_scene ? RESUME_PHASE.PT_INFO : RESUME_PHASE.DISP;
  }
  // Furthest leg reached → the visible phase that owns it. Order matters.
  if (ts.time_available || ts.time_at_destination) return RESUME_PHASE.HNDVR;
  if (ts.time_depart_scene) return RESUME_PHASE.TRANS;
  return RESUME_PHASE.DISP; // dispatch / on-scene / nothing captured yet
}
