
import asyncio
from sqlalchemy import select
from app.database import AsyncSessionLocal
from app.models.user import User

async def check_user():
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(User).where(User.email == "admin@emsclaims.co.za"))
        user = res.scalar_one_or_none()
        if user:
            print(f"User: {user.email}")
            print(f"Role: {user.role}")
            print(f"Permissions: {user.permissions}")
        else:
            print("User not found")

if __name__ == "__main__":
    asyncio.run(check_user())
