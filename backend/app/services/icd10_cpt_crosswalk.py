"""
ICD-10 to CPT/Tariff Cross-Walk Engine
Validates that diagnosis codes match procedure codes and detects clinical mismatches.

Uses SA-specific EMS tariff codes alongside standard CPT codes.
"""
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class CrossWalkResult:
    """Result of ICD-10 ↔ CPT validation."""
    is_valid: bool = True
    icd10_code: str = ""
    cpt_code: str = ""
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    suggested_codes: list[str] = field(default_factory=list)
    modifier_suggestions: list[str] = field(default_factory=list)
    is_pmb: bool = False
    pmb_category: Optional[str] = None


# ── ICD-10 Code Registry (SA EMS-relevant subset) ──────────────
# Maps ICD-10 codes to clinical categories and valid CPT ranges
ICD10_REGISTRY: dict[str, dict] = {
    # Cardiovascular emergencies
    "I21": {"desc": "Acute myocardial infarction", "category": "cardiovascular", "pmb": True, "valid_cpt_prefixes": ["9928", "9929", "9218", "9219"]},
    "I21.0": {"desc": "Acute transmural MI of anterior wall", "category": "cardiovascular", "pmb": True, "valid_cpt_prefixes": ["9928", "9929"]},
    "I21.1": {"desc": "Acute transmural MI of inferior wall", "category": "cardiovascular", "pmb": True, "valid_cpt_prefixes": ["9928", "9929"]},
    "I46": {"desc": "Cardiac arrest", "category": "cardiovascular", "pmb": True, "valid_cpt_prefixes": ["9928", "9929", "9219"]},
    "I46.0": {"desc": "Cardiac arrest with successful resuscitation", "category": "cardiovascular", "pmb": True, "valid_cpt_prefixes": ["9928", "9929"]},
    "I10": {"desc": "Essential hypertension", "category": "cardiovascular", "pmb": False, "valid_cpt_prefixes": ["9928", "9921"]},
    "I48": {"desc": "Atrial fibrillation and flutter", "category": "cardiovascular", "pmb": True, "valid_cpt_prefixes": ["9928", "9929"]},
    "I63": {"desc": "Cerebral infarction (stroke)", "category": "cerebrovascular", "pmb": True, "valid_cpt_prefixes": ["9928", "9929", "9218"]},

    # Trauma
    "S06": {"desc": "Intracranial injury", "category": "trauma", "pmb": True, "valid_cpt_prefixes": ["9928", "9929", "9218", "9219"]},
    "S06.0": {"desc": "Concussion", "category": "trauma", "pmb": True, "valid_cpt_prefixes": ["9928", "9921"]},
    "S72": {"desc": "Fracture of femur", "category": "trauma", "pmb": True, "valid_cpt_prefixes": ["9928", "9929", "9218"]},
    "S82": {"desc": "Fracture of lower leg", "category": "trauma", "pmb": True, "valid_cpt_prefixes": ["9928", "9929"]},
    "S52": {"desc": "Fracture of forearm", "category": "trauma", "pmb": True, "valid_cpt_prefixes": ["9928", "9921"]},
    "T07": {"desc": "Unspecified multiple injuries", "category": "trauma", "pmb": True, "valid_cpt_prefixes": ["9928", "9929"]},
    "T14": {"desc": "Injury of unspecified body region", "category": "trauma", "pmb": True, "valid_cpt_prefixes": ["9928", "9921"]},

    # Respiratory
    "J18": {"desc": "Pneumonia, organism unspecified", "category": "respiratory", "pmb": True, "valid_cpt_prefixes": ["9928", "9921"]},
    "J44": {"desc": "COPD", "category": "respiratory", "pmb": True, "valid_cpt_prefixes": ["9928", "9921"]},
    "J45": {"desc": "Asthma", "category": "respiratory", "pmb": True, "valid_cpt_prefixes": ["9928", "9921"]},
    "J46": {"desc": "Status asthmaticus", "category": "respiratory", "pmb": True, "valid_cpt_prefixes": ["9928", "9929"]},
    "J96": {"desc": "Respiratory failure", "category": "respiratory", "pmb": True, "valid_cpt_prefixes": ["9928", "9929", "9219"]},

    # Metabolic / Endocrine
    "E10": {"desc": "Type 1 diabetes mellitus", "category": "metabolic", "pmb": True, "valid_cpt_prefixes": ["9928", "9921"]},
    "E11": {"desc": "Type 2 diabetes mellitus", "category": "metabolic", "pmb": True, "valid_cpt_prefixes": ["9928", "9921"]},
    "E16.0": {"desc": "Drug-induced hypoglycaemia", "category": "metabolic", "pmb": True, "valid_cpt_prefixes": ["9928", "9921"]},

    # Obstetric
    "O80": {"desc": "Single spontaneous delivery", "category": "obstetric", "pmb": True, "valid_cpt_prefixes": ["9928", "9929"]},
    "O82": {"desc": "Delivery by caesarean section", "category": "obstetric", "pmb": True, "valid_cpt_prefixes": ["9928", "9929"]},

    # Poisoning / Overdose
    "T36-T50": {"desc": "Poisoning by drugs/substances", "category": "poisoning", "pmb": True, "valid_cpt_prefixes": ["9928", "9929"]},
    "T39": {"desc": "Poisoning by analgesics/antipyretics", "category": "poisoning", "pmb": True, "valid_cpt_prefixes": ["9928", "9921"]},
    "T40": {"desc": "Poisoning by narcotics", "category": "poisoning", "pmb": True, "valid_cpt_prefixes": ["9928", "9929"]},
    # Psychiatric / Behavioral
    "F32": {"desc": "Depressive episode", "category": "psychiatric", "pmb": True, "valid_cpt_prefixes": ["9928", "9921"]},
    "F41": {"desc": "Other anxiety disorders", "category": "psychiatric", "pmb": False, "valid_cpt_prefixes": ["9928", "9921"]},
    "F41.0": {"desc": "Panic disorder", "category": "psychiatric", "pmb": False, "valid_cpt_prefixes": ["9928", "9921"]},
    "X60-X84": {"desc": "Intentional self-harm", "category": "psychiatric", "pmb": True, "valid_cpt_prefixes": ["9928", "9929"]},

    # Burns
    "T20": {"desc": "Burn of head and neck", "category": "burns", "pmb": True, "valid_cpt_prefixes": ["9928", "9929"]},
    "T30": {"desc": "Burn of unspecified body region", "category": "burns", "pmb": True, "valid_cpt_prefixes": ["9928", "9929"]},
    "T31": {"desc": "Burns classified by extent of body surface", "category": "burns", "pmb": True, "valid_cpt_prefixes": ["9928", "9929"]},

    # General / Symptoms
    "R50.9": {"desc": "Fever, unspecified (Pyrexia)", "category": "general", "pmb": False, "valid_cpt_prefixes": ["9928", "9921"]},
}

