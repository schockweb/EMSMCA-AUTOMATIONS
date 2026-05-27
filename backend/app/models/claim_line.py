"""
ClaimLine model — Granular billing lines (CPT, NAPPI, ICD-10).
"""
import uuid
from decimal import Decimal
from sqlalchemy import String, Integer, Text, ForeignKey, Numeric
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class ClaimLine(Base):
    __tablename__ = "claim_lines"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    claim_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("claims.id"), nullable=False, index=True
    )
    line_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    cpt_code: Mapped[str | None] = mapped_column(String(255), nullable=True)
    nappi_code: Mapped[str | None] = mapped_column(String(255), nullable=True)
    icd10_primary: Mapped[str | None] = mapped_column(String(50), nullable=True)
    icd10_secondary: Mapped[str | None] = mapped_column(String(50), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False, default=0)
    total_price: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False, default=0)
    modifier: Mapped[str | None] = mapped_column(
        String(50), nullable=True, comment="PMB or other modifier"
    )

    # Relationships
    claim = relationship("Claim", back_populates="claim_lines")

    def __repr__(self):
        return f"<ClaimLine {self.line_number}: {self.cpt_code} — R{self.total_price}>"
