import asyncio
from app.database import engine
from sqlalchemy import text

async def add_cols():
    async with engine.begin() as conn:
        try:
            await conn.execute(text("ALTER TABLE cases ADD COLUMN IF NOT EXISTS dependant_code VARCHAR(50) DEFAULT NULL"))
            print("Finished adding dependant_code")
        except Exception as e:
            print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(add_cols())
