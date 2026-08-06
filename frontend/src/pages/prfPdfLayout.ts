/**
 * Sizing policy for the PRF PDF export.
 *
 * WHY THIS IS A SEPARATE MODULE
 * -----------------------------
 * The export lives in PRFView.tsx, and the 72-test PDF suite runs in jsdom,
 * which has NO layout engine — offsetWidth/offsetHeight are always 0. That is
 * precisely why a defect that shrank the clinical page to ~3pt survived a green
 * suite: the policy was tangled up with measurements the tests could not make.
 *
 * The measuring stays in PRFView (it needs a real browser). The DECISIONS —
 * how far the sheet may be widened, and whether a given snapshot may be shrunk
 * onto one sheet or must be sliced across several — are pure arithmetic and
 * live here, where they can be tested without a layout engine.
 *
 * (It is also a separate file because PRFView.tsx may not export non-components:
 * eslint react-refresh/only-export-components is ERROR severity there.)
 */

// ── A4 landscape printable area, 5mm safety inset on every edge ─────────────
export const PAGE_W_MM = 297;
export const PAGE_H_MM = 210;
export const INSET_MM = 5;
export const MAX_W_MM = PAGE_W_MM - INSET_MM * 2;   // 287
export const MAX_H_MM = PAGE_H_MM - INSET_MM * 2;   // 200

/** Aspect (height/width) a sheet must match to fill the printable area. */
export const SHEET_RATIO = MAX_H_MM / MAX_W_MM;     // ≈ 0.697

/** Width the sheets are authored at. All physical text sizes are relative to it. */
export const DESIGN_W_PX = 1220;

/**
 * Never print text smaller than this fraction of its designed size.
 *
 * Measured on real exports (see devPdfHarness) BEFORE this floor existed. The
 * fill-the-sheet reflow widened a page until its aspect matched the sheet,
 * capped only by an arbitrary 2400px. Because the IV, medication and vitals
 * stacks are fixed-height rows whose height comes from ROW COUNT rather than
 * text wrapping, widening never shortened them — it just made everything
 * smaller when the snapshot was placed at a fixed 287mm:
 *
 *   IV / drugs      reflow width     printed label
 *   0 / 0           1265px           5.76pt
 *   1 / 3           1509px           4.83pt
 *   2 / 4           1945px           3.75pt   <- an ORDINARY cardiac call
 *   6 / 8           2400px (cap)     3.04pt
 *
 * Nothing was ever clipped, so the document looked complete — it was simply
 * unreadable, and rasterised into JPEG at that size, so zooming could not
 * recover it. 0.9 holds the smallest label at ~5.2pt. Overflow now costs an
 * extra SHEET instead of costing legibility.
 */
export const MIN_LEGIBLE_SCALE = 0.9;

/**
 * Hard ceiling on the fill-the-sheet reflow, derived from the floor above.
 * FLOOR, not round: rounding up would put the resulting scale a hair BELOW
 * MIN_LEGIBLE_SCALE (1220/1356 = 0.8997), so the constant meant to enforce the
 * floor would breach it. Flooring keeps `DESIGN_W_PX / MAX_FIT_W >= MIN_LEGIBLE_SCALE`
 * exactly true, which the test sweep asserts.
 */
export const MAX_FIT_W = Math.floor(DESIGN_W_PX / MIN_LEGIBLE_SCALE);   // 1355

/**
 * Beyond this height we slice rather than shrink. NOTE: on its own this was
 * never a legibility guarantee — it is measured on a canvas the reflow has
 * already widened, so the two compounded silently. `planPlacement` applies the
 * legibility floor explicitly.
 */
export const SHRINK_LIMIT_MM = MAX_H_MM * 1.4;

export type Placement =
  | { kind: 'fit'; drawWmm: number; drawHmm: number; textScale: number }
  | { kind: 'shrink'; drawWmm: number; drawHmm: number; textScale: number }
  | { kind: 'slice'; sheets: number; bandHpx: number; textScale: number };

/**
 * Decide how one rasterised sheet is placed on paper.
 *
 * @param canvasW  snapshot width in px  (reflowW × html2canvas scale)
 * @param canvasH  snapshot height in px
 * @param reflowW  CSS width the sheet was reflowed to before snapshotting
 *
 * `textScale` is the printed size of text relative to its designed size — the
 * number the legibility floor governs. 1 means "as authored".
 */
