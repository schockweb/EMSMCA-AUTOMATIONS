/**
 * planPage1Sheets — page 1 splits onto continuation sheets instead of being cut.
 *
 * The heights below are real, measured in Chrome via the pdf-harness at genuine
 * maximum field entry. Page 1 has no continuation anywhere else in the export,
 * which is why it was the one sheet the exporter had to shrink-then-slice, and
 * why the cut landed through signature boxes.
 */
import { describe, it, expect } from 'vitest';
import { planPage1Sheets, PAGE1_MAX_H_PX, MAX_FIT_W, SHEET_RATIO } from '../pages/prfPdfLayout';

// call type -> [Band A, Band B, Band C] as measured at max fill.
const MEASURED: Record<string, number[]> = {
  PRIMARY: [359, 520, 305],
  RHT:     [283, 1475, 253],
  WCA_IOD: [359, 831, 305],
};

describe('PAGE1_MAX_H_PX', () => {
  it('is derived from the reflow cap and the sheet ratio, not chosen', () => {
    expect(PAGE1_MAX_H_PX).toBe(Math.floor(MAX_FIT_W * SHEET_RATIO));
    expect(PAGE1_MAX_H_PX).toBe(944);
  });
});

describe('planPage1Sheets', () => {
  it('leaves a page that already fits on one sheet', () => {
    // 862px is the ordinary Primary — the case that was never broken and must
    // not gain a sheet now.
    expect(planPage1Sheets([264, 407, 191])).toEqual([[0, 1, 2]]);
  });

  it('never splits a page that is exactly at the budget', () => {
    expect(planPage1Sheets([444, 500])).toEqual([[0, 1]]);
  });

  it('splits one band past the budget', () => {
    expect(planPage1Sheets([444, 501])).toEqual([[0], [1]]);
  });

  it('keeps every band, in order, however many sheets it takes', () => {
    for (const heights of Object.values(MEASURED)) {
      const sheets = planPage1Sheets(heights);
      expect(sheets.flat()).toEqual(heights.map((_, i) => i));
    }
  });

  it('brings every measured max-fill page within budget, except an indivisible band', () => {
    for (const [call, heights] of Object.entries(MEASURED)) {
      for (const sheet of planPage1Sheets(heights)) {
        const total = sheet.reduce((n, i) => n + heights[i], 0);
        // A single band taller than a sheet cannot be made shorter here; it is
        // given a sheet to itself so the exporter's fallback acts on that band
        // alone. RHT's Band B (the refusal waiver) is the only such case.
        if (sheet.length === 1 && heights[sheet[0]] > PAGE1_MAX_H_PX) continue;
        expect(total, `${call} sheet ${sheet}`).toBeLessThanOrEqual(PAGE1_MAX_H_PX);
      }
    }
  });

  it('isolates an oversized band rather than dragging neighbours onto its sheet', () => {
    // RHT: Band B is 1475px on its own. A and C must not be stranded with it.
    expect(planPage1Sheets(MEASURED.RHT)).toEqual([[0], [1], [2]]);
  });

  it('packs greedily so reading order is preserved', () => {
    // Not balanced: 300+300 then 600, NOT 300 then 300+300.
    expect(planPage1Sheets([300, 300, 600], 700)).toEqual([[0, 1], [2]]);
  });

  it('returns one sheet when nothing has been measured yet', () => {
    // jsdom reports every height as 0, and so does a real browser before
    // layout. Both must mean "leave it alone", never "one sheet per band".
    expect(planPage1Sheets([0, 0, 0])).toEqual([[0, 1, 2]]);
  });

  it('treats missing and nonsense heights as zero rather than throwing', () => {
    expect(planPage1Sheets([NaN, 500, Infinity, -20])).toEqual([[0, 1, 2, 3]]);
  });

  it('has nothing to place for a page with no bands', () => {
    expect(planPage1Sheets([])).toEqual([]);
  });

  it('never emits an empty sheet', () => {
    for (const heights of [[2000], [2000, 2000], [1, 5000, 1], ...Object.values(MEASURED)]) {
      for (const sheet of planPage1Sheets(heights)) expect(sheet.length).toBeGreaterThan(0);
    }
  });
});
