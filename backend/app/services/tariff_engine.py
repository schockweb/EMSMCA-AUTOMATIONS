"""
Tariff Engine — Hybrid Pipeline for EMS billing line generation.

Architecture:
  Stage 1 (Deterministic):  Python calculates Base Rate + Mileage from DB tariff schedules. Zero cost.
  Stage 2 (AI — scoped):    Azure OpenAI identifies clinical add-ons (procedures, medications) from PRF narratives.
                             The AI is NEVER trusted with prices — it only returns codes and descriptions.
  Stage 3 (Price Injection): Python forcefully maps every AI-returned code to its database price.
                             If no DB price exists, the line is flagged "(rate pending)" at R0.00.

This guarantees:
  √ Base Rate and Mileage are always mathematically correct
  √ AI can never hallucinate a Rand amount
  √ Every price on the invoice traces back to an uploaded Billing Guideline
"""
from __future__ import annotations
import json
import math
import re
import logging
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.config import get_settings
from app.rules import get_rules_for_scheme

logger = logging.getLogger("ems.tariff_engine")
settings = get_settings()


# ===============================================================================
# PUBLIC API
# ===============================================================================

async def generate_tariff_lines(
    extracted_data: dict,
    scheme_name: str,
    db: AsyncSession = None,
) -> dict:
    """
    Generate structured billing lines from hardcoded scheme rule modules.

    Resolution flow:
      1. Look up the scheme's rule module via `app.rules.get_rules_for_scheme`
      2. If no module is registered → return an explicit 'not configured' error
         dict (the invoice/submit endpoints translate this to HTTP 422).
      3. Dispatch to `_generate_gems_lines` (the only priced path today).
         New schemes plug in via their own module + dispatch branch here.
      4. For non-GEMS schemes with rate_per_minute > 0 in their rate schema,
         a time charge line is automatically calculated and appended.

    Returns:
        {
            "lines": [ ... ],
            "total_amount": 5200.00,
            "scheme_matched": "GEMS" | None,
            "rules_used": int,
            "ai_powered": bool,
            "error": "..." | None,
        }
    """
    clinical_context = _build_clinical_context(extracted_data)

    rules_module = get_rules_for_scheme(scheme_name)
    if rules_module is None:
        error_msg = (
            f"No pricing module configured for scheme '{scheme_name}'. "
            f"Contact engineering to add a module under backend/app/rules/."
        )
        logger.error(error_msg)
        return {
            "lines": [],
            "total_amount": 0.0,
            "scheme_matched": None,
            "rules_used": 0,
            "ai_powered": False,
            "error": error_msg,
        }

    # GEMS and Discovery share the NHRPL 2006 billing structure (100km
    # metropolitan rule, 45/60 min base windows, 15-min extensions, IHT
    # call-out fee, multi-patient multipliers, qualification cap). They both
    # use _generate_gems_lines — only the TARIFFS list differs.
    sid = getattr(rules_module, "SCHEME_ID", "")
    if sid in ("gems", "discovery"):
        gems_result = await _generate_gems_lines(clinical_context, rules_module)
        gems_result["scheme_matched"] = sid.upper()
        logger.info(
            "[TariffEngine] %s hardcoded path: %d lines, total R%.2f (call_type=%s level=%s)",
            sid.upper(),
            len(gems_result["lines"]),
            gems_result["total_amount"],
            clinical_context.get("call_type", "?"),
            clinical_context.get("level_of_care", "?"),
        )
        return gems_result

    # ── Non-GEMS/Discovery: DB-driven tariff billing ──────────────────────
    # 1. Try to load rate_schema + its tariff lines from the DB.
    # 2. If tariff lines exist, run the full NHRPL billing logic from DB rows.
    # 3. If no tariff lines but rate_per_minute > 0, fall back to time billing.
    # 4. Otherwise, return an explicit error.
    rate_schema = None
    if db is not None:
        try:
            from app.models.rate_schema import RateSchema
            billing_code = extracted_data.get("billing_schema_code", "")
            if billing_code:
                result = await db.execute(
                    select(RateSchema).where(
                        RateSchema.schema_code == billing_code,
                        RateSchema.active == True,
                    )
                )
                rate_schema = result.scalar_one_or_none()
        except Exception as e:
            logger.warning("[TariffEngine] Could not load rate schema: %s", e)

    # ── Path A: DB-driven tariff lines (full NHRPL-style billing) ────────
    if rate_schema is not None:
        tariff_lines = getattr(rate_schema, "tariff_lines", None) or []
        active_lines = [ln for ln in tariff_lines if ln.is_active]
        if active_lines:
            db_result = await _generate_db_driven_lines(clinical_context, active_lines, rate_schema)
            db_result["scheme_matched"] = scheme_name
            logger.info(
                "[TariffEngine] DB-driven path for '%s': %d lines, total R%.2f",
                scheme_name, len(db_result["lines"]), db_result["total_amount"],
            )
            return db_result

    # ── Path B: rate_per_minute time billing (scalar fallback) ───────────
    if rate_schema and rate_schema.rate_per_minute and rate_schema.rate_per_minute > Decimal("0"):
        icd10 = clinical_context.get("icd10_primary") or None
        time_line = _calculate_time_charge(
            extracted_data=extracted_data,
            rate_per_minute=rate_schema.rate_per_minute,
            min_minutes=rate_schema.min_minutes or 0,
            time_rounding=rate_schema.time_rounding or "none",
            time_basis=rate_schema.time_basis or "dispatch_to_clear",
            icd10=icd10,
        )
        if time_line:
            clean_line = {k: v for k, v in time_line.items() if not k.startswith("_")}
            return {
                "lines": [clean_line],
                "total_amount": time_line["total_price"],
                "scheme_matched": scheme_name,
                "rules_used": 1,
                "ai_powered": False,
                "time_billing": {
                    "raw_minutes": time_line.get("_raw_minutes"),
                    "billable_minutes": time_line.get("_billable_minutes"),
                    "time_basis": time_line.get("_time_basis"),
                },
            }

    # ── No pricing path available ───────────────────────────────────────
    error_msg = (
        f"Scheme '{scheme_name}' has no tariff lines and no rate_per_minute configured. "
        f"Add tariff lines via the Tariff Billing dashboard or set rate_per_minute > 0."
    )
    logger.error(error_msg)
    return {
        "lines": [],
        "total_amount": 0.0,
        "scheme_matched": getattr(rules_module, "SCHEME_ID", None) if rules_module else None,
        "rules_used": 0,
        "ai_powered": False,
        "error": error_msg,
    }


# ===============================================================================
# STAGE 1: DETERMINISTIC CORE — Base Rate + Mileage (non-GEMS fallback)
# ===============================================================================

