"""
Seed (and remove) realistic demo PRFs for a client walkthrough, by CLONING
hand-captured reference PRFs and varying the patient.

    cd backend
    python seed_demo_prfs.py --provider EMSMCA --templates            # inspect
    python seed_demo_prfs.py --provider EMSMCA --count 500 --plan     # write nothing
    python seed_demo_prfs.py --provider EMSMCA --count 500 --seed     # create
    python seed_demo_prfs.py --provider EMSMCA --count 15000 --fill matrix --seed
    python seed_demo_prfs.py --teardown demo_seed_manifest_<stamp>.json --yes

`--fill matrix` grades the records across DENSITY_BANDS instead of leaving each
one the size its template happened to be, so the set spans a quiet call through
to the largest the form can hold. That is what makes it useful for finding where
the PDF stops fitting on a sheet — see the band table further down.

WHY THIS CLONES INSTEAD OF GENERATING
-------------------------------------
The first version of this script hand-built a form_data payload from the field
names in the code. It produced records that were structurally valid and visibly
hollow: 45 keys against the 183 a real capture carries, four of the nine
timestamps (and the wrong four), no kilometres at all, no signatures, no vehicle
or crew links, and an invented survey_* key set that printed nothing.

A PRF has too many interdependent fields to reproduce from first principles.
So the seeder no longer tries. It takes a PRF a crew actually captured, copies
it whole, and overwrites ONLY the things that must differ between two calls.
Everything else — every key, every signature, the hospital sticker, the vehicle
and crew links — comes along because it is a copy.

The rule is inverted from the usual one: PRESERVE BY DEFAULT, override
explicitly. A field nobody thought about stays exactly as the crew captured it,
which is the safe direction. Adding a field to the form later needs no change
here.

WHAT IS OVERWRITTEN (and why each one must be)
----------------------------------------------
  identity   — name, surname, ID/passport, DOB, age, address, phones, and the
               debtor / deceased equivalents. Cloning these would put one real
               patient's identifiers on 500 records.
  times+kms  — re-anchored to a new call, PRESERVING the template's real
               intervals, so a transfer still takes as long as a transfer.
  clinical   — vitals, complaint, diagnosis, medication values.
  admin      — scheme, member number, facility, ward, receiving doctor, crew.

WHAT IS DELIBERATELY KEPT
-------------------------
  Signatures and the hospital sticker are copied as-is (owner's decision,
  2026-08-14). They are the owner's own staff on the owner's own tenant, and a
  demo record with "Not captured" where a signature belongs looks broken.

VISIBILITY — the part that is easy to get wrong
-----------------------------------------------
The Cases page always requests queue=management, and that filter is a subquery
over DOCUMENTS, not over cases or PRFs (api/cases.py). A PRF + Case with no
documents row is INVISIBLE. Each seeded record therefore gets the full chain the
real pipeline builds — DigitalPRF -> Case -> Document(needs_hitl_review=False)
-> Claim — and the PRF is finalised to PROCESSED with case_id and document_id
set. Anything left at SUBMITTED with a NULL case_id lights the red "N PRFs
failed to process" alarm ten minutes later and the beat watchdog starts
re-enqueueing it into the live billing pipeline.

Written through the ORM, never raw SQL: form_data and cases.patient_id_number
are TypeDecorators that encrypt on bind, two before_insert listeners derive the
patient_id_hash POPIA subject-access depends on, and the Postgres enum labels
are the UPPERCASE member NAMES.

REMOVAL IS DESIGNED IN
----------------------
The application refuses to delete anything past DRAFT, so these cannot be
removed through the UI. Two independent handles: a `_demo_seed` marker inside
form_data, and a manifest listing every id created. Teardown deletes only ids in
the manifest AND carrying the marker, and aborts if the two disagree.
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import json
import random
import sys
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.database import engine
from app.models.case import Case
from app.models.claim import Claim, AdjudicationStatus
from app.models.digital_prf import DigitalPRF, PRFStatus
from app.models.document import Document, OCRStatus
from app.models.service_provider import ServiceProvider

MARKER = "_demo_seed"

TIME_COLS = ["time_call_received", "time_dispatched", "time_mobile", "time_on_scene",
             "time_depart_scene", "time_at_destination", "time_handover",
             "time_available", "time_back_to_base"]
KM_COLS = ["km_call_received", "km_dispatched", "km_mobile", "km_on_scene",
           "km_depart_scene", "km_at_destination", "km_handover",
           "km_available", "km_back_to_base"]
SIG_COLS = ["patient_signature", "witness_signature", "handover_signature",
            "crew_signature", "valuables_signature"]

# ── Value pools ────────────────────────────────────────────────────────────
SCHEMES = ["Discovery Health Medical Scheme", "Government Employees Medical Scheme (GEMS)",
           "Bonitas Medical Fund", "Momentum Health", "Medihelp", "Bestmed",
           "Fedhealth", "Profmed", "Polmed", "Medshield"]
PLANS = ["Classic Saver", "Coastal Core", "Priority", "Essential", "Comprehensive", "KeyCare Plus"]
FACILITIES = ["Charlotte Maxeke Johannesburg Academic Hospital", "Chris Hani Baragwanath Academic Hospital",
              "Netcare Milpark Hospital", "Netcare Sunninghill Hospital", "Life Flora Hospital",
              "Life Fourways Hospital", "Mediclinic Morningside", "Steve Biko Academic Hospital",
              "Tembisa Provincial Tertiary Hospital", "Helen Joseph Hospital"]
WARDS = ["casualty", "Resus 1", "ICU", "High Care", "Cath Lab 2", "Trauma Unit", "Maternity"]
SURNAMES = ["Ndlovu", "Mokoena", "Dlamini", "Nkosi", "Molefe", "Khumalo", "Sithole", "Mahlangu",
            "van der Merwe", "Botha", "Naidoo", "Pillay", "Adams", "Jacobs", "Mthembu",
            "Zulu", "Marais", "Fourie", "Govender", "Mokwena"]
FIRST_M = ["Sipho", "Thabo", "Johan", "Pieter", "Ravi", "Ahmed", "Lunga", "Kagiso", "Andre", "Bongani",
           "Tshepo", "Wesley", "Farhan", "Dumisani", "Riaan"]
FIRST_F = ["Nomsa", "Thandi", "Lerato", "Anele", "Zanele", "Priya", "Ayesha", "Maria", "Chantel",
           "Naledi", "Refilwe", "Shireen", "Elmarie", "Palesa", "Kholeka"]
STREETS = ["Rissik Street", "Voortrekker Road", "Church Street", "Main Reef Road", "Klipfontein Road",
           "Beyers Naude Drive", "Nelson Mandela Drive", "Chris Hani Road", "Sunset Avenue", "Louis Botha Avenue"]
SUBURBS = [("Sebokeng Unit 7", "1983"), ("Vanderbijlpark Central", "1900"), ("Soweto Orlando East", "1804"),
           ("Randburg Ferndale", "2194"), ("Benoni Northmead", "1501"), ("Centurion Lyttelton", "0157"),
           ("Roodepoort Florida", "1709"), ("Alberton New Redruth", "1449"), ("Midrand Halfway House", "1685"),
           ("Kempton Park Birchleigh", "1618"), ("Boksburg Bartlett", "1459")]
DOCTORS = ["Dr M. Nkosi", "Dr T. van Rensburg", "Dr A. Patel", "Dr L. Mokwena",
           "Dr S. Abrahams", "Dr K. Botha", "Dr N. Zwane", "Dr R. Chetty"]
CREW = [("P. Naidoo", "ECP", "ECP0041882"), ("T. Dlamini", "AEA", "AEA0093117"),
        ("A. Mokoena", "ECT", "ECT0028640"), ("J. van Wyk", "BAA", "BAA0175204"),
        ("S. Khumalo", "ANT", "ANT0011975"), ("M. Adams", "ECA", "ECA0060338"),
        ("L. Sithole", "AEA", "AEA0102446"), ("K. Pretorius", "ECP", "ECP0037159")]
COMPLAINTS = [
    ("Chest pain", "Acute coronary syndrome", "Central crushing chest pain radiating to the left arm, onset 40 minutes prior to call."),
    ("Shortness of breath", "Acute exacerbation of asthma", "Progressive dyspnoea over six hours with audible wheeze, using accessory muscles."),
    ("Motor vehicle accident", "Polytrauma", "Restrained driver, frontal impact with moderate intrusion, ambulatory on scene."),
    ("Seizure", "Generalised tonic-clonic seizure", "Witnessed seizure lasting three minutes, post-ictal on arrival."),
    ("Abdominal pain", "Acute abdomen for investigation", "Right iliac fossa pain with guarding and nausea, no vomiting."),
    ("Collapse", "Syncope for investigation", "Sudden collapse at work with brief loss of consciousness, spontaneous recovery."),
    ("Fall", "Suspected neck of femur fracture", "Fall from standing, unable to weight-bear, shortened externally rotated leg."),
    ("Assault", "Head injury with lacerations", "Assault with a blunt object, laceration to the occiput, GCS 14 on arrival."),
    ("Difficulty breathing", "Community-acquired pneumonia", "Productive cough for four days, febrile, reduced air entry at the right base."),
    ("Diabetic emergency", "Hypoglycaemia", "Found confused and diaphoretic, HGT 2.1 mmol/L, responded to dextrose."),
    ("Burns", "Partial-thickness burns to forearm", "Scald from boiling water, approximately 4% TBSA, cooled on scene."),
    ("Obstetric emergency", "Threatened preterm labour", "32 weeks gestation, regular contractions, no per-vaginal bleeding."),
]
DRUGS = [("Morphine Sulphate", "5 mg", "IV"), ("Salbutamol", "5 mg", "Nebulised"),
         ("Adrenaline 1:1000", "0.5 mg", "IM"), ("Aspirin", "300 mg", "ORAL"),
         ("Dextrose 50%", "50 ml", "IV"), ("Paracetamol", "1 g", "IV"),
         ("Ondansetron", "4 mg", "IV"), ("Midazolam", "2.5 mg", "IN")]
FLUIDS = ["Ringer's Lactate", "Sodium Chloride 0.9%", "Dextrose 5%", "Modified Fluid Gelatin"]

# Reference PRFs, by the display name their case carries.
TEMPLATE_NAMES = ["Primary", "IFT/IHT", "RHT", "WCA/IOD", "Courtesy", "RESUS", "DOD"]
# How the 500 are distributed. PRIMARY dominates as it does in real EMS work.
TEMPLATE_MIX = {"Primary": 44, "IFT/IHT": 25, "RHT": 9, "WCA/IOD": 7,
                "Courtesy": 5, "RESUS": 6, "DOD": 4}

# ── Fill density ───────────────────────────────────────────────────────────
# A record's SIZE on the page is driven by three repeating tables and by how
# much prose the crew typed. The numbers below are the same ones the PDF layout
# gate uses (frontend/scripts/pdf-layout-matrix.mjs), so a band here and a band
# there mean the same thing and the seeded data exercises the same geometry the
# gate measures.
#
# `text` selects a prose tier: 0 short, 1 long, 2 maximum.
# IV and medication rows are capped at 3 by the owner's instruction
# (2026-08-17). A real call runs one to three lines and one to three drugs; the
# earlier 20/26 produced seven continuation sheets of drug tables per record,
# which stressed the paginator but made the demo records unlike anything a crew
# would recognise. The layout paginator is still exercised to 12 IV and 16
# medications by scripts/pdf-layout-matrix.mjs, which is where that belongs —
# a synthetic fixture, not the data a client is shown.
#
# The rest of the stress stays: 26 observation sets is the form's own maximum
# and tier-3 prose is a crew who typed a page into every box.
DENSITY_BANDS = {
    "typical":  {"iv": 1,  "med": 2,  "vitals": 3,  "text": 0},
    "heavy":    {"iv": 2,  "med": 3,  "vitals": 5,  "text": 1},
    "max":      {"iv": 3,  "med": 3,  "vitals": 6,  "text": 2},
    "extreme":  {"iv": 3,  "med": 3,  "vitals": 6,  "text": 2},
    # Past anything a real call produces, on purpose. Every layout budget in
    # PRFView was derived from a measurement, and a budget is only trustworthy
    # once something has been pushed through the far side of it: this band is
    # what proves the sheet SPILLS instead of slicing rather than proving it
    # happens to fit. Twenty-six observation sets is the form's own maximum, and
    # tier 3 prose is a crew who typed a page into every free-text box.
    "overfill": {"iv": 3,  "med": 3,  "vitals": 26, "text": 3},
}
# Weighted toward the top: the point of this data set is to find where the sheet
# breaks, and a set that is mostly 'typical' finds nothing. 'typical' is kept in
# so the list still reads like real work when a client scrolls it.
DENSITY_MIX = {"typical": 25, "heavy": 30, "max": 30, "extreme": 15}
# Fault-hunting mix: almost entirely past the budgets, with a little ordinary
# work so a regression in the NORMAL path still shows up in the same run.
DENSITY_MIX_HUNT = {"typical": 5, "heavy": 10, "max": 20, "extreme": 25, "overfill": 40}

# Clinical rows only belong on call types that render the clinical stack. A
# refusal (RHT) hides it entirely — fd.patient_refused_treatment collapses the
# whole capture — and a declaration of death has no observations to carry, so
# padding either with 12 IV lines would inflate the record without ever
# reaching the page. Those two get the prose tiers and nothing else.


CLINICAL_TEMPLATES = {"Primary", "IFT/IHT", "RESUS", "Courtesy", "WCA/IOD"}

# Prose at three lengths, per field. Tier 0 is what a busy crew actually types;
# tier 2 is the longest entry the field can hold and still be a real answer.
PROSE = {
    "events_hpi": [
        "Central crushing chest pain radiating to the left arm, onset 40 minutes prior to call.",
        "Patient reports central crushing chest pain that began approximately 40 minutes before the "
        "call while walking up stairs at home, radiating to the left arm and jaw, associated with "
        "nausea, sweating and shortness of breath. No relief from rest. No prior episodes of this "
        "severity, although patient describes two milder episodes over the past fortnight.",
        "Patient reports central crushing chest pain that began approximately 40 minutes before the "
        "call while walking up a flight of stairs at home, radiating to the left arm and the angle of "
        "the jaw, associated with nausea, profuse diaphoresis and progressive shortness of breath. "
        "Pain described as 8/10, constant, not pleuritic and not reproducible on palpation. No relief "
        "from rest or from a single sublingual nitrate taken from a family member's supply. Patient "
        "describes two milder self-limiting episodes over the preceding fortnight, both on exertion "
        "and both resolving within ten minutes. No syncope, no palpitations, no calf pain or swelling, "
        "no recent long-haul travel or immobilisation. Family reports patient has been non-adherent "
        "with antihypertensive therapy for several months following a change of treating doctor.",
    ],
    "findings_on_arrival": [
        "Patient seated, alert, clammy and in obvious discomfort.",
        "Patient found seated upright on a dining chair, alert and orientated, pale, clammy and in "
        "obvious discomfort, clutching the anterior chest. Airway patent, speaking full sentences with "
        "mild effort. Radial pulse present and regular.",
        "Patient found seated upright on a dining chair in the lounge, alert and fully orientated to "
        "person, place and time, pale, cool peripherally and markedly diaphoretic, in obvious "
        "discomfort and clutching the anterior chest wall. Airway patent and self-maintained, speaking "
        "in full sentences with mild increased effort. Chest clear bilaterally on auscultation with "
        "equal air entry and no added sounds. Radial pulse present, regular and of reduced volume. "
        "Abdomen soft and non-tender. No peripheral oedema, no calf tenderness, no external injury. "
        "Family present and cooperative; scene safe with clear egress to the vehicle.",
    ],
    "management_notes": [
        "Oxygen, IV access, analgesia. Transported stable.",
        "High-flow oxygen applied via non-rebreather, 12-lead acquired and transmitted to the "
        "receiving unit, IV access established, aspirin and titrated analgesia administered. Patient "
        "monitored throughout and transported in a position of comfort. Handed over stable.",
        "High-flow oxygen applied via non-rebreather mask at 15 l/min with continuous saturation "
        "monitoring. A 12-lead ECG was acquired on scene, interpreted and transmitted ahead to the "
        "receiving unit, and the cardiac team was placed on standby prior to arrival. Two large-bore "
        "IV lines were established in the antecubital fossae after two attempts, and analgesia was "
        "titrated to effect with reassessment after each increment. Aspirin was administered after "
        "confirming no allergy and no active bleeding. Vital signs were recorded at regular intervals "
        "throughout and remained within the ranges documented in the observation series. The patient "
        "was moved by carry chair to the vehicle, transported in a semi-recumbent position of comfort "
        "with continuous cardiac monitoring, and handed over to the receiving practitioner together "
        "with the ECG trace, the medication record and this report form. No deterioration en route.",
    ],
    "past_medical_history": [
        "Hypertension.",
        "Hypertension diagnosed 2019, Type 2 Diabetes Mellitus on oral therapy, previous myocardial "
        "infarction 2021 with stenting, ex-smoker of 20 pack-years.",
        "Hypertension diagnosed 2019 and poorly controlled by patient's own account, Type 2 Diabetes "
        "Mellitus on oral therapy since 2017 with documented peripheral neuropathy, previous "
        "myocardial infarction in 2021 managed with primary angioplasty and a single drug-eluting "
        "stent to the left anterior descending artery, hypercholesterolaemia, mild chronic kidney "
        "disease stage 2, and an ex-smoking history of approximately 20 pack-years stopped in 2021. "
        "Appendicectomy 1998. No previous cerebrovascular event and no known arrhythmia.",
    ],
    "current_medications": [
        "Metformin 850mg BD.",
        "Metformin 850mg BD, Enalapril 10mg daily, Atorvastatin 20mg nocte, Aspirin 75mg daily.",
        "Metformin 850mg twice daily, Enalapril 10mg daily, Atorvastatin 20mg nocte, Aspirin 75mg "
        "daily, Clopidogrel 75mg daily, Hydrochlorothiazide 12.5mg daily, Gabapentin 300mg at night "
        "for neuropathic pain, and an as-required short-acting inhaler. Patient reports intermittent "
        "adherence over the past three months and is unsure of the last dose taken today.",
    ],
    "allergies": [
        "NKDA",
        "Penicillin — rash. Sulfa drugs — reported intolerance.",
        "Penicillin — widespread urticarial rash documented in 2014, no airway involvement. Sulfa "
        "drugs — reported gastrointestinal intolerance rather than true allergy. Adhesive dressings — "
        "local skin reaction. No known food or latex allergy.",
    ],
    "chief_complaint": [
        "Chest pain",
        "Chest pain with associated shortness of breath and sweating",
        "Central chest pain radiating to the left arm with associated shortness of breath, nausea and "
        "sweating, worsening over 40 minutes",
    ],
    "primary_diagnosis": [
        "Acute coronary syndrome",
        "Acute coronary syndrome — suspected STEMI",
        "Acute coronary syndrome — suspected ST-elevation myocardial infarction, anterior territory, "
        "with ongoing chest pain and autonomic features at handover",
    ],
    "rht_refusal_reason": [
        "Patient feels better and will consult own GP in the morning.",
        "Patient states symptoms have resolved and declines transport, intending to consult their own "
        "general practitioner in the morning. Risks of non-conveyance explained and understood.",
        "Patient states symptoms have fully resolved and declines both further assessment and "
        "transport, intending to consult their own general practitioner in the morning. The reasons "
        "transport was recommended were explained in the patient's home language, together with the "
        "specific risks of non-conveyance including deterioration, collapse and death, and the "
        "patient repeated these back in their own words. Patient is alert, orientated, has no "
        "evidence of intoxication or head injury and was assessed as having capacity to refuse. A "
        "family member was present throughout and was given the same explanation. Patient was advised "
        "to call again without hesitation should symptoms return, and the emergency number was left "
        "in writing on the kitchen counter.",
    ],
}

# ── Tier 3: the overfill band's prose ──────────────────────────────────────
# Built by CONTINUING each tier-2 answer rather than repeating or padding it,
# so the result is still one coherent clinical account and still exercises real
# wrapping. Lorem or a repeated paragraph would measure the renderer against
# text no crew would ever produce, and the whole point of this band is to find
# out what the form does with a crew who genuinely wrote a lot.
PROSE_TIER3_EXTRA = {
    "events_hpi":
        " On direct questioning the patient denies any preceding viral illness, recent dental work or "
        "invasive procedure. There is no history of intravenous drug use and no recent hospital "
        "admission. The pain has not changed with position or with deep inspiration at any point. A "
        "neighbour present at onset confirms the patient was ambulant and speaking normally immediately "
        "beforehand, and describes no seizure activity, no incontinence and no head strike during the "
        "episode. The patient took no analgesia of their own before the crew arrived beyond the single "
        "sublingual nitrate already noted. Repeat questioning at the receiving unit produced the same "
        "account without variation.",
    "findings_on_arrival":
        " On repeat assessment ten minutes after the initial survey the patient remained alert and "
        "orientated with no change in conscious level. Peripheral perfusion improved slightly following "
        "oxygen and analgesia, with capillary refill shortening and the skin becoming less clammy. Chest "
        "auscultation was repeated in four zones anteriorly and two posteriorly with no interval change "
        "and no new crackles at the bases. There was no jugular venous distension at forty-five degrees "
        "and no hepatojugular reflux. Calves remained soft and non-tender with no asymmetry.",
    "management_notes":
        " A second 12-lead was acquired en route at the twelve-minute mark and compared against the "
        "first, with no interval change in ST segments and no new arrhythmia; both traces accompanied "
        "the patient. Oxygen was weaned in step with saturations once they had held above 94 per cent "
        "for five consecutive minutes. The receiving unit was updated by radio twice during transport "
        "with an amended estimated time of arrival. On arrival a full verbal handover was given using "
        "the ATMIST structure, covering age, time of onset, mechanism, injuries and findings, vital "
        "signs and treatment given, and questions were invited and answered before the crew cleared.",
    "past_medical_history":
        " Immunisation history reported as complete for the childhood schedule with an additional "
        "tetanus booster in 2019 following a garden injury. No previous adverse reaction to anaesthesia "
        "in the patient or in any first-degree relative. Family history of ischaemic heart disease in "
        "both the father, who sustained a fatal myocardial infarction at fifty-eight, and a paternal "
        "uncle who underwent bypass grafting in his early sixties. The patient lives independently in a "
        "single-storey dwelling, manages all activities of daily living unaided, and has no recorded "
        "cognitive impairment.",
    "current_medications":
        " Patient additionally reports occasional over-the-counter ibuprofen for joint pain, taken "
        "perhaps twice a week and not disclosed at the last clinic review, and a herbal preparation "
        "obtained informally whose contents they cannot name. Compliance aids are not in use. Repeat "
        "prescriptions are collected monthly by a family member and the patient is uncertain whether "
        "the most recent collection has been made.",
    "allergies":
        " A reaction to iodine-based contrast was reported by a relative but is not documented in any "
        "record the crew could access and the patient does not recall it; it is recorded as unconfirmed "
        "so the receiving unit can verify before imaging rather than discover it during a procedure.",
    "chief_complaint":
        ", with associated nausea and a single episode of vomiting shortly before the crew arrived",
    "primary_diagnosis":
        ", differential including pulmonary embolism and aortic dissection, neither excluded "
        "pre-hospital",
    "rht_refusal_reason":
        " The conversation was repeated a second time after a ten-minute interval to allow the patient "
        "to reconsider, and their answer did not change. The crew remained on scene throughout that "
        "interval and reassessed observations before departing, all of which were within normal limits "
        "and are recorded above.",
}
for _k, _extra in PROSE_TIER3_EXTRA.items():
    if _k in PROSE:
        PROSE[_k].append(PROSE[_k][2] + _extra)
    else:                       # a PROSE key was renamed and this went stale
        raise SystemExit(f"PROSE_TIER3_EXTRA names '{_k}', which PROSE does not have")


def sa_id(dob: datetime, female: bool) -> str:
    """13-digit SA ID with a correct Luhn check digit."""
    seq = random.randint(0, 4999) if female else random.randint(5000, 9999)
    base = f"{dob:%y%m%d}{seq:04d}08"
    total, alt = 0, False
    for ch in reversed(base):
        d = int(ch)
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return base + str((10 - total % 10) % 10)


def _cell() -> str:
    return f"08{random.choice('236')} {random.randint(100,999)} {random.randint(1000,9999)}"


def _land() -> str:
    return f"01{random.randint(1,6)} {random.randint(100,999)} {random.randint(1000,9999)}"


class Person:
    """One generated identity, reused across every field that names the patient."""

    def __init__(self, when: datetime):
        self.female = random.random() < 0.5
        self.first = random.choice(FIRST_F if self.female else FIRST_M)
        self.surname = random.choice(SURNAMES)
        self.dob = datetime(1938, 1, 1, tzinfo=timezone.utc) + timedelta(days=random.randint(0, 31000))
        self.age = int((when - self.dob).days / 365.25)
        self.suburb, self.code = random.choice(SUBURBS)
        self.address = f"{random.randint(1, 2400)} {random.choice(STREETS)}"
        self.id_number = sa_id(self.dob, self.female)
        self.use_passport = random.random() < 0.10
        self.passport = f"{random.choice('ABDEMNP')}{random.randint(1000000, 9999999)}"
        self.cell, self.home = _cell(), _land()
        self.gender = "Female" if self.female else "Male"

    @property
    def full(self) -> str:
        return f"{self.first} {self.surname}"


# Row shapes lifted from whichever reference PRF captured the richest one, so a
# template that recorded no medications can still be grown to sixteen of them
# with the exact keys the renderer reads. Filled by _collect_donors().
DONOR: dict[str, dict] = {}


def _collect_donors(tpls: dict) -> None:
    """Remember the widest row of each repeating table across all templates.
    Widest, not first: a row with more keys populated is the one that renders
    every column, and a narrow donor would silently print half-empty tables."""
    for field in ("vitals_sets", "iv_therapy", "medications"):
        best = None
        for prf in tpls.values():
            for row in (prf.form_data or {}).get(field) or []:
                if isinstance(row, dict) and (best is None or len(row) > len(best)):
                    best = row
        if best is not None:
            DONOR[field] = copy.deepcopy(best)


def _fit(rows: list, target: int | None, field: str = "") -> list:
    """Grow or trim a repeating table to `target` rows, reusing the template's own
    row as the shape so every added row carries exactly the keys the renderer
    reads. Falls back to the donor shape when the template captured none."""
    if target is None:
        return rows
    shapes = [r for r in rows if isinstance(r, dict)]
    if not shapes:
        donor = DONOR.get(field)
        if donor is None:
            return rows
        shapes = [donor]
        rows = []
    if target <= len(rows):
        return rows[:target]
    out = list(rows)
    while len(out) < target:
        clone = copy.deepcopy(shapes[len(out) % len(shapes)])
        # Drop embedded images from ADDED rows only. A per-row signature is real,
        # but pasting the same 15 kB PNG into sixteen medication rows would put a
        # quarter-megabyte of duplicate image into every record and measure the
        # renderer's appetite for base64 rather than its layout. vary_rows writes
        # the practitioner's name into the cleared field.
        for k, v in list(clone.items()):
            if isinstance(v, str) and v.startswith("data:"):
                clone[k] = ""
        out.append(clone)
    return out


def vary_vitals(sets: list, when: datetime, target: int | None = None) -> list:
    """Keep the template's vitals STRUCTURE (its exact keys) and replace only the
    measured values. gcs_total is derived — a blank total beside three filled
    components reads as a broken form."""
    severity = random.choices(["routine", "moderate", "critical"], weights=[55, 32, 13])[0]
    sets = _fit(sets, target, "vitals_sets")
    out = []
    for i, s in enumerate(sets):
        if not isinstance(s, dict):
            out.append(s)
            continue
        n = copy.deepcopy(s)
        if severity == "critical":
            e, v, m = random.choice([(3, 2, 4), (2, 2, 3), (4, 3, 5)])
            hr, rr, spo2, bp, perf, cap = random.randint(115, 140), random.randint(26, 34), random.randint(84, 92), "88/54", "Poor", "> 2sec"
        elif severity == "moderate":
            e, v, m = 4, random.choice([4, 5]), 6
            hr, rr, spo2, bp, perf, cap = random.randint(95, 115), random.randint(20, 26), random.randint(93, 96), "135/88", "Pale", "> 2sec"
        else:
            e, v, m = 4, 5, 6
            hr, rr, spo2, bp, perf, cap = random.randint(66, 92), random.randint(12, 18), random.randint(97, 100), "126/78", "Well Perfused", "< 2sec"
        vals = {
            "time": f"{when + timedelta(minutes=8 * i):%H:%M}", "resp_rate": str(rr), "hr": str(hr),
            "spo2": str(spo2), "bp": bp, "perfusion": perf, "cap_refill": cap,
            "gcs_e": str(e), "gcs_v": str(v), "gcs_m": str(m), "gcs_total": str(e + v + m),
            "hgt": f"{random.uniform(4.2, 9.4):.1f}", "temp": f"{random.uniform(36.1, 38.6):.1f}",
            "pain": str(random.randint(0, 9)),
            "ecg": random.choice(["NSR", "Sinus Tachy", "Sinus Brady", "AF"]),
        }
        for k, val in vals.items():
            if k in n:            # only fields the template itself carries
                n[k] = val
        out.append(n)
    return out


def vary_rows(rows: list, when: datetime, crew_name: str, qual: str, kind: str,
              target: int | None = None) -> list:
    rows = _fit(rows, target, "iv_therapy" if kind == "iv" else "medications")
    out = []
    for i, r in enumerate(rows):
        if not isinstance(r, dict):
            out.append(r)
            continue
        n = copy.deepcopy(r)
        if kind == "iv":
            new = {"type": random.choice(FLUIDS), "jelco_size": random.choice(["16g", "18g", "20g"]),
                   "site": random.choice(["Left ACF", "Right ACF", "Left dorsum of hand", "Right forearm"]),
                   "vol_infused": random.choice(["250", "500", "1000"]),
                   # Stagger down the table: sixteen medications all stamped the
                   # same minute is the tell that a record was generated.
                   "time_up": f"{when + timedelta(minutes=6 + 4 * i):%H:%M}",
                   "indication": random.choice(["Fluid resuscitation", "Maintenance", "Medication route"])}
        else:
            drug, dose, route = random.choice(DRUGS)
            new = {"type": drug, "dose": dose, "route": route,
                   "time": f"{when + timedelta(minutes=10 + 3 * i):%H:%M}",
                   "reason": f"Medication Administered via {route}"}
        for k, v in new.items():
            if k in n:
                n[k] = v
        for k in ("sign", "administered_by"):
            if k in n and not str(n.get(k, "")).startswith("data:"):
                n[k] = crew_name
        if "administered_by_qualification" in n:
            n["administered_by_qualification"] = qual
        out.append(n)
    return out


def build_from_template(tpl_fd: dict, when: datetime, band: str | None = None,
                        tname: str = "") -> tuple[dict, dict]:
    """Deep-copy the template's form_data, then overwrite ONLY what must differ.
    Anything not named here is preserved exactly as the crew captured it.

    `band` (a DENSITY_BANDS key) additionally sizes the record: it grows the
    three repeating tables and swaps the free-text answers for a longer tier, so
    the set spans from a quiet call to the largest one the form can hold."""
    fd = copy.deepcopy(tpl_fd)
    p = Person(when)
    crew1, q1, h1 = random.choice(CREW)
    crew2, q2, h2 = random.choice([c for c in CREW if c[0] != crew1])
    scheme = random.choice(SCHEMES)
    member = str(random.randint(1000000, 9999999))
    complaint, diagnosis, hpi = random.choice(COMPLAINTS)
    facility = random.choice(FACILITIES)

    def put(key: str, value) -> None:
        """Only overwrite keys the template actually has — never invent one."""
        if key in fd:
            fd[key] = value

    # ── identity ───────────────────────────────────────────────────────────
    put("gender", p.gender)
    put("patient_name", p.first)
    put("patient_surname", p.surname)
    put("patient_dob", f"{p.dob:%Y-%m-%d}")
    put("age", str(p.age))
    put("patient_address", p.address)
    put("patient_suburb", p.suburb)
    put("patient_postal_code", p.code)
    put("patient_phone_cell", p.cell)
    put("patient_phone_home", p.home)
    put("patient_phone_work", _land())
    if p.use_passport and "patient_passport_number" in fd:
        put("patient_passport_number", p.passport)
        if "patient_id_number" in fd:
            fd["patient_id_number"] = ""
    else:
        put("patient_id_number", p.id_number)
        if "patient_passport_number" in fd:
            fd["patient_passport_number"] = ""

    # Debtor: a distinct person where the template captured one.
    if any(k in fd for k in ("debtor_name", "debtor_surname", "debtor_id_number")):
        d = Person(when)
        put("debtor_gender", d.gender)
        put("debtor_name", d.first)
        put("debtor_surname", d.surname)
        put("debtor_id_number", d.id_number)
        put("debtor_dob", f"{d.dob:%Y-%m-%d}")
        put("debtor_age", str(d.age))
        put("debtor_address", d.address)
        put("debtor_suburb", d.suburb)
        put("debtor_postal_code", d.code)
        put("debtor_phone_cell", d.cell)
        put("debtor_phone_home", d.home)
        if "debtor_passport_number" in fd:
            fd["debtor_passport_number"] = ""

    # Declaration of death names the deceased instead of a patient.
    if fd.get("med_aid_dec_death"):
        put("med_aid_dec_death_deceased_first_name", p.first)
        put("med_aid_dec_death_deceased_surname", p.surname)
        put("med_aid_dec_death_deceased_gender", p.gender)
        put("med_aid_dec_death_deceased_id", p.id_number)
        put("med_aid_dec_death_deceased_dob", f"{p.dob:%Y-%m-%d}")
        put("med_aid_dec_death_deceased_age", str(p.age))
        put("med_aid_dec_death_deceased_address", p.address)
        put("med_aid_dec_death_deceased_suburb", p.suburb)
        put("med_aid_dec_death_deceased_postal_code", p.code)
        put("med_aid_dec_death_deceased_cell", p.cell)
        put("med_aid_dec_death_deceased_tel_home", p.home)
        put("med_aid_dec_death_deceased_passport", "")
        put("med_aid_dec_death_date", f"{when:%Y-%m-%d}")
        put("med_aid_dec_death_time", f"{when:%H:%M}")
        put("med_aid_dec_death_crew_attended_name", crew1)
        put("med_aid_dec_death_signatory_name", crew1)

    # ── scheme / payer ─────────────────────────────────────────────────────
    put("medical_scheme", scheme)
    put("scheme_option", random.choice(PLANS))
    put("plan_option", random.choice(PLANS))
    put("medical_aid_number", member)
    put("main_member_id", p.id_number)
    put("main_member_name", p.full)
    put("dependent_number", f"{random.randint(0, 6):02d}")
    put("dependent_code", f"{random.randint(0, 6):02d}")
    if "post_auth_number" in fd and fd.get("post_auth_number"):
        put("post_auth_number", f"A{random.randint(100000, 999999)}")

    # ── scene / destination ────────────────────────────────────────────────
    put("incident_location", f"{random.randint(1, 900)} {random.choice(STREETS)}, {p.suburb.split()[0]}")
    put("suburb_ward", p.suburb)
    put("receiving_facility", facility)
    put("ward", random.choice(WARDS))
    put("receiving_doctor", random.choice(DOCTORS))
    put("referring_doctor", random.choice(DOCTORS))

    # ── clinical narrative ─────────────────────────────────────────────────
    put("chief_complaint", complaint)
    put("primary_diagnosis", diagnosis)
    put("events_hpi", hpi)
    put("allergies", random.choice(["NKDA", "NKDA", "Penicillin", "Sulfa drugs", "Aspirin"]))
    put("current_medications", random.choice(["None", "Metformin 850mg BD", "Enalapril 10mg daily",
                                              "Salbutamol PRN", "Warfarin 5mg daily"]))
    put("past_medical_history", random.choice(["Nil of note", "Hypertension", "Type 2 Diabetes Mellitus",
                                               "Asthma", "Previous MI 2021", "Epilepsy"]))
    put("last_meal", random.choice(["Breakfast 07:00", "Lunch 13:00", "Nil since midnight", "Supper 19:30"]))
    put("last_meal_time", f"{when - timedelta(hours=random.randint(1, 8)):%H:%M}")

    # ── crew ───────────────────────────────────────────────────────────────
    put("assessed_by", crew1)
    put("assessor_qualifications", q1)
    put("managed_by", crew2)
    put("manager_qualifications", q2)
    put("treating_practitioner_name", crew1)
    put("treating_practitioner_hpcsa", h1)
    put("treating_practitioner_category", q1)

    # ── structured rows: keep the template's shape, vary the readings ───────
    # With a density band the tables are sized to it (growing from the donor
    # shape when this template captured none); without one they keep exactly the
    # rows the crew recorded, which is the original behaviour.
    b = DENSITY_BANDS.get(band or "", None)
    clinical = bool(b) and tname in CLINICAL_TEMPLATES
    # The band's iv/med figure is a CEILING, not a quota. Owner's instruction,
    # 2026-08-17: "2 or none or 1 or even 3". Drawing 0..ceiling per record is
    # what a real day looks like — plenty of calls run no line and give no drug
    # at all — and it exercises the renderer's empty-section paths, which a
    # fixed count never would. Observation sets are NOT drawn this way: they are
    # what the layout stress rests on now that the drug tables are capped.
    draw = {}
    if clinical:
        draw["iv"] = random.randint(0, b["iv"])
        draw["med"] = random.randint(0, b["med"])
        draw["vitals"] = b["vitals"]
    for field, key, fn in (("vitals_sets", "vitals", "vitals"),
                           ("iv_therapy", "iv", "iv"),
                           ("medications", "med", "med")):
        cur = fd.get(field)
        # A clinical call type that never captured this table at all still gets
        # one built from the donor: "no medications key" is the commonest shape
        # among the references and would otherwise cap the whole set at the two
        # rows one template happened to record.
        if cur is None and clinical:
            cur = []
        if not isinstance(cur, list):
            continue
        target = draw[key] if clinical else None
        if not cur and target is None:
            continue
        if fn == "vitals":
            fd[field] = vary_vitals(cur, when, target)
        else:
            fd[field] = vary_rows(cur, when, crew1, q1, fn, target)

    # ── refusal wording ────────────────────────────────────────────────────
    if fd.get("patient_refused_treatment"):
        put("rht_refusal_reason", random.choice([
            "Patient feels better and will consult own GP in the morning.",
            "Declined transport, family will take patient privately.",
            "Refused assessment, states no injury sustained.",
        ]))
        put("rht_waiver_date", f"{when:%Y-%m-%d}")
        put("rht_waiver_signatory_name", p.full)
        put("rht_waiver_witness_name", f"Const. {random.choice('KMTS')}. {random.choice(SURNAMES)}, SAPS")

    # ── prose tier ─────────────────────────────────────────────────────────
    # LAST, deliberately: the refusal block above writes a short reason of its
    # own, and an earlier pass here would be silently overwritten on exactly the
    # call type (RHT) whose sheet is driven by how much the crew wrote.
    #
    # This is also the one place that will ADD a key the template did not carry,
    # a deliberate exception to the preserve-by-default rule. A crew leaving
    # "Findings on arrival" blank is the case this data set must NOT be limited
    # to — the sheet only reaches its limits when they fill it in. Every key
    # below is one PRFView renders.
    if b:
        tier = b["text"]
        for key, tiers in PROSE.items():
            if key.startswith("rht_") and not fd.get("patient_refused_treatment"):
                continue
            fd[key] = tiers[tier]

    # The marker doubles as the band label, so "show me every extreme record"
    # is one query. Teardown only tests it for NOT NULL, which a string satisfies
    # exactly as the boolean the earlier batches carry.
    fd[MARKER] = band or True

    mirror = {
        "patient_name": p.full,
        "patient_id_number": fd.get("patient_id_number") or None,
        "medical_scheme_name": fd.get("medical_scheme") or None,
        "scheme_member_number": fd.get("medical_aid_number") or None,
        "preauth_number": fd.get("post_auth_number") or None,
    }
    return fd, mirror


def shift_times(tpl: DigitalPRF, when: datetime) -> dict:
    """Re-anchor the template's timestamps at a new call, KEEPING its intervals —
    a transfer should still take as long as a transfer."""
    present = [(c, getattr(tpl, c)) for c in TIME_COLS if getattr(tpl, c, None)]
    if not present:
        return {}
    base = min(v for _, v in present)
    return {c: when + (v - base) for c, v in present}


def shift_kms(tpl: DigitalPRF, start: int) -> dict:
    """Same for the odometer: preserve the distances, move the starting reading."""
    present = [(c, getattr(tpl, c)) for c in KM_COLS if getattr(tpl, c, None) is not None]
    if not present:
        return {}
    base = min(Decimal(str(v)) for _, v in present)
    return {c: Decimal(start) + (Decimal(str(v)) - base) for c, v in present}


async def _resolve_provider(db, ident: str) -> ServiceProvider:
    rows = (await db.execute(select(ServiceProvider).where(
        (ServiceProvider.prf_name == ident) | (ServiceProvider.slug == ident)
        | (ServiceProvider.name == ident)))).scalars().all()
    if not rows:
        raise SystemExit(f"No provider matches '{ident}'.")
    if len(rows) > 1:
        raise SystemExit(f"'{ident}' matches {len(rows)} providers.")
    return rows[0]


async def _load_templates(db, provider) -> dict:
    """The reference PRFs, keyed by the display name their case carries."""
    rows = (await db.execute(
        select(DigitalPRF, Case.custom_display_name)
        .join(Case, Case.id == DigitalPRF.case_id)
        .where(DigitalPRF.provider_id == provider.id))).all()
    found = {}
    for prf, label in rows:
        name = (label or "").strip()
        if name in TEMPLATE_NAMES:
            found[name] = prf
    return found


async def cmd_templates(args) -> None:
    S = async_sessionmaker(engine, expire_on_commit=False)
    async with S() as db:
        provider = await _resolve_provider(db, args.provider)
        tpls = await _load_templates(db, provider)
        print(f"\n  Reference PRFs on {provider.name}:\n")
        for name in TEMPLATE_NAMES:
            t = tpls.get(name)
            if not t:
                print(f"    {name:10} MISSING — no case named exactly '{name}'")
                continue
            fd = t.form_data or {}
            times = sum(1 for c in TIME_COLS if getattr(t, c, None))
            kms = sum(1 for c in KM_COLS if getattr(t, c, None) is not None)
            sigs = sum(1 for c in SIG_COLS if getattr(t, c, None))
            imgs = sum(1 for v in fd.values() if isinstance(v, str) and v.startswith("data:"))
            print(f"    {name:10} #{t.prf_number:<4} call_type={str(fd.get('call_type')):9} "
                  f"keys={len(fd):<4} times={times}/9 kms={kms}/9 sigs={sigs}/5 images={imgs}")
        missing = [n for n in TEMPLATE_NAMES if n not in tpls]
        print(f"\n  {len(tpls)}/{len(TEMPLATE_NAMES)} templates found"
              + (f" — MISSING: {', '.join(missing)}" if missing else "") + "\n")
    await engine.dispose()


async def run(args) -> None:
    S = async_sessionmaker(engine, expire_on_commit=False)
    random.seed(args.rand_seed)

    async with S() as db:
        provider = await _resolve_provider(db, args.provider)
        tpls = await _load_templates(db, provider)
        missing = [n for n in TEMPLATE_NAMES if n not in tpls]
        if missing:
            raise SystemExit(f"Missing reference PRFs: {', '.join(missing)}. Run --templates.")
        existing = (await db.execute(select(func.count()).select_from(DigitalPRF)
                                     .where(DigitalPRF.provider_id == provider.id))).scalar()
        base_no = (await db.execute(select(func.coalesce(func.max(DigitalPRF.prf_number), 0))
                                    .where(DigitalPRF.provider_id == provider.id,
                                           DigitalPRF.correction_of_id.is_(None)))).scalar() or 0
        base_no = max(base_no, provider.prf_start_number or 0)
        # Detach the templates: the session is reused below and a lazy attribute
        # access after expiry would re-query mid-loop.
        tpl_data = {n: (t.prf_number, copy.deepcopy(t.form_data or {}),
                        {c: getattr(t, c) for c in TIME_COLS},
                        {c: getattr(t, c) for c in KM_COLS},
                        {c: getattr(t, c) for c in SIG_COLS},
                        t.vehicle_id, t.crew_member_1_id, t.crew_member_2_id)
                    for n, t in tpls.items()}
        tpl_objs = {n: t for n, t in tpls.items()}
        _collect_donors(tpls)

    names = list(TEMPLATE_MIX)
    weights = [TEMPLATE_MIX[n] for n in names]
    picks = random.choices(names, weights=weights, k=args.count)
    counts = {n: picks.count(n) for n in names}

    if args.fill == "matrix":
        bnames = list(DENSITY_MIX)
        bands = random.choices(bnames, weights=[DENSITY_MIX[b] for b in bnames], k=args.count)
    else:
        bands = [None] * args.count
    bcounts = {b: bands.count(b) for b in DENSITY_MIX}

    print(f"\n  Provider     : {provider.name}")
    print(f"  Existing PRFs: {existing}  (numbers up to #{base_no})")
    print(f"  Will create  : {args.count}, numbered #{base_no+1}–#{base_no+args.count}")
    print(f"  Dated across : the last {args.spread_days} days")
    print("  Cloned from  : " + ", ".join(
        f"{n}(#{tpl_data[n][0]})×{counts[n]}" for n in names if counts[n]))
    print(f"  Copied as-is : signatures, hospital sticker, vehicle + crew links, all other keys")
    print(f"  Overwritten  : identity, times, kms, clinical values, scheme, facility, crew")
    if args.fill == "matrix":
        print("  Fill density : " + ", ".join(
            f"{b}×{bcounts[b]} (iv {DENSITY_BANDS[b]['iv']}/med {DENSITY_BANDS[b]['med']}"
            f"/vitals {DENSITY_BANDS[b]['vitals']})" for b in DENSITY_MIX if bcounts[b]))
        print(f"                 clinical tables grown only on {', '.join(sorted(CLINICAL_TEMPLATES))}"
              " — RHT and DOD get the prose tiers only")
        print(f"  Donor rows   : " + ", ".join(f"{k}({len(v)} keys)" for k, v in DONOR.items()))
    else:
        print("  Fill density : as captured (--fill matrix grades it for PDF limit testing)")
    print(f"  Marker       : form_data['{MARKER}'] = band  (+ manifest for teardown)")
    print(f"  Batch commit : every {args.batch} records")
    if args.plan:
        print("\n  --plan: nothing was written.\n")
        await engine.dispose()
        return

    now = datetime.now(timezone.utc)
    manifest = {"created_at": now.isoformat(), "provider_id": str(provider.id),
                "provider_name": provider.name, "marker": MARKER, "records": []}
    made = 0

    out = Path(args.manifest or f"demo_seed_manifest_{now:%Y%m%dT%H%M%SZ}.json")

    def flush_manifest() -> None:
        """Rewritten after every batch, never only at the end. A run interrupted
        at record 9,000 must still leave a manifest that covers what was
        committed — otherwise those records exist with no handle to remove them
        but the marker, and teardown cross-checks the two against each other."""
        out.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    async with S() as db:
        for i, (tname, band) in enumerate(zip(picks, bands), start=1):
            tpl = tpl_objs[tname]
            when = now - timedelta(days=random.uniform(0, args.spread_days),
                                   hours=random.uniform(0, 24))
            number = base_no + i
            fd, mirror = build_from_template(tpl_data[tname][1], when, band, tname)

            prf = DigitalPRF(
                provider_id=provider.id, prf_number=number, status=PRFStatus.DRAFT,
                case_number=f"{(provider.slug or 'PRF').upper()[:35]}-{when:%Y}-{when:%m}-{number:06d}",
                form_data=fd, created_at=when, updated_at=when,
                vehicle_id=tpl.vehicle_id,
                crew_member_1_id=tpl.crew_member_1_id,
                crew_member_2_id=tpl.crew_member_2_id,
            )
            for col, val in shift_times(tpl, when).items():
                setattr(prf, col, val)
            for col, val in shift_kms(tpl, random.randint(40_000, 260_000)).items():
                setattr(prf, col, val)
            # Signatures are copied verbatim, by the owner's decision: a demo
            # record showing "Not captured" where a signature belongs reads as
            # broken software rather than as demo data.
            for col in SIG_COLS:
                v = getattr(tpl, col, None)
                if v:
                    setattr(prf, col, v)
            db.add(prf)
            await db.flush()

            case = Case(
                patient_name=(mirror["patient_name"] or "Unknown")[:255],
                patient_id_number=mirror["patient_id_number"],
                medical_scheme_name=mirror["medical_scheme_name"],
                scheme_member_number=(mirror["scheme_member_number"] or None),
                preauth_number=(mirror["preauth_number"] or None),
                dispatch_type=("IFT" if (fd.get("call_type") or "").upper()
                               in ("TRANSFER", "IHT", "IFT", "RHT", "COURTESY") else "Primary"),
                incident_date=when.date(), created_at=when, updated_at=when,
            )
            db.add(case)
            await db.flush()

            document = Document(
                case_id=case.id, original_filename=f"PRF-{number}.json",
                storage_uri=f"digital-prf://{prf.id}", document_type="Digital PRF",
                ocr_status=OCRStatus.COMPLETED, ocr_confidence_avg=1.0,
                needs_hitl_review=False,          # THE gate for the management queue
                created_at=when, updated_at=when)
            db.add(document)
            await db.flush()

            claim = Claim(case_id=case.id, total_amount=0,
                          target_scheme=fd.get("medical_scheme"),
                          adjudication_status=AdjudicationStatus.PENDING,
                          created_at=when, updated_at=when)
            db.add(claim)
            await db.flush()

            prf.case_id = case.id
            prf.document_id = document.id
            prf.status = PRFStatus.PROCESSED
            prf.submitted_at = when
            prf.processing_error = None

            manifest["records"].append({
                "prf_id": str(prf.id), "prf_number": number, "case_id": str(case.id),
                "document_id": str(document.id), "claim_id": str(claim.id),
                "template": tname, "band": band})
            made += 1

            # Commit and release in batches. Held to the end, 15,000 records of
            # ~65 kB each sit in the identity map at once and the process grows
            # past a gigabyte before anything reaches the database.
            if made % args.batch == 0:
                flush_manifest()
                await db.commit()
                db.expunge_all()
                print(f"    ... {made}/{args.count} committed")

        flush_manifest()
        await db.commit()

    print(f"\n  Created {made} PRFs (+ case, document, claim each).")
    print(f"  Manifest: {out.resolve()}")
    print(f"  Remove with:  python seed_demo_prfs.py --teardown {out.name} --yes\n")
    await engine.dispose()


async def teardown(path: str, yes: bool) -> None:
    man = json.loads(Path(path).read_text(encoding="utf-8"))
    recs = man["records"]
    prf_ids = [r["prf_id"] for r in recs]
    case_ids = [r["case_id"] for r in recs]
    doc_ids = [r["document_id"] for r in recs]
    claim_ids = [r["claim_id"] for r in recs]
    print(f"\n  Manifest : {path}")
    print(f"  Provider : {man['provider_name']}")
    print(f"  Records  : {len(recs)} PRFs / cases / documents / claims")

    S = async_sessionmaker(engine, expire_on_commit=False)
    async with S() as db:
        found = (await db.execute(select(func.count()).select_from(DigitalPRF)
                                 .where(DigitalPRF.id.in_([uuid.UUID(x) for x in prf_ids])))).scalar()
        marked = (await db.execute(text(
            "select count(*) from digital_prfs where id = any(cast(:ids as uuid[])) "
            "and (form_data ->> :m) is not null"), {"ids": prf_ids, "m": MARKER})).scalar()
        print(f"  Present in DB: {found}    carrying the '{MARKER}' marker: {marked}")
        if found != marked:
            raise SystemExit(f"  ABORT: {found - marked} manifest record(s) do NOT carry the marker.")
        if not yes:
            print("\n  Re-run with --yes to delete.\n")
            await engine.dispose()
            return
        stmts = [
            ("claim_lines", "delete from claim_lines where claim_id = any(cast(:c as uuid[]))", {"c": claim_ids}),
            ("rfis", "delete from rfis where claim_id = any(cast(:c as uuid[]))", {"c": claim_ids}),
            ("eras", "delete from eras where claim_id = any(cast(:c as uuid[]))", {"c": claim_ids}),
            ("edi_submissions", "delete from edi_submissions where claim_id = any(cast(:c as uuid[]))", {"c": claim_ids}),
            ("scheme_auth_requests", "delete from scheme_auth_requests where claim_id = any(cast(:c as uuid[])) "
                                     "or case_id = any(cast(:k as uuid[]))", {"c": claim_ids, "k": case_ids}),
            ("claims.amended_by_id", "update claims set amended_by_id = null where amended_by_id = any(cast(:c as uuid[]))", {"c": claim_ids}),
            ("claims", "delete from claims where id = any(cast(:c as uuid[]))", {"c": claim_ids}),
            ("prf.correction_of_id", "update digital_prfs set correction_of_id = null where correction_of_id = any(cast(:p as uuid[]))", {"p": prf_ids}),
            ("digital_prfs", "delete from digital_prfs where id = any(cast(:p as uuid[]))", {"p": prf_ids}),
            ("documents", "delete from documents where id = any(cast(:d as uuid[]))", {"d": doc_ids}),
            ("cases", "delete from cases where id = any(cast(:k as uuid[]))", {"k": case_ids}),
        ]
        for label, sql, params in stmts:
            res = await db.execute(text(sql), params)
            print(f"    {label:24} {res.rowcount}")
        await db.commit()

    async with S() as db:
        left = (await db.execute(select(func.count()).select_from(DigitalPRF)
                                .where(DigitalPRF.id.in_([uuid.UUID(x) for x in prf_ids])))).scalar()
        lc = (await db.execute(select(func.count()).select_from(Case)
                              .where(Case.id.in_([uuid.UUID(x) for x in case_ids])))).scalar()
    print(f"\n  Residue: PRFs {left}, cases {lc}  -> {'CLEAN' if left == 0 and lc == 0 else 'INCOMPLETE'}\n")
    await engine.dispose()


def main() -> None:
    ap = argparse.ArgumentParser(description="Clone reference PRFs into realistic demo records.")
    ap.add_argument("--provider")
    ap.add_argument("--count", type=int, default=500)
    ap.add_argument("--spread-days", type=int, default=45)
    ap.add_argument("--rand-seed", type=int, default=20260814)
    ap.add_argument("--manifest")
    ap.add_argument("--fill", choices=["real", "matrix"], default="real",
                    help="real: keep each template's own field count. "
                         "matrix: grade records across the DENSITY_BANDS so the "
                         "set spans a quiet call to the largest the form holds.")
    ap.add_argument("--batch", type=int, default=500,
                    help="commit every N records (keeps memory flat on big runs)")
    ap.add_argument("--templates", action="store_true", help="show the reference PRFs and exit")
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--seed", action="store_true")
    ap.add_argument("--teardown", metavar="MANIFEST")
    ap.add_argument("--yes", action="store_true")
    args = ap.parse_args()

    if args.teardown:
        asyncio.run(teardown(args.teardown, args.yes)); return
    if not args.provider:
        ap.error("--provider is required")
    if args.templates:
        asyncio.run(cmd_templates(args)); return
    if not (args.plan or args.seed):
        ap.error("pass --plan to preview, or --seed to write")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
