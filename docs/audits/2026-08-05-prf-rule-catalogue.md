# Digital PRF Rule Catalogue
### Capture-time enforcement to stop avoidable claim rejections

*Built 2026-08-05 from the SA Clinical Practice Guidelines / Protocols (July 2018), all 229 pages (447 checkable requirements extracted), cross-referenced against white-box recon of the rule engines, the PRF `form_data` model, the claim-rejection paths and the HPCSA scope/billing linkage. Corrections from an adversarial review (paramedic + implementer lens) are merged in. Claims marked **[VERIFIED]** were confirmed by direct code read.*

---

## 1. The honest framing

Clinical practice guidelines are not billing rules. The CPG tells a paramedic what good care looks like; it says nothing about what a scheme will pay for. Claims are rejected for four boring reasons: **documentation completeness** (a required field is blank), **internal consistency** (two fields contradict each other), **scope mismatch** (the person recorded performing an act was not licensed to), and **unsupported billed lines** (an invoice item with no corresponding clinical entry).

Where the CPG earns its place is as a *specification of what must be recorded for a given presentation*. If the guideline says a febrile child must have temperature, HR, RR and capillary refill recorded, then a paediatric fever call billed at an ALS level with those blank is a claim that cannot be defended — not because a protocol was broken, but because the observation that justified the tariff is missing. That is the whole of the value.

Do not oversell it. A large share of CPG requirements (uterotonic sequencing, cord-clamp timing, magnesium regimens, Apgar) are **not enforceable today because the capture fields do not exist**. Those are capture-model changes, not rule changes. The items that will actually move the rejection rate are in §3, and almost none of them are clinical.

---

## 2. STOP — the rule engine is not currently working **[VERIFIED]**

Nothing in this catalogue produces any production effect until this is fixed.

`backend/app/services/adjudication_engine.py:514-516`:

```python
claim_context = build_claim_context(
    claim=claim, case=case, claim_lines=claim_lines, provider=provider,
)   # <-- no extracted_data=
```

`build_claim_context` accepts `extracted_data: Optional[dict] = None` (`rule_engine.py:61`) and gates **every PRF-derived key** behind `if extracted_data:`. This is the only production call site (confirmed by grep). So in production `extracted_data` is always `None`, and these context keys are **never set at all**:

`level_of_care`, `chief_complaint`, `clinical_notes`, `procedures_performed`, `medications_administered`, `icd10_external_cause`, `treating_practitioner_category`, `airway_interventions`, `circulation_interventions`, `medications_list`

Three consequences, all verified:

1. **HPCSA scope enforcement is dead on every claim.** `hpcsa_scope.py:106-113` reads `treating_practitioner_category`, finds `""`, and returns `[]` immediately. The entire scope-of-practice feature never fires in adjudication.
2. **Rules keyed on a value never fire.** `level_of_care` is read by `gems.py:296`, `discovery.py:287`, `netcare.py:56`, `er24.py:63`; `procedures_performed` by `netcare.py:88`, `er24.py:84`. All compare against `""` forever.
3. **Absence-predicates fire on 100% of claims.** e.g. `gems.py:427` `not c.get("patient_signature")` is always true. The RFI queue is currently a mix of universal false positives and permanently silent rules.

**Fix:** pass the adapted PRF dict (`_adapt_prf_to_extracted_data`, `digital_prf.py:1183+`) into the call. One argument, plus fixture updates. **Do this before writing any new rule.**

### 2b. A live, unsatisfiable rule is nagging crews right now **[VERIFIED]**

`NTC-3.7-PATIENT-WEIGHT` (`frontend/src/pages/crew/prfValidation.ts:185-197`) warns on every Netcare call where any medication was given and no weight was recorded. `patient_weight_kg` exists **only** as a phase anchor (`DigitalPRFForm.tsx:5528`) and in the rule itself — **there is no weight input widget in the form**. Crews cannot comply. Either ship the input or suppress the rule. (Shipping the input is cheap and unlocks all weight-based dosing checks — see E5.)

---

## 3. The design constraint every rule must obey

**This product does not interrupt a crew with validation errors during a live call.** That is a settled product decision with code enforcing it: `validatePhase()` force-downgrades every finding to `severity: 'warn'` and fails open on a thrown predicate (`prfValidation.ts:2044-2059`); `prfValidation.test.ts:355-364` asserts `blockers(findings)).toHaveLength(0)`, so a blocking rule fails CI; `scrub-phase` is a deliberate no-op (`digital_prf.py:790-795`). The only hard gates, `collectLeavePhaseBlockers()` (`DigitalPRFForm.tsx:5602-5672`), are operational (times, odometer, dispatch type) and namespaced `INLINE-*`.