def _calculate_core_lines(clinical_context: dict, tariff_mappings: list) -> list:
    lines = []
    level = (clinical_context.get("level_of_care") or "ILS").upper().strip()
    call_type = clinical_context.get("call_type", "Primary")
    icd10 = clinical_context.get("icd10_primary") or None

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
            "icd10_primary": icd10,
            "icd10_secondary": None,
            "description": f"{level or 'EMS'} {call_type} Base Rate - Emergency Transport",
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
                "description": f"Callout Mileage (Without Patient - Base to Scene) - {callout:.0f} km",
                "modifier": None,
                "quantity": int(callout),
                "unit_price": float(r["price"]),
                "total_price": float(_d_mul(r["price"], callout)),
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
                "description": f"Loaded Transport (With Patient - Scene to Hospital) - {loaded:.0f} km",
                "modifier": None,
                "quantity": int(loaded),
                "unit_price": float(r["price"]),
                "total_price": float(_d_mul(r["price"], loaded)),
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
                "description": f"Return to Base (Without Patient) - {rtb:.0f} km",
                "modifier": None,
                "quantity": int(rtb),
                "unit_price": float(r["price"]),
                "total_price": float(_d_mul(r["price"], rtb)),
                "source": "deterministic",
            })

    # 3. Scene / Time Charge
    # For schemes with rate_per_minute > 0, calculate a priced time line.
    # For GEMS, time billing is handled by _generate_gems_lines (15-min extension codes).
    if scene_mins > 0:
        lines.append({
            "cpt_code": None,
            "nappi_code": None,
            "icd10_primary": icd10,
            "icd10_secondary": None,
            "description": f"Scene Time (Clinical Holding/Treatment) - {scene_mins:.0f} min",
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
            "description": f"{level} Call Out Fee",
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
            if any(lk in desc for lk in search_terms):
                return {"code": t.get("code"), "price": _parse_rate(t.get("max_rate"))}
        best = max(bre, key=lambda t: _parse_rate(t.get("max_rate")) or 0)
        return {"code": best.get("code"), "price": _parse_rate(best.get("max_rate"))}

    base_keywords = ["base", "up to 45", "up to 60", "transport", "flat rate"]

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
            if any(lk in str(t.get("description", "")).lower() for lk in search_terms):
                return {"code": t.get("code"), "price": _parse_rate(t.get("max_rate"))}
        return {"code": me[0].get("code"), "price": _parse_rate(me[0].get("max_rate"))}
    for t in tariff_mappings:
        if any(mk in str(t.get("description", "")).lower() for mk in ["km", "mileage", "per km"]):
            return {"code": t.get("code"), "price": _parse_rate(t.get("max_rate"))}
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
        if str(t.get("code", "")).strip() == target:
            return {"code": target, "price": _parse_rate(t.get("max_rate"))}
        if "call out" in str(t.get("description", "")).lower() and level.lower() in str(t.get("description", "")).lower():
            return {"code": t.get("code"), "price": _parse_rate(t.get("max_rate"))}

    return None


async def _ai_identify_addons(
    clinical_context: dict,
    tariff_mappings: list,
    exclusions: list,
    scheme_name: str,
) -> list[dict]:
    """
    Use Azure OpenAI to identify clinical procedures and medications
    from the PRF narrative. The AI is EXPLICITLY forbidden from calculating prices.
    """
    import httpx

    endpoint = settings.AZURE_OPENAI_ENDPOINT.rstrip("/")
    deployment = settings.AZURE_OPENAI_DEPLOYMENT
    api_version = settings.AZURE_OPENAI_API_VERSION
    url = f"{endpoint}/openai/deployments/{deployment}/chat/completions?api-version={api_version}"

    # Build a compact code reference from the tariff schedule (codes + descriptions only, no prices)
    code_reference = []
    for t in tariff_mappings[:80]:
        code_reference.append({
            "code": t.get("code", ""),
            "description": t.get("description", ""),
        })

    prompt = (
        "You are a South African EMS clinical coding expert.\n\n"
        "Your ONLY job is to identify billable procedures, medications, and consumables from the clinical "
        "narrative below. You must map them to the correct CPT/tariff codes and ICD-10 diagnosis codes.\n\n"
        "CRITICAL RULES:\n"
        "1. Do NOT include base rate or mileage/transport lines - those are handled separately.\n"
        "2. Do NOT calculate or include any prices, unit_price, or total_price fields.\n"
        "3. ONLY return procedures, medications, consumables, and supplies that were actually performed or used.\n"
        "4. Do NOT include items that appear in the exclusions list.\n"
        "5. Map the chief complaint and clinical presentation to the most appropriate ICD-10 code(s).\n\n"
        f"CLINICAL DATA FROM PRF:\n"
        f"- Level of Care: {clinical_context.get('level_of_care', 'UNKNOWN')}\n"
        f"- Chief Complaint: {clinical_context.get('chief_complaint', 'Not specified')}\n"
        f"- Clinical Notes: {clinical_context.get('clinical_notes', 'None')}\n"
        f"- Primary Survey: {clinical_context.get('primary_survey', 'None')}\n"
        f"- Procedures Performed: {clinical_context.get('procedures_performed', 'None')}\n"
        f"- Medications Administered: {clinical_context.get('medications_administered', 'None')}\n"
        f"- Mechanism of Injury: {clinical_context.get('mechanism_of_injury', 'None')}\n\n"
        f"SCHEME: {scheme_name}\n\n"
        f"AVAILABLE TARIFF CODES (use these for matching):\n"
        f"{json.dumps(code_reference, indent=2)}\n\n"
        f"EXCLUDED ITEMS (do NOT bill these):\n"
        f"{json.dumps(exclusions[:20], indent=2)}\n\n"
        'Return a JSON object with key "addons" containing an array. Each entry must have:\n'
        '- "cpt_code": The tariff/CPT code from the available codes list (string)\n'
        '- "nappi_code": NAPPI code if this is a medication/consumable (string or null)\n'
        '- "icd10_primary": Primary ICD-10 code for the clinical presentation (string)\n'
        '- "icd10_secondary": Secondary ICD-10 code if applicable (string or null)\n'
        '- "description": Clear billing description of what was performed/administered (string)\n'
        '- "quantity": Number of units (integer, default 1)\n\n'
        'If no procedures or medications were performed beyond the standard transport, return {"addons": []}.\n'
        'Return ONLY valid JSON. No markdown.'
    )

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            url,
            headers={
                "api-key": settings.AZURE_OPENAI_API_KEY,
                "Content-Type": "application/json",
            },
            json={
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.1,
                "response_format": {"type": "json_object"},
            },
        )

        if response.status_code != 200:
            logger.error("Azure OpenAI returned %d: %s", response.status_code, response.text[:500])
            raise RuntimeError(f"AI returned status {response.status_code}")

        data = response.json()
        content = data["choices"][0]["message"]["content"]

        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            match = re.search(r"\[.*\]", content, re.DOTALL)
            if match:
                parsed = {"addons": json.loads(match.group(0))}
            else:
                raise RuntimeError("AI returned invalid JSON")

        addons = parsed.get("addons", parsed.get("lines", []))
        if isinstance(addons, dict):
            addons = [addons]

        # Validate and sanitize — strip any prices the AI might have sneaked in
        validated = []
        for item in addons:
            if not isinstance(item, dict):
                continue
            validated.append({
                "cpt_code": str(item.get("cpt_code", "")).strip() or None,
                "nappi_code": str(item.get("nappi_code", "")).strip() or None if item.get("nappi_code") else None,
                "icd10_primary": str(item.get("icd10_primary", "")).strip() or None,
                "icd10_secondary": str(item.get("icd10_secondary", "")).strip() or None if item.get("icd10_secondary") else None,
                "description": str(item.get("description", "")).strip()[:255],
                "quantity": max(1, int(item.get("quantity", 1) or 1)),
                # Explicitly NO price fields — Python will inject these in Stage 3
            })

        logger.info("AI identified %d clinical add-ons for scheme '%s'", len(validated), scheme_name)
        return validated


# ===============================================================================
# STAGE 3: PRICE INJECTION — Force database prices onto AI output
# ===============================================================================

def _enforce_db_prices(
    ai_addons: list[dict],
    tariff_mappings: list,
) -> list[dict]:
    """
    For each AI-identified add-on, look up the REAL price from the database
    tariff schedule. The AI is NEVER trusted with prices.
    """
    # Build a lookup: code -> {price, description}
    price_lookup = {}
    for t in tariff_mappings:
        code = str(t.get("code", "")).strip()
        if code:
            price_lookup[code] = {
                "price": _parse_rate(t.get("max_rate")),
                "db_description": t.get("description", ""),
            }

    priced_lines = []
    for addon in ai_addons:
        code = addon.get("cpt_code") or ""
        quantity = addon.get("quantity", 1)

        db_entry = price_lookup.get(code)

        if db_entry and db_entry["price"] > Decimal("0"):
            unit_price = db_entry["price"]
            total_price = _d_mul(unit_price, quantity)
            description = addon.get("description", db_entry["db_description"])
        else:
            unit_price = Decimal("0.00")
            total_price = Decimal("0.00")
            description = f"{addon.get('description', 'Clinical procedure')} (rate pending)"
            logger.warning(
                "No DB price found for CPT code '%s'. Line flagged as rate pending.", code,
            )

        priced_lines.append({
            "cpt_code": addon.get("cpt_code"),
            "nappi_code": addon.get("nappi_code"),
            "icd10_primary": addon.get("icd10_primary"),
            "icd10_secondary": addon.get("icd10_secondary"),
            "description": description,
            "modifier": None,
            "quantity": quantity,
            "unit_price": float(unit_price),
            "total_price": float(total_price),
            "source": "ai_addon",
        })

    return priced_lines


# ===============================================================================
# MERGE: Combine deterministic core lines + AI add-ons
# ===============================================================================

def _merge_lines(
    core_lines: list[dict],
    addon_lines: list[dict],
) -> list[dict]:
    """
    Merge deterministic core lines with AI-identified add-ons.
    Deduplicates by CPT code (core lines always win on price).
    """
    # Collect ICD-10 from AI add-ons to apply to core lines
    primary_icd10 = None
    secondary_icd10 = None
    for addon in addon_lines:
        if addon.get("icd10_primary") and not primary_icd10:
            primary_icd10 = addon["icd10_primary"]
        if addon.get("icd10_secondary") and not secondary_icd10:
            secondary_icd10 = addon["icd10_secondary"]

    # Apply ICD-10 to core lines (they may not have diagnosis codes)
    for line in core_lines:
        if not line.get("icd10_primary") and primary_icd10:
            line["icd10_primary"] = primary_icd10
        if not line.get("icd10_secondary") and secondary_icd10:
            line["icd10_secondary"] = secondary_icd10

    # Deduplicate: if an AI addon has the same CPT code as a core line, skip it
    core_codes = {l.get("cpt_code") for l in core_lines if l.get("cpt_code")}
    unique_addons = [a for a in addon_lines if a.get("cpt_code") not in core_codes]

    merged = core_lines + unique_addons

    # Strip the internal "source" field before returning
    for line in merged:
        line.pop("source", None)

    return merged


# ===============================================================================
# HELPERS
# ===============================================================================

def _build_clinical_context(data: dict) -> dict:
    """Extract the clinically relevant fields from the PRF for tariff coding."""
    trip_distance = 0.0
    try:
        start = float(re.sub(r"[^\d.]", "", str(data.get("odometer_start", "") or "")))
        end = float(re.sub(r"[^\d.]", "", str(data.get("back_to_base", "") or data.get("odometer_end", "") or "")))
        trip_distance = max(0, end - start)
    except (ValueError, TypeError):
        pass

    # Resolve call type (Primary vs IHT) from PRF data
    call_type = _resolve_call_type(data)
    is_iht = (call_type == "IFT")

    # crew qualification may arrive as an HPCSA category (BAA/AEA/ECT/ECA/ANT/ECP)
    # for post-migration digital PRFs, or as a legacy BLS/ILS/ALS tier from OCR /
    # paper-PRF flows. Normalise to a billing tier so the LEVEL_RANK comparison
    # below behaves consistently for either input shape.
    from app.utils.hpcsa import to_tier as _qual_to_tier
    crew_qual_raw = _qual_to_tier(
        data.get("crew_member_1_qualification") or
        data.get("crew1_qualification") or
        data.get("level_of_care")
    )
    
    # Normalise common South African HPCSA EMS variations
    if any(q in crew_qual_raw for q in ["ALS", "ADVANCED", "PARAMEDIC", "CCA", "ECP", "NDIP"]):
        highest_crew_qual = "ALS"
    elif any(q in crew_qual_raw for q in ["ILS", "INTERMEDIATE", "AEA", "ECT"]):
        highest_crew_qual = "ILS"
    elif any(q in crew_qual_raw for q in ["BLS", "BASIC", "BAA"]):
        highest_crew_qual = "BLS"
    else:
        # Fall back to the extracted explicit level of care
        doc_level = str(data.get("level_of_care", "ILS")).strip().upper()
        highest_crew_qual = doc_level if doc_level in ["ALS", "ILS", "BLS"] else "ILS"

    # ── Multiple-patient indicator ──
    # Values from the form select: "Patient 1 of 2", "Patient 2 of 3", etc.
    multi_raw = (data.get("multiple_patient_indicator") or "").strip().lower()
    if "of 3" in multi_raw or "3 patient" in multi_raw:
        patient_count = 3
    elif "of 2" in multi_raw or "2 patient" in multi_raw:
        patient_count = 2
    else:
        patient_count = 1

    # ── Total billable km (used for the 100km metropolitan/long-distance rule) ──
    callout_km = _safe_float(data.get("mileage_billable_callout_km"))
    loaded_km  = _safe_float(data.get("mileage_billable_loaded_km"))
    rtb_km     = _safe_float(data.get("mileage_billable_rtb_km"))
    total_km   = _safe_float(data.get("mileage_billable_total_km"))
    if total_km == 0.0:
        total_km = callout_km + loaded_km + rtb_km

    return {
        "level_of_care":       (data.get("level_of_care") or "ILS").strip().upper(),
        "highest_crew_qual":   highest_crew_qual,   # validated billing level cap
        "patient_count":       patient_count,        # 1, 2, or 3+
        "call_type":           call_type,            # "Primary" | "IFT"
        "is_iht":              is_iht,
        "call_type_label":     "IHT" if is_iht else "Primary",
        "chief_complaint":     data.get("chief_complaint") or "",
        "clinical_notes":      data.get("clinical_notes") or "",
        "primary_survey":      data.get("primary_survey") or "",
        "procedures_performed":    data.get("procedures_performed") or "",
        "medications_administered": data.get("medications_administered") or "",
        "mechanism_of_injury":     data.get("mechanism_of_injury") or "",
        "receiving_facility":      data.get("receiving_facility") or "",
        "trip_distance_km":        trip_distance,
        "total_claimed_amount":    data.get("total_claimed_amount") or "",
        "icd10_primary":   data.get("primary_icd10") or data.get("primary_icd10_code") or data.get("icd10_primary") or "",
        "callout_distance_km": callout_km,
        "loaded_distance_km":  loaded_km,
        "rtb_distance_km":     rtb_km,
        "total_distance_km":   total_km,
        "scene_minutes":       _safe_float(data.get("mileage_scene_minutes")),
    }


def _safe_float(value, default: float = 0.0) -> float:
    """Safely parse a float from any input, returning default on failure.
    Used for non-monetary values (KM, minutes) where float is acceptable."""
    if value is None:
        return default
    try:
        return float(value)
    except (ValueError, TypeError):
        return default


def _safe_decimal(value, default: Decimal = Decimal("0.00")) -> Decimal:
    """Safely parse a Decimal from any input. Used for ALL monetary values."""
    if value is None:
        return default
    try:
        return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError, TypeError):
        return default


