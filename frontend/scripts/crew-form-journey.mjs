/**
 * Crew-form smoke journey — drives the REAL form in a REAL browser.
 *
 *   node scripts/crew-form-journey.mjs            # against production
 *   TARGET=http://localhost:5199 node scripts/crew-form-journey.mjs
 *
 * Needs a session bundle on stdin or at --session (see
 * backend/crew_session_bootstrap.py), which mints a crew token, a portal grant
 * and a vehicle for the throwaway tenant.
 *
 * WHY THIS EXISTS
 * ---------------
 * The 578-test suite runs in jsdom, and the PDF matrix drives a real browser
 * but only ever renders PRFView — the read-only sheet. Nothing had ever driven
 * DigitalPRFForm, the thing a paramedic actually touches. The gap is not
 * theoretical: the first run of this found that the crew dashboard's vehicle
 * picker could never load, because it was the one call in that file that
 * omitted the portal-grant header and answered 401 to every online crew.
 *
 * jsdom cannot find that class of defect. It has no network, so a missing
 * Authorization header is invisible; the component renders, the test asserts
 * on what rendered, and it passes.
 *
 * WHY IT AUTHENTICATES PROGRAMMATICALLY
 * -------------------------------------
 * The session is injected into localStorage exactly as a completed sign-in
 * would leave it, rather than typed into the login form. The sign-in flow
 * already has jsdom coverage (offlineShiftStart, offlineCrewRoster), it is not
 * what is under test, and this way no password is typed by a machine.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const TARGET = process.env.TARGET || 'https://portal.emsmca.co.za';
const SESSION = process.argv.includes('--session')
  ? process.argv[process.argv.indexOf('--session') + 1]
  : 'session.json';

const s = JSON.parse(readFileSync(SESSION, "utf8"));
const SLUG = s.provider_slug;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};
// Ground this harness does not yet cover. Reported, not silently dropped, and
// NOT counted as a failure — a gate that is always red is a gate everyone
// learns to ignore, and these are harness limits rather than product defects.
const skip = (name, why) => {
  results.push({ name, skipped: true, detail: why });
  console.log(`  SKIP  ${name}  [${why}]`);
};

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    // The dispatch step asks for a fix. Granting it keeps the run on the happy
    // path instead of measuring the permission-denied fallback every time.
    permissions: ['geolocation'],
    geolocation: { latitude: -26.2041, longitude: 28.0473 },   // Johannesburg
    acceptDownloads: true,     // the PDF export at the end hands back a file
  });
  const page = await ctx.newPage();

  // Uncaught exceptions are the crash family this is really hunting: a missing
  // theme token or a wrong runtime type from the API takes the whole form out,
  // and the crew sees a blank screen mid-call.
  const crashes = [];
  page.on('pageerror', (e) => crashes.push(String(e).slice(0, 160)));

  // Every write the form makes, so "does it autosave" is answered by evidence.
  const writes = [];
  page.on('response', async (r) => {
    const u = r.url();
    if (/\/api\/digital-prf/.test(u) && r.request().method() !== 'GET') {
      writes.push({ m: r.request().method(), status: r.status(), u: u.replace(/^.*\/api/, '/api') });
    }
  });

  await page.goto(`${TARGET}/${SLUG}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([sess, slug]) => {
    localStorage.setItem('crew_token', sess.crew_token);
    localStorage.setItem('crew_profile', JSON.stringify(sess.crew_profile));
    localStorage.setItem('crew2_profile', JSON.stringify(sess.partner));
    localStorage.setItem('portal_grant_' + slug, sess.grant);
    if (sess.vehicle) localStorage.setItem('active_vehicle', JSON.stringify(sess.vehicle));
  }, [s, SLUG]);

  // ── the dashboard ────────────────────────────────────────────────────────
  await page.goto(`${TARGET}/${SLUG}/crew/dashboard`, { waitUntil: 'networkidle' });
  const onShift = await page.getByText('ON SHIFT').count();
  check('crew dashboard renders the shift', onShift > 0);

  // The vehicle picker: the regression that started this script. It must list
  // the vehicle, not "Could not reach the server".
  const vehResp = await page.evaluate(async ([slug]) => {
    const g = localStorage.getItem('portal_grant_' + slug);
    const r = await fetch(`/api/providers/${slug}/public-vehicles`, {
      headers: { Authorization: 'Bearer ' + g },
    });
    return { status: r.status, n: r.ok ? (await r.json()).length : 0 };
  }, [SLUG]);
  check('vehicle list loads with the portal grant', vehResp.status === 200 && vehResp.n > 0,
        `HTTP ${vehResp.status}, ${vehResp.n} vehicle(s)`);

  // ── open a PRF the way a crew does ───────────────────────────────────────
  await page.getByRole('button', { name: /new prf/i }).click().catch(() => {});
  await page.waitForURL(/\/crew\/prf\//, { timeout: 20000 });
  const prfId = page.url().split('/crew/prf/')[1];
  check('New PRF creates a record and opens the form', !!prfId, prfId);

  await page.waitForSelector('text=CALL TYPE', { timeout: 15000 });
  check('form reaches the call-type step', true);

  // ── drive the dispatch step ──────────────────────────────────────────────
  await page.getByRole('button', { name: 'PRIMARY', exact: true }).click();
  const km = page.getByPlaceholder(/e\.g\. 14250/);
  if (await km.count()) {
    await km.fill('14250');
    await page.getByRole('button', { name: /start route/i }).click();
  }
  await page.waitForTimeout(2500);
  const atDispatch = await page.getByText(/DISPATCH TIMES/i).count();
  check('call type selected and dispatch step entered', atDispatch > 0);

  // ── does it persist? test the CONTRACT, not an assumption ────────────────
  // The form is offline-first on purpose: it writes to a local draft ~400ms
  // after a change, and pushes a server backup on app-switch, on phase change
  // and every 5 minutes. An early version of this script asserted the server
  // had the data within five seconds and "failed" — measuring a cadence the
  // form never promised. Mid-call, the guarantee that matters is the LOCAL
  // write; the server backup is the lost-device safety net. Both are checked,
  // each on its own terms.
  await page.waitForTimeout(1500);
  const local = await page.evaluate((id) => {
    try {
      const d = JSON.parse(localStorage.getItem(`prf-draft:${id}`) || '{}');
      return { call_type: (d.fd || {}).call_type, kms: Object.keys(d.kms || {}).length,
               savedAt: !!d.savedAt };
    } catch { return {}; }
  }, prfId);
  check('capture is safe on the device immediately', local.call_type === 'PRIMARY',
        `call_type=${local.call_type} km entries=${local.kms}`);

  // The documented safety net: locking the phone / switching apps must push a
  // server backup. Simulating the visibility change is the honest way to test
  // it — the alternative is waiting out the five-minute timer.
  const before = writes.length;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(4000);
  const patched = writes.slice(before).filter(w => w.m === 'PATCH');
  check('app-switch pushes a server backup', patched.length > 0,
        patched.map(w => `PATCH ${w.status}`).join(', ') || 'no PATCH observed');

  const saved = await page.evaluate(async (id) => {
    const t = localStorage.getItem('crew_token');
    const r = await fetch(`/api/digital-prf/${id}`, { headers: { Authorization: 'Bearer ' + t } });
    if (!r.ok) return { status: r.status };
    const b = await r.json();
    const fd = b.form_data || {};
    return { status: 200, call_type: fd.call_type, keys: Object.keys(fd).length,
             km: b.km_dispatched };
  }, prfId);
  check('the backup actually landed on the server', saved.call_type === 'PRIMARY',
        `call_type=${saved.call_type} keys=${saved.keys} km=${saved.km}`);
  check('writes observed', writes.length > 0,
        writes.map(w => `${w.m} ${w.status}`).join(', ') || 'none');

  // Move to the Patient Information phase, which is where the crew actually
  // types. The form resumes from the local draft's `phase` — using its own
  // resume mechanism rather than clicking seven gated CTAs, which would test
  // the gates rather than the phase.
  const gotoPhase = async (n) => {
    await page.evaluate(([i, phase]) => {
      const k = `prf-draft:${i}`;
      const d = JSON.parse(localStorage.getItem(k) || '{}');
      d.phase = phase; d.savedAt = Date.now();
      localStorage.setItem(k, JSON.stringify(d));
    }, [prfId, n]);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1600);
  };
  await gotoPhase(2);
  const fieldCount = await page.evaluate(() =>
    [...document.querySelectorAll('input,textarea')].filter(e => e.offsetParent).length);
  check('patient-information phase renders its fields', fieldCount > 20, `${fieldCount} fields`);

  // ── offline: the case the crew actually lives in ─────────────────────────
  // A paramedic works in basements and lift shafts. The contract is that
  // capture continues with no signal and syncs when it returns — so this drops
  // the network for real (Playwright's offline mode, not a mocked navigator
  // flag), types into the form, and checks BOTH halves: the draft is safe on
  // the device while offline, and the server catches up afterwards.
  const beforeOffline = writes.length;
  await ctx.setOffline(true);
  await page.waitForTimeout(500);

  // Typed with real keystrokes, not a synthetic value assignment: a React
  // controlled input ignores a raw .value write unless the native setter is
  // used, and typing is what a crew does anyway.
  const target = page.locator('input[type="text"]:visible, textarea:visible').first();
  let offlineTyped = null;
  if (await target.count()) {
    await target.click();
    await target.fill('OFFLINE-CAPTURE-MARK');
    offlineTyped = await target.evaluate(e => e.name || e.placeholder || e.tagName);
  }
  await page.waitForTimeout(1800);

  const offlineDraft = await page.evaluate((id) => {
    const raw = localStorage.getItem(`prf-draft:${id}`) || '{}';
    return raw.includes('OFFLINE-CAPTURE-MARK');
  }, prfId);
  check('capture continues with no signal', offlineDraft === true,
        `typed into ${offlineTyped || 'no field found'}`);

  // Nothing may reach the server while offline — if a write "succeeded" here
  // the offline mode is not really off, and the rest of this proves nothing.
  const duringOffline = writes.slice(beforeOffline).filter(w => w.status >= 200 && w.status < 300);
  check('nothing is written while offline', duringOffline.length === 0,
        `${duringOffline.length} successful writes during the outage`);

  await ctx.setOffline(false);
  await page.waitForTimeout(1200);
  const beforeSync = writes.length;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(5000);
  const synced = writes.slice(beforeSync).some(w => w.m === 'PATCH' && w.status === 200);
  check('the device syncs once signal returns', synced,
        writes.slice(beforeSync).map(w => `${w.m} ${w.status}`).join(', ') || 'no write after reconnect');

  // ── the full journey: complete, sign, submit ─────────────────────────────
  // Brought to a submittable state through the API rather than by clicking
  // every field on seven phases — that part is covered by the 3,000-record
  // campaign and 300 brittle selectors would test the selectors, not the form.
  // What is driven HERE is what only a browser can do: a signature drawn with
  // real pointer events, and the submit gate.
  const prepared = await page.evaluate(async ([id, payload]) => {
    const t = localStorage.getItem('crew_token');
    const r = await fetch(`/api/digital-prf/${id}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return r.status;
  }, [prfId, s.submit_payload || { form_data: {} }]);
  check('full capture accepted by the server', prepared === 200, `HTTP ${prepared}`);

  // ── sign + submit from the form: NOT YET DRIVEN ──────────────────────────
  // Submitting from the UI is gated on crew sign-off, and the sign-off pad is
  // a fixed overlay whose canvas only exists once it is open. Driving it needs
  // the completeness gate satisfied first (it lists what is still outstanding
  // and is a real gate, not a drawing — see the PRF 125 note in
  // DigitalPRFForm). Several attempts to click through it landed on buttons
  // that are in the DOM but belong to a closed modal, so nothing advanced.
  //
  // It is reported as SKIP rather than FAIL because nothing here suggests a
  // product defect: the gate refusing to submit an incomplete PRF is the gate
  // working. What is genuinely unproven is the UI interaction, and saying so
  // is more useful than a red line nobody reads.
  //
  // The submit PATH itself is not unproven — 3,000 PRFs were driven through
  // create -> full capture -> submit and all 3,000 arrived
  // (backend/eprf_journey_campaign.py). What is missing is specifically the
  // browser's sign-off-then-submit interaction.
  skip('signature drawn with real pointer events',
       'sign-off pad renders its canvas only once open; opener not yet driven');
  skip('submit from the form UI',
       'gated on crew sign-off; API submit path covered by eprf_journey_campaign.py');
  skip('PDF export from the crew view',
       'needs a submitted PRF; export measured across 336 real records by pdf-export-benchmark.mjs');

  // Last, so it covers everything above: the crash family that takes the whole
  // form out mid-call (a missing theme token, a wrong runtime type from the API).
  check('no uncaught exception during the journey', crashes.length === 0,
        crashes[0] || '');

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  return failed.length === 0;
};

const ok = await run();
process.exit(ok ? 0 : 1);
