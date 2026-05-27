"""Add role column to crew_members and seed JEMS."""
import asyncio
from sqlalchemy import text
from app.database import engine, AsyncSessionLocal, Base
from app.models.service_provider import ServiceProvider
from app.models.crew_member import CrewMember
from app.utils.security import hash_password
from sqlalchemy import select


async def migrate_and_seed():
    # 1. Add role column if missing
    from sqlalchemy.exc import OperationalError
    async with engine.begin() as conn:
        try:
            await conn.execute(text(
                "ALTER TABLE crew_members ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'crew'"
            ))
            print("role column added")
        except OperationalError as e:
            if "duplicate column name" in str(e):
                print("role column already exists")
            else:
                raise

    # 2. Ensure new tables exist
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # 3. Seed JEMS admin
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(ServiceProvider).where(ServiceProvider.slug == "jems")
        )
        provider = result.scalar_one_or_none()

        if not provider:
            provider = ServiceProvider(
                name="JEMS Medical Services",
                slug="jems",
                pr_number="009 003 074661",
                pty_reg_number="2017/438874/07",
                phone="078 670 6945",
                email="terrancer@jemsmedical.co.za",
                address="59 Greendale Road, Chatsworth, 4092",
            )
            db.add(provider)
            await db.flush()
            print(f"Created provider: {provider.name}")
        else:
            print(f"Provider exists: {provider.name}")

        result = await db.execute(
            select(CrewMember).where(CrewMember.email == "jems.admin@emsclaims.co.za")
        )
        admin = result.scalar_one_or_none()

        if not admin:
            admin = CrewMember(
                provider_id=provider.id,
                email="jems.admin@emsclaims.co.za",
                hashed_password=hash_password("JEMS.Admin!2026"),
                full_name="JEMS Administrator",
                initials="JA",
                qualification="ECP",   # HPCSA category — see app.utils.hpcsa
                role="admin",
            )
            db.add(admin)
            print(f"Created admin: {admin.email}")
        else:
            print(f"Admin exists: {admin.email}")

        await db.commit()
        print("Done! JEMS is ready.")


if __name__ == "__main__":
    asyncio.run(migrate_and_seed())
