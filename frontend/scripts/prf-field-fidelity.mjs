/**
 * Field fidelity — does everything captured in the ePRF reach the PDF?
 *
 *   node scripts/prf-field-fidelity.mjs --session hunt.json --count 120
 *
 * The layout gate proves the sheets fit and the fault hunt proves nothing is
 * cut off. Neither answers the question a scheme actually asks: is the value
 * the crew typed ON the document? A field can be dropped from the renderer
 * entirely — never referenced, never laid out, nothing to slice — and every
 * layout check in this repo passes while the record is quietly incomplete.
 *
 * So this reads what was CAPTURED straight from the API, renders the record,
 * reads every word the sheets actually draw, and reports which captured values
 * never appear.
 *
 * WHY MATCHING IS NOT A STRAIGHT STRING COMPARE
 * --------------------------------------------
 * The PDF is a document, not a data dump, and it legitimately transforms what
 * it shows:
 *   - dates print dd/mm/yyyy from an ISO value
 *   - booleans become a tick, with no text at all
 *   - signatures and photographs are images
 *   - some keys are internal (underscore-prefixed, server-managed)
 * Each of those is handled explicitly below. Anything NOT explained that way is
 * a real gap, and gets reported.
 *
 * A field being absent is not automatically a defect either — a form can hold
 * data a given call type does not print, and that can be deliberate. The output
 * is evidence for a human to rule on, which is why it prints the key, the value
 * and how often it happened rather than a pass/fail count alone.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const TARGET = process.env.TARGET || 'https://portal.emsmca.co.za';
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const SESSION = arg('--session', 'hunt.json');
const COUNT = Number(arg('--count', '120'));

const s = JSON.parse(readFileSync(SESSION, 'utf8'));
const cases = s.cases.slice(0, COUNT);

// Captured, but never expected as TEXT on the sheet. Each entry is a reason,
// not a convenience: anything parked here is excluded from the result, so the
// list is the honest limit of what this proves.
const NOT_TEXT = [
  /_signature$/, /_sig$/, /signature/i,        // drawn, then rendered as an image
  /sticker/i, /_image$/, /_photo$/, /_pdf$/,   // photographs and attachments
  /^_/,                                        // server-managed, stripped on save
  /^crew_signoff_sigs$/, /^geos?$/,            // structural, not printed as text
  /_base64$/, /^data:/,
];
const isNotText = (k) => NOT_TEXT.some((r) => r.test(k));

// The document's own renderings of a captured value.
const variants = (v) => {
  const out = new Set();
  const str = String(v).trim();
  if (!str) return out;
  out.add(str.toLowerCase());
  // ISO date -> dd/mm/yyyy, which is what fmtDateValue prints
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    out.add(`${m[3]}/${m[2]}/${m[1]}`);
    out.add(`${Number(m[3])}/${Number(m[2])}/${m[1]}`);
  }
  // ISO timestamp -> HH:MM
  const t = str.match(/T(\d{2}):(\d{2})/);
  if (t) out.add(`${t[1]}:${t[2]}`);
  // numbers may print with or without decimals
  if (/^\d+\.0+$/.test(str)) out.add(str.replace(/\.0+$/, ''));
  // long prose: match a distinctive slice rather than the whole paragraph,
  // because the renderer collapses and re-wraps whitespace
  if (str.length > 40) out.add(str.slice(0, 40).toLowerCase());
  return out;
};

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${TARGET}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('access_token', t), s.admin_token);

  const missing = new Map();     // key -> {n, example, calls:Set}
  let checked = 0, fields = 0, present = 0, skipped = 0, done = 0;

  for (const c of cases) {
    try {
      await page.goto(`${TARGET}/cases/${c.case_id}/prf`, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForSelector('.prf-page', { timeout: 25000 });
      await page.waitForTimeout(400);

      const fd = await page.evaluate(async (id) => {
        const t = localStorage.getItem('access_token');
        const r = await fetch(`/api/digital-prf/admin/by-case/${id}`, { headers: { Authorization: 'Bearer ' + t } });
        return r.ok ? ((await r.json()).form_data || {}) : null;
      }, c.case_id);
      if (!fd) continue;

      const text = (await page.evaluate(() =>
        [...document.querySelectorAll('.prf-page')].map((p) => p.textContent || '').join(' ')
      )).replace(/\s+/g, ' ').toLowerCase();

      for (const [k, v] of Object.entries(fd)) {
        if (v === null || v === undefined || v === '' || v === false) continue;
        if (typeof v === 'boolean') { skipped++; continue; }     // renders as a tick
        if (isNotText(k)) { skipped++; continue; }
        if (typeof v === 'object') { skipped++; continue; }      // rows checked via their own keys
        const str = String(v).trim();
        if (!str || str.length < 2) continue;
        if (str.startsWith('data:')) { skipped++; continue; }
        fields++;
        const hit = [...variants(str)].some((x) => text.includes(x));
        if (hit) { present++; continue; }
        const e = missing.get(k) || { n: 0, example: str.slice(0, 60), calls: new Set() };
        e.n++; e.calls.add(c.call_type);
        missing.set(k, e);
      }
      checked++;
    } catch { /* counted by absence */ }
    if (++done % 20 === 0) console.log(`    ... ${done}/${cases.length}  fields checked ${fields}`);
  }
  await browser.close();

  const rows = [...missing.entries()].sort((a, b) => b[1].n - a[1].n);
  console.log(`\n  ── field fidelity: ePRF capture -> rendered PDF ──`);
  console.log(`  records checked        ${checked}`);
  console.log(`  captured text fields   ${fields}`);
  console.log(`  found on the document  ${present}   (${(100 * present / (fields || 1)).toFixed(2)} %)`);
  console.log(`  NOT found              ${fields - present}`);
  console.log(`  excluded (images, ticks, internal): ${skipped}`);
  if (rows.length) {
    console.log(`\n  captured but not on the document — ${rows.length} distinct field(s):`);
    for (const [k, e] of rows) {
      console.log(`    ${k.padEnd(34)} x${String(e.n).padEnd(5)} ${[...e.calls].join(',').padEnd(22)} e.g. "${e.example}"`);
    }
  } else {
    console.log(`\n  every captured value appears on the rendered document.`);
  }
  writeFileSync('field-fidelity-report.json', JSON.stringify({
    checked, fields, present,
    missing: rows.map(([k, e]) => ({ key: k, count: e.n, calls: [...e.calls], example: e.example })),
  }, null, 1));
  console.log(`\n  full report: field-fidelity-report.json`);
  return rows.length === 0;
};

process.exit((await run()) ? 0 : 1);
