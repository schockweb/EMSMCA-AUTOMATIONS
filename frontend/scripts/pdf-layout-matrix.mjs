/**
 * PDF layout regression gate — renders the PRF in a REAL browser and fails when
 * a sheet exceeds the one-page ceiling or drops below the legibility floor.
 *
 *     npx vite --config vite.config.ts --port 5199 &      # or: preview_start pdf-harness
 *     node scripts/pdf-layout-matrix.mjs                  # add --json for machine output
 *
 * WHY THIS EXISTS
 * ---------------
 * The 558-test suite runs in jsdom, which has NO layout engine. It can assert
 * what renders; it can never assert how tall it is. A sheet can be 3000px and
 * every test still passes. Two production defects reached clients through that
 * gap: a clinical page printed at ~3pt, and page 1 sliced mid-signature-box.
 *
 * The ceiling is not arbitrary. Text may not print below 0.9 of design size, so
 * the widest the exporter may reflow to is 1220/0.9 ~= 1355px, and at the A4
 * landscape ratio (0.697) that is 944px of height. Widening and shrinking trade
 * exactly, so no scaling trick rescues an over-tall sheet — it either slices or
 * goes sub-legible.
 *
 * The matrix is deliberately HOSTILE. Typical fixtures are what let both defects
 * through: the previous harness only ever rendered a PRIMARY call.
 */
import { chromium } from 'playwright';

const BASE = process.env.HARNESS_URL || 'http://localhost:5199';
const CEILING = 944;      // px — above this the exporter slices the sheet
const LABEL_FLOOR = 5.0;  // pt — FieldRow labels below this are unreadable
// The 0.46rem text is the smallest on any sheet and prints at 4.84pt when the
// page needs no shrinking. The same 0.9-of-design rule the 944px ceiling is
// derived from puts its floor at 4.84 x 0.9. Deriving it rather than picking a
// round number keeps this gate and the ceiling describing one policy.
const TEXT_FLOOR  = +(4.84 * 0.9).toFixed(2);   // 4.36pt
const JSON_OUT = process.argv.includes('--json');
// 112 combinations is too many to read when they pass. --quiet prints only the
// failures plus the tally.
const QUIET = process.argv.includes('--quiet');

const CALLS = ['PRIMARY', 'IHT', 'RHT', 'WCA_IOD', 'COURTESY', 'RESUS', 'DOD'];
// Density was only ever the ROW count — iv / med / vitals. It is not what makes
// page 1 tall. Page 1 carries no clinical tables at all; its height comes from
// how much text sits in the patient, debtor and billing columns, and the
// harness has always had fixtures for that (`max=1` fills every optional field,
// `long=1` the long free-text answers, `sig=3` the three T&C marks). Nothing
// passed them, so every "max" and "extreme" result was measured against a sheet
// whose billing column read "—" on every row. WCA/IOD at genuine max fill is
// 1499px against a 944px ceiling and slices in two; the gate reported it ok.
//
// The bands now carry the fill flags they always implied.
const DENSITIES = [
  ['min',     { iv: 0,  med: 0,  vitals: 1 }, {}],
  ['typical', { iv: 1,  med: 2,  vitals: 3 }, {}],
  ['max',     { iv: 6,  med: 8,  vitals: 6 }, { max: 1 }],
  // Beyond anything a real call should produce. Present because clearing only
  // the density that happened to fail proves nothing about the next one — the
  // first pagination attempt passed 'max' while still slicing at this arm.
  ['extreme', { iv: 12, med: 16, vitals: 6 }, { max: 1, long: 1, sig: 3 }],
];
// The billing block a call type is actually billed under is chosen by the crew
// and is NOT implied by the call type: a WCA/IOD call billed to a medical aid
// renders the tall employer block AND is classified compact by the sticker
// rule, which is the combination that overflowed. Sweeping the payer axis is
// the only way that pairing shows up.
const BILLINGS = ['MED AID', 'WCA / IOD', 'RAF', 'PVT'];

