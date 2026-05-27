import asyncio
import os
import sys

sys.path.append(os.getcwd())

from sqlalchemy import select
from app.database import AsyncSessionLocal
from app.models.user import User

async def fetch():
    async with AsyncSessionLocal() as db:
        users = (await db.execute(select(User))).scalars().all()
        for u in users:
            print(f"Name: '{u.full_name}' Email: '{u.email}'")

if __name__ == "__main__":
    asyncio.run(fetch())
