import asyncio
import os
import sys
sys.path.append(os.getcwd())

from sqlalchemy import select
from app.database import AsyncSessionLocal
from app.models.case import Case
from app.models.claim import Claim

async def check():
    async with AsyncSessionLocal() as db:
        cases = (await db.execute(select(Case.id))).all()
        claims = (await db.execute(select(Claim.id, Claim.adjudication_status))).all()
        pending = sum(1 for c in claims if c[1].value == "pending")
        print(f"Total Cases: {len(cases)}")
        print(f"Total Claims: {len(claims)}")
        print(f"Pending Scubbing: {pending}")

if __name__ == "__main__":
    asyncio.run(check())
