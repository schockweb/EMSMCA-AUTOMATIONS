import asyncio
import os
import sys

# Add working directory to path so app modules can be found
sys.path.append(os.getcwd())

from sqlalchemy import select
from app.database import AsyncSessionLocal
from app.models.claim import Claim
from app.models.case import Case

async def get_latest_claims():
    async with AsyncSessionLocal() as db:
        stmt = select(
            Claim.id, 
            Claim.total_amount, 
            Case.patient_name,
            Claim.adjudication_status
        ).join(Case).order_by(Claim.created_at.desc()).limit(5)
        
        result = await db.execute(stmt)
        claims = result.all()
        
        if not claims:
            print("No claims found in the database.")
            return

        print("\n--- LATEST 5 CLAIMS ---")
        for claim_id, amount, patient, status in claims:
            print(f"ID: {claim_id}")
            print(f"Patient: {patient}")
            print(f"Amount: R{float(amount):.2f}")
            print(f"Status: {status.value}")
            print("-" * 30)

if __name__ == "__main__":
    asyncio.run(get_latest_claims())
