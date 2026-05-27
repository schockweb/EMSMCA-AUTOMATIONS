import asyncio
from sqlalchemy import select, update
from app.database import AsyncSessionLocal
from app.models.document import Document, OCRStatus

async def reset_stuck():
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            update(Document)
            .where(Document.ocr_status.in_([
                OCRStatus.EXTRACTING,
                OCRStatus.PREPROCESSING,
                OCRStatus.FAILED,
            ]))
            .values(ocr_status=OCRStatus.PENDING)
        )
        await db.commit()
        print(f"Reset {result.rowcount} stuck documents to pending.")

asyncio.run(reset_stuck())
