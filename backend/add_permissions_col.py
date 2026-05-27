import asyncio
from app.database import engine
from sqlalchemy import text

async def add_col():
    async with engine.begin() as conn:
        await conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSON DEFAULT NULL"))
        print("Column added successfully")

asyncio.run(add_col())
