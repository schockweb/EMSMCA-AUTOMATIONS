"""
Migration: Add group_id and is_group_primary columns to the documents table.
Run: python add_document_groups.py
"""
import asyncio
from app.database import engine
from sqlalchemy import text

async def migrate():
    async with engine.begin() as conn:
        try:
            await conn.execute(text(
                "ALTER TABLE documents ADD COLUMN IF NOT EXISTS group_id VARCHAR(36) DEFAULT NULL"
            ))
            print("✓ Added group_id column")
        except Exception as e:
            print(f"group_id: {e}")

        try:
            await conn.execute(text(
                "ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_group_primary BOOLEAN DEFAULT FALSE"
            ))
            print("✓ Added is_group_primary column")
        except Exception as e:
            print(f"is_group_primary: {e}")

        try:
            await conn.execute(text(
                "CREATE INDEX IF NOT EXISTS idx_documents_group_id ON documents(group_id)"
            ))
            print("✓ Created index on group_id")
        except Exception as e:
            print(f"index: {e}")

    print("\nMigration complete.")

if __name__ == "__main__":
    asyncio.run(migrate())
