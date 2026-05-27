"""Migration: Create scheme_configs table and add auth_flag columns to cases."""
import asyncio
from sqlalchemy import text
from app.database import engine, Base
from app.models import *  # noqa: F403

async def migrate():
    async with engine.begin() as conn:
        # Add auth_flag columns to cases table
        for col_sql in [
            "ALTER TABLE cases ADD COLUMN IF NOT EXISTS auth_flag BOOLEAN NOT NULL DEFAULT FALSE",
            "ALTER TABLE cases ADD COLUMN IF NOT EXISTS auth_flag_reason TEXT",
        ]:
            try:
                await conn.execute(text(col_sql))
            except Exception as e:
                print(f"Column note: {e}")

        print("Cases auth_flag columns added.")

        # Create scheme_configs table
        await conn.run_sync(Base.metadata.create_all)
        print("scheme_configs table created.")

if __name__ == "__main__":
    asyncio.run(migrate())
