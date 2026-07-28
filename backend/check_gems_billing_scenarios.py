import asyncio
from app.database import AsyncSessionLocal
from app.services.tariff_engine import generate_tariff_lines

async def run():
    async with AsyncSessionLocal() as db:
        print("=" * 70)
        print("GEMS BILLING COMPLIANCE TEST SUITE")
        print("=" * 70)

        # ── Scenario A: Metropolitan ILS Primary, under 100km
        # Expected: TIME billing — base code 125 + no km codes
        print("\n[A] ILS Primary — 30 km total, 40 min scene (within 45min window)")
        result = await generate_tariff_lines({
            "level_of_care": "ILS",
            "crew_member_1_qualification": "ILS",
            "incident_type": "Primary",
            "primary_icd10": "R55",
            "mileage_billable_callout_km": 5.0,
            "mileage_billable_loaded_km": 20.0,
            "mileage_billable_rtb_km": 5.0,
            "mileage_billable_total_km": 30.0,
            "mileage_scene_minutes": 40.0,
        }, "GEMS", db)
        for line in result["lines"]:
            print(f"  [{line['cpt_code']}] x{line['quantity']} @ R{line['unit_price']:.2f} = R{line['total_price']:.2f}  | {line['description']}")
        print(f"  MODE: {result.get('billing_mode')} | TOTAL: R{result['total_amount']:.2f}")
        assert result.get("billing_mode") == "TIME", "FAIL: Expected TIME billing"
        assert not any("km @" in l["description"] for l in result["lines"]), "FAIL: km codes found in TIME billing"
        print("  PASS: TIME billing applied, no km codes")

        # ── Scenario B: Metropolitan ILS Primary, overtime 65 minutes
        # Expected: TIME billing — base 125 + 1 extension interval (127 × 1)
        print("\n[B] ILS Primary — 50 km total, 65 min scene (20 min overtime = 2 intervals)")
        result = await generate_tariff_lines({
            "level_of_care": "ILS",
            "crew_member_1_qualification": "ILS",
            "incident_type": "Primary",
            "primary_icd10": "R55",
            "mileage_billable_callout_km": 10.0,
            "mileage_billable_loaded_km": 30.0,
            "mileage_billable_rtb_km": 10.0,
            "mileage_billable_total_km": 50.0,
            "mileage_scene_minutes": 65.0,
        }, "GEMS", db)
        for line in result["lines"]:
            print(f"  [{line['cpt_code']}] x{line['quantity']} @ R{line['unit_price']:.2f} = R{line['total_price']:.2f}  | {line['description']}")
        print(f"  MODE: {result.get('billing_mode')} | TOTAL: R{result['total_amount']:.2f}")
        ext_lines = [l for l in result["lines"] if l["cpt_code"] == "127"]
        assert len(ext_lines) == 1, "FAIL: Expected extension code 127"
        assert ext_lines[0]["quantity"] == 2, f"FAIL: Expected 2 intervals, got {ext_lines[0]['quantity']}"
        print("  PASS: 2 extensions billed correctly (65 - 45 = 20 min -> CEIL(20/15) = 2)")

        # ── Scenario C: Long Distance ALS IHT, over 100km
        # Expected: DISTANCE billing — km codes only, no base code 131
        print("\n[C] ALS IHT — 150 km total, 45 min scene")
        result = await generate_tariff_lines({
            "level_of_care": "ALS",
            "crew_member_1_qualification": "ALS",
            "incident_type": "IHT",
            "primary_icd10": "I21",
            "mileage_billable_callout_km": 10.0,
            "mileage_billable_loaded_km": 120.0,
            "mileage_billable_rtb_km": 20.0,
            "mileage_billable_total_km": 150.0,
            "mileage_scene_minutes": 45.0,
        }, "GEMS", db)
        for line in result["lines"]:
            print(f"  [{line['cpt_code']}] x{line['quantity']} @ R{line['unit_price']:.2f} = R{line['total_price']:.2f}  | {line['description']}")
        print(f"  MODE: {result.get('billing_mode')} | TOTAL: R{result['total_amount']:.2f}")
        assert result.get("billing_mode") == "DISTANCE", "FAIL: Expected DISTANCE billing"
        assert not any(l["cpt_code"] == "131" for l in result["lines"]), "FAIL: Base code 131 must NOT appear"
        print("  PASS: DISTANCE billing applied, base code 131 excluded")

        # ── Scenario D: Multiple patients (2) — 0.75 multiplier
        print("\n[D] ILS Primary — 30 km, 2 patients (0.75x multiplier)")
        result = await generate_tariff_lines({
            "level_of_care": "ILS",
            "crew_member_1_qualification": "ILS",
            "incident_type": "Primary",
            "primary_icd10": "R55",
            "multiple_patient_indicator": "Patient 1 of 2",
            "mileage_billable_loaded_km": 30.0,
            "mileage_billable_total_km": 30.0,
            "mileage_scene_minutes": 30.0,
        }, "GEMS", db)
        for line in result["lines"]:
            print(f"  [{line['cpt_code']}] x{line['quantity']} @ R{line['unit_price']:.2f} = R{line['total_price']:.2f}  | {line['description']}")
        print(f"  MULTIPLIER: {result.get('base_multiplier')} | TOTAL: R{result['total_amount']:.2f}")
        assert abs(result.get("base_multiplier", 1.0) - 0.75) < 0.01, "FAIL: Expected 0.75 multiplier"
        print("  PASS: 0.75 multiplier applied for 2-patient call")

        # ── Scenario E: Crew qualification cap — ILS crew billed as ALS
        print("\n[E] CREW CAP — ALS billed but ILS crew → downgrade to ILS")
        result = await generate_tariff_lines({
            "level_of_care": "ALS",
            "crew_member_1_qualification": "ILS",  # < ALS → should cap to ILS
            "incident_type": "Primary",
            "primary_icd10": "R55",
            "mileage_billable_loaded_km": 20.0,
            "mileage_billable_total_km": 20.0,
            "mileage_scene_minutes": 30.0,
        }, "GEMS", db)
        for line in result["lines"]:
            print(f"  [{line['cpt_code']}] x{line['quantity']} @ R{line['unit_price']:.2f} = R{line['total_price']:.2f}  | {line['description']}")
        assert not any(l["cpt_code"] == "131" for l in result["lines"]), "FAIL: Code 131 (ALS) must not appear when ILS crew"
        assert any(l["cpt_code"] == "125" for l in result["lines"]), "FAIL: Code 125 (ILS) should appear after downgrade"
        print("  PASS: Level downgraded from ALS → ILS due to crew qualification cap")

        # ── Scenario F: Call-out without transport
        print("\n[F] NO TRANSPORT — Patient treated but not loaded")
        result = await generate_tariff_lines({
            "level_of_care": "ILS",
            "crew_member_1_qualification": "ILS",
            "incident_type": "Primary",
            "primary_icd10": "R55",
            "mileage_billable_callout_km": 15.0,
            "mileage_billable_loaded_km": 0.0,
            "mileage_billable_total_km": 15.0,
            "mileage_scene_minutes": 20.0,
            "receiving_facility": "",
        }, "GEMS", db)
        for line in result["lines"]:
            print(f"  [{line['cpt_code']}] x{line['quantity']} @ R{line['unit_price']:.2f} = R{line['total_price']:.2f}  | {line['description']}")
        print(f"  MODE: {result.get('billing_mode')} | TOTAL: R{result['total_amount']:.2f}")
        assert result.get("billing_mode") == "NO_TRANSPORT", "FAIL: Expected NO_TRANSPORT billing"
        assert len(result["lines"]) == 1, "FAIL: Expected only 1 call-out line"
        print("  PASS: Call-Out Without Transport applied correctly")

        print("\n" + "=" * 70)
        print("ALL TESTS PASSED")
        print("=" * 70)

asyncio.run(run())
