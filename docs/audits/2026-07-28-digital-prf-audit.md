# Digital PRF form — audit

**Date:** 2026-07-28 · **Scope:** `frontend/src/pages/crew/DigitalPRFForm.tsx` (10,862 lines)
and its immediate collaborators (`services/offlineDb.ts`, `services/syncEngine.ts`,
`pages/crew/prfValidation.ts`).

**Status: REPORT ONLY. Nothing in this document has been fixed.**

**Method.** Five parallel analyses (data loss, crashes/state, clinical correctness,
coverage/risk, security/privacy), each finding then handed to an independent reviewer
whose job was to REFUTE it. **59 raised, 43 confirmed, 16 refuted.**

**Why this audit exists.** No test anywhere mounts this component. `conditionalFields.test.ts`
(58 tests) and `digitalPrfSecurity.test.ts` (12 tests) RE-IMPLEMENT its logic inside the
test file — their own comments say *"Mirror the field visibility rules from
DigitalPRFForm.tsx JSX"* — so all 70 would still pass if the form were deleted.

**Context for triage.** 96 real PRFs have gone through this form in production. Most of
what follows has never fired; it is unguarded rather than actively broken. That
distinction matters when deciding what to fix before go-live.

---

## Summary

| Severity | Count |
|---|---:|
| high | 18 |
| medium | 17 |
| low | 8 |
| **Total confirmed** | **43** |
| Refuted on review | 16 |

### By category

| Category | High | Total |
|---|---:|---:|
| data-loss | 6 | 12 |
| clinical-correctness | 4 | 12 |
| coverage-gap | 4 | 6 |
| crash | 0 | 5 |
| state-bug | 1 | 4 |
| security | 3 | 4 |

---

## HIGH (18)

### localStorage quota failure is swallowed, and the resulting stale draft then permanently shadows AND overwrites the server row

- **Severity:** high · **Category:** data-loss · **Lens:** data-loss
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:4495`

**Impact.** Silent, unbounded loss of the patient record. The crew sees a form that looks intact (it is their own older data), so nothing signals a problem; meanwhile the server copy is actively destroyed by the next autosave. The attachment that triggered the quota failure — an ID copy, referral letter, death-certificate supporting document — is itself never persisted anywhere.

**Reproduction.** 1. Crew works a PRF; several server saves land (phase changes / 5-min timer), so the server row is current.
2. Crew attaches an OAR PDF or ~20 document photos. From that setItem onward every saveToLocal throws QuotaExceededError and is discarded. The draft key still exists, frozen at its last successful (pre-attachment) content.
3. Crew keeps capturing clinical data. Phone/PWA is killed, or the crew navigates away and back.
4. loadPrf -> loadFromLocal() returns true from the STALE draft. fetchPrfOnce then hits the `if (!localStorage.getItem(...))` guard and refuses to hydrate from the server, so React state is the stale draft.
5. The next doSave PATCHes that stale blob; the backend replaces form_data with it, deleting every field the crew had already got onto the server.

<details><summary>Evidence</summary>

```
saveToLocal (4495-4505) is the ONLY writer of the draft and swallows every failure:

  const saveToLocal = () => {
    if (!prfId) return;
    try {
      const draft = { fd, vitals, ivRows, medRows, timestamps, kms, sigs, geos, vehicle, crew2Id, phase, savedAt: Date.now() };
      localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify(draft));
    } catch { /* localStorage full or unavailable — non-fatal */ }
  };

`fd` carries base64 blobs with no aggregate budget. PdfDrop (3563) allows a 10 MB PDF -> ~13.3 MB base64 string; DocumentsCapture commits an UNBOUNDED array of ~200-250 KB JPEG data URLs (components/DocumentsCapture.tsx:59-61 `onChange([...docs, ...next])`, no cap); handleWcaPhoto (4424) has no size check at all. Typical localStorage quota is ~5 MB.

The stale draft then wins over the server, forever (4590-4594):

    // If there is an active local draft, DO NOT overwrite the form state
    if (!localStorage.getItem(`prf-draft:${prfId}`)) {
      setFd(normalizeFormData(data));
      ... setVitals / setSigs / setTs / setKms / setGeos ...
    }

and the backend replaces form_data wholesale (backend/app/api/digital_prf.py:391-397):

    if body.form_data is not None:
        existing = prf.form_data or {}
        merged = {k: v for k, v in body.form_data.items() if not k.startswith("_")}
        for k, v in existing.items():
            if k.startswith("_") and k not in merged: merged[k] = v
        prf.form_data = merged
```

</details>

**Recommended fix.** Do not put base64 payloads in the localStorage draft. Keep `fd` attachments in IndexedDB (already a dependency via offlineDb) and store only a reference in the draft. Make saveToLocal's catch observable: on QuotaExceededError, delete the draft key (so the server copy is authoritative again rather than being shadowed by a stale one), set a visible banner, and force an immediate doSave.

<details><summary>Independent verification</summary>

The code says what the claim says it says, and no guard prevents it.

VERIFIED MECHANISM:
1. saveToLocal (DigitalPRFForm.tsx:4495-4505) serialises the whole `fd` into a single localStorage.setItem with an empty catch. Grep confirms it is the only writer of `prf-draft:${prfId}` besides the CrewDashboard seed (CrewDashboard.tsx:518); neither strips data_url blobs.
2. Attachment sinks are real, reachable and uncapped: PdfDrop at line 7156 (raf_oar_report_pdf, 10 MB ceiling -> ~13.6M base64 chars in one string) exceeds a ~5 MB quota in a single permitted action; DocumentsCapture at 3204 (med_aid_dec_death_documents) and 6815 (nursing_notes) commit an uncapped array via onChange([...docs, ...next]) at ~200-250 KB each; PatientDocumentsCapture at 8370; handleWcaPhoto at 4407 has no size check (only a 1600px/0.85 downsize).
3. Per spec, a QuotaExceededError leaves the previous value intact, so an OLD draft remains. A prior successful write is guaranteed — the CrewDashboard seeds the key at PRF creation and the 400ms autosave (4731) writes from the first keystroke.
4. The load boundary (4590-4594) arbitrates purely on KEY EXISTENCE: `if (!localStorage.getItem('prf-draft:'+prfId))`. draft.savedAt is written but never read; prf.updated_at is never compared. loadFromLocal (4507) ignores savedAt too.
5. AGGRAVATING DETAIL THE CLAIM MISSED: setPrfMeta and `baseUpdatedAtRef.current = prf.updated_at` sit OUTSIDE that if-block, so a shadowed load refreshes the optimistic-concurrency token to the server's latest while state stays stale. This actively defeats the 409 guard at backend/app/api/digital_prf.py:371-382 that would otherwise catch the stale overwrite.
6. Backend merge (digital_prf.py:391-397) confirmed wholesale replace, preserving only underscore-prefixed keys.
7. No signal to the crew: saveState reflects server saves only and keeps reading "saved"; the quota catch is silent.

REAL LOSS PATH: local writes start failing at T -> server keeps receiving complete data (doSave builds from live React state) -> tab reloads or is discarded -> loadFromLocal restores state-at-T, the entire server-apply branch is skipped (setFd/setVitals/setSigs/setTs/setKms/setGeos/setPhase are all inside the if) -> OCC token already refreshed so no 409 -> next PATCH replaces newer server form_data with state-at-T. Vitals, IV/medication rows and signatures recorded after T are destroyed on a medical-legal record; if the crew submits from that state the loss is baked into the submitted PRF. Reload is routine on a phone PWA and is made MORE likely by holding a 13 MB blob in React state.

WH

</details>

---

### Server errors other than 401/404/409/423 are neither queued to the outbox nor shown to the crew — the save state is a write-only setter

- **Severity:** high · **Category:** data-loss · **Lens:** data-loss
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:5043`

**Impact.** Server-side saving can be failing for the entire duration of a call with zero indication to the crew — no banner, no icon, no outbox count on this screen. The crew believes the PRF is safe because the form 'just saves silently after every change' (the comment at 4314). The record survives only in the localStorage draft on that handset, which is exactly the copy the quota bug can freeze and clearLocalDraft later deletes.

**Reproduction.** Any 500 / 502 / 413 from the PATCH. 413 is concretely reachable: nginx/nginx.conf:69 sets `client_max_body_size 50M`, and form_data carries every base64 attachment (a 13.3 MB base64 PDF plus a stack of document photos). The 'offline' state set at 5033 and 5042 is equally invisible for the same reason.

<details><summary>Evidence</summary>

```
doSave's terminal else-branch drops the payload on the floor (5043-5047):

      } else {
        // Unknown server error (e.g. 500). Do NOT advance lastSavedPayloadRef so
        // the same data is retried on the next change/cycle.
        setSaveState('error');
      }

No queueToOutbox() call — unlike the 401 (5002), offline (5032) and 404 (5041) branches which all preserve the payload.

And `setSaveState` writes to nothing. The state values are destructured away (4317-4320):

  const [, setSaving] = useState(false);
  const [submitting, setSubmit] = useState(false);
  const [, setLastSaved] = useState<Date | null>(null);
  const [, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'offline' | 'error'>('idle');

Grepping the whole of frontend/src for `saveState` returns only these lines inside doSave/handleSubmit — it is never rendered, and this page shows no outbox badge either (`outbox-change` is only dispatched, never listened to here).
```

</details>

**Recommended fix.** Queue to the outbox in the terminal else-branch too — a 500 is no less a reason to preserve the crew's work than a 404. Surface saveState: at minimum a persistent 'not saved to server' indicator whenever state is 'error' or 'offline'. Reject oversized payloads client-side before the PATCH rather than discovering it as an opaque 413.

<details><summary>Independent verification</summary>

Every asserted fact verified in source. (1) DigitalPRFForm.tsx:5043-5047 terminal else-branch calls only setSaveState('error') with no queueToOutbox, while the 401 (5002), offline (5032) and 404 (5041) branches all queue. (2) setSaveState is genuinely write-only: line 4320 destructures the value away, and a repo-wide grep for `SaveState` returns only the declaration plus nine setter calls; nothing renders it. (3) No outbox UI exists anywhere in the app — `outbox-change` is dispatched in 7 places, listened to in zero; getPending/getCount/getOutboxSummary are imported only by syncEngine.ts and the test file, so syncEngine.ts:60-65's promise that dead entries stay "in the outbox count for the crew to see and manually resend" has no UI behind it.

Mitigations considered and weighed: the payload is a full snapshot and lastSavedPayloadRef is not advanced, so a transient 5xx/429 self-heals on the next phase change (5641) or submit — for most real 5xx the impact is zero, which makes "for the entire duration of a call" true only for a persistent failure. The localStorage draft (400ms debounce) means data is not memory-only. Counter-weight: dirtyRef.current is set false immediately after doSaveRef.current() at 4744 and 4760 regardless of outcome, so after a failed save the visibility-change and 5-min backups and the unmount flush (gated on dirtyRef at 5075) stop firing; retry then depends on the crew typing again, changing phase, or submitting.

Impact is understated, not overstated. The branch is reachable for deterministic failures, not just transient ones: backend/app/api/digital_prf.py:436/441/446 calls uuid.UUID(body.vehicle_id) unguarded (ValueError -> 500), line 448 raises 403, _assert_provider_owns raises 403, and any Pydantic body rejection is a 422. With the server otherwise healthy, handleSubmit's authoritative PATCH loop fails and breaks at 5777 with saved=false, then POST /submit (no body) succeeds, sets prfLockedRef, calls clearLocalDraft() (5815/5818/5823) and alerts "PRF submitted successfully." The PRF is locked at the last-good server state, all later data is permanently gone, the only local copy is deleted, and the crew is told it worked. The comment at 5774-5776 claiming the submit "routes to the offline outbox ... so nothing is lost" is false here: the submit catch only queues on 401 (5829) or offline (5893).

Deliberate-design defence does not cover it. The comment at 4314-4316 and the standing "never warn the crew mid-call" rule defensibly justify the absence of a "saved" badge, and a fix should respect that — but they say nothing about a pe

</details>

---

### A cleared signature, timestamp or odometer reading can never be un-set on the server — the crew's correction is silently discarded and the stale value keeps printing on the PDF

- **Severity:** high · **Category:** clinical-correctness · **Lens:** data-loss
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:4940`

**Impact.** The legal/billing record diverges from what the crew can see and believes they corrected. A signature the crew deliberately repudiated is printed on the submitted PRF as if it were valid consent. A wrong odometer reading the crew tried to erase survives into the mileage engine and the claim.

**Reproduction.** Signature: on the T&C card (8564-8571) the pad writes BOTH keys — `onChange={v => { sf('tc_patient_signature', v); setSigs(p => ({ ...p, patient_signature: v })); }}` — but reads only `fd.tc_patient_signature`. The crew realises the wrong person signed and taps Clear. `fd.tc_patient_signature` becomes null (form_data IS replaced wholesale, so that clears server-side), but `patient_signature: null` is skipped by the backend, so the DB column keeps the repudiated image. The pad now shows blank to the crew while PRFView's `||` fallback renders the old signature on the submitted PDF.
Odometer: crew types 14285, blurs, later clears the field to re-enter it, then the PRF is submitted before they retype. The server keeps 14285 and bills the mileage off it.

<details><summary>Evidence</summary>

```
buildSavePayload converts every cleared value to null (4940-4955):

    for (const [k, v] of Object.entries(kms)) { cleanKms[k] = v && String(v).trim() ? v : null; }
    for (const [k, v] of Object.entries(timestamps)) { cleanTs[k] = v || null; }
    return { form_data: {...}, vehicle_id: ..., ...cleanTs, ...cleanKms, ...sigs };

and SignaturePad's clear button emits null (components/SignaturePad.tsx:92-101 `const clear = () => { ... onChange(null); }`), which lands in `sigs` (7406, 8309, 8804, 9141).

The backend treats null as 'field not sent' for all three groups (backend/app/api/digital_prf.py:399-447):

    for field in TIMESTAMP_FIELDS:
        val = getattr(body, field, None)
        if val is not None: ...
    for field in KM_FIELDS:
        val = getattr(body, field, None)
        if val is not None:
            setattr(prf, field, val if val != '' else None)   # unreachable: client sends null, never ''
    for sig_field in ["patient_signature", "witness_signature", "handover_signature", "crew_signature", "valuables_signature"]:
        val = getattr(body, sig_field, None)
        if val is not None: setattr(prf, sig_field, val)

The divergence is then rendered. frontend/src/pages/PRFView.tsx:2257:

    <SignatureBox src={fd.tc_patient_signature || prf.signatures?.patient_signature} minHeight={80} />
```

</details>

**Recommended fix.** Send an explicit sentinel for cleared fields (e.g. empty string, already half-handled in the KM branch) or switch the backend to `if field in body.model_fields_set`, so 'the crew cleared this' is distinguishable from 'the client did not send this'. Remove the `||` fallback in PRFView:2257 once clearing propagates, so one source of truth renders.

<details><summary>Independent verification</summary>

The core defect is real and correctly located for two of the three field groups; only the timestamp third of the claim is refuted.

CONFIRMED — signatures. FullscreenSignaturePad (the component the crew form actually uses) renders a red "Clear" button at frontend/src/components/FullscreenSignaturePad.tsx:112-114 with onClick={() => onChange(null)}. Every call site writes that null into `sigs` (DigitalPRFForm.tsx:7406, 7419, 8309, 8358, 8569, 8575, 8804, 9141). buildSavePayload (4940-4955) spreads ...sigs, so the PATCH body carries an explicit patient_signature: null. backend/app/api/digital_prf.py:427-430 gates on `if val is not None`, so the column keeps the old base64 permanently. Verified there is no alternative clear path: the crew form's only writes are PATCH /{id}, POST /{id}/mark-time and POST /{id}/submit, and the submit handler (1268) never re-syncs signature columns. The stale value provably prints: PRFView.tsx:1845 and :2152 render the handover signature SOLELY from prf.signatures?.handover_signature with no form_data term at all, so a cleared handover signature has no way not to print; :2257, :2247 and :1813 use `fd.x || prf.signatures?.x`, where the cleared fd side is falsy and falls through to the stale column.

CONFIRMED — odometer. Reachable two ways: plain backspace in a KmInput (handleKmChange, :5228) and a first-class "Clear" button in the odometer-sanity dialog (:9786-9788, sf(kmKey,'') + setKms('')), whose own copy instructs the crew to "clear and re-enter". cleanKms converts '' to null, so the handler's `val if val != '' else None` at :422 is indeed dead code for this client. Impact is not cosmetic: PRFView.tsx:1042 reads `prf.kms` (the server columns, not form_data) for the printed table, and digital_prf.py:640-641 computes loaded_km / rtb_km from prf.km_at_destination - prf.km_depart_scene, feeding billing.

REFUTED — timestamps. Unreachable. The only timestamp editor (DigitalPRFForm.tsx:6069-6070) short-circuits an emptied input: `const v = e.target.value; if (!v) return;`. No setTs site anywhere writes null or '' (the others at :5121, :5125, :6077, :6489 all write valid ISO strings). cleanTs's `v || null` therefore only nulls a timestamp that was never set, where the backend skip is correct behaviour. The claim's "a cleared timestamp can never be un-set" describes a state the crew cannot produce.

MINOR OVERSTATEMENT: "silently discarded" is slightly strong. On a load with no local draft, DigitalPRFForm.tsx:4604 and :4607-4613 re-seed kms and sigs from the server columns, so the stale value visibly reappears in the crew form. Bu

</details>

---

### Out-of-scope airway/circulation interventions are unmounted, not preserved — an already-ticked procedure vanishes from the UI but stays in the submitted record

- **Severity:** high · **Category:** clinical-correctness · **Lens:** clinical-correctness
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:8124`

**Impact.** The PRF asserts that a BAA-registered practitioner performed an intubation and a surgical airway. The crew cannot see the claim, cannot untick it, and it flows through to the billed claim and any HPCSA audit. This is the exact scenario the scope matrix exists to prevent, and it is the reverse of the documented intent ("Never silently strip an already-on selection"). The same applies to Chest Decompression, IO Line, Central Line, Pacing and Cardio Version.

**Reproduction.** 1. Treating practitioner = the ECP crew member. In Clinical, tick 'Intubation' and 'Surg. Airway' (fd.airway_interventions = ['Intubation','Surg. Airway']).
2. Tap 'Change' on the Treating Practitioner chip (line 7952) and select the BAA/AEA partner — or simply pick both crew in the multi-select, where `picked[0]` (line 9916) is whichever appears first in `opts`, i.e. Crew 1.
3. `scopeForFormLabel('Intubation','BAA')` now returns `unauthorised`, so line 8124 returns null. Both checkboxes disappear entirely from the Airway card.
4. `fd.airway_interventions` still contains both values. `buildSavePayload()` (4952) spreads `...fd` wholesale into `form_data` and submits it.
5. Tell-tale: the dependent sub-fields still render — `{inArr('airway_interventions','Intubation') && (<>Attempts / ETT Size / ETT Depth</>)}` at 8133 stays on screen with no visible parent checkbox.

<details><summary>Evidence</summary>

```
The `Chk` component was built specifically to preserve out-of-scope selections (line 3474-3492):

  // When disabled (HPCSA scope), render as a non-interactive pill with a
  // small inline reason. Never silently strip an already-on selection — that
  // would erase audit data. If the value is on and now out-of-scope (treating
  // practitioner was changed mid-call), surface that with an amber accent so
  // it can be reviewed; if off, render greyed.
  if (disabled) { const accent = on ? '#f59e0b' : '#cbd5e1'; ... }

But BOTH call sites throw the disabled case away before `Chk` ever renders:

  // Airway (8117-8126)
  {['Self-maintained','Suction','OP Airway','Supraglottic Airway','Intubation','Advanced Airway','Chest Decompression','Surg. Airway'].map(i => {
    const verdict = scopeForFormLabel(i, cat);
    const disabled = verdict.kind === 'unauthorised';
    if (disabled) return null;                                   // <-- 8124
    return <Chk key={i} fk="airway_interventions" val={i} disabled={disabled} hint={hint} />;
  })}

  // Circulation (8158-8166) — identical
    if (disabled) return null;                                   // <-- 8165
    return <Chk key={i} fk="circulation_interventions" val={i} disabled={disabled} hint={hint} />;

`disabled` is therefore ALWAYS false by the time Chk renders; the entire amber preservation branch is dead code. Nothing anywhere removes the value from the array — `toggleArr` is the only writer.
```

</details>

**Recommended fix.** Delete both `if (disabled) return null;` lines and let `Chk` render its disabled branch, which already handles both the on (amber, reviewable) and off (greyed) cases. If hiding is wanted for never-ticked options, gate it on `!inArr(fk, i) && disabled` so a recorded value is always visible.

<details><summary>Independent verification</summary>

VERIFIED, NOT REFUTED. Every mechanical assertion checks out against the source.

CODE SAYS WHAT THE CLAIM SAYS:
- frontend/src/pages/crew/DigitalPRFForm.tsx:8117-8126 (Airway) and 8153-8167 (Circulation) each compute `const disabled = verdict.kind === 'unauthorised'` and then `if (disabled) return null;` (lines 8124 and 8165) BEFORE constructing `<Chk ... disabled={disabled} />`.
- `Chk` at 3471-3506 contains exactly the quoted preservation branch and comment ("Never silently strip an already-on selection - that would erase audit data"), with the amber #f59e0b accent for the on-and-out-of-scope case at 3479-3492.
- Dead-code claim DEMONSTRATED, not asserted: only four `Chk` call sites exist in the whole 10,862-line file (7173 flags/debtor, 8125 airway, 8166 circulation, 8184 immob_equipment). Only 8125 and 8166 pass `disabled`, and both early-return first. `disabled` is therefore provably always undefined/false at render, so lines 3479-3492 are unreachable.

NO GUARD/NORMALISER PREVENTS IT:
- `toggleArr` (4885-4889) is the only writer of airway_interventions / circulation_interventions. `sf` at 4884 is generic. Grep across the repo shows no other write site; the only other frontend references are read-only (5981 procedures_performed concat, 8128/8133/8168 inArr gates, 4206 array-type list).
- `normalizeFormData` (4210-4224) only replaces a non-array with `[]`; it does not filter members.
- No effect keyed on treating_practitioner_category prunes either array.

REACHABLE IN PRACTICE:
- hpcsaScope.ts:138 `airway_ett_drug_facilitated: authorised ['ECP']` and :184 `airway_surgical_cricothyroidotomy: ['ECT','ANT','ECP']` -> BAA yields kind 'unauthorised' via scopeForFormLabel (1242-1258). isAuthorised only fails open for ART/unknown.
- Mid-call downgrade is an explicitly supported flow: the banner comment at 7897-7900 says "Tap Change to swap mid-call", and the picker (advance 9882-9895, TreatingPicker.confirm 9913-9922) offers crew1/crew2/extra_crew with NO restriction to a higher category. A BAA+ECP pairing is the standard ambulance crew.
- Additional routes: 96 production PRFs predate the scope matrix; OCR/paper flow and direct API writes never run the gate.

DECISIVE EVIDENCE THE CLAIM DID NOT CITE (rules out "deliberate design"): `ScopedInp` (3514-3541) implements precisely the intended behaviour - preserves the existing value and shows an "Out of scope for {cat}" amber pill - and it is used TWICE INSIDE THESE SAME TWO CARDS (ng_tube_size at 8142, iv_attempts at 8177). The correct pattern sits two lines from the broken one. Its own docstring says "Mirro

</details>

---

### 'Patient Refused Treatment' hides the entire clinical block while retaining vitals, IV lines and drugs in the payload — and on a RESUS call the toggle to undo it does not exist

- **Severity:** high · **Category:** clinical-correctness · **Lens:** clinical-correctness
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:8008`

**Impact.** Scenario B is a cardiac-arrest call on which the crew physically cannot enter vitals, airway management, defibrillation or drugs, with no error message and no visible cause (validatePhase is deliberately silent). Scenario A produces a legally self-contradictory patient record — refusal of treatment alongside documented treatment — that no one on scene can see.

**Reproduction.** A) Contradictory record: on a PRIMARY call, capture 3 vitals sets, an IV line and a morphine dose. Patient then refuses further care; crew taps 'Patient Refuses Treatment'. Everything disappears from the screen. Submit — the PRF carries a refusal flag AND a full drug/IV administration record, with the vitals-shortfall gate and the pre-submit review warnings both bypassed.
B) Unrecoverable: tick 'Patient Refuses Treatment' on any call type, then change call_type to RESUS via the pill dropdown (line 2853). Line 8008 now suppresses the toggle, so the crew has no control to untick it, and line 8037 keeps the whole clinical body — vitals, airway, circulation, IV, medications — hidden for the rest of the call.

<details><summary>Evidence</summary>

```
The toggle is rendered only for non-RESUS call types:

  {fd.call_type !== 'RESUS' && (
  <button type="button" onClick={() => sf('patient_refused_treatment', !fd.patient_refused_treatment)} ...>
    {fd.patient_refused_treatment ? '✓ Patient Refused Treatment — tap to undo' : 'Patient Refuses Treatment'}
  </button>
  )}