**No clinical rule may ever be added to `collectLeavePhaseBlockers`.**

| Tier | When | How it surfaces |
|---|---|---|
| **T1 SILENT/STRUCTURAL** | At capture | The mistake is made impossible or fixed silently: pickers instead of free text, fixed units in the label, auto-derived values, sensible defaults. Zero crew-visible errors. |
| **T2 DEFERRED** | At handover/submit (**phase 6**), or server-side after the call | Non-blocking amber banner with tap-to-jump, or a motivation prompt that always lets the crew through (the `MIN_VITALS` pattern, `handleSubmit:5900-5923`), or acknowledge-and-continue (the `km_review_flags` pattern, `:10278-10286`). |
| **T3 BACK-OFFICE** | In adjudication, before submission | An RFI against the billing team, or `case.auth_flag`. **The crew never sees it.** |

### Three traps that will silently neutralise a rule

1. **Predicate polarity is inverted between engines.** Backend `Rule.predicate` returns `True` on **violation** (`netcare.py:114`); frontend `ValidationRule.check` returns `True` on **pass** (`prfValidation.ts:35`). Both fail open, so a copy-pasted-without-negating rule looks identical to one that never fires.
2. **Rule names are load-bearing.** `_rule_matches_phase` substring-matches `rule.name` against `PHASE_RULE_KEYWORDS` (`digital_prf.py:511-565`), and adjudication truncates to `rule_name[:30]` (`adjudication_engine.py:535`) — names collide past 30 chars.
3. **"Intervention then a later observation" rules must be `phases: [6]` only.** They are *by construction* unsatisfiable at the moment the intervention is recorded — EtCO2 cannot exist the instant 'Intubation' is ticked. Putting them on phase 3 fires a banner during intubation, defibrillation, an active seizure and a fluid bolus: the four highest-acuity moments in the form. Non-blocking is not the same as non-distracting.

---

## 4. Tier-0 — the highest-value rules, none of which are clinical

Fix these before writing a single CPG-derived rule.

| # | Rule | Real field(s) | Tier | Prevents |
|---|---|---|---|---|
| **T0-1** | Scheme + member number present when `billing_type == 'MED AID'` | `medical_scheme`, `medical_aid_number`, `main_member_id`, `dependent_number`, `scheme_option` | T1 picker + mask; T2 at **phase 6**; T3 `MISSING_SCHEME_INFO` | A missing payer identity is a 100% guaranteed rejection. Zero clinical judgement, no falsification pressure, RFI code already exists. **Cheapest rand-per-line-of-code in the document.** |
| **T0-2** | **Filing-window / stale-claim alert** | case date of service vs `STALE_DAYS_FROM_SERVICE`, `RESUBMISSION_WINDOW_DAYS` (both already in `backend/app/rules/base.py`) | **T3 only** | A claim past the scheme's filing window is rejected outright, 100% avoidably, with zero crew burden. Constants exist and are unused. **Probably the single best value-to-effort item in the whole problem space.** |
| **T0-3** | **Duplicate-claim detection** | `patient_id_hash` (already computed by `_sync_prf_patient_id_hash`) + date of service + provider | **T3 only** | `DUPLICATE_CLAIM` is already a defined `RFIReasonCode` (`adjudication_engine.py:44-57`) **with no rule behind it**. Purely mechanical rejection class. |
| **T0-4** | **Provider practice number (PCNS) present and well-formed** | `provider_pcns` context key; `REQUIRE_PROVIDER_PCNS` (base.py); `INVALID_PROVIDER` RFI code | **T3 only** | Instantly rejected by every scheme. One field, no crew impact. All three pieces already exist. |
| **T0-5** | Signature completeness — patient (or refusal reason), crew, and handover on any transported patient | `hasPatientSig` / `hasCrewSig` / `hasHandoverSig` — ⚠ **top-level DB columns, not `form_data` keys** (`prfSaveContract.ts:70`) | T2 at **phase 5/6 only** + T3 | The most common administrative rejection. `gems.py:437-454` already implements the transported-handover case, so it activates for free once §2 is fixed. |
| **T0-6** | Member eligibility/active on the date of service | scheme member-lookup path | T3 | T0-1 checks the number is *present*; this checks it is *valid*. A syntactically perfect but inactive membership is a guaranteed rejection. |
| **T0-7** | Times present and chronologically sane | the five `INLINE-TIME-*` fields | ⚠ **T2 acknowledge-and-continue — do NOT harden the existing hard gate** | Out-of-order times are a real rejection cause, but a device clock correction or timezone shift would otherwise trap a crew mid-call behind a gate they can only clear by typing a false time. |
| **T0-8** | Destination/receiving facility present on any transported patient | `receiving_facility`, `call_type` | T2 phase 5/6 + T3 | Transport billed with no destination. |
| **T0-9** | Billed line with no documented intervention behind it | claim lines vs `airway_interventions[]`, `circulation_interventions[]`, `medications[]` | **T3 only** | The definitive "unsupported line" rejection. ⚠ **Never surface to the crew** — telling a crew their billed level lacks justification is direct upcoding pressure. |
| **T0-10** | **PDF field reconciliation** | the ~21 captured-but-not-printed fields (`transfer_subtype`, `referring_doctor` the likely real gaps) | Investigation, then T1 | What the scheme actually receives is the generated PDF. A field the crew captured that the PDF never renders is **functionally missing at the payer** — no amount of capture-time enforcement fixes it. Reconcile the PDF field set against the fields the rules rely on *before* trusting those rules. |

