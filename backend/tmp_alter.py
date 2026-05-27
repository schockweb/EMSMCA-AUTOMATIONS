import asyncio
from sqlalchemy import text
from app.database import AsyncSessionLocal

async def alter_enum():
    async with AsyncSessionLocal() as session:
        try:
            await session.execute(text("ALTER TYPE guideline_type ADD VALUE 'case_management';"))
            await session.commit()
            print('Enum altered successfully')
        except Exception as e:
            await session.rollback()
            print('Enum probably already exists or error:', str(e))

asyncio.run(alter_enum())