# ── SA EMS CPT/Tariff Codes ────────────────────────────────────
CPT_TARIFF_CODES: dict[str, dict] = {
    # Intermediate Life Support (ILS) — SA EMS no longer uses BLS
    "99211": {"desc": "Office/outpatient visit - minimal", "level": "ILS", "rate_tier": 1},
    "99281": {"desc": "ED visit - minor", "level": "ILS", "rate_tier": 1},

    # EMS-specific SA tariffs
    "99218": {"desc": "Initial observation care - low complexity", "level": "ILS", "rate_tier": 2},
    "99219": {"desc": "Initial observation care - moderate complexity", "level": "ALS", "rate_tier": 3},
    "99220": {"desc": "Initial observation care - high complexity", "level": "ALS", "rate_tier": 4},
    "99281": {"desc": "Emergency department visit - self-limited", "level": "ILS", "rate_tier": 1},
    "99282": {"desc": "Emergency department visit - low to moderate", "level": "ILS", "rate_tier": 2},
    "99283": {"desc": "Emergency department visit - moderate", "level": "ILS", "rate_tier": 2},
    "99284": {"desc": "Emergency department visit - high severity", "level": "ALS", "rate_tier": 3},
    "99285": {"desc": "Emergency department visit - immediate threat to life", "level": "ALS", "rate_tier": 4},
    "99288": {"desc": "Physician direction of EMS", "level": "ALS", "rate_tier": 3},
    "99289": {"desc": "Critical care first 30-74 min", "level": "ALS", "rate_tier": 4},
    "99290": {"desc": "Critical care each additional 30 min", "level": "ALS", "rate_tier": 4},
    "99291": {"desc": "Critical care evaluation first hour", "level": "ALS", "rate_tier": 4},

    # SA-specific ambulance codes
    "A0427": {"desc": "ALS ambulance transport emergency", "level": "ALS", "rate_tier": 3},
    "A0429": {"desc": "ILS ambulance transport emergency", "level": "ILS", "rate_tier": 1},
    "A0433": {"desc": "ALS ambulance transport non-emergency", "level": "ALS", "rate_tier": 2},
}

