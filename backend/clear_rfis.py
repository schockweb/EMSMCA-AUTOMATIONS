import asyncio
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from app.database import AsyncSessionLocal
from app.models.rfi import RFI, RFIStatus
from sqlalchemy import delete

async def clear_rfis():
    async with AsyncSessionLocal() as db:
        result = await db.execute(delete(RFI).where(RFI.rfi_status == RFIStatus.OPEN))
        await db.commit()
        print(f"DELETED {result.rowcount} OPEN RFIs from database!")

if __name__ == "__main__":
    asyncio.run(clear_rfis())
