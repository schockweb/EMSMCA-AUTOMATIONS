import asyncio
from app.database import AsyncSessionLocal
from app.models.document import Document
from sqlalchemy import select

async def main():
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Document))
        docs = res.scalars().all()
        for d in docs:
            print(f"Doc: {d.original_filename} | Status: {d.ocr_status.name if hasattr(d.ocr_status, 'name') else d.ocr_status}")
            import json
            print(json.dumps(d.extracted_data, indent=2))


asyncio.run(main())