const parse = (out) => {
  const sheets = [];
  for (const ln of String(out).split('\n')) {
    const m = ln.match(/^sheet (\d+): (\d+)x(\d+)px -> width (\d+)px.*branch=(\S+(?: x\d+)?)/);
    if (m) sheets.push({ n: +m[1], h: +m[3], branch: m[5] });
  }
  const labels = [...String(out).matchAll(/label\s+[0-9.]+rem: ([0-9.]+)pt/g)].map((x) => +x[1]);
  // The 0.56rem label is NOT the smallest text on the sheet — 0.46rem is, and a
  // sheet that shrinks to fit takes both down together. Reading only the label
  // let a page pass at 5.2pt while its smallest text printed at about 4.3pt,
  // which is the whole defect this gate exists to catch. The harness has always
  // printed this line; nothing was reading it.
  const smalls = [...String(out).matchAll(/T&C\s+[0-9.]+rem: ([0-9.]+)pt/g)].map((x) => +x[1]);
  return {
    sheets,
    minLabelPt: labels.length ? Math.min(...labels) : null,
    minTextPt: smalls.length ? Math.min(...smalls) : null,
  };
};

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
  const results = [];

  for (const call of CALLS) {
    for (const [dname, d, fill] of DENSITIES) {
     for (const billing of BILLINGS) {
      const extra = Object.entries(fill).map(([k, v]) => `&${k}=${v}`).join('');
      const url = `${BASE}/pdf-harness.html?call=${call}&iv=${d.iv}&med=${d.med}`
        + `&vitals=${d.vitals}&sticker=1&billing=${encodeURIComponent(billing)}${extra}`;
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForSelector('.prf-page', { timeout: 15000 });
      await page.waitForTimeout(400);            // let fonts and the logo settle
      const out = await page.evaluate(() => window.__measure && window.__measure());
      const { sheets, minLabelPt, minTextPt } = parse(out);
      const sliced = sheets.filter((s) => /slice/.test(s.branch));
      const illegible = minTextPt !== null && minTextPt < TEXT_FLOOR;
      results.push({
        call, density: dname, billing,
        sheets: sheets.length,
        tallest: Math.max(...sheets.map((s) => s.h), 0),
        sliced: sliced.map((s) => `sheet${s.n} ${s.branch} @${s.h}px (+${s.h - CEILING})`),
        minLabelPt, minTextPt, illegible,
        // Page 1 slicing cuts a signature box in half — always a failure.
        page1Sliced: /slice/.test(sheets[0]?.branch || ''),
        pass: sliced.length === 0
          && (minLabelPt === null || minLabelPt >= LABEL_FLOOR)
          && !illegible,
      });
     }
    }
  }
  await browser.close();
  return results;
};

const results = await run();
if (JSON_OUT) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(`\n  PDF layout matrix — ceiling ${CEILING}px, label floor ${LABEL_FLOOR}pt\n`);
  console.log(`  ${'call'.padEnd(9)} ${'density'.padEnd(8)} ${'billing'.padEnd(10)} ${'sheets'.padEnd(7)} `
    + `${'tallest'.padEnd(8)} ${'label'.padEnd(7)} ${'min-text'.padEnd(9)} result`);
  for (const r of results) {
    const verdict = r.pass ? 'ok'
      : r.page1Sliced ? `FAIL page 1 sliced @${r.tallest}px`
      : r.illegible ? `FAIL smallest text ${r.minTextPt}pt < ${TEXT_FLOOR}pt`
      : `FAIL ${r.sliced.join('; ')}`;
    if (!r.pass || !QUIET) {
      console.log(`  ${r.call.padEnd(9)} ${r.density.padEnd(8)} ${r.billing.padEnd(10)} `
        + `${String(r.sheets).padEnd(7)} `
        + `${String(r.tallest).padEnd(8)} ${String(r.minLabelPt ?? '-').padEnd(7)} `
        + `${String(r.minTextPt ?? '-').padEnd(9)} ${verdict}`);
    }
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n  ${results.length - failed.length}/${results.length} pass`);
  if (failed.length) {
    const byCall = {};
    for (const f of failed) (byCall[f.call] ||= new Set()).add(f.density);
    console.log('  FAILING: ' + Object.entries(byCall)
      .map(([c, s]) => `${c}(${[...s].join(',')})`).join('  ') + '\n');
  }
}
process.exit(results.every((r) => r.pass) ? 0 : 1);
