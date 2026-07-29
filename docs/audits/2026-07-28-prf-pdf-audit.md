# PRF PDF export — reliability audit

**Date:** 2026-07-28 · **Scope:** `frontend/src/pages/PRFView.tsx` and the PDF export path

**Method.** Four parallel analyses (runtime render failures, test-coverage truth, field
completeness, cleanup scope), each finding then handed to an independent reviewer whose
job was to REFUTE it. 45 raised, **35 confirmed, 10 refuted**. Confirmed findings were
additionally checked against a real browser where measurable.

**Why an audit was needed at all.** The 72-test PDF suite mocks `html2canvas` to a blank
10x10 canvas and `jsPDF`'s `addImage`/`save` to no-ops, and runs in jsdom, which has no
layout engine. `buildPrfPdf` is therefore never executed by any test. The suite proves
*the right data reaches the DOM*; it can say nothing about *how the page looks*.

---

## Summary

| | High | Medium | Low | Total |
|---|---:|---:|---:|---:|
| Addressed | 9 | 2 | 3 | 14 |
| **STILL OPEN** | 8 | 11 | 2 | 21 |

---

## STILL OPEN (21)

### On-screen fit `zoom` can be re-applied mid-capture — capture is unguarded against resize and reader-zoom

- **Severity:** high · **Category:** render-risk
- **Location:** `frontend/src/pages/PRFView.tsx:559`

**Impact.** A phone's URL bar collapsing on scroll, a rotation, the on-screen keyboard opening, or the crew tapping the zoom pill while the PDF pre-warms fires a resize. `zoom` shrinks the LAYOUT box (the code says so at 465-467), so mid-capture the page's offsetWidth drops from 1220 to ~380. Pages captured after that point render at ~50 DPI equivalent — unreadable — and since the build is cached in `sharePdfFileRef` (line 456) it is that corrupted file that gets emailed to the receiving facility. Note also that clearScreenFit is only called once, so the corruption affects every remaining page in the loop, not just one.

<details><summary>Evidence</summary>

```
`clearScreenFit()` runs exactly once, before the page loop (line 559), and is restored in the `finally` (line 671). Nothing prevents `applyScreenFit` from running during the multi-second capture:
```js
window.addEventListener('resize', applyScreenFit);   // line 500
```
and `applyScreenFit` writes the zoom straight back onto the element being captured (486-496):
```js
const fit = Math.min(1, avail / 1240);
setFitScale(fit);
const z = userZoomRef.current ?? fit;
el.style.zoom = z < 1 ? String(z) : '';
```
The reader-zoom pill (`stepZoom`, 509-521) calls `setUserZoom`, which is in the effect's dependency array (line 504) — tapping +/- during a build re-runs applyScreenFit too.

The pre-warm path (431-461) makes this the default: the build starts 400ms after data lands and runs for seconds on a phone, while `handleAutoSend` (908-914) waits up to 20s for it.
```

</details>

**Recommended fix.** Set a `capturingRef` flag for the duration of buildPrfPdf and make applyScreenFit a no-op while it is set (re-running once in the finally).

---

### buildPrfPdf is never executed by any test — the entire PDF export path has zero coverage

- **Severity:** high · **Category:** coverage-gap
- **Location:** `frontend/src/pages/PRFView.tsx:441`

**Impact.** Every line of the export pipeline — the fill-the-sheet reflow loop, the three placement branches, band slicing, the zero-canvas `continue`, and the catch that returns null — ships untested. Deleting buildPrfPdf and the Save-as-PDF button outright would leave all 75 tests green.

<details><summary>Evidence</summary>

```
The only caller reachable from a mounted PRFView is the pre-warm effect: `const t = window.setTimeout(async () => { ... const pdf = await buildPrfPdf(); ... }, 400); return () => window.clearTimeout(t);` (PRFView.tsx:441-459). Neither test file calls vi.useFakeTimers, vi.advanceTimersByTime, or waits >=400ms — grep for 'useFakeTimers|advanceTimers' in both files returns nothing. RTL auto-cleanup (globals:true in vite.config.ts) unmounts after each test, firing the clearTimeout. The jspdf/html2canvas mocks at prfPdfFieldMatrix.test.tsx:42-56 are therefore never invoked.
```

</details>

**Recommended fix.** Add a test that awaits buildPrfPdf directly (export it, or drive the effect with fake timers) with instrumented mocks asserting addImage call count and per-page placement, so at minimum a dropped or duplicated sheet fails CI.

---

### No test anywhere in the repo exercises real PDF bytes or visual layout

- **Severity:** high · **Category:** coverage-gap
- **Location:** `frontend/src/test/prfMedicalAidPdfRender.test.tsx:5`

**Impact.** Not one byte of PRF PDF output has ever been asserted on. The file header's claim — 'whatever appears in that DOM is exactly what lands in the PDF sent to the medical scheme' — is an untested assumption carrying the whole suite's medical-legal value.

<details><summary>Evidence</summary>

```
Repo-wide grep for playwright/cypress/puppeteer/percy/chromatic/toMatchImageSnapshot/pixelmatch/resemble returns only false hits in .loadtest-venv and package-lock.json. Backend grep for reportlab|weasyprint|pypdf|PyPDF2|fpdf|pdfkit|wkhtmltopdf|fitz|pdfplumber yields one comment, backend/app/services/submission_strategies.py:140 'In production, this uses reportlab/weasyprint to create'. CI (.github/workflows/ci.yml:59,129) runs only `npx vitest run` (jsdom) and `pytest tests/`.
```

</details>

**Recommended fix.** Add one headless-Chromium test that renders PRFView with real jspdf/html2canvas, takes pdf.output('blob'), and asserts sheet count plus recoverability of every fixture sentinel from the rendered sheets.

---

### Vitals continuation page (page 3) is never asserted present — only asserted absent

- **Severity:** high · **Category:** data-loss
- **Location:** `frontend/src/pages/PRFView.tsx:2631`

**Impact.** On a long IHT or a cardiac arrest the crew records 4+ vitals sets. Every reading past the third renders only via this uncovered block; if it regresses, those readings vanish from the PDF the scheme receives, with no test failing.

<details><summary>Evidence</summary>