---

## 5. Clinical documentation rules from the CPG

Only rules that are objectively checkable from structured data. `Field(s)` uses real key names. Items marked *(implied)* need clinical sign-off.

### 5.1 Airway & resuscitation — highest-value clinical group

| Rule | Trigger | What must be present | Field(s) | Tier | Prevents |
|---|---|---|---|---|---|
| **A1. Capnography with any advanced airway** | `airway_interventions[]` contains Intubation / Advanced Airway / Supraglottic | ≥1 `vitals_sets[]` row with non-blank `etco2` | `airway_interventions[]`, `vitals_sets[].etco2` | **T2 phase 6 only** + T3 | ALS uplift + advanced-airway line struck as unconfirmed placement (CPG p32-33) |
| **A2. Intubation attempts + tube size** | `airway_interventions[]` contains Intubation | `intubation_attempts`, `ett_size` non-blank | `intubation_attempts`, `ett_size`, `ett_depth` | T1 steppers + T2 | Procedure unverifiable without size; attempts >2 is a governance flag |
| **A3. Cardiac rhythm recorded before defib/cardioversion** | `circulation_interventions[]` contains Defib / Cardio Version / Pacing | ≥1 `vitals_sets[]` row with non-blank **`ecg`**, timestamped at/before | ⚠ **`vitals_sets[].ecg`** — *not* `rhythm`, which is `['Regular','Irregular']` (pulse regularity, `:518`). Cardiac rhythm is `ecg` (`:520`) | T2 phase 6 + T3 | Shock line billed with no documented shockable rhythm |
| **A4. CPR ⇒ call-type coherence** | `circulation_interventions[]` contains CPR | `call_type` is RESUS/DOD, or motivation given | `circulation_interventions[]`, `call_type`, `motivation_notes` | T3 | Resus fee billed against a PRIMARY call |
| **A5. Ventilated patient has ventilator observations** | any `vitals_sets[].vent_mode` non-blank | `tidal_vol`, `peep_cpap`, `min_vol` on ≥1 row | `vitals_sets[].vent_mode/tidal_vol/min_vol/peep_cpap/etco2` | T2 + T3 (name must contain `'Ventilated IFT'` to phase-map) | Ventilated-IFT/ICU tariff with no settings |
| A6. Shock energy/count | — | — | ⚠ **field does not exist** (only the `'Defib J/NR'` label). Note `pacing` ('Pacing mA/Rate', `:535`) **does** exist | — | Needs capture first |
| **A7. Arrest + ROSC timestamps** | `call_type == 'RESUS'` | time pulselessness confirmed, time of ROSC | ⚠ **Correction:** `rosc_achieved` / `perfusing_rhythm_on_handover` **do** exist — read from `form_data` (`digital_prf.py:742-743`), anchored (`:5542`), and already driving 3 live frontend rules. **Only the input widget is missing** — same shape as the weight field | — | **Highest-value missing widget after weight.** Unblocks every arrest-interval check |

### 5.2 Oxygen & respiratory

