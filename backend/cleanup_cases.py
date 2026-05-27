import asyncio
import uuid
from sqlalchemy import select, delete
from app.database import AsyncSessionLocal
from app.models.case import Case
from app.models.claim import Claim
from app.models.claim_line import ClaimLine
from app.models.rfi import RFI
from app.models.document import Document
from app.models.auth_request import SchemeAuthRequest

async def purge_orphans():
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Case.id).where(~Case.id.in_(select(Document.case_id).where(Document.case_id.is_not(None)))))
        orphans = [r for r in res.scalars()]
        print('Orphan cases:', orphans)
        if not orphans:
            return
        claims = await db.execute(select(Claim.id).where(Claim.case_id.in_(orphans)))
        claim_ids = [c for c in claims.scalars()]
        if claim_ids:
            await db.execute(delete(RFI).where(RFI.claim_id.in_(claim_ids)))
            await db.execute(delete(ClaimLine).where(ClaimLine.claim_id.in_(claim_ids)))
            await db.execute(delete(SchemeAuthRequest).where(SchemeAuthRequest.claim_id.in_(claim_ids)))
            await db.execute(delete(Claim).where(Claim.case_id.in_(orphans)))
        await db.execute(delete(SchemeAuthRequest).where(SchemeAuthRequest.case_id.in_(orphans)))
        await db.execute(delete(Case).where(Case.id.in_(orphans)))
        await db.commit()
        print('Cleanup complete')

if __name__ == "__main__":
    asyncio.run(purge_orphans())
