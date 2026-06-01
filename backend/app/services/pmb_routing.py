"""
PMB (Prescribed Minimum Benefits) Routing Service
Detects PMB conditions from ICD-10 codes and clinical narratives,
automatically appends necessary modifiers for legally mandated scheme coverage.

Reference: Medical Schemes Act No. 131 of 1998, Regulation 8
PMBs cover 270+ diagnosis-treatment pairs (DTPs) and 26+ chronic disease list (CDL) conditions.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional
import re


@dataclass
class PMBRoutingResult:
    """Result of PMB condition detection."""
    is_pmb: bool = False
    pmb_type: Optional[str] = None  # "emergency", "cdl", "dtp"
    pmb_condition: Optional[str] = None
    pmb_code: Optional[str] = None
    modifier_to_append: Optional[str] = None
    cdl_number: Optional[int] = None
    legal_mandate: str = ""
    routing_notes: list[str] = field(default_factory=list)


# ── PMB Emergency Conditions ───────────────────────────────
# Medical Schemes Act: Schemes MUST cover emergency conditions regardless of benefits.
PMB_EMERGENCY_ICD10 = {
    # Cardiac emergencies
    "I21": {"condition": "Acute myocardial infarction", "modifier": "PMB-E", "pmb_code": "DTP-910A"},
    "I46": {"condition": "Cardiac arrest", "modifier": "PMB-E", "pmb_code": "DTP-910B"},
    "I48": {"condition": "Atrial fibrillation (acute)", "modifier": "PMB-E", "pmb_code": "DTP-910C"},
    "I63": {"condition": "Cerebral infarction / stroke", "modifier": "PMB-E", "pmb_code": "DTP-910D"},
    "I64": {"condition": "Stroke not specified", "modifier": "PMB-E", "pmb_code": "DTP-910D"},

    # Respiratory emergencies
    "J46": {"condition": "Status asthmaticus", "modifier": "PMB-E", "pmb_code": "DTP-920A"},
    "J96": {"condition": "Respiratory failure", "modifier": "PMB-E", "pmb_code": "DTP-920B"},

    # Trauma
    "S06": {"condition": "Intracranial injury", "modifier": "PMB-E", "pmb_code": "DTP-930A"},
    "S72": {"condition": "Fracture of femur", "modifier": "PMB-E", "pmb_code": "DTP-930B"},
    "T07": {"condition": "Multiple injuries", "modifier": "PMB-E", "pmb_code": "DTP-930C"},
    "T20": {"condition": "Burns of head/neck", "modifier": "PMB-E", "pmb_code": "DTP-930D"},
    "T30": {"condition": "Burns unspecified", "modifier": "PMB-E", "pmb_code": "DTP-930D"},
    "T31": {"condition": "Burns by extent", "modifier": "PMB-E", "pmb_code": "DTP-930D"},

    # Poisoning / Overdose
    "T39": {"condition": "Analgesic poisoning", "modifier": "PMB-E", "pmb_code": "DTP-940A"},
    "T40": {"condition": "Narcotic poisoning", "modifier": "PMB-E", "pmb_code": "DTP-940A"},

    # Obstetric emergencies
    "O80": {"condition": "Spontaneous delivery", "modifier": "PMB-M", "pmb_code": "DTP-950A"},
    "O82": {"condition": "Caesarean delivery", "modifier": "PMB-M", "pmb_code": "DTP-950B"},

    # Metabolic emergencies
    "E16.0": {"condition": "Drug-induced hypoglycaemia", "modifier": "PMB-E", "pmb_code": "DTP-960A"},
}

# ── CDL (Chronic Disease List) – 27 conditions ─────────────
# Schemes must cover these 27 chronic conditions with treatment algorithms.
CDL_CONDITIONS = {
    1: {"icd10": ["E10"], "condition": "Type 1 Diabetes Mellitus", "modifier": "CDL-01"},
    2: {"icd10": ["E11"], "condition": "Type 2 Diabetes Mellitus", "modifier": "CDL-02"},
    3: {"icd10": ["I10", "I11", "I12", "I13", "I15"], "condition": "Hypertension", "modifier": "CDL-03"},
    4: {"icd10": ["J45"], "condition": "Asthma", "modifier": "CDL-04"},
    5: {"icd10": ["J44"], "condition": "COPD", "modifier": "CDL-05"},
    6: {"icd10": ["I48"], "condition": "Cardiac dysrhythmia", "modifier": "CDL-06"},
    7: {"icd10": ["I20", "I25"], "condition": "Coronary artery disease", "modifier": "CDL-07"},
    8: {"icd10": ["N18"], "condition": "Chronic renal disease", "modifier": "CDL-08"},
    9: {"icd10": ["B20", "B21", "B22", "B23", "B24"], "condition": "HIV/AIDS", "modifier": "CDL-09"},
    10: {"icd10": ["I50"], "condition": "Cardiac failure", "modifier": "CDL-10"},
    11: {"icd10": ["G40", "G41"], "condition": "Epilepsy", "modifier": "CDL-11"},
    12: {"icd10": ["E05"], "condition": "Hyperthyroidism", "modifier": "CDL-12"},
    13: {"icd10": ["E03"], "condition": "Hypothyroidism", "modifier": "CDL-13"},
    14: {"icd10": ["E22"], "condition": "Hypopituitarism", "modifier": "CDL-14"},
    15: {"icd10": ["E27.1"], "condition": "Addison's disease", "modifier": "CDL-15"},
    16: {"icd10": ["G35"], "condition": "Multiple sclerosis", "modifier": "CDL-16"},
    17: {"icd10": ["G20"], "condition": "Parkinson's disease", "modifier": "CDL-17"},
    18: {"icd10": ["M05", "M06"], "condition": "Rheumatoid arthritis", "modifier": "CDL-18"},
    19: {"icd10": ["M32"], "condition": "Systemic lupus erythematosus", "modifier": "CDL-19"},
    20: {"icd10": ["D60", "D61"], "condition": "Aplastic anaemia", "modifier": "CDL-20"},
    21: {"icd10": ["K50", "K51"], "condition": "Crohn's / Ulcerative colitis", "modifier": "CDL-21"},
    22: {"icd10": ["E84"], "condition": "Cystic fibrosis", "modifier": "CDL-22"},
    23: {"icd10": ["D66", "D67"], "condition": "Haemophilia", "modifier": "CDL-23"},
    24: {"icd10": ["M45"], "condition": "Ankylosing spondylitis", "modifier": "CDL-24"},
    25: {"icd10": ["K90.0"], "condition": "Coeliac disease", "modifier": "CDL-25"},
    26: {"icd10": ["N03", "N04", "N05"], "condition": "Glomerulonephritis", "modifier": "CDL-26"},
    27: {"icd10": ["D56"], "condition": "Thalassaemia", "modifier": "CDL-27"},
}

# Emergency keywords in clinical narratives that trigger PMB routing
PMB_EMERGENCY_KEYWORDS = [
    "cardiac arrest", "heart attack", "myocardial infarction", "chest pain",
    "stroke", "cva", "cerebrovascular", "unconscious", "unresponsive",
    "respiratory failure", "respiratory arrest", "difficulty breathing",
    "status asthmaticus", "severe asthma", "intubation", "ventilation",
    "major trauma", "polytrauma", "head injury", "spinal injury",
    "burn", "electrocution", "drowning", "near-drowning",
    "overdose", "poisoning", "toxic ingestion",
    "delivery", "childbirth", "labour", "eclampsia", "pre-eclampsia",
    "anaphylaxis", "allergic reaction severe",
    "diabetic emergency", "hypoglycaemia", "dka", "ketoacidosis",
    "seizure", "status epilepticus",
]


def detect_pmb_from_icd10(primary_icd10: str, secondary_icd10: Optional[str] = None) -> PMBRoutingResult:
    """
    Detect if an ICD-10 code triggers PMB coverage.

    Checks both emergency PMB conditions and CDL chronic conditions.
    Returns the modifier to append and routing instructions.
    """
    result = PMBRoutingResult()
    codes_to_check = [primary_icd10]
    if secondary_icd10:
        codes_to_check.append(secondary_icd10)

    for code in codes_to_check:
        code_clean = code.strip().upper().replace(".", "")

        # Check emergency PMB
        for pmb_prefix, pmb_info in PMB_EMERGENCY_ICD10.items():
            pmb_clean = pmb_prefix.replace(".", "")
            if code_clean == pmb_clean or code_clean.startswith(pmb_clean):
                result.is_pmb = True
                result.pmb_type = "emergency"
                result.pmb_condition = pmb_info["condition"]
                result.pmb_code = pmb_info["pmb_code"]
                result.modifier_to_append = pmb_info["modifier"]
                result.legal_mandate = (
                    f"Medical Schemes Act Reg 8: Scheme MUST cover as emergency PMB. "
                    f"Condition: {pmb_info['condition']} ({code})"
                )
                result.routing_notes.append(f"PMB Emergency detected: {pmb_info['condition']}")
                result.routing_notes.append(f"Append modifier: {pmb_info['modifier']}")
                result.routing_notes.append("Scheme cannot decline — legally mandated coverage")
                return result

        # Check CDL
        for cdl_num, cdl_info in CDL_CONDITIONS.items():
            for cdl_code in cdl_info["icd10"]:
                cdl_clean = cdl_code.replace(".", "")
                if code_clean == cdl_clean or code_clean.startswith(cdl_clean):
                    result.is_pmb = True
                    result.pmb_type = "cdl"
                    result.pmb_condition = cdl_info["condition"]
                    result.cdl_number = cdl_num
                    result.modifier_to_append = cdl_info["modifier"]
                    result.legal_mandate = (
                        f"CDL Condition #{cdl_num}: {cdl_info['condition']}. "
                        f"Must be covered per treatment algorithm."
                    )
                    result.routing_notes.append(f"CDL #{cdl_num} detected: {cdl_info['condition']}")
                    result.routing_notes.append(f"Append modifier: {cdl_info['modifier']}")
                    return result

    return result


def detect_pmb_from_narrative(clinical_notes: str) -> PMBRoutingResult:
    """
    Detect PMB conditions from free-text clinical narratives.
    Supplements ICD-10-based detection for cases where coding may be incomplete.
    """
    result = PMBRoutingResult()
    if not clinical_notes:
        return result

    notes_lower = clinical_notes.lower()

    for keyword in PMB_EMERGENCY_KEYWORDS:
        if keyword in notes_lower:
            result.is_pmb = True
            result.pmb_type = "emergency"
            result.pmb_condition = f"Narrative keyword match: '{keyword}'"
            result.modifier_to_append = "PMB-E"
            result.legal_mandate = (
                f"Emergency PMB detected from clinical narrative. "
                f"Keyword: '{keyword}'. Manual ICD-10 coding review recommended."
            )
            result.routing_notes.append(f"PMB keyword detected: '{keyword}'")
            result.routing_notes.append("Recommend verifying ICD-10 code matches narrative")
            return result

    return result