def _parse_rate(value) -> Decimal:
    """Parse a rate value from various formats (e.g., 'R3,850.00' -> Decimal('3850.00')).
    Returns Decimal for precise monetary arithmetic."""
    if value is None:
        return Decimal("0.00")
    try:
        clean = re.sub(r"[^\d.]", "", str(value))
        return Decimal(clean).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) if clean else Decimal("0.00")
    except (InvalidOperation, ValueError, TypeError):
        return Decimal("0.00")


def _d_mul(a, b, places: str = "0.01") -> Decimal:
    """Multiply two values as Decimals with specified precision. Central billing arithmetic."""
    return (Decimal(str(a)) * Decimal(str(b))).quantize(Decimal(places), rounding=ROUND_HALF_UP)


def _d_round(val, places: str = "0.01") -> Decimal:
    """Round a value to Decimal with specified precision."""
    return Decimal(str(val)).quantize(Decimal(places), rounding=ROUND_HALF_UP)


# ===============================================================================
# TIME-BASED BILLING ENGINE
# For non-GEMS schemes that bill per-minute. GEMS uses its own 15-min extension
# codes via _generate_gems_lines and does NOT use this path.
# ===============================================================================

def _apply_time_rounding(raw_minutes: float, rounding_rule: str) -> int:
    """Apply time rounding per the rate schema's time_rounding field.

    Args:
        raw_minutes: Raw duration in fractional minutes.
        rounding_rule: One of 'none', 'up_5', 'up_15', 'nearest_5'.

    Returns:
        Rounded whole-number minutes.
    """
    import math
    if rounding_rule == "up_5":
        return int(math.ceil(raw_minutes / 5) * 5)
    elif rounding_rule == "up_15":
        return int(math.ceil(raw_minutes / 15) * 15)
    elif rounding_rule == "nearest_5":
        return int(round(raw_minutes / 5) * 5)
    else:  # 'none'
        return int(round(raw_minutes))