| Rule | Trigger | What must be present | Field(s) | Tier | Prevents |
|---|---|---|---|---|---|
| **B1. Oxygen requires a recorded SpO2** | `vitals_sets[].o2_percent` indicates oxygen | ≥1 row with non-blank `spo2` at/before | ⚠ `o2_percent` is **free text** with `'R/A'` (room air) a documented expected value (`:519`). **Must exclude `R/A` and 21%** or it fires on every room-air patient | T2 phase 6 + T3 | The textbook unsupported line. Covers ACS (p59), AHF (p64), paediatric fever (p42), pregnant trauma (p25) in one rule |
| **B3. RR on any respiratory presentation** | `chief_complaint`/`primary_diagnosis` matches asthma/COPD/bronchiolitis/pneumonia/PE | `resp_rate` non-blank on ≥1 row | `chief_complaint`, `vitals_sets[].resp_rate` | T2 + T3 | Respiratory assessment billed without its defining observation |
| **B4. CPAP/NIV pressure + post-application observation** | `peep_cpap` non-blank | a later `vitals_sets[]` row exists | `vitals_sets[].peep_cpap/.time` | T2 **phase 6 only** + T3 | CPAP line with no setting or response (p66) |
| B2 / B5 | oxygen device+flow; NIV below SBP 85 | — | ⚠ B2 fields do not exist. B5 needs a parser on free-text `bp` and is a **clinical-judgement** finding — route to clinical governance, not a billing RFI | — | — |

### 5.3 Cardiac / ACS

| Rule | Trigger | What must be present | Field(s) | Tier | Prevents |
|---|---|---|---|---|---|
| **C1. Chest pain ⇒ an ECG observation** | `chief_complaint`/`primary_diagnosis` matches chest pain/ACS/STEMI/MI | ≥1 row with non-blank **`ecg`** | ⚠ `vitals_sets[].ecg` only — drop the `rhythm` condition (wrong field, adds false positives) | T2 + T3 | ECG line billed with no interpretation — the classic ACS query |
| **C3. Nitrate requires a BP before it** | `medications[].type` matches nitro/GTN/isordil | a `vitals_sets[]` row with `bp` and `time` ≤ med time | `medications[].type/.time`, `vitals_sets[].bp/.time` | T2 **phase 6 only** + T3 | Nitrate line with no pre-administration BP (p62, p68) |
| **C4. Opioid requires pain scores either side** | `medications[].type` matches morphine/fentanyl/ketamine/tramadol | a `pain` value before **and** after the med `time` | `medications[].type/.time`, `vitals_sets[].pain/.time` | T2 **phase 6 only** + T3 | The most commonly queried analgesia billing; also justifies repeat doses (p60) |
| C5 / C6 | thrombolytic bleeding-risk; clopidogrel dose vs age | — | ⚠ C5 has no structured checklist; C6 needs dose-string parsing and is clinical judgement | T3 *(implied)* — prefer clinical governance | — |

### 5.4 Seizures & neurological

| Rule | Trigger | What must be present | Field(s) | Tier | Prevents |
|---|---|---|---|---|---|
| **D1. Seizure ⇒ blood glucose recorded** | `chief_complaint` matches seizure/convulsion/fit/status epilepticus | ≥1 row with non-blank `hgt` | `vitals_sets[].hgt`, `chief_complaint` | **T2 + T3 — build this first in this group** | A benzo or dextrose billed on a seizure with no glucose has no documented workup; the drug line **and** the ALS uplift are queried (p36) |
| **D2. Seizure ⇒ GCS recorded** | as D1 | `gcs_e` + `gcs_v` + `gcs_m` all set (total derives only when all three present, `:6481-6486`) | `vitals_sets[].gcs_e/gcs_v/gcs_m` | T1 (pickers + auto-total, already built) + T2 | Neuro assessment billed with no score |
| **D3. Benzodiazepine ⇒ glucose + GCS present** | `medications[].type` matches midazolam/diazepam/lorazepam | D1 and D2 satisfied | as above | T2 **phase 6 only** + T3 | Drug line with no documented indication |
| D4 / D5 | seizure duration; hypoglycaemic seizure transported | — | ⚠ D4 fields do not exist. D5's `refused_transport` is **not a form_data key** — it is derived from `call_type` (`digital_prf.py:1185`); the crew-facing key is `patient_refused_transport`. D5 is also clinical judgement | T3 backend only | — |

### 5.5 Paediatric

