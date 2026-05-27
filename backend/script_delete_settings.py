from app.database import AsyncSessionLocal
import asyncio
from sqlalchemy import text

async def main():
    async with AsyncSessionLocal() as db:
        await db.execute(text("DELETE FROM system_settings WHERE category IN ('integrations', 'authorization_rules', 'extraction');"))
        await db.commit()
        print('Deleted successfully.')

if __name__ == '__main__':
    asyncio.run(main())
