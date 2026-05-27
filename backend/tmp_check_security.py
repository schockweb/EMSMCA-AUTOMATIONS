import asyncio
from sqlalchemy import text
from app.database import AsyncSessionLocal

async def check():
    async with AsyncSessionLocal() as db:
        r = await db.execute(text(
            "SELECT column_name FROM information_schema.columns WHERE table_name='users' ORDER BY ordinal_position"
        ))
        print("=== Users table columns ===")
        for row in r.all():
            print(f"  {row[0]}")

        r2 = await db.execute(text(
            "SELECT table_name FROM information_schema.tables WHERE table_name='token_blacklist'"
        ))
        if r2.scalar_one_or_none():
            print("\n✅ token_blacklist table EXISTS")
        else:
            print("\n❌ token_blacklist table MISSING")

asyncio.run(check())