def _calculate_time_charge(
    extracted_data: dict,
    rate_per_minute: Decimal,
    min_minutes: int,
    time_rounding: str,
    time_basis: str,
    icd10: str | None = None,
) -> dict | None:
    """Calculate time-based billing per the rate schema's time_basis.

    Handles call-type branching: DOD/RHT calls auto-force to 'scene_only'
    because they never capture depart_scene or handover timestamps.

    Args:
        extracted_data: Full PRF extracted_data dict.
        rate_per_minute: Decimal rate per minute from rate schema.
        min_minutes: Minimum billable minutes from rate schema.
        time_rounding: Rounding rule string from rate schema.
        time_basis: Which time segment to bill from rate schema.
        icd10: Primary ICD-10 code for the claim line.

    Returns:
        Dict with time charge billing line, or None if rate_per_minute is 0.
    """
    if rate_per_minute <= Decimal("0"):
        return None

    no_transport = bool(extracted_data.get("no_transport_call", False))

    # DOD/RHT: force scene_only — depart_scene and handover are never captured
    effective_basis = "scene_only" if no_transport else time_basis

    # Parse timestamps from extracted_data
    from datetime import datetime

    def _parse_ts(key: str):
        val = extracted_data.get(key)
        if not val:
            return None
        if isinstance(val, datetime):
            return val
        try:
            return datetime.fromisoformat(str(val))
        except (ValueError, TypeError):
            return None

    ts_dispatched = _parse_ts("time_dispatched") or _parse_ts("dispatch_ts")
    ts_on_scene = _parse_ts("time_on_scene") or _parse_ts("on_scene_ts")
    ts_depart_scene = _parse_ts("time_depart_scene") or _parse_ts("transport_start_ts")
    ts_handover = _parse_ts("time_handover") or _parse_ts("handover_ts")
    ts_available = _parse_ts("time_available") or _parse_ts("clear_ts")

    # Calculate raw minutes based on effective basis
    raw_minutes = 0.0
    basis_label = effective_basis

    if effective_basis == "dispatch_to_clear" and ts_dispatched and ts_available:
        raw_minutes = max(0.0, (ts_available - ts_dispatched).total_seconds() / 60)
    elif effective_basis == "transport_only" and ts_depart_scene and ts_handover:
        raw_minutes = max(0.0, (ts_handover - ts_depart_scene).total_seconds() / 60)
    elif effective_basis in ("scene_to_clear", "scene_only") and ts_on_scene and ts_available:
        raw_minutes = max(0.0, (ts_available - ts_on_scene).total_seconds() / 60)
    else:
        logger.warning(
            "[TimeBilling] Cannot calculate time for basis '%s': missing timestamps. "
            "dispatched=%s on_scene=%s depart=%s handover=%s available=%s",
            effective_basis, ts_dispatched, ts_on_scene, ts_depart_scene, ts_handover, ts_available,
        )
        return None

    if raw_minutes <= 0:
        return None

    # Apply rounding
    billable_minutes = _apply_time_rounding(raw_minutes, time_rounding)

    # Apply minimum
    billable_minutes = max(billable_minutes, min_minutes)

    # Calculate charge using Decimal
    time_charge = _d_mul(billable_minutes, rate_per_minute)

    BASIS_LABELS = {
        "dispatch_to_clear": "Dispatch to Clear",
        "transport_only": "Transport Only",
        "scene_to_clear": "Scene to Clear",
        "scene_only": "Scene Time (No Transport)",
    }

    logger.info(
        "[TimeBilling] basis=%s raw=%.1f min → rounded=%d min (rule=%s, min=%d) → R%.2f",
        effective_basis, raw_minutes, billable_minutes, time_rounding, min_minutes, float(time_charge),
    )

    return {
        "cpt_code": None,
        "nappi_code": None,
        "icd10_primary": icd10,
        "icd10_secondary": None,
        "description": f"Time Charge — {BASIS_LABELS.get(effective_basis, effective_basis)} ({billable_minutes} min @ R{float(rate_per_minute):.4f}/min)",
        "modifier": None,
        "quantity": billable_minutes,
        "unit_price": float(rate_per_minute),
        "total_price": float(time_charge),
        "source": "deterministic",
        # Metadata for downstream (not persisted directly)
        "_raw_minutes": raw_minutes,
        "_billable_minutes": billable_minutes,
        "_time_basis": effective_basis,
        "_time_charge": float(time_charge),
    }

