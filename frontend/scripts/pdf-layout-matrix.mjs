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
const JSON_OUT = process.argv.includes('--json');

const CALLS = ['PRIMARY', 'IHT', 'RHT', 'WCA_IOD', 'COURTESY', 'RESUS', 'DOD'];
const DENSITIES = [
  ['min',     { iv: 0, med: 0, vitals: 1 }],
  ['typical', { iv: 1, med: 2, vitals: 3 }],
  ['max',     { iv: 6, med: 8, vitals: 6 }],
  // Beyond anything a real call should produce. Present because clearing only
  // the density that happened to fail proves nothing about the next one — the
  // first pagination attempt passed 'max' while still slicing at this arm.
  ['extreme', { iv: 12, med: 16, vitals: 6 }],
];

const parse = (out) => {
  const sheets = [];
  for (const ln of String(out).split('\n')) {
    const m = ln.match(/^sheet (\d+): (\d+)x(\d+)px -> width (\d+)px.*branch=(\S+(?: x\d+)?)/);
    if (m) sheets.push({ n: +m[1], h: +m[3], branch: m[5] });
  }
  const labels = [...String(out).matchAll(/label\s+0\.56rem: ([0-9.]+)pt/g)].map((x) => +x[1]);
  return { sheets, minLabelPt: labels.length ? Math.min(...labels) : null };
};

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
  const results = [];

  for (const call of CALLS) {
    for (const [dname, d] of DENSITIES) {
      const url = `${BASE}/pdf-harness.html?call=${call}&iv=${d.iv}&med=${d.med}&vitals=${d.vitals}&sticker=1`;
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForSelector('.prf-page', { timeout: 15000 });
      await page.waitForTimeout(400);            // let fonts and the logo settle
      const out = await page.evaluate(() => window.__measure && window.__measure());
      const { sheets, minLabelPt } = parse(out);
      const sliced = sheets.filter((s) => /slice/.test(s.branch));
      results.push({
        call, density: dname,
        sheets: sheets.length,
        tallest: Math.max(...sheets.map((s) => s.h), 0),
        sliced: sliced.map((s) => `sheet${s.n} ${s.branch} @${s.h}px (+${s.h - CEILING})`),
        minLabelPt,
        // Page 1 slicing cuts a signature box in half — always a failure.
        page1Sliced: /slice/.test(sheets[0]?.branch || ''),
        pass: sliced.length === 0 && (minLabelPt === null || minLabelPt >= LABEL_FLOOR),
      });
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
  console.log(`  ${'call'.padEnd(9)} ${'density'.padEnd(8)} ${'sheets'.padEnd(7)} ${'tallest'.padEnd(8)} ${'label'.padEnd(7)} result`);
  for (const r of results) {
    const verdict = r.pass ? 'ok' : (r.page1Sliced ? 'FAIL page 1 sliced' : `FAIL ${r.sliced.join('; ')}`);
    console.log(`  ${r.call.padEnd(9)} ${r.density.padEnd(8)} ${String(r.sheets).padEnd(7)} `
      + `${String(r.tallest).padEnd(8)} ${String(r.minLabelPt ?? '-').padEnd(7)} ${verdict}`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n  ${results.length - failed.length}/${results.length} pass`);
  if (failed.length) console.log(`  FAILING: ${[...new Set(failed.map((f) => f.call + '/' + f.density))].join(', ')}\n`);
}
process.exit(results.every((r) => r.pass) ? 0 : 1);
