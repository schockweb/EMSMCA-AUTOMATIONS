/**
 * PDF sizing policy — the legibility floor.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The 72-test PDF suite renders PRFView in jsdom with html2canvas mocked to a
 * blank 10x10 canvas. jsdom has no layout engine, so offsetWidth/offsetHeight
 * are 0 and `buildPrfPdf` is never executed. A defect that printed the clinical
 * page at ~3pt therefore lived behind a fully green suite.
 *
 * The measuring still needs a real browser (see src/devPdfHarness.tsx). The
 * DECISIONS are pure arithmetic and are tested here.
 *
 * REAL MEASUREMENTS these tests encode (taken in Chrome, before the fix):
 *   IV / drugs    reflow width    printed label
 *   0 / 0         1265px          5.76pt
 *   1 / 3         1509px          4.83pt
 *   2 / 4         1945px          3.75pt   <- an ORDINARY cardiac call
 *   6 / 8         2400px (cap)    3.04pt
 * After the fix, both of the last two hold at 5.38pt and cost extra sheets.
 */
import { describe, it, expect } from 'vitest';
import {
  planPlacement, printedPt,
  MAX_W_MM, MAX_H_MM, DESIGN_W_PX, MAX_FIT_W, MIN_LEGIBLE_SCALE, SHEET_RATIO,
} from '../pages/prfPdfLayout';

/** html2canvas runs at scale 1.5 in PRFView. */
const canvasFor = (cssW: number, cssH: number) => ({ cw: cssW * 1.5, ch: cssH * 1.5 });

/** The smallest label on the sheet: FieldRow's 0.56rem (PRFView.tsx). */
const SMALLEST_LABEL_REM = 0.56;
const ptFor = (scale: number) => printedPt(SMALLEST_LABEL_REM, scale);

describe('geometry constants', () => {
  it('describes the A4 landscape printable area', () => {
    expect(MAX_W_MM).toBe(287);
    expect(MAX_H_MM).toBe(200);
    expect(SHEET_RATIO).toBeCloseTo(0.697, 3);
  });

  it('caps the reflow so text can never fall below the legibility floor', () => {
    // Assert the INVARIANT, not the formula: a page reflowed all the way to the
    // cap must still print at or above the floor. (Rounding the cap UP instead
    // of down breaks this by a hair — 1220/1356 = 0.8997 — which is exactly the
    // kind of silent breach this floor exists to prevent.)
    expect(DESIGN_W_PX / MAX_FIT_W).toBeGreaterThanOrEqual(MIN_LEGIBLE_SCALE);
    // The old cap was 2400px — nearly 2x the design width, i.e. half-size text.
    expect(MAX_FIT_W).toBeLessThan(1500);
  });

  it('prints the smallest label around 5.8pt at the design width', () => {
    expect(ptFor(1)).toBeCloseTo(5.97, 1);
  });
});

describe('placement — a page that already fits', () => {
  it('draws full width with no shrink', () => {
    const { cw, ch } = canvasFor(1265, 866);
    const plan = planPlacement(cw, ch, 1265);
    expect(plan.kind).toBe('fit');
    expect(plan.textScale).toBeGreaterThanOrEqual(MIN_LEGIBLE_SCALE);
    expect(ptFor(plan.textScale)).toBeGreaterThan(5);
  });
});

describe('placement — the regression that shipped', () => {
  // Heights measured in Chrome from the real component.
  const CASES = [
    { label: '1 IV / 3 drugs', cssH: 1051 },
    { label: '2 IV / 4 drugs (ordinary cardiac call)', cssH: 1355 },
    { label: '6 IV / 8 drugs (busy code)', cssH: 2571 },
  ];

  for (const c of CASES) {
    it(`${c.label}: keeps the printed label legible`, () => {
      // Reflow is capped, so a tall sheet arrives at MAX_FIT_W.
      const { cw, ch } = canvasFor(MAX_FIT_W, c.cssH);
      const plan = planPlacement(cw, ch, MAX_FIT_W);
      expect(plan.textScale).toBeGreaterThanOrEqual(MIN_LEGIBLE_SCALE);
      // 5pt is the floor below which the audit judged the page unreadable.
      expect(ptFor(plan.textScale)).toBeGreaterThan(5);
    });

    it(`${c.label}: pays for the overflow in SHEETS, not in text size`, () => {
      const { cw, ch } = canvasFor(MAX_FIT_W, c.cssH);
      const plan = planPlacement(cw, ch, MAX_FIT_W);
      if (plan.kind === 'slice') expect(plan.sheets).toBeGreaterThan(1);
      else expect(plan.kind).toBe('fit');
    });
  }

  it('reproduces the OLD behaviour to prove these tests can fail', () => {
    // The pre-fix reflow widened this same page to 2400px.
    const { cw, ch } = canvasFor(2400, 2571);
    const plan = planPlacement(cw, ch, 2400);
    // ~3pt — what the scheme actually received.
    expect(ptFor(plan.textScale)).toBeLessThan(3.5);
    expect(plan.textScale).toBeLessThan(MIN_LEGIBLE_SCALE);
  });
});

describe('placement — the shrink branch may not breach the floor', () => {
  it('refuses to shrink onto one sheet when that would shrink text too far', () => {
    // Tall enough that a uniform shrink would be well under the floor.
    const { cw, ch } = canvasFor(MAX_FIT_W, 2200);
    const plan = planPlacement(cw, ch, MAX_FIT_W);
    expect(plan.kind).toBe('slice');
    expect(plan.textScale).toBeGreaterThanOrEqual(MIN_LEGIBLE_SCALE);
  });

  it('still allows a shrink when the result stays readable', () => {
    // Only just over one sheet: shrinking is the nicer outcome (one sheet, and
    // still legible) so the policy should take it rather than slice.
    const { cw, ch } = canvasFor(DESIGN_W_PX, 880);
    const plan = planPlacement(cw, ch, DESIGN_W_PX);
    expect(['fit', 'shrink']).toContain(plan.kind);
    expect(plan.textScale).toBeGreaterThanOrEqual(MIN_LEGIBLE_SCALE);
  });

  it('never returns a plan below the floor, across a sweep of realistic heights', () => {
    for (let cssH = 850; cssH <= 3200; cssH += 50) {
      const { cw, ch } = canvasFor(MAX_FIT_W, cssH);
      const plan = planPlacement(cw, ch, MAX_FIT_W);
      expect(
        plan.textScale,
        `height ${cssH}px produced textScale ${plan.textScale.toFixed(3)} (${ptFor(plan.textScale).toFixed(2)}pt)`,
      ).toBeGreaterThanOrEqual(MIN_LEGIBLE_SCALE);
    }
  });

  it('slice count grows with height instead of text getting smaller', () => {
    const short = planPlacement(...Object.values(canvasFor(MAX_FIT_W, 1400)) as [number, number], MAX_FIT_W);
    const tall = planPlacement(...Object.values(canvasFor(MAX_FIT_W, 2800)) as [number, number], MAX_FIT_W);
    expect(short.textScale).toBeCloseTo(tall.textScale, 5);   // same size text
    if (short.kind === 'slice' && tall.kind === 'slice') {
      expect(tall.sheets).toBeGreaterThan(short.sheets);       // more paper
    }
  });
});
