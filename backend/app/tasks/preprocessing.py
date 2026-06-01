"""
Preprocessing Celery Task — runs image enhancement pipeline asynchronously.
"""
from __future__ import annotations
import asyncio
from app.tasks.celery_app import celery_app


@celery_app.task(bind=True, max_retries=3, default_retry_delay=30)
def preprocess_document(self, document_id: str, engine: str = "azure"):
    """
    Async task: preprocess a document image.
    1. Load raw file from storage
    2. Run through Claid.ai (or local fallback)
    3. Save processed result
    4. Update document record
    5. Trigger OCR extraction task
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(_preprocess(self, document_id, engine))
    finally:
        loop.close()


async def _preprocess(task, document_id: str, engine: str):
    from sqlalchemy import select
    from app.database import AsyncSessionLocal
    from app.models.document import Document, OCRStatus
    from app.services.image_preprocessing import preprocess_image
    from app.utils.storage import get_full_path, save_processed

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Document).where(Document.id == document_id))
        doc = result.scalar_one_or_none()

        if not doc:
            return {"error": f"Document {document_id} not found"}

        # Check file extension — PDFs skip image preprocessing
        is_pdf = doc.original_filename.lower().endswith(".pdf")

        if is_pdf:
            # PDFs go directly to OCR extraction (no image preprocessing needed)
            doc.ocr_status = OCRStatus.EXTRACTING
            await db.commit()

            from app.tasks.extraction import extract_document_task
            extract_document_task.delay(document_id, engine=engine)

            return {
                "document_id": document_id,
                "preprocessing_method": "skipped_pdf",
                "enhancements": [],
                "success": True,
            }

        # Image files: Update status and run preprocessing
        doc.ocr_status = OCRStatus.PREPROCESSING
        await db.commit()

        # Read raw file
        raw_path = get_full_path(doc.storage_uri)
        with open(raw_path, "rb") as f:
            raw_bytes = f.read()

        # Preprocess image
        preprocess_result = await preprocess_image(raw_bytes, doc.original_filename)

        if preprocess_result.success:
            # Save processed file
            processed_uri = await save_processed(
                preprocess_result.image_bytes, doc.original_filename
            )
            doc.processed_uri = processed_uri

        await db.commit()

        # Trigger OCR extraction
        from app.tasks.extraction import extract_document_task
        extract_document_task.delay(document_id, engine=engine)

        return {
            "document_id": document_id,
            "preprocessing_method": preprocess_result.method_used,
            "enhancements": preprocess_result.enhancements_applied,
            "success": preprocess_result.success,
        }

