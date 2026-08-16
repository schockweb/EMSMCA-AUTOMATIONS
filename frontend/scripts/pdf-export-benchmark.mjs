/**
 * PDF export benchmark — generates REAL PDFs from REAL records, in a browser.
 *
 *   node scripts/pdf-export-benchmark.mjs --session pdfbench.json --count 200
 *
 * WHAT THIS MEASURES, AND WHY THE OBVIOUS TEST WOULD NOT
 * ------------------------------------------------------
 * The PRF PDF is built CLIENT-SIDE — html2canvas rasterises each sheet and
 * jsPDF assembles them, in the browser of whoever pressed the button. There is
 * no server-side PDF service. So "can it generate 1,000 PDFs a day" is NOT a
 * server capacity question, and loading records into the database does not
 * exercise it at all: those 1,000 exports are 1,000 separate devices doing one
 * export each, roughly one every 90 seconds across a whole day, with no shared
 * resource between them.
 *
 * The question that IS worth answering is therefore per-export, on one device:
 * does it succeed, how long does the crew wait, how big is the file, and how
 * many sheets does it come to — across every call type and every fill density,
 * on records a crew actually captured rather than a fixture.
 *
 * That is what this does: opens each case, presses the real "Save as PDF"
 * button, catches the download, and records the outcome.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const TARGET = process.env.TARGET || 'https://portal.emsmca.co.za';
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const SESSION = arg('--session', 'pdfbench.json');
const COUNT = Number(arg('--count', '200'));

const s = JSON.parse(readFileSync(SESSION, 'utf8'));
const cases = s.cases.slice(0, COUNT);

const pct = (xs, p) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p / 100))];
};

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const crashes = [];
  page.on('pageerror', (e) => crashes.push(String(e).slice(0, 140)));

  await page.goto(`${TARGET}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((tok) => localStorage.setItem('access_token', tok), s.admin_token);

  const rows = [];
  let done = 0;
  for (const c of cases) {
    const t0 = Date.now();
    let rec = { case_id: c.case_id, call: c.call_type, band: c.band, ok: false };
    try {
      await page.goto(`${TARGET}/cases/${c.case_id}/prf`, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForSelector('.prf-page', { timeout: 30000 });
      // Let fonts, the logo and the inline signature images settle — the same
      // 400ms the share-sheet build waits out before snapshotting.
      await page.waitForTimeout(600);
      rec.sheets = await page.locator('.prf-page').count();
      rec.renderMs = Date.now() - t0;

      const t1 = Date.now();
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 120000 }),
        page.getByLabel('Save as PDF').click(),
      ]);
      const path = await dl.path();
      const { size } = await import('node:fs').then(m => m.promises.stat(path));
      rec.exportMs = Date.now() - t1;
      rec.bytes = size;
      rec.name = dl.suggestedFilename();
      // A jsPDF file always starts %PDF- and ends with an EOF marker. Size
      // alone would pass a truncated or empty download.
      const head = readFileSync(path).subarray(0, 5).toString();
      const tail = readFileSync(path).subarray(-1024).toString();
      rec.validPdf = head === '%PDF-' && /%%EOF/.test(tail);
      rec.ok = rec.validPdf && size > 20_000;
    } catch (e) {
      rec.error = String(e).split('\n')[0].slice(0, 110);
    }
    rows.push(rec);
    if (++done % 20 === 0) {
      const okN = rows.filter(r => r.ok).length;
      console.log(`    ... ${done}/${cases.length}  ok=${okN}  ` +
        `p50 export ${pct(rows.filter(r => r.exportMs).map(r => r.exportMs), 50)}ms`);
    }
  }
  await browser.close();

  const ok = rows.filter(r => r.ok);
  const bad = rows.filter(r => !r.ok);
  const exp = ok.map(r => r.exportMs);
  const ren = ok.map(r => r.renderMs);
  const kb = ok.map(r => r.bytes / 1024);
  const sh = ok.map(r => r.sheets);

  console.log(`\n  ── PDF export benchmark (${TARGET}) ──`);
  console.log(`  exports attempted        ${rows.length}`);
  console.log(`  valid PDFs produced      ${ok.length}   (${(100 * ok.length / rows.length).toFixed(1)} %)`);
  console.log(`  failures                 ${bad.length}`);
  console.log(`  uncaught page errors     ${crashes.length}`);
  console.log(`\n  render to on-screen      p50 ${pct(ren, 50)}ms   p95 ${pct(ren, 95)}ms`);
  console.log(`  build + download the PDF p50 ${pct(exp, 50)}ms   p95 ${pct(exp, 95)}ms   max ${Math.max(...exp, 0)}ms`);
  console.log(`  file size                p50 ${pct(kb, 50).toFixed(0)}kB   p95 ${pct(kb, 95).toFixed(0)}kB   max ${Math.max(...kb, 0).toFixed(0)}kB`);
  console.log(`  sheets per PDF           p50 ${pct(sh, 50)}   p95 ${pct(sh, 95)}   max ${Math.max(...sh, 0)}`);

  const byCall = {};
  for (const r of ok) {
    (byCall[r.call] ||= []).push(r);
  }
  console.log(`\n  by call type:`);
  for (const [k, v] of Object.entries(byCall).sort()) {
    console.log(`    ${String(k).padEnd(10)} n=${String(v.length).padEnd(4)} ` +
      `export p50 ${String(pct(v.map(r => r.exportMs), 50)).padEnd(6)}ms  ` +
      `${pct(v.map(r => r.bytes / 1024), 50).toFixed(0)}kB  ${pct(v.map(r => r.sheets), 50)} sheets`);
  }
  if (bad.length) {
    console.log(`\n  failures:`);
    for (const r of bad.slice(0, 8)) console.log(`    ${r.case_id} ${r.call}  ${r.error || 'invalid pdf'}`);
  }

  // What the client actually asked about, stated in their terms rather than
  // implied from a throughput number that does not apply to a client-side job.
  const p95s = pct(exp, 95) / 1000;
  console.log(`\n  1,000 exports a day = one roughly every 86 seconds, each on a`);
  console.log(`  different device. At p95 ${p95s.toFixed(1)}s per export they do not overlap`);
  console.log(`  and never queue: the work is done by the browser that asked for it.\n`);
  return bad.length === 0;
};

const okAll = await run();
process.exit(okAll ? 0 : 1);
