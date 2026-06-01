"""
Documents API — Upload, list, and download PRF documents.
Triggers async preprocessing and OCR extraction pipelines.
"""
from __future__ import annotations
import uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, status, BackgroundTasks
from fastapi.responses import FileResponse, Response
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.document import Document, OCRStatus
from app.models.user import User
from app.schemas.document import DocumentResponse, DocumentListResponse
from app.utils.security import get_current_user
from app.utils.storage import save_upload, get_full_path, file_exists
from app.config import get_settings

settings = get_settings()

router = APIRouter(prefix="/api/documents", tags=["Documents"])

ALLOWED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp", ".webp"}

async def _rollback_failed_case(case_id_str: str, db: AsyncSession):
    """Cleanly delete an orphaned case and its children when validation fails."""
    from sqlalchemy import delete
    from app.models.case import Case
    from app.models.claim import Claim
    from app.models.claim_line import ClaimLine
    from app.models.rfi import RFI
    from app.models.auth_request import SchemeAuthRequest
    
    case_query = await db.execute(select(Case).where(Case.id == uuid.UUID(case_id_str)))
    case = case_query.scalar_one_or_none()
    if not case: return
    
    claims_query = await db.execute(select(Claim.id).where(Claim.case_id == case.id))
    claim_ids = [c for c in claims_query.scalars()]
    
    if claim_ids:
        await db.execute(delete(RFI).where(RFI.claim_id.in_(claim_ids)))
        await db.execute(delete(ClaimLine).where(ClaimLine.claim_id.in_(claim_ids)))
        await db.execute(delete(SchemeAuthRequest).where(SchemeAuthRequest.claim_id.in_(claim_ids)))
        await db.execute(delete(Claim).where(Claim.case_id == case.id))
        
    await db.execute(delete(SchemeAuthRequest).where(SchemeAuthRequest.case_id == case.id))
    await db.execute(delete(Case).where(Case.id == case.id))

async def background_auto_auth(case_id: str, user_id: uuid.UUID):
    """Trigger authorization API request in a background session."""
    from app.database import AsyncSessionLocal
    import asyncio
    
    # Wait slightly to ensure commit completes in main thread
    await asyncio.sleep(1)
    
    async with AsyncSessionLocal() as db:
        user_res = await db.execute(select(User).where(User.id == user_id))
        user = user_res.scalar_one_or_none()
        if user:
            from app.api.authorization import request_authorization
            try:
                await request_authorization(case_id=case_id, body=None, db=db, current_user=user)
            except Exception as e:
                import logging
                logging.getLogger("ems.documents").error(f"Auto-auth failed for case {case_id}: {e}")

