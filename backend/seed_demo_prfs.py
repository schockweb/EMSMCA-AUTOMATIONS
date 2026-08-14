"""
Seed (and remove) realistic demo PRFs for a client walkthrough.

    cd backend
    python seed_demo_prfs.py --provider EMSMCA --count 500 --plan      # show, write nothing
    python seed_demo_prfs.py --provider EMSMCA --count 500 --seed      # create
    python seed_demo_prfs.py --teardown demo_seed_manifest_<stamp>.json

WHY THIS EXISTS
---------------
A client needs to browse a realistic body of Patient Report Forms to satisfy
themselves the system works. Hand-capturing 500 is not possible, and the load
generator's PRFs are deliberately bloated filler that would embarrass us in
front of a client.

WHAT MAKES A PRF VISIBLE IN CASE MANAGEMENT — read this before changing anything
------------------------------------------------------------------------------
The Cases page always requests `queue=management`, and that filter is a subquery
over DOCUMENTS, not over cases or PRFs (api/cases.py):

    Case.id.in_(select(Document.case_id)
                .where(Document.needs_hitl_review == False,
                       Document.case_id.is_not(None)))

So a PRF + Case with no Document row is INVISIBLE — the client sees "No cases
yet" while the rows sit in the database. Every seeded record therefore gets the
full set the real pipeline creates (tasks/prf_processing.py):

    DigitalPRF  ->  Case  ->  Document (needs_hitl_review=False)  ->  Claim

and the PRF is finalised to PROCESSED with case_id + document_id set. Anything
left at SUBMITTED with a NULL case_id lights the red "N PRFs failed to process"
alarm on the Cases header ten minutes later, and the beat watchdog starts
re-enqueueing it into the live billing pipeline.

Exactly ONE DigitalPRF per case_id: the admin viewer uses scalar_one_or_none(),
so two PRFs sharing a case is a 500 the moment the client clicks "View PRF".

WHY THE ORM AND NOT RAW SQL
---------------------------
Three columns are TypeDecorators that transform on bind (form_data encrypts the
identifier keys, cases.patient_id_number likewise) and two before_insert
listeners derive the patient_id_hash that POPIA subject-access depends on. Raw
INSERTs bypass all of it and write plaintext identifiers with NULL hashes. The
Postgres enum labels are also the UPPERCASE member NAMES, so a hand-written
status='processed' raises InvalidTextRepresentationError.

REMOVAL IS DESIGNED IN, NOT BOLTED ON
-------------------------------------
The application refuses to delete anything past DRAFT ("submitted/processed
claims must never be deleted"), so seeded rows cannot be removed through the UI.
Two independent handles make teardown surgical:

  * every seeded form_data carries `_demo_seed` (underscore keys are preserved
    server-side and hidden from the crew form), and
  * a MANIFEST file lists every id created.

Teardown deletes only ids present in the manifest AND carrying the marker, so it
is structurally incapable of touching a record it did not create.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
import uuid
from datetime import datetime, timedelta, timezone
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

# ── Value pools ────────────────────────────────────────────────────────────
# Real South African schemes, hospitals and names. The crew form's own
# applyTestFill uses "Test *" placeholders and a single Durban address; that is
# fine for QA and unacceptable in front of a client.
SCHEMES = [
    "Discovery Health Medical Scheme", "Government Employees Medical Scheme (GEMS)",
    "Bonitas Medical Fund", "Momentum Health", "Medihelp", "Bestmed",
    "Fedhealth", "Profmed", "Polmed", "Medshield",
]
FACILITIES = [
    "Charlotte Maxeke Johannesburg Academic Hospital", "Chris Hani Baragwanath Academic Hospital",
    "Netcare Milpark Hospital", "Netcare Sunninghill Hospital", "Life Flora Hospital",
    "Life Fourways Hospital", "Mediclinic Morningside", "Steve Biko Academic Hospital",
    "Tembisa Provincial Tertiary Hospital", "Helen Joseph Hospital",
]
WARDS = ["casualty", "Resus 1", "ICU", "High Care", "Cath Lab 2", "Trauma Unit", "Maternity"]
SURNAMES = ["Ndlovu", "Mokoena", "Dlamini", "Nkosi", "Molefe", "Khumalo", "Sithole",
            "Mahlangu", "van der Merwe", "Botha", "Naidoo", "Pillay", "Adams", "Jacobs", "Mthembu"]
FIRST_M = ["Sipho", "Thabo", "Johan", "Pieter", "Ravi", "Ahmed", "Lunga", "Kagiso", "Andre", "Bongani"]
FIRST_F = ["Nomsa", "Thandi", "Lerato", "Anele", "Zanele", "Priya", "Ayesha", "Maria", "Chantel", "Naledi"]
SUBURBS = [("Sebokeng Unit 7", "1983"), ("Vanderbijlpark Central", "1900"), ("Soweto Orlando East", "1804"),
           ("Randburg Ferndale", "2194"), ("Benoni Northmead", "1501"), ("Centurion Lyttelton", "0157"),
           ("Roodepoort Florida", "1709"), ("Alberton New Redruth", "1449"), ("Midrand Halfway House", "1685")]
DOCTORS = ["Dr M. Nkosi", "Dr T. van Rensburg", "Dr A. Patel", "Dr L. Mokwena", "Dr S. Abrahams", "Dr K. Botha"]
CREW_NAMES = ["A. Mokoena", "T. Dlamini", "J. van Wyk", "P. Naidoo", "S. Khumalo", "M. Adams"]
QUALS = ["BAA", "AEA", "ECT", "ECA", "ANT", "ECP"]

COMPLAINTS = [
    ("Chest pain", "Acute coronary syndrome", "Central crushing chest pain radiating to left arm, onset 40 min prior."),
    ("Shortness of breath", "Acute exacerbation of asthma", "Progressive dyspnoea over 6 hours, audible wheeze, using accessory muscles."),
    ("Motor vehicle accident", "Polytrauma", "Restrained driver, frontal impact, moderate intrusion, ambulatory on scene."),
    ("Seizure", "Generalised tonic-clonic seizure", "Witnessed seizure lasting 3 minutes, post-ictal on arrival."),
    ("Abdominal pain", "Acute abdomen for investigation", "Right iliac fossa pain with guarding, nausea, no vomiting."),
    ("Collapse", "Syncope for investigation", "Sudden collapse at work, brief LOC, spontaneous recovery."),
    ("Fall", "Suspected neck of femur fracture", "Fall from standing, unable to weight-bear, shortened externally rotated leg."),
    ("Assault", "Head injury and lacerations", "Assault with blunt object, laceration to occiput, GCS 14 on arrival."),
    ("Difficulty breathing", "Community-acquired pneumonia", "Productive cough 4 days, febrile, reduced air entry right base."),
    ("Diabetic emergency", "Hypoglycaemia", "Found confused and diaphoretic, HGT 2.1 mmol/L, responded to dextrose."),
]

MECHANISMS = ["MVA (Motor Vehicle Accident)", "MBA (Motorbike Accident)", "PVA (Pedestrian vehicle accident)",
              "Assault — Blunt", "Fall", "Medical Emergency", "Sporting Injury", "Workplace / Industrial Accident"]
TRANSFER_SUBTYPES = ["Return Trip", "Social Transfer", "Hospital to Hospital", "Hospital to Residence",
                     "Hospital to Stepdown", "Residence to Hospital", "Psychiatric"]

# call_type -> weight. PRIMARY dominates in real EMS work; the rarer types are
# present so the client can see each layout, but not in unrealistic numbers.
CALL_MIX = [("PRIMARY", 46), ("IHT", 26), ("RHT", 9), ("WCA_IOD", 7),
            ("COURTESY", 5), ("RESUS", 4), ("DOD", 3)]


def _sa_id(dob: datetime, female: bool) -> str:
    """A 13-digit SA ID with a correct Luhn check digit."""
    seq = random.randint(0, 4999) if female else random.randint(5000, 9999)
    base = f"{dob:%y%m%d}{seq:04d}08"
    # Luhn over the first 12 digits.
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


def _vitals_set(t: datetime, severity: str) -> dict:
    """One vitals column. gcs_total is DERIVED — the crew never types it, and a
    blank total beside three filled components reads as a broken form."""
    if severity == "critical":
        e, v, m = random.choice([(3, 2, 4), (2, 2, 3), (4, 3, 5)])
        hr, rr, spo2, bp = random.randint(115, 140), random.randint(26, 34), random.randint(84, 92), "88/54"
        perf, cap = "Poor", "> 2sec"
    elif severity == "moderate":
        e, v, m = 4, random.choice([4, 5]), 6
        hr, rr, spo2, bp = random.randint(95, 115), random.randint(20, 26), random.randint(93, 96), "135/88"
        perf, cap = "Pale", "> 2sec"
    else:
        e, v, m = 4, 5, 6
        hr, rr, spo2, bp = random.randint(66, 92), random.randint(12, 18), random.randint(97, 100), "126/78"
        perf, cap = "Well Perfused", "< 2sec"
    return {
        "time": f"{t:%H:%M}", "resp_rate": str(rr), "rhythm": "Regular",
        "ae": "Bilat equal and clear", "spo2": str(spo2), "o2_percent": "",
        "hr": str(hr), "ecg": random.choice(["NSR", "Sinus Tachy", "Sinus Brady"]),
        "cap_refill": cap, "perfusion": perf, "bp": bp,
        "gcs_e": str(e), "gcs_v": str(v), "gcs_m": str(m), "gcs_total": str(e + v + m),
        "pupil_size_l": "3", "pupil_size_r": "3", "pupil_react": "Equal/Reactive",
        "neuro_def": "No", "hgt": f"{random.uniform(4.2, 8.9):.1f}",
        "temp": f"{random.uniform(36.1, 38.4):.1f}", "pain": str(random.randint(0, 9)),
        "vent_mode": "", "etco2": "", "tidal_vol": "", "min_vol": "", "peep_cpap": "", "pacing": "",
    }


def build_form_data(i: int, call_type: str, when: datetime) -> tuple[dict, dict]:
    """Return (form_data, case_mirror). case_mirror holds the values that must be
    copied onto the Case row — the Cases page searches the CASE columns, not the
    PRF blob, so a scheme name that lives only in form_data is unsearchable."""
    female = random.random() < 0.5
    first = random.choice(FIRST_F if female else FIRST_M)
    surname = random.choice(SURNAMES)
    # tz-aware: `when` carries a timezone, and subtracting a naive datetime from
    # it raises. Caught on the first rehearsal run.
    dob = datetime(1940, 1, 1, tzinfo=timezone.utc) + timedelta(days=random.randint(0, 30000))
    age = int((when - dob).days / 365.25)
    suburb, code = random.choice(SUBURBS)
    scheme = random.choice(SCHEMES)
    member_no = f"{random.randint(1000000, 9999999)}"
    complaint, diagnosis, hpi = random.choice(COMPLAINTS)
    severity = random.choices(["routine", "moderate", "critical"], weights=[55, 32, 13])[0]
    crew1, crew2 = random.sample(CREW_NAMES, 2)
    qual1 = random.choice(QUALS)

    fd: dict = {
        MARKER: True,                     # teardown handle; hidden from the crew form
        "call_type": call_type,
        "incident_location": f"{random.randint(1, 900)} {random.choice(['Rissik','Voortrekker','Church','Main','Klipfontein','Beyers Naude'])} Street, {suburb.split()[0]}",
        "suburb_ward": suburb,
        "gender": "Female" if female else "Male",
        "patient_name": first,
        "patient_surname": surname,
        "patient_dob": f"{dob:%Y-%m-%d}",
        "age": str(age),
        "patient_address": f"{random.randint(1, 2000)} {random.choice(['Emfuleni Drive','Chris Hani Road','Nelson Mandela Drive','Sunset Avenue'])}",
        "patient_suburb": suburb,
        "patient_postal_code": code,
        "patient_phone_cell": f"08{random.choice('236')} {random.randint(100,999)} {random.randint(1000,9999)}",
        "patient_phone_home": f"01{random.randint(1,6)} {random.randint(100,999)} {random.randint(1000,9999)}",
        "accompanying_persons_count": str(random.choice([0, 0, 1, 1, 2])),
        "assessed_by": crew1,
        "assessor_qualifications": qual1,
        "managed_by": crew2,
        "manager_qualifications": random.choice(QUALS),
        "assessment_level": {"BAA": "BLS", "AEA": "ILS", "ECT": "ILS", "ECA": "ILS",
                             "ANT": "ALS", "ECP": "ALS"}.get(qual1, "ILS"),
    }

    # Identity: SA ID for most, passport for a realistic minority of patients.
    if random.random() < 0.88:
        fd["patient_id_number"] = _sa_id(dob, female)
    else:
        fd["patient_passport_number"] = f"{random.choice('ABDEMNP')}{random.randint(1000000, 9999999)}"

    case_mirror = {"patient_name": f"{first} {surname}", "medical_scheme_name": None,
                   "scheme_member_number": None, "preauth_number": None,
                   "patient_id_number": fd.get("patient_id_number")}

    # ── Payer block. COURTESY carries NO billing_type at all; WCA_IOD carries a
    #    fifth value that is not in BILLING_TYPE_OPTS. Both are load-bearing:
    #    PRFView gates whole panels on them.
    if call_type == "COURTESY":
        pass
    elif call_type == "WCA_IOD":
        fd["billing_type"] = "WCA / IOD"
        fd["wca_employer_name"] = random.choice(["Sasol Mining", "ArcelorMittal SA", "Transnet Freight Rail",
                                                 "Anglo American Platinum", "Bidvest Facilities"])
        fd["wca_employee_number"] = f"EMP{random.randint(10000, 99999)}"
    else:
        opts = ["MED AID", "PVT"] if call_type in ("DOD", "RESUS") else ["MED AID", "MED AID", "RAF", "PVT"]
        bt = random.choice(opts)
        fd["billing_type"] = bt
        if bt == "MED AID":
            fd["medical_scheme"] = scheme
            fd["medical_aid_number"] = member_no
            fd["main_member_name"] = f"{random.choice(FIRST_M + FIRST_F)} {surname}"
            fd["dependent_code"] = f"{random.randint(0, 6):02d}"
            fd["plan_option"] = random.choice(["Classic Saver", "Coastal Core", "Priority", "Essential", "Comprehensive"])
            if random.random() < 0.55:
                fd["post_auth_number"] = f"A{random.randint(100000, 999999)}"
                case_mirror["preauth_number"] = fd["post_auth_number"]
            case_mirror["medical_scheme_name"] = scheme
            case_mirror["scheme_member_number"] = member_no
        elif bt == "RAF":
            fd["raf_claim_number"] = f"RAF/{random.randint(2024, 2026)}/{random.randint(10000, 99999)}"
        elif bt == "PVT":
            fd["pvt_payment_method"] = random.choice(["Cash", "EFT", "Card", "Indigent"])
            if fd["pvt_payment_method"] == "Cash":
                amt = f"{random.choice([950, 1250, 1500, 1850, 2400])}.00"
                fd["pvt_cash_amount_paid"] = amt
                fd["pvt_cash_crew_received"] = amt
                fd["pvt_cash_payer_name"] = f"{first} {surname}"

    # ── Call-type specific shape ───────────────────────────────────────────
    if call_type == "IHT":
        fd["transfer_subtype"] = random.choice(TRANSFER_SUBTYPES)
        fd["referring_doctor"] = random.choice(DOCTORS)

    if call_type == "RHT":
        # A refusal has NO clinical page — vitals/IV/meds would never print.
        fd.update({
            "patient_refused_treatment": True,
            "rht_call_out_fee": "Refusal Of Treatment",
            "rht_refusal_reason": random.choice([
                "Patient feels better and will consult own GP in the morning.",
                "Declined transport, family will take patient privately.",
                "Refused assessment, states no injury sustained.",
            ]),
            "rht_waiver_date": f"{when:%Y-%m-%d}",
            "rht_waiver_signatory_name": f"{first} {surname}",
            "rht_waiver_witness_name": f"Const. {random.choice('KMTS')}. {random.choice(SURNAMES)}, SAPS",
            "rht_cap_alert": True, "rht_cap_no_impairment": True, "rht_cap_risks_explained": True,
            "rht_cap_questions": True, "rht_cap_advised_recall": True, "rht_cap_alternative_care": False,
        })
    elif call_type == "DOD":
        fd.update({
            "med_aid_dec_death": True,
            "med_aid_dec_death_date": f"{when:%Y-%m-%d}",
            "med_aid_dec_death_time": f"{when:%H:%M}",
            "med_aid_dec_death_location": fd["incident_location"],
            "med_aid_dec_death_identified_by": f"{random.choice(FIRST_F + FIRST_M)} {surname} (next of kin)",
            "med_aid_dec_death_deceased_first_name": first,
            "med_aid_dec_death_deceased_surname": surname,
            "med_aid_dec_death_deceased_gender": "Female" if female else "Male",
            "med_aid_dec_death_deceased_dob": f"{dob:%Y-%m-%d}",
            "med_aid_dec_death_deceased_age": str(age),
            "med_aid_dec_death_hcp_first_name": crew1.split(". ")[-1],
            "med_aid_dec_death_hcp_qualification": qual1,
            "med_aid_dec_death_med_carotid": "Absent", "med_aid_dec_death_med_heart_sounds": "Absent",
            "med_aid_dec_death_med_respiratory": "Absent", "med_aid_dec_death_med_ecg": "Asystole",
            "med_aid_dec_death_med_pupils": "Fixed and dilated",
            "undertaker_name": random.choice(["Doves Funeral Services", "AVBOB", "Martin's Funeral Home"]),
        })
    else:
        # Everything with a clinical page: complaint, survey, vitals, and often
        # oxygen / IV / medication.
        fd.update({
            "chief_complaint": complaint,
            "primary_diagnosis": diagnosis,
            "events_hpi": hpi,
            "findings_on_arrival": random.choice([
                "Patient found seated, alert and orientated, in obvious distress.",
                "Patient supine on floor, responsive to voice, airway patent.",
                "Patient ambulatory at roadside, no external haemorrhage noted.",
            ]),
            "allergies": random.choice(["NKDA", "NKDA", "Penicillin", "Sulfa drugs", "Aspirin"]),
            "current_medications": random.choice(["None", "Metformin 850mg BD", "Enalapril 10mg daily",
                                                  "Salbutamol PRN", "Warfarin 5mg daily"]),
            "past_medical_history": random.choice(["Nil of note", "Hypertension", "Type 2 Diabetes Mellitus",
                                                   "Asthma", "Previous MI 2021", "Epilepsy"]),
            "last_meal": random.choice(["Breakfast 07:00", "Lunch 13:00", "Nil since midnight", "Supper 19:30"]),
            "a_airway": "Patent, self-maintained", "b_breathing": "Equal chest rise, no added sounds",
            "c_circulation": "Radial pulse present, regular",
            "head_back": "No external injury", "neuro": "GCS as recorded, no focal deficit",
            "chest": "No flail segment, no crepitus", "abdomen": "Soft, non-distended",
            "limbs": "No deformity", "back": "No step or tenderness",
            "priority": random.choices(["RED", "ORANGE", "YELLOW", "GREEN"], weights=[12, 30, 40, 18])[0],
            "airway_interventions": ["Self-maintained"],
            "receiving_facility": random.choice(FACILITIES),
            "ward": random.choice(WARDS),
            "receiving_doctor": random.choice(DOCTORS),
            "handover_qualification": random.choice(["Sister", "Dr", "EN"]),
            "handover_notes": "Full verbal handover given, obs and interventions handed over.",
        })
        if call_type in ("PRIMARY", "WCA_IOD"):
            fd["mechanism"] = [random.choice(MECHANISMS)]
        if call_type == "RESUS":
            fd["med_aid_resus"] = True
            fd["assessment_level"] = random.choice(["ILS", "ALS"])
            fd["circulation_interventions"] = ["CPR", "Defib J/NR"]
            fd.pop("priority", None)

        n_vitals = random.choices([1, 2, 3, 4], weights=[18, 42, 30, 10])[0]
        fd["vitals_sets"] = [_vitals_set(when + timedelta(minutes=8 * k), severity) for k in range(n_vitals)]

        if severity != "routine" or random.random() < 0.35:
            fd.update({
                "o2_flow_rate": random.choice(["2", "4", "6", "8", "10", "15"]),
                "o2_device": random.choice(["Mask", "Nasal Cannula", "Non-Rebreather", "Venturi Mask"]),
                "o2_start_time": f"{when:%H:%M}",
            })
        if random.random() < 0.5:
            fd["iv_therapy"] = [{
                "type": random.choice(["Ringer's Lactate", "Sodium Chloride 0.9%", "Dextrose 5%"]),
                "jelco_size": random.choice(["16g", "18g", "20g"]),
                "site": random.choice(["Left ACF", "Right ACF", "Left dorsum of hand", "Right forearm"]),
                "vol_infused": random.choice(["250", "500", "1000"]),
                "time_up": f"{when + timedelta(minutes=6):%H:%M}",
                "indication": random.choice(["Fluid resuscitation", "Maintenance", "Medication route"]),
                "sign": crew1, "administered_by": crew1, "administered_by_qualification": qual1,
            }]
        if random.random() < 0.4:
            drug, dose, route = random.choice([
                ("Morphine Sulphate", "5 mg", "IV"), ("Salbutamol", "5 mg", "Nebulised"),
                ("Adrenaline 1:1000", "0.5 mg", "IM"), ("Aspirin", "300 mg", "ORAL"),
                ("Dextrose 50%", "50 ml", "IV"), ("Paracetamol", "1 g", "IV"),
            ])
            fd["medications"] = [{
                "type": drug, "route": route, "dose": dose,
                "time": f"{when + timedelta(minutes=10):%H:%M}",
                "reason": "Medication Administered via " + route,
                "sign": crew1, "administered_by": crew1, "administered_by_qualification": qual1,
            }]

    fd["motivation_notes"] = random.choice([
        "", "", "Patient transported for further assessment and definitive care.",
        "Scene handed over to SAPS. No further EMS involvement required.",
    ])
    return fd, case_mirror


async def _resolve_provider(db, ident: str) -> ServiceProvider:
    q = select(ServiceProvider).where(
        (ServiceProvider.prf_name == ident) | (ServiceProvider.slug == ident) | (ServiceProvider.name == ident))
    rows = (await db.execute(q)).scalars().all()
    if not rows:
        raise SystemExit(f"No provider matches '{ident}'. Use --list to see them.")
    if len(rows) > 1:
        raise SystemExit(f"'{ident}' matches {len(rows)} providers: " + ", ".join(p.name for p in rows))
    return rows[0]


async def cmd_list() -> None:
    S = async_sessionmaker(engine, expire_on_commit=False)
    async with S() as db:
        for p in (await db.execute(select(ServiceProvider).order_by(ServiceProvider.name))).scalars():
            n = (await db.execute(select(func.count()).select_from(DigitalPRF)
                                  .where(DigitalPRF.provider_id == p.id))).scalar()
            print(f"  {p.name:34} prf_name={str(p.prf_name):10} slug={p.slug:28} PRFs={n}")
    await engine.dispose()


async def run(args) -> None:
    S = async_sessionmaker(engine, expire_on_commit=False)
    random.seed(args.rand_seed)

    async with S() as db:
        provider = await _resolve_provider(db, args.provider)
        existing = (await db.execute(select(func.count()).select_from(DigitalPRF)
                                     .where(DigitalPRF.provider_id == provider.id))).scalar()
        # Compute the base ONCE. _next_prf_number is a max()+1 that is only
        # race-free while the caller holds the provider row FOR UPDATE; calling
        # it 500 times would either collide or serialise the whole run.
        base = (await db.execute(select(func.coalesce(func.max(DigitalPRF.prf_number), 0))
                                 .where(DigitalPRF.provider_id == provider.id,
                                        DigitalPRF.correction_of_id.is_(None)))).scalar() or 0
        base = max(base, provider.prf_start_number or 0)

    slug_part = (provider.slug or "PRF").upper()[:35]
    spread_days = args.spread_days

    print(f"\n  Provider     : {provider.name}  (prf_name={provider.prf_name}, slug={provider.slug})")
    print(f"  Existing PRFs: {existing}   (numbers up to #{base})")
    print(f"  Will create  : {args.count} PRFs, numbered #{base+1}–#{base+args.count}")
    print(f"  Dated across : the last {spread_days} days (Case.created_at is the list sort key)")
    mix = {c: 0 for c, _ in CALL_MIX}
    types = random.choices([c for c, _ in CALL_MIX], weights=[w for _, w in CALL_MIX], k=args.count)
    for t in types:
        mix[t] += 1
    print("  Call-type mix: " + ", ".join(f"{k}={v}" for k, v in mix.items() if v))
    print(f"  Each record  : DigitalPRF + Case + Document + Claim, PRF finalised PROCESSED")
    print(f"  Marker       : form_data['{MARKER}'] = true  (+ a manifest file for teardown)")

    if args.plan:
        print("\n  --plan: nothing was written.\n")
        await engine.dispose()
        return

    now = datetime.now(timezone.utc)
    manifest = {"created_at": now.isoformat(), "provider_id": str(provider.id),
                "provider_name": provider.name, "marker": MARKER, "records": []}

    made = 0
    async with S() as db:
        for i, call_type in enumerate(types, start=1):
            when = now - timedelta(days=random.uniform(0, spread_days))
            number = base + i
            fd, mirror = build_form_data(i, call_type, when)

            prf = DigitalPRF(
                provider_id=provider.id, prf_number=number, status=PRFStatus.DRAFT,
                case_number=f"{slug_part}-{when:%Y}-{when:%m}-{number:06d}",
                form_data=fd, created_at=when, updated_at=when,
                time_call_received=when, time_on_scene=when + timedelta(minutes=9),
                time_at_destination=when + timedelta(minutes=34),
                time_handover=when + timedelta(minutes=41),
            )
            db.add(prf)
            await db.flush()

            case = Case(
                patient_name=(mirror["patient_name"] or "Unknown")[:255],
                patient_id_number=mirror["patient_id_number"],
                medical_scheme_name=(mirror["medical_scheme_name"] or None),
                scheme_member_number=(mirror["scheme_member_number"] or None),
                preauth_number=(mirror["preauth_number"] or None),
                dispatch_type=("IFT" if call_type in ("IHT", "RHT", "COURTESY") else "Primary"),
                incident_date=when.date(),
                # Copied from the PRF on purpose: the Cases list orders by
                # Case.created_at DESC, so defaulting it stacks all 500 rows on
                # the seed timestamp and they sort by UUID.
                created_at=when, updated_at=when,
            )
            db.add(case)
            await db.flush()

            document = Document(
                case_id=case.id,
                original_filename=f"PRF-{number}.json",
                storage_uri=f"digital-prf://{prf.id}",
                document_type="Digital PRF",
                ocr_status=OCRStatus.COMPLETED,
                ocr_confidence_avg=1.0,
                needs_hitl_review=False,      # THE gate for the management queue
                created_at=when, updated_at=when,
            )
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
                "document_id": str(document.id), "claim_id": str(claim.id), "call_type": call_type,
            })
            made += 1
            if made % 100 == 0:
                print(f"    ... {made}/{args.count}")

        # Manifest is written BEFORE the commit: if the commit fails there is a
        # file describing rows that do not exist (harmless), never rows that
        # exist with no file (unremovable).
        out = Path(args.manifest or f"demo_seed_manifest_{now:%Y%m%dT%H%M%SZ}.json")
        out.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        await db.commit()

    print(f"\n  Created {made} PRFs (+ case, document, claim each).")
    print(f"  Manifest: {out.resolve()}")
    print(f"  Remove with:  python seed_demo_prfs.py --teardown {out.name}\n")
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
        # Refuse to touch anything that is not ours: every id must still carry
        # the marker. A manifest pointing at a record without it means the file
        # is wrong or the row was replaced, and deleting would be guesswork.
        found = (await db.execute(select(func.count()).select_from(DigitalPRF)
                                 .where(DigitalPRF.id.in_([uuid.UUID(x) for x in prf_ids])))).scalar()
        marked = (await db.execute(text(
            "select count(*) from digital_prfs where id = any(cast(:ids as uuid[])) "
            "and (form_data ->> :m) is not null"), {"ids": prf_ids, "m": MARKER})).scalar()
        print(f"  Present in DB: {found}    carrying the '{MARKER}' marker: {marked}")
        if found != marked:
            raise SystemExit(f"  ABORT: {found - marked} record(s) in the manifest do NOT carry the marker. "
                             "Refusing to delete records this script may not have created.")
        if not yes:
            print("\n  Re-run with --yes to delete.\n")
            await engine.dispose()
            return

        # Nothing here is ON DELETE CASCADE; this order is FK-safe.
        stmts = [
            ("claim_lines",           "delete from claim_lines where claim_id = any(cast(:c as uuid[]))", {"c": claim_ids}),
            ("rfis",                  "delete from rfis where claim_id = any(cast(:c as uuid[]))", {"c": claim_ids}),
            ("eras",                  "delete from eras where claim_id = any(cast(:c as uuid[]))", {"c": claim_ids}),
            ("edi_submissions",       "delete from edi_submissions where claim_id = any(cast(:c as uuid[]))", {"c": claim_ids}),
            ("scheme_auth_requests",  "delete from scheme_auth_requests where claim_id = any(cast(:c as uuid[])) "
                                      "or case_id = any(cast(:k as uuid[]))", {"c": claim_ids, "k": case_ids}),
            ("claims.amended_by_id",  "update claims set amended_by_id = null where amended_by_id = any(cast(:c as uuid[]))", {"c": claim_ids}),
            ("claims",                "delete from claims where id = any(cast(:c as uuid[]))", {"c": claim_ids}),
            ("prf.correction_of_id",  "update digital_prfs set correction_of_id = null where correction_of_id = any(cast(:p as uuid[]))", {"p": prf_ids}),
            ("digital_prfs",          "delete from digital_prfs where id = any(cast(:p as uuid[]))", {"p": prf_ids}),
            ("documents",             "delete from documents where id = any(cast(:d as uuid[]))", {"d": doc_ids}),
            ("cases",                 "delete from cases where id = any(cast(:k as uuid[]))", {"k": case_ids}),
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
    print(f"\n  Residue check: PRFs left {left}, cases left {lc}  -> {'CLEAN' if left == 0 and lc == 0 else 'INCOMPLETE'}\n")
    await engine.dispose()


def main() -> None:
    ap = argparse.ArgumentParser(description="Seed or remove realistic demo PRFs.")
    ap.add_argument("--provider", help="prf_name, slug or full name (e.g. EMSMCA)")
    ap.add_argument("--count", type=int, default=500)
    ap.add_argument("--spread-days", type=int, default=45)
    ap.add_argument("--rand-seed", type=int, default=20260814)
    ap.add_argument("--manifest", help="manifest path to write (seed) ")
    ap.add_argument("--plan", action="store_true", help="show what would happen, write nothing")
    ap.add_argument("--seed", action="store_true", help="actually create the records")
    ap.add_argument("--list", action="store_true", help="list providers and exit")
    ap.add_argument("--teardown", metavar="MANIFEST", help="remove everything in a manifest")
    ap.add_argument("--yes", action="store_true", help="confirm a teardown")
    args = ap.parse_args()

    if args.list:
        asyncio.run(cmd_list()); return
    if args.teardown:
        asyncio.run(teardown(args.teardown, args.yes)); return
    if not args.provider:
        ap.error("--provider is required (or use --list / --teardown)")
    if not (args.plan or args.seed):
        ap.error("pass --plan to preview, or --seed to write")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
