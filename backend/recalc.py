import asyncio
import json
from app.database import AsyncSessionLocal
from sqlalchemy import select, delete
from app.models.case import Case
from app.models.document import Document
from app.models.claim import Claim
from app.models.claim_line import ClaimLine
from app.services.tariff_engine import generate_tariff_lines
import uuid

async def main():
    async with AsyncSessionLocal() as db:
        cases_res = await db.execute(select(Case))
        cases = cases_res.scalars().all()
        for case in cases:
            claim_res = await db.execute(select(Claim).where(Claim.case_id == case.id))
            claim = claim_res.scalar_one_or_none()
            if not claim: continue
            
            doc_res = await db.execute(select(Document).where(Document.case_id == case.id))
            doc = doc_res.scalar_one_or_none()
            if not doc: continue
            
            # Delete old lines
            await db.execute(delete(ClaimLine).where(ClaimLine.claim_id == claim.id))
            
            # Generate new lines
            extracted = doc.extracted_data
            if isinstance(extracted, str):
                extracted = json.loads(extracted)
            if isinstance(extracted, str):
                extracted = json.loads(extracted)
            
            print(f"Loaded extracted for {case.id}")
            res = await generate_tariff_lines(case.medical_scheme_name, extracted, db=db)
            lines_data = res.get("lines", [])
            
            new_total = 0
            for line_data in lines_data:
                cl = ClaimLine(
                    claim_id=claim.id,
                    cpt_code=line_data.get("cpt_code"),
                    nappi_code=line_data.get("nappi_code"),
                    icd10_primary=line_data.get("icd10_primary"),
                    icd10_secondary=line_data.get("icd10_secondary"),
                    description=line_data.get("description"),
                    modifier=line_data.get("modifier"),
                    quantity=line_data.get("quantity", 1),
                    unit_price=line_data.get("unit_price", 0.0),
                    total_price=line_data.get("total_price", 0.0)
                )
                db.add(cl)
                new_total += float(line_data.get("total_price", 0.0))
                
            claim.total_amount = new_total
            await db.commit()
            print(f"Recalculated Case {case.id} - Total Lines: {len(lines_data)}")

asyncio.run(main())
