
import asyncio
from app.database import AsyncSessionLocal
from app.models.user import User, UserRole
from app.utils.security import hash_password
from sqlalchemy import select

async def create_admin():
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(User).where(User.email == "admin@emsclaims.co.za"))
        if res.scalar_one_or_none():
            print("Admin already exists")
            return
        
        admin = User(
            email="admin@emsclaims.co.za",
            hashed_password=hash_password("Admin@2026!"),
            full_name="System Administrator",
            role=UserRole.ADMIN,
            is_active=True,
            permissions=None # Full access
        )
        db.add(admin)
        await db.commit()
        print("Created admin user")

if __name__ == "__main__":
    asyncio.run(create_admin())
