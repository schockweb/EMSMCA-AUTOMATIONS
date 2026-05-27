import pathlib

target = pathlib.Path("app/services/tariff_engine.py")
content = target.read_text(encoding="utf-8")

# Let's extract everything from the top of the file up to _calculate_core_lines definition
idx = content.find("def _calculate_core_lines")
if idx == -1:
    print("FATAL: Cannot find _calculate_core_lines")
    import sys; sys.exit(1)

header = content[:idx]

# Let's extract everything from _ai_identify_addons (STAGE 2) to the bottom
idx_end = content.find("def _ai_identify_addons")
if idx_end == -1:
    print("FATAL: Cannot find _ai_identify_addons")
    import sys; sys.exit(1)

# Back up to the STAGE 2 comment header
idx_stage2 = content.rfind("# ════════", 0, idx_end)
if idx_stage2 == -1:
    idx_stage2 = content.rfind("# ├", 0, idx_end)
if idx_stage2 == -1:
    idx_stage2 = content.rfind("#", 0, idx_end)

footer = content[idx_stage2:]

NEW_MIDDLE = """def _calculate_core_lines(clinical_context: dict, tariff_mappings: list) -> list:
    lines = []
    level = (clinical_context.get("level_of_care") or "ILS").upper().strip()
    call_type = clinical_context.get("call_type", "Primary")

    # 1. Base Rate
    base = _find_base_rate(level, call_type, tariff_mappings)
    if base:
        import re as _re
        cpt = str(base["code"]).upper().strip()
        if not _re.match(r"^\d{2,6}$", cpt) and not _re.match(r"^\d{5}$", cpt) and not _re.match(r"^[A-Z]\d{4}$", cpt):
            cpt = "A0427" if level in ("ALS", "ICU") else "A0429"

        lines.append({
            "cpt_code": cpt,
            "nappi_code": None,
            "icd10_primary": None,
            "icd10_secondary": None,
            "description": f"{level or 'EMS'} {call_type} Base Rate — Emergency Transport",
            "modifier": None,
            "quantity": 1,
            "unit_price": base["price"],
            "total_price": base["price"],
            "source": "deterministic",
        })

    # 2. Mileage
    callout = clinical_context.get("callout_distance_km", 0.0)
    loaded = clinical_context.get("loaded_distance_km", 0.0)
    rtb = clinical_context.get("rtb_distance_km", 0.0)
    scene_mins = clinical_context.get("scene_minutes", 0.0)

    if loaded == 0 and rtb == 0 and callout == 0:
        loaded = clinical_context.get("trip_distance_km", 0.0)

    loaded_rate = _find_loaded_mileage_rate(level, tariff_mappings)
    unloaded_rate = _find_unloaded_mileage_rate(level, tariff_mappings)

    if callout > 0:
        r = unloaded_rate or loaded_rate
        if r:
            lines.append({
                "cpt_code": r["code"],
                "nappi_code": None,
                "icd10_primary": None,
                "icd10_secondary": None,
                "description": f"Callout Mileage (Dispatch → Scene) — {callout:.0f} km × R{r['price']:.2f}/km",
                "modifier": None,
                "quantity": int(callout),
                "unit_price": r["price"],
                "total_price": round(r["price"] * callout, 2),
                "source": "deterministic",
            })

    if loaded > 0:
        r = loaded_rate or unloaded_rate
        if r:
            lines.append({
                "cpt_code": r["code"],
                "nappi_code": None,
                "icd10_primary": None,
                "icd10_secondary": None,
                "description": f"Loaded Transport Mileage (Scene → Destination) — {loaded:.0f} km × R{r['price']:.2f}/km",
                "modifier": None,
                "quantity": int(loaded),
                "unit_price": r["price"],
                "total_price": round(r["price"] * loaded, 2),
                "source": "deterministic",
            })

    if rtb > 0:
        r = unloaded_rate or loaded_rate
        if r:
            lines.append({
                "cpt_code": r["code"],
                "nappi_code": None,
                "icd10_primary": None,
                "icd10_secondary": None,
                "description": f"Return to Base Mileage (Destination → Base) — {rtb:.0f} km × R{r['price']:.2f}/km",
                "modifier": None,
                "quantity": int(rtb),
                "unit_price": r["price"],
                "total_price": round(r["price"] * rtb, 2),
                "source": "deterministic",
            })

    # 3. Scene Time
    if scene_mins > 0:
        lines.append({
            "cpt_code": "TIME",
            "nappi_code": None,
            "icd10_primary": None,
            "icd10_secondary": None,
            "description": f"Scene Time (Clinical Holding/Treatment) — {scene_mins:.0f} min",
            "modifier": None,
            "quantity": int(scene_mins),
            "unit_price": 0.0,
            "total_price": 0.0,
            "source": "deterministic",
        })

    # 4. Call Out Fee
    co = _find_call_out_fee(level, call_type, tariff_mappings)
    if co:
        lines.append({
            "cpt_code": co["code"],
            "nappi_code": None,
            "icd10_primary": None,
            "icd10_secondary": None,
            "description": f"ILS Call Out Fee" if level=="ILS" else f"{level} Call Out Fee",
            "modifier": None,
            "quantity": 1,
            "unit_price": co["price"],
            "total_price": co["price"],
            "source": "deterministic",
        })

    return lines


def _find_base_rate(level: str, call_type: str, tariff_mappings: list) -> Optional[dict]:
    level = level.upper().strip()
    search_terms = {"ALS": ["als"], "ILS": ["ils"], "BLS": ["bls"]}.get(level, [level.lower()])
    
    # 0. Base rate category
    bre = [t for t in tariff_mappings if str(t.get("category", "")).lower() == "base_rate"]
    if bre:
        for t in bre:
            desc = str(t.get("description", "")).lower()
            if any(lk in desc for lk in search_terms): return {"code": t.get("code"), "price": _parse_rate(t.get("max_rate"))}
        best = max(bre, key=lambda t: _parse_rate(t.get("max_rate")) or 0)
        return {"code": best.get("code"), "price": _parse_rate(best.get("max_rate"))}
        
    base_keywords = ["base", "call-out", "callout", "call out", "transport", "flat rate"]
    
    # 1. Level matched
    for t in tariff_mappings:
        desc = str(t.get("description", "")).lower()
        if any(lk in desc for lk in search_terms) and any(bk in desc for bk in base_keywords):
            return {"code": t.get("code"), "price": _parse_rate(t.get("max_rate"))}

    # 2. Generic fallback
    for t in tariff_mappings:
        desc = str(t.get("description", "")).lower()
        if any(bk in desc for bk in base_keywords) and "km" not in desc and "mileage" not in desc:
            return {"code": t.get("code"), "price": _parse_rate(t.get("max_rate"))}
    return None


def _find_mileage_rate(level: str, tariff_mappings: list) -> Optional[dict]:
    level = level.upper().strip()
    search_terms = {"ALS": ["als"], "ILS": ["ils"], "BLS": ["bls"]}.get(level, [level.lower()])
    me = [t for t in tariff_mappings if str(t.get("category", "")).lower() == "mileage"]
    if me:
        for t in me:
            if any(lk in str(t.get("description", "")).lower() for lk in search_terms): return {"code": t.get("code"), "price": _parse_rate(t.get("max_rate"))}
        return {"code": me[0].get("code"), "price": _parse_rate(me[0].get("max_rate"))}
    for t in tariff_mappings:
        if any(mk in str(t.get("description", "")).lower() for mk in ["km", "mileage", "per km"]): return {"code": t.get("code"), "price": _parse_rate(t.get("max_rate"))}
    return None

def _find_loaded_mileage_rate(level: str, tariff_mappings: list) -> Optional[dict]:
    search_terms = {"ALS": ["als"], "ILS": ["ils"], "BLS": ["bls"]}.get(level.upper().strip(), [level.lower()])
    for t in tariff_mappings:
        desc = str(t.get("description", "")).lower()
        if any(lk in desc for lk in search_terms) and ("with patient" in desc or "loaded" in desc) and "km" in desc:
            return {"code": t.get("code"), "price": _parse_rate(t.get("max_rate"))}
    return _find_mileage_rate(level, tariff_mappings)

def _find_unloaded_mileage_rate(level: str, tariff_mappings: list) -> Optional[dict]:
    search_terms = {"ALS": ["als"], "ILS": ["ils"], "BLS": ["bls"]}.get(level.upper().strip(), [level.lower()])
    for t in tariff_mappings:
        desc = str(t.get("description", "")).lower()
        if any(lk in desc for lk in search_terms) and ("without patient" in desc or "unloaded" in desc) and "km" in desc:
            return {"code": t.get("code"), "price": _parse_rate(t.get("max_rate"))}
    return _find_mileage_rate(level, tariff_mappings)

def _find_call_out_fee(level: str, call_type: str, tariff_mappings: list) -> Optional[dict]:
    level = level.upper().strip()
    target = {"BLS": "104", "ILS": "126", "ALS": "134"}.get(level, "126")

    for t in tariff_mappings:
        if str(t.get("code", "")).strip() == target: return {"code": target, "price": _parse_rate(t.get("max_rate"))}
        if "call out" in str(t.get("description", "")).lower() and level.lower() in str(t.get("description", "")).lower():
            return {"code": t.get("code"), "price": _parse_rate(t.get("max_rate"))}
            
    is_primary = (call_type == "Primary")
    f = {"104": [0.0, 743.60], "126": [0.0, 1115.20], "134": [0.0, 1974.40]}
    if target in f: return {"code": target, "price": f[target][0] if is_primary else f[target][1]}
    return None

"""

target.write_text(header + NEW_MIDDLE + footer, encoding="utf-8")
print("SUCCESS: Rewrote the tariff_engine.py deterministic core.")
