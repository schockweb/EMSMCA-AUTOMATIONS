/**
 * Fault hunt — render REAL records and look for the ways a PRF can be wrong.
 *
 *   node scripts/prf-fault-hunt.mjs --session hunt.json --count 300
 *
 * The layout matrix (pdf-layout-matrix.mjs) renders SEVEN synthetic fixtures.
 * This renders whatever is actually in the database, which is the only way to
 * find a fault that depends on real captured data rather than on a fixture
 * somebody wrote to pass.
 *
 * FOUR FAULTS, and the order matters — the last one is the one nothing else
 * could see:
 *
 *  1. CRASH        an uncaught exception. The crew or the adjudicator gets a
 *                  blank screen; on this file the recurring causes are a
 *                  missing theme token and a wrong runtime type from the API.
 *  2. SLICE        a sheet over the ~944px ceiling, which the exporter cuts
 *                  in half rather than shrinking below the legibility floor.
 *  3. HOLE         a sheet whose tallest column is filled less than a third —
 *                  not a rendering failure, but on a printed clinical form an
 *                  empty column reads as a section the crew did not complete,
 *                  and it is how a spilled section announces it left nothing
 *                  behind. This is the defect the clinical page had AFTER the
 *                  overflow was fixed.
 *  4. CLIPPED      an element whose content is taller or wider than the box
 *                  drawing it, inside something with overflow hidden. THIS IS
 *                  SILENT. The sheet is the right height, nothing slices,
 *                  every automated height check passes — and a line of the
 *                  clinical record is simply not on the page. On a document a
 *                  scheme adjudicates and a court can subpoena, quietly losing
 *                  a line of drug history is the worst failure in this list,
 *                  and it is the only one with no visible symptom.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const TARGET = process.env.TARGET || 'https://portal.emsmca.co.za';
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const SESSION = arg('--session', 'hunt.json');
const COUNT = Number(arg('--count', '300'));
const CEILING = 944;

const s = JSON.parse(readFileSync(SESSION, 'utf8'));
const cases = s.cases.slice(0, COUNT);

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();

  await page.goto(`${TARGET}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('access_token', t), s.admin_token);

  const faults = [];
  let done = 0, rendered = 0;

  for (const c of cases) {
    const crashes = [];
    const onErr = (e) => crashes.push(String(e).slice(0, 200));
    page.on('pageerror', onErr);
    let r = null;
    try {
      await page.goto(`${TARGET}/cases/${c.case_id}/prf`, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForSelector('.prf-page', { timeout: 25000 });
      await page.waitForTimeout(500);

      r = await page.evaluate((ceiling) => {
        const sheets = [...document.querySelectorAll('.prf-page')];
        const out = { sheets: [], clipped: [] };

        // CLIPPED: walk every element and compare what it wants to draw with
        // the box it is drawing into. Only counted where something in the
        // ancestry actually hides the overflow — otherwise the content is
        // merely spilling visibly, which the height checks already catch.
        const hides = (el) => {
          for (let n = el; n && n !== document.body; n = n.parentElement) {
            const o = getComputedStyle(n);
            if (o.overflow === 'hidden' || o.overflowY === 'hidden' || o.overflowX === 'hidden') return true;
          }
          return false;
        };
        for (const sheet of sheets) {
          for (const el of sheet.querySelectorAll('*')) {
            const dy = el.scrollHeight - el.clientHeight;
            const dx = el.scrollWidth - el.clientWidth;
            if ((dy > 2 || dx > 2) && el.clientHeight > 0 && hides(el)) {
              out.clipped.push({
                dy, dx, tag: el.tagName,
                text: (el.textContent || '').replace(/\s+/g, ' ').slice(0, 70),
              });
            }
          }
        }

        for (const [i, pg] of sheets.entries()) {
          const bands = [...pg.children].filter((x) => x.dataset.contHeader !== '1');
          let worstFill = 1;
          for (const bd of bands) {
            if (bd.offsetHeight < 200) continue;      // header strips are not holes
            const prev = bd.style.alignItems; bd.style.alignItems = 'start';
            for (const col of bd.children) {
              const kids = [...col.children];
              const inked = kids.reduce((n, k) => n + k.offsetHeight, 0);
              worstFill = Math.min(worstFill, inked / bd.offsetHeight);
            }
            bd.style.alignItems = prev;
          }
          out.sheets.push({ n: i + 1, h: pg.offsetHeight, fill: worstFill });
        }
        out.over = out.sheets.filter((x) => x.h > ceiling);
        return out;
      }, CEILING);
      rendered++;
    } catch (e) {
      faults.push({ ...c, type: 'RENDER', detail: String(e).split('\n')[0].slice(0, 120) });
    }
    page.off('pageerror', onErr);

    if (crashes.length) faults.push({ ...c, type: 'CRASH', detail: crashes[0] });
    if (r) {
      for (const o of r.over) {
        faults.push({ ...c, type: 'SLICE', detail: `sheet ${o.n} at ${o.h}px (+${o.h - CEILING})` });
      }
      // A hole only matters on a sheet that had room to be fuller.
      for (const sh of r.sheets) {
        if (sh.fill < 0.33 && sh.h > 400) {
          faults.push({ ...c, type: 'HOLE', detail: `sheet ${sh.n} tallest column ${(sh.fill * 100).toFixed(0)}% filled` });
        }
      }
      for (const cl of r.clipped.slice(0, 3)) {
        faults.push({ ...c, type: 'CLIPPED', detail: `${cl.tag} loses ${cl.dy || cl.dx}px: "${cl.text}"` });
      }
    }

    if (++done % 25 === 0) {
      console.log(`    ... ${done}/${cases.length} rendered  faults=${faults.length}`);
    }
  }
  await browser.close();

  const by = {};
  for (const f of faults) (by[f.type] ||= []).push(f);
  console.log(`\n  ── fault hunt over ${rendered}/${cases.length} real records ──`);
  for (const t of ['CRASH', 'CLIPPED', 'SLICE', 'HOLE', 'RENDER']) {
    const n = (by[t] || []).length;
    console.log(`  ${t.padEnd(9)} ${String(n).padEnd(5)} ${n ? '<-- ' + [...new Set(by[t].map(f => f.band))].join(',') : 'none'}`);
  }
  for (const t of Object.keys(by)) {
    console.log(`\n  ${t} examples:`);
    for (const f of by[t].slice(0, 5)) {
      console.log(`    ${f.call_type}/${f.band}  ${f.case_id.slice(0, 8)}  ${f.detail}`);
    }
  }
  writeFileSync('fault-hunt-report.json', JSON.stringify({ rendered, faults }, null, 1));
  console.log(`\n  full report: fault-hunt-report.json`);
  return faults.filter((f) => f.type === 'CRASH' || f.type === 'CLIPPED' || f.type === 'SLICE').length === 0;
};

process.exit((await run()) ? 0 : 1);