# ── NAPPI Codes for Common EMS Consumables ──────────────────────
NAPPI_CODES: dict[str, dict] = {
    "706729": {"desc": "Normal saline 1000ml IV", "category": "IV fluids"},
    "706730": {"desc": "Ringers lactate 1000ml", "category": "IV fluids"},
    "707101": {"desc": "Adrenaline 1mg/ml", "category": "Cardiac drugs"},
    "707102": {"desc": "Atropine 1mg/ml", "category": "Cardiac drugs"},
    "707103": {"desc": "Amiodarone 150mg/3ml", "category": "Cardiac drugs"},
    "707201": {"desc": "Morphine 10mg/ml", "category": "Analgesics"},
    "707202": {"desc": "Ketamine 200mg/20ml", "category": "Analgesics"},
    "707301": {"desc": "Midazolam 5mg/5ml", "category": "Sedatives"},
    "707401": {"desc": "Salbutamol nebule 5mg/2.5ml", "category": "Respiratory"},
    "707501": {"desc": "Dextrose 50% 50ml", "category": "Metabolic"},
    "707601": {"desc": "Oxygen per minute", "category": "Respiratory"},
    "708001": {"desc": "Disposable gloves (pair)", "category": "Consumables"},
    "708002": {"desc": "IV cannula 18G", "category": "Consumables"},
    "708003": {"desc": "Bandage crepe 100mm", "category": "Consumables"},
    "708004": {"desc": "Splint disposable", "category": "Consumables"},
    "708005": {"desc": "Cervical collar", "category": "Consumables"},
}


def validate_icd10_code(code: str) -> dict:
    """Validate an ICD-10 code and return its clinical classification."""
    code_clean = code.strip().upper().replace(".", "")

    # Try exact match first
    for registered_code, info in ICD10_REGISTRY.items():
        reg_clean = registered_code.replace(".", "").replace("-", "")
        if code_clean == reg_clean or code_clean.startswith(reg_clean):
            return {
                "valid": True,
                "code": code,
                "description": info["desc"],
                "category": info["category"],
                "is_pmb": info["pmb"],
            }

    # Check if it follows ICD-10 format (letter + 2-5 alphanumeric)
    if re.match(r"^[A-Z]\d{2,5}$", code_clean):
        return {
            "valid": True,
            "code": code,
            "description": "Unlisted ICD-10 code",
            "category": "unknown",
            "is_pmb": False,
        }

    return {
        "valid": False,
        "code": code,
        "description": None,
        "category": None,
        "is_pmb": False,
    }


import re


