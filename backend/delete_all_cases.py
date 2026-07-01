import asyncio
from sqlalchemy import delete, text
from app.database import AsyncSessionLocal
from app.models.case import Case
from app.models.claim import Claim
from app.models.claim_line import ClaimLine
from app.models.rfi import RFI
from app.models.document import Document
from app.models.auth_request import SchemeAuthRequest
from app.models.digital_prf import DigitalPRF

async def delete_all_cases():
    async with AsyncSessionLocal() as db:
        print("Deleting RFIs...")
        await db.execute(delete(RFI))
        print("Deleting ClaimLines...")
        await db.execute(delete(ClaimLine))
        print("Deleting SchemeAuthRequests...")
        await db.execute(delete(SchemeAuthRequest))
        print("Deleting Claims...")
        await db.execute(delete(Claim))
        print("Deleting Digital PRFs...")
        await db.execute(delete(DigitalPRF))
        print("Deleting Documents...")
        await db.execute(delete(Document))
        print("Deleting Cases...")
        await db.execute(delete(Case))
        await db.commit()
        print("All cases and related records deleted successfully.")

if __name__ == "__main__":
    asyncio.run(delete_all_cases())