export function planPlacement(canvasW: number, canvasH: number, reflowW: number): Placement {
  const wScale = MAX_W_MM / canvasW;          // mm per source px at full width
  const fullH = canvasH * wScale;             // height in mm when drawn full-width

  // At full width the only thing shrinking text is how far the reflow widened.
  const fullWidthTextScale = DESIGN_W_PX / reflowW;

  if (fullH <= MAX_H_MM + 0.5) {
    const drawH = fullH >= MAX_H_MM * 0.92 ? MAX_H_MM : fullH;
    return { kind: 'fit', drawWmm: MAX_W_MM, drawHmm: drawH, textScale: fullWidthTextScale };
  }

  // Uniform shrink onto one sheet — allowed only while it stays readable.
  const scale = Math.min(MAX_W_MM / canvasW, MAX_H_MM / canvasH);
  const drawWmm = canvasW * scale;
  const shrinkTextScale = fullWidthTextScale * (drawWmm / MAX_W_MM);

  if (fullH <= SHRINK_LIMIT_MM && shrinkTextScale >= MIN_LEGIBLE_SCALE) {
    return { kind: 'shrink', drawWmm, drawHmm: canvasH * scale, textScale: shrinkTextScale };
  }

  // Otherwise slice into full-width bands: every row keeps its full size.
  //
  // The bands are EVEN, not fill-then-remainder. Filling each sheet to the brim
  // and letting the last one take what is left is what produced the near-empty
  // trailing sheet: a page 2% too tall spilled ~1.5% of itself onto a second A4
  // page, which is what "page 1 overlaps onto page 2" looked like on an IFT.
  //
  // Splitting the same content into `sheets` equal bands makes that impossible.
  // For sheets >= 2, `sheets = ceil(canvasH / sheetHpx)` gives
  // `canvasH > (sheets - 1) * sheetHpx`, so
  // `bandHpx >= canvasH / sheets > sheetHpx * (sheets - 1) / sheets >= sheetHpx / 2`
  // — every emitted sheet is more than half full. `bandHpx <= sheetHpx` also
  // holds (sheetHpx is an integer >= canvasH / sheets), so a band can never be
  // drawn taller than the printable area.
  const sheetHpx = Math.max(1, Math.floor(MAX_H_MM / wScale));
  const sheets = Math.max(1, Math.ceil(canvasH / sheetHpx));
  return {
    kind: 'slice',
    sheets,
    bandHpx: Math.max(1, Math.ceil(canvasH / sheets)),
    textScale: fullWidthTextScale,
  };
}

// ── On-SCREEN legibility floor ──────────────────────────────────────────────

/**
 * Never auto-apply a screen zoom below this.
 *
 * The same failure as the print floor above, in the other medium. The viewer
 * shrinks the fixed 1220px sheet with CSS `zoom` so it fits the container,
 * which is right on a desktop column. On a 375px phone it resolves to ~0.30:
 * a full A4 landscape PRF rendered about 363x257 CSS px, where a label
 * authored at 0.62rem (~9.9px) paints at under 3px. Nothing is clipped and
 * nothing errors — the form is simply unreadable, which is what "squished"
 * means when a crew reports it.
 *
 * Panning already works (.prf-screen-wrap is overflow-x:auto) and this page
 * already relaxes the app-wide maximum-scale so pinch-zoom works too. Both were
 * added to let a reader ESCAPE the squished default — but the default itself
 * was never raised, so every phone still opened on the unreadable view and the
 * crew had to know to fix it.
 *
 * 0.75 keeps the smallest label at ~7.4px, which is legible on a phone, and
 * costs horizontal panning — exactly what every PDF reader does with a
 * landscape page on a portrait screen. The true fit-to-width is still kept as
 * `fitScale` so the zoom-out control can reach the full-page overview
 * deliberately; it is just no longer where the reader lands.
 */
export const MIN_SCREEN_ZOOM = 0.75;

/** Width the on-screen fit is computed against: design width plus margin. */
export const SCREEN_FIT_BASIS_PX = 1240;

/**
 * Decide the on-screen zoom for a container `availPx` wide.
 *
 * `fit`     — true fit-to-width; the lower bound the zoom-out control may reach.
 * `applied` — what to actually set by default, never below MIN_SCREEN_ZOOM.
 *
 * Pure arithmetic on purpose: jsdom has no layout engine, so this is the part
 * that can be tested. The measuring stays in PRFView.
 */
export function screenZoomFor(availPx: number): { fit: number; applied: number } {
  const fit = Math.min(1, availPx / SCREEN_FIT_BASIS_PX);
  return { fit, applied: Math.max(fit, MIN_SCREEN_ZOOM) };
}

/**
 * The printed size, in points, of a piece of text authored at `remAtDesign`
 * for a sheet placed with the given `textScale`. Used by tests to assert a
 * legibility floor in absolute terms rather than as a ratio.
 */
export function printedPt(remAtDesign: number, textScale: number, rootPx = 16): number {
  const designPx = remAtDesign * rootPx;
  const mm = designPx * (MAX_W_MM / DESIGN_W_PX) * textScale;
  return mm * 2.83465;   // mm -> pt
}
