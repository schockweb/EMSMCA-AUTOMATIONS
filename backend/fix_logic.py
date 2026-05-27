import pathlib
import re

target = pathlib.Path("app/services/tariff_engine.py")
content = target.read_text(encoding="utf-8")

# 1. Update _find_base_rate
old_base_keywords = 'base_keywords = ["base", "call-out", "callout", "call out", "transport", "flat rate"]'
new_base_keywords = 'base_keywords = ["base", "up to 45", "up to 60", "transport", "flat rate"]'
if old_base_keywords in content:
    content = content.replace(old_base_keywords, new_base_keywords)

# 2. Update _find_call_out_fee
# I need to replace the entire _find_call_out_fee function
def_find_call_out_fee_new = '''def _find_call_out_fee(level: str, call_type: str, tariff_mappings: list) -> Optional[dict]:
    level = level.upper().strip()
    target = {"BLS": "104", "ILS": "126", "ALS": "134"}.get(level, "126")

    # Look specifically for the exact code or a description match
    for t in tariff_mappings:
        if str(t.get("code", "")).strip() == target: 
            return {"code": target, "price": _parse_rate(t.get("max_rate"))}
        if "call out" in str(t.get("description", "")).lower() and level.lower() in str(t.get("description", "")).lower():
            return {"code": t.get("code"), "price": _parse_rate(t.get("max_rate"))}
    
    return None'''

# Find the start of _find_call_out_fee
idx_start = content.find('def _find_call_out_fee(level: str, call_type: str, tariff_mappings: list) -> Optional[dict]:')
if idx_start != -1:
    # Find the next function or end of file
    idx_next = content.find('def _', idx_start + 10)
    if idx_next == -1: idx_next = len(content)
    
    content = content[:idx_start] + def_find_call_out_fee_new + '\n\n' + content[idx_next:]

target.write_text(content, encoding="utf-8")
print("SUCCESS")