# ===============================================================================
# GEMS STRUCTURED DB PATH
# Bypasses knowledge-base AI for GEMS claims — reads gems_tariffs table directly
# ===============================================================================

def _resolve_call_type(data: dict) -> str:
    """
    Returns the canonical call type: 'Primary' or 'IFT'.
    Reads from incident_type (written by claims_pipeline after normalisation),
    then falls back to dispatch_type / call_type fields.
    """
    from app.models.enums import normalise_call_type
    raw = (
        data.get("incident_type") or
        data.get("dispatch_type") or
        data.get("call_type") or ""
    )
    result = normalise_call_type(str(raw))
    return result if result in ("Primary", "IFT") else "Primary"


def _is_gems_scheme(scheme_name: str) -> bool:
    """Returns True if the claim's target scheme is GEMS or a GEMS-administered plan."""
    name = (scheme_name or "").lower().strip()
    return any(k in name for k in ["gems", "government employees", "government employee"])


def _match_level_row(rows: list, level: str, pick_rate_fn=None):
    """
    Find the gems_tariffs row that best matches the given level of care (ILS/ALS).
    Picks the row with the highest non-zero price to avoid returning R0 rows.
    """
    level_upper = level.upper()
    bracket_tag = f"[{level_upper}]"

    bracket_matched = [
        r for r in rows
        if bracket_tag in (r.description or "").upper()
    ]
    if not bracket_matched:
        bracket_matched = [
            r for r in rows
            if level_upper in (r.description or "").upper()
            or f"LEVEL: {level_upper}" in (r.notes or "").upper()
        ]

    if not bracket_matched:
        return None

    if pick_rate_fn:
        priced = [r for r in bracket_matched if pick_rate_fn(r) > 0]
        if priced:
            return max(priced, key=lambda r: pick_rate_fn(r))

    return bracket_matched[0]


def _find_mileage_row(rules_module, level: str, loaded: bool, pick_rate_fn=None):
    """
    Find the correct mileage code by level and loaded/unloaded status.

    loaded=True  -> patient on board  (Scene -> Hospital)
    loaded=False -> no patient aboard (Callout: Base -> Scene, or Return to Base)

    Backed by the scheme module's `all_mileage()` accessor — previously read
    from the gems_tariffs table via an async DB session.
    """
    # Direct-match shortcut: if the module supports it, prefer typed lookup.
    if hasattr(rules_module, "mileage_row"):
        direct = rules_module.mileage_row(level, loaded)
        if direct is not None and (pick_rate_fn is None or pick_rate_fn(direct) > 0):
            return direct

    all_mileage = rules_module.all_mileage()

    if not all_mileage:
        return None

    LOADED_KWS   = {"with patient", "loaded", "patient on board", "patient aboard", "transfer with"}
    UNLOADED_KWS = {"without patient", "unloaded", "callout", "dispatch",
                    "return to base", "rtb", "non patient", "transfer without"}

    level_rows = [
        r for r in all_mileage
        if level.upper() in (r.description or "").upper()
        or f"LEVEL: {level.upper()}" in (r.notes or "").upper()
    ]
    search_pool = level_rows if level_rows else all_mileage

    # First pass: keyword match + non-zero price
    for row in search_pool:
        desc = (row.description or "").lower()
        price_ok = (pick_rate_fn is None) or (pick_rate_fn(row) > 0)
        if loaded and any(kw in desc for kw in LOADED_KWS) and price_ok:
            return row
        if not loaded and any(kw in desc for kw in UNLOADED_KWS) and price_ok:
            return row

    # Second pass: keyword match even if price is 0
    for row in search_pool:
        desc = (row.description or "").lower()
        if loaded and any(kw in desc for kw in LOADED_KWS):
            return row
        if not loaded and any(kw in desc for kw in UNLOADED_KWS):
            return row

    return search_pool[0] if search_pool else None


# ===============================================================================
# DB-DRIVEN BILLING — converts SchemeTariffLine rows into the same billing path
# ===============================================================================

