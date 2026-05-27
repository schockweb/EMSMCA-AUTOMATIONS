"""
OCR Extraction Celery Task — runs Vision-Language AI pipeline asynchronously.
"""
import asyncio
from app.tasks.celery_app import celery_app


@celery_app.task(bind=True, max_retries=3, default_retry_delay=60)
def extract_document_task(self, document_id: str, engine: str = "azure"):
    """
    Async task: extract structured data from a preprocessed document.
    1. Load processed (or raw) file
    2. Run through LlamaParse (or Mistral fallback)
    3. Store extracted JSON, confidence scores
    4. Flag for HITL review if confidence is low
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(_extract(self, document_id, engine))
    finally:
        loop.close()


async def _extract(task, document_id: str, engine: str):
    from sqlalchemy import select
    from app.database import AsyncSessionLocal
    from app.models.document import Document, OCRStatus
    from app.services.ocr_extraction import extract_document
    from app.utils.storage import get_full_path

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Document).where(Document.id == document_id))
        doc = result.scalar_one_or_none()

        if not doc:
            return {"error": f"Document {document_id} not found"}

        # Update status
        doc.ocr_status = OCRStatus.EXTRACTING
        await db.commit()

        # Read the best available file (processed > raw)
        uri = doc.processed_uri or doc.storage_uri
        file_path = get_full_path(uri)
        with open(file_path, "rb") as f:
            file_bytes = f.read()

        # Extract — pass db so learned corrections are injected into the prompt
        extraction_result = await extract_document(file_bytes, doc.original_filename, engine=engine, db=db)

        # Update document with results
        doc.extracted_data = extraction_result.extracted_data
        doc.ocr_field_scores = extraction_result.field_scores
        doc.ocr_confidence_avg = extraction_result.avg_confidence
        doc.needs_hitl_review = extraction_result.needs_hitl_review
        doc.ocr_status = (
            OCRStatus.COMPLETED if extraction_result.success else OCRStatus.FAILED
        )
        await db.commit()

        return {
            "document_id": document_id,
            "extraction_method": extraction_result.method_used,
            "avg_confidence": extraction_result.avg_confidence,
            "needs_review": extraction_result.needs_hitl_review,
            "fields_extracted": len(extraction_result.extracted_data),
            "success": extraction_result.success,
        }