@router.post("/upload", response_model=DocumentResponse, status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile = File(...),
    document_type: str = Form("prf"),
    case_id: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Upload a PRF document or supporting file.
    Triggers async preprocessing → OCR extraction pipeline.
    Gated behind OCR_INTAKE_ENABLED while we focus on Digital PRF rollout.
    """
    # ── OCR intake feature flag ──
    # The paper/OCR pipeline is parked. Existing uploads, Celery tasks,
    # models, and the uploads/ directory all remain in place; this guard
    # simply refuses NEW intake until OCR_INTAKE_ENABLED=true is set.
    from app.config import get_settings as _get_settings
    if not _get_settings().OCR_INTAKE_ENABLED:
        raise HTTPException(
            status_code=503,
            detail=(
                "OCR / paper-PRF intake is currently disabled. "
                "Submit cases via the Digital PRF on the crew portal. "
                "To re-enable, set OCR_INTAKE_ENABLED=true."
            ),
        )
    # Validate file extension
    import os
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file type: {ext}. Allowed: {ALLOWED_EXTENSIONS}",
        )

    # Validate file size
    file_bytes = await file.read()
    max_size = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024
    if len(file_bytes) > max_size:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File size exceeds {settings.MAX_UPLOAD_SIZE_MB}MB limit",
        )

    # Validate file content (magic bytes) — prevents disguised executables
    MAGIC_SIGNATURES = {
        b"%PDF":        "application/pdf",         # PDF
        b"\x89PNG":     "image/png",               # PNG
        b"\xff\xd8\xff": "image/jpeg",             # JPEG
        b"II\x2a\x00": "image/tiff",              # TIFF (little-endian)
        b"MM\x00\x2a": "image/tiff",              # TIFF (big-endian)
        b"BM":         "image/bmp",                # BMP
        b"RIFF":       "image/webp",               # WebP (RIFF container)
    }
    header = file_bytes[:16]
    content_valid = any(header.startswith(sig) for sig in MAGIC_SIGNATURES)
    if not content_valid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File content does not match a supported document type. The file may be corrupted or disguised.",
        )

    # Save to local storage
    storage_uri = await save_upload(file_bytes, file.filename or "upload.pdf")

    # Create document record
    doc = Document(
        case_id=uuid.UUID(case_id) if case_id else None,
        original_filename=file.filename or "upload.pdf",
        storage_uri=storage_uri,
        processed_uri=None,
        document_type=document_type,
        ocr_status=OCRStatus.PENDING,
        uploaded_by=current_user.id,
    )
    db.add(doc)
    await db.commit()
    await db.refresh(doc)

    # Trigger async preprocessing task
    try:
        from app.tasks.preprocessing import preprocess_document
        preprocess_document.delay(str(doc.id))
    except Exception:
        # If Celery/RabbitMQ isn't running, the upload still succeeds — task can be retried later
        pass

    return DocumentResponse(
        id=str(doc.id),
        case_id=str(doc.case_id) if doc.case_id else None,
        original_filename=doc.original_filename,
        document_type=doc.document_type,
        ocr_status=doc.ocr_status.value,
        ocr_confidence_avg=doc.ocr_confidence_avg,
        ocr_field_scores=doc.ocr_field_scores,
        extracted_data=doc.extracted_data,
        needs_hitl_review=doc.needs_hitl_review,
        created_at=doc.created_at,
    )


@router.get("/", response_model=DocumentListResponse)
async def list_documents(
    page: int = 1,
    page_size: int = 20,
    ocr_status: Optional[str] = None,
    case_id: Optional[str] = None,
    needs_review: Optional[bool] = None,
    exclude_accepted: bool = False,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """List documents with pagination and filters."""
    query = select(Document).order_by(Document.created_at.asc())
    count_query = select(func.count(Document.id))

    if ocr_status:
        query = query.where(Document.ocr_status == OCRStatus(ocr_status))
        count_query = count_query.where(Document.ocr_status == OCRStatus(ocr_status))
    if case_id:
        query = query.where(Document.case_id == uuid.UUID(case_id))
        count_query = count_query.where(Document.case_id == uuid.UUID(case_id))
    if needs_review is not None:
        query = query.where(Document.needs_hitl_review == needs_review)
        count_query = count_query.where(Document.needs_hitl_review == needs_review)
    if exclude_accepted:
        query = query.where(Document.case_id.is_(None))
        count_query = count_query.where(Document.case_id.is_(None))

    # Total count
    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0

    # Paginated results
    offset = (page - 1) * page_size
    result = await db.execute(query.offset(offset).limit(page_size))
    docs = result.scalars().all()

    from starlette.responses import JSONResponse
    doc_list = [
        {
            "id": str(d.id),
            "case_id": str(d.case_id) if d.case_id else None,
            "original_filename": d.original_filename,
            "document_type": d.document_type,
            "ocr_status": d.ocr_status.value,
            "ocr_confidence_avg": d.ocr_confidence_avg,
            "ocr_field_scores": d.ocr_field_scores,
            "extracted_data": d.extracted_data,
            "needs_hitl_review": d.needs_hitl_review,
            "group_id": d.group_id,
            "is_group_primary": d.is_group_primary,
            "created_at": d.created_at.isoformat() if d.created_at else None,
        }
        for d in docs
    ]
    return JSONResponse(content={"documents": doc_list, "total": total, "page": page, "page_size": page_size})



@router.get("/{doc_id}", response_model=DocumentResponse)
async def get_document(
    doc_id: str,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Get a specific document's metadata and extraction results."""
    result = await db.execute(select(Document).where(Document.id == uuid.UUID(doc_id)))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    from starlette.responses import JSONResponse
    return JSONResponse(content={
        "id": str(doc.id),
        "case_id": str(doc.case_id) if doc.case_id else None,
        "original_filename": doc.original_filename,
        "document_type": doc.document_type,
        "ocr_status": doc.ocr_status.value,
        "ocr_confidence_avg": doc.ocr_confidence_avg,
        "ocr_field_scores": doc.ocr_field_scores,
        "extracted_data": doc.extracted_data,
        "needs_hitl_review": doc.needs_hitl_review,
        "group_id": doc.group_id,
        "is_group_primary": doc.is_group_primary,
        "created_at": doc.created_at.isoformat() if doc.created_at else None,
    })



@router.delete("/{doc_id}", status_code=status.HTTP_200_OK)
async def delete_document(
    doc_id: str,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Permanently delete a document and its files from disk."""
    import os

    result = await db.execute(select(Document).where(Document.id == uuid.UUID(doc_id)))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # Delete files from disk
    for uri in [doc.storage_uri, doc.processed_uri]:
        if uri:
            full_path = get_full_path(uri)
            if os.path.exists(full_path):
                try:
                    os.remove(full_path)
                except OSError:
                    pass  # File may already be gone

    # Delete the database record
    await db.delete(doc)
    await db.commit()

    return {"message": "Document deleted permanently", "id": doc_id}


@router.get("/{doc_id}/download")
async def download_document(
    doc_id: str,
    processed: bool = False,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Download the raw or processed document file."""
    result = await db.execute(select(Document).where(Document.id == uuid.UUID(doc_id)))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    uri = doc.processed_uri if (processed and doc.processed_uri) else doc.storage_uri
    full_path = get_full_path(uri)

    if not file_exists(uri):
        raise HTTPException(status_code=404, detail="File not found on disk")

    import mimetypes
    mime_type, _ = mimetypes.guess_type(doc.original_filename)
    if not mime_type:
        mime_type = "application/octet-stream"

    return FileResponse(
        path=full_path,
        filename=doc.original_filename,
        media_type=mime_type,
        content_disposition_type="inline",
    )


@router.post("/{document_id}/reprocess")
async def reprocess_document_endpoint(
    document_id: str,
    engine: Optional[str] = "azure",
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Force reprocess a document through the AI pipeline.
    Gated behind OCR_INTAKE_ENABLED while we focus on Digital PRF rollout."""
    from app.config import get_settings as _get_settings
    if not _get_settings().OCR_INTAKE_ENABLED:
        raise HTTPException(
            status_code=503,
            detail="OCR reprocessing is currently disabled (OCR_INTAKE_ENABLED=false).",
        )
    from app.tasks.preprocessing import preprocess_document

    result = await db.execute(select(Document).where(Document.id == uuid.UUID(document_id)))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # Reset statuses
    doc.ocr_status = OCRStatus.PENDING
    doc.needs_hitl_review = False
    await db.commit()

    # Trigger with engine preference
    preprocess_document.delay(str(doc.id), engine=engine)

    return {"message": "Document queued for re-processing", "status": "pending"}


@router.patch("/{doc_id}/review", response_model=DocumentResponse)
async def review_document(
    doc_id: str,
    review_data: dict,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update extracted data and mark document as reviewed (HITL).
    
    When clear_review_flag is True:
    1. Saves the corrected extracted data
    2. Creates Case → Claim → ClaimLines from the data
    3. Auto-triggers the adjudication engine
    """
    result = await db.execute(select(Document).where(Document.id == uuid.UUID(doc_id)))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
        
    doc.extracted_data = review_data.get("extracted_data", doc.extracted_data)
    if "original_filename" in review_data:
        doc.original_filename = review_data["original_filename"]
        
    # Mark fields that have been filled as 1.0 confidence so they stop glowing as RFI
    if doc.ocr_field_scores and isinstance(doc.extracted_data, dict):
        new_scores = dict(doc.ocr_field_scores)
        for k, v in doc.extracted_data.items():
            if v not in (None, "", []):
                new_scores[k] = 1.0
        from sqlalchemy.orm.attributes import flag_modified
        doc.ocr_field_scores = new_scores
        flag_modified(doc, "ocr_field_scores")
        
    pipeline_result = None
    adjudication_result = None
    
    if review_data.get("clear_review_flag", False):
        doc.needs_hitl_review = False
        import datetime as dt
        doc.reviewed_at = dt.datetime.now(dt.timezone.utc)
        doc.reviewed_by_id = current_user.id
        
        # ── Auto-create or Update Case → Claim → ClaimLines ──
        if doc.extracted_data:
            try:
                from app.services.claims_pipeline import create_claim_from_document, update_claim_from_document
                if not doc.case_id:
                    pipeline_result = await create_claim_from_document(doc, db)
                else:
                    pipeline_result = await update_claim_from_document(doc, db)
                
                # ── Auto-Auth logic ──
                if "error" not in pipeline_result:
                    case_id_str = pipeline_result["case_id"]
                    from app.models.case import Case, PreAuthStatus
                    case_res = await db.execute(select(Case).where(Case.id == uuid.UUID(case_id_str)))
                    case_rec = case_res.scalar()
                    
                    if case_rec and not case_rec.preauth_number:
                        scheme = (case_rec.medical_scheme_name or "").lower()
                        if not scheme or "private" in scheme or "cash" in scheme:
                            case_rec.auth_flag = True
                            case_rec.auth_flag_reason = "Private Claim - No API Auth Expected"
                            case_rec.preauth_status = PreAuthStatus.PENDING
                        else:
                            background_tasks.add_task(background_auto_auth, case_id_str, current_user.id)
                    
                    # ── Auto-trigger adjudication ──
                    try:
                        from app.services.adjudication_engine import adjudicate_claim
                        adj = await adjudicate_claim(
                            claim_id=pipeline_result["claim_id"],
                            db=db,
                            auto_generate_rfis=True,
                        )
                        adjudication_result = {
                            "status": adj.status,
                            "is_clean": adj.is_clean,
                            "passed": adj.passed_checks,
                            "failed": adj.failed_checks,
                            "warnings": adj.warning_count,
                            "rfis": adj.rfis_generated,
                            "checks": [{"check_name": c.check_name, "passed": c.passed, "severity": c.severity, "message": c.message} for c in adj.checks]
                        }

                        # ── Prevent PRF from advancing if it failed verification ──
                        # Keep it in the Document Review queue so the user can fix the errors.
                        blocking_rfis = [rfi for rfi in adj.rfis_generated if rfi.get("reason_code") != "MISSING_PREAUTH"]
                        failed_checks = [c for c in adj.checks if not c.passed and c.severity == "error"]
                        
                        if blocking_rfis or failed_checks:
                            doc.needs_hitl_review = True
                            doc.reviewed_at = None
                            doc.reviewed_by_id = None
                            doc.case_id = None
                            await _rollback_failed_case(pipeline_result["case_id"], db)

                    except Exception as adj_err:
                        import traceback
                        traceback.print_exc()
                        adjudication_result = {"error": str(adj_err)}
                        doc.needs_hitl_review = True
                        doc.reviewed_at = None
                        doc.reviewed_by_id = None
                        doc.case_id = None
                        await _rollback_failed_case(pipeline_result["case_id"], db)
                    
            except Exception as pipe_err:
                pipeline_result = {"error": str(pipe_err)}
                doc.needs_hitl_review = True
                doc.reviewed_at = None
                doc.reviewed_by_id = None
                doc.case_id = None
        
    await db.commit()
    await db.refresh(doc)
    
    response = DocumentResponse(
        id=str(doc.id),
        case_id=str(doc.case_id) if doc.case_id else None,
        original_filename=doc.original_filename,
        document_type=doc.document_type,
        ocr_status=doc.ocr_status.value,
        ocr_confidence_avg=doc.ocr_confidence_avg,
        ocr_field_scores=doc.ocr_field_scores,
        extracted_data=doc.extracted_data,
        needs_hitl_review=doc.needs_hitl_review,
        created_at=doc.created_at,
    )
    
    # Attach pipeline info to response (extra fields beyond schema)
    resp_dict = response.model_dump(mode='json')
    if pipeline_result:
        resp_dict["pipeline"] = pipeline_result
    if adjudication_result:
        resp_dict["adjudication"] = adjudication_result
    
    from starlette.responses import JSONResponse
    return JSONResponse(content=resp_dict, status_code=200)


@router.post("/reprocess-pending")
async def reprocess_pending_documents(
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Re-trigger processing for all documents stuck in pending/failed status.
    Gated behind OCR_INTAKE_ENABLED while we focus on Digital PRF rollout."""
    from app.config import get_settings as _get_settings
    if not _get_settings().OCR_INTAKE_ENABLED:
        raise HTTPException(
            status_code=503,
            detail="OCR reprocessing is currently disabled (OCR_INTAKE_ENABLED=false).",
        )
    from app.tasks.preprocessing import preprocess_document

    result = await db.execute(
        select(Document).where(
            Document.ocr_status.in_([OCRStatus.PENDING, OCRStatus.FAILED])
        )
    )
    stuck_docs = result.scalars().all()

    triggered = []
    for doc in stuck_docs:
        preprocess_document.delay(str(doc.id))
        triggered.append(str(doc.id))

    return {
        "message": f"Re-triggered {len(triggered)} documents",
        "document_ids": triggered,
    }


@router.get("/export-spreadsheet")
async def export_spreadsheet(
    status_filter: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Export all processed documents to an Excel spreadsheet."""
    from app.services.spreadsheet_export import generate_prf_spreadsheet
    from datetime import datetime

    query = select(Document).order_by(Document.created_at.desc())
    if status_filter:
        query = query.where(Document.ocr_status == OCRStatus(status_filter))

    result = await db.execute(query)
    docs = result.scalars().all()

    # Convert to dicts for the spreadsheet generator
    doc_dicts = []
    for doc in docs:
        doc_dicts.append({
            "id": str(doc.id)[:8],
            "original_filename": doc.original_filename,
            "ocr_status": doc.ocr_status.value,
            "ocr_confidence_avg": f"{doc.ocr_confidence_avg:.0%}" if doc.ocr_confidence_avg else "",
            "extracted_data": doc.extracted_data or {},
            "needs_hitl_review": doc.needs_hitl_review,
            "created_at": doc.created_at.strftime("%Y-%m-%d %H:%M") if doc.created_at else "",
        })

    excel_bytes = generate_prf_spreadsheet(doc_dicts)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M")
    filename = f"PRF_Extractions_{timestamp}.xlsx"

    return Response(
        content=excel_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Document Grouping ───────────────────────────────────────────────────────

from pydantic import BaseModel as PydanticBase

class GroupRequest(PydanticBase):
    primary_id: str    # PRF — becomes the group leader
    secondary_id: str  # Tracker/attachment — linked to primary


@router.post("/group")
async def group_documents(
    body: GroupRequest,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Bundle two documents together. Primary (PRF) leads the group; secondary is the attachment."""
    primary = (await db.execute(select(Document).where(Document.id == uuid.UUID(body.primary_id)))).scalar_one_or_none()
    secondary = (await db.execute(select(Document).where(Document.id == uuid.UUID(body.secondary_id)))).scalar_one_or_none()

    if not primary or not secondary:
        raise HTTPException(status_code=404, detail="One or both documents not found")
    if body.primary_id == body.secondary_id:
        raise HTTPException(status_code=400, detail="Cannot group a document with itself")

    # Use primary's existing group_id or create a new one
    group_id = primary.group_id or str(uuid.uuid4())

    primary.group_id = group_id
    primary.is_group_primary = True
    secondary.group_id = group_id
    secondary.is_group_primary = False

    await db.commit()
    return {"group_id": group_id, "primary_id": body.primary_id, "secondary_id": body.secondary_id}


@router.delete("/{document_id}/ungroup")
async def ungroup_document(
    document_id: str,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Remove a document from its bundle, clearing its group_id."""
    doc = (await db.execute(select(Document).where(Document.id == uuid.UUID(document_id)))).scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    old_group_id = doc.group_id
    doc.group_id = None
    doc.is_group_primary = False

    # If only one document remains in the group, dissolve it too
    if old_group_id:
        remaining = (await db.execute(
            select(Document).where(Document.group_id == old_group_id, Document.id != doc.id)
        )).scalars().all()
        if len(remaining) == 1:
            remaining[0].group_id = None
            remaining[0].is_group_primary = False
        elif len(remaining) > 1:
            remaining[0].is_group_primary = True

    await db.commit()
    return {"success": True, "document_id": document_id}


@router.get("/group/{group_id}")
async def get_group(
    group_id: str,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Fetch all documents in a bundle, primary first."""
    from starlette.responses import JSONResponse
    docs = (await db.execute(
        select(Document).where(Document.group_id == group_id).order_by(Document.is_group_primary.desc())
    )).scalars().all()

    return JSONResponse(content={
        "group_id": group_id,
        "documents": [
            {
                "id": str(d.id),
                "original_filename": d.original_filename,
                "document_type": d.document_type,
                "ocr_status": d.ocr_status.value,
                "ocr_confidence_avg": d.ocr_confidence_avg,
                "is_group_primary": d.is_group_primary,
                "needs_hitl_review": d.needs_hitl_review,
                "created_at": d.created_at.isoformat() if d.created_at else None,
            }
            for d in docs
        ]
    })


@router.patch("/{document_id}/type")
async def update_document_type(
    document_id: str,
    document_type: str = Form(...),
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Update document type."""
    doc = (await db.execute(select(Document).where(Document.id == uuid.UUID(document_id)))).scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    
    doc.document_type = document_type
    await db.commit()
    
    return {"success": True, "document_type": document_type}