def validate_cpt_code(code: str) -> dict:
    """Validate a CPT/tariff code against SA EMS billing standards.
    
    Accepts:
      - Registered codes in CPT_TARIFF_CODES dict
      - Standard CPT: exactly 5 digits (e.g. 99285)
      - HCPCS transport: letter + 4 digits (e.g. A0427)
      - SA EMS tariff codes: 2-6 digit numerics (e.g. 100, 0190, 17600, 176001)
        SA EMS uses numeric tariff codes from the GEMS/NHRPL schedules which
        do NOT follow the strict US 5-digit CPT format.
    """
    code_clean = code.strip().upper()

    # Exact match in registry
    if code_clean in CPT_TARIFF_CODES:
        info = CPT_TARIFF_CODES[code_clean]
        return {
            "valid": True,
            "code": code_clean,
            "description": info["desc"],
            "level": info["level"],
            "rate_tier": info["rate_tier"],
        }

    # Standard US CPT: exactly 5 digits
    if re.match(r"^\d{5}$", code_clean):
        return {
            "valid": True,
            "code": code_clean,
            "description": "Unlisted CPT code",
            "level": "unknown",
            "rate_tier": 0,
        }

    # HCPCS-style codes (e.g. A0427, A0429, A0433)
    if re.match(r"^[A-Z]\d{4}$", code_clean):
        return {
            "valid": True,
            "code": code_clean,
            "description": "HCPCS/transport code",
            "level": "unknown",
            "rate_tier": 0,
        }

    # SA EMS / GEMS / NHRPL tariff codes: 2–6 digit numeric
    # e.g. 100, 0190, 17600, 176001 — these are valid SA tariff schedule codes
    if re.match(r"^\d{2,6}$", code_clean):
        return {
            "valid": True,
            "code": code_clean,
            "description": "SA EMS tariff code",
            "level": "unknown",
            "rate_tier": 0,
        }

    return {"valid": False, "code": code_clean, "description": None, "level": None, "rate_tier": None}


def validate_nappi_code(code: str) -> dict:
    """Validate a NAPPI code."""
    code_clean = code.strip()
    if code_clean in NAPPI_CODES:
        info = NAPPI_CODES[code_clean]
        return {"valid": True, "code": code_clean, "description": info["desc"], "category": info["category"]}

    # Accept any 6-digit numeric NAPPI
    if re.match(r"^\d{6,8}$", code_clean):
        return {"valid": True, "code": code_clean, "description": "Unlisted NAPPI", "category": "unknown"}

    return {"valid": False, "code": code_clean, "description": None, "category": None}


def cross_walk_icd10_cpt(icd10_code: str, cpt_code: str) -> CrossWalkResult:
    """
    Cross-reference an ICD-10 diagnostic code against a CPT procedure code.
    Detects clinical mismatches and suggests corrections.
    """
    result = CrossWalkResult(icd10_code=icd10_code, cpt_code=cpt_code)

    # Validate ICD-10
    icd_info = validate_icd10_code(icd10_code)
    if not icd_info["valid"]:
        result.is_valid = False
        result.errors.append(f"Invalid ICD-10 code: {icd10_code}")
        return result

    # Validate CPT
    cpt_info = validate_cpt_code(cpt_code)
    if not cpt_info["valid"]:
        result.is_valid = False
        result.errors.append(f"Invalid CPT code: {cpt_code}")
        return result

    # Check PMB status
    result.is_pmb = icd_info.get("is_pmb", False)
    if result.is_pmb:
        result.pmb_category = icd_info.get("category")

    # Cross-walk: check if CPT is valid for this ICD-10 category
    icd_clean = icd10_code.strip().upper().replace(".", "")
    for reg_code, reg_info in ICD10_REGISTRY.items():
        reg_clean = reg_code.replace(".", "").replace("-", "")
        if icd_clean == reg_clean or icd_clean.startswith(reg_clean):
            valid_prefixes = reg_info.get("valid_cpt_prefixes", [])
            cpt_clean = cpt_code.strip()

            prefix_match = any(cpt_clean.startswith(p) for p in valid_prefixes)
            if not prefix_match and valid_prefixes:
                result.warnings.append(
                    f"CPT {cpt_code} may not be appropriate for {icd10_code} ({reg_info['desc']}). "
                    f"Expected prefixes: {', '.join(valid_prefixes)}"
                )
                result.suggested_codes = [f"{p}x" for p in valid_prefixes[:3]]

            # Check severity alignment
            if reg_info["category"] in ("cardiovascular", "cerebrovascular", "burns"):
                if cpt_info.get("rate_tier", 0) < 3:
                    result.warnings.append(
                        f"Low-tier CPT for high-acuity condition ({reg_info['desc']}). "
                        f"Consider ALS-level code for clinical accuracy."
                    )
            break

    return result