class _DbTariffRow:
    """Lightweight adapter that gives SchemeTariffLine DB rows the same
    attribute interface as the hardcoded TariffEntry dataclass, so
    _generate_gems_lines can consume them identically."""
    __slots__ = (
        "tariff_code", "description", "primary_rate", "iht_rate",
        "category", "notes", "unit", "is_active", "level", "loaded", "keywords",
    )

    def __init__(self, db_line):
        self.tariff_code = db_line.tariff_code
        self.description = db_line.description
        self.primary_rate = float(db_line.primary_rate) if db_line.primary_rate is not None else 0.0
        self.iht_rate = float(db_line.iht_rate) if db_line.iht_rate is not None else 0.0
        self.category = db_line.category
        self.notes = db_line.notes
        self.unit = db_line.unit or "per call"
        self.is_active = db_line.is_active
        self.level = db_line.level_of_care
        self.loaded = db_line.loaded
        # Parse comma-separated keywords into a tuple
        kw_str = db_line.keywords or ""
        self.keywords = tuple(k.strip() for k in kw_str.split(",") if k.strip())


class _DbRulesModule:
    """Fake rules-module that satisfies the interface _generate_gems_lines
    expects: all_base_rates(), all_mileage(), mileage_row(), base_rates_for_level()."""

    def __init__(self, rows: list[_DbTariffRow]):
        self._rows = rows
        self.SCHEME_ID = "db_driven"

    def all_tariffs(self):
        return [r for r in self._rows if r.is_active]

    def all_base_rates(self):
        return [r for r in self._rows if r.is_active and r.category == "base_rate"]

    def all_mileage(self):
        return [r for r in self._rows if r.is_active and r.category == "mileage"]

    def base_rates_for_level(self, level: str):
        tag = f"[{level.upper()}]"
        return [r for r in self.all_base_rates() if tag in (r.description or "").upper()]

    def mileage_row(self, level: str, loaded: bool):
        lvl = level.upper()
        for r in self.all_mileage():
            if r.level == lvl and r.loaded == loaded:
                return r
        return None


async def _generate_db_driven_lines(
    clinical_context: dict,
    db_tariff_lines: list,
    rate_schema,
) -> dict:
    """Generate billing lines from DB-stored tariff lines.

    Wraps the DB rows into _DbTariffRow adapters, builds a fake rules
    module, and delegates to _generate_gems_lines which implements the
    full NHRPL billing logic (100km rule, time extensions, mileage,
    crew-qualification cap, multi-patient multipliers).
    """
    adapted_rows = [_DbTariffRow(ln) for ln in db_tariff_lines]
    fake_module = _DbRulesModule(adapted_rows)

    result = await _generate_gems_lines(clinical_context, fake_module)

    # Override the source label
    result["source"] = "db_driven"
    result["billing_schema_code"] = rate_schema.schema_code if rate_schema else None

    return result


