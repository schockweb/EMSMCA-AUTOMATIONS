import pathlib

target = pathlib.Path("app/services/tariff_engine.py")
content = target.read_text(encoding="utf-8")

old_str = '''        "total_claimed_amount": data.get("total_claimed_amount") or "",
        "icd10_primary": data.get("primary_icd10") or data.get("primary_icd10_code") or data.get("icd10_primary") or "",
    }'''

new_str = '''        "total_claimed_amount": data.get("total_claimed_amount") or "",
        "icd10_primary": data.get("primary_icd10") or data.get("primary_icd10_code") or data.get("icd10_primary") or "",
        "callout_distance_km": data.get("mileage_billable_callout_km", 0.0),
        "loaded_distance_km": data.get("mileage_billable_loaded_km", 0.0),
        "rtb_distance_km": data.get("mileage_billable_rtb_km", 0.0),
        "scene_minutes": data.get("mileage_scene_minutes", 0.0),
    }'''

if old_str in content:
    content = content.replace(old_str, new_str)
    target.write_text(content, encoding="utf-8")
    print("SUCCESS: _build_clinical_context patched successfully")
else:
    print("FAILED: old string not found")