```
PRFView.tsx:1016-1018 sets `const VITALS_PER_PAGE = 3; const vitalsPage1 = vitals.slice(0, 3); const vitalsOverflow = vitals.slice(3);` and the page-3 block is gated `{vitalsOverflow.length > 0 && (` at line 2631. Both fixtures supply exactly 3 vitals sets (matrix:164-168, medaid:181-185), so vitalsOverflow is always empty. prfMedicalAidPdfRender.test.tsx:348 asserts the opposite direction: `expect(screen.queryByText(/Vitals — Continuation/)).not.toBeInTheDocument();`
```

</details>

**Recommended fix.** Add a 6-vitals-set scenario asserting the continuation page renders and that sets 4-6 appear on it.

---

### Injury Diagram page (body_marks) has zero test coverage

- **Severity:** high · **Category:** coverage-gap
- **Location:** `frontend/src/pages/PRFView.tsx:2953`

**Impact.** The injury diagram is the crew's pictorial record of where the patient was injured — primary clinical and medico-legal evidence, and material to RAF and IOD claims. The whole sheet could stop rendering and all 75 tests would stay green.

<details><summary>Evidence</summary>

```
`{Array.isArray(fd.body_marks) && fd.body_marks.length > 0 && (` gates a full `.prf-page` sheet headed 'Injury Diagram' (PRFView.tsx:2953-2965). Neither fixture sets `body_marks` — grep for body_marks across both test files returns nothing.
```

</details>

**Recommended fix.** Add a fixture with populated body_marks and assert the Injury Diagram sheet renders with its marks.

---

### Crew-attached supporting document pages (WCA/RAF evidence) are never rendered in any test

- **Severity:** high · **Category:** coverage-gap
- **Location:** `frontend/src/pages/PRFView.tsx:2709`

**Impact.** WCA payslips, employee IDs and RAF OAR reports are the documentary evidence a compensation claim is paid on. If these sheets stop appending, claims are rejected for missing supporting documents and no test fails.

<details><summary>Evidence</summary>

```
`attachedDocs` is built from five keys — wca_oar_report_pdf, wca_employee_id_pdf, wca_payslip_pdf, wca_medical_report_pdf, raf_oar_report_pdf (PRFView.tsx:1032-1040) — and drives both `{attachedDocs.map(d => (` at line 2709 and the summary row `attachedDocs.some(d => d.key.startsWith('wca_')) && ... ' — see attached sheet(s)'` at lines 1998-2002. None of these keys appear in either test fixture, including in the IOD and RAF billing arms (prfPdfFieldMatrix.test.tsx:352-381) which are exactly the scenarios that carry them.
```

</details>

**Recommended fix.** Extend the IOD and RAF matrix arms with populated wca_*/raf_oar_report_pdf data-URL objects and assert both the attachment sheets and the 'see attached sheet(s)' summary row.

---

### Declaration of Death on a non-DOD call type renders an entire uncovered page

- **Severity:** high · **Category:** coverage-gap
- **Location:** `frontend/src/pages/PRFView.tsx:2796`

**Impact.** A patient who arrests and is declared dead during a PRIMARY or RESUS call is a routine occurrence — the call type stays PRIMARY/RESUS while med_aid_dec_death is set. The declaration sheet, including its signatures, is completely untested despite being the legal record of the death.

<details><summary>Evidence</summary>

```
`{fd.med_aid_dec_death && fd.call_type !== 'DOD' && (` (PRFView.tsx:2796) renders a separate death-declaration sheet. The fixture only ever sets `med_aid_dec_death: true` inside the DOD arm (prfPdfFieldMatrix.test.tsx:290-291), where `call_type === 'DOD'` makes this guard false. The condition is therefore never true in any of the 75 tests.
```

</details>

**Recommended fix.** Add a RESUS + MED AID scenario with med_aid_dec_death set and call_type left as RESUS; assert the declaration sheet and its two signatures render.

---

### RHT refusal waiver prints as a consent-to-treatment acknowledgement — the document asserts the opposite of what happened

- **Severity:** high · **Category:** render-risk
- **Location:** `frontend/src/pages/PRFView.tsx:2148`

**Impact.** On a Refusal of Hospital Transport, the crew shows the patient a waiver on screen and the patient signs to REFUSE care. The PDF that reaches the scheme and would reach a court shows that same signature under a clause acknowledging treatment was received and accepting full payment liability — with no waiver wording, no signatory name, no witness name and no date anywhere on the page. If the patient later deteriorates and the refusal is disputed, the provider's own record is documentary evidence against the defence it needs to run, and it simultaneously bills a patient who declined.

<details><summary>Evidence</summary>

```
Crew captures a refusal waiver at DigitalPRFForm.tsx:7392 — "I, the patient or the responsible person, hereby waive any treatment offered to me by JEMS Medical Services and understand that by signing this waiver, I indemnify JEMS ... from all further responsibility for my well-being hereonforth." — with `<Inp fk="rht_waiver_signatory_name">` (7400), `<Inp fk="rht_waiver_witness_name">` (7413), `<DateInp fk="rht_waiver_date">` (7424), and two FullscreenSignaturePads writing sigs.patient_signature / sigs.witness_signature. PRFView renders NONE of it: `grep -c` for rht_waiver_signatory_name / rht_waiver_witness_name / rht_waiver_date in PRFView.tsx = 0, 0, 0; `grep -niE "waive|indemnif"` returns no waiver clause. Instead the T&C block at PRFView.tsx:2148 is gated only on `fd.call_type !== 'DOD'` — so it RENDERS for RHT — and clause 1 (line 2155) reads "hereby acknowledge that the treatment and/or transportation noted on this document was received by the patient. I accept full responsibility for all payments...". The patient's refusal signature is then printed directly beneath it at line 2187: `<SignatureBox src={fd.tc_patient_signature || prf.signatures?.patient_signature} minHeight={80} />` under the label "Patient / Rep." (2186).
```

</details>

**Recommended fix.** Gate the T&C block on `fd.call_type !== 'DOD' && fd.call_type !== 'RHT'` and add a dedicated RHT waiver section that renders the same indemnity wording the crew displayed, plus rht_waiver_signatory_name, rht_waiver_witness_name and rht_waiver_date alongside the patient and witness signature boxes.

---

### Rasterisation settings put the smallest labels at ~6pt / ~164 DPI with lossy JPEG on coloured text

- **Severity:** medium · **Category:** render-risk
- **Location:** `frontend/src/pages/PRFView.tsx:606`

**Impact.** At the design width the labels are borderline-legible on a printed A4 and ring/blur where teal meets tint. Combined with the reflow finding, the realistic worst case for a busy call is 3pt at 164 DPI. Scheme assessors routinely print or fax these; a claim can be queried or rejected because the assessor cannot read a tariff-relevant field.

<details><summary>Evidence</summary>

```
```js
canvas = await html2canvas(el, {
  // Scale 1.5 gives ~150 DPI on A4 ...
  scale: 1.5,
  useCORS: true,
  backgroundColor: '#ffffff',
  windowWidth: el.scrollWidth,
  windowHeight: el.scrollHeight,
});
...
const imgData = canvas.toDataURL('image/jpeg', 0.72);
```
At the (already reflowed) ~1237px design width: canvas = 1856px placed across 287mm = 11.30in => 164 DPI. Physical em sizes: FieldRow label `0.56rem` (line 191) = 5.9pt; vitals row label `0.55rem` (line 3034) = 5.8pt; SectionHead `0.62rem` (line 214) = 6.6pt; declaration body text `0.62rem` (line 2899) = 6.6pt. Vitals cell values are `0.66rem` (line 3043) = 7.0pt.

Those glyph stems are ~1.5 canvas px wide, and JPEG's 8x8 blocks with 4:2:0 chroma subsampling at q=0.72 are applied to teal text (`GREEN`/`INK` on `GREEN_TINT`) — chroma is the channel that gets subsampled.
```

</details>

**Recommended fix.** Raise `scale` to 2 and JPEG quality to ~0.85 for the form sheets (keep 0.72 for the photo-attachment sheets where file size actually matters), and lift the sub-0.6rem label sizes.

---

### html2canvas 1.4.1 ignores `object-fit` — a wide provider logo prints horizontally squashed

- **Severity:** medium · **Category:** render-risk
- **Location:** `frontend/src/pages/PRFView.tsx:169`

**Impact.** A tenant with a wide wordmark logo gets a visibly distorted brand mark on every exported and emailed PRF, while the on-screen viewer looks perfect — so nobody catches it internally. This is the provider's identity on a document sent to medical schemes.

<details><summary>Evidence</summary>

```
ProviderLogo (line 169):
```jsx
style={{ height, width: 'auto', maxWidth: '100%', objectFit: 'contain', display: 'block' }}
```
With an explicit `height` and `width: auto`, `max-width` clamps the used width without reducing the specified height, so the element BOX stops matching the image's aspect ratio; on screen `object-fit: contain` letterboxes it back.

html2canvas does not implement object-fit — `grep -c 'object-fit\|objectFit' node_modules/html2canvas/dist/html2canvas.js` returns 0, and the renderer stretches the full intrinsic image into the box (node_modules/html2canvas/dist/html2canvas.js:6805-6812):
```js
this.ctx.drawImage(image, 0, 0, container.intrinsicWidth, container.intrinsicHeight, box.left, box.top, box.width, box.height);
```
Page 1 renders it at `height={62}` inside the ~1.95fr brand column (line 1575), giving ~289px of usable width — any logo wider than ~4.7:1 is clamped and therefore squashed. Same pattern at line 2813 (`height={48}`) and lines 2648/2726 (`height={30}`).

Signature and attachment images are safe by contrast: they use max-width + max-height with no explicit dimension (lines 138, 2754, 3015), so the box keeps the intrinsic ratio and object-fit is a no-op.
```

</details>

---

### Very tall pages are guillotined mid-row: the slice path cuts at an arbitrary pixel line

- **Severity:** medium · **Category:** layout
- **Location:** `frontend/src/pages/PRFView.tsx:644`

**Impact.** On the pages that reach this branch (roughly: >2340 design px tall at the 2400px reflow cap — a heavily medicated call), a medication row's drug name can be split so its top half is on sheet 3 and its bottom half on sheet 4. A half-glyph dose value on a document a scheme prices from is worse than an omission, because it can be misread rather than queried.

<details><summary>Evidence</summary>

```
```js
// Very tall page — slice into full-width A4 bands across consecutive
// sheets so every row stays full size and readable, never clipped.
const sliceHpx = Math.max(1, Math.floor(maxH / wScale));   // source px per sheet
for (let sy = 0; sy < ch; sy += sliceHpx) {
  ...
  ctx.drawImage(canvas, 0, sy, cw, hpx, 0, 0, cw, hpx);
```
The cut position is purely arithmetic — it has no knowledge of row boundaries, so a band edge lands wherever `sy` falls. The comment's claim "never clipped" is true for the page as a whole but not for the individual row straddling the boundary, which is bisected horizontally through the glyphs.
```

</details>

**Recommended fix.** Snap the band boundary to the nearest row separator — e.g. measure `.prf-page` child offsets and pick a cut point that falls in a `borderTop` gap — or simply prefer the slice path over the widen path so pages break at natural rows.

---

### The PDF and print paths disagree about what to do with a tall page: bands vs unbounded shrink

- **Severity:** medium · **Category:** render-risk
- **Location:** `frontend/src/pages/PRFView.tsx:750`

**Impact.** For the same PRF, 'Save as PDF' produces multiple full-size readable bands while the printer/hard-copy path produces one sheet with 8.96px text rendered at 2.3px — about 1.7pt, i.e. a grey smudge. Whichever path the crew or admin happens to use decides whether the receiving facility gets a readable document. Two paths, two failure modes, and the tests exercise neither.

<details><summary>Evidence</summary>

```
PDF path caps the shrink and slices past it (569, 636-661):
```js
// Beyond this height we slice instead of shrinking, so a very tall page
// never scales text below ~70% (1 / 1.4) and stays legible.
const SHRINK_LIMIT_MM = maxH * 1.4;
```
Print path has no such limit (line 750):
```js
const s = Math.min(frameW / w, frameH / h, 1);
```
`s` is bounded above at 1 but has no lower bound. A page 3000px tall at the 2400px reflow cap gives s = min(1107/2400, 766/3000) = 0.255.
```

</details>

---

### WCA_IOD is a real call type but is absent from the test matrix

- **Severity:** medium · **Category:** coverage-gap
- **Location:** `frontend/src/test/prfPdfFieldMatrix.test.tsx:537`

**Impact.** The Call Type row for an injury-on-duty call, and any WCA_IOD-specific rendering branch, is never exercised. IOD calls are a distinct payer channel with statutory reporting duties.

<details><summary>Evidence</summary>

```
`CALL_TYPE_OPTS = ['PRIMARY', 'IHT', 'RHT', 'WCA_IOD', 'COURTESY', 'RESUS', 'DOD']` (DigitalPRFForm.tsx:2630) with `CALL_TYPE_LABELS = { ... WCA_IOD: 'WCA / IOD' ... }`. The MATRIX (prfPdfFieldMatrix.test.tsx:537-547) has keys PRIMARY, IHT, RHT, COURTESY, RESUS, DOD — 6 of 7. The suite treats IOD purely as a billing type; the test's own comment at line 356-358 notes 'The crew form models this as the WCA_IOD *call type*' yet never sets call_type to it.
```

</details>

**Recommended fix.** Add WCA_IOD to the MATRIX with its permitted billing types and assert the 'WCA / IOD' Call Type row via expectFieldRow.

---

### expectVisible asserts DOM presence, not visibility, despite its name and the suite's premise

- **Severity:** medium · **Category:** render-risk
- **Location:** `frontend/src/test/prfPdfFieldMatrix.test.tsx:504`

**Impact.** A field rendered white-on-white, at opacity:0, behind visibility:hidden, or clipped outside its sheet by overflow:hidden satisfies every one of these assertions while being absent from the PDF the scheme receives. This is the helper carrying the large majority of the suite's field checks.

<details><summary>Evidence</summary>

```
`function expectVisible(sentinel: string) { const matches = screen.queryAllByText((content) => content.includes(sentinel), { exact: false }); expect(matches.length, `"${sentinel}" missing from rendered PRF PDF`).toBeGreaterThan(0); }` (prfPdfFieldMatrix.test.tsx:504-510; identical at prfMedicalAidPdfRender.test.tsx:242-248). RTL's queryAllByText ignores only script/style elements and applies no CSS visibility filter; jest-dom's toBeVisible() is never used. jsdom additionally computes no layout, so offsetWidth/offsetHeight are always 0.
```

</details>

**Recommended fix.** Rename to expectPresent to stop the name overstating the guarantee, and add the real-render test from finding 2 to cover actual visibility.

---

### Band slicing of a tall page can cut a text row in half across two sheets

- **Severity:** medium · **Category:** layout
- **Location:** `frontend/src/pages/PRFView.tsx:657`

**Impact.** A dense PRF — many medication or IV rows, a long narrative — silently switches from one sheet to N sliced sheets, and a vitals row, dose or signature can be bisected across the sheet break. Also contradicts the comment at PRFView.tsx:677-679 promising 'exactly ONE A4-landscape sheet per .prf-page'.

<details><summary>Evidence</summary>

```
When fullH exceeds SHRINK_LIMIT_MM the export slices: `const sliceHpx = Math.max(1, Math.floor(maxH / wScale)); for (let sy = 0; sy < ch; sy += sliceHpx) { ... ctx.drawImage(canvas, 0, sy, cw, hpx, 0, 0, cw, hpx); ... }` (PRFView.tsx:647-661). The cut is at a fixed pixel offset with no awareness of row or line boundaries. Which branch fires depends on rendered height, which jsdom cannot compute (offsetHeight is 0, so `el.offsetHeight || 862` always takes the fallback).
```

</details>

**Recommended fix.** Cover via the real-render test in finding 2 with a deliberately long-narrative fixture; consider snapping slice boundaries to row edges.

---

### Drugs administered at the receiving hospital (hospital_medications) never appear on the PDF

- **Severity:** medium · **Category:** data-loss
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:8398`

**Impact.** On an inter-facility transfer the crew witnesses and records hospital-administered drugs, then the printed PRF omits them entirely. Any interaction, duplicate dose or adverse event at the receiving facility has no record in the document that follows the patient.

<details><summary>Evidence</summary>

```
A repeating table stored as `{time, drug, dose, route}` rows: `sf('hospital_medications', rows.map(...))` (8398), `addRow` (8400), `removeRow` (8401), shown for `['IFT','IHT'].includes(fd.call_type)` (8395). The in-code comment at 8387-8394 states it "Records drugs given by the receiving facility's staff after handover" and is deliberately exempt from HPCSA scope filtering. `grep -c hospital_medications frontend/src/pages/PRFView.tsx` = 0. PRFView's Medication / Infusion table (2513) is built only from `fd.medications` (medRows, 1023).
```

</details>

**Recommended fix.** Render hospital_medications as a second table beneath Medication / Infusion, clearly labelled as facility-administered.

---

### Overseeing-practitioner communication record is captured but not printed

- **Severity:** medium · **Category:** data-loss
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:8031`

**Impact.** This is the record of a lower-scope practitioner obtaining authorisation from an ALS/ILS overseer — the evidence that an out-of-scope intervention was properly supervised. It is the single most important field in an HPCSA scope-of-practice complaint, and it is absent from the legal document.

<details><summary>Evidence</summary>

```
Dedicated section "Overseeing Practitioner Communication" (SHdr, DigitalPRFForm.tsx:8028) with `<VoiceTxt fk="overseen_practitioner_communication" ph="Document communication with overseeing ALS or ILS practitioner here..." rows={3} />` (8031), rendered for all non-DOD calls. `grep -c overseen_practitioner_communication frontend/src/pages/PRFView.tsx` = 0.
```

</details>

**Recommended fix.** Render it as a narrative FieldRow in the clinical column alongside the other narrative fields (near PRFView.tsx:2466).

---

### Estimated blood loss captured but not printed

- **Severity:** medium · **Category:** data-loss
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:8171`

**Impact.** Estimated blood loss drives triage priority at the receiving facility and substantiates fluid-resuscitation and transport-level charges. The receiving clinician reading the PRF does not see it.

<details><summary>Evidence</summary>

```
`<Sel fk="blood_loss_ml" opts={['< 50 ml', '50–100 ml', '100–250 ml', '250–500 ml', '500–1000 ml', '1000–1500 ml', '> 1500 ml']} />` (DigitalPRFForm.tsx:8171). `grep -c blood_loss_ml frontend/src/pages/PRFView.tsx` = 0.
```

</details>

**Recommended fix.** Add a FieldRow in the primary/secondary survey area of the clinical page.

---

### Treating-practitioner selection (name, HPCSA, category, multi-practitioner JSON) is not printed

- **Severity:** medium · **Category:** data-loss
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:9916`

**Impact.** The PDF shows everyone who was on the vehicle, not who actually treated the patient. Where a two-person crew includes one practitioner out of scope for an intervention, the document cannot show which of them performed it, and the multi-practitioner selection is lost entirely. Lower severity than the others because the roster and its HPCSA numbers do print.

<details><summary>Evidence</summary>

```
A gate makes the crew explicitly select who treated the patient, writing four keys: `sf('treating_practitioner_name', picked[0].name)` (9916), `sf('treating_practitioner_category', picked[0].qualification)` (9917), `sf('treating_practitioner_hpcsa', picked[0].hpcsa)` (9918), `sf('treating_practitioners_json', JSON.stringify(picked.map(...)))` (9919); also 9884-9886. All four are 0 in PRFView. Partial mitigation: PRFView prints the crew ROSTER — `prf.crew_1?.full_name` / `qualification` / `hpcsa_number` (1745-1747) and crew_2 (1791-1793), plus extra crew (2303-2305).
```

</details>

**Recommended fix.** Render the treating-practitioner set as an explicit row or a marker against the roster entries, rather than relying on the reader to infer it.

---

### Body/head diagram images have no onError fallback, and the pre-warm decode gate swallows failures

- **Severity:** low · **Category:** cleanup
- **Location:** `frontend/src/components/BodyDiagram.tsx:231`

**Impact.** If a hashed asset URL 404s — the exact failure mode this project already hits per its own notes on stale service-worker caches after a frontend rebuild — the Injury Diagram sheet exports as an empty white box with only the coloured marker overlay floating on it. The marks have no anatomy behind them, so an injury pattern the scheme is being billed for becomes uninterpretable, with no error anywhere.

<details><summary>Evidence</summary>

```
BodyCanvas/HeadCanvas render the bundled SVGs with no error handling (BodyDiagram.tsx:231-245 and 330-344):
```jsx
<img src={bodyDiagramUrl} alt="Body diagram" draggable={false} style={ ... } />
```
Compare ProviderLogo, which does handle it (PRFView.tsx:166): `onError={() => setFailed(true)}`.

The export-side gate also swallows: `img.decode().catch(() => undefined)` (PRFView.tsx:446).

Mitigating: both SVGs carry explicit root `width`/`height` (`width="360" height="360"` and `width="1092" height="1433"`), so html2canvas's `container.intrinsicWidth > 0` guard passes and the print sizes are aspect-correct — the usual blank-SVG-in-canvas trap does not apply here.
```

</details>

**Recommended fix.** Add an onError fallback that renders a labelled placeholder, and have the export gate count failed decodes rather than discarding them.

---

### Duplicated inline-style literals: 7 sheet frames, 11 signature labels, 15 signature wrappers

- **Severity:** low · **Category:** cleanup
- **Location:** `frontend/src/pages/PRFView.tsx:1553`

**Impact.** No user-visible impact today. It is the mechanism by which a future styling tweak lands on 6 of 7 sheets — the kind of half-applied change that yields one visually inconsistent page in a document sent to a scheme.

<details><summary>Evidence</summary>

```
Verified by exact-string count over the file:
- `width: 1220, minHeight: 862` — 7 occurrences (1553, 2328, 2634, 2712, 2799, 2956, 2997). Six are byte-identical across the following two lines (`margin: '28px auto 0', background: '#fff', color: INK,` then `border: 2px solid ${LN}, boxShadow: '0 6px 24px rgba(0,0,0,0.1)',`); only page 1 at 1554 differs, using `margin: '0 auto'`.
- `fontSize: '0.52rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4` — 11 identical occurrences (the 'Signature' / 'Witness Signature' / 'Undertaker Signature' caption above every SignatureBox).
- `padding: '6px 8px', borderTop: \`1px solid ${LN}\`` — 15 identical occurrences (the wrapper div around each signature block).
All are literal constants composed only of the module-level tokens MUT, INK and LN. Hoisting them to `const SHEET_STYLE`, `const SIG_LABEL_STYLE`, `const SIG_WRAP_STYLE` produces object-identical computed styles, so the rendered DOM and the rasterised output are unchanged.
```

</details>

**Recommended fix.** This is the one cleanup in the file that is genuinely output-neutral and provable. Still, it touches ~33 sites across every printed sheet, so it is only safe with the 75-test suite run before and after. Given the go-live window, defer it — the payoff is stylistic consistency, not correctness, and it is the single change most likely to be blamed if any unrelated PDF issue appears in the first week.

---

## Addressed 2026-07-28 (14)

Fixed across commits `c9fcdb2` (legibility floor, silent page drop, four dropped fields)
and `dae9570` (duplicate OAR sheet, attachment test coverage, safe cleanups).

### "Fill-the-sheet reflow" silently shrinks all text to ~50% as content grows — no clamp, no warning

- **Severity:** high · **Category:** render-risk
- **Location:** `frontend/src/pages/PRFView.tsx:599`

**Impact.** A code or long IHT with ~8 medication entries and ~6 IV entries produces a page tall enough to hit the 2400px cap. The scheme receives a PRF whose drug names, doses, routes and vitals labels are printed at ~3pt — not clipped, so nothing looks 'missing', just an unreadable document. Reprinting or zooming doesn't help: the JPEG was rasterised at that size. Clinically this is the exact page an adjudicator needs to read to price the claim.

<details><summary>Evidence</summary>

```
buildPrfPdf, lines 597-605:
```js
let w = el.offsetWidth || 1220;
let h = el.offsetHeight || 862;
for (let pass = 0; pass < 4 && h / w > SHEET_RATIO + 0.002; pass++) {
  w = Math.min(Math.ceil(h / SHEET_RATIO), 2400);   // cap: sanity bound
  el.style.width = `${w}px`;
  el.style.minWidth = `${w}px`;
  h = el.offsetHeight;                  // reflowed height
  w = el.offsetWidth || w;
}
```
SHEET_RATIO = maxH/maxW = 200/287 = 0.6969. The canvas is then always placed at `maxW` (287mm), so physical text size = designPx x (287 / w) mm.

The reflow's premise is that widening makes text re-wrap and the page shorter. That holds for the prose FieldRows, but NOT for the growth cases: IV rows (2478-2505), medication rows (2514-2541) and vitals rows are stacks of fixed-height `FieldRow`s and 50px signature boxes whose height is driven by ROW COUNT, not wrapping. Widening the page leaves h unchanged, so the loop runs to the 2400px cap.

At the 1220px design width, `FieldRow`'s label (line 191, `fontSize: '0.56rem'` = 8.96px) prints at 8.96 x 0.235mm = 2.08mm em, ~5.9pt. At the 2400px cap that becomes ~3.0pt. Same for the vitals row labels (`fontSize: '0.55rem'`, PRFView.tsx:3034) and SectionHead (`'0.62rem'`, line 214).

Note also that even an EMPTY page trips this: 862/1220 = 0.7066 > 0.6989, so every page is widened at least once on every export.
```

</details>

**Recommended fix.** Cap the reflow width at something that preserves a legibility floor (e.g. w <= 1220 * (1/0.85) so text never drops below ~85% of design size), and route anything taller to the existing slice path instead of the widen path. Add an assertion test that computes effective mm-per-design-px for a synthetic 10-medication PRF and fails below a threshold.

---

### A zero-size html2canvas snapshot silently drops an entire sheet from the exported and emailed PDF

- **Severity:** high · **Category:** data-loss
- **Location:** `frontend/src/pages/PRFView.tsx:622`

**Impact.** If page 2 (the entire clinical sheet — vitals, IV therapy, medications, management) fails to rasterise on one device, the crew sees 'sent', the backend stamps `facility_email_sent_at`, and the receiving facility and the scheme get a PRF containing only the administrative page. Nobody in the loop is told a page went missing.

<details><summary>Evidence</summary>

```
```js
const cw = canvas?.width || 0;
const ch = canvas?.height || 0;
if (!canvas || !cw || !ch) continue;      // skip a zero-size snapshot
```
The loop then proceeds to the next page. No counter, no flag, no user-facing signal, and the surrounding `try` (664-668) is not entered because nothing throws. `buildPrfPdf` returns a valid, savable jsPDF that is simply missing a page.

The result feeds the facility email verbatim: `handleAutoSend` (895-981) attaches `pdf.output('blob')` and only checks `if (!pdf) throw ...` — a short PDF passes every check and is uploaded to `/email-facility`.
```

</details>

**Recommended fix.** Count skipped pages; if `skipped > 0`, return null so `handleSavePdf` falls back to `window.print()` and `handleAutoSend` surfaces an error rather than transmitting a truncated medical-legal document.

---

### IV therapy clinical justification — all four mandatory answers are captured and none reach the PDF

- **Severity:** high · **Category:** data-loss
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:10795`

**Impact.** The IV line and its consumables are billed, but the clinical indication justifying them — the single thing a scheme asks for when it queries an IV charge — never appears on the document sent to the scheme. Claims get rejected or clawed back as unjustified, and the crew's contemporaneous justification is unavailable to defend the intervention.

<details><summary>Evidence</summary>

```
A modal titled "Reason for IV Therapy" / "Why is this IV line needed?" (DigitalPRFForm.tsx:10783-10786) gates IV recording and writes exactly one of four booleans: `sf('ift_ongoing_iv_treatment', true)` (10795), `sf('primary_iv_profuse_bleeding', ...)` (10828), `sf('primary_iv_fluid_resuscitation', ...)` (10829), `sf('iv_medication_administration', ...)` (10830); also toggled directly at 7563-7576. In PRFView.tsx a bare-word grep for each of the four returns 0 occurrences.
```

</details>

**Recommended fix.** Render the selected reason as a FieldRow in the existing IV Therapy section of PRFView (column 2, near line 2509).

---

### transfer_subtype (IFT/IHT transfer reason) is captured but never printed — CONFIRMS the prior audit

- **Severity:** high · **Category:** data-loss
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:2690`

**Impact.** A 'Social Transfer' and an 'Upgrade Transfer' are reimbursed completely differently and one of them is frequently not a benefit at all. The PDF prints both as 'Transfer — IHT'. The scheme cannot adjudicate the transfer reason it is being billed for, and the field the crew was forced to complete is discarded at the document boundary.

<details><summary>Evidence</summary>

```
Captured via a mandatory card picker: `onClick={() => { sf('transfer_subtype', r); setExpanded(false); }}` (DigitalPRFForm.tsx:2690) over TRANSFER_SUBTYPES (declared line 451: 'Return Trip', 'Social Transfer', 'Upgrade Transfer', 'Downgrade Transfer', 'Hospital to Hospital', 'Hospital to Residence', 'Hospital to Stepdown', 'Residence to Hospital', ...). It is a hard validation requirement (prfValidation.ts:131-132 `check: (d) => !isIFT(d) || has(d, 'transfer_subtype')`) and gates the pre-auth UI (6638). `grep -c transfer_subtype frontend/src/pages/PRFView.tsx` = 0. PRFView collapses the whole thing to a generic string at line 1631: `else if (['IHT','IFT','RHT','COURTESY'].includes(ct)) display = `Transfer — ${ct}`;`.
```

</details>

**Recommended fix.** Add a FieldRow for transfer_subtype in the Call Information column, or fold it into the call-type display string at PRFView.tsx:1631.

---

### monitoring_level (level of care during transport) is captured but never printed, while assessment_level is

- **Severity:** high · **Category:** data-loss
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:10590`

**Impact.** The transport tariff is driven by the level of care actually delivered en route, not the level at initial assessment. A patient assessed BLS but monitored ALS bills at ALS; the PDF shows only 'Assessment: BLS', so the higher line is unsupported by the document and the deliberate upgrade the form detected is invisible to the scheme.

<details><summary>Evidence</summary>

```
Captured by the "Monitoring Level" modal, subtitled "Level of care monitored during transport" (DigitalPRFForm.tsx:10571-10575): `onClick={() => sf('monitoring_level', lvl)}` (10590). The sibling field renders — PRFView.tsx:1613 `{fd.call_type !== 'DOD' && <FieldRow label="Assessment" value={fd.assessment_level} />}` — but `grep -c monitoring_level frontend/src/pages/PRFView.tsx` = 0. The form itself models these as distinct and compares their ranks (`const isUpgrade = hasMismatch && monRank > assessRank`, 10565).
```

</details>

**Recommended fix.** Add `<FieldRow label="Monitoring" value={fd.monitoring_level} />` immediately after the Assessment row at PRFView.tsx:1613.

---

### PVT cash-handover signature prints with no signatory name — pvt_cash_payer_name is captured and dropped

- **Severity:** high · **Category:** data-loss
- **Location:** `frontend/src/pages/PRFView.tsx:2026`

**Impact.** The cash-receipt block on the printed PRF is an unattributed squiggle against a rand amount. If the payer later disputes handing over cash, or the money goes missing between crew and office, the document cannot identify who paid. The quoted-vs-paid discrepancy is also invisible, hiding short payments.

<details><summary>Evidence</summary>

```
Captured at DigitalPRFForm.tsx:6994-6995 under the label "Payer Full Name": `<Inp fk="pvt_cash_payer_name" ph="Full name of person handing over cash" />`, directly above the signature pad for `pvt_cash_payer_signature`. PRFView renders the signature but not the name: line 2026-2028 emits the label "Payer Signature" then `<SignatureBox src={fd.pvt_cash_payer_signature} minHeight={40} />`. `grep -c pvt_cash_payer_name frontend/src/pages/PRFView.tsx` = 0. Also dropped: `pvt_amount_quoted` (captured 6952, `<Inp fk="pvt_amount_quoted" ... type="number" />`), 0 in PRFView — only pvt_cash_amount_paid renders (2025).
```

</details>

**Recommended fix.** Add `<FieldRow label="Payer" value={fd.pvt_cash_payer_name} />` above the Payer Signature box, and a Quoted row alongside Amount Paid.

---

### None of the 21 unrendered fields appear in the 72-test PDF suite — monitoring_level is in both fixtures but never asserted

- **Severity:** high · **Category:** coverage-gap
- **Location:** `frontend/src/test/prfPdfFieldMatrix.test.tsx:108`

**Impact.** The suite is the designated regression gate for the PDF, and it is green while the document silently omits refusal waivers, IV justification, transfer reason and level of care. Its greenness is actively misleading: a reviewer reasonably concludes the PDF is field-complete. Because the fixtures also mock html2canvas to a blank 10x10 canvas, nothing downstream catches it either.

<details><summary>Evidence</summary>

```
Grepping src/test/ for the gap fields returns zero hits for rht_waiver_signatory_name, rht_waiver_witness_name, rht_waiver_date, pvt_cash_payer_name, transfer_subtype, ift_ongoing_iv_treatment, overseen_practitioner_communication, hospital_medications, treating_practitioner_name and blood_loss_ml — they are absent from the fixtures entirely, so no assertion can fail. The one exception is monitoring_level, present in BOTH fixtures (prfPdfFieldMatrix.test.tsx:108 `monitoring_level: 'BLS',` and prfMedicalAidPdfRender.test.tsx:113) yet appearing in no expectVisible list. Separately, prfMedicalAidPdfRender.test.tsx has 0 occurrences of 'RHT', so the refusal call type is untested in that file.
```

</details>

**Recommended fix.** Add every captured field to the fixtures and assert each is either visible or explicitly listed in a documented, owner-approved exclusion set — so a future deletion like commit b76b69d fails a test instead of passing silently. Add an RHT call-type case to prfMedicalAidPdfRender.test.tsx.

---

### RAF OAR report renders as TWO pages, and the second one exports blank (iframe cannot be rasterised)

- **Severity:** high · **Category:** render-risk
- **Location:** `frontend/src/pages/PRFView.tsx:2989`

**Impact.** Every RAF claim carrying an OAR report produces a PRF PDF with two sheets for one document: one correct placeholder sheet and one blank-bodied sheet that still looks official (branded header, document title). A medical scheme receiving this sees a page that announces an attached OAR report and shows nothing — reading as either a missing document or a tampered/corrupt submission, on the exact document class where completeness is the billing argument. It also inflates every RAF PDF by a wasted sheet.

<details><summary>Evidence</summary>

```
`raf_oar_report_pdf` is a single form field (`<PdfDrop fk="raf_oar_report_pdf" />`, DigitalPRFForm.tsx:7156) but PRFView feeds it into TWO independent page loops.

(1) line 1037, inside `attachedDocs`:
  `{ key: 'raf_oar_report_pdf',     label: 'OAR Report' },`
filtered by `.filter(d => d.file && ... typeof d.file.data_url === 'string' && d.file.data_url)` (line 1040) and rendered as its own sheet at line 2710 (`attachedDocs.map(d => (<div className="prf-print-frame" ...`).

(2) line 2989, inside the attachment-pages array:
  `...(fd.raf_oar_report_pdf ? [{ label: `RAF OAR Report: ${fd.raf_oar_report_pdf.name || 'PDF'}`, val: fd.raf_oar_report_pdf.data_url, isPdf: true }] : [])`
filtered by `.filter(d => d.val)` (line 2994) and rendered as another `.prf-print-frame` sheet at line 2995.

Both predicates are satisfied by the same truthy `data_url`, so both sheets render. Both carry class `.prf-page`, which is the exact selector the export pipeline iterates.

The two sheets are not even equivalent. Path (1) hits `isImageDoc` (line 1041) — `data_url.startsWith('data:image/')` — which is FALSE for a PDF data-URL, so it renders the safe textual placeholder ('PDF document attached', line 2769). Path (2) sets `isPdf: true` and renders `<iframe src={doc.val} title={doc.label} style={{ width: '100%', height: 740, ... }} />` (line 3013). html2canvas rasterises DOM into a canvas; it cannot paint a PDF-plugin iframe's contents, so that sheet exports as an empty bordered box under a green 'Patient Documents (Attachments) - RAF OAR Report' header.
```

</details>

**Recommended fix.** Remove the line 2989-2993 spread so `raf_oar_report_pdf` is served solely by the `attachedDocs` path (line 1037), which already renders it correctly and degrades honestly for non-image data. This is a real defect fix, not a no-op cleanup: it changes rendered output, so land it as its own small commit with a dedicated test asserting exactly one sheet for a PRF carrying `raf_oar_report_pdf`. Do not instead 'fix' the iframe by making html2canvas render it — that is not achievable for PDF content.

---

### The entire attachment/extra-page family has zero test coverage, and the suite's html2canvas mock structurally cannot catch export-time failures

- **Severity:** high · **Category:** coverage-gap
- **Location:** `frontend/src/test/prfPdfFieldMatrix.test.tsx:1`

**Impact.** The duplicate-blank-page defect above sits in this uncovered region and survived a green suite, which is the proof the gap is live rather than theoretical. Attachments are the evidentiary payload of a claim — ID documents, medical aid cards, admission forms, WCA payslips, nursing notes. A regression that drops or blanks one of these pages would ship undetected and would only be discovered by a scheme rejecting the claim, i.e. after patient billing is already in flight.

<details><summary>Evidence</summary>

```
Keyword scan across BOTH PDF test files (prfPdfFieldMatrix.test.tsx and prfMedicalAidPdfRender.test.tsx), which are the stated regression gate:
  raf_oar_report_pdf    0 / 0
  attachedDocs          0 / 0
  'Attached Document'   0 / 0
  body_marks            0 / 0
  nursing_notes         0 / 0
  undertaker            0 / 0
Compare with what IS covered: med_aid_dec_death 22 hits, call_type 10, vitals_sets 2, hospital_sticker 1.

So the covered surface is page 1 / page 2 / the Declaration-of-Death fields. Everything gated behind a document or diagram attachment is untested: the injury-diagram page (`Array.isArray(fd.body_marks) && fd.body_marks.length > 0`, line 2953), the `attachedDocs` sheets (line 2710), the nursing-notes and declaration-of-death document sheets (lines 2981-2988), and the undertaker blocks (lines 1844, 2933).

Compounding it: html2canvas is mocked to a blank 10x10 canvas and jsPDF's addImage/save/output are no-ops. The tests therefore assert DOM presence only. A sheet that is present in the DOM but rasterises to nothing — precisely the iframe case above — passes every one of the 75 tests. Verified baseline: `npx vitest run` on both files = 75 passed.
```

</details>

**Recommended fix.** Before go-live, add DOM-level tests for the attachment family only — assert sheet COUNT and header text for a PRF fixture carrying body_marks, one image attachment, one nursing note, and raf_oar_report_pdf. That is cheap, needs no un-mocking, and would have caught the duplicate sheet. Separately, log (do not fix now) that no test exercises real rasterisation; the durable answer post-go-live is one golden-image or page-count assertion against a real html2canvas run, not un-mocking the existing 75.

---

### RAF OAR PDF attachment renders as an un-rasterisable iframe, and is emitted twice

- **Severity:** medium · **Category:** render-risk
- **Location:** `frontend/src/pages/PRFView.tsx:3013`

**Impact.** Every PRF with a RAF OAR report gains an extra sheet that is a header bar over an empty grey box. In a package sent to a scheme, a blank page titled 'Patient Documents (Attachments) - RAF OAR Report' reads as a failed/missing document and invites an RFI.

<details><summary>Evidence</summary>

```
Attachment page (line 3013):
```jsx
{(doc as any).isPdf ? (
  <iframe src={doc.val} title={doc.label} style={{ width: '100%', height: 740, ... }} />
) : (
  <img src={doc.val} ... />
)}
```
html2canvas can only render an iframe whose document it can reach (node_modules/html2canvas/dist/html2canvas.js:4702-4721 — `iframe.contentWindow.document.documentElement` inside a `try { } catch (e) { }`). A `data:application/pdf` frame is not a reachable DOM tree (and Chrome blocks data: URL frame navigation outright), so the catch swallows and only `backgroundColor` is painted.

The same file is also already handled correctly elsewhere: `attachedDocs` includes `{ key: 'raf_oar_report_pdf', label: 'OAR Report' }` (line 1037) and renders a proper 'PDF document attached' record block (2757-2783) because, per the comment at 1029-1031, "an uploaded PDF file can't be painted into the page snapshot". The attachment list at 2989-2993 then adds it a second time as an iframe.
```

</details>

**Recommended fix.** Delete the `raf_oar_report_pdf` entry from the attachment array at 2989-2993 — `attachedDocs` already covers it with the correct non-rasterisable-PDF treatment.

---

### Declaration of Death is implemented twice (~145 lines each) under mutually exclusive guards — a drift hazard, but currently correct

- **Severity:** medium · **Category:** cleanup
- **Location:** `frontend/src/pages/PRFView.tsx:1711`

**Impact.** Nothing is broken today. The exposure is future: a scheme-mandated wording change or an added deceased-particulars field applied to only one copy would silently produce two legally different Declaration of Death documents depending on whether the call was typed DOD or (say) RESUS-that-became-a-death. That divergence would be invisible on screen and invisible to the current tests, which exercise the med_aid_dec_death fields but never assert the two variants agree.

<details><summary>Evidence</summary>

```
Two full implementations of the same statutory block, guarded by complementary conditions:
  line 1711: `{fd.call_type === 'DOD' && fd.med_aid_dec_death && (` — inline Band B on page 1
  line 2796: `{fd.med_aid_dec_death && fd.call_type !== 'DOD' && (` — its own dedicated A4 sheet
They are genuinely mutually exclusive, so neither is unreachable and nothing renders twice.

The overlap is large and literal — roughly 40 FieldRows repeated verbatim, e.g. `med_aid_dec_death_deceased_gender / _first_name / _surname / _id / _passport / _dob / _age / _cell / _tel_home / _tel_work / _address / _suburb / _postal_code` appear identically at 1722-1736 and 2847-2861, and the five Confirmation-of-Death rows (`_med_carotid / _med_heart_sounds / _med_respiratory / _med_ecg / _med_pupils`) at 1767-1771 and 2881-2885. The declaration wording paragraph is duplicated character-for-character at 1809-1810 and 2901-2902.

But the differences are deliberate, not drift. Variant A uses `gridTemplateColumns: '1fr 1fr 1fr'` and carries Crew 1 / Crew 2 sign-off blocks (1742-1753, 1788-1799) plus a Recipient Signature (1779-1784). Variant B uses `'1.3fr 2.4fr 2fr'`, adds the provider logo/PR-number masthead (2806-2839) and a large title card (2866-2871), and omits the crew sign-offs. I traced the omission: for a non-DOD call the handover signature is still rendered by the page-1 block at line 2080, whose guard `!(fd.call_type === 'DOD' && fd.med_aid_dec_death) && fd.call_type !== 'RHT'` passes in exactly that case. No field is lost.
```

</details>

**Recommended fix.** Do NOT merge these before go-live. The columns, grid ratios, masthead and sign-off placement genuinely differ, so any shared component needs enough props that the abstraction buys little while risking layout shift on a legal document. Cheapest safe mitigation now: add a cross-reference comment at both 1711 and 2796 naming the other site as the sibling that must be edited in lockstep. Revisit consolidation post-pilot, gated behind a test that renders both variants and asserts identical field sets.

---

### Test docstring's stated source of truth has drifted from the actual billing options

- **Severity:** low · **Category:** cleanup
- **Location:** `frontend/src/test/prfPdfFieldMatrix.test.tsx:11`

**Impact.** Two of the five billing arms exercised are legacy-only values no crew can select today, while the docstring implies the matrix is derived from the live constant. A future reader trusting it will mis-scope changes to billing coverage.

<details><summary>Evidence</summary>

```
The header states 'Billing types (BILLING_TYPE_OPTS): MED AID, IOD, RAF, PVT, CALL OUT FEE' and 'DOD -> MED AID, PVT (no IOD / RAF)'. Actual: `const BILLING_TYPE_OPTS = ['MED AID', 'RAF', 'PVT', 'CALL OUT FEE']` (DigitalPRFForm.tsx:2877) — 'IOD' is not a member at all; `const baseOpts = BILLING_TYPE_OPTS.filter(o => o !== 'CALL OUT FEE')` (line 2895) removes CALL OUT FEE from the picker; and the DOD branch strips only RAF (`baseOpts.filter(o => o !== 'RAF')`, line 2897).
```

</details>

**Recommended fix.** Correct the docstring to state which arms are live vs legacy-compatibility, and derive ALL_BILLING from the real constant where practical.

---

### km_review_flags is internal audit state and correctly absent from the PDF

- **Severity:** low · **Category:** cleanup
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:9821`

**Impact.** None on the printed document — this is a crew acknowledgement that a km discrepancy was reviewed, not clinical or billing data. Listed only to close out the enumeration: it is the one gap that is correctly a non-issue. Note the regex artefacts 'address', 'f' and 'fk' that appear in a naive fd-key diff have no capture site and are not fields.

<details><summary>Evidence</summary>

```
`sf('km_review_flags', [...existing, newFlag])` (9821) where newFlag is `{field, prev_field, delta, acknowledged: true, timestamp}` — the comment at 9813 says "Persist acknowledgement into form_data so it survives save/reload". 0 in PRFView.
```

</details>

**Recommended fix.** No PDF change. It may be worth surfacing in the admin audit view, but it does not belong on the scheme-facing document.

---

### Unused catch binding `_e` — the file's only genuine unused-variable hit

- **Severity:** low · **Category:** cleanup
- **Location:** `frontend/src/pages/PRFView.tsx:664`

**Impact.** None. Cosmetic lint noise. Listed only to document that the exhaustive search for dead code in this file returned essentially nothing.

<details><summary>Evidence</summary>

```
`} catch (_e) {` at line 664, inside buildPrfPdf's image-rasterisation guard. ESLint reports `'_e' is defined but never used  @typescript-eslint/no-unused-vars` — the project config has no argsIgnorePattern for the underscore convention. This is the ONLY no-unused-vars finding in all 3,049 lines; the other 29 ESLint errors are all `no-explicit-any` (a typing concern, not dead code), plus 2 react-hooks/exhaustive-deps warnings at 416 and 774 that are load-bearing (adding the suggested deps would re-fire the fetch and the print-CSS effect). `npx tsc --noEmit -p tsconfig.app.json` passes clean.
```

</details>

**Recommended fix.** `catch {` (optional catch binding, supported by the project's TS target) removes it in one character. Safe to do at any time, including now, since it cannot alter rendered output. Do not touch the two exhaustive-deps warnings — line 416's effect intentionally re-runs on caseId only, and line 774's on mount/print state only.

---

## Refuted (10)

Raised by an analysis pass and killed on independent review. Recorded so they are not
re-raised later as if new.

- **Native print path clips ~28mm off the right edge of every sheet if `beforeprint` does not fire — the only guard is JS**
  - The structural observation is true but the filed finding is refuted on scope, evidence, and impact. Verified in C:/Users/USER-PC/Desktop/New EMS AUTOMATIONS/frontend/src/pages/PRFView.tsx.

WHAT THE CLAIM GETS RIGHT: `.prf-print-frame` is width:295mm/height:205mm/overflow:hidden (1494-1513); `.prf-page` carries inline width:1220 (1552-1553); the print CSS deliberately does not force a width (comme
- **Print path's `transform: scale()` leaks into the html2canvas path — buildPrfPdf never resets it**
  - REFUTED — the code reading is accurate, but the render mechanism and therefore the impact are wrong.

WHAT THE CLAIM GETS RIGHT (verified):
- PRFView.tsx:750-752: `fit()` does stamp `transformOrigin='top left'` + `transform=scale(s)` on every `.prf-page`, inline (not print-media-scoped).
- PRFView.tsx:755-767: `reset()` on `afterprint` is the only place it is cleared.
- PRFView.tsx:593-594 / 615-6
- **Nearly every page is vertically stretched up to 8.7% — the code contradicts its own "uniform scale" invariant**
  - REFUTED — on impact and on the causal argument, not on the code quote.

WHAT THE CLAIM GETS RIGHT (I confirmed this part verbatim)
frontend/src/pages/PRFView.tsx:632-635 reads exactly as quoted. `pdf.addImage(..., maxW, drawH, ...)` does pin width at maxW while `drawH` snaps up to maxH, so the branch is genuinely anisotropic, and the header comment at 545-549 does promise "same factor on both axes
- **Vitals beyond set #3 all crush onto a single continuation sheet with unbounded column count**
  - REFUTED — the structural facts are correct but the mechanism and impact are measurably wrong, and the stated impact does not occur at the volume the claim itself cites.

VERIFIED TRUE (read in source): PRFView.tsx:1015-1017 has VITALS_PER_PAGE=3, vitalsPage1=slice(0,3), vitalsOverflow=slice(3); line 1090 vitalsOverflowCols=Math.max(vitalsOverflow.length,5) is genuinely unbounded; line 2631 renders
- **No font-readiness gate anywhere, and the sheet's font stack resolves differently per device — export geometry is device-dependent**
  - REFUTED — the quoted evidence is accurate, but the diagnosis inverts the mitigation and the claimed impact does not follow from the mechanism.

VERIFIED AS STATED: the grep for fonts.ready/FontFace/fontsReady returns nothing frontend-wide; PRFView.tsx:1118 sets fontFamily '"Segoe UI", -apple-system, Roboto, Arial, sans-serif' on .prf-screen-wrap; line 198 sets 'ui-monospace, "SF Mono", monospace' 
- **The PDF test suite's html2canvas mock forces a branch that never runs in production**
  - REFUTED — the stated mechanism does not happen. The claim's arithmetic is right in the abstract (a 10x10 canvas would yield wScale=28.7, fullH=287mm > maxH+0.5=200.5 and > SHRINK_LIMIT_MM=280, hence the slice branch at PRFView.tsx:644), but its premise — that the tests execute buildPrfPdf at all — is false, and I demonstrated that rather than assuming it.

Evidence:
1) frontend/src/test/prfPdfFiel
- **Page/sheet count is asserted in only 1 of the 20 matrix scenarios**
  - Evidence is literally accurate (verified: prfPdfFieldMatrix.test.tsx has no page-count assertion; prfMedicalAidPdfRender.test.tsx:260-261,349 are the only ones; matrix = 20 scenarios; buildPrfPdf at PRFView.tsx:644-661 does slice tall pages so DOM divs != PDF sheets). But the claimed impact is overstated and two existing guards cover the stated failure in all 20 scenarios. (1) A DROPPED sheet is n
- **RHT PDFs get no "Refused Treatment" watermark — the watermark keys off a separate manual toggle, not call_type**
  - REFUTED — the code reading is accurate but the semantic premise is wrong, the impact is overstated, and the implied fix would introduce a worse error.

VERIFIED CODE FACTS (I re-read these, not taken on trust):
- PRFView.tsx:2349 gates the diagonal watermark solely on fd.patient_refused_treatment. True.
- Repo-wide grep (--include=*.py/*.ts/*.tsx) shows exactly ONE write path for patient_refused_t
- **referring_doctor was deleted from the PDF by a bulk layout commit and never restored — CONFIRMS the prior audit**
  - REFUTED — the claim's raw observations are accurate and demonstrated, but its causal thesis and its impact statement are both contradicted by evidence it did not examine.

VERIFIED AS STATED: referring_doctor is captured at DigitalPRFForm.tsx:6857 (exact quoted line matches); it is used in prfValidation.ts at 699, 763, 1885, 1937; PRFView.tsx contains ZERO case-insensitive occurrences and has no d
- **handover_name (DOD body-recipient) is captured but the recipient signature prints unattributed**
  - REFUTED — the quoted lines exist as described, but the failure they are said to produce cannot occur, and the recipient IS attributed on the PDF.

VERIFIED-TRUE parts of the evidence:
- frontend/src/pages/crew/DigitalPRFForm.tsx:8287-8315 — under `fd.med_aid_dec_death` the SHdr becomes "Undertaker", the field is labelled "Receiving Name" and binds `value={fd.handover_name ?? ''} onChange={e => sf(
