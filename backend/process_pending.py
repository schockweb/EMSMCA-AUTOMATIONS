import asyncio
from sqlalchemy import select
from app.database import AsyncSessionLocal
from app.models.document import Document
from app.tasks.preprocessing import preprocess_document

async def get_pending():
    async with AsyncSessionLocal() as session:
        res = await session.execute(select(Document.id).where(Document.ocr_status == 'pending'))
        return [str(d) for d in res.scalars()]

if __name__ == "__main__":
    docs = asyncio.run(get_pending())
    print(f"Found {len(docs)} pending documents.")
    for d_id in docs:
        print(f"Processing {d_id}...")
        preprocess_document(d_id)
        print(f"Finished {d_id}")