| Rule | Trigger | What must be present | Field(s) | Tier | Prevents |
|---|---|---|---|---|---|
| **E1. Paediatric fever four-field completeness** | `age` < 12 **and** fever keywords | `temp`, `hr`, `resp_rate`, `cap_refill` all non-blank on ≥1 row | `vitals_sets[].temp/.hr/.resp_rate/.cap_refill`, `age` | **T2 + T3 — the cleanest CPG-derived rule in the document** | CPG p40 makes all four mandatory. Any one blank makes the call directly queryable |
| **E3. Fluid bolus ⇒ a reassessment observation after it** | `iv_therapy[]` row with `vol_infused` > 0 | a `vitals_sets[]` row with `time` after `time_up` | `iv_therapy[].vol_infused/.time_up`, `vitals_sets[].time` | T2 **phase 6 only** + T3 | Repeat boluses billed with no intervening reassessment (p44, p48, p53) |
| **E4. Paediatric IV fluid ⇒ documented indication** | `age` < 12 and `iv_therapy[]` present | `iv_therapy[].indication` non-blank | `iv_therapy[].indication` | T1 (picker + free-text tail) + T2 | IV fluid with no documented shock/ORT failure is rejected as not medically necessary (p53) |
| **E5. Weight-based dosing** | `age` < 12 and any med/bolus | patient weight | ⚠ **`patient_weight_kg` anchor + a LIVE rule already exist — only the input widget is missing** (see §2b). Cheaper than it looks | T1 input + T2 | Unblocks paediatric mg/kg bands, 10/20 mL/kg boluses, the 40–60 mL/kg threshold |
| E2 | abnormal HR/CRT ⇒ BP | — | ⚠ `cap_refill` is a **picker** `['< 2sec','> 2sec']` (`:522`) — there is no numeric seconds value, so `>= 3` is not computable. E1's non-blank check works; this threshold does not | — | Needs capture change |
| E6 / E7 | dehydration grade; temperature route | — | ⚠ fields do not exist | — | — |

### 5.6 Obstetric — effectively unbuildable today

A repo-wide grep for `apgar` returns **zero hits**. `'Obstetric Emergency'` exists only as a string in `MECHANISM_OPTS`. Birth time, gestational age, cord-clamp time, placenta-delivered time, pregnancy status, birth weight — none exist.

**Recommendation:** either add a compact `call_type`-gated obstetric supplement (~9 fields: `pregnancy_status`, `gestational_age_weeks`, `birth_time`, `apgar_1min`, `apgar_5min`, `cord_clamp_time`, `placenta_delivered_time`, `birth_weight_grams`, `estimated_blood_loss_ml`) which unlocks ~15 of the CPG's cleanest checks, or accept that obstetric claims are adjudicated on free text and stop pretending otherwise. Do not attempt obstetric rules against the current model.

---

## 6. Numeric plausibility — record-then-flag, never input-restrict

These catch transcription errors: the RR of 160, the GCS of 20, the 7 kg adult.

⚠ **Do not implement these as input restrictions.** Real extreme values must stay recordable — SVT at 280, neonatal RR, severe hypothermia. Only `spo2` is safe to hard-clamp (0–100). Everything else is **record, then flag**, reusing the existing `km_review_flags` interaction verbatim (`DigitalPRFForm.tsx:10278-10286`): show once, tap acknowledge, write `{field, value, acknowledged, timestamp}` as the audit trail. A new `vitals_review_flags[]` key must be registered in `PRF_ARRAY_FIELDS` (`:4297-4342`).

Population derives from `form_data.age` (a **String** — coerce carefully).

| Field (`vitals_sets[].`) | Neonate | Paediatric (1–11) | Adult | Flag as implausible |
|---|---|---|---|---|
| `hr` | 100–180 | 70–160 | 40–140 | < 20 or > 250 |
| `resp_rate` | 30–60 | 15–40 (**> 60 is a CPG high-risk marker in febrile children, not an error**) | 8–30 | < 4 or > 80 |
| `spo2` | 85–100 | 90–100 | 90–100 | < 50 or > 100 — **only field safe to clamp** |
| `temp` | 35.0–38.0 | 35.0–41.0 | 35.0–41.0 | < 25 or > 43 (⚠ `temp` is a **text** input, `:531` — making it numeric is a capture change) |
| `gcs_total` | 3–15 | 3–15 | 3–15 | outside 3–15 (derived; already safe) |

