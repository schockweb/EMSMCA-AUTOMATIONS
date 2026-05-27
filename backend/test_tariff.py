import asyncio
from app.database import AsyncSessionLocal
from app.services.tariff_engine import generate_tariff_lines

async def run():
    async with AsyncSessionLocal() as db:
        # Scenario 1: ILS Primary — 50 min scene time (exceeds 45-min window by 5 min = 1 interval)
        # 15 km loaded, no callout or RTB
        prf_data = {
            "level_of_care": "ILS",
            "incident_type": "Primary",
            "primary_icd10": "R55",
            "mileage_billable_loaded_km": 15.0,
            "mileage_billable_callout_km": 0.0,
            "mileage_billable_rtb_km": 0.0,
            "mileage_scene_minutes": 50.0,
        }
        print("=== Scenario 1: ILS Primary — 50 min scene, 15km loaded ===")
        result = await generate_tariff_lines(prf_data, "GEMS", db)
        for line in result["lines"]:
            print(f"  [{line['cpt_code']}] x{line['quantity']} @ R{line['unit_price']:.2f} = R{line['total_price']:.2f} | {line['description']}")
        print(f"  TOTAL: R{result['total_amount']:.2f}\n")

        # Scenario 2: ALS IHT — 90 min scene time (exceeds 60-min window by 30 min = 2 intervals)
        # 120km loaded (>100km rate applies)
        prf_data2 = {
            "level_of_care": "ALS",
            "incident_type": "IHT",
            "primary_icd10": "I21",
            "mileage_billable_loaded_km": 120.0,
            "mileage_billable_callout_km": 0.0,
            "mileage_billable_rtb_km": 0.0,
            "mileage_scene_minutes": 90.0,
        }
        print("=== Scenario 2: ALS IHT — 90 min scene, 120km loaded ===")
        result2 = await generate_tariff_lines(prf_data2, "GEMS", db)
        for line in result2["lines"]:
            print(f"  [{line['cpt_code']}] x{line['quantity']} @ R{line['unit_price']:.2f} = R{line['total_price']:.2f} | {line['description']}")
        print(f"  TOTAL: R{result2['total_amount']:.2f}\n")

        # Scenario 3: ILS Primary — 30 min scene time (within 45-min window, no extra charge)
        prf_data3 = {
            "level_of_care": "ILS",
            "incident_type": "Primary",
            "primary_icd10": "R55",
            "mileage_billable_loaded_km": 8.0,
            "mileage_billable_callout_km": 0.0,
            "mileage_billable_rtb_km": 0.0,
            "mileage_scene_minutes": 30.0,
        }
        print("=== Scenario 3: ILS Primary — 30 min scene, 8km loaded ===")
        result3 = await generate_tariff_lines(prf_data3, "GEMS", db)
        for line in result3["lines"]:
            print(f"  [{line['cpt_code']}] x{line['quantity']} @ R{line['unit_price']:.2f} = R{line['total_price']:.2f} | {line['description']}")
        print(f"  TOTAL: R{result3['total_amount']:.2f}\n")

asyncio.run(run())
