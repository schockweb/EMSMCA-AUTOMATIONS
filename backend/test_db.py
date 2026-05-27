import asyncio
from app.database import AsyncSessionLocal
from sqlalchemy import text

async def main():
    async with AsyncSessionLocal() as session:
        res = await session.execute(text("SELECT * FROM gems_tariffs WHERE tariff_code='134'"))
        for row in res.mappings():
            print(dict(row))

asyncio.run(main())
