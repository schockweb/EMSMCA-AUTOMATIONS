"""
Submission Strategy Pattern — Payer-type-aware invoice routing.

Routes approved invoices to the correct billing pathway:
  • SCHEME  → EDI Switch (HealthBridge / Mediswitch XML)
  • AGGREGATOR → B2B PDF Statement (ER24, Netcare 911)

Uses the Strategy pattern for clean extensibility.
"""
from __future__ import annotations
import uuid
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal

logger = logging.getLogger("submission_strategies")


# ═══════════════════════════════════════════════════════════
# RESULT DATACLASS
# ═══════════════════════════════════════════════════════════

@dataclass
class SubmissionResult:
    """Typed result returned by every submission strategy."""
    success: bool
    reference: str = ""
    strategy_name: str = ""
    payer_type: str = ""
    payload_preview: str = ""
    error: str = ""
    submitted_at: str = ""


# ═══════════════════════════════════════════════════════════
# ABSTRACT BASE CLASS
# ═══════════════════════════════════════════════════════════

class SubmissionStrategy(ABC):
    """
    Abstract base for invoice submission strategies.
    Each concrete strategy encapsulates the full submit workflow
    for a specific payer type.
    """

    @abstractmethod
    async def execute(self, invoice_data: dict) -> SubmissionResult:
        """
        Execute the submission for the given invoice payload.

        Args:
            invoice_data: Dictionary containing claim_id, case details,
                          claim_lines, payer config, and financial totals.

        Returns:
            SubmissionResult with reference number and status.
        """
        ...


# ═══════════════════════════════════════════════════════════
# CONCRETE STRATEGY: EDI SWITCH (SCHEME)
# ═══════════════════════════════════════════════════════════

class EDISwitchStrategy(SubmissionStrategy):
    """
    Strategy for SCHEME payers (e.g. Discovery, GEMS, Medshield).

    Translates the invoice payload into an EDI XML format and dispatches
    it to a clearinghouse switch (HealthBridge / Mediswitch).
    Returns a switch transaction reference.
    """

    async def execute(self, invoice_data: dict) -> SubmissionResult:
        claim_id: str = invoice_data.get("claim_id", "unknown")
        scheme_name: str = invoice_data.get("payer_name", "Unknown Scheme")
        total_amount: float = invoice_data.get("total_amount", 0.0)

        logger.info(
            "EDISwitchStrategy: Translating invoice %s for scheme '%s' (R%.2f) to EDI XML…",
            claim_id, scheme_name, total_amount,
        )

        # ── MOCK: Build EDI XML payload ──────────────────────────
        # In production, this calls the real edi_generator service
        # and posts to HealthBridge/Mediswitch.
        switch_reference = f"SW-{uuid.uuid4().hex[:12].upper()}"
        edi_payload_preview = (
            f'<?xml version="1.0"?>\n'
            f"<HealthBridgeClaim>\n"
            f"  <ClaimId>{claim_id}</ClaimId>\n"
            f"  <Scheme>{scheme_name}</Scheme>\n"
            f"  <TotalAmount>{total_amount:.2f}</TotalAmount>\n"
            f"  <SwitchRef>{switch_reference}</SwitchRef>\n"
            f"</HealthBridgeClaim>"
        )

        logger.info(
            "EDISwitchStrategy: Invoice %s dispatched → switch ref %s",
            claim_id, switch_reference,
        )

        return SubmissionResult(
            success=True,
            reference=switch_reference,
            strategy_name="EDISwitchStrategy",
            payer_type="SCHEME",
            payload_preview=edi_payload_preview,
            submitted_at=datetime.now(timezone.utc).isoformat(),
        )


# ═══════════════════════════════════════════════════════════
# CONCRETE STRATEGY: B2B AGGREGATOR
# ═══════════════════════════════════════════════════════════

class B2BAggregatorStrategy(SubmissionStrategy):
    """
    Strategy for AGGREGATOR payers (e.g. ER24, Netcare 911).

    Generates a PDF statement with line items and dispatches it
    via the aggregator's B2B API. Returns a B2B dispatch reference.
    """

    async def execute(self, invoice_data: dict) -> SubmissionResult:
        claim_id: str = invoice_data.get("claim_id", "unknown")
        aggregator_name: str = invoice_data.get("payer_name", "Unknown Aggregator")
        dispatch_ref: str = invoice_data.get("dispatch_reference_number", "")
        total_amount: float = invoice_data.get("total_amount", 0.0)

        logger.info(
            "B2BAggregatorStrategy: Generating PDF statement for '%s', "
            "dispatch ref '%s', claim %s (R%.2f)…",
            aggregator_name, dispatch_ref, claim_id, total_amount,
        )

        # ── MOCK: Generate PDF statement ─────────────────────────
        # In production, this uses reportlab/weasyprint to create
        # a compliant PDF and POSTs it to the aggregator B2B API.
        b2b_reference = f"B2B-{uuid.uuid4().hex[:12].upper()}"
        pdf_payload_preview = (
            f"[PDF STATEMENT GENERATED]\n"
            f"Aggregator : {aggregator_name}\n"
            f"Dispatch # : {dispatch_ref}\n"
            f"Claim ID   : {claim_id}\n"
            f"Total      : R{total_amount:.2f}\n"
            f"B2B Ref    : {b2b_reference}"
        )

        logger.info(
            "B2BAggregatorStrategy: Statement dispatched → B2B ref %s",
            claim_id, b2b_reference,
        )

        return SubmissionResult(
            success=True,
            reference=b2b_reference,
            strategy_name="B2BAggregatorStrategy",
            payer_type="AGGREGATOR",
            payload_preview=pdf_payload_preview,
            submitted_at=datetime.now(timezone.utc).isoformat(),
        )


# ═══════════════════════════════════════════════════════════
# FACTORY / ROUTER
# ═══════════════════════════════════════════════════════════

_STRATEGY_MAP: dict[str, type[SubmissionStrategy]] = {
    "SCHEME": EDISwitchStrategy,
    "AGGREGATOR": B2BAggregatorStrategy,
}


async def route_invoice(
    invoice_data: dict,
    payer_type: str,
) -> SubmissionResult:
    """
    Factory function that instantiates the correct submission strategy
    based on the payer type and executes it.

    Args:
        invoice_data: Full invoice payload (claim_id, lines, payer info, etc.)
        payer_type: 'SCHEME' or 'AGGREGATOR'

    Returns:
        SubmissionResult from the executed strategy.

    Raises:
        ValueError: If payer_type is not recognized.
    """
    strategy_cls = _STRATEGY_MAP.get(payer_type.upper())
    if strategy_cls is None:
        logger.error("route_invoice: Unknown payer_type '%s'", payer_type)
        return SubmissionResult(
            success=False,
            strategy_name="Unknown",
            payer_type=payer_type,
            error=f"Unsupported payer type: '{payer_type}'. Expected SCHEME or AGGREGATOR.",
        )

    strategy = strategy_cls()
    logger.info(
        "route_invoice: Routing claim %s via %s (payer_type=%s)",
        invoice_data.get("claim_id", "?"), strategy_cls.__name__, payer_type,
    )
    return await strategy.execute(invoice_data)
