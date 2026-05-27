import asyncio
import os
import sys
sys.path.append(os.getcwd())

from sqlalchemy import select
from app.database import AsyncSessionLocal
from app.models.claim import Claim, AdjudicationStatus
from app.services.adjudication_engine import adjudicate_claim

async def backfill_adjudications():
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Claim.id).where(Claim.adjudication_status == AdjudicationStatus.PENDING)
        )
        pending_ids = result.scalars().all()
        
        print(f"Found {len(pending_ids)} pending claims to adjudicate.")
        
        for claim_id in pending_ids:
            try:
                print(f"Adjudicating {claim_id}...", end=" ")
                res = await adjudicate_claim(
                    claim_id=str(claim_id),
                    db=db,
                    auto_generate_rfis=True
                )
                print(f"[{res.status}] Clean: {res.is_clean}, Flags: {len(res.rfis_generated)}")
            except Exception as e:
                print(f"ERROR: {e}")

if __name__ == "__main__":
    asyncio.run(backfill_adjudications())
