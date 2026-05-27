import asyncio
import uuid
import sys
from app.database import AsyncSessionLocal
from app.models.document import Document
from sqlalchemy import select
from app.services.adjudication_engine import adjudicate_claim

async def main():
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(Document).where(Document.extracted_data != None).where(Document.needs_hitl_review == True).order_by(Document.created_at.desc()).limit(1))
        doc = res.scalar()
        if not doc:
            print('No logic triggered')
            return
            
        print('DOC:', doc.id)
        from app.services.claims_pipeline import update_claim_from_document, create_claim_from_document
        
        try:
            if not doc.case_id:
                pipeline_result = await create_claim_from_document(doc, db)
            else:
                pipeline_result = await update_claim_from_document(doc, db)
                
            print('Calling adjudicate with claim:', pipeline_result['claim_id'])
            adj = await adjudicate_claim(claim_id=pipeline_result['claim_id'], db=db, auto_generate_rfis=True)
            print('Done')
        except Exception as e:
            import traceback
            traceback.print_exc()

if __name__ == '__main__':
    asyncio.run(main())