---

## 7. Cross-field consistency

| Rule | Check | Tier |
|---|---|---|
| **X1. Intervention timestamped before on-scene time** | any `medications[].time` / `iv_therapy[].time_up` / `vitals_sets[].time` earlier than `time_on_scene` | T2 acknowledge + T3 |
| **X2. Out-of-scope intervention** | documented act vs `treating_practitioner_category` via `hpcsa_scope.evaluate()` | ⚠ **T3 ONLY.** Scope may gate prompting/ordering; it must **never** gate *recording*. Blocking capture of an out-of-scope act falsifies the record by omission and loses safety-critical information at handover. The per-row `medications[].administered_by_qualification` capture already exists — that is the safe mechanism |
| **X3. Billed level vs documented interventions** | ALS/ILS billed with no ALS/ILS intervention | **T3 ONLY** — never crew-facing (upcoding pressure) |
| **X4. Mileage vs route** | `loaded_distance_km` vs odometer delta | T2 acknowledge (`km_review_flags`, already built) + T3 |

---

## 8. Implementation plan

**Order of work:**

1. **Fix §2** — pass `extracted_data=` into `build_claim_context`. Nothing else works until this lands. Add a regression test asserting `treating_practitioner_category` is populated and `hpcsa_scope.evaluate()` returns findings for a known out-of-scope claim.
2. **Fix §2b** — ship the `patient_weight_kg` input or suppress `NTC-3.7`. It is nagging crews unsatisfiably today.
3. **T0-2, T0-3, T0-4** (filing window, duplicate, PCNS) — pure back-office, constants and RFI codes already exist, zero crew impact, zero clinical risk. Highest value-to-effort in the document.
4. **T0-1 and T0-5** (scheme/member, signatures) — biggest administrative rejection classes.
5. **T0-10** — reconcile the PDF field set before trusting any rule that assumes the payer can see a field.
6. **Clinical rules D1, E1, B1, A1, C4** — in that order. All `phases: [6]`.

**Where each tier lives:** T1 → `DigitalPRFForm.tsx` field definitions + `normalizeFormData`. T2 → `prfValidation.ts` rule arrays (`schemes: ['all']` **is** viable — `validatePhase` honours it at `:2047`; only a PRF with no resolvable scheme gets nothing). T3 → `backend/app/rules/{gems,discovery,netcare,er24}.py` `RULES` tuples + `hpcsa_scope.evaluate()`.

**Worked example — D1 (seizure ⇒ glucose), frontend T2:**

```ts
{
  id: 'CPG-SEIZ-HGT',
  schemes: ['all'],
  phases: [6],                 // submit only — never mid-call
  severity: 'warn',
  field: 'vitals_sets',
  check: (d) => {              // TRUE = passes (frontend polarity)
    const cc = `${d.chief_complaint ?? ''} ${d.primary_diagnosis ?? ''}`.toLowerCase();
    if (!/seizure|convuls|fit\b|status epilepticus/.test(cc)) return true;   // rule N/A
    return (d.vitals_sets ?? []).some((v: any) => has(v, 'hgt'));
  },
  message: 'Record a blood glucose for this patient.',   // no source citation in crew copy
  source: 'CPG July 2018 §2 Seizures p36',              // metadata only
}
```

Backend T3 twin — remember the **inverted polarity** (`True` = violation) and keep `name` under 30 characters.

---

## 9. Fields worth adding, ranked

1. `patient_weight_kg` **input** (anchor + rule already exist) — unblocks all paediatric dosing checks
2. `rosc_achieved` / `perfusing_rhythm_on_handover` **inputs** (backend reads + 3 live rules already exist) — unblocks arrest intervals
3. `ecg_acquired_time` — unblocks the 10-minute 12-lead rule (CPG p57)
4. `o2_device` + `o2_flow_lpm` — only if oxygen consumables are billed
5. `cap_refill` as a graded picker — turns E1's presence check into E2's threshold check
6. Obstetric supplement (~9 fields) — unlocks ~15 checks, only if obstetric volume justifies it

---

*Sources: CPG July 2018 (229pp, 447 requirements extracted); recon of `adjudication_engine.py`, `rule_engine.py`, `backend/app/rules/*`, `DigitalPRFForm.tsx`, `prfValidation.ts`, `digital_prf.py`, `hpcsa_scope.py`. Regulatory/source references are kept in `source`/comment metadata only — never in crew-facing `message` copy.*