but the block it hides is NOT call-type-conditional (8037 and 8212):

  {!fd.patient_refused_treatment && (<>          // 8037 — history, mechanism, surveys,
  ...                                             //  vitals, oxygen, airway, circulation,
  {IvAndMedsSection()}                            //  immobilisation, IV + meds
  </>)}                                           // 8190

  {!fd.patient_refused_treatment && (<>          // 8212 — Transport: meds, vitals trend

Nothing clears `vitals`, `ivRows` or `medRows` when the flag is set, and they are submitted unconditionally:

  form_data: { ...fd, vitals_sets: vitals, iv_therapy: ivRows, medications: medRows },   // 4952

Both safety nets are also switched off by the same flag:

  if (vitals.length < MIN_VITALS && !fd.med_aid_dec_death && fd.call_type !== 'RHT' && !fd.patient_refused_treatment) {   // 5692
  if (fd.call_type === 'DOD' || fd.call_type === 'RHT' || fd.patient_refused_treatment) return warn;                      // 9204 (empty warnings)
```

</details>

**Recommended fix.** Render the refusal toggle for every call type (or at minimum whenever `fd.patient_refused_treatment` is already true, so it is always reversible). When the flag is set with non-empty vitals/ivRows/medRows, keep those sections visible in a read-only state rather than unmounting them, so the record and the screen agree.

<details><summary>Independent verification</summary>

The code says exactly what the claim says it says, and no guard prevents it.

VERIFIED:
1. DigitalPRFForm.tsx:8008 — the refusal toggle is wrapped in `{fd.call_type !== 'RESUS' && (`, with a comment stating the intent ("Hidden for Resus — the patient is dead or dying, so a treatment refusal doesn't apply").
2. The hidden block at 8037-8190 has ZERO call-type branching. Its contents, confirmed by listing every section header inside it: Patient History, Mechanism/Incident, Injury Diagram, Primary Survey, Secondary Survey, Vitals Monitoring, Oxygen Administration, Airway, Circulation, Immobilisation Equipment, and IvAndMedsSection(). The Transport-phase wrapper at 8212 is likewise unconditional, and RESUS does render phase 4 (advancePhase at 5592 hides only phases 1/3/6 for RESUS).
3. `sf('patient_refused_treatment', ...)` appears at exactly ONE site in the entire repo — line 8011, the hidden button. No reset on phase change, no reset on load, no other writer. So on a RESUS call the flag is unclearable from the RESUS UI; the only escape is switching call type away and back, which is undiscoverable.
4. Reachability is proven by the adjacent code, not asserted. CallTypePicker.pick() (line 2733) force-sets `med_aid_dec_death = (o === 'DOD')` with a comment explaining that a stale flag from a previous selection would otherwise leak into the wrong call type — the identical bug class, already recognised and guarded for the sibling flag — but leaves patient_refused_treatment untouched. The picker remains live as a dropdown pill after the first pick, on the same P0 screen that embeds P3(true) (line 6771). Sequence: refusal set on a PRIMARY/COURTESY call, patient deteriorates into arrest, crew switches call type to RESUS, toggle disappears, entire clinical body stays hidden. Clinically real (refusal followed by arrest) and also reachable by mis-tap.
5. Silence is confirmed, not just alleged. prfValidation.ts:2031 emits every finding with `severity: 'warn'`, so blockers() is always empty and handleSubmit's `if (!ok)` never fires. With the vitals-shortfall gate (5692) and reviewWarnings (9204) both short-circuited by the same flag, a RESUS PRF with no airway, defibrillation, vitals or drug record submits with no prompt whatsoever.
6. Data retention confirmed: buildSavePayload (4952) spreads `...fd, vitals_sets: vitals, iv_therapy: ivRows, medications: medRows` unconditionally; nothing clears them when the flag is set.

WHERE THE CLAIM OVERREACHES (partial refutation, insufficient to void it):
- Scenario A's "no one on scene can see" is false. On every non-RESUS call t

</details>

---

### `med_aid_dec_death` is simultaneously a collapse/disclosure toggle and the load-bearing 'this is a death certificate' flag — collapsing the form silently converts the record and strands the crew with no Submit button

- **Severity:** high · **Category:** state-bug · **Lens:** clinical-correctness
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:6714`

**Impact.** A death certificate PRF quietly stops being one. The crew loses the Submit button on the only screen that has it for DOD, the record picks up live-patient defaults (ward = casualty), and the deceased's particulars stop propagating to the patient_* fields that billing actually reads. Recovering requires re-expanding a form the crew has no reason to think is a data flag.

**Reproduction.** On a DOD call, tap the 'Declaration of Death Form' header a second time to collapse the (very long) certificate. `med_aid_dec_death` flips to false while `call_type` stays 'DOD'.
- The Undertaker section (7276) and the Available-time + 'Complete & Submit' block (7331) both disappear; the crew is offered 'UNDERTAKER →' (7372) instead, which calls `advancePhase(4, 'time_depart_scene', 'km_depart_scene')`.
- In advancePhase, `fd.med_aid_dec_death` is now false and 'DOD' is absent from the RESUS/PRIMARY/COURTESY/IFT/IHT/WCA_IOD list (5592) and is not RHT (5604), so no hidden-set applies and the crew is dropped onto the Transport phase and prompted for a depart-scene odometer and time on a deceased patient.
- Meanwhile `ward` gets defaulted to 'casualty' on the next load (4916), the deceased→patient mirror stops running (4837), and the Handover card re-titles from 'Undertaker' to 'Handover Details' (8286).

<details><summary>Evidence</summary>

```
The disclosure chevron writes the clinical fact flag directly:

  {fd.call_type === 'DOD' && timestamps.time_on_scene && kms.km_on_scene && (
    <button type="button" onClick={() => sf('med_aid_dec_death', !fd.med_aid_dec_death)}
      aria-expanded={!!fd.med_aid_dec_death} ...>
      <span>Declaration of Death Form</span>
      <div style={{ transform: fd.med_aid_dec_death ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</div>

(identical pattern for RESUS at 6780). That same flag drives, independently of `call_type`:

  const hidden = fd.med_aid_dec_death ? new Set([1,3,4,5,6]) : ... ;        // 4337 phase visibility
  if (fd.med_aid_dec_death) { const hidden = new Set([1,3,4,5,6]); ... }    // 5583 advancePhase
  {fd.med_aid_dec_death && (<><SHdr t="Undertaker" /> ...)}                  // 7276
  {fd.med_aid_dec_death ? (<>Available + Complete & Submit</>) : ...}        // 7331
  <SHdr t={fd.med_aid_dec_death ? "Undertaker" : "Handover Details"} />      // 8286
  if (!fd.med_aid_dec_death && !(fd.ward ?? '').trim()) sf('ward','casualty'); // 4916
  useEffect(() => { if (!fd.med_aid_dec_death) return; /* deceased -> patient mirror */ }, [...]) // 4837
  if (vitals.length < MIN_VITALS && !fd.med_aid_dec_death && ...)            // 5692

Note the CallTypePicker takes deliberate care to keep the flag in sync on pick (2741, `sf('med_aid_dec_death', o === 'DOD')`) — the collapse button then breaks that invariant.
```

</details>

**Recommended fix.** Give the collapse its own local `useState` (the phase-2 copy already does this correctly — `dodFormOpen`, line 4396 / 7218) and leave `med_aid_dec_death` derived from `call_type === 'DOD'` (plus the explicit RESUS-failed checkbox). Never bind a disclosure chevron to a clinical fact.

<details><summary>Independent verification</summary>

NOT REFUTED — the mechanism is real, verified in source, and no guard, normaliser or reachability argument neutralises it. Two of the three claimed impacts are wrong or overstated, but the core defect survives and its worst consequence is actually WORSE than the claim states.

CONFIRMED — the dual purpose is real (C:/Users/USER-PC/Desktop/New EMS AUTOMATIONS/frontend/src/pages/crew/DigitalPRFForm.tsx:6714). The Dispatch-phase control is dressed purely as a disclosure widget (label "Declaration of Death Form", a rotating chevron, `aria-expanded`, top-rounded-corners-when-open) and its onClick is `sf('med_aid_dec_death', !fd.med_aid_dec_death)` — it writes the clinical fact directly. Because CallTypePicker.pick sets `sf('med_aid_dec_death', o === 'DOD')` at :2741, the flag is ALREADY true when this button first renders, so the panel is expanded by default and the crew's very first interaction with it is a collapse — i.e. the first tap un-declares the death. The author's own comment at :2731-2740 says the flag is set "so the panel (which auto-expands on these call types) shows the right body" — the flag is being used as expansion state. Decisive counter-evidence that this is a slip and not a design choice: the SAME accordion on the On Scene phase (:7210-7249) uses a dedicated UI state `dodFormOpen` (:4396) and is gated on `fd.call_type === 'DOD'` alone. The concerns were separated there and not on Dispatch.

No guard exists. `normalizeFormData` (:4210-4224) only coerces PRF_TEXT_FIELDS/PRF_ARRAY_FIELDS — it does not resync the flag to call_type. There is no effect anywhere that re-derives `med_aid_dec_death` from `call_type`; the only writer besides the two toggles is the picker. The backend never references the field (grep over backend/ returns nothing), so nothing server-side repairs it.

THE IMPACT THE CLAIM MISSED — the medical-legal document. In C:/Users/USER-PC/Desktop/New EMS AUTOMATIONS/frontend/src/pages/PRFView.tsx the statutory Declaration of Death block has two mutually-exclusive implementations: BAND B at :1774 guarded `fd.call_type === 'DOD' && fd.med_aid_dec_death`, and the dedicated sheet at :2892 guarded `fd.med_aid_dec_death && fd.call_type !== 'DOD'`. The combination call_type==='DOD' && !med_aid_dec_death matches NEITHER, so the entire death certificate — date/time of death, particulars of deceased, HCP, medical confirmation, handover, signed declaration — silently vanishes from the rendered and printed PRF. And the crew can still fill every one of those fields, because the On Scene DOD section (:7210) is gated on call_type only. So a cr

</details>

---

### Medication and IV scope are validated against the treating practitioner, not against the crew member recorded as administering the drug

- **Severity:** high · **Category:** clinical-correctness · **Lens:** clinical-correctness
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:7694`

**Impact.** The PRF carries a signed attestation that a Basic Ambulance Assistant administered a schedule-controlled ALS drug, and the form actively certifies it as in-scope. This is the single most consequential HPCSA record on the document and the check is pointed at the wrong person.

**Reproduction.** Crew 1 = ECP, Crew 2 = BAA; both are selected as treating practitioners. `picked[0]` is Crew 1, so `treating_practitioner_category = 'ECP'` and every scope check passes. Add a Medication row, and in the 'Who is administering this Medication?' picker choose Crew 2 (the BAA), who signs for it. The row is stored as `administered_by_qualification: 'BAA'` with, say, Morphine — a drug no BAA may administer. `medOutOfScope` evaluates `!medCap.authorised.includes('ECP')` → false, so no badge, no warning, nothing.

<details><summary>Evidence</summary>

```
Each med/IV row is explicitly attributed to a named crew member with their own qualification and HPCSA number (10164-10171):

  const newRow: Record<string,string> = {
    administered_by: crew.name,
    administered_by_qualification: crew.qualification,
    administered_by_hpcsa: crew.hpcsa,
    sign: b64,
  };

But the out-of-scope badge on that very row ignores those fields and consults the PRF-level treating practitioner instead (7693-7696):

  {medRows.map((row, i) => {
    const treatingCat = normaliseHpcsaCategory(fd.treating_practitioner_category);
    const medCap = findMedicationByName(row.type);
    const medOutOfScope = !!(treatingCat && medCap && !medCap.authorised.includes(treatingCat));

and the drug picker is filtered the same way (7689-7690): `const authorised = medicationNamesForCategory(cat);` where `cat` is again the treating practitioner. Same for the IV button (7666-7668): `const canIv = !cat || isAuthorised(cat,'circ_iv_cannulation_limbs_over_1yr');`

Worse, `fd.treating_practitioner_category` is not "the practitioner" but the FIRST entry of a multi-select, in `opts` order (Crew 1, Crew 2, extra crew) — 9913-9921:

  const confirm = () => {
    const picked = opts.filter(o => selected.has(o.id));
    if (picked.length === 0) return;
    sf('treating_practitioner_name', picked[0].name);
    sf('treating_practitioner_category', picked[0].qualification);   // <-- first-in-list wins
```

</details>

**Recommended fix.** Scope-check each row against `normaliseHpcsaCategory(row.administered_by_qualification)`, falling back to the treating practitioner only when the row has no attribution. Do the same for the IV rows. Separately, `treating_practitioner_category` should not be silently reduced to `picked[0]` — either store the full set and check against the specific performer, or make the single-category choice explicit to the crew.

<details><summary>Independent verification</summary>

The mechanism is real and verified at every cited line. frontend/src/pages/crew/DigitalPRFForm.tsx:7694-7696 computes medOutOfScope from fd.treating_practitioner_category; :7689 filters the drug list by the same value; :7666-7668 gates the IV button on it. row.administered_by_qualification is read in exactly two places in the whole frontend (:7593, :7764), both display-only — no frontend scope check ever consults it. The first-in-list finding is also accurate: :9913-9921 does opts.filter(...) then picked[0].qualification, and opts is ordered Crew 1, Crew 2, extra crew.

Crucially, the codebase's own documented decision sides with the claim. backend/app/rules/hpcsa_scope.py:15-20 records "decided 2026-05-17 D5=b": procedure checkboxes check against the treating practitioner, but medication/IV rows must prefer the row's administered_by_qualification. The backend implements that correctly (:170) and it is unit-tested (test_rules_hpcsa_scope.py:147-181). The frontend contradicts the project's written design decision.

I tried to refute via that backend safety net and could not. hpcsa_scope.evaluate only receives its inputs if build_claim_context is called with extracted_data, and the sole production caller — adjudication_engine.py:514 — omits that argument. treating_practitioner_category and medications_list are therefore never populated in production and evaluate() short-circuits at "if not treating: return results". The per-row-correct check exists but fires only in its own tests, so nothing downstream compensates.

The claim's impact framing is nonetheless inflated, and should be corrected rather than accepted: (1) "the form actively certifies it as in-scope" is false — there is no in-scope affirmation anywhere; the only artifact is an amber badge that appears on violation and whose text names the category it checked ("Out of scope for {treatingCat}"), so a missing badge is silence, not certification. (2) "the drug picker is filtered the same way" is misleading — :7703-7705 adds every out-of-scope drug back under an "Out of scope" optgroup, with an always-available "Other..." free-text escape, and a comment stating this is deliberate so a drug given by a higher-qualified partner can still be recorded; nothing is blocked or dropped. (3) The exported PDF (PRFView.tsx:2601-2625) prints Drug/Route/Dose/Time/Reason/Signature and does not print administered_by, qualification, or HPCSA number, nor any scope marker — so the medical-legal document carries no false in-scope statement. (4) The IV button (if (!canIv) return null) is the most concrete consequence but 

</details>

---

### Dismissing the treating-practitioner picker disables HPCSA scope enforcement for the entire PRF (fail-open)

- **Severity:** high · **Category:** security · **Lens:** clinical-correctness
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:10021`

**Impact.** The scope matrix — the whole point of which is that "a BAA-registered crew member can't be recorded performing an ANT/ECP procedure" (comment at 4383) — is one tap away from being off for the entire call, with no persisted marker that it was bypassed. Combined with finding #1, an unscoped PRF and a scoped-then-switched PRF are indistinguishable in the stored record.

**Reproduction.** 1. Reach the clinical section via 'Start Examination' (6519-6523), which opens the picker when no category is set.
2. Tap Cancel. `dismissedTreating = true`; the effect at 4711 can never re-fire (and its `phase !== 3` guard means it was already unreachable — phase 3 is one of the three hidden phases).
3. Every airway, circulation, medication and IV control is now fully enabled regardless of who is on the vehicle. The only visible trace is a small amber banner at 7913-7931, which sits above the fields it fails to gate.
4. Equivalent path with no user action: a crew profile whose `qualification` is e.g. 'Paramedic (Intermediate)' or 'AEA - Advanced' normalises to undefined and produces the same open gate.

<details><summary>Evidence</summary>

```
The picker's Cancel writes nothing and suppresses re-prompting:

  onClick={() => { setDismissedTreating(true); setCrewPicker(null); }}        // 10021

and the only auto-open guard respects that flag (4711-4718):

  useEffect(() => {
    if (phase !== 3) return;                       // phase 3 (Clinical) is a HIDDEN phase — never reached
    if (fd.treating_practitioner_category) return;
    if (dismissedTreating) return;
    setCrewPicker({ phase: 'select', kind: 'treating' });

With `treating_practitioner_category` empty, every scope check short-circuits to authorised:

  const ok = !cat || isAuthorised(cat, capabilityKey);                        // ScopedInp, 3519
  const canIv = !cat || isAuthorised(cat, 'circ_iv_cannulation_limbs_over_1yr'); // 7667
  const medOutOfScope = !!(treatingCat && medCap && !...);                    // 7696 — false when unset
  // hpcsaScope.ts:1254
  if (!normalised) return { kind: 'authorised', capabilityKey: key };

`normaliseHpcsaCategory` also returns `undefined` for any qualification string outside the seven codes and the small legacy map (hpcsaScope.ts:1128-1163: BLS/ILS/ALS/ICU/PARAMEDIC/EMT-B/EMT-I/EMT-P/CCA/BASIC/DOCTOR/MD/DR), so a free-text qualification on a crew or `extra_crew` record has the same fail-open effect.
```

</details>

**Recommended fix.** Persist the bypass (e.g. `scope_gate_dismissed: true`) so the record shows enforcement was off, and re-prompt on entry to the clinical section rather than latching `dismissedTreating` for the mount. Separately, log/flag unrecognised qualification strings instead of silently failing open — a value that does not normalise is a data problem, not an authorisation.

<details><summary>Independent verification</summary>

The mechanism is real and verified line by line. DigitalPRFForm.tsx:10021 Cancel is exactly `setDismissedTreating(true); setCrewPicker(null);` — no sf() write, no setPhase rollback, and the treating overlay has no backdrop-dismiss so Cancel is the sole exit. dismissedTreating (declared 4392) is only ever set true. With treating_practitioner_category empty, every consumer short-circuits to authorised: ScopedInp 3519, IV add-button 7667, medOutOfScope 7696, the airway/circulation Chk grids at 8118/8159 via scopeForFormLabel, and medicationNamesForCategory(undefined) returns the whole catalogue; hpcsaScope.ts:1254 returns {kind:'authorised'} for an unresolved category. Crucially there is NO server-side compensating control: backend/app/rules/hpcsa_scope.py:106-113 also returns zero findings on an empty category and comments that the "Phase 2 gate normally prevents this" and "missing gate is its own separate concern". So the whole stack delegates correctness to a gate that is optional. Two comments assert a guarantee the code does not provide: 4714-4715 claims Cancel "drops back to Phase 2" (it never calls setPhase) and 7910-7912 claims the fallback banner is only reachable "via dev tools or a stale state" (Cancel reaches it normally). The LEGACY_TIER_TO_CATEGORY map at 1128-1163 is quoted accurately and unmapped strings do fail open.

Errors in the claim's evidence that do not save it: (1) "phase 3 (Clinical) is a HIDDEN phase — never reached" is wrong twice — phase 3 is reached by jumpToVitals (setPhase(3), 8699) and inferResumePhase (4619), and the phase!==3 effect is not even the primary trigger; the real entry is P0's "Start Examination" button at 6521 which opens the picker and then renders P3(true) inline at 6773. Reachability is broader than claimed. (2) "an unscoped PRF and a scoped-then-switched PRF are indistinguishable" is wrong as stated — an unscoped PRF stores empty treating_practitioner_name/category/hpcsa, plainly distinguishable from a switched one; what is genuinely absent is a positive marker that the crew declined, and empty is ambiguous with pre-feature PRFs. (3) The claim omits real mitigations: a standing role="alert" banner with a "Pick" button renders at the top of the clinical section whenever the practitioner is unset (7906-7930), and dismissedTreating is component state only (not in fd, not in the localStorage draft), so a reload/resume re-prompts. (4) "free-text qualification" is overstated for crew 1/2 — ProviderManagement.tsx:1181 constrains qualification to a select of the seven codes — though legacyOption (25-28) deliberatel

</details>

---

### Zero automated checks would fail if DigitalPRFForm.tsx broke — 70 of the 276 frontend tests are self-referential mirrors

- **Severity:** high · **Category:** coverage-gap · **Lens:** coverage-and-risk
- **Location:** `frontend/src/test/conditionalFields.test.ts:78`

**Impact.** The two files named after the form contribute 70 tests (25.4% of the frontend suite) and 0% of its coverage. They pass with the component deleted. Anyone reading the suite sees 276 green and concludes the roadside form is tested; 96 real PRFs and every claim derived from them are protected by nothing.

**Reproduction.** cd frontend && npx vitest run  → 276 passed. Then grep the two files for any import from '../' → none. Delete DigitalPRFForm.tsx → both files still pass.

<details><summary>Evidence</summary>

```
conditionalFields.test.ts:77-78 — "/** Mirror the field visibility rules from DigitalPRFForm.tsx JSX */\nfunction isFieldVisible(fd: Fd, fieldGroup: string): boolean {" — the function under test is defined in the test file. digitalPrfSecurity.test.ts:13 does the same: "function shouldSkipSave(currentPayload: object, lastSavedRef: { current: string | null }): boolean {". Verified by import scan: conditionalFields.test.ts and digitalPrfSecurity.test.ts import NOTHING from ../ — every other test file does (offlineSync → ../services/offlineDb, prfValidation → ../pages/crew/prfValidation, prfPdfLayout → ../pages/prfPdfLayout, PRFView tests → ../pages/PRFView). Suite run: 9 files, 276 tests, all pass.
```

</details>

**Recommended fix.** Treat this as negative coverage, not zero coverage. Either (a) rename both to *.model.test.ts with a header stating they test a hand-written model, not the form, or (b) delete them and rebuild against extracted modules (see the seam findings below). Do this first — it is the only change that stops the suite lying.

<details><summary>Independent verification</summary>

VERDICT: NOT REFUTED. Every factual assertion in the claim independently verified, and I found the predicted drift has ALREADY materialised — the claim is if anything understated.

VERIFIED AS STATED
1. Import isolation. `grep` for imports across all 9 test files: conditionalFields.test.ts imports ONLY `vitest` (line 26); digitalPrfSecurity.test.ts imports ONLY `vitest` (line 8). Every other file imports real source: offlineSync → ../services/offlineDb + ../services/syncEngine, prfValidation → ../pages/crew/prfValidation, prfPdfLayout → ../pages/prfPdfLayout, prfResumePhase → ../utils/prfResumePhase, both PDF .tsx files → ../pages/PRFView, authRefreshFanout → ../api/client. Exactly the two named files are inert.
2. Only non-test reference to the component is App.tsx:30 (`import DigitalPRFForm from './pages/crew/DigitalPRFForm'`) and its route at App.tsx:236. No test imports it, directly or transitively.
3. Counts. Ran `npx vitest run`: 9 files, 276 tests, 276 pass. `it(` blocks: conditionalFields 58, digitalPrfSecurity 12 = 70 = 25.4%. Numbers exact.
4. The quoted lines are verbatim (conditionalFields.test.ts:77-78, digitalPrfSecurity.test.ts:13).

NEW EVIDENCE — THE MIRRORS HAVE ALREADY DRIFTED, GREEN
5. Dead billing type asserted as live. Test ALL_BILLING_OPTS (line 68) = ['MED AID','PVT','RAF','WCA','CALL OUT FEE']. Real BILLING_TYPE_OPTS (DigitalPRFForm.tsx:2877) = ['MED AID','RAF','PVT','CALL OUT FEE'] — no 'WCA'. conditionalFields.test.ts:229 asserts `expect(opts).toContain('WCA')` for a PRIMARY call, and isFieldVisible case 'wca_details' (line 95-96) returns `bt === 'WCA'`. Both pass while describing a billing option the crew cannot select. Contrast prfPdfFieldMatrix.test.tsx:541, which DID get updated when 'EVENT' was removed — because it really imports PRFView and would have broken. The self-referential file silently rotted.
6. The dedup mirror encodes the data-loss variant. Test `shouldSkipSave` (line 13-18) commits `lastSavedRef.current = serialized` unconditionally, before any save. Real doSave checks at 4985 but commits at 4994 ONLY after `await api().patch(...)` resolves; resets to null on 409 (5026); and 5044 comments "Do NOT advance lastSavedPayloadRef so the same data is retried". Test line 35 asserts "stores the serialized payload after the first save" — false for the shipping code on a failed save. The mirror documents commit-before-save, i.e. the exact bug (silently discarding a patient record after a failed PATCH) that the real code was written to avoid. Someone "fixing" doSave to match its own test would introduce that data loss.
7.

</details>

---

### The mirrored logic has already drifted: conditionalFields.test.ts asserts on call types, billing types and fields that do not exist

- **Severity:** high · **Category:** coverage-gap · **Lens:** coverage-and-risk
- **Location:** `frontend/src/test/conditionalFields.test.ts:68`

**Impact.** The mirror is not merely unattached, it is wrong. It documents billing options that can never be picked and a field-visibility model for panels that do not exist. Anyone changing the real BillingTypePicker will get 58 green tests confirming behaviour the form does not have.

**Reproduction.** grep -n "BILLING_TYPE_OPTS\|CALL_TYPE_OPTS" DigitalPRFForm.tsx (lines 2877, 2630) and compare to conditionalFields.test.ts lines 68-75 and every 'IFT' assertion.

<details><summary>Evidence</summary>

```
Test: "const ALL_BILLING_OPTS = ['MED AID', 'PVT', 'RAF', 'WCA', 'CALL OUT FEE'];" and "it('PRIMARY call can use MED AID, RAF, WCA, PVT...')  expect(opts).toContain('WCA')". Real: DigitalPRFForm.tsx:2877 "const BILLING_TYPE_OPTS = ['MED AID', 'RAF', 'PVT', 'CALL OUT FEE'] as const;" — there is no 'WCA'. Test asserts on call_type 'IFT' in 12 places; real: DigitalPRFForm.tsx:2630 "const CALL_TYPE_OPTS = ['PRIMARY', 'IHT', 'RHT', 'WCA_IOD', 'COURTESY', 'RESUS', 'DOD']" — no 'IFT' (it is a legacy value, label 'IFT/IHT' maps to IHT). Test's 'mechanism_detail' field group: real field is mechanism_other (DigitalPRFForm.tsx:8064 fk="mechanism_other"); the test enumerates mechanism 'Medical' — MECHANISM_OPTS:546 has 'Medical Emergency'. Test's 'raf_claim_number' does not exist; real RAF keys are raf_police_case_number / raf_accident_date / raf_oar_report_pdf. Field groups 'bypass_motivation', 'wca_details', 'iht_nursing_notes' have no counterpart anywhere in the component.
```

</details>

**Recommended fix.** Do not repair the mirror in place — that just re-creates the drift. Extract the real tables (CALL_TYPE_OPTS, BILLING_TYPE_OPTS, the billingOpts filter at 2895-2900, the CallTypePicker pick side-effects at 2731-2749) into src/pages/crew/prfCallTypeModel.ts and have the test import them.

<details><summary>Independent verification</summary>

NOT REFUTED — the core defect is real and I reproduced it. But three of the claim's five evidence items are wrong or overstated, and the finding needs rewriting before it is actioned.

VERIFIED BY EXECUTION
I ran the suite: `npx vitest run src/test/conditionalFields.test.ts` -> "Test Files 1 passed (1) / Tests 58 passed (58)". The evidence is demonstrated, not asserted. Combined with the established fact that nothing mounts DigitalPRFForm, these 58 tests are green against a hand-written mirror in the test file, and at least one of them affirmatively asserts behaviour the form does not have.

CONFIRMED (the finding stands on these)
1. The 'WCA' billing option is fictional AND affirmatively asserted. Test line 68 `ALL_BILLING_OPTS = ['MED AID','PVT','RAF','WCA','CALL OUT FEE']`; line 229 `expect(opts).toContain('WCA')`. Real, C:\Users\USER-PC\Desktop\New EMS AUTOMATIONS\frontend\src\pages\crew\DigitalPRFForm.tsx:2877 `const BILLING_TYPE_OPTS = ['MED AID','RAF','PVT','CALL OUT FEE']`. There is no 'WCA' pickable option. A green test therefore certifies a chip the crew can never tap. This one is the real finding.
2. 'bypass_motivation' is fictional AND asserted twice (test lines 457-465, `ct !== 'PRIMARY'`). No counterpart exists: grep for "motivation" in the component yields only `vitals_shortfall_motivation` (a submit-time gate, 5683-5695) and an ungated "Motivation / Other Notes" -> `motivation_notes` (8648). The nearest real field, `closest_facility_bypassed` (5330), is a phase-4 field with no call_type gate.
3. `raf_claim_number` does not exist (real RAF keys: raf_police_case_number, raf_accident_date, raf_accident_location, raf_sketch, raf_oar_report_pdf) — but it appears only as inert setup data at test lines 528/539 and is never asserted on.
4. `mechanism_detail` as an fd key is fictional (real key is `mechanism_other`, DigitalPRFForm.tsx:8064) — though the modelled *visibility rule* `!!fd.mechanism` exactly matches the real gate at 8060 `{fd.mechanism && (`. Naming drift, correct logic.
5. Mechanism 'Medical' vs real 'Medical Emergency' (MECHANISM_OPTS, ~line 546): true, but inert — that loop only proves a non-empty string is truthy, and 7 of its 8 values are real.

WRONG IN THE CLAIM — must be corrected
6. The IFT evidence, which is the claim's largest ("12 places"), is essentially wrong. 'IFT' is indeed absent from CALL_TYPE_OPTS (2630), but the real component is still IFT-aware in ~10 live branches: `['IFT','IHT'].includes(fd.call_type)` at 5438, 6014, 6638, 6672, 6771, 6811, 7457, 8395, and `fd.call_type === 'IFT'` at 4471. The test's `ift_iht_fi

</details>

---

### The submit path's authoritative final save — where signatures were lost once already — has no test

- **Severity:** high · **Category:** data-loss · **Lens:** coverage-and-risk
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:5740`

**Impact.** This is the exact regression that already shipped: crew and patient signatures written as NULL on a submitted, permanently-locked PRF. A PRF is a legal clinical record and the billing artefact; an unsigned one is unclaimable and unrepairable (the row is 423-locked after submit). Reintroducing it is a single careless edit to doSave's dedup, and nothing would notice.

**Reproduction.** Make doSave's dedup (L4985 'if (payloadStr === lastSavedPayloadRef.current) return;') swallow the final save again, or delete the direct PATCH block at 5747-5780 and let handleSubmit rely on doSave(). Suite stays 276/276 green.

<details><summary>Evidence</summary>

```
L5740-5780: "// Authoritative final save — MUST land before we lock the PRF via /submit. The crew sign-off and patient signatures were drawn seconds ago in the pre-submit modals; going through doSave()'s dedup + coalescing could skip or defer this save (a deferred save then 423s after submit and is lost), which dropped every signature captured at submit time — crew + patient saved NULL while the earlier handover signature persisted." The repair is a bare for-loop with four status branches (409 refresh-and-retry, 423 treat-as-saved, 401 queue-to-outbox-then-relogin, default break-and-fall-through-to-submit). Nothing imports or exercises any of it.
```

</details>

**Recommended fix.** Extract buildSavePayload (L4940-4956) and the submit-save ladder into src/pages/crew/prfSaveContract.ts as pure functions over an explicit state object, then assert: signatures are always present in the payload; a 409 retries exactly once with a refreshed token; a 401 queues to the outbox BEFORE navigating; a 423 does not lose the payload. This is the single highest-value test file to write.

<details><summary>Independent verification</summary>

The claim survives adversarial checking on every refutation ground offered.

CODE SAYS WHAT THE CLAIM SAYS. frontend/src/pages/crew/DigitalPRFForm.tsx:5740-5780 contains the quoted comment essentially verbatim and the described structure: `for (let attempt = 0; attempt < 2 && !saved; attempt++)` wrapping a direct `api().patch(/api/digital-prf/${prfId}, finalPayload)`, with four branches — 409 (refetch to refresh `baseUpdatedAtRef`, `continue`), 423 (`saved = true; break`), 401 (`await queueToOutbox(finalPayload)`, `handleSessionExpired()`, `return`), default (`break`, falling through to `/submit` which routes to the offline outbox). The hazard it bypasses is real and present: `doSave` at L4977 has both the coalescing early-return (L4981 `if (savingInFlightRef.current) { savePendingRef.current = true; return; }`) and the payload dedup (L4985 `if (payloadStr === lastSavedPayloadRef.current) return;`).

NO GUARD PREVENTS THE IMPACT. I looked specifically for a server-side backstop. `backend/app/api/digital_prf.py:1145` `_validate_prf_for_submission` is explicitly documented as the "server-side safety net" but checks only: form_data non-empty, `call_type` present, `crew_member_1_id` present. It performs NO signature check. So a submit with NULL crew/patient signatures is accepted (202), and `digital_prf.py:363-365` (`if prf.status != PRFStatus.DRAFT: raise 423`) makes the row permanently uneditable. There is no admin reopen/amend route for a DigitalPRF — `amended_by_id` exists only for Claims (backend/app/api/claims.py:307-385). The "unclaimable and unrepairable" characterisation is therefore accurate at the product level, not overstated.

NOT A DELIBERATE-DESIGN FALSE POSITIVE. It touches none of the listed intentional choices (validatePhase short-circuit, non-exported values, normalizeFormData, viewport, phase indexing, dual auth).

NOT UNREACHABLE. `handleSubmit` is the sole submit path (crew button plus the summary-review and crew-sign-off modals re-entering it), and this block runs on every submission; 96 real PRFs exist in production.

COVERAGE GAP INDEPENDENTLY VERIFIED, NOT ASSERTED. The only import of DigitalPRFForm anywhere is frontend/src/App.tsx:30 (route element). conditionalFields.test.ts, digitalPrfSecurity.test.ts and prfPdfFieldMatrix.test.tsx reference it in comments only. offlineSync.test.ts covers services/offlineDb + syncEngine (queueSave/queueSubmit/423/404/dead-entry semantics) — the library the 401 branch calls into, but not the branch or the save-before-submit ordering. Backend tests exercise the PATCH and /submit endpoints but canno

</details>

---

### doSave's error routing decides whether a crew's work is queued or discarded — five branches, no coverage

- **Severity:** high · **Category:** data-loss · **Lens:** coverage-and-risk
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:4998`

**Impact.** The 404 branch is what makes offline PRF creation (commit b69ea03) safe: a PRF whose create is still in the outbox must have its edits queued, not dropped. If that branch is ever collapsed into the generic error case, every offline-started PRF silently loses its edits — the crew sees no error (saveState is not surfaced to the crew by design, L4314-4316) and the record is gone.

**Reproduction.** Change the 404 branch to fall through to setSaveState('error'). No test fails. On a no-signal call the outbox never receives the save; the crew's PRF exists only in localStorage on that handset.

<details><summary>Evidence</summary>

```
L4998-5047: 401 → "await queueToOutbox(payload); handleSessionExpired();"; 423 → "prfLockedRef.current = true"; 409 → refresh updated_at, "lastSavedPayloadRef.current = null; savePendingRef.current = true; retryDelayRef.current = 1500;"; offline → queueToOutbox; 404 → "// No server row yet. This is the normal state for a PRF the crew started with no signal ... await queueToOutbox(payload);"; else → "setSaveState('error')" with "// Do NOT advance lastSavedPayloadRef". offlineSync.test.ts (35 tests) covers queueSave/queueSubmit and the sync engine once called — it never asserts that doSave calls them, or for which statuses.
```

</details>

**Recommended fix.** Extract a pure classifySaveError(status, errCode, navigatorOnline) → 'relogin' | 'lock' | 'retry-409' | 'outbox' | 'error' into prfSaveContract.ts and table-test all six branches. doSave then becomes a thin dispatcher.

<details><summary>Independent verification</summary>

VERDICT: The finding stands on its facts, but the claimed impact is materially overstated. Severity should be MEDIUM, not high.

WHAT SURVIVES (verified, not taken on faith):

1. The code says exactly what the claim says. `frontend/src/pages/crew/DigitalPRFForm.tsx` L4998-5047 contains all five branches verbatim as quoted: 401 -> `await queueToOutbox(payload); handleSessionExpired();` (L5002-5003); 423 -> `prfLockedRef.current = true` (L5011); 409 -> refresh `updated_at`, `lastSavedPayloadRef.current = null; savePendingRef.current = true; retryDelayRef.current = 1500;` (L5026-5028); offline -> `queueToOutbox` (L5032); 404 -> the quoted comment plus `await queueToOutbox(payload)` (L5035-5041); else -> `setSaveState('error')` with the "Do NOT advance lastSavedPayloadRef" comment (L5044-5046). No paraphrase, no misquote.

2. The coverage gap is real. `frontend/src/test/digitalPrfSecurity.test.ts` L10-12 states outright that it extracts a pure utility "to avoid needing to mount the full 5000-line DigitalPRFForm component" — it tests only `shouldSkipSave` (payload dedup), never the catch block. Grep across all frontend test files for `doSave`/`DigitalPRFForm` returns only comments and re-implementations. So doSave's status routing — the queue-vs-discard decision for patient records — is genuinely unexecuted by any test.

3. Save state is genuinely invisible to the crew. L4317-4320 confirm `setSaving`, `setLastSaved` and `setSaveState` are all destructured with a discarded getter (`const [, setSaveState] = ...`), so a mis-routed error surfaces nothing. That part of the claim is accurate.

WHAT IS OVERSTATED — "every offline-started PRF silently loses its edits, the record is gone" does not follow:

a) The 404 branch is unreachable while actually offline. L5030 tests `!navigator.onLine || ECONNABORTED || ERR_NETWORK` BEFORE the 404 test at L5034. An offline crew always lands in the offline branch. Reaching 404 requires a real HTTP response, i.e. the device is online and the outbox create simply has not drained yet. Per `syncEngine.ts` L165-185 that window is bounded: sync fires 1s after the `online` event, on visibilitychange, and every 60s. So the 404 branch protects a narrow reconnection window, not the offline period the claim attributes to it.

b) Saves are full-state, not incremental. `buildSavePayload()` (L4940-4956) serialises the entire form, and `queueSave` writes a fixed key `${prfId}:save` (offlineDb.ts L61-72), overwriting rather than accumulating. One later successful PATCH carries everything. Nothing is "lost edits" — at worst a save is deferred u

</details>

---

### Local draft always wins over the server copy — a one-character inversion silently replaces in-progress work

- **Severity:** high · **Category:** data-loss · **Lens:** coverage-and-risk
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:4593`

**Impact.** Between the 400ms local autosave and the next server contact (phase change / phone lock / 5-min timer) the ONLY copy of the crew's work is this localStorage draft. Inverting the guard, or clearing the draft one line too early, replaces live roadside data with a stale server snapshot on the next reload — with no error and no way back.

**Reproduction.** Remove the `!` at L4593. Reload a PRF mid-call: every field typed since the last server contact reverts. Suite: 276/276 green.

<details><summary>Evidence</summary>

```
L4590-4594: "// If there is an active local draft, DO NOT overwrite the form state with the server's version. The local draft contains the user's most recent auto-saved keystrokes that haven't been pushed yet.\n if (!localStorage.getItem(`prf-draft:${prfId}`)) { setFd(normalizeFormData(data)); ..." — plus loadFromLocal() at L4507-4527 and clearLocalDraft() at L4529-4531, called on every successful submit path (L5815, 5819, 5823, 5870). No test touches the key `prf-draft:${prfId}` or this precedence rule.
```

</details>

**Recommended fix.** Extract readDraft/writeDraft/clearDraft plus a pure chooseHydrationSource(hasLocalDraft, serverRow) into src/pages/crew/prfLocalDraft.ts; test that a present draft wins, an absent one falls through to the server, a corrupt JSON draft returns false without throwing (L4526 'catch { return false; }'), and that clearDraft only runs after a confirmed submit.

<details><summary>Independent verification</summary>

VERIFIED, NOT REFUTED — with one sub-claim trimmed.

CODE SAYS WHAT THE CLAIM SAYS. DigitalPRFForm.tsx:4590-4593 is verbatim as quoted. The guard `if (!localStorage.getItem(`prf-draft:${prfId}`))` sits inside fetchPrfOnce and gates lines 4594-4619 — the ENTIRE server hydration: setFd(normalizeFormData(data)), vehicle, crew2Id, vitals, ivRows, medRows, every ALL_TIME_ROWS timestamp+km, geos, all five signature slots, and setPhase(inferResumePhase(...)). One `!` controls ~26 state writes, not a single field. Note setPrfMeta(prf) and baseUpdatedAtRef.current (the OCC token, 4586-4588) are set OUTSIDE the guard — deliberate and correct, metadata refreshes either way.

helpers at claimed lines: loadFromLocal 4507-4527, clearLocalDraft 4529-4531. Call sites confirmed by grep: saveToLocal at 4731 (400ms debounce) and 5732; clearLocalDraft at exactly 5815, 5818, 5823, 5870 — all four after a confirmed 2xx from POST /submit.

COVERAGE GAP IS REAL. grep for `prf-draft` across all of frontend/ returns exactly two source files (DigitalPRFForm.tsx:4493, CrewDashboard.tsx:285/518) and ZERO test files. No test references loadFromLocal, clearLocalDraft, saveToLocal or the precedence rule. Consistent with the established fact that nothing mounts the component. Inverting the `!`, or deleting it, is caught by no test, no type check and no runtime assert.

NO EXISTING GUARD PREVENTS IT. There is no savedAt/staleness check — savedAt is written in saveToLocal (4501) and by CrewDashboard's seed, but loadFromLocal never reads it. The try/catch in loadFromLocal only guards JSON corruption, not precedence. normalizeFormData is applied on the SERVER branch only; loadFromLocal calls setFd(draft.fd) raw.

PATH IS REACHABLE AND DOMINANT — stronger than the claim states. CrewDashboard.tsx:518 (startPrfOffline, commit b69ea03) SEEDS `prf-draft:${newId}` at creation, before any server row exists, with an in-code comment that its shape "MUST match what DigitalPRFForm's saveToLocal writes" because loadFromLocal bails on !draft.fd. For an offline-created PRF the local branch is the ONLY branch that can produce a form — the server fetch 404s. So the invariant is load-bearing across two files with zero coverage, and an inverted guard there would blank the form outright rather than merely staling it.

NOT A DELIBERATE-DESIGN FALSE POSITIVE. Local-wins IS the intended hybrid-save design, but the claim does not ask to change it — it flags that the deciding character is untested. It touches none of the listed deliberate choices (validatePhase short-circuit, non-exported values, normalizeFormData

</details>

---

### collectLeavePhaseBlockers is the form's ONLY real gate — prfValidation's 62 tests cover a function that can never block

- **Severity:** high · **Category:** coverage-gap · **Lens:** coverage-and-risk
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:5398`

**Impact.** Every value the mileage engine and the IFT/IHT billing path depend on — km_dispatched, km_on_scene, km_depart_scene, km_at_destination, med_aid_quoted_amount, preauth_number — is protected by this one untested function. Lose a branch and PRFs submit with missing odometer legs, producing claims that cannot be priced. prfValidation.test.ts's 62 green tests actively obscure this: they test a rules table that is intentionally short-circuited in production.

**Reproduction.** Set fd.medical_scheme empty (the common case) → validatePhase returns [] → runValidation always ok:true. Delete the IFT/IHT branch at L5438-5459: no test fails, and IFT/IHT PRFs advance with no pre-auth number.

<details><summary>Evidence</summary>

```
prfValidation.ts:2044 "if (!scheme) return [];" and 2059 "severity: 'warn',  // block nothing, ever". So runValidation()'s blocking check (L5300-5301 "const blocking = validationBlockers(all); if (blocking.length > 0)") can never fire — both gates that call it, advancePhase L5571-5572 ("const { ok } = runValidation(phase); if (!ok) return;") and handleSubmit L5707 ("const { ok, findings: f } = runValidation(6);"), are dead code. The live gates are collectLeavePhaseBlockers (L5398-5468: per-leg time capture, per-leg odometer, IFT/IHT quoted amount + pre-auth) enforced at two call sites — advancePhase L5563 and the stepper node onClick L8887 — and allCrewSigned at L5718/5726. Neither has a test.
```

</details>

**Recommended fix.** Extract collectLeavePhaseBlockers into src/pages/crew/prfGates.ts as a pure fn over {fromPhase, timestamps, kms, fd}. Test each blocker id (INLINE-TIME-*, INLINE-KM-*, INLINE-MISSING-DISPATCH, INLINE-QUOTED-AMOUNT, INLINE-PREAUTH), the ALL_TIME_ROWS→phase lookup at L5401, and that the stepper path (L8887) applies the identical set as the CTA path.

<details><summary>Independent verification</summary>

Core claim verified against source; three specifics need correction, none fatal.

VERIFIED EXACTLY AS CLAIMED (all 8 line refs correct verbatim):
- prfValidation.ts:2044 "if (!scheme) return [];" and :2059 "severity: 'warn', // block nothing, ever". validatePhase is the sole producer of RULES findings, so blockers() (filter severity==='block') can never return non-empty.
- DigitalPRFForm.tsx:5300-5301 blocking check, :5571-5572 advancePhase "if (!ok) return", :5707 runValidation(6) with its alert() at 5708-5713 — both if(!ok) branches are genuinely unreachable dead code.
- collectLeavePhaseBlockers at :5398-5468, exactly two call sites (advancePhase :5563, stepper onClick :8887); allCrewSigned defined :5661, gated :5718/:5726. Untested (nothing mounts the form).
- NO SERVER BACKSTOP: backend/app/api/digital_prf.py:1145 _validate_prf_for_submission checks only non-empty form_data, call_type, crew_member_1_id. Docstring: "The mobile form does the detailed validation." No km, no med_aid_quoted_amount, no preauth_number. So the client function IS the only enforcement in the whole stack for those fields.

CORRECTION 1 — impact mis-stated (but in the claim's favour, not against): missing odometer legs do not produce unpriceable claims; they price silently at ZERO. digital_prf.py:615 `_km` returns 0.0 for falsy. mileage_engine.py:346-360 computes each segment only when both endpoints are non-None; GPS fallback at :560 tries geo_segments_from_prf; :597-599 coerces to 0.0. There is NO MISSING_ODOMETER issue code — all layer-3 plausibility checks are guarded by `is not None`, so an absent leg raises neither warning nor error. Result: silently under-billed claim with nothing in the review queue. Not cosmetic; a real financial/record defect, just a different failure mode than described.

CORRECTION 2 — "62 tests cover a function that can never block / actively obscure this" is unfair and should be struck. The RULES table is NOT short-circuited in production: validatePhase returns warn findings for discovery/netcare/gems/er24/bonitas, rendered live in the amber half of the banner at :8976-9010 with tap-to-jump (FIELD_ANCHOR/jumpToField). The tests explicitly PIN the never-block contract rather than hiding it — expect(blockers(f)).toHaveLength(0) at test lines 363, 423, 455, 479.

CORRECTION 3 — "ONLY real gate" undercounts, and the gate has a hole the claim missed: (a) a third untested gate exists, the MIN_VITALS motivation prompt at :5692, which the backend deliberately deferred to (digital_prf.py:1169 comment "that is the single gate"); (b) handleSubmit never calls

</details>

---

### Recommended first suite, in order of protection per unit of effort

- **Severity:** high · **Category:** coverage-gap · **Lens:** coverage-and-risk
- **Location:** `frontend/src/test/conditionalFields.test.ts:1`

**Impact.** Five files, roughly one day, converts the form from 0 real checks to guarded on every path that can destroy a patient record or an unpriceable claim — without touching the 10k-line render tree.

**Reproduction.** n/a — this is the proposal.

<details><summary>Evidence</summary>

```
Existing precedent to copy: prfPdfLayout.ts (127 lines extracted from PRFView, 11 tests, real import) and prfResumePhase.ts (51 lines extracted from this very file — DigitalPRFForm.tsx:559 records the extraction: "inferResumePhase (draft-resume phase mapping) lives in utils/prfResumePhase.ts so it can be unit-tested and never returns a hidden phase"). Infrastructure already present: vitest + jsdom + globals (vite.config.ts test block), @testing-library/react 16.3, user-event 14.6, jest-dom in src/test/setup.ts, fake-indexeddb 6.2.
```

</details>

**Recommended fix.** 1) prfSaveContract.ts + test (~35 tests): buildSavePayload (L4940-4956 — assert '' km/timestamps become null, '0' survives, all five sigs always present), classifySaveError (all six branches of L4998-5047), nextSubmitGate (the ordered gates at L5692/5702/5718/5726). Protects the signature-loss and offline-discard regressions. 2) digitalPrfMount.test.tsx (~8 tests) — the FIRST test that actually mounts it: MemoryRouter with :providerSlug/:prfId, crew_token + crew profile seeded in localStorage, vi.mock('axios') returning a fixture PRF, geolocation and SpeechRecognition stubbed. Assert it renders the call-type grid, console.error stays empty, picking DOD collapses the stepper, and typing a 13-digit SA ID fills #prf-field-age. Cheap, and it is the only thing that catches the recurring crash family (missing slate token, wrong runtime type, Fast-Refresh-breaking export). 3) prfPhaseModel.ts + test (~20): unify the four hidden-phase copies and catch the live RHT divergence. 4) prfGates.ts + test (~25): collectLeavePhaseBlockers, allCrewSigned, detectOdometerAnomaly (L5257-5286). 5) prfDictation.ts + prfDerive.ts + tests (~40): pure moves, no code change, protects narrative and DOB. Then delete or rename conditionalFields.test.ts and digitalPrfSecurity.test.ts — leaving them is worse than having nothing.

<details><summary>Independent verification</summary>

Could not refute. Every checkable element of the evidence verified exactly against the code.

VERIFIED EVIDENCE (demonstrated, not asserted — all six numbers exact):
- frontend/src/pages/prfPdfLayout.ts is exactly 127 lines; frontend/src/test/prfPdfLayout.test.ts has exactly 11 it() blocks and a REAL import (from '../pages/prfPdfLayout').
- frontend/src/utils/prfResumePhase.ts is exactly 51 lines; real import { inferResumePhase } from '../utils/prfResumePhase'.
- The quoted extraction comment is verbatim at DigitalPRFForm.tsx:557-559 (claim cited 559, the anchor line of the three-line comment).
- vite.config.ts test block has environment jsdom, globals true, setupFiles ./src/test/setup.ts; setup.ts imports @testing-library/jest-dom; package.json has @testing-library/react 16.3.2, user-event 14.6.1, fake-indexeddb 6.2.5.

INFRASTRUCTURE IS WIRED, NOT MERELY INSTALLED: fake-indexeddb/auto is actually imported at offlineSync.test.ts:19, and @testing-library/react is actually rendering in prfMedicalAidPdfRender.test.tsx and prfPdfFieldMatrix.test.tsx. So "already present" holds in the strong sense — there is a working render precedent, not just a dependency entry.

PREMISE HOLDS AND IS WORSE THAN STATED: conditionalFields.test.ts:28 states its own method — "We simulate the form's fd state machine directly — pure function tests, no DOM." More damningly, digitalPrfSecurity.test.ts re-implements shouldSkipSave DIVERGENTLY from the code it claims to mirror: the test advances lastSavedRef immediately (before any network call), whereas the real doSave advances lastSavedPayloadRef ONLY after a successful PATCH (DigitalPRFForm.tsx:4994, inside try after await api().patch). The real 500-error branch explicitly comments "Do NOT advance lastSavedPayloadRef so the same data is retried." The mirrored test therefore encodes behaviour production deliberately does not have, and passes anyway. This is a live demonstration of the claim's thesis, not a rebuttal.

IMPACT NOT OVERSTATED: not cosmetic-dressed-as-data-loss. The untested surface is the save/submit path, where a real signature-dropping data-loss bug already occurred (doSave coalescing dropped crew/patient signatures captured seconds before submit). Feasibility checks out: normalizeFormData is at line 4210, MODULE SCOPE, outside the component which opens at 4226 — alongside parseSaIdDob (568), ageFromDob (584), vitalsIntervalMs (603), mergeDictation (838), correctDictation (887), overlapLen (947), pickTranscript (970), applyDictation (989), fmtTime (554). All already pure and module-scope, extractable by cut-and-past

</details>

---

### IndexedDB outbox retains full patient PRF payloads forever — End Shift and logout never clear it

- **Severity:** high · **Category:** data-loss · **Lens:** security-and-privacy
- **Location:** `frontend/src/services/offlineDb.ts:175`

**Impact.** The End Shift comment claims POPIA compliance ("don't leave patient data on device") and the crew is shown a dialog promising drafts are deleted — but a parallel, larger copy of the same patient records survives in IndexedDB under `ems-offline`/`outbox`. Any entry that exhausted its 5 retries is 'dead' and is architecturally permanent: there is no crew-facing or admin-facing action anywhere in the app that removes it. On a shared roadside tablet, patient records from every prior crew and every prior shift accumulate indefinitely; on a lost or stolen tablet they are recoverable from browser storage with no authentication at all.

**Reproduction.** 1. Crew A works a PRF with no signal; doSave 401/offline routes through queueToOutbox (DigitalPRFForm.tsx:4958) or handleSubmit's offline branch (5895).
2. Signal never returns for 6 sync passes → syncEngine.ts:65 calls markDead.
3. Crew A taps End Shift. localStorage `prf-draft:*` is cleared; `ems-offline` outbox is untouched.
4. Open devtools → Application → IndexedDB → ems-offline → outbox on the tablet. Full patient record, indefinitely.

<details><summary>Evidence</summary>

```
offlineDb.ts exposes a purge that no application code ever calls:

  export async function clearAll() {
    const db = await initDb();
    await db.clear(STORE);
  }

A repo-wide grep for `clearAll` outside offlineDb.ts returns only `test/offlineSync.test.ts` (and an unrelated local `clearAll` in BodyDiagram.tsx). Meanwhile the End Shift handler in CrewDashboard.tsx:280-293 deliberately purges localStorage but stops there:

    // Clear all local PRF drafts (POPIA: don't leave patient data on device)
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith('prf-draft:')) keysToRemove.push(key);
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch { }
    clearCrewSessionStorage();
    localStorage.removeItem('shift_supervisor');

The outbox payload is the whole record — DigitalPRFForm.tsx:4951 buildSavePayload() returns `{ form_data: { ...fd, vitals_sets, iv_therapy, medications }, ...sigs }`, i.e. patient name, SA ID number, clinical narrative, medications, base64 signatures and base64 document/ID photos. offlineDb.ts:130 markDead is explicitly documented as "NEVER deleted".
```

</details>

**Recommended fix.** End Shift must purge the outbox as deliberately as it purges localStorage — but only after the crew has been shown and acknowledged what is still unsent (dead entries are unsynced patient records; deleting them blindly is the data-loss bug commit b69ea03 fixed). Suggested shape: block End Shift while `getOutboxSummary().dead > 0`, force a manual resend or an explicit "discard N unsent PRFs" confirmation, then call clearAll(). Separately, give successfully-drained-but-abandoned devices a TTL sweep.

<details><summary>Independent verification</summary>

I tried to refute this and could not. Every load-bearing assertion checks out against the code, and two of them are actually understated.

VERIFIED FACTS

1. `clearAll` is dead code. `offlineDb.ts:175-178` is exactly as quoted. A repo-wide grep returns only `test/offlineSync.test.ts:24,58,66` and an unrelated local `const clearAll` in `BodyDiagram.tsx:426` (a body-map reset closure, not this function). No application code calls it.

2. End Shift does not touch IndexedDB. `CrewDashboard.tsx:248-294` (`handleLogout`) is as quoted: POSTs `/api/digital-prf/end-shift`, loops `localStorage` removing `prf-draft:*`, calls `clearCrewSessionStorage()`, removes `shift_supervisor`, navigates away. `clearCrewSession` (`utils/crewSession.ts:100-106`) removes exactly 5 localStorage keys (token, profile, partner, extraCrew, vehicle) — no IndexedDB. A grep for `indexedDB|deleteDB|deleteDatabase|ems-offline` across `frontend/src` hits only `offlineDb.ts:15`. `Login.tsx:47` calls `caches.delete` — that is the service-worker cache, not IndexedDB. Nothing anywhere deletes the store.

3. The payload is the full patient record. `DigitalPRFForm.tsx:4940-4956` `buildSavePayload()` returns `{ form_data: { ...fd, vitals_sets, iv_therapy, medications }, vehicle_id, crew_member_2_id, ...cleanTs, ...cleanKms, ...sigs }`. `fd` carries `patient_id_number` (13-digit SA ID, `:6913`), `debtor_id_number` (`:7180`), names, `medical_aid_number`, clinical narrative and meds. `sigs` (`:4359`) is a record of base64 signature data URLs. `PdfDrop` (`:3546-3548`) explicitly stores attachments "as a base64 data URL inside form_data so it persists with the existing PRF save flow". This exact object is what reaches `queueSave` (`:4958-4964`) and `queueSubmit` (`:5833-5834`, `:5895-5896`).

4. Dead entries are architecturally permanent. `syncEngine.ts:59-72` calls `markDead` after `retries > 5`; `markDead` (`offlineDb.ts:130-137`) only flips status; `getPending` (`:94`) excludes `'dead'`, so auto-retry never revisits them.

WHERE THE CLAIM IS UNDERSTATED

`offlineDb.ts:126` justifies permanent retention because the entry "stays visible in the outbox count for manual resend", and `retryDead` (`:158-168`) exists to serve that manual resend. Neither is wired up. `retryDead`, `getOutboxSummary` and `getCount` have zero call sites outside `offlineSync.test.ts`. `outbox-change` is dispatched in 6 places (`syncEngine.ts:70,149,153`; `DigitalPRFForm.tsx:4962,5835,5897`; `CrewDashboard.tsx:532`) and there is **no `addEventListener('outbox-change')` anywhere in the codebase**. So the crew cannot see the outbox,

</details>

---

### syncEngine re-creates a previous crew's PRF under whoever is logged in now — cross-tenant injection and wrong-practitioner attribution

- **Severity:** high · **Category:** security · **Lens:** security-and-privacy
- **Location:** `frontend/src/services/syncEngine.ts:14`

**Impact.** Provider A's patient record is POSTed into Provider B's tenant as a fresh, valid, server-authorized PRF — the token is genuinely Provider B's, so no server-side isolation check fires. It is then submitted, which spawns a billable Case under the wrong provider containing another provider's patient's name, SA ID and clinical detail. Even in the same-provider case the record is stamped with the wrong vehicle, wrong supervising practitioner and wrong submitting crew, which for a medico-legal document that names who treated the patient is a falsified clinical record.

**Reproduction.** 1. Crew A (Provider A) has a submit entry queued in the outbox (offline at submit time).
2. Crew A taps End Shift → server deletes their draft PRFs → the queued prfId now 404s. Outbox is NOT cleared (see finding 1).
3. Crew B (Provider B, or a different crew of Provider A) logs in on the same shared tablet. A new crew_token, shift_supervisor and active_vehicle are written to localStorage.
4. initSyncListeners' 60s interval or the online/visibilitychange handler fires startSync.
5. The submit entry drains: PATCH → 404 → subErr.response.status === 404 → recreateAndSubmit runs with Crew B's headers, Crew B's supervisor and Crew B's vehicle, carrying Crew A's patient payload.

<details><summary>Evidence</summary>

```
recreateAndSubmit builds a brand-new PRF from ambient localStorage read at drain time, not from the crew who authored the record:

  async function recreateAndSubmit(prfId: string, payload: any, headers: Record<string, string>) {
    const supervisor = JSON.parse(localStorage.getItem('shift_supervisor') || 'null');
    const storedVehicle = JSON.parse(localStorage.getItem('active_vehicle') || 'null');
    const createRes = await axios.post('/api/digital-prf', {
      vehicle_id: payload?.vehicle_id || storedVehicle?.id || null,
      supervising_practitioner_pr: supervisor?.hpcsa_number || null,
      ...
    }, { headers, timeout: 10000 });
    await axios.patch(`/api/digital-prf/${newId}`, payload, ...);
    await axios.post(`/api/digital-prf/${newId}/submit`, ...);
  }

and `headers` comes from whoever holds the device right now (syncEngine.ts:74):

      const token = getCrewToken();
      if (!token) break;
      const headers = { Authorization: `Bearer ${token}` };

The outbox is not scoped to a crew or a provider — OfflineEntry (offlineDb.ts:3-13) carries only `id`, `action`, `payload`, `timestamp`, `retries`, `status`. syncEngine has no equivalent of crewSession.ts's `ensureProviderSession` tenant guard. The 404 that triggers this path is routine, not exotic: End Shift deletes every draft PRF server-side (CrewDashboard.tsx:269 `POST /api/digital-prf/end-shift`).
```

</details>

**Recommended fix.** Stamp each OfflineEntry with the authoring `provider_id` and `crew_member_1_id` at queue time, and refuse to drain any entry whose stamped provider does not match the current crew_profile.provider_id (leave it pending rather than dropping it). Take the vehicle/supervisor from the entry's stored payload only — never re-read `shift_supervisor`/`active_vehicle` from localStorage at drain time, since those belong to whoever is on shift now.

<details><summary>Independent verification</summary>

The code says what the claim says it says, and no guard prevents the core failure. syncEngine.ts:14-36 recreateAndSubmit derives the new PRF's identity entirely from ambient state at drain time: headers from getCrewToken() (line 74), supervisor from localStorage['shift_supervisor'], vehicle fallback from localStorage['active_vehicle']. OfflineEntry (offlineDb.ts:3-13) has no crew/provider field, clearAll() is never called outside tests, and CrewDashboard handleLogout (lines 280-293) clears prf-draft:* and the crew session but deliberately leaves the outbox, so a queued entry survives into the next crew's session. Backend create_prf (digital_prf.py:219-342) stamps provider_id and crew_member_1_id from the caller's token, so the recreated row is attributed to whoever drains it. PRFSaveRequest even guards crew_member_1_id against reassignment (:445-448) — the exact invariant this path bypasses by creating a fresh row.

The claim's "404 is deterministic" refutation-bait actually cuts the claim's way: _load_crew_prf (:189-190) returns 404 for cross-tenant by design ("so the API never confirms the existence of another company's PRF"), so the syncEngine comment at line 11 ("the row truly doesn't exist — this can never duplicate a live PRF") is false. Same-provider foreign crew gets 403, so that sub-case is guarded.

Two supporting statements are wrong and must be corrected. (1) End Shift does NOT delete every draft: end_shift (:876-916) deletes only drafts failing _draft_has_captured_work, i.e. empty ones; the CrewDashboard.tsx:256 confirm text is stale copy. The real 404 sources are narrower: a PRF created online but worked entirely offline (server row still empty) swept by End Shift, or an offline create that went 'dead' — since getPending() excludes 'dead', the blockedPrfIds guard stops applying on the next pass and the submit's 404 reaches recreateAndSubmit. (2) The cross-tenant PHI impact is overstated: the POST succeeds under Provider B's token (create_prf never calls _assert_provider_owns, so Provider A's vehicle_id is written onto a Provider B row), but the PHI-bearing PATCH hits _assert_provider_owns on vehicle_id at :438 and raises 400 before db.commit() at :450. handleNewPRF refuses to create a PRF without a stored vehicle (CrewDashboard.tsx:418), so payload.vehicle_id is non-null in practice. Net cross-tenant effect: up to six empty orphan drafts under Provider B (recreateAndSubmit sends no client_id, so it is not idempotent) consuming Provider B's prf_number sequence, plus Provider A's PRF stranded 'dead'. No patient name or SA ID crosses the tenan

</details>

---

### Patient residential address and incident GPS coordinates are sent to a third-party geocoder in a URL query string

- **Severity:** high · **Category:** security · **Lens:** security-and-privacy
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:1783`

**Impact.** A patient's home address, or the address of a person who has just died, leaves the country to a third-party operator (OSM Foundation, EU) that logs queries and source IPs, tagged with an identifying operator email. The reverse-geocode call transmits zoom-18 coordinates of an active medical emergency. This is a cross-border transfer of special-personal-information-adjacent data with no operator agreement, no consent capture and no record of processing — squarely a POPIA s72/s19 exposure for a product that is otherwise careful (the End Shift handler cites POPIA explicitly). It is also the one place in this page where patient detail is put in a URL rather than a request body, so it lands in the third party's access logs verbatim.

**Reproduction.** 1. Open a PRF, go to Patient Information → Residential Address.
2. Type the patient's real street address. After 400ms of idle, watch the network tab: GET https://nominatim.openstreetmap.org/search?...&q=12+Smith+Street+Durban...
3. Or: Incident Address → "Capture Current GPS Location" → GET .../reverse?...&lat=-29.85&lon=31.02&email=system@jemsmedical.co.za

<details><summary>Evidence</summary>

```
Every debounced keystroke in an address field is shipped to OpenStreetMap as a query parameter (AddrInp.runSearch, line 1783):

    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&countrycodes=za&addressdetails=1&limit=6`;
    fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } })

  const onTextChange = (next: string) => {
    sf(fk, next);
    debounceRef.current = window.setTimeout(() => runSearch(next), 400);
  };

The `manualOnly` variant still runs this — its own comment says so (line 1888): "Manual-only mode (residential addresses): plain inline text field with the type-to-search autocomplete, NO GPS-capture pop-up". Only the GPS button is suppressed, not the search. The fields wired to AddrInp include:

  6921: <AddrInp fk="patient_address" ... manualOnly />        // patient's home address
  7187: <AddrInp fk="debtor_address" ... manualOnly />         // debtor's home address
  3143: <AddrInp fk="med_aid_dec_death_deceased_address" ... /> // deceased patient's home address
  6853: <AddrInp fk="incident_location" ... />                  // where the patient was found
  7155: <AddrInp fk="raf_accident_location" ... />

The reverse path (line 1398) sends the patient's exact incident coordinates plus a hard-coded operator identity:

  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lng}&email=system@jemsmedical.co.za`;

This is not accidental — nginx/security-headers.conf:15 whitelists `https://nominatim.openstreetmap.org` in connect-src, so it is a sanctioned egress that appears never to have been assessed as a personal-information transfer.
```

</details>

**Recommended fix.** Proxy both calls through the backend so patient text and coordinates never leave under the crew device's IP and never appear in a third party's logs — the backend already has app.utils.net_guard for outbound URL safety, and a server-side cache would also fix Nominatim's 1 req/s usage policy that the 400ms debounce currently violates. If the third-party call must stay client-side, disable autocomplete entirely on the patient/debtor/deceased residential-address fields (make `manualOnly` mean what its name says) and keep it only for incident/scene lookup.

<details><summary>Independent verification</summary>

VERDICT: NOT REFUTED. The mechanism is real, code-accurate, reachable in production, and unmitigated. Two peripheral evidence errors do not touch it.

WHAT I VERIFIED IN THE CODE (all absolute paths):

1. C:/Users/USER-PC/Desktop/New EMS AUTOMATIONS/frontend/src/pages/crew/DigitalPRFForm.tsx:1783 — quoted verbatim, exact match. `runSearch` builds `https://nominatim.openstreetmap.org/search?...&q=${encodeURIComponent(q)}...` and fetches it directly from the crew device. `onTextChange` (line ~1801) calls `sf(fk, next)` then `debounceRef.current = window.setTimeout(() => runSearch(next), 400)`. Confirmed.

2. Line 1398 — quoted verbatim, exact match, including the hard-coded `&email=system@jemsmedical.co.za`. `reverseGeocode(lat, lng, signal)` is called from `captureGps` with `navigator.geolocation.getCurrentPosition(..., { enableHighAccuracy: true })`, i.e. the device's precise position at the moment the crew taps "Capture Current GPS Location" — at the scene, for `incident_location`, that is the emergency's coordinates. Confirmed.

3. The `manualOnly` claim is correct and is the load-bearing point. The `manualOnly` branch (line ~1890) renders an `<input onChange={e => onTextChange(e.target.value)} />` plus the shared `suggestionDropdown`. Only the modal and the GPS button are suppressed. The quoted comment is verbatim. So residential addresses DO get shipped to OSM.

WHY THE LISTED REFUTATION GROUNDS DO NOT APPLY:
- Guard/normaliser/try-catch: both fetches have `.catch`, but they handle the response after the request is already on the wire. `encodeURIComponent` is escaping, not privacy. The `q.trim().length < 3` early-return and the `skipNextRef` suppression-after-pick reduce request volume only.
- Unreachable: the opposite. C:/Users/USER-PC/Desktop/New EMS AUTOMATIONS/nginx/security-headers.conf:15 whitelists the host in `connect-src`, and the comment at line 11-14 states removing it means "location capture silently fails in prod". It is deliberately enabled egress.
- Deliberate-design list: this is not on it. The parked `validatePhase`, the non-exported values, `normalizeFormData`, the viewport lock and the 7-phase model are all unrelated.
- Impact overstated / asserted: no. Two independent facts I found make it worse, not cosmetic:
  (a) C:/Users/USER-PC/Desktop/New EMS AUTOMATIONS/backend/app/api/geocode.py ALREADY IS a server-side Nominatim proxy with a proper `User-Agent: EMS-Forms-Claim-Adjudication/1.0`, mounted at `/api/geocode` in main.py:258 — and grep shows NO frontend file calls it. The safer path was built and abandoned; the crew form bypass

</details>

---

## MEDIUM (17)

### GPS captured while offline is never sent to the server — buildSavePayload omits `geos` entirely, and the local copy is deleted at submit

- **Severity:** medium · **Category:** data-loss · **Lens:** data-loss
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:4951`

**Impact.** The GPS trail that backs the billed mileage is missing for exactly the calls made in poor-signal (usually rural, usually longest) areas. backend/app/services/mileage_engine.py:533-541 and geo_utils.py derive mileage segments from geo_locations with `gps_source: prf_geo_locations`; with no geo the claim falls back to hand-typed odometer values with no independent corroboration, and the /mark-time spoofing check (digital_prf.py:956-988) has nothing to compare against.

**Reproduction.** Crew marks On Scene / Depart Scene / At Destination in a dead-signal area. Each /mark-time POST fails, the catch stores coordinates locally, and the crew sees the confirmed location in the UI. Connectivity returns; doSave and the outbox both send payloads with no geo field. On submit, clearLocalDraft() deletes the draft. `digital_prfs.geo_locations` for those legs is empty forever.

<details><summary>Evidence</summary>

```
`geos` is loaded from the server (4607 `setGeos(prf.geo_locations || {})`) and saved to the draft (4499), but is absent from the save payload:

    return {
      form_data: { ...fd, vitals_sets: vitals, iv_therapy: ivRows, medications: medRows },
      vehicle_id: vehicle || null, crew_member_2_id: crew2Id || null,
      ...cleanTs, ...cleanKms, ...sigs,
    };

Geo reaches the server ONLY via POST /mark-time. When that call fails, commitMarkTime keeps the coordinates in React state alone (5123-5137):

    } catch {
      // Offline / network error — still record locally so the crew isn't blocked.
      setTs(p => ({ ...p, [timeKey]: new Date().toISOString() }));
      if (coords) {
        setGeos(p => ({ ...p, [timeKey]: { lat: coords.latitude, lng: coords.longitude, accuracy_m: coords.accuracy, captured_at: new Date().toISOString() } }));
      }
    }

Nothing ever replays it: no outbox action carries geo (services/offlineDb.ts has only create/save/submit, all fed by buildSavePayload), and clearLocalDraft() at 5815/5818/5823/5870 removes the only remaining copy on submit.

Relatedly, the autosave effect's dependency list omits `geos` (4734): `[fd, vitals, ivRows, medRows, timestamps, kms, sigs, vehicle, crew2Id, prfId]` — a geo-only change would not even reach localStorage.
```

</details>

**Recommended fix.** Include `geo_locations: geos` in buildSavePayload and accept it on the PATCH with a merge (same shape the mark-time handler already builds). Add `geos` to the autosave effect's dependency array.

<details><summary>Independent verification</summary>

CONFIRMED — the data-loss mechanism is real and every link was verified in source, not asserted.

VERIFIED CHAIN:
1. `geos` is standalone React state (DigitalPRFForm.tsx:4358), NOT part of `fd`. Written to the local draft (4499), rehydrated from local (4521) and server (4607).
2. `buildSavePayload` (4940-4956) is verbatim as quoted — no `geos`. Stronger than the claim states: the backend `PRFSaveRequest` model (backend/app/api/digital_prf.py:63-101) has NO geo/latitude/longitude field either, so adding geos to the payload would be silently dropped. The sole geo write path in the whole backend is `POST /{prf_id}/mark-time` (digital_prf.py:919) via `PRFMarkTimestamp` (lat/lng/accuracy_m).
3. `commitMarkTime`'s catch (5122-5137) is verbatim — offline coords live only in React state and localStorage.
4. No replay path exists. `offlineDb.ts:5` declares `action: 'create' | 'save' | 'submit'`; queueCreate/queueSave/queueSubmit (48/61/74) are all fed `buildSavePayload`. `syncEngine.ts` handles only those three actions (83/92/102), and its `addEventListener('online')` (165) drains the outbox and nothing more. `clearLocalDraft()` on submit then removes the last copy.
5. Downstream consumer confirmed: `mileage_engine.py:539-541` reads `data.get("geo_locations")` via `geo_utils.geo_segments_from_prf`, which stamps `gps_source: "prf_geo_locations"` (geo_utils.py:204); the digital-PRF→extracted_data adapter (digital_prf.py:1443) supplies it.

WHERE THE CLAIM IS WRONG (corrections, none of which rescue it):
a) Billing impact is OVERSTATED. mileage_engine.py:536-537 states the priority explicitly — odometer is ground truth; GPS only fills segments that are already `None` (`if segs.callout_km is None and gps[...] is not None`), each fill emitting a `GPS_FALLBACK_*` warning and setting `bill._gps_fallback = True`. GPS never cross-checks a *present* odometer value, so "hand-typed odometer values with no independent corroboration" describes a check the engine does not perform. The billing consequence only materialises when the odometer is ALSO missing/invalid.
b) The autosave dep-list sub-claim is UNREACHABLE. Both `setGeos` sites (5122 online, 5127 offline) sit in the same synchronous block as a `setTs` that always constructs a fresh object; React 18 batches them into one render, so the effect fires on the `timestamps` reference change with a `saveToLocal` closure already holding the new `geos`. No geo-only mutation path exists. Latent hazard, not an active bug.
c) Reach is WIDER than claimed. For an offline-created PRF (commit b69ea03) the device-minted UUID does not exis

</details>

---

### Two tabs on the same device share one draft key with no cross-tab coordination, so each silently overwrites the other's draft and PATCHes its own whole blob

- **Severity:** medium · **Category:** data-loss · **Lens:** data-loss
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:4493`

**Impact.** Whole sections of a patient record disappear with no error, and the crew's instinct — reload the page — is what makes the loss permanent, because the stale draft outranks the server copy.

**Reproduction.** The 404 self-heal comment at 5842 confirms multi-tab is real in the field ('an End Shift in another tab swept drafts while this tab still holds the full form'). Open the same PRF in two tabs of the crew PWA. Tab A captures vitals; its 400 ms debounce writes the draft. Tab B, which never saw those vitals, types a patient detail and its debounce writes a draft without them. The stored draft now has no vitals. Reload either tab: loadFromLocal restores the vitals-less draft and the 4593 guard blocks server hydration, so the vitals are gone from the UI, and the next doSave deletes them server-side too.

<details><summary>Evidence</summary>

```
The draft key is derived only from the PRF id — nothing identifies the tab:

  const LOCAL_DRAFT_KEY = `prf-draft:${prfId}`;

Each mount writes the full snapshot unconditionally (4495-4505) and reads it back wholesale (4507-4527). There is no `storage` event listener anywhere in frontend/src (grep for `addEventListener('storage'` returns nothing), so a tab never learns its draft was replaced, and no BroadcastChannel/lock is taken. Each tab additionally runs its own 5-minute doSave (4755-4764) and visibilitychange doSave (4740-4749), each sending its own complete form_data, which the backend replaces wholesale (backend/app/api/digital_prf.py:397).
```

</details>

**Recommended fix.** Namespace the draft per tab (sessionStorage, or a tab id in the key) and reconcile on load; or take a Web Lock / BroadcastChannel leader election so only one tab owns the draft and the server saves for a given PRF. At minimum, listen for `storage` on the draft key and warn when another tab has taken over.

<details><summary>Independent verification</summary>

The mechanism holds up under direct reading, but the write-up omits a real defence layer and overstates the impact. Details, with corrections.

VERIFIED — the code says what the claim says it says.
- `frontend/src/pages/crew/DigitalPRFForm.tsx:4493` — `const LOCAL_DRAFT_KEY = `prf-draft:${prfId}`;`. Keyed on the PRF id only; nothing identifies a tab.
- `saveToLocal` (4495-4506) writes the entire snapshot (`fd, vitals, ivRows, medRows, timestamps, kms, sigs, geos, vehicle, crew2Id, phase`) with `localStorage.setItem` — an unconditional whole-blob replace, no read-merge, no compare of the `savedAt` it writes.
- `savedAt` is written in two places (DigitalPRFForm.tsx:4501, CrewDashboard.tsx:529) and **read nowhere** in `frontend/src`. So even the one field that could arbitrate staleness is dead.
- `loadFromLocal` (4507-4527) reads it back wholesale into ten `setX` calls.
- Cross-tab coordination is genuinely absent, all four primitives: `addEventListener('storage'`, `BroadcastChannel`, `navigator.locks`, and `sessionStorage` each return **zero** hits across `frontend/src`. The claim's grep is accurate and I confirmed the superset.
- The two server-backup triggers are as described: visibilitychange (4740-4749) and a 5-minute `setInterval` (4755-4764), both calling `doSaveRef.current()`, and `buildSavePayload` (4941) always emits the complete `form_data`.
- The load-order claim is correct: `DigitalPRFForm.tsx:4593` — `if (!localStorage.getItem(`prf-draft:${prfId}`))` guards the entire server-hydration block, so on reload a stale local draft outranks the server copy and the tab then PATCHes that stale blob back up.

CORRECTION 1 — the claim's evidence is materially incomplete. It says the backend "replaces wholesale (digital_prf.py:397)" as if there were no concurrency control. There is one: `backend/app/api/digital_prf.py:370-383` implements optimistic concurrency — the client echoes `client_base_updated_at` (set at DigitalPRFForm.tsx:4987, seeded at 4588) and a save built on a view more than 1s stale is rejected with 409. The claim should have engaged with this. Saves are also serialised in-tab (`savingInFlightRef`) and deduped (`lastSavedPayloadRef`).

CORRECTION 2 — but the OCC does not rescue it, which is why I am not refuting. The 409 handler (4018-5028) refetches **only the version token**, never the form data:
    const fresh = await api().get(`/api/digital-prf/${prfId}`);
    baseUpdatedAtRef.current = fresh?.data?.updated_at || null;
    lastSavedPayloadRef.current = null;
    savePendingRef.current = true;
…then retries the same stale blob against th

</details>

---

### TreatingPicker is declared inside a render-time IIFE and mounted as `<TreatingPicker />` — every parent re-render remounts it and discards the crew's multi-select

- **Severity:** medium · **Category:** state-bug · **Lens:** crash-and-state
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:10057`

**Impact.** The treating-practitioner gate is the input to HPCSA scope enforcement. Silently dropping a multi-crew selection means the recorded treating practitioner is wrong or missing on a record that later drives per-action scope checks and billing — and the crew has no signal that their taps were discarded.

**Reproduction.** Enter the Clinical phase on a call with 3+ crew (Crew 1, Crew 2, extra_crew). The gate auto-opens (effect at 4711). Tap two crew members, then wait for any parent state change — the periodic save, or the 700ms debouncedVitals settle after a vitals edit. The tiles clear and the confirm button reverts to "Select a crew member".

<details><summary>Evidence</summary>

```
The component is created fresh on each render of DigitalPRFForm:
```
9851:        {crewPicker && crewPicker.phase === 'select' && (() => {
…
9898:          const TreatingPicker = () => {
9899:            const getPreSelected = () => { … };
9907:            const [selected, setSelected] = useState<Set<string>>(getPreSelected);
…
10057:          if (isTreating) return <TreatingPicker />;
```
Because the function identity changes on every parent render, React treats it as a different element type, unmounts the old tree and mounts a new one — `selected` is re-initialised from `getPreSelected()`, which reads `fd.treating_practitioners_json` / `fd.treating_practitioner_name`. Neither is written until `confirm()` runs (9919), so an in-progress selection resets to empty. The parent re-renders on its own while the overlay is open: the debounced-vitals timer (5928), the 600ms live-validation effect (5507), the 5-minute backup's `setSaving`/`setSaveState`, and the scroll handler's `setIsScrolled` (4289).

Contrast the sibling sections, which are deliberately *invoked as functions* to avoid exactly this — `{VitalsSection({ showFull: true })}` (8249), `{TimeRow({ row: r })}` (6126).
```

</details>

**Recommended fix.** Hoist TreatingPicker to module scope (or wrap in useCallback/useMemo-stable identity) and pass `opts`, `fd`, `sf`, `setCrewPicker` as props — or, matching the local convention, invoke it as a plain function and lift `selected` into the parent's state.

<details><summary>Independent verification</summary>

CONFIRMED (with two evidence corrections and a modest impact correction).

CODE SAYS WHAT THE CLAIM SAYS. frontend/src/pages/crew/DigitalPRFForm.tsx:9851 opens a render-time IIFE `{crewPicker && crewPicker.phase === 'select' && (() => {`. Inside it, 9898 declares `const TreatingPicker = () => {`, 9907 holds the only copy of the multi-select in `const [selected, setSelected] = useState<Set<string>>(getPreSelected)`, and 10057 mounts it as `if (isTreating) return <TreatingPicker />;`. Function identity changes on every parent render, so element.type differs, so React unmounts and remounts the subtree and re-seeds `selected` from `getPreSelected()` (9899-9906), which reads `fd.treating_practitioners_json` / `fd.treating_practitioner_name`. Those are written only inside `confirm()` (9919-9925). No key, no memo, no ref mirror, no other holder of the in-progress set. The sibling contrast is accurate AND is the house convention: `{TimeRow({ row: r })}` (6126, 6681, 6693) and `{VitalsSection({ showFull: true })}` (8100, 8249) are deliberately invoked as functions; TreatingPicker is the single inline-declared component in the file mounted as an element — and it had to be, since it needs useState, which invoke-as-function would place conditionally in the parent's hook order. So this is an outlier defect, not the deliberate pattern.

NO GUARD PREVENTS IT. No React.memo, no key prop, no scroll lock, no persistence of `selected` outside the child.

TWO EVIDENCE POINTS IN THE CLAIM ARE WRONG (they do not save it, but the claimant overstated the trigger set):
1. The 600ms live-validation effect (5507, deps [fd, vitals, ivRows, medRows, sigs, timestamps, kms, phase]) and the 700ms debounced-vitals effect (5927-5930, deps [vitals]) are keyed to inputs the crew CANNOT change while the modal overlay is up. They fire at most once, only if already scheduled when the overlay opened. They are not a repeating source during selection. The validation effect additionally bails out (`unchanged ? prev : next`) when findings are identical.
2. Phase advance is `await doSave(); setPhase(target);` (5640-5641), so the phase-change server save fully settles BEFORE the overlay opens. The claim implies otherwise.

TRIGGERS THAT DO SURVIVE, all input-independent and live while the overlay is open:
- visibilitychange handler (4740-4747) calls doSaveRef.current(); doSave sets setSaving(true)/setSaveState('saving') (4990-4991) then setLastSaved/setSaveState('saved')/setSaving(false) (4996-5050). These are real useState setters (4317-4320, values intentionally unused) so each distinct value is a

</details>

---

### Call-type-specific billing fields are never cleared on a call-type switch and become invisible while still being submitted

- **Severity:** medium · **Category:** data-loss · **Lens:** clinical-correctness
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:2731`

**Impact.** Claims go out carrying a pre-auth number and a quoted payout for a transfer that did not happen, or a resus fee flag on a routine primary call. The DOD flag was explicitly hardened against exactly this leak (see the comment at 2738-2740) while its siblings were not. The crew has no way to see or correct any of it — the pre-submit summary shows `transfer_subtype` and `preauth_number` as though they were deliberate.

**Reproduction.** a) Start as IFT/IHT: pick a transfer subtype, enter a quoted payout of R4 500 and a pre-auth number. Realise it is actually a primary call and switch the pill to PRIMARY. All three fields unmount; `fd.transfer_subtype`, `fd.med_aid_quoted_amount`, `fd.preauth_number` are still in the payload at 4952 and still listed in the summary card (9290-9292 reads them unconditionally).
b) Pick RESUS (sets `med_aid_resus: true`), then switch to PRIMARY. `MedAidMore`'s body is gated on `isOpen = fd.call_type === 'DOD' || fd.call_type === 'RESUS'` (3374), so the resus billing line flag is set on a PRIMARY call with no UI anywhere that shows or clears it.
c) Pick MED AID, then switch the call type to WCA_IOD: line 2748 overwrites `billing_type` to 'WCA / IOD' with no prompt.
d) Pick RAF, then switch to DOD: RAF is filtered out of `billingOpts` but `selected` stays 'RAF' and the RAF panel (7144) still renders — the picker's own rule is not enforced on the stored value.

<details><summary>Evidence</summary>

```
`pick()` resets exactly one flag and overwrites one other; everything else is left behind (2731-2749):

  const pick = (o: string) => {
    sf('call_type', o);
    // ... only DOD turns the flag on, every other pick clears it. This prevents the DoD
    // form from leaking into MED AID billing for IFT/IHT/RHT/PRIMARY/etc calls ...
    sf('med_aid_dec_death', o === 'DOD');
    if (o === 'RESUS') { sf('med_aid_resus', true); }        // set, but NEVER cleared anywhere
    if (o === 'WCA_IOD') { sf('billing_type', 'WCA / IOD'); } // overwrites an explicit crew choice

The fields that go invisible are all `FadeIn`-gated, and FadeIn unmounts (3900): `if (!show && !visible) return null;`

  <FadeIn show={fd.call_type === 'IHT'}> ... <TransferSubtypeCards /> </FadeIn>                       // 6614 transfer_subtype
  <FadeIn show={fd.call_type === 'IHT' && !!fd.transfer_subtype}> ... med_aid_quoted_amount </FadeIn> // 6621
  <FadeIn show={['IHT','IFT'].includes(fd.call_type) && ... && preauthVisible}> preauth_number       // 6638
  <FadeIn show={fd.call_type === 'RHT'}> ... rht_call_out_fee </FadeIn>                               // 6648
  {fd.billing_type === 'PVT' && (...)} / {fd.billing_type !== 'PVT' && (<>Debtor + MED AID card</>)}  // 6944 / 7027

The billing picker also narrows its option list without touching an already-invalid stored value (2895-2900):

  const billingOpts = fd.call_type === 'DOD' ? baseOpts.filter(o => o !== 'RAF')
    : fd.call_type === 'RESUS' ? baseOpts.filter(o => o === 'MED AID' || o === 'PVT') : baseOpts;
```

</details>

**Recommended fix.** In `pick()`, clear the fields that belong only to the outgoing call type (transfer_subtype, med_aid_quoted_amount, preauth_number, rht_call_out_fee, med_aid_resus + its level/fee), ideally behind a one-line confirm when any of them is non-empty. Reset `billing_type` to '' when the new call type's `billingOpts` no longer contains the current value, and don't overwrite an explicit billing choice on WCA_IOD without asking.

<details><summary>Independent verification</summary>

NOT REFUTED. The core defect is real and I confirmed it end-to-end in the actual code, not by assertion. Two sub-claims are overstated and one is weak; details below so the parent can right-size it.

VERIFIED AS STATED

1. pick() — DigitalPRFForm.tsx:2732-2748. Quoted code is verbatim. `sf('med_aid_dec_death', o === 'DOD')` is the only reset. `if (o === 'RESUS') sf('med_aid_resus', true)` sets and is never cleared anywhere (I grepped every `med_aid_resus` write in the file: 2743 and 3390's manual toggle are the only ones). `if (o === 'WCA_IOD') sf('billing_type', 'WCA / IOD')` overwrites.

2. FadeIn genuinely unmounts — 3900: `if (!show && !visible) return null;`. Gates at 6614/6621/6638/6648 key on `fd.call_type` exactly as quoted.

3. Nothing clears these on switch. No useEffect does it — the only call_type effects are the hidden-phase skip (4336-4352) and the preauth-visibility effect (4468-4477), which only ever sets `preauthVisible` true, never false. `normalizeFormData` (4211) coerces types only. The save payload is wholesale: 4952 `form_data: { ...fd, ... }` — no visibility filter, no call_type filter.

4. billingOpts narrowing at 2895-2900 is verbatim and does not touch a stored invalid value.

IMPACT — CONFIRMED FOR THE TWO THAT MATTER

preauth_number: reaches the claim. backend/app/api/digital_prf.py:1096 maps `fd.get("preauth_number")` with no call_type gate; claims_pipeline.py:52 and :215 set `case.preauth_number` from it; adjudication_engine.py:231-282 then emits `Pre-auth: {preauth} ✓` and authorization.py:317-320 excludes cases with a non-null preauth_number from the needs-authorisation queue. So an abandoned IHT's auth number silently satisfies the pre-auth check on a PRIMARY. Not cosmetic.

med_aid_resus: the cleanest instance, and the claim under-sells it. MedAidMore's whole body is gated `const isOpen = fd.call_type === 'DOD' || fd.call_type === 'RESUS'` (3374), so after RESUS→PRIMARY it renders nothing; the flag is also absent from the pre-submit summary (9289-9293 lists only call_type/transfer_subtype/preauth_number/quoted/rht fee). Yet PRFView.tsx:2129 prints a `Resus / Level / Fee (R)` block gated solely on `fd.med_aid_resus`, no call_type check. A resus level and rand fee print on the medical-legal PDF of a routine primary call, invisible to the crew in both the form and the review.
(Aside: MedAidMore at 7044 is rendered only when call_type is NOT RESUS/DOD, while its own isOpen requires RESUS/DOD — that mount is dead in every case.)

transfer_subtype (PRFView:1664) and rht_call_out_fee (PRFView:1646) also print ungated.

WHERE TH

</details>

---

### The pre-submit summary's Billing card reads five field keys the form never writes — scheme, membership number and dependant code are invisible in the crew's final review

- **Severity:** medium · **Category:** coverage-gap · **Lens:** clinical-correctness
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:9278`

**Impact.** The summary modal exists so "crew can spot typos or missing info" (comment at 4328) on the last screen before the record locks. For medical-aid claims — the ones where a wrong membership number or dependant code means a rejected claim — the three fields most likely to contain a typo are the three the review cannot display. A mistyped membership number sails through the one control designed to catch it.

**Reproduction.** Complete a MED AID claim and tap Submit. The summary review modal opens (5715-5722). Its Billing section lists 'Billing Type: MED AID' and 'Plan / Option', and — because `v()` returns null for absent keys and the list is `.filter(Boolean)`-ed — omits the medical scheme, the membership number, the dependant code and the main member name entirely. Tapping 'Looks Good' proceeds to crew sign-off and then to `/submit`, after which the PRF is permanently uneditable (the 423 branch at 5006).

<details><summary>Evidence</summary>

```
Summary card (9276-9285):

  const billing = [
    v('billing_type', 'Billing Type'),
    v('scheme_name', 'Medical Aid Scheme'), v('scheme_option', 'Plan / Option'),
    v('med_aid_number', 'Med Aid Number'), v('main_member_name', 'Main Member'),
    v('main_member_id', 'Main Member ID'), v('main_member_surname', 'Main Member Surname'),
    v('dependant_code', 'Dependant Code'), ...
  ].filter(Boolean)

The actual inputs use different keys (7036-7042):

  <Inp/ComboInp fk="medical_scheme" ... />        // not scheme_name
  <Inp fk="medical_aid_number" ... />             // not med_aid_number
  <DepCodePicker />  -> sf('dependent_number', o) // not dappant_code/dependant_code (2611, 2618)
  <Inp fk="main_member_id" ... />                 // the only one that matches

The warning list in the same modal proves the real keys (9243-9248): `missing(fd.medical_scheme)`, `missing(fd.medical_aid_number)`, `missing(fd.dependent_number)`, `missing(fd.scheme_option)`. A repo-wide grep for `scheme_name`, `med_aid_number`, `dependant_code`, `main_member_name`, `main_member_surname` in this file returns only these summary lines — they are never written by any control.
```

</details>

**Recommended fix.** Change the summary keys to `medical_scheme`, `medical_aid_number`, `dependent_number` and drop `main_member_name`/`main_member_surname` (no such inputs exist), or add a dev-time assertion that every key passed to `v()` is one the form actually writes.

<details><summary>Independent verification</summary>

The claim survives adversarial checking on every load-bearing point.

CODE SAYS WHAT THE CLAIM SAYS. frontend/src/pages/crew/DigitalPRFForm.tsx:9184 defines the summary helper as a direct read: `const v = (key: string, label?: string) => { const val = fd[key]; if (val === undefined || val === null || val === '') return null; ... }`. There is no alias map, no fallback chain, no fuzzy lookup. Lines 9276-9285 read exactly as quoted in the evidence. The billing controls at 7036-7042 write `medical_scheme` (ComboInp), `medical_aid_number` (Inp), `main_member_id` (Inp); DepCodePicker writes `dependent_number` (2611, 2618); SchemeOptionField (2108-2118) writes `scheme_option`. So of the twelve keys on the Billing card, `scheme_name`, `med_aid_number`, `main_member_name`, `main_member_surname` and `dependant_code` are read but never written -- five, as claimed.

NO GUARD OR NORMALISER RESCUES IT. normalizeFormData (4210-4224) only coerces runtime types over PRF_TEXT_FIELDS/PRF_ARRAY_FIELDS; it never renames a key. The backend stores the PRF as an opaque JSON `form_data` column (backend/app/models/digital_prf.py:73), so no server-side aliasing populates the alternate names on load. The `medical_scheme_name`/`dependant_code` columns that do exist live on the Case/authorization models -- a different, admin-side entity, not `fd`. A file-wide grep confirms the five names appear ONLY at 9278-9281, plus line 1076, which is `excludedKeyPatterns`, a voice-dictation mic-suppression regex that tests field keys and writes nothing. (The evidence's "returns only these summary lines" is imprecise by that one line, but the substance -- never written by any control -- is confirmed.)

PATH IS REACHABLE AND MANDATORY. handleSubmit at 5718 does `if (!summaryReviewOpen && !allCrewSigned()) { setSummaryReviewOpen(true); return; }` -- the modal is a forced gate ahead of crew sign-off and the /submit lock, not an optional screen. The card assembly is an explicit whitelist (card1Sections, 9264-9285, rendered at 9365); there is no catch-all that dumps remaining fd keys, so unlisted data has no second chance to appear.

IMPACT IS NOT OVERSTATED, though it needs two calibrations that the claim itself does not get wrong. (1) Two of the five dead keys, `main_member_name` and `main_member_surname`, are fields the form never captures anywhere -- they are dead labels, not hidden data, so no information is lost for those. The genuine review blind spot is three fields: medical scheme, membership number, dependent code. (2) The missing-info gate in the same modal (9243-9248) uses the CORRECT keys,

</details>

---

### Journey timestamps are stamped when the crew confirms the GPS overlay, not when they tapped Mark Time — and cancelling the overlay records nothing

- **Severity:** medium · **Category:** clinical-correctness · **Lens:** clinical-correctness
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:5120`

**Impact.** Every leg of the journey is recorded systematically late by a variable amount driven by GPS quality, and the error is not uniform — a good fix in an open street adds a few seconds, a fix inside a hospital basement adds the full 12s timeout plus the crew's reaction. Response intervals and on-scene times are both clinical audit metrics and, for transfers, billing inputs. Separately, a crew who taps Cancel (or whose phone rings over the overlay) loses the mark silently and must re-mark later, at an even more wrong time.

**Reproduction.** Tap 'Mark Time' / 'Confirm Arrival' on arrival at scene. The overlay shows 'capturing' for up to 12s (line 5224) while the GPS fixes, then runs a Nominatim reverse-geocode over the mobile network, then waits for the crew to read the address and tap Confirm. On a poor fix the sequence routinely takes 15-40s; if the crew is mid-handover it can be minutes. Whatever that total is, it is added to the recorded on-scene time. The same overlay sits in front of `time_dispatched`, `time_depart_scene`, `time_at_destination` and `time_available` (10232, 10295, 10363, 10429).

<details><summary>Evidence</summary>

```
`markTime` only opens an overlay and starts a GPS fix — it captures no time (5156-5225):

  const markTime = useCallback((timeKey, kmKey, onAfterCommit?) => {
    const baseline: PendingMark = { timeKey, kmKey, coords: null, error: null, capturing: true, ... };
    setPendingMark(baseline);
    navigator.geolocation.getCurrentPosition(..., { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  }, []);

The timestamp is minted only once the crew taps Confirm (9718 → 5108-5125):

  await commitMarkTime(timeKey, kmKey, coords);
  ...
  const r = await api().post(`/api/digital-prf/${prfId}/mark-time`, payload);
  setTs(p => ({ ...p, [timeKey]: r.data.timestamp }));      // server now(), at confirm time
  } catch {
    setTs(p => ({ ...p, [timeKey]: new Date().toISOString() }));  // device now(), at confirm time

And Cancel discards the mark entirely (9690): `onCancel={() => setPendingMark(null)}` — no timestamp, no state, no trace.
```

</details>

**Recommended fix.** Capture `Date.now()` (or request the server timestamp) inside `markTime` at the moment of the tap, carry it on `PendingMark`, and send it as the intended timestamp in the `/mark-time` payload — let GPS confirmation attach coordinates to an already-fixed time rather than gate it. On Cancel, either commit the tap-time without coords or tell the crew nothing was recorded.

<details><summary>Independent verification</summary>

The code says what the claim says it says, and the mechanism is real on every journey leg.

VERIFIED IN CODE:
1. frontend/src/pages/crew/DigitalPRFForm.tsx:5156-5226 — the `baseline: PendingMark` built by `markTime` contains timeKey, kmKey, coords, error, capturing, address, geocoding, geocodeError, onAfterCommit. There is NO time field of any kind: no Date.now(), no performance.now() monotonic anchor. markTime only opens the overlay and calls getCurrentPosition with {enableHighAccuracy:true, timeout:12000, maximumAge:0}.
2. commitMarkTime (5108-5139) posts `{ field, km, latitude, longitude, accuracy_m }` — no timestamp. Success path takes r.data.timestamp; catch path uses `new Date().toISOString()`. Both are evaluated at confirm time.
3. backend/app/api/digital_prf.py:103-109 — PRFMarkTimestamp has no timestamp field, so a client time could not be sent even if captured. Line 941-942: `now = datetime.now(timezone.utc); setattr(prf, body.field, now)`. Notably the endpoint's own docstring (line 926) reads "Crew taps a button → system captures exact time" — the stated contract, which the frontend does not honour.
4. Cancel at 9690 is exactly `() => setPendingMark(null)`; on the phase-advance path (5623-5640) onAfterCommit never fires, so the phase also does not advance.
5. No guard, normaliser or try/catch mitigates the delay. Nothing is deliberate here: no comment defends confirm-time stamping, and it is not on the deliberate-design list. The path is the only path — every Mark Time button (6091), every row cell (6042, 6099), the auto-advance hook (5635) and all four leg prompts (10232, 10295, 10363, 10429) funnel through markTime.

THE CLAIM ACTUALLY UNDERSTATES TWO THINGS:
- GeoConfirmOverlay canConfirm (3751-3752) = `!capturing && !geocoding && (!hasTargetField || targetFieldOccupied || addressReady || manualReady)`. For the two GEO_TARGET_FIELD entries (490-493: time_on_scene → incident_location, time_at_destination → receiving_facility) the timestamp CANNOT be committed until the Nominatim reverse-geocode returns (reverseGeocode 1395-1417 has no fetch timeout) or, on failure, until the crew hand-types the address. So the single most audited interval — arrival on scene — can be gated behind a third-party network round trip or manual address entry at the moment of arrival. Offline (now supported per b69ea03) the geocode always fails, so arrival time is gated behind typing the incident address.
- On the odometer legs (10229-10236, 10292-10299) markTime only fires after the crew types the odometer in a modal and taps Confirm, so tap→stamp includes modal + 

</details>

---

### Manual time correction has no date component and no ordering check — a midnight-crossing edit lands ~24 hours out

- **Severity:** medium · **Category:** clinical-correctness · **Lens:** clinical-correctness
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:6069`

**Impact.** A negative or ~24h response interval on the record, on the one field crews are most likely to hand-correct (the auto-mark being late is precisely what prompts the correction). Nothing surfaces it: `validatePhase` is deliberately short-circuited, the odometer plausibility check (5257) covers km only, and the summary card prints the raw ISO string (9294).

**Reproduction.** Night shift. Dispatch is auto-marked at 23:52 on the 7th; the crew later notices it should have read 23:35 and corrects it — fine. Now the inverse, which is the common one: the crew is dispatched at 23:52 but the mark is only confirmed at 00:04 on the 8th (see the confirm-time finding), so the stored ISO date is the 8th. Correcting the displayed time back to '23:52' sets 23:52 **on the 8th** — 23h48m in the future, after every other leg on the call. `time_dispatched` now sits after `time_on_scene`, giving a negative response interval, and `lastVitalAt`'s anchor (8683) is thrown out by a day.

<details><summary>Evidence</summary>

```
onChange={e => {
  const v = e.target.value;
  if (!v) return;
  const [hh, mm] = v.split(':').map(s => parseInt(s, 10));
  if (Number.isNaN(hh) || Number.isNaN(mm)) return;
  const prevIso = timestamps[row.timeKey];
  const d = prevIso ? new Date(prevIso) : new Date();
  d.setHours(hh, mm, 0, 0);                                  // date part is whatever was already stored
  setTs(p => ({ ...p, [row.timeKey]: d.toISOString() }));
}}

The control is `<input type="time">` — hours and minutes only. Nothing compares the result against the adjacent legs. Contrast the vitals code, which does handle the rollover (8688-8692): `if (d.getTime() < anchor.getTime() - 12*60*60*1000) { d.setDate(d.getDate() + 1); }`.
```

</details>

**Recommended fix.** When the edited HH:mm implies a jump of more than ~12h relative to the neighbouring captured legs, roll the date by ±1 day the way `lastVitalAt` already does. A passive confirm prompt — same pattern as the existing `kmConfirm` dialog at 9731, which is explicitly designed not to block — would cover the residual cases without violating the no-mid-call-validation rule.

<details><summary>Independent verification</summary>

MECHANISM: CONFIRMED. The evidence quote is verbatim (DigitalPRFForm.tsx:6066-6089). The control is `<input type="time">`, value from `fmtTime` (line 554-558, local getHours/getMinutes, HH:mm only). `d.setHours(hh, mm, 0, 0)` on a Date built from the previously stored ISO keeps whatever calendar day was already there. Grep for `setDate` across the whole 10,862-line file returns exactly two hits — lines 8691, inside the `lastVitalAt` memo. So the contrast the claim draws is accurate: the author handled midnight rollover for vitals and not here. No ordering check exists client-side, and the backend PATCH (backend/app/api/digital_prf.py:405-411) just parses and assigns each `time_*` field with no ordering or plausibility validation. Reachable on all five editable legs (ALL_TIME_ROWS, line 475-484) the moment a time is marked. Not on the deliberate-design list. So the code says what the claim says it says.

BUT THE CLAIMED IMPACT IS LARGELY REFUTED BY THE DOWNSTREAM CODE:

1. "A negative or ~24h response interval on the record" — no interval is stored on the record, and the two paths that compute one are both date-agnostic or clamped:
   - Submit → billing: `_adapt_prf_to_extracted_data` (digital_prf.py:1083-1131) converts leg timestamps to HH:mm-only strings (`_as_hhmm`) and emits NO `time_*` ISO keys at all. The mileage engine parses those strings onto 1970-01-01 (mileage_engine.py:210-211) and `_minutes_between` (217-225) explicitly adds a day on a negative delta: "Midnight rollover (e.g. scene at 23:55, departure at 00:12)". Scene time in the billing/adjudication path is therefore computed purely from HH:mm and is completely immune to a wrong date component. tariff_engine.py:830-845 `_parse_ts("time_dispatched")` never sees a value from a digital PRF (the adapter doesn't emit those keys), so it returns None — and the tariff engine is disabled in both envs anyway.
   - `_build_partial_context` (digital_prf.py:598-613) is the only place full datetimes are differenced. Both computations are wrapped in `max(0.0, ...)`, so the negative direction yields 0, never a negative number. The +24h direction yields ~1440 min, which trips the scene-time caps (gems.py:543, netcare.py:225, discovery.py:397) — a spurious flag surfaced to an admin, i.e. a false positive, not a silent wrong figure.

2. "the summary card prints the raw ISO string (9294)" — true (also 9301), so the crew's own review surface does show the wrong date, though as an unreadable UTC ISO string. Weak as either a guard or a harm.

3. The printed medical-legal document is unaffected. PRFView renders ev

</details>

---

### Two signature blocks have no signatory name, and the patient signature column carries opposite meanings on different call types

- **Severity:** medium · **Category:** clinical-correctness · **Lens:** clinical-correctness
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:8572`

**Impact.** An unattributed signature on a financial-responsibility and data-disclosure consent is not enforceable and cannot be audited — nobody can say who signed. The indemnity clause names the provider and authorises disclosure to the RAF, the Compensation Commissioner and collection agencies (8546-8547), which is exactly the kind of consent that needs a named signatory. The shared `patient_signature` column means downstream consumers cannot distinguish a consent from a refusal without also inspecting `call_type`.

**Reproduction.** Sign the T&C 'Witness Signature' and 'Next of Kin Signature'. Submit. The record contains two signature images with no name, no relationship and no identifier attached to either — for the Next of Kin there is not even a field elsewhere in the form to hold one. Separately, compare a RHT PRF and a PRIMARY PRF: both have a non-null `patient_signature`, one meaning 'I waive all treatment and indemnify the provider', the other 'I accept the treatment and the bill'.

<details><summary>Evidence</summary>

```
Terms & Conditions captures three signatures, two of them anonymous (8564-8582):

  <FullscreenSignaturePad label="Patient / Representative Signature" value={fd.tc_patient_signature}
    onChange={v => { sf('tc_patient_signature', v); setSigs(p => ({ ...p, patient_signature: v })); }} />
  <FullscreenSignaturePad label="Witness Signature" value={fd.tc_witness_signature}
    onChange={v => { sf('tc_witness_signature', v); setSigs(p => ({ ...p, witness_signature: v })); }} />
  <FullscreenSignaturePad label="Next of Kin Signature" value={fd.next_of_kin_signature}
    onChange={v => { sf('next_of_kin_signature', v); }} />

There is no name input in this card, and `next_of_kin_*` appears nowhere else in the file. Compare the blocks that get it right — RHT waiver (7397-7420) pairs `rht_waiver_signatory_name` / `rht_waiver_witness_name`; the DOD declaration (3266-3320) pairs `med_aid_dec_death_signatory_name` / `_crew_attended_name` / `_witness_name`; handover pairs `receiving_doctor` (8339-8359).

Meaning collision on one column: the RHT refusal waiver writes the same `sigs.patient_signature` (7402-7407) that on every other call type means the patient accepted treatment and financial responsibility (clause 1 at 8545, mirrored at 8569).

Also `valuables_signature` is initialised (4362), loaded (4613), restored (4520) and submitted (4954) but no pad is ever bound to it — the 'Valuables Handed To' card (8502) has a name field and no signature.
```

</details>

**Recommended fix.** Add name inputs beside the T&C witness and next-of-kin pads (mirroring `rht_waiver_witness_name`), and record the representative's relationship when the signatory is not the patient. Keep the RHT waiver signature in its own key rather than aliasing `patient_signature`. Either wire up `valuables_signature` to the valuables card or drop it from the payload.

<details><summary>Independent verification</summary>

Every factual assertion in the claim checks out against the code, and the one impact statement that is inaccurate is inaccurate in the direction of UNDERSTATING the defect.

1) Anonymous signature blocks — CONFIRMED. DigitalPRFForm.tsx:8564-8582 renders three FullscreenSignaturePads (Patient/Representative — wrapped in `fd.call_type !== 'DOD'`, which the claim's quoted snippet silently drops; Witness; Next of Kin) with no name input in the card. Repo-wide grep: `next_of_kin_signature` exists ONLY at 8579-8580, its render at PRFView.tsx:2248, and two PDF test fixtures. There is no next-of-kin name field in the form, the SQLAlchemy model, or the PDF. `tc_witness_signature` likewise has no paired name. The contrast blocks cited are real: rht_waiver_signatory_name / rht_waiver_witness_name at 7397-7420, med_aid_dec_death_witness_name at 3305-3318 (name Inp immediately above the pad in both).

2) Meaning collision on `patient_signature` — CONFIRMED, and materially worse than described. The RHT refusal waiver (7402-7407) writes `setSigs(p => ({...p, patient_signature: v}))`; the T&C block (8569) writes the identical key. The RHT branch lives inside P2 and has its own inline Submit (7430), so P6 — and therefore renderTermsAndConditions — is NEVER reached on an RHT; `tc_patient_signature` stays null. PRFView.tsx:2216 gates the whole Terms & Conditions + Signatures section on `fd.call_type !== 'DOD'` only, so an RHT PDF DOES print the four acceptance clauses, and line 2257 resolves the signature as `fd.tc_patient_signature || prf.signatures?.patient_signature` under the label "Patient / Rep.". Net effect on the printed medico-legal record: the ink the patient put down to REFUSE treatment is printed beneath "I accept full responsibility for all payments associated with such treatment" and "acknowledge that the treatment and/or transportation noted on this document was received by the patient". The claim says downstream "cannot distinguish a consent from a refusal without also inspecting call_type" — in fact the actual downstream consumer does not inspect it at all and renders the refusal as a consent. Impact understated, not overstated.

3) Corollary I verified while checking: `rht_waiver_signatory_name`, `rht_waiver_witness_name` and `rht_waiver_date` appear ONLY in DigitalPRFForm.tsx (7400/7413/7424) — zero hits in PRFView.tsx and zero in backend/. They persist inside the form_data JSON but never render on the exported PRF. So the single place a signatory name IS bound to that signature is dropped from the printed document.

4) `valuables_signature` — CONFIRMED.

</details>

---

### handleSubmit's drain loop can spin forever — axios instances are created with no timeout

- **Severity:** medium · **Category:** state-bug · **Lens:** coverage-and-risk
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:5736`

**Impact.** On a roadside connection that accepts the TCP connection but never responds (a captive portal, a stalled cell handoff), a background autosave hangs, submitInFlightRef is already true (set at L5703), and the crew's Submit button is permanently dead for the life of the mount, showing "Submitting PRF...". The only escape is a reload, which risks the localStorage-draft path above.

**Reproduction.** Mock the PATCH to return a never-settling promise, trigger a 5-min periodic save (L4757) or a visibilitychange save (L4743), then tap Submit. The loop never exits.

<details><summary>Evidence</summary>

```
L5736-5738: "while (savingInFlightRef.current || savePendingRef.current) { await new Promise(r => setTimeout(r, 100)); }" — no iteration cap, no deadline. savingInFlightRef is only cleared in doSave's finally (L5049), which requires the PATCH to settle. api() at L55-65 creates the instance with baseURL and headers only: "return axios.create({ baseURL: API, headers: { Authorization: ... } });" — no timeout, so axios defaults to 0 (wait indefinitely).
```

</details>

**Recommended fix.** Cap the drain loop (e.g. 50 iterations / 5s) and fall through to the direct authoritative PATCH regardless, and give api() a timeout. Test the capped loop as a pure async helper — it is trivially unit-testable once lifted out.

<details><summary>Independent verification</summary>

The code says what the claim says it says, and no guard prevents it. Verified: (1) the drain loop at DigitalPRFForm.tsx:5736-5738 is verbatim as quoted, sits outside any try/catch, and has no iteration cap or deadline; (2) grep confirms savingInFlightRef is written in exactly two places — set true at L4989, cleared only in doSave's finally at L5049 — so exiting the loop requires the PATCH to settle; (3) api() at L55-65 passes only baseURL and headers (the claim's quote omits the ngrok header but that is immaterial), there is no axios.defaults.timeout anywhere in frontend/src, and no AbortController/signal on the save path (the AbortControllers at L1780/4700/5190 are geocode/address-lookup and the load effect); (4) the consequence is real — submitInFlightRef is set true at L5703 before the loop with no later reset, setSubmit(true) at L5731 disables all four Submit buttons (L7357, L7433, L8659, L10856) showing "Submitting PRF...", and there is no watchdog resetting `submitting` (all setSubmit(false) calls are inside handleSubmit, after the loop).

Reachability checked rather than assumed: advancePhase AWAITS doSave (L5636, L5641), so the phase-change save cannot strand the crew (they would not have reached the submit screen). But two unawaited triggers can be in flight when Submit is tapped: the visibilitychange save (L4743 — routine on a phone during the multi-modal summary/sign-off flow) and the 5-minute interval save (L4759). On a stalled-but-associated connection navigator.onLine is still true, so no offline shortcut fires.

Not a deliberate design choice: the comment above waitForCaseId (L5669-5670) explicitly caps that poll at ~45s "so a stalled worker can't strand the crew on the submit button" — the same author guarded the identical failure mode one function away. services/syncEngine.ts (10s/15s) and CrewDashboard.tsx:271 (8s) set explicit axios timeouts; this file is the outlier. The missing timeout also affects the calls after the loop (L5753 PATCH, L5783 /submit), which strand at "Submitting PRF..." by the same mechanism.

One overstatement, not enough to refute: "spin forever" / "permanently dead for the life of the mount" is wrong in the limit — the wait is unbounded in application code but ends when the socket eventually errors, after which doSave's catch routes to the outbox and its finally releases the loop. Accurate framing is an unbounded stall (potentially many minutes on a captive portal / stalled cell handoff), not a permanent hang. No data loss either: saveToLocal() runs at L5732 before the loop and the outbox catches the eventual fai

</details>

---

### SA-ID → DOB/age autofill writes two billed fields and is guarded only by an assertion about a string literal

- **Severity:** medium · **Category:** clinical-correctness · **Lens:** coverage-and-risk
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:568`

**Impact.** patient_dob and age are on the claim and on the PDF. A century-pivot regression ages a 2019-born infant to 106 (or vice versa), which changes clinical thresholds and can invalidate the scheme member match. parseSaIdDob accepts 6+ digits, so it fires on a half-typed ID — the pivot logic runs on every keystroke.

**Reproduction.** Change the pivot at L578 to `>=`. Every patient born in the current year flips a century. Nothing fails.

<details><summary>Evidence</summary>

```
parseSaIdDob L568-582 handles the century pivot ("const year = candidate2000 > currentYear ? 1900 + yy : candidate2000;") and rejects non-calendar dates (L580 round-trip check); ageFromDob L584-589; autofillAgeFromId L4775-4797 writes both age and patient_dob and clears them when the ID is emptied. The only 'test' is conditionalFields.test.ts:573-578: "const partial = '800101500'; const idDigits = partial.replace(/\\D/g, ''); expect(idDigits.length).toBeLessThan(13);" — it asserts a string literal has 9 characters. parseSaIdDob is never called.
```

</details>

**Recommended fix.** parseSaIdDob, ageFromDob, fmtTime and vitalsIntervalMs (L554-608) are already pure module-scope functions — move them verbatim into src/pages/crew/prfDerive.ts (no behaviour change) and test: 6-digit prefix, 13-digit, the pivot at this year's boundary, 29-Feb non-leap rejection, ageFromDob on the birthday and the day before, and the clear-on-empty path at L4790-4793.

<details><summary>Independent verification</summary>

Every code fact checks out verbatim. DigitalPRFForm.tsx:568-582 gates on digits.length < 6 (not 13), L578 is exactly the quoted pivot line, L580 is the calendar round-trip. autofillAgeFromId L4775-4797 writes both age and dob keys and clears them only when idDigits.length === 0, driven by useEffect on [fd.patient_id_number] and [fd.debtor_id_number].

The test is worse than described. frontend/src/test/conditionalFields.test.ts:573-578 (claim's directory path was slightly off) asserts expect(idDigits.length).toBeLessThan(13) on a hard-coded literal, and its title and comment state "partial SA ID (< 13 digits) does not produce a DOB" / "parseSaIdDob would return null for < 13 digits" -- the OPPOSITE of the real behaviour, which returns a Date at 6 digits. The L564 comment also cites stale line numbers (2722-2725; code is at 4790). All three tests in the describe block re-implement logic inline; none can call parseSaIdDob, which is un-exported per the deliberate Fast-Refresh rule, so the function is genuinely at zero coverage.

Impact is mechanically supported, not merely asserted: patient_dob flows PRF -> backend/app/tasks/prf_processing.py:234 -> Case.patient_dob -> edi_generator.py:95 and :215, emitted alongside IDNumber at :93/:213. Nothing server-side re-derives DOB from the ID digits, so this client function is the sole source of the DOB on the claim; a bad pivot ships a DOB contradicting the ID it was derived from, which is exactly what breaks a scheme member match. age renders on the PDF at PRFView.tsx:1939.

Three overreaches, none fatal. (1) The title's "guarded only by an assertion about a string literal" conflates untested with unguarded -- L575 (mm/dd range) and L580 (round-trip) are real guards, and I verified the pivot is currently CORRECT (currentYear 2026: yy<=26 -> 20xx, yy>=27 -> 19xx). This is regression risk, not a live bug. (2) "Fires on a half-typed ID / pivot runs on every keystroke" is dressed as a hazard but is a non-issue: digits 1-6 ARE YYMMDD, so the 6-digit result equals the 13-digit result. (3) "age is on the claim" is inaccurate -- prf_processing.py never maps age to a Case column, so age reaches the PDF and PRF JSON but not the EDI; only patient_dob reaches the claim.

Also found a real current defect the claim missed in the same function: the clear branch is `else if (idDigits.length === 0)`, so backspacing to a partial or invalid ID (e.g. month digits corrected to 13) leaves age/patient_dob holding values derived from the PREVIOUS ID -- precisely the staleness the L4770-4772 comment claims to defend against, handled only 

</details>

---

### The DoD deceased→patient mirror copies 13 identity fields onto the keys billing reads — untested

- **Severity:** medium · **Category:** data-loss · **Lens:** coverage-and-risk
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:4836`

**Impact.** If a MAP entry or a dependency is dropped, a Declaration of Death PRF submits with a blank patient_name / patient_id_number while the DoD panel looks complete to the crew. The claim then has no identifiable patient, and DoD PRFs are the ones that cannot be re-opened for correction.

**Reproduction.** Remove 'med_aid_dec_death_deceased_id' from the MAP or from the dep array at L4872. The DoD form still looks right; patient_id_number never populates. Suite green.

<details><summary>Evidence</summary>

```
L4828-4882: "// On a Declaration of Death the deceased IS the patient, and both the Patient Information section and the billing pipeline read the patient_* keys — not the deceased-specific ones." followed by a 13-entry MAP and a reducer "if (v != null && String(v).trim() !== '' && prev[dst] !== v) { next[dst] = v; changed = true; }", with a 14-key dependency array (L4867-4882). The paired CallTypePicker side-effect (DigitalPRFForm.tsx:2741 "sf('med_aid_dec_death', o === 'DOD');") is only mirrored in conditionalFields.test.ts's own pickCallType, never imported.
```

</details>

**Recommended fix.** Lift the reducer body to a pure mirrorDeceasedToPatient(prev) → next in prfDerive.ts and assert every MAP destination is populated, blanks never overwrite, and the MAP keys and the dependency array stay in sync (a test that asserts MAP.map(([src]) => src) equals the dep list catches the classic omission).

<details><summary>Independent verification</summary>

VERDICT: not refuted. The claim is accurate as a coverage-and-risk finding, though one sentence of its impact statement overshoots and should be corrected.

WHAT I VERIFIED IN THE CODE (all read, not taken on trust)

1. The quoted code is verbatim correct. C:/Users/USER-PC/Desktop/New EMS AUTOMATIONS/frontend/src/pages/crew/DigitalPRFForm.tsx L4828-4882 is exactly as described: the comment, the 13-entry MAP, the reducer `if (v != null && String(v).trim() !== '' && prev[dst] !== v)`, the eslint-disable, and the 14-key dependency array (13 deceased keys + `fd.med_aid_dec_death`). The paired side-effect at L2741 `sf('med_aid_dec_death', o === 'DOD');` is also verbatim.

2. The MAP is currently COMPLETE — no present defect. The DoD panel captures exactly 13 deceased particulars (L3125-3146: gender, first_name, surname, id, passport, dob, age, cell, tel_home, tel_work, address, suburb, postal_code) and all 13 are mapped, and all 13 appear in the dependency array. Nothing is dropped today. The claim never asserted otherwise — it is explicitly phrased as drift risk.

3. No compensating guard exists — and this is the part that makes the finding legitimate rather than theoretical. Both of the normal safety nets are deliberately switched OFF for this exact call type:
   - L6904: `{fd.call_type !== 'DOD' && (` wraps the entire Patient Information card (L6906-6928, the only `patient_name` / `patient_surname` / `patient_id_number` inputs in the form outside the RAF billing card at L7144-7150). On a DOD PRF the crew has NO UI to type a patient name. The mirror is the sole writer of those keys.
   - L9204: the review missing-info gate returns early — `if (fd.call_type === 'DOD' || ...) return warn;` — so the blank-patient_name warnings at L9210-9213 never fire on a DOD.
   So a silent mirror failure is unobservable to the crew and ungated at submit.

4. Downstream reader confirmed. backend/app/services/claims_pipeline.py L45-46 / L208-209 / L290-292: `_extract_patient_name` tries `patient_name, name, full_name, patient_full_name` and `patient_id_number or id_number`. There is NO deceased-field fallback anywhere in the backend (grep for `deceased_*` hits only PRFView.tsx, prfPdfFieldMatrix.test.tsx and DigitalPRFForm.tsx — zero backend files). So the claim's "the keys billing reads" is correct.

5. I checked for a field-stripping mechanism that could wipe hidden-section keys (L4337, L8842, L8939) — those `hidden` sets are PHASE indexes, not field keys. No wipe risk. Not a refutation route.

WHERE THE CLAIM OVERSTATES (correct this, don't discard the finding)
"The claim 

</details>

---

### ~180 lines of dictation merge logic is how clinical narrative reaches the record on mobile — zero tests

- **Severity:** medium · **Category:** clinical-correctness · **Lens:** coverage-and-risk
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:838`

**Impact.** These functions write chief_complaint, events_hpi, findings_on_arrival, past_medical_history and management_notes — the narrative clinical record. A dedup regression duplicates or truncates what the crew dictated at the roadside, and the corruption is invisible until someone reads the PDF. The homophone rules are deliberately context-gated so that "GCS 8", "4 mg morphine" and "gave 2 puffs" stay as digits (L864-869); loosening a regex silently rewrites clinical numbers into words.

**Reproduction.** Broaden DICTATION_FIXES[2] from /\\b2\\s+(the|him|her|them|a|an)\\b/ to /\\b2\\s+\\w+/ → "2 mg adrenaline" becomes "to mg adrenaline" in the permanent record. Nothing fails.

<details><summary>Evidence</summary>

```
mergeDictation L838-858 (word-level suffix/prefix overlap dedup), correctDictation L887-894 with DICTATION_FIXES L870-879 and MEAL_FIELD_FIXES L884-886, overlapLen L947-957, pickTranscript L970-987, applyDictation L989-1020. All pure, all module-scope, all un-exported. The comments record real field failures they exist to fix: "Samsung Internet keeps several non-final entries in the results list and each is CUMULATIVE ... garbling the field with repeated words — the 'gibberish' bug" (L995-999).
```

</details>

**Recommended fix.** Move the five functions verbatim into src/pages/crew/prfDictation.ts (they take no React state — applyDictation takes a plain {committed, finalCount} and a results-array-shaped event, both trivial to fake). Test: exact repeat, cumulative re-emission, partial word overlap, Samsung multi-interim, and a NEGATIVE table asserting clinical numbers are never rewritten. High value, near-zero effort — the code needs no change at all.

<details><summary>Independent verification</summary>

NOT REFUTED. I read the code and executed it; the claim holds, and one of its premises is actually understated.

VERIFIED AS STATED
- The functions exist as described in C:\Users\USER-PC\Desktop\New EMS AUTOMATIONS\frontend\src\pages\crew\DigitalPRFForm.tsx: mergeDictation L838-858, DICTATION_FIXES L870-879, MEAL_FIELDS/MEAL_FIELD_FIXES L883-886, correctDictation L887-894, overlapLen L947-957, pickTranscript L970-987, applyDictation L989-1020. All module-scope, all un-exported, all pure except applyDictation (mutates a passed DictationState).
- Zero coverage confirmed independently of the established facts: grep for mergeDictation/correctDictation/pickTranscript/overlapLen/applyDictation/newDictationState across all of frontend/src returns hits ONLY inside DigitalPRFForm.tsx. No test file in src/test/ (9 files) mentions dictation, VoiceTxt, or SpeechRecognition at all. The logic is not duplicated in a tested util either — SpeechRecognition appears in exactly one file.
- Reachability is real, not theoretical. applyDictation is wired into two live components: Inp (L1138) and VoiceTxt (L2339), each behind `showMic`/`supported = !!SpeechRecognitionAPI` — true on Android Chrome and Samsung Internet, the roadside targets the code is explicitly written for. There are 13 <VoiceTxt> instances.
- The narrative fields named are correct: VoiceTxt fk="chief_complaint" (L8040), findings_on_arrival (L8047), past_medical_history (L8050), events_hpi (L8055), management_notes (L8253 and L8646). These land verbatim on the PDF — prfPdfFieldMatrix.test.tsx L224-231 and prfMedicalAidPdfRender.test.tsx L330-372 assert each one renders. So this is the medical-legal record, not cosmetic. The "invisible until someone reads the PDF" impact is right.

EMPIRICAL, NOT ASSERTED — I extracted the functions verbatim and ran them:
- Genuine repetition is silently deleted today. mergeDictation("BP 120 over 80", "BP 120 over 80 on recheck") returns "BP 120 over 80 on recheck" — a second, identical vitals reading is swallowed by the overlap-dedup. The algorithm cannot distinguish a cumulative re-emission from a crew genuinely repeating a phrase; that is inherent to the design, and nothing pins the tradeoff.
- The claim's own premise ("context-gated so GCS 8 / 4 mg morphine / 2 puffs stay digits") is only partly true. Those three inputs do survive — I confirmed "GCS 8 at scene", "4 mg morphine given", "gave 2 puffs" are untouched. But correctDictation("morphine 4 the pain settled") returns "morphine for the pain settled" — a dose digit rewritten to a word, and speech engines rarely emit the 

</details>

---

### normalizeFormData's two key lists are the entire defence against a recurring crash family, and nothing keeps them aligned

- **Severity:** medium · **Category:** crash · **Lens:** coverage-and-risk
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:4201`

**Impact.** A wrong runtime type from the API white-screens the form mid-call (the crash family this exists to fix). The lists only protect the nine keys someone remembered; the tenth crashes. The mechanism example shows a second entry point already writing a type the UI cannot render.

**Reproduction.** Have the API return allergies as a number with 'allergies' removed from PRF_TEXT_FIELDS → .toLowerCase() at L5961 throws during render. Or open the QA test-fill for any call type and inspect fd.mechanism → an array where a string is expected.

<details><summary>Evidence</summary>

```
L4199-4208: "⚠️  When you add a field the form treats as text or a list, add its key to the matching set below. This is the single place that guarantees its type.\nconst PRF_TEXT_FIELDS = ['allergies', 'handover_doctor_email', 'medical_scheme', 'preauth_number', 'rht_call_out_fee'];\nconst PRF_ARRAY_FIELDS = ['airway_interventions', 'circulation_interventions', 'km_review_flags', 'med_aid_dec_death_documents'];" — nine keys, maintained by comment. Evidence the discipline already slips: applyTestFill L6352 writes "mechanism: ['FALL']" (an array) while the UI binds mechanism as a single-select string (L8059 "<Sel fk=\"mechanism\" opts={MECHANISM_OPTS} />") and compares it to strings at L8066-8072.
```

</details>

**Recommended fix.** Move normalizeFormData + both lists to src/pages/crew/prfNormalize.ts. Test each declared key with number/null/object/array input, then add a guard test that scans the component source for `fd.<key>.` string-method and `.map(` call sites and asserts each dereferenced key appears in the matching list — that turns a comment into an enforced invariant.

<details><summary>Independent verification</summary>

NOT REFUTED — the core defect is real and I found better evidence for it than the claim supplied, but two of the claim's supporting assertions are wrong and its scope is roughly half what it states.

VERIFIED AS WRITTEN: DigitalPRFForm.tsx:4188-4224 contains exactly the quoted comment and the two literal arrays (5 text keys, 4 array keys). normalizeFormData is called at exactly one site, L4594, inside fetchPrfOnce. fd is Record<string, any>; there is no schema, no lint rule, and (per established facts) no test mounts the file. "Maintained by a comment, nothing keeps them aligned" is literally true.

STRONGER DRIFT EVIDENCE THAN THE CLAIM GAVE: the text-half crash idiom is `(fd.X || '').trim()`. Listed keys cover L2110 (medical_scheme), L5800/L5871 (handover_doctor_email), L6670 (rht_call_out_fee), L6672 (preauth_number). But TWO unlisted keys use the same idiom: L4916 `(fd.ward ?? '').trim()` and L5693 `(fd.vitals_shortfall_motivation ?? '').trim()` — `??` guards null/undefined only, so a number throws exactly the described TypeError. These are the predicted "tenth key" and they already exist. The file also contains a safer key-agnostic idiom in parallel (String(v).trim() at L4858/4945/5415/5439/5449/5663), showing the list approach is not the only pattern and is how drift arises.

AMPLIFIER (supports the claim): loadFromLocal L4507-4527 does setFd(draft.fd) with NO normalization, and when a local draft exists fetchPrfOnce skips setFd entirely (L4593). A bad type that reaches state gets autosaved into prf-draft:${prfId}, making the crash sticky across the ErrorBoundary's "Reload Page" recovery.

CORRECTION 1 — the array half is NOT the sole defence, it is redundant. toggleArr/inArr (L4886, L4890) do Array.isArray(fd[k]) ? ... : [] key-agnostically, protecting every multi-select regardless of whether its key is listed. All four listed array keys are consumed only via guarded paths (L3207, L5981-5982, L9813, and <Chk fk=...> -> inArr). Unlisted array-shaped keys (flags L9253, extra_crew L5652/8629/9869) are guarded identically and never needed the list. A tenth ARRAY key would not crash. Exposure is the text half only.

CORRECTION 2 — the mechanism evidence does not survive inspection, on three counts: (a) mechanism is in neither list, so it cannot demonstrate the lists' discipline slipping; (b) applyTestFill is gated at L6547 by providerSlug?.toLowerCase() === 'test', so it cannot write into any real provider's PRF — not a production entry point; (c) an array in mechanism does not crash and is not unrenderable — Sel (L2506-2514) reads val = fd[fk] ?? '', 

</details>

---

### Structural blockers to testing this component, and why extraction (not mounting) is the answer

- **Severity:** medium · **Category:** coverage-gap · **Lens:** coverage-and-risk
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:4226`

**Impact.** Every cheap seam is locked behind the Fast-Refresh rule, so the default reaction ("just export it") is wrong and would be reverted. Meanwhile the coverage script is broken, so nobody sees the gap in CI.

**Reproduction.** npx vitest run --coverage → "MISSING DEPENDENCY  Cannot find dependency '@vitest/coverage-istanbul'".

<details><summary>Evidence</summary>

```
Single default export at L4226 over 10,862 lines: 45 useEffect, ~95 useState, 3 useMemo, 6 useCallback, 106 sf() call sites, 97 distinct fd.* keys, 11 api() calls. Sub-renderers are defined INSIDE the component body and so cannot be rendered in isolation: L6512 'const P0 = () => {', 6847 P1, 6876 P2, 7866 P3, 8198 P4, 8261 P5, 8589 P6, plus VitalsSection L6152 and TimeRow L6004. api() at L55 constructs its own axios instance internally — no injection point, so tests must vi.mock('axios'). alert() and navigate() carry control flow in both submit paths (L5014, 5709, 5819, 5887, 5898). 0 data-testid in the file; only 5 aria-labels. The deliberate no-non-component-export rule is stated at L715-718: "NOT exported on purpose: ... Exporting a non-component value from a module that also exports components disables React Fast Refresh". @vitest/coverage-istanbul is NOT installed, so `npm run test:coverage` fails outright — the 0% cannot even be measured.
```

</details>

**Recommended fix.** The repo already has the sanctioned pattern three times over: prfValidation.ts (2075 lines, same directory, imported by the form), prfResumePhase.ts, and prfPdfLayout.ts — whose header states the reason exactly: "It is also a separate file because PRFView.tsx may not export non-components". Extract into sibling pure .ts modules under pages/crew/, never export from the .tsx. Also: install @vitest/coverage-istanbul so the number is visible, and add prf-field-${fk} style ids to the button pickers (CallTypePicker/BillingTypePicker/Sel/Toggle/Chk) which currently have none — needed for the one mount test below.

<details><summary>Independent verification</summary>

Every factual assertion verified independently against the code; all counts and line numbers are exact.

VERIFIED EXACT: 10,862 lines with a single `export default function DigitalPRFForm()` at L4226 (grep '^export' returns that one line only). 45 useEffect, 95 useState, 3 useMemo, 6 useCallback, 106 sf() sites, 97 distinct fd.* keys, 11 real api() call sites (L4550, 4993, 5023, 5120, 5675, 5753, 5762, 5783, 5853, 5862, 5863). Sub-renderer line numbers all exact and all at 2-space indent, i.e. inside the component body: TimeRow 6004, VitalsSection 6152, P0 6512, P1 6847, P2 6876, P3 7866, P4 8198, P5 8261, P6 8589. api() at L55 does construct its own axios.create() internally with no injection parameter, and is not exported. alert()/navigate() control flow confirmed at all five cited lines (5014, 5709, 5819, 5887, 5898) — each alert is followed by navigate() and/or a terminating return. 0 data-testid, 5 aria-label. The L715-718 Fast-Refresh comment is a verbatim match.

DEMONSTRATED, NOT ASSERTED: the coverage break was reproduced, not inferred. vite.config.ts declares coverage.provider = 'istanbul', but @vitest/coverage-istanbul is absent from both package.json and node_modules. Running `npx vitest run --coverage` yields "MISSING DEPENDENCY Cannot find dependency '@vitest/coverage-istanbul'" with EXIT=1. This is the one piece of evidence most likely to be hand-waved, and it holds.

THE SEAM PROBLEM IS WORSE THAN STATED: Inp (L1063) does `useContext(FormContext)`, and FormContext is defined at L719 — directly under the comment forbidding its export. So the field primitive and its data channel are both locked behind the same deliberate rule. Every Inp renders `placeholder=""` hardcoded with no label (7 <label>, 1 htmlFor in 10,862 lines) and no aria-label, so getByLabelText / getByPlaceholderText / getByRole-with-name all fail. Sub-renderers are invoked as plain function calls, not JSX (`{VitalsSection({ showFull: true })}` at L8100/L8249), so they get no fiber of their own.

CI IMPACT IF ANYTHING UNDERSTATED: .github/workflows/ci.yml:59 runs `npx vitest run` and never --coverage, so the broken script does not redden CI; coverage is simply never measured. The only quantitative gate is a 150-test floor (L69). Per established facts, conditionalFields.test.ts (58) and digitalPrfSecurity.test.ts (12) re-implement the form's logic and would still pass if the file were deleted — 70 tests counting toward the floor while covering none of the shipped component. CI cannot detect the gap.

TWO FAIRNESS QUALIFIERS, NEITHER REFUTING: (1) "0 data-testid" is marginally 

</details>

---

### A 403 from the server is silently suppressed whenever a local draft exists, rendering another crew's patient record from localStorage

- **Severity:** medium · **Category:** security · **Lens:** security-and-privacy
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:4683`

**Impact.** On a shared tablet, patient records survive in localStorage for any PRF that was not ended via End Shift (and the End Shift dialog actively discourages tapping it: "If the tablet is just going to sleep, cancel this"). A later user who reaches the same URL — trivially, from browser history or the URL bar autocomplete, since the prfId is in the path — gets the previous crew's full patient record rendered on screen, complete with SA ID number, clinical narrative and signatures, even though the server correctly refused them. The offline-resilience behaviour is right; extending it to cover an explicit authorization denial is not.

**Reproduction.** 1. Crew A opens /providerA/prf/<uuid>, fills the patient in, closes the app without End Shift. `prf-draft:<uuid>` remains.
2. Crew B logs in on the same tablet and opens /providerA/prf/<uuid> from browser history (same slug, so ensureProviderSession passes; a different slug wipes the session but leaves the draft, and re-login then reaches the same state).
3. Server returns 403. loadPrf breaks out, hits `if (hadLocal) return`, no error UI.
4. Crew A's patient record is on screen.

<details><summary>Evidence</summary>

```
loadPrf hydrates from localStorage before contacting the server, then treats the server's authorization verdict as advisory:

    const hadLocal = loadFromLocal();
    if (hadLocal) { setLoading(false); }
    ...
        const status = err?.response?.status;
        if (status === 401 || status === 403 || status === 400) break;
    ...
    if (lastErr?.response?.status === 401) {
      navigate(`/${providerSlug}/login`, { replace: true });
      return;
    }
    // If we already loaded from local, don't show an error — the crew can
    // continue working offline and the next doSave/submit will sync.
    if (hadLocal) {
      setRetrying(false);
      return;                    // <-- 403 swallowed, form renders local data
    }

Only 401 redirects. A 403 ("not this crew's PRF" — the code's own comment at line 4665 says so) falls through to the `hadLocal` early-return, so `loadError` is never set and the fully-populated form renders. The tenant guard that does run (line 4236 `ensureProviderSession(providerSlug)`) compares only `provider_slug` against the URL and does not touch `prf-draft:*` keys — crewSession.ts:90-94 removes only `last_prf_id` and `shift_supervisor` on a slug mismatch.
```

</details>

**Recommended fix.** Treat 403 like 401 in loadPrf: it is a definitive statement that this session may not see this record, and no cached copy should survive it. On 403, call clearLocalDraft() for that prfId and route to the dashboard with a message. Reserve the `hadLocal` suppression for genuine network failures (`!lastErr?.response`), which is the case the comment is actually describing.

<details><summary>Independent verification</summary>

CLAIM STANDS. Every link in the chain verified in source; nothing about it is asserted-only.

1) The code says what the claim says (frontend/src/pages/crew/DigitalPRFForm.tsx:4627-4697). `const hadLocal = loadFromLocal(); if (hadLocal) setLoading(false);` (4639-4642). In the retry loop, `if (status === 401 || status === 403 || status === 400) break;` (4668) — comment at 4664 literally says "403 (not this crew's PRF)". After the loop, only 401 is acted on (`navigate(.../login)`, 4677-4680), then `if (hadLocal) { setRetrying(false); return; }` (4683-4686) returns BEFORE `setLoadError(detail)` (4693). So on 403: loadError stays null, loading is already false.

2) Nothing downstream blocks the render. `loadError` is the only early-return screen (8708). `prfMeta` initialises to `{}` (4331) and every consumer uses `prfMeta.x?.y` / `|| fallback` (5648, 8590, 9855-9862), so a never-populated meta object does not crash or gate anything. The fully hydrated form (fd, vitals, meds, IV, sigs incl. patient/crew signatures, geos — set at 4514-4524) renders.

3) The 403 is genuinely reachable, not hypothetical. backend/app/api/digital_prf.py:1394 calls `_load_crew_prf(db, prf_id, crew, allow_crew2=True)`; `_load_crew_prf` (165-199) returns 404 for cross-tenant (deliberately) but `raise HTTPException(403, "PRF does not belong to this crew member")` (197) for a same-provider crew who is neither crew 1 nor crew 2. So 403 == exactly "another crew member of your own company owns this record".

4) No guard scopes the local draft to the crew. `prf-draft:*` appears in only two files (CrewDashboard.tsx:285, 518 and DigitalPRFForm.tsx:4493, 4593). The only wipe is inside the End Shift handler (CrewDashboard.tsx:281-288). `ensureProviderSession` (crewSession.ts:86-98) wipes only on provider-slug mismatch and removes only `last_prf_id`/`shift_supervisor` — same provider, different crew passes it untouched. Neither `saveAdminSession` (113-138) nor `saveShiftSession` (148-177) clears drafts, so a new crew logging in / starting a shift on the same tablet inherits the previous crew's drafts. `clearCrewSession` on a 401 (CrewDashboard.tsx:176-181) also leaves drafts in place — and its own comment says the crew re-logs in after the 12h token cap, which is precisely when a different crew member may be the one logging in.

5) Precondition realism: the exposure needs (a) the PRF still a draft — submit calls clearLocalDraft (5815-5870) and End Shift deletes server-side drafts, (b) End Shift not tapped, (c) a different crew member on the same device, (d) navigation to the same /{slug}/crew/pr

</details>

---

### localStorage quota exhaustion is swallowed, and the stale draft then silently overrides fresher server data on reload

- **Severity:** medium · **Category:** data-loss · **Lens:** security-and-privacy
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:4504`

**Impact.** After the crew attaches one large ID photo or PDF, every subsequent keystroke stops persisting locally with no visible change — the save indicator still reads normally because `dirtyRef.current = true` is set regardless (line 4731) and the 5-minute server backup still fires. If the tab is killed (routine on a phone during a call), everything since the attachment is lost from local storage, and on resume the pre-attachment local draft is loaded and the server's newer data is discarded on top. The architecture's premise — 'keystrokes autosave to localStorage; the server is contacted every 5 minutes' — quietly inverts into 'up to 5 minutes of clinical data is unprotected, and a resume can roll the record backwards'.

**Reproduction.** 1. Open a PRF, attach a ~9 MB patient ID photo via PatientDocumentsCapture's file-picker path (not the camera path).
2. Continue typing vitals and narrative for a few minutes. Observe in devtools that `prf-draft:<id>` has stopped updating (savedAt frozen at the pre-attachment value).
3. Kill the tab before the 5-minute server backup, reopen the PRF.
4. loadFromLocal returns the stale draft; the server copy is skipped by the line-4593 existence check.

<details><summary>Evidence</summary>

```
The primary save path fails silently:

  const saveToLocal = () => {
    if (!prfId) return;
    try {
      const draft = { fd, vitals, ivRows, medRows, timestamps, kms, sigs, geos, vehicle, crew2Id, phase, savedAt: Date.now() };
      localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify(draft));
    } catch { /* localStorage full or unavailable — non-fatal */ }
  };

Quota (5-10 MB) is reachable in normal use because base64 images live inside `fd`: PatientDocumentsCapture.tsx:346-349 accepts a picked file up to 12 MB and stores it *uncompressed* (`setCaptured(String(reader.result))` — only the camera path downscales, at line 322-335), and PdfDrop (line 3563) admits a 10 MB PDF as a data URL. One such attachment exceeds the quota on its own.

On the next load, the stale draft wins twice over. loadFromLocal returns true, and fetchPrfOnce then refuses to apply the server's fresher copy because the key merely *exists* (line 4593):

    if (!localStorage.getItem(`prf-draft:${prfId}`)) {
      setFd(normalizeFormData(data));
      ...
    }

`savedAt` is written into the draft but is never read anywhere in the codebase — there is no staleness comparison against `prf.updated_at`.
```

</details>

**Recommended fix.** Two independent fixes. (a) Compress the picked-file path in PatientDocumentsCapture the way the camera path already does — reuse `compressFile` from utils/imageUtils, which DocumentsCapture.tsx:50 already uses — so attachments cannot approach the quota. (b) Make the quota failure visible and non-destructive: catch QuotaExceededError specifically, force an immediate doSave() to the server, surface a real indicator to the crew, and compare the draft's `savedAt` against `prf.updated_at` at line 4593 so a stale local draft can never beat a newer server record.

<details><summary>Independent verification</summary>

I could not refute this. Every quoted line matches the code, the reachability path is ordinary use, and the real-world impact is worse than the claim states.

VERIFIED EVIDENCE (all exact):
- `saveToLocal` at DigitalPRFForm.tsx:4495-4505 is verbatim as quoted. Bare `catch {}` with no quota handling, no fallback, no user signal.
- Guard at DigitalPRFForm.tsx:4593 is verbatim: `if (!localStorage.getItem(\`prf-draft:${prfId}\`))` — existence only. Inside that block sit `setFd(normalizeFormData(data))`, vitals, iv, meds, timestamps, kms, geos and all five signatures. Outside it (4586-4588) only `setPrfMeta` and `baseUpdatedAtRef.current = prf.updated_at` run, so the OCC token IS refreshed while the data is NOT.
- `savedAt` is written twice (DigitalPRFForm.tsx:4501, CrewDashboard.tsx:529) and read ZERO times — grep over all of frontend/src confirms. No staleness comparison exists.
- `grep -rn "QuotaExceeded|quota|estimate()" frontend/src` returns nothing. There is no quota handling anywhere in the frontend.
- Attachment paths confirmed: PatientDocumentsCapture.tsx:344-350 `onPickFile` accepts a 12 MB image and does `setCaptured(String(reader.result))` — uncompressed. Only the camera path downscales (`drawCrop`, maxDim 1600, JPEG 0.92). Six slots feed `fd` via `onChange={(key,v)=>sf(key,v)}` at DigitalPRFForm.tsx:8368-8379: hospital_sticker, admission_form_image, id_document_image, medical_aid_image, aod_document, additional_document_image. PdfDrop (3563) admits a 10 MB PDF as a data URL, though it is RAF-gated (7156) so the image path is the reachable one.
- `dirtyRef.current = true` at 4731 is set unconditionally next to `saveToLocal()`, and `saveState` is driven only by `doSave`, never by `saveToLocal`. So the crew's "Saved" indicator genuinely cannot reflect a local-save failure.

REACHABILITY: a 2 MB gallery photo becomes ~2.7M base64 chars; Chrome/Safari localStorage quota is ~5 MB counted in UTF-16 (2 bytes/char), so one picked photo alone exceeds it. Even the downscaled camera path (~0.5 MB → ~680K chars → ~1.4 MB) blows the budget after 4-6 documents. Worse, drafts for ALL PRFs in a shift share the origin quota — CrewDashboard only wipes `prf-draft:` keys at logout (line 281-288) — so one PRF's attachment can silently break a *different* PRF's local save.

THE IMPACT IS UNDERSTATED, NOT OVERSTATED. `setItem` failing leaves the previous value intact, so the draft freezes at its pre-attachment state permanently. Then on any remount (back-swipe and return, PWA restart, routine iOS tab eviction — no crash required): `loadFromLocal` returns true, `fetchPrf

</details>

---

### WCA PDF attachment has no size cap and no content validation before being embedded as a data URL

- **Severity:** medium · **Category:** crash · **Lens:** security-and-privacy
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:4436`

**Impact.** A crew attaching a large scanned employer document turns it into a base64 string ~1.37x its size inside React state, which then rides in every autosave PATCH body and every localStorage write. A 40 MB PDF becomes a ~55 MB payload: it blows the localStorage quota (triggering the silent-failure chain above), makes each PATCH enormous over mobile data mid-call, and can OOM the tab on a mid-range phone — losing the in-progress patient record. The name-only extension check also means the value stored as `data_url` and later rendered/downloaded is not necessarily a PDF.

**Reproduction.** Open a WCA (workplace injury) PRF, use the WCA document prompt to attach any large file named *.pdf. No size error appears; the file is read whole into a data URL and pushed into form_data.

<details><summary>Evidence</summary>

```
handleWcaPdf checks the extension and nothing else:

  const handleWcaPdf = (key: string, file: File | null) => {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      alert('Only PDF files are accepted.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      sf(key, { name: file.name, size: file.size, data_url: String(reader.result) });
      ...
    };
    reader.readAsDataURL(file);
  };

There is no `file.size` guard and no `reader.onerror`. The sibling PdfDrop handler 900 lines earlier does cap it (line 3563: `if (f.size > 10 * 1024 * 1024) { setErr('File exceeds 10 MB.'); return; }`), and imageUtils exports `MAX_RAW_FILE_BYTES` for exactly this — neither is applied here. handleWcaPhoto (line 4407) is likewise uncapped and additionally does no type check at all, so a non-image silently does nothing (`img.onload` never fires, no `img.onerror` handler).
```

</details>

**Recommended fix.** Route both WCA handlers through the same guards the rest of the form uses: reject over `MAX_RAW_FILE_BYTES` from utils/imageUtils (or the 10 MB PdfDrop limit) before calling readAsDataURL, add a `reader.onerror`, verify the PDF magic bytes (%PDF-) rather than the filename, and pass handleWcaPhoto through `compressFile` and a real image-type check.

<details><summary>Independent verification</summary>

VERIFIED, NOT REFUTED — but the security half of the claim should be dropped and the impact re-grounded.

CODE MATCHES VERBATIM. frontend/src/pages/crew/DigitalPRFForm.tsx:4436-4449 handleWcaPdf checks extension/MIME only: no file.size guard, no reader.onerror. handleWcaPhoto (4407-4434) has no type check and no img.onerror/reader.onerror.

NO GUARD ANYWHERE ON THE PATH. buildSavePayload (4940) spreads ...fd wholesale into form_data with no size handling. Repo-wide grep for size guards in the crew capture surface returns exactly two, neither on this path: DigitalPRFForm.tsx:3563 (PdfDrop, 10MB) and PatientDocumentsCapture.tsx:346 (12MB). imageUtils.ts:36 exports MAX_RAW_FILE_BYTES but it is imported by nothing; DigitalPRFForm does not import from imageUtils at all.

REACHABLE. DigitalPRFForm.tsx:7069-7070 — a <select> in the WCA/IOD billing card (billing_type === 'WCA / IOD' || call_type === 'WCA_IOD') sets wcaDocKey and opens the modal at 10670, mounting both file inputs (10702 photo, 10718 PDF), across four document keys. Ordinary crew flow.

CONCRETE FAILURE MODE — worse than the claim stated, and demonstrated not asserted. nginx/nginx.conf:69 sets client_max_body_size 50M. Base64 is ~1.37x, so a raw PDF above ~36MB yields a PATCH body nginx rejects with 413. doSave (4977) handles 401/423/409/network/404 explicitly; a 413 falls through to the final else, which sets saveState('error') and deliberately does NOT advance lastSavedPayloadRef, so the same oversized body retries forever. Concurrently saveToLocal (4494) is try { localStorage.setItem } catch { /* full or unavailable - non-fatal */ }, so the quota blowout silently no-ops. Both persistence layers die at once and, per the project's deliberate no-mid-call-warning rule, the crew sees only a small save-state indicator. Genuine data-loss path for a medical-legal record; not cosmetic. Medium severity holds.

THREE PARTS OF THE CLAIM I REJECT:
1. "No content validation" is NOT an inconsistency with the sibling — PdfDrop at 3559-3562 uses the IDENTICAL MIME-or-extension logic. It is the project convention, and the actor is the authenticated crew member picking a file off their own device (no untrusted party). Not a security finding.
2. "The value stored as data_url and later rendered/downloaded is not necessarily a PDF" is refuted by the render side: PRFView.tsx:1077 isImageDoc = data_url.startsWith('data:image/'); anything else renders as a labelled record block, never embedded. File.type derives from the extension anyway, so a renamed file gets application/pdf. No render or XSS vector. This part was a

</details>

---

## LOW (8)

### The last 400 ms of typing is dropped from localStorage on unmount, leaving the server flush as the only copy

- **Severity:** low · **Category:** data-loss · **Lens:** data-loss
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:4726`

**Impact.** Small but real: the last thing typed before leaving the screen — often the clinical impression or handover note added at the door — can be absent from both the local draft and the server.

**Reproduction.** Crew types the final handover note and immediately back-swipes / closes the PWA within 400 ms. The debounce timer is cleared, so those characters never reach the draft. The unmount doSave is the only chance; combined with the 'unknown server error is not queued' finding above (5043) or the no-timeout hang, that PATCH can fail with the data preserved nowhere.

<details><summary>Evidence</summary>

```
The autosave effect cancels its pending write on every cleanup, including unmount (4726-4734):

    const t = setTimeout(() => { saveToLocal(); dirtyRef.current = true; }, 400);
    return () => clearTimeout(t);

The unmount path only flushes to the network (5068-5078):

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (dirtyRef.current && prfId) { doSaveRef.current(); }
    };

and that flush can early-return without saving anything — `if (savingInFlightRef.current) { savePendingRef.current = true; return; }` (4981) or the dedup at 4985 — while the callers that clear `dirtyRef.current = false` (4744, 4760) do so unconditionally, whether or not doSave actually transmitted.
```

</details>

**Recommended fix.** Flush synchronously on unmount: in the effect cleanup call saveToLocal() (or clear the timer only when the deps changed, not on unmount) before firing doSaveRef.current(). Also only clear dirtyRef once doSave reports it actually transmitted.

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

### fmtTime produces the literal string "NaN:NaN" for an unparseable timestamp and feeds it into `<input type="time">`

- **Severity:** low · **Category:** clinical-correctness · **Lens:** crash-and-state
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:557`

**Impact.** A leg time silently reads as blank on the timing table with no way to re-mark it, and the unparseable value keeps round-tripping to the server. Leg times drive scene/transport minutes and the mileage/billing calculations downstream, so a silently-empty cell is both a clinical-record gap and a claim defect.

**Reproduction.** Any non-ISO value in a timestamp slot — e.g. a draft restored from `prf-draft:<id>` written by an older build, or an outbox replay that stored a non-ISO string. The row shows an empty time box even though `has = !!timestamps[row.timeKey]` is true, so the "Mark Time" button is hidden and the crew cannot re-capture it.

<details><summary>Evidence</summary>

```
```
554: function fmtTime(iso: string | null | undefined): string | null {
555:   if (!iso) return null;
556:   const d = new Date(iso);
557:   return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
558: }
```
The only guard is falsiness. For an Invalid Date, `getHours()` returns NaN and `String(NaN).padStart(2,'0')` is "NaN", so the function returns "NaN:NaN". It is consumed as a controlled value on the timing table (6068): `value={fmtTime(timestamps[row.timeKey]) || ''}` — a `type="time"` input silently rejects a non-`HH:mm` value and displays blank, while `timestamps[row.timeKey]` still holds the unparseable string and is sent on every save.
```

</details>

**Recommended fix.** `const d = new Date(iso); if (Number.isNaN(d.getTime())) return null;` — returning null makes `has` logic and the `|| ''` fallback behave correctly and restores the Mark Time affordance.

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

### `fd.gender[0].toUpperCase()` in a top-level useMemo that evaluates on every render regardless of phase

- **Severity:** low · **Category:** crash · **Lens:** crash-and-state
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:5973`

**Impact.** White screen on open for that record, at any phase — the crash is not localised to the screen that consumes the summary, so there is no phase the crew can retreat to.

**Reproduction.** A PRF whose form_data has a non-string `gender` (e.g. an extraction pre-fill writing a coded value). Opening the PRF at any phase evaluates handoverSummary and throws `fd.gender[0].toUpperCase is not a function`.

<details><summary>Evidence</summary>

```
```
5969:  const handoverSummary = useMemo(() => {
5970:    const last = vitals[vitals.length - 1];
5971:    return {
5972:      patient: [fd.patient_name, fd.patient_surname].filter(Boolean).join(' ') || '—',
5973:      age: fd.age ? `${fd.age}${fd.gender ? fd.gender[0].toUpperCase() : ''}` : '—',
```
`fd.gender` is truthiness-checked but never type-checked, and it is not in PRF_TEXT_FIELDS (4201). If it arrives as a number or a boolean, `fd.gender[0]` is undefined and `.toUpperCase()` throws. Because this is a component-level useMemo (not inside a phase renderer), it runs for every render at every phase — the throw is not confined to the Handover screen.
```

</details>

**Recommended fix.** Add `'gender'` (and `'age'`) to PRF_TEXT_FIELDS, and write the expression defensively: `String(fd.gender).charAt(0).toUpperCase()`.

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

### `fd.extra_crew` elements are never null-checked, though the array itself is

- **Severity:** low · **Category:** crash · **Lens:** crash-and-state
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:5653`

**Impact.** Crash at submit — the worst moment, with the patient already handed over and all signatures captured — or when opening the IV/medication crew picker mid-treatment.

**Reproduction.** `crew_extra` in localStorage contains `[{...}, null]` (a partially-written shift session). Opening the PRF seeds `fd.extra_crew = [null]`; getCrewSignList (called by allCrewSigned during submit, 5663) throws on `c.name`, as does the crew-picker overlay at 9871.

<details><summary>Evidence</summary>

```
Both consumers guard the container and then dereference each element unconditionally:
```
5652:    if (Array.isArray(fd.extra_crew)) {
5653:      fd.extra_crew.forEach((c: any, i: number) => list.push({
5654:        key: `c${i + 3}`,
5655:        name: c.name || c.full_name || `Crew ${i + 3}`,
```
```
9869:          if (Array.isArray(fd.extra_crew)) {
9870:            fd.extra_crew.forEach((c: any, i: number) => {
9871:              if (c.name || c.full_name) {
```
The array is seeded straight from localStorage with only a container-level check (4574-4583):
```
        const raw = JSON.parse(localStorage.getItem(CREW_SESSION_KEYS.extraCrew) || 'null');
        return Array.isArray(raw) ? raw : [];
…
        data.extra_crew = extraCrews.slice(1);
```
A `null` element passes `Array.isArray` and throws on `c.name`.
```

</details>

**Recommended fix.** Filter on ingest at 4582 (`extraCrews.slice(1).filter(c => c && typeof c === 'object')`) or guard per element at both consumers.

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

### getCrewProfile can return null for a stored "null", and the load path dereferences it immediately

- **Severity:** low · **Category:** crash · **Lens:** crash-and-state
- **Location:** `frontend/src/utils/crewSession.ts:64`

**Impact.** The PRF fails to load with a generic crash rather than routing the crew to re-login, so the fix (log out and back in) is not discoverable on scene.

**Reproduction.** `localStorage.setItem('crew_profile', JSON.stringify(null))` (or any writer that stores a null profile). Opening a PRF throws `Cannot read properties of null (reading 'name')` inside fetchPrfOnce.

<details><summary>Evidence</summary>

```
```
62: export function getCrewProfile(): Record<string, any> {
63:   try {
64:     return JSON.parse(localStorage.getItem(CREW_SESSION_KEYS.profile) || '{}');
65:   } catch {
66:     return {};
67:   }
68: }
```
The `|| '{}'` only covers an absent/empty key. A stored literal `"null"` parses successfully to `null`, so the try/catch never fires and the declared return type is violated. DigitalPRFForm relies on the guarantee — the comment at 4479 states "getCrewProfile() guards against a corrupted localStorage value" — and dereferences without a check:
```
4482:  const profile = getCrewProfile();
…
4562:    const lead = crew1FromMeta?.full_name || profile.name || '';
4580:    if (prf.status === 'draft' && prf.crew_member_1_id === profile.id) {
```
```

</details>

**Recommended fix.** `const p = JSON.parse(raw); return (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};`

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

### Depart-scene odometer is auto-seeded from the on-scene reading, so an unverified number can be confirmed as a real meter reading

- **Severity:** low · **Category:** clinical-correctness · **Lens:** clinical-correctness
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:5625`

**Impact.** Scene-repositioning kilometres silently disappear from the billed distance, and a value the crew never read off the meter is stored as an odometer capture. Small per call, but it is a required field on a distance-billed claim and the record asserts a reading that was never taken.

**Reproduction.** Mark On Scene with km 14265. Tap 'DEPART SCENE →'. The Depart modal opens with 14265 already filled. Tap 'Confirm Depart' without looking at the dashboard — `km_depart_scene` is recorded as 14265 whether or not the vehicle was repositioned on scene (moved to a safer spot, relocated to the patient, sent to a second address on the same incident).

<details><summary>Evidence</summary>

```
if (timeKey === 'time_depart_scene') {
  if (!kms.km_depart_scene && kms.km_on_scene) {
    handleKmChange('km_depart_scene', kms.km_on_scene);
  }
  setDepartPromptOpen(true);
  return;
}

The Depart modal then presents that value in a field labelled `<Lbl t="Depart Odometer (KM)" req />` (10326) pre-filled, and 'Confirm Depart' commits it as captured. The odometer plausibility check cannot catch it either — `handleKmCommit` returns early on a zero delta (5272: `if (delta > ABSURD_KM_DELTA || delta < 0)`).
```

</details>

**Recommended fix.** Leave the field empty and let the crew enter it, or keep the prefill but visually mark it as a suggestion (placeholder rather than value) so confirming is a deliberate act.

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

### Declaration-of-death date is auto-stamped with the device's current date on first mount of the certificate body

- **Severity:** low · **Category:** clinical-correctness · **Lens:** clinical-correctness
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:3094`

**Impact.** The date on a declaration-of-death certificate is set by when the crew happened to open a form section rather than by when the patient died, and it is pre-filled so it reads as deliberate. For a legal document that is handed to an undertaker and to the family this is the wrong default.

**Reproduction.** A crew starts a DOD PRF at 23:50 and saves the draft. They reopen it after midnight (or the next morning) to finish the certificate; `med_aid_dec_death_date` is still empty because the form body had not been expanded, so it is stamped with the new date. Same effect if a draft from a night shift is completed the following day. The paired 'Time Of Death' field (3108) is left blank, so nothing contradicts the wrong date on screen.

<details><summary>Evidence</summary>

```
useEffect(() => {
  if (!fd['med_aid_dec_death_date']) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    sf('med_aid_dec_death_date', `${yyyy}-${mm}-${dd}`);
  }
}, []);

The dependency array is empty, so this fires whenever `DodFormBody` first mounts — which for the DOD path is the dispatch-screen copy (6756) and for a failed resus is the clinical copy (6805) — using the phone's clock, not the incident.
```

</details>

**Recommended fix.** Derive the default from `timestamps.time_on_scene` (or `time_dispatched`) rather than `new Date()`, and leave it blank if neither is set.

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

### An assessment or monitoring level of BLS survives a switch to RESUS, where BLS is not an offered option

- **Severity:** low · **Category:** state-bug · **Lens:** clinical-correctness
- **Location:** `frontend/src/pages/crew/DigitalPRFForm.tsx:10488`

**Impact.** A cardiac-arrest PRF asserting a BLS level of care — which is both clinically implausible and a lower-tariff billing line than the resus that was actually run — with the picker offering no way to see that BLS is what is stored.

**Reproduction.** Select assessment level BLS on a PRIMARY call, then switch the call type to RESUS. The Assessment Level chip still reads 'BLS'; reopening the modal offers only ILS and ALS, with none of them highlighted as current (`isOn` is false for both), so the crew sees an empty-looking picker over a stored BLS value. The mismatch banner at 10614 then computes `assessRank = 0` against an ILS/ALS monitoring choice and tells the crew to notify dispatch for an upgrade.

<details><summary>Evidence</summary>

```
const LEVELS = fd.call_type === 'RESUS' ? (['ILS','ALS'] as const) : (['BLS','ILS','ALS'] as const);   // 10488 assessment
const LEVELS = fd.call_type === 'RESUS' ? (['ILS','ALS'] as const) : (['BLS','ILS','ALS'] as const);   // 10554 monitoring

Neither modal clears or re-prompts on an existing out-of-range value, and the chip that displays it renders whatever is stored (7971-7979): `<div ...>{fd.assessment_level}</div>`. `RANK` in the monitoring modal (10561) still contains BLS, so the upgrade/downgrade mismatch banner compares against a level the picker refuses to offer.
```

</details>

**Recommended fix.** When `call_type` changes to RESUS and the stored level is not in the new `LEVELS`, clear it and re-open the picker (or highlight the out-of-range value in the modal the way `Chk`'s amber state does), and keep `RANK` in step with the offered set.

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

## Refuted on independent review (16)

Raised by an analysis pass and killed on review. Recorded so they are not re-raised
later as if new.

- **No HTTP timeout on any form request: a hung PATCH pins savingInFlightRef forever and handleSubmit's drain loop spins indefinitely — the PRF can never be submitted**
  - REFUTED as stated — the mechanism is real but both the "forever" and the "data-loss" framing are materially wrong.

VERIFIED TRUE: api() (DigitalPRFForm.tsx:55-66) sets no timeout, so axios defaults to 0; syncEngine.ts genuinely does bound every call (timeout 10000/15000 at lines 29/33/35/91/94/117/126) — the asymmetry is real. doSave sets savingInFlightRef=true at 4989 before the unbounded await and clears it only i
- **The 423 Locked path abandons every unsynced edit on the device: no outbox queue, no draft preserved for review, immediate navigation away**
  - REFUTED. The claim's load-bearing premise is factually false, and its proposed fix is provably a no-op.

1) "The `payload` built at 4983 is the ONLY record of everything this device captured" — false. `C:\Users\USER-PC\Desktop\New EMS AUTOMATIONS\frontend\src\pages\crew\DigitalPRFForm.tsx:4726-4734` runs a 400ms-debounced effect keyed on [fd, vitals, ivRows, medRows, timestamps, kms, sigs, vehicle, crew2Id] that call
- **409 is not conflict resolution: it refetches only the version token and re-PATCHes the whole local blob, so the losing device silently deletes the other device's fields**
  - REFUTED — the code reading is accurate, but the impact scenario is unreachable by construction, and the behaviour is correct for the 409s that actually occur.

WHAT THE CLAIM GETS RIGHT (granted, verified):
- `frontend/src/pages/crew/DigitalPRFForm.tsx:5018-5029` does take only `fresh?.data?.updated_at` and discard `fresh.data.form_data`; no local state is reconciled.
- The retry is scheduled in `finally` (5050-5056)
- **Outbox save entries use a fixed key and are deleted by id after upload, so a newer queued payload can be deleted un-sent**
  - REFUTED ON IMPACT, not on mechanism. The quoted code is verbatim-accurate and the TOCTOU is real: queueSave (offlineDb.ts:61-72) uses a fixed key `${prfId}:save`, markSynced (107-110) is an unconditional db.delete by key, and there is no version/timestamp compare between them. It is marginally worse than claimed — startSync snapshots the queue once at syncEngine.ts:43 and iterates detached objects, so the window is t
- **mark-time's onAfterCommit calls a stale doSave closure, so the timestamp and geo just committed are absent from the PATCH it triggers**
  - The stale-closure mechanism is real (DigitalPRFForm.tsx:5635, 10363, 10429 capture render-time doSave; buildSavePayload at 4940 reads closed-over timestamps/kms/fd; commitMarkTime at 5108 calls setTs/setGeos then onAfterCommit at 9719 before re-render), but every claimed impact is blocked and two key pieces of evidence are wrong.

(1) The geo half of the claim is impossible: buildSavePayload never includes `geos` — g
- **Declaration-of-Death "UNDERTAKER →" walks `phase` off the end of PHASES and renders `undefined()` — deterministic white screen**
  - REFUTED — the two halves of the claimed path are mutually exclusive, and the claim's own key piece of evidence is what makes them so.

WHAT THE CODE ACTUALLY SAYS (C:/Users/USER-PC/Desktop/New EMS AUTOMATIONS/frontend/src/pages/crew/DigitalPRFForm.tsx)

1. The walk-off arithmetic is real, in isolation. PHASES (line 464) has 7 entries. advancePhase (5562) does, under `if (fd.med_aid_dec_death)` (5583) with `hidden = {
- **vitals_sets / iv_therapy / medications are loaded with no array-type guard — normalizeFormData covers `fd` only, so a wrong-typed list from the API crashes the render**
  - REFUTED as a high-severity crash-and-state defect. The code shape is described accurately, but the crash the claim describes has no producer, and the specific line it nominates as the unconditional crash site does not in fact crash on the types it postulates.

WHAT IS TRUE (verified, not disputed):
- C:/Users/USER-PC/Desktop/New EMS AUTOMATIONS/frontend/src/pages/crew/DigitalPRFForm.tsx:4594-4599 is verbatim as quote
- **`fd.ward` is not in PRF_TEXT_FIELDS — a numeric ward from the API throws `.trim is not a function` inside the effect that runs the instant loading completes**
  - REFUTED — the mechanism is described accurately, but the precondition it depends on is asserted, never demonstrated, and nothing in this system can produce it.

WHAT THE CLAIM GETS RIGHT (verified, not disputed):
- C:\Users\USER-PC\Desktop\New EMS AUTOMATIONS\frontend\src\pages\crew\DigitalPRFForm.tsx:4916 reads exactly as quoted, and `??` does pass a number straight through to `.trim()`.
- PRF_TEXT_FIELDS (4201-4204
- **`renderPhase()` is called with no bounds check, and loadFromLocal accepts any number (including NaN) as the resume phase**
  - REFUTED as written. The code facts are half-right, but the named mechanism is impossible, the stated impact is wrong, and the evidence is asserted rather than demonstrated.

WHAT THE CLAIM GETS RIGHT
`frontend/src/pages/crew/DigitalPRFForm.tsx:8795` really is `const renderPhase = RENDERERS[phase];` (RENDERERS = [P0..P6], line 8667) and `:9036` really is a bare `{renderPhase()}`. There is no clamp and no fallback. Lin
- **`geo.lat.toFixed(5)` trusts the shape of a server-echoed geo object on the Dispatch screen — the first screen of every call**
  - The code quote is accurate — DigitalPRFForm.tsx:6055-6060 does call geo.lat.toFixed(5) unguarded on any truthy geos entry, the three setGeos sources (4521/4607/5122) do no coercion, and GeoCapture (4357) is a compile-time-only assertion over untyped JSON. The claim fails on reachability and impact.

TRIGGER SOURCES: The claim names three ways lat becomes a string; two are demonstrably false. (1) "JSONB round-trip" — 
- **WCA document tiles call `.name.toLowerCase()` on whatever is stored under the key, and render `NaN KB` when size is absent**
  - The code is quoted accurately and the missing guard is real (DigitalPRFForm.tsx:7101 checks only truthiness; :3554 is a bare `as` cast that proves nothing at runtime), and the sibling PRFView.tsx:1075-1076 does defensively check `typeof d.file === 'object' && typeof d.file.data_url === 'string'`, so the asymmetry the claim points at exists. But the claimed failure is unreachable and both hypothesised sources are asse
- **advancePhase's `onAfterCommit` closes over a stale `doSave`, so the reverse-geocoded incident address written moments earlier is excluded from the PATCH that follows**
  - The stale-closure mechanism is real and correctly described: buildSavePayload (DigitalPRFForm.tsx:4940) spreads the render-scoped `fd`, doSave (4977) is a per-render function, and the onAfterCommit arrow created at 5635 is stored in `pendingMark` state and invoked at 9719 after the sf() writes at 9703/9716, so that PATCH carries the pre-geocode fd. The path is reachable for the incident address (advancePhase(2,'time_
- **handleSubmit's autosave-drain loop is unbounded and the axios instance has no timeout — a hung PATCH strands the crew on "Submitting PRF..." forever**
  - REFUTED — the mechanical observations are accurate but the named mechanism, the stated failure mode and the claimed impact are all wrong.

VERIFIED TRUE: the drain loop at DigitalPRFForm.tsx:5736 has no cap/deadline; api() (line 54) sets no timeout; savingInFlightRef is set only at 4989 and cleared only in doSave's finally (5049); submit buttons (7357/7433/8659) are disabled={submitting} with no cancel. syncEngine.ts
- **Primary Diagnosis silently rewrites the crew's entry by appending a question mark**
  - REFUTED — the mechanism is real but it is a deliberate design choice implementing a codified clinical rule, and both claimed impacts are wrong.

WHAT THE CLAIM GETS RIGHT (verified, not disputed): the code at DigitalPRFForm.tsx:8041-8046 is quoted accurately. `Inp` (line 1063) genuinely forwards the custom onBlur in all three render branches (1238, 1240, 1253) via `onBlur={e => { onB(e); if (onBlur) onBlur(e); }}`. `
- **The hidden-phase model is encoded five times with four copies and has already diverged for RHT**
  - The mechanical evidence is accurate — the hidden-phase rule really is encoded five times (DigitalPRFForm.tsx:4337-4345 effect, :5586/5598/5612 advancePhase, :8843-8850 stepper nodes, :8940-8947 stepper labels, plus utils/prfResumePhase.ts `compressed`), and RHT really does diverge (effect/stepper use Set([1,3,4,5,6]); advancePhase:5612 uses Set([1,3,4,5])). Only inferResumePhase is tested (frontend/src/test/prfResume
- **allCrewSigned can return true for an unsigned PRF if the extra_crew shape changes**
  - The quoted code at DigitalPRFForm.tsx:5647-5664 is transcribed accurately, but the claim fails on mechanism, consistency and impact.

(1) MECHANISM IS HYPOTHETICAL, AND ALREADY GUARDED. The only writer of fd.extra_crew in the form is L4574-4583, and its source is normalised at the point of read: `const raw = JSON.parse(localStorage.getItem(CREW_SESSION_KEYS.extraCrew) || 'null'); return Array.isArray(raw) ? raw : []`
