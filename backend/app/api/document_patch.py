from __future__ import annotations
@router.patch("/{doc_id}/review", response_model=DocumentResponse)
async def review_document(
    doc_id: str,
    review_data: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update extracted data and mark document as reviewed."""
    result = await db.execute(select(Document).where(Document.id == uuid.UUID(doc_id)))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
        
    doc.extracted_data = review_data.get("extracted_data", doc.extracted_data)
    
    if review_data.get("clear_review_flag", False):
        doc.needs_hitl_review = False
        import datetime
        doc.reviewed_at = datetime.datetime.now(datetime.timezone.utc)
        doc.reviewed_by = current_user.id
        
    await db.commit()
    await db.refresh(doc)
    
    return DocumentResponse(
        id=str(doc.id),
        case_id=str(doc.case_id) if doc.case_id else None,
        original_filename=doc.original_filename,
        document_type=doc.document_type.value,
        ocr_status=doc.ocr_status.value,
        ocr_confidence_avg=doc.ocr_confidence_avg,
        ocr_field_scores=doc.ocr_field_scores,
        extracted_data=doc.extracted_data,
        needs_hitl_review=doc.needs_hitl_review,
        created_at=doc.created_at,
    )