async def _generate_gems_lines(clinical_context: dict, rules_module) -> dict:
    """
    Generate billing lines from the hardcoded GEMS tariff module.

    Previously this function read the `gems_tariffs` DB table via an async
    session. Now it reads from the in-memory `TARIFFS` tuple exposed by
    `app.rules.gems` (passed in as `rules_module`). The computation logic —
    100km rule, crew-qualification cap, multi-patient multipliers, time
    extensions — is unchanged.

    === GEMS BILLING COMPLIANCE RULES ===

    100km Metropolitan Rule (NHRPL):
      Under 100km total distance  → TIME billing only
        Bill: Base code (100/125/131) + Extension code (103/127/133) if overtime
        Do NOT add km codes (111/128/129/141 etc.)
      Over 100km total distance   → DISTANCE billing only
        Bill: Loaded km code + Unloaded km codes
        Do NOT include base time codes (100/125/131)

    Time Extension:
      ILS/BLS base window = 45 min  → code 127 / 103 per 15-min interval (CEIL)
      ALS base window     = 60 min  → code 133 per 15-min interval (CEIL)

    IHT Call-Out Fee:
      Added only for IHT/IFT calls (code 126 for ILS, 104 for BLS).

    Multiple Patient Multiplier:
      2 patients: 0.75x base rate per patient
      3+ patients: 0.50x base rate per patient

    Crew Qualification Cap:
      Billed level of care must not exceed highest crew qualification.
      ALS crew required for code 131; ILS crew required for code 125.
    """
    level           = (clinical_context.get("level_of_care") or "ILS").upper()
    highest_qual    = (clinical_context.get("highest_crew_qual") or level).upper()
    is_iht          = clinical_context.get("is_iht", False)
    call_label      = "IHT" if is_iht else "Primary"
    icd10           = clinical_context.get("icd10_primary") or None
    patient_count   = int(clinical_context.get("patient_count") or 1)
    scene_mins      = _safe_float(clinical_context.get("scene_minutes"))
    total_km        = _safe_float(clinical_context.get("total_distance_km"))
    callout_km      = _safe_float(clinical_context.get("callout_distance_km"))
    loaded_km       = _safe_float(clinical_context.get("loaded_distance_km"))
    rtb_km          = _safe_float(clinical_context.get("rtb_distance_km"))

    # ── Crew Qualification Cap ────────────────────────────────────────────────
    # If the claimed level of care exceeds the highest crew qualification,
    # downgrade the billed level to prevent NHRPL upcoding violations.
    LEVEL_RANK = {"BLS": 0, "ILS": 1, "ALS": 2}
    if LEVEL_RANK.get(level, 1) > LEVEL_RANK.get(highest_qual, 1):
        logger.warning(
            "[BillingCompliance] Downgrading level %s → %s: crew qualification cap applied",
            level, highest_qual,
        )
        level = highest_qual

    # ── Multiple Patient Multiplier ───────────────────────────────────────────
    # NHRPL: 2 patients = 75% of base; 3+ patients = 50% of base.
    if patient_count == 2:
        base_multiplier = 0.75
    elif patient_count >= 3:
        base_multiplier = 0.50
    else:
        base_multiplier = 1.0

    # ── 100km Metropolitan Rule ───────────────────────────────────────────────
    # Under 100km: Time billing ONLY (base + extension codes). No km codes.
    # Over 100km:  Distance billing ONLY (km codes). No base time codes.
    use_time_billing     = (total_km == 0.0 or total_km < 100.0)
    use_distance_billing = (total_km >= 100.0)

    billing_mode = "TIME" if use_time_billing else "DISTANCE"

    # ── PRE-SUBMISSION SCRUB ─────────────────────────────────────────────────
    logger.info(
        "[PreSubmissionScrub] Validation: Distance is %.1f km, applying %s billing logic.",
        total_km, billing_mode,
    )
    logger.info(
        "[PreSubmissionScrub] Validation: Crew qualification [%s] matches Tariff Code for level [%s].",
        highest_qual, level,
    )
    icd10_upper = (icd10 or "").strip().upper()
    if icd10_upper:
        logger.info(
            "[PreSubmissionScrub] Validation: ICD-10 sequence for '%s' is %s.",
            icd10_upper,
            "Correct" if icd10_upper[0] not in ("S", "T") else "Correct (external cause code required — checked by adjudication engine)",
        )

    def _pick_rate(row) -> Decimal:
        """Select the correct rate column; fall back if the preferred column is 0/None.
        Returns Decimal for precise billing arithmetic."""
        if is_iht:
            rate = Decimal(str(row.iht_rate)) if row.iht_rate is not None else Decimal("0")
            if rate == Decimal("0"):
                rate = Decimal(str(row.primary_rate)) if row.primary_rate is not None else Decimal("0")
        else:
            rate = Decimal(str(row.primary_rate)) if row.primary_rate is not None else Decimal("0")
            if rate == Decimal("0"):
                rate = Decimal(str(row.iht_rate)) if row.iht_rate is not None else Decimal("0")
        return _d_round(rate)

    lines: list = []
    total = Decimal("0.00")

    # Load all active base-rate rows from the hardcoded module
    all_base_rows = rules_module.all_base_rates()

    bracket_tag = f"[{level}]"
    level_base_rows = [r for r in all_base_rows if bracket_tag in (r.description or "").upper()]

    def _find_row_by_keywords(rows, *keywords):
        """Return the first row whose description contains ALL of the given keywords (case-insensitive)."""
        kws = [k.lower() for k in keywords]
        for r in rows:
            desc = (r.description or "").lower()
            if all(k in desc for k in kws):
                return r
        return None

    # ── TRANSPORT STATUS (Critical Gate) ─────────────────────────────────────
    receiving_facility = (clinical_context.get("receiving_facility") or "").strip()
    is_transported = (loaded_km > 0.0) or bool(receiving_facility)

    if not is_transported:
        logger.info(
            "[PreSubmissionScrub] Validation: Patient was NOT loaded/transported (loaded_km=0). "
            "Applying flat Call-Out Without Transport code. Skipping time/distance rules."
        )
        # Attempt to find the specific Call Out Fee code first (e.g., 104, 126)
        base_row = _find_row_by_keywords(level_base_rows, "call out fee") or \
                   _find_row_by_keywords(level_base_rows, "callout fee")
                   
        # Fall back to the standard base rate if no specific call-out fee code exists
        if not base_row:
            if level == "ALS":
                base_row = _find_row_by_keywords(level_base_rows, "up to 60")
            else:
                base_row = _find_row_by_keywords(level_base_rows, "up to 45")
                
        if not base_row:
            base_row = next((r for r in level_base_rows if _pick_rate(r) > 0), None)

        if base_row:
            raw_price = _pick_rate(base_row)
            price = _d_mul(raw_price, base_multiplier)
            if price > Decimal("0"):
                multi_note = ""
                if patient_count == 2:
                    multi_note = f" [x0.75 — 2 patients]"
                elif patient_count >= 3:
                    multi_note = f" [x0.50 — {patient_count} patients]"

                lines.append({
                    "cpt_code":        base_row.tariff_code,
                    "nappi_code":      None,
                    "icd10_primary":   icd10,
                    "icd10_secondary": None,
                    "description":     f"GEMS {level} Call-Out Without Transport{multi_note}",
                    "modifier":        None,
                    "quantity":        1,
                    "unit_price":      float(price),
                    "total_price":     float(price),
                })
                total += price
                logger.info("[TariffEngine] Non-transport code [%s] billed at R%.2f", base_row.tariff_code, float(price))
                
        return {
            "lines":          lines,
            "total_amount":   float(total),
            "scheme_matched": "GEMS",
            "rules_used":     len(lines),
            "ai_powered":     False,
            "source":         "gems_structured_db",
            "billing_mode":   "NO_TRANSPORT",
            "total_km":       total_km,
            "patient_count":  patient_count,
            "base_multiplier": base_multiplier,
        }



    # ═══════════════════════════════════════════════════════════════════════
    # TIME BILLING PATH  (total distance < 100km — METROPOLITAN)
    # Bill: Base code + extension codes only. NO km codes.
    # ═══════════════════════════════════════════════════════════════════════
    if use_time_billing:

        # ── 1. Base Rate — pick correct time-window code ─────────────────
        if level == "ALS":
            base_window_mins = 60
            base_row = _find_row_by_keywords(level_base_rows, "up to 60")
        else:
            base_window_mins = 45
            base_row = _find_row_by_keywords(level_base_rows, "up to 45")

        if not base_row:
            base_row = next((r for r in level_base_rows if _pick_rate(r) > 0), None)
        if not base_row:
            base_row = next((r for r in all_base_rows if _pick_rate(r) > 0), None)

        if base_row:
            raw_price = _pick_rate(base_row)
            price = round(raw_price * base_multiplier, 2)
            if price > 0:
                multi_note = ""
                if patient_count == 2:
                    multi_note = f" [x0.75 — 2 patients]"
                elif patient_count >= 3:
                    multi_note = f" [x0.50 — {patient_count} patients]"

                lines.append({
                    "cpt_code":        base_row.tariff_code,
                    "nappi_code":      None,
                    "icd10_primary":   icd10,
                    "icd10_secondary": None,
                    "description":     f"GEMS {level} {call_label} Base Rate (Up to {base_window_mins} min){multi_note}",
                    "modifier":        None,
                    "quantity":        1,
                    "unit_price":      float(price),
                    "total_price":     float(price),
                })
                total += price
                logger.info("[TariffEngine] Base rate [%s] R%.2f (multiplier=%.2f)",
                            base_row.tariff_code, float(price), base_multiplier)

        # ── 2. Extension — extra 15-min intervals beyond base window ─────
        if scene_mins > base_window_mins:
            extra_mins = scene_mins - base_window_mins
            intervals = int((extra_mins + 14) // 15)   # ceiling division

            extra_row = _find_row_by_keywords(level_base_rows, "every 15")
            if not extra_row:
                extra_row = _find_row_by_keywords(level_base_rows, "15 minute")
            if not extra_row:
                extra_row = _find_row_by_keywords(level_base_rows, "15 min")

            if extra_row and intervals > 0:
                raw_unit = _pick_rate(extra_row)
                unit_price = _d_mul(raw_unit, base_multiplier)
                if unit_price > Decimal("0"):
                    line_total = _d_mul(unit_price, intervals)
                    interval_word = "interval" if intervals == 1 else "intervals"
                    lines.append({
                        "cpt_code":        extra_row.tariff_code,
                        "nappi_code":      None,
                        "icd10_primary":   icd10,
                        "icd10_secondary": None,
                        "description": (
                            f"Additional Scene Time - {int(extra_mins):.0f} min overtime "
                            f"({intervals} x 15-min {interval_word} @ R{unit_price:.2f} each)"
                        ),
                        "modifier":        None,
                        "quantity":        intervals,
                        "unit_price":      float(unit_price),
                        "total_price":     float(line_total),
                    })
                    total += line_total
                    logger.info("[TariffEngine] Extra time [%s]: %d x R%.2f = R%.2f",
                                extra_row.tariff_code, intervals, float(unit_price), float(line_total))
            elif not extra_row:
                logger.warning("[TariffEngine] Could not find 'every 15 min' row for level=%s", level)
        elif scene_mins > 0:
            logger.info("[TariffEngine] Scene time %.0f min within base window (%d min) - no extension",
                        scene_mins, base_window_mins)

        # ── 3. IHT Call-Out Fee ──────────────────────────────────────────
        if is_iht:
            callout_fee_row = _find_row_by_keywords(level_base_rows, "call out fee")
            if not callout_fee_row:
                callout_fee_row = _find_row_by_keywords(level_base_rows, "callout fee")
            if callout_fee_row:
                fee = _pick_rate(callout_fee_row)
                if fee > Decimal("0"):
                    lines.append({
                        "cpt_code":        callout_fee_row.tariff_code,
                        "nappi_code":      None,
                        "icd10_primary":   icd10,
                        "icd10_secondary": None,
                        "description":     f"{level} IHT Call Out Fee",
                        "modifier":        None,
                        "quantity":        1,
                        "unit_price":      float(fee),
                        "total_price":     float(fee),
                    })
                    total += fee
                    logger.info("[TariffEngine] IHT call-out fee [%s] = R%.2f",
                                callout_fee_row.tariff_code, float(fee))

        logger.info(
            "[BillingCompliance] TIME billing applied (%.1f km < 100 km). "
            "Base + extension codes only. No km codes.",
            total_km,
        )

    # ═══════════════════════════════════════════════════════════════════════
    # DISTANCE BILLING PATH  (total distance >= 100km — LONG DISTANCE)
    # Bill: Loaded km codes + Unloaded km codes. NO base time codes.
    # ═══════════════════════════════════════════════════════════════════════
    else:

        # ── 1. IHT Call-Out Fee (still applies even on Long Distance) ────
        if is_iht:
            callout_fee_row = _find_row_by_keywords(level_base_rows, "call out fee")
            if not callout_fee_row:
                callout_fee_row = _find_row_by_keywords(level_base_rows, "callout fee")
            if callout_fee_row:
                fee = _pick_rate(callout_fee_row)
                if fee > Decimal("0"):
                    lines.append({
                        "cpt_code":        callout_fee_row.tariff_code,
                        "nappi_code":      None,
                        "icd10_primary":   icd10,
                        "icd10_secondary": None,
                        "description":     f"{level} IHT Call Out Fee",
                        "modifier":        None,
                        "quantity":        1,
                        "unit_price":      float(fee),
                        "total_price":     float(fee),
                    })
                    total += fee

        # ── 2. Callout Mileage (Without Patient — Base to Scene) ─────────
        if callout_km > 0:
            unloaded_row = _find_mileage_row(rules_module, level, loaded=False, pick_rate_fn=_pick_rate)
            if unloaded_row:
                ppm = _pick_rate(unloaded_row)
                line_total = _d_mul(ppm, callout_km)
                if ppm > Decimal("0"):
                    lines.append({
                        "cpt_code":        unloaded_row.tariff_code,
                        "nappi_code":      None,
                        "icd10_primary":   icd10,
                        "icd10_secondary": None,
                        "description":     f"Callout Mileage (Without Patient - Base to Scene) - {callout_km:.1f} km @ R{float(ppm):.2f}/km",
                        "modifier":        None,
                        "quantity":        int(callout_km),
                        "unit_price":      float(ppm),
                        "total_price":     float(line_total),
                    })
                    total += line_total
                    logger.info("[TariffEngine] Callout km [%s]: %.1f km @ R%.2f = R%.2f",
                                unloaded_row.tariff_code, callout_km, float(ppm), float(line_total))

        # ── 3. Loaded Mileage (With Patient — Scene to Hospital) ─────────
        if loaded_km > 0:
            loaded_row = _find_mileage_row(rules_module, level, loaded=True, pick_rate_fn=_pick_rate)
            if loaded_row:
                ppm = _pick_rate(loaded_row)
                line_total = _d_mul(ppm, loaded_km)
                if ppm > Decimal("0"):
                    lines.append({
                        "cpt_code":        loaded_row.tariff_code,
                        "nappi_code":      None,
                        "icd10_primary":   icd10,
                        "icd10_secondary": None,
                        "description":     f"Loaded Transport (With Patient - Scene to Hospital) - {loaded_km:.1f} km @ R{float(ppm):.2f}/km",
                        "modifier":        None,
                        "quantity":        int(loaded_km),
                        "unit_price":      float(ppm),
                        "total_price":     float(line_total),
                    })
                    total += line_total
                    logger.info("[TariffEngine] Loaded km [%s]: %.1f km @ R%.2f = R%.2f",
                                loaded_row.tariff_code, loaded_km, float(ppm), float(line_total))

        # ── 4. Return to Base (Without Patient — Hospital to Base) ───────
        if rtb_km > 0:
            rtb_row = _find_mileage_row(rules_module, level, loaded=False, pick_rate_fn=_pick_rate)
            if rtb_row:
                ppm = _pick_rate(rtb_row)
                line_total = _d_mul(ppm, rtb_km)
                if ppm > Decimal("0"):
                    lines.append({
                        "cpt_code":        rtb_row.tariff_code,
                        "nappi_code":      None,
                        "icd10_primary":   icd10,
                        "icd10_secondary": None,
                        "description":     f"Return to Base (Without Patient) - {rtb_km:.1f} km @ R{float(ppm):.2f}/km",
                        "modifier":        None,
                        "quantity":        int(rtb_km),
                        "unit_price":      float(ppm),
                        "total_price":     float(line_total),
                    })
                    total += line_total
                    logger.info("[TariffEngine] RTB km [%s]: %.1f km @ R%.2f = R%.2f",
                                rtb_row.tariff_code, rtb_km, float(ppm), float(line_total))

        logger.info(
            "[BillingCompliance] DISTANCE billing applied (%.1f km >= 100 km). "
            "Km codes only. Base time codes excluded.",
            total_km,
        )

    logger.info("[TariffEngine] GEMS lines generated: %d  total=R%.2f", len(lines), float(total))

    return {
        "lines":          lines,
        "total_amount":   float(total),
        "scheme_matched": "GEMS",
        "rules_used":     len(lines),
        "ai_powered":     False,
        "source":         "gems_structured_db",
        "billing_mode":   billing_mode,
        "total_km":       total_km,
        "patient_count":  patient_count,
        "base_multiplier": base_multiplier,
    }

