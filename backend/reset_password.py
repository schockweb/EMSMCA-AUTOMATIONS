import asyncio
from sqlalchemy import select
from app.database import AsyncSessionLocal
from app.models.user import User
from app.utils.security import hash_password

async def main():
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(User.email == "admin@emsclaims.co.za"))
        user = result.scalar_one_or_none()
        if user:
            print(f"Current hash: {user.hashed_password}")
            user.hashed_password = hash_password("Admin@2026!")
            await db.commit()
            print(f"New hash set for {user.email}")
        else:
            print("User not found")

asyncio.run(main())
