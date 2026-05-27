import asyncio
from sqlalchemy import text
from app.database import AsyncSessionLocal

async def add_cols():
    async with AsyncSessionLocal() as db:
        await db.execute(text(
            "ALTER TABLE documents ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ"
        ))
        await db.execute(text(
            "ALTER TABLE documents ADD COLUMN IF NOT EXISTS reviewed_by_id UUID REFERENCES users(id)"
        ))
        await db.commit()
        print("Columns added successfully.")

asyncio.run(add_cols())
