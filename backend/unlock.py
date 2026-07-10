import asyncio
from app.db.database import async_session_maker
from sqlalchemy import text

async def unlock():
    async with async_session_maker() as db:
        await db.execute(text('UPDATE users SET failed_login_attempts = 0, locked_until = NULL;'))
        await db.commit()
        print('Unlocked all users')

if __name__ == "__main__":
    asyncio.run(unlock())
