import pathlib
import re

target = pathlib.Path("app/services/tariff_engine.py")
content = target.read_text(encoding="utf-8")

# 1. Update _build_clinical_context
new_ctx = '''        "total_claimed_amount": data.get("total_claimed_amount") or "",
        "icd10_primary": data.get("primary_icd10") or data.get("primary_icd10_code") or data.get("icd10_primary") or "",
    }'''
content = re.sub(r'        "total_claimed_amount": data.get\("total_claimed_amount"\) or "",\n    \}', new_ctx, content)


# 2. Add icd10 to _calculate_core_lines
new_calc = '''def _calculate_core_lines(clinical_context: dict, tariff_mappings: list) -> list:
    lines = []
    level = (clinical_context.get("level_of_care") or "ILS").upper().strip()
    call_type = clinical_context.get("call_type", "Primary")
    icd10 = clinical_context.get("icd10_primary") or None

    # 1. Base Rate
    base = _find_base_rate(level, call_type, tariff_mappings)
    if base:
        import re as _re
        cpt = str(base["code"]).upper().strip()
        if not _re.match(r"^\\d{2,6}$", cpt) and not _re.match(r"^\\d{5}$", cpt) and not _re.match(r"^[A-Z]\\d{4}$", cpt):
            cpt = "A0427" if level in ("ALS", "ICU") else "A0429"

        lines.append({
            "cpt_code": cpt,
            "nappi_code": None,
            "icd10_primary": icd10,
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
                "icd10_primary": icd10,
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
                "icd10_primary": icd10,
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
                "icd10_primary": icd10,
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
            "icd10_primary": icd10,
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
            "icd10_primary": icd10,
            "icd10_secondary": None,
            "description": f"ILS Call Out Fee" if level=="ILS" else f"{level} Call Out Fee",
            "modifier": None,
            "quantity": 1,
            "unit_price": co["price"],
            "total_price": co["price"],
            "source": "deterministic",
        })

    return lines'''

idx_start = content.find('def _calculate_core_lines(clinical_context: dict, tariff_mappings: list) -> list:')
idx_end = content.find('def _find_base_rate(level: str, call_type: str, tariff_mappings: list)', idx_start)

content = content[:idx_start] + new_calc + '\n\n\n' + content[idx_end:]

target.write_text(content, encoding='utf-8')
print('SUCCESS: Substituted icd10_primary safely inside tariff engine')
