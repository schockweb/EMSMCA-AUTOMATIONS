import asyncio
from app.main import seed_default_settings

async def main():
    await seed_default_settings()

if __name__ == "__main__":
    asyncio.run(main())
