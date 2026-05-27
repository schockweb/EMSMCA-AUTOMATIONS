import asyncio
from app.database import AsyncSessionLocal
from sqlalchemy import text

async def main():
    async with AsyncSessionLocal() as db:
        res = await db.execute(text("SELECT created_at, source, endpoint, message, stacktrace FROM crash_events WHERE source='BACKEND' ORDER BY created_at DESC LIMIT 1"))
        for row in res.fetchall():
            print(f'[{row[0]}] {row[1]} | {row[2]}')
            print(' MESSAGE:', row[3])
            print(' STACKTRACE:', str(row[4]))

if __name__ == "__main__":
    asyncio.run(main())
