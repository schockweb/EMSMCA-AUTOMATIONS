"""
Digital PRF API — Create, auto-save (5s), and submit digital Patient Report Forms.
Crew members use these endpoints from their mobile phones.
"""
from __future__ import annotations
import uuid
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select, func, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.digital_prf import DigitalPRF, PRFStatus
from app.models.service_provider import ServiceProvider
from app.models.vehicle import Vehicle
from app.models.crew_member import CrewMember
from app.models.case import Case
from app.models.claim import Claim, AdjudicationStatus
from app.models.document import Document, OCRStatus
from app.models.user import User
from app.api.crew_auth import get_current_crew
from app.utils.security import get_current_user
from app.utils.hpcsa import to_tier as _qual_to_tier

logger = logging.getLogger("ems.digital_prf")

router = APIRouter(prefix="/api/digital-prf", tags=["Digital PRF"])


# ── Schemas ──────────────────────────────────────────────────

class PRFCreateRequest(BaseModel):
    vehicle_id: str | None = None
    crew_member_2_id: str | None = None
    # Supervising practitioner — only set when the shift was started with a
    # BAA-only crew (HPCSA staffing rule §2.1). The HPCSA registration number
    # is the field the rules engine reads (`supervising_practitioner_pr`);
    # name + qualification are stored alongside for display + audit.
    supervising_practitioner_pr: str | None = None
    supervising_practitioner_name: str | None = None
    supervising_practitioner_qualification: str | None = None

class PRFSaveRequest(BaseModel):
    """Auto-save payload — sent every 5 seconds from the mobile form."""
    form_data: dict | None = None
    # Optimistic concurrency: the `updated_at` value the client last received
    # from the server (via GET or a previous save). If another writer has since
    # touched this row, the server rejects the save with 409 so the client can
    # refetch and avoid silently clobbering newer data. Optional — when omitted
    # the save proceeds (backward compatible).
    client_base_updated_at: str | None = None
    # Real-time timestamp markers (ISO strings from frontend)
    time_call_received: str | None = None
    time_dispatched: str | None = None
    time_mobile: str | None = None
    time_on_scene: str | None = None
    time_depart_scene: str | None = None
    time_at_destination: str | None = None
    time_handover: str | None = None
    time_available: str | None = None
    time_back_to_base: str | None = None
    # Odometer readings
    km_call_received: str | None = None
    km_dispatched: str | None = None
    km_mobile: str | None = None
    km_on_scene: str | None = None
    km_depart_scene: str | None = None
    km_at_destination: str | None = None
    km_handover: str | None = None
    km_available: str | None = None
    km_back_to_base: str | None = None
    # Signatures (base64)
    patient_signature: str | None = None
    witness_signature: str | None = None
    handover_signature: str | None = None
    crew_signature: str | None = None
    valuables_signature: str | None = None
    # Crew assignment
    vehicle_id: str | None = None
    crew_member_1_id: str | None = None
    crew_member_2_id: str | None = None

class PRFMarkTimestamp(BaseModel):
    """Crew taps a button to mark a real-time timestamp."""
    field: str  # e.g. "time_dispatched", "time_on_scene"
    km: str | None = None  # optional km reading at the same time
    latitude: float | None = None
    longitude: float | None = None
    accuracy_m: float | None = None  # GPS accuracy radius in metres


def _parse_iso(val: str | None) -> datetime | None:
    if not val:
        return None
    try:
        return datetime.fromisoformat(val.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


async def _next_prf_number(db: AsyncSession, provider: ServiceProvider) -> int:
    """Next PRF number for THIS provider only.

    Each of the 100+ providers counts its own PRFs independently — provider A
    creating #103 must never advance provider B's numbering. The number is
    therefore derived from this provider's own rows, not a shared sequence.

    `provider.prf_start_number` is the baseline an admin enters once at
    onboarding (the count of PRFs already completed on paper). The first digital
    PRF continues from there (baseline + 1); once digital PRFs pass the baseline,
    the provider's own max drives the count.

    Concurrency: `create_prf` loads the provider row `FOR UPDATE`, which
    serialises concurrent PRF creation for the *same* provider (other providers
    are unaffected), so this max()+1 cannot hand two crews the same number.
    """
    result = await db.execute(
        select(func.max(DigitalPRF.prf_number)).where(
            DigitalPRF.provider_id == provider.id
        )
    )
    provider_max = result.scalar() or 0
    baseline = provider.prf_start_number or 0
    return max(provider_max, baseline) + 1


def _generate_case_number(provider_slug: str, prf_number: int) -> str:
    """Generate a case number like JEMS-2026-04-000001 (max 50 chars)."""
    now = datetime.now(timezone.utc)
    # Suffix '-YYYY-MM-00000X' is exactly 15 chars. Max total is 50.
    # Truncate slug to max 35 chars.
    safe_slug = provider_slug[:35].upper().rstrip('-')
    return f"{safe_slug}-{now.year}-{now.month:02d}-{prf_number:06d}"


# ═══════════════════════════════════════════════════════════
# Access control helpers (multi-tenant isolation)
# ═══════════════════════════════════════════════════════════
# Every crew-facing endpoint must load a PRF through `_load_crew_prf` so that a
# crew member can never read or mutate a PRF belonging to another provider
# (another of the 105 client companies). Loading a PRF by id alone — without a
# provider check — is a cross-tenant PHI leak.

async def _load_crew_prf(
    db: AsyncSession,
    prf_id: str,
    crew: CrewMember,
    *,
    require_owner: bool = True,
    allow_crew2: bool = False,
) -> DigitalPRF:
    """Load a PRF and enforce tenant + ownership access control.

    - 400 if `prf_id` is not a valid UUID.
    - 404 if the PRF does not exist OR belongs to a different provider. We use
      404 (not 403) for the cross-tenant case so the API never confirms the
      existence of another company's PRF.
    - If `require_owner`: 403 when the caller is not the PRF creator
      (`crew_member_1_id`). When `allow_crew2` is True the second crew member on
      the PRF is also permitted (e.g. read-only review).
    """
    try:
        pid = uuid.UUID(prf_id)
    except (ValueError, TypeError):
        raise HTTPException(400, "Invalid PRF id")

    result = await db.execute(select(DigitalPRF).where(DigitalPRF.id == pid))
    prf = result.scalar_one_or_none()
    if not prf or prf.provider_id != crew.provider_id:
        raise HTTPException(404, "PRF not found")

    if require_owner:
        permitted = {prf.crew_member_1_id}
        if allow_crew2:
            permitted.add(prf.crew_member_2_id)
        if crew.id not in permitted:
            raise HTTPException(403, "PRF does not belong to this crew member")

    return prf


async def _assert_provider_owns(db: AsyncSession, model, obj_id, provider_id, label: str):
    """Raise 400 unless `obj_id` exists and belongs to `provider_id`.

    Used to stop a crew from attaching another company's vehicle or crew member
    to their PRF (which would corrupt tenant isolation and billing attribution).
    """
    res = await db.execute(
        select(model.id).where(model.id == obj_id, model.provider_id == provider_id)
    )
    if res.scalar_one_or_none() is None:
        raise HTTPException(400, f"Invalid {label} for this provider")


# ═══════════════════════════════════════════════════════════
# ENDPOINTS
# ═══════════════════════════════════════════════════════════

@router.post("", status_code=201)
async def create_prf(
    body: PRFCreateRequest,
    crew: CrewMember = Depends(get_current_crew),
    db: AsyncSession = Depends(get_db),
):
    """Create a new draft PRF. Auto-fills crew + provider."""
    # Load provider for case number generation. FOR UPDATE serialises
    # concurrent PRF creation for this one provider so `_next_prf_number`'s
    # max()+1 is race-free (other providers never contend on this row).
    provider = await db.execute(
        select(ServiceProvider)
        .where(ServiceProvider.id == crew.provider_id)
        .with_for_update()
    )
    provider = provider.scalar_one()

    prf_number = await _next_prf_number(db, provider)
    case_number = _generate_case_number(provider.slug, prf_number)

    # Seed form_data with the supervising practitioner if the frontend sent
    # one — this is what the rules engine reads. Stored as plain keys (not
    # nested) so the existing `fd.get("supervising_practitioner_pr")` access
    # pattern in `_build_clinical_context` works unchanged.
    initial_form_data: dict = {}
    if body.supervising_practitioner_pr:
        initial_form_data["supervising_practitioner_pr"] = body.supervising_practitioner_pr.strip().upper()
    if body.supervising_practitioner_name:
        initial_form_data["supervising_practitioner_name"] = body.supervising_practitioner_name.strip()
    if body.supervising_practitioner_qualification:
        initial_form_data["supervising_practitioner_qualification"] = body.supervising_practitioner_qualification.strip().upper()

    prf = DigitalPRF(
        provider_id=crew.provider_id,
        crew_member_1_id=crew.id,
        crew_member_2_id=uuid.UUID(body.crew_member_2_id) if body.crew_member_2_id else None,
        vehicle_id=uuid.UUID(body.vehicle_id) if body.vehicle_id else None,
        prf_number=prf_number,
        case_number=case_number,
        status=PRFStatus.DRAFT,
        form_data=initial_form_data,
    )
    db.add(prf)
    await db.commit()

    logger.info(
        "Created draft PRF #%d (case %s) by crew %s",
        prf.prf_number, prf.case_number, crew.full_name,
    )

    return {
        "id": str(prf.id),
        "prf_number": prf.prf_number,
        "case_number": prf.case_number,
        "status": prf.status.value,
    }


@router.patch("/{prf_id}")
async def save_prf(
    prf_id: str,
    body: PRFSaveRequest,
    crew: CrewMember = Depends(get_current_crew),
    db: AsyncSession = Depends(get_db),
):
    """Auto-save PRF draft. Called every 10 minutes (periodic backup) from the mobile form."""
    prf = await _load_crew_prf(db, prf_id, crew)

    # Only DRAFTs are editable. Once a PRF is SUBMITTED it is being read by the
    # billing pipeline — a late autosave here would produce a torn read and bill
    # off inconsistent data. PROCESSED PRFs are immutable billing records.
    # 423 (Locked), NOT 409: the client's 409 handler means "concurrency
    # conflict — refetch and retry", so a 409 here put a device that still had
    # a submitted PRF open into an infinite zero-delay retry loop that tripped
    # the nginx rate limiter and blocked the whole device (Samsung PWA outage,
    # 2026-07-21). 423 tells the client the row is permanently uneditable.
    if prf.status != PRFStatus.DRAFT:
        raise HTTPException(
            423, f"Cannot edit a {prf.status.value} PRF — only drafts can be auto-saved."
        )

    # Optimistic concurrency — reject a save built on a stale view of the row so
    # a second device (or an out-of-order request) can't silently clobber newer
    # data. The client refetches on 409 and retries against the latest version.
    if body.client_base_updated_at and prf.updated_at is not None:
        base = _parse_iso(body.client_base_updated_at)
        if base is not None:
            current = prf.updated_at
            if current.tzinfo is None:
                current = current.replace(tzinfo=timezone.utc)
            # 1s tolerance absorbs serialization/clock rounding.
            if (current - base).total_seconds() > 1.0:
                raise HTTPException(
                    409,
                    "PRF was modified elsewhere. Refetch the latest version before saving.",
                )

    # Update form data. The crew app sends the full form_data blob every
    # 5 seconds, so a naive overwrite would clobber server-managed keys
    # (e.g. `_doctor_access_token`, `_doctor_access_expires_at`) that the
    # client never sees. Preserve any underscore-prefixed key from the
    # existing row that the incoming payload doesn't explicitly include.
    # To prevent mass assignment privilege escalation, we filter out any
    # underscore-prefixed keys provided by the client before merging.
    if body.form_data is not None:
        existing = prf.form_data or {}
        merged = {k: v for k, v in body.form_data.items() if not k.startswith("_")}
        for k, v in existing.items():
            if k.startswith("_") and k not in merged:
                merged[k] = v
        prf.form_data = merged

    # Update timestamps
    TIMESTAMP_FIELDS = [
        "time_call_received", "time_dispatched", "time_mobile",
        "time_on_scene", "time_depart_scene", "time_at_destination",
        "time_handover", "time_available", "time_back_to_base",
    ]
    for field in TIMESTAMP_FIELDS:
        val = getattr(body, field, None)
        if val is not None:
            # Empty strings are not valid ISO timestamps — skip them.
            parsed = _parse_iso(val) if val else None
            if parsed is not None:
                setattr(prf, field, parsed)

    # Update km readings
    KM_FIELDS = [
        "km_call_received", "km_dispatched", "km_mobile",
        "km_on_scene", "km_depart_scene", "km_at_destination",
        "km_handover", "km_available", "km_back_to_base",
    ]
    for field in KM_FIELDS:
        val = getattr(body, field, None)
        if val is not None:
            # Empty strings crash asyncpg when written to Numeric columns
            # (decimal.ConversionSyntax). Treat '' as NULL.
            setattr(prf, field, val if val != '' else None)

    # Update signatures
    for sig_field in ["patient_signature", "witness_signature", "handover_signature", "crew_signature", "valuables_signature"]:
        val = getattr(body, sig_field, None)
        if val is not None:
            setattr(prf, sig_field, val)

    # Update crew/vehicle assignments. Every assigned vehicle / crew member must
    # belong to the caller's provider, and the primary crew member (the owner)
    # may not be reassigned to someone else.
    if body.vehicle_id is not None:
        new_vehicle_id = uuid.UUID(body.vehicle_id) if body.vehicle_id else None
        if new_vehicle_id is not None:
            await _assert_provider_owns(db, Vehicle, new_vehicle_id, crew.provider_id, "vehicle")
        prf.vehicle_id = new_vehicle_id
    if body.crew_member_2_id is not None:
        new_c2 = uuid.UUID(body.crew_member_2_id) if body.crew_member_2_id else None
        if new_c2 is not None:
            await _assert_provider_owns(db, CrewMember, new_c2, crew.provider_id, "crew member")
        prf.crew_member_2_id = new_c2
    if body.crew_member_1_id is not None:
        new_c1 = uuid.UUID(body.crew_member_1_id) if body.crew_member_1_id else None
        if new_c1 is not None and new_c1 != crew.id:
            raise HTTPException(403, "Cannot reassign the primary crew member of a PRF.")

    await db.commit()
    await db.refresh(prf)

    # Invalidate the Redis cache for this PRF on every save.
    # The next GET will rebuild from the DB and re-cache.
    from app.cache import invalidate_prf as _invalidate_prf
    await _invalidate_prf(prf_id)

    return {
        "status": "saved",
        "prf_number": prf.prf_number,
        "updated_at": prf.updated_at.isoformat() if prf.updated_at else None,
    }


# ═══════════════════════════════════════════════════════════════════════════
# In-form adjudication — phase-scoped scrub
# ═══════════════════════════════════════════════════════════════════════════
# The crew form calls this on Save & Continue. We pull the same hardcoded
# rules the back-office adjudication runs, evaluate them against the partial
# PRF, and return only the issues that map to fields visible in the phase the
# crew is leaving. CRITICAL / HIGH severities block the advance; MEDIUM / LOW
# warn but allow progression.

# Map: which rule keywords belong to which phase. The adjudication rule "name"
# field carries a short title — we filter on substrings so a rule rename
# doesn't silently un-gate a phase.
PHASE_RULE_KEYWORDS: dict[int, tuple[str, ...]] = {
    # Phase 0 — Dispatch (call type, billing type, dispatch + dispatched times)
    0: (
        "EMED reference number",
        "Member number",
        "Dependent code",
        "Pre-planned event",
    ),
    # Phase 1 — En Route (call info, destination, referring/receiving doctor)
    1: (
        "IFT requires referring doctor",
        "IFT requires pre-authorisation",
        "Bypassing closest",
    ),
    # Phase 2 — On Scene (patient demographics, ID, mechanism, priority)
    2: (
        "Patient ID or DOB",
        "Priority 1 patient",
        "Two BLS crew",
    ),
    # Phase 3 — Clinical (history, surveys, vitals, IV, meds, ICDs)
    3: (
        "S/T ICD-10",
        "Z-codes",
        "vitals",
        "ILS billed without",
        "Cardiac incident",
        "Resus fee",
        "Ventilated IFT",
    ),
    # Phase 4 — Transport (depart-scene + management notes)
    4: (
        "Scene time exceeds",
        "Direct admission",
    ),
    # Phase 5 — Handover (arrival, handover signature, handover notes)
    5: (
        "Handover signature",
        "Handover time exceeds",
        "4th patient",
    ),
    # Phase 6 — Complete (signatures, ICD-10, final review). Everything that
    # didn't match earlier still has to pass before submit; surface anything
    # remaining here.
    6: (
        "signature",
        "Call-out fee",
    ),
}


def _rule_matches_phase(rule_name: str, phase: int) -> bool:
    keywords = PHASE_RULE_KEYWORDS.get(phase, ())
    name_lower = rule_name.lower()
    return any(kw.lower() in name_lower for kw in keywords)


def _build_partial_context(prf: DigitalPRF, crew: CrewMember) -> dict:
    """Build the same flat context the adjudication engine expects, from the
    in-progress PRF (rows + form_data) without requiring a Case/Claim yet.
    Mirrors the keys produced by `_adapt_prf_to_extracted_data`."""
    fd = prf.form_data or {}

    # Build clinical narratives + intervention flags identically to the submit path
    airway     = fd.get("airway_interventions")     if isinstance(fd.get("airway_interventions"), list) else []
    circulate  = fd.get("circulation_interventions") if isinstance(fd.get("circulation_interventions"), list) else []
    immob      = fd.get("immob_equipment")          if isinstance(fd.get("immob_equipment"), list) else []
    medications = fd.get("medications")              if isinstance(fd.get("medications"), list) else []
    iv_therapy  = fd.get("iv_therapy")               if isinstance(fd.get("iv_therapy"), list) else []

    # Mechanism is now a single-select string but legacy PRFs may still be lists
    _mech_raw = fd.get("mechanism")
    mechanism = _mech_raw if isinstance(_mech_raw, list) else ([_mech_raw] if _mech_raw else [])

    procedures_text = ", ".join(filter(None, [*airway, *circulate, *immob])).lower()
    meds_text = " ".join(
        filter(None, [(m.get("type") or "") + " " + (m.get("dose") or "") for m in medications if isinstance(m, dict)])
    ).lower()
    notes_text = " ".join(filter(None, [
        fd.get("events_hpi") or "",
        fd.get("management_notes") or "",
        fd.get("findings_on_arrival") or "",
        fd.get("chief_complaint") or "",
    ])).lower()
    haystack = procedures_text + " " + meds_text + " " + notes_text

    resus_keywords = ("cpr", "defib", "intubat", "resuscitat", "shock", "rosc")
    als_keywords = ("intubat", "pacing", "defib", "adrenaline", "amiodarone",
                    "morphine", "midazolam", "ketamine", "etomidate", "rocuronium")
    ils_keywords = ("nebuli", "dextrose", "salbutamol", "ipratropium", "fluid", "saline")

    resuscitation_performed = any(k in haystack for k in resus_keywords)
    als_intervention = resuscitation_performed or any(k in haystack for k in als_keywords)
    ils_intervention = als_intervention or (bool(iv_therapy) and bool(medications)) \
        or any(k in haystack for k in ils_keywords)

    # Dispatch type — RHT (Returned Home Transfer), COURTESY transfers, IHT
    # (Inter-Hospital Transfer) and IFT (Inter-Facility Transfer) all map to
    # the canonical "IFT" dispatch type the rule engine recognises. Anything
    # else (PRIMARY, blank, unknown) treated as a Primary emergency response.
    call_raw = (fd.get("call_type") or "").upper()
    dispatch_type = "IFT" if call_raw in ("TRANSFER", "IHT", "IFT", "RHT", "COURTESY") else "Primary"

    # Crew qualification cap — supervising practitioner derived from crew_2 if present.
    # The form_data value may be an HPCSA category (BAA/AEA/…) for crew who logged in
    # post-migration, or a legacy tier (BLS/ILS/ALS) for in-flight PRFs. `_qual_to_tier`
    # normalises both so the rules engine still sees BLS/ILS/ALS as expected.
    crew2_qual = ""
    if prf.crew_member_2_id:
        crew2_qual = _qual_to_tier(fd.get("crew_member_2_qualification"), default="")

    # ── Call-type aware time calculation ─────────────────────────────────────
    # DOD and RHT calls have no Handover phase — time_at_destination and
    # time_handover are never captured for those call types. We zero them
    # explicitly here (before no_transport is set below) rather than
    # relying on None arithmetic in the max() below.
    raw_call_type_for_time = (fd.get("call_type") or "").upper()
    no_transport_time = raw_call_type_for_time in ("DOD", "RHT")

    # Handover minutes
    handover_minutes = 0.0
    if not no_transport_time and prf.time_at_destination and prf.time_handover:
        handover_minutes = max(
            0.0, (prf.time_handover - prf.time_at_destination).total_seconds() / 60.0
        )
    # Scene minutes
    scene_minutes = 0.0
    if prf.time_on_scene and prf.time_depart_scene:
        scene_minutes = max(
            0.0, (prf.time_depart_scene - prf.time_on_scene).total_seconds() / 60.0
        )
    elif no_transport_time and prf.time_on_scene and prf.time_available:
        # DOD / RHT: crew stays on scene until "Available" — use that as the
        # end of their billable on-scene time since there is no depart_scene.
        scene_minutes = max(
            0.0, (prf.time_available - prf.time_on_scene).total_seconds() / 60.0
        )

    # Distances
    def _km(val):
        try:
            return float(val) if val else 0.0
        except (TypeError, ValueError):
            return 0.0

    # ── Call-type aware distance calculation ─────────────────────────────────
    # DOD (Declaration of Death) and RHT (Refused Hospital Transport) have no
    # patient transport leg — the crew never departed scene toward a facility,
    # so km_depart_scene, km_at_destination, and km_back_to_base are always
    # None for those call types. Silently applying max(0.0, ...) would produce
    # a zero and mask the real reason. We branch explicitly so the intent is
    # clear and auditable. Any new no-transport call type must be added here.
    raw_call_type = (fd.get("call_type") or "").upper()
    no_transport = raw_call_type in ("DOD", "RHT")

    callout_km = max(0.0, _km(prf.km_on_scene) - _km(prf.km_dispatched))

    if no_transport:
        # No facility transport on this call type — loaded and RTB legs do not
        # exist. Set to 0.0 explicitly rather than relying on None arithmetic.
        loaded_km = 0.0
        rtb_km = 0.0
    else:
        loaded_km = max(0.0, _km(prf.km_at_destination) - _km(prf.km_depart_scene))
        rtb_km = max(0.0, _km(prf.km_back_to_base) - _km(prf.km_at_destination))

    total_km = loaded_km + rtb_km + callout_km

    vitals_count = len(fd.get("vitals_sets") or []) if isinstance(fd.get("vitals_sets"), list) else 0

    return {
        # Identity / scheme
        "scheme_member_number":  fd.get("medical_aid_number"),
        "patient_id_number":     fd.get("patient_id_number"),
        "patient_dob":           fd.get("patient_dob"),
        "dependant_code":        fd.get("dependent_number"),
        "preauth_number":        fd.get("preauth_number"),
        "emed_reference_number": fd.get("emed_reference_number") or fd.get("preauth_number"),

        # Crew / level — `crew.qualification` is now an HPCSA category
        # (BAA/AEA/…); translate to legacy BLS/ILS/ALS tier so the rules engine
        # (LEVEL_RANK, two-BLS rejection, billing-cap) keeps working unchanged.
        "level_of_care":              fd.get("monitoring_level") or fd.get("assessment_level") or _qual_to_tier(crew.qualification),
        "highest_crew_qual":          _qual_to_tier(crew.qualification),
        "crew_member_2_qualification": crew2_qual,

        # Supervising practitioner — non-empty when the shift was BAA-only.
        # Discovery's "BLS-only must have a supervising practitioner" rule and
        # the softened GEMS two-BLS rejection both read this key.
        "supervising_practitioner_pr": fd.get("supervising_practitioner_pr") or "",

        # Call shape
        "dispatch_type":     dispatch_type,
        "incident_type":     dispatch_type,
        "call_type":         dispatch_type,
        "priority":          fd.get("priority"),
        "patient_count":     int(fd.get("patient_count") or 1),
        "pre_planned_event": bool(fd.get("pre_planned_event")),

        # Routing / facility
        "incident_location":             fd.get("incident_location"),
        "receiving_facility":            fd.get("receiving_facility"),
        "referring_doctor_pr":           fd.get("referring_doctor"),
        "referring_doctor":              fd.get("referring_doctor"),
        "closest_facility_bypassed":     bool(fd.get("closest_facility_bypassed")),
        "direct_admission":              bool(fd.get("direct_admission")),
        "emed_notified":                 bool(fd.get("emed_notified")),
        "lifesaving_intervention_required": bool(fd.get("lifesaving_intervention_required")),

        # ICD-10
        "icd10_primary":         fd.get("icd10_primary"),
        "icd10_external_cause":  fd.get("icd10_external_cause"),

        # Clinical state
        "scene_minutes":                scene_minutes,
        "handover_minutes":             handover_minutes,
        "loaded_distance_km":           loaded_km,
        "rtb_distance_km":              rtb_km,
        "callout_distance_km":          callout_km,
        "total_distance_km":            total_km,
        "vitals_count":                 vitals_count,
        "ils_intervention_performed":   ils_intervention,
        "als_intervention_performed":   als_intervention,
        "resuscitation_performed":      resuscitation_performed,
        "iv_line_placed":               bool(iv_therapy),
        "iv_active_infusion":           bool(iv_therapy and medications),
        "iv_tkvo":                      (fd.get("iv_purpose") or "").lower().startswith("tkvo"),
        "ventilator_in_use":            bool(fd.get("ventilator_in_use")),
        "ventilator_settings_recorded": bool(fd.get("ventilator_settings_recorded")),
        "blood_gas_attached":           bool(fd.get("blood_gas_attached")),
        "has_ecg_attached":             bool(fd.get("has_ecg_attached")),
        "rosc_achieved":                bool(fd.get("rosc_achieved")),
        "perfusing_rhythm_on_handover": bool(fd.get("perfusing_rhythm_on_handover")),
        "cardiac_incident":             bool(fd.get("cardiac_incident")),
        "declaration_of_death_completed": bool(fd.get("declaration_of_death_completed")),

        # Signatures (the form persists base64 strings on the prf row)
        "patient_signature":  prf.patient_signature,
        "witness_signature":  prf.witness_signature,
        "handover_signature": prf.handover_signature,
        "valuables_signature": prf.valuables_signature,
        "signature_refused_reason": fd.get("signature_refused_reason"),

        # Call-out fee (only relevant if claimed)
        "call_out_fee_claimed":             bool(fd.get("call_out_fee_claimed")),
        "call_out_fee_dispatched_by_emed":  bool(fd.get("call_out_fee_dispatched_by_emed")),
        "vehicle_tracking_report":          bool(fd.get("vehicle_tracking_report")),
        "tracking_error_letter":            bool(fd.get("tracking_error_letter")),

        # Narrative
        "clinical_notes":   fd.get("management_notes") or fd.get("events_hpi") or "",
        "motivation_notes": fd.get("management_notes") or fd.get("events_hpi") or "",
        "cpt_codes":        [],   # not yet generated at form-fill time
    }


@router.post("/{prf_id}/scrub-phase")
async def scrub_phase(
    prf_id: str,
    phase: int = 0,
    crew: CrewMember = Depends(get_current_crew),
    db: AsyncSession = Depends(get_db),
):
    """Run the scheme's hardcoded rules against the in-progress PRF and return
    any blockers/warnings relevant to the phase the crew is trying to leave.

    Response shape:
        {
          "can_continue": bool,            # false if any CRITICAL/HIGH rule fired
          "blockers":   [{rule, reason, severity, rfi_code}],
          "warnings":   [{rule, reason, severity, rfi_code}],
          "scheme_matched": "GEMS" | "Discovery" | None,
        }
    """
    prf = await _load_crew_prf(db, prf_id, crew)

    # Go-live scope: digital PRF only, no adjudication. Scrub is intentionally
    # a no-op so missing rule data can never block phase advance. Re-enable by
    # removing this short-circuit when the adjudication system goes live.
    return {
        "can_continue": True,
        "blockers": [],
        "warnings": [],
        "scheme_matched": None,
    }

    fd = prf.form_data or {}
    scheme_name = fd.get("medical_scheme") or ""

    # Resolve the rule module via the registry
    from app.rules import get_rules_for_scheme
    from app.rules.base import RuleAction, RuleSeverity

    module = get_rules_for_scheme(scheme_name)
    if module is None:
        # No rule module → never block; the scrub is a no-op.
        return {
            "can_continue": True,
            "blockers": [],
            "warnings": [],
            "scheme_matched": None,
        }

    ctx = _build_partial_context(prf, crew)

    blockers: list[dict] = []
    warnings: list[dict] = []

    for rule in getattr(module, "RULES", ()):
        try:
            matched = bool(rule.predicate(ctx))
        except Exception as e:
            logger.warning("Rule '%s' raised during scrub: %s", rule.name, e)
            matched = False

        if not matched:
            continue
        if not _rule_matches_phase(rule.name, phase):
            continue

        sev = rule.severity.value if isinstance(rule.severity, RuleSeverity) else str(rule.severity)
        action = rule.action.value if isinstance(rule.action, RuleAction) else str(rule.action)

        entry = {
            "rule": rule.name,
            "reason": rule.reason,
            "severity": sev,
            "action": action,
            "rfi_code": rule.rfi_code,
        }
        # CRITICAL + HIGH → blockers; everything else → warnings.
        # REJECT actions are always blockers regardless of severity.
        if sev in ("critical", "high") or action == "REJECT":
            blockers.append(entry)
        else:
            warnings.append(entry)

    return {
        "can_continue": len(blockers) == 0,
        "blockers": blockers,
        "warnings": warnings,
        "scheme_matched": getattr(module, "SCHEME_ID", "").upper() or None,
    }


@router.delete("/{prf_id}", status_code=200)
async def delete_prf(
    prf_id: str,
    crew: CrewMember = Depends(get_current_crew),
    db: AsyncSession = Depends(get_db),
):
    """
    Delete a single PRF. Only DRAFT status is deletable, and only by the
    crew member who created it (crew_member_1_id) — submitted/processed
    claims must never be deleted by crew (they're billing records).

    Used by the dashboard "discard draft" button and by the end-shift
    sweep that fires when a crew taps "End Shift".
    """
    prf = await _load_crew_prf(db, prf_id, crew)

    # Submitted / processed PRFs are billing records — never deletable from crew app
    if prf.status != PRFStatus.DRAFT:
        raise HTTPException(
            409,
            f"Cannot delete a {prf.status.value} PRF. Only drafts can be discarded.",
        )

    prf_number = prf.prf_number
    await db.delete(prf)
    await db.commit()
    logger.info("Crew %s deleted draft PRF #%d", crew.full_name, prf_number)
    return {"status": "deleted", "prf_number": prf_number}


@router.post("/end-shift", status_code=200)
async def end_shift(
    crew: CrewMember = Depends(get_current_crew),
    db: AsyncSession = Depends(get_db),
):
    """
    End-of-shift cleanup. Deletes every DRAFT PRF the authenticated crew
    member has open. Submitted PRFs are untouched (they're already in the
    billing pipeline).

    Idempotent — safe to call multiple times. Returns the list of deleted
    PRF numbers so the frontend can show a final confirmation toast.
    """
    result = await db.execute(
        select(DigitalPRF).where(
            DigitalPRF.crew_member_1_id == crew.id,
            DigitalPRF.status == PRFStatus.DRAFT,
        )
    )
    drafts = result.scalars().all()

    deleted_numbers = [p.prf_number for p in drafts]
    for prf in drafts:
        await db.delete(prf)
    await db.commit()

    logger.info(
        "Crew %s ended shift — discarded %d draft PRF(s): %s",
        crew.full_name, len(deleted_numbers), deleted_numbers,
    )
    return {
        "status": "shift_ended",
        "drafts_deleted": len(deleted_numbers),
        "prf_numbers": deleted_numbers,
    }


@router.post("/{prf_id}/mark-time")
async def mark_timestamp(
    prf_id: str,
    body: PRFMarkTimestamp,
    crew: CrewMember = Depends(get_current_crew),
    db: AsyncSession = Depends(get_db),
):
    """Mark a real-time timestamp. Crew taps a button → system captures exact time."""
    prf = await _load_crew_prf(db, prf_id, crew)
    if prf.status != PRFStatus.DRAFT:
        raise HTTPException(
            409, f"Cannot mark times on a {prf.status.value} PRF — only drafts are editable."
        )

    VALID_FIELDS = {
        "time_call_received", "time_dispatched", "time_mobile",
        "time_on_scene", "time_depart_scene", "time_at_destination",
        "time_handover", "time_available", "time_back_to_base",
    }
    if body.field not in VALID_FIELDS:
        raise HTTPException(400, f"Invalid timestamp field: {body.field}")

    now = datetime.now(timezone.utc)
    setattr(prf, body.field, now)

    # Also save km if provided
    km_field = body.field.replace("time_", "km_")
    if body.km and hasattr(prf, km_field):
        setattr(prf, km_field, body.km)

    # Persist confirmed GPS coordinates keyed by the timestamp field name.
    # SQLAlchemy doesn't track in-place dict mutation on JSONB columns, so we
    # rebuild the dict and reassign to flag the column dirty.
    geo_entry: dict | None = None
    if body.latitude is not None and body.longitude is not None:
        import math
        spoofing_flag = False
        existing = dict(prf.geo_locations or {})
        
        # Check against the most recently captured coordinate to detect spoofing
        if existing:
            try:
                latest_key = max(existing, key=lambda k: datetime.fromisoformat(existing[k]["captured_at"]))
                latest_geo = existing[latest_key]
                lat1, lon1 = latest_geo["lat"], latest_geo["lng"]
                lat2, lon2 = body.latitude, body.longitude
                
                # Haversine distance via shared utility
                from app.services.geo_utils import haversine_km
                distance_km = haversine_km(lat1, lon1, lat2, lon2)
                
                # Time difference in hours
                latest_time = datetime.fromisoformat(latest_geo["captured_at"])
                time_diff_hrs = (now - latest_time).total_seconds() / 3600.0
                
                if time_diff_hrs > 0 and (distance_km / time_diff_hrs) > 150.0:
                    spoofing_flag = True
                    logger.warning("GPS Spoofing suspected for PRF #%d: speed exceeds 150km/h", prf.prf_number)
            except Exception as e:
                logger.error("Error calculating GPS velocity: %s", e)

        geo_entry = {
            "lat": body.latitude,
            "lng": body.longitude,
            "accuracy_m": body.accuracy_m,
            "captured_at": now.isoformat(),
            "spoofing_suspected": spoofing_flag
        }
        existing[body.field] = geo_entry
        prf.geo_locations = existing

    await db.commit()

    logger.info(
        "PRF #%d: %s marked at %s by %s%s",
        prf.prf_number, body.field, now.isoformat(), crew.full_name,
        f" @ {body.latitude:.5f},{body.longitude:.5f}" if geo_entry else "",
    )

    return {
        "field": body.field,
        "timestamp": now.isoformat(),
        "km": body.km,
        "geo": geo_entry,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Digital PRF → extracted_data adapter
# ═══════════════════════════════════════════════════════════════════════════
# The tariff engine and mileage engine were written for OCR'd paper PRFs that
# arrive as an extracted_data dict with a specific set of keys. Digital PRFs
# store their data under different key names on `form_data` plus dedicated
# columns for timestamps, km readings, and FK-linked crew records. This
# adapter translates the digital shape into the canonical extracted_data
# shape so the same billing pipeline drives both sources.

def _build_narrative(items, fmt) -> str:
    """Turn a list of dicts into a single human-readable string for the AI stage."""
    if not isinstance(items, list):
        return ""
    return "; ".join(fmt(i) for i in items if isinstance(i, dict) and any(i.values()))


def _adapt_prf_to_extracted_data(
    prf: DigitalPRF,
    crew1: CrewMember | None,
    provider: ServiceProvider | None = None,
) -> dict:
    """Flatten the DigitalPRF record into the keys generate_tariff_lines expects."""
    fd = prf.form_data or {}

    # ── Clinical narratives built from structured form arrays ──
    airway     = fd.get("airway_interventions")     if isinstance(fd.get("airway_interventions"), list) else []
    circulate  = fd.get("circulation_interventions") if isinstance(fd.get("circulation_interventions"), list) else []
    immob      = fd.get("immob_equipment")          if isinstance(fd.get("immob_equipment"), list) else []

    # Mechanism is now a single dropdown selection (string) but legacy PRFs
    # may still carry a multi-select list. Accept either shape.
    mech_raw = fd.get("mechanism")
    if isinstance(mech_raw, list):
        mechanism_text = ", ".join(filter(None, mech_raw))
    else:
        mechanism_text = (mech_raw or "").strip()
    mech_other = (fd.get("mechanism_other") or "").strip()
    if mech_other:
        mechanism_text = f"{mechanism_text} — {mech_other}" if mechanism_text else mech_other

    procedures = ", ".join(filter(None, [*airway, *circulate, *immob]))

    medications_narrative = _build_narrative(
        fd.get("medications"),
        lambda m: " ".join(filter(None, [m.get("type"), m.get("dose"), m.get("route"), m.get("time")])),
    )
    iv_narrative = _build_narrative(
        fd.get("iv_therapy"),
        lambda i: " ".join(filter(None, [i.get("type"), i.get("site"), i.get("vol_infused")])),
    )

    # Primary survey concatenated (A/B/C) — the engine's AI stage reads
    # clinical narratives to identify procedural add-ons.
    primary_survey = "; ".join(filter(None, [
        f"A: {fd.get('survey_a')}"  if fd.get("survey_a") else "",
        f"B: {fd.get('survey_b')}"  if fd.get("survey_b") else "",
        f"C: {fd.get('survey_c')}"  if fd.get("survey_c") else "",
    ]))

    clinical_notes = "\n".join(filter(None, [
        fd.get("events_hpi"),
        fd.get("management_notes"),
        fd.get("findings_on_arrival"),
    ]))

    # ── Crew qualification — billing-level cap ──
    # `crew1.qualification` is an HPCSA category post-migration; collapse to the
    # legacy SAPAESA tier the tariff engine expects.
    crew_qual = _qual_to_tier(
        (crew1.qualification if crew1 else None) or fd.get("assessment_level")
    )

    # ── Level of care from the assessment / monitoring toggles ──
    level_of_care = (fd.get("monitoring_level") or fd.get("assessment_level") or crew_qual or "ILS")

    # ── ISO datetime timestamps → HH:MM strings for mileage engine ──
    def _as_hhmm(dt):
        if not dt:
            return None
        return f"{dt.hour:02d}:{dt.minute:02d}"

    return {
        # ── Call type / scheme / demographics ──
        "call_type":               fd.get("call_type"),
        "dispatch_type":           fd.get("call_type"),  # engine will normalise
        "incident_type":           fd.get("call_type"),
        "medical_scheme":          fd.get("medical_scheme"),
        "scheme_name":             fd.get("medical_scheme"),
        "member_number":           fd.get("medical_aid_number"),
        "preauth_number":          fd.get("preauth_number"),
        "patient_id_number":       fd.get("patient_id_number"),
        "patient_dob":             fd.get("patient_dob"),
        "patient_name":            " ".join(filter(None, [fd.get("patient_name"), fd.get("patient_surname")])).strip(),
        "incident_location":       fd.get("incident_location"),
        "receiving_facility":      fd.get("receiving_facility"),

        # ── Crew & provider identifiers (drive HPCSA + BHF checks) ──
        "crew_member_1_hpcsa":         (crew1.hpcsa_number if crew1 else None),
        "crew1_hpcsa_number":          (crew1.hpcsa_number if crew1 else None),
        "provider_practice_number":    (provider.pr_number if provider else None),
        "bhf_practice_number":         (provider.pr_number if provider else None),

        # ── Clinical context (drives AI add-on stage) ──
        "level_of_care":               level_of_care,
        "crew_member_1_qualification": crew_qual,
        "chief_complaint":             fd.get("chief_complaint"),
        "clinical_notes":              clinical_notes,
        "primary_survey":              primary_survey,
        "procedures_performed":        "; ".join(filter(None, [procedures, iv_narrative])),
        "medications_administered":    medications_narrative,
        "mechanism_of_injury":         mechanism_text,
        "icd10_primary":               fd.get("icd10_primary"),
        "primary_icd10_code":          fd.get("icd10_primary"),

        # ── Odometer readings (mileage engine's primary keys) ──
        # km_* columns are Numeric → Decimal, which isn't JSON-serialisable.
        "odometer_dispatch":    float(prf.km_dispatched) if prf.km_dispatched is not None else None,
        "odometer_at_scene":    float(prf.km_on_scene) if prf.km_on_scene is not None else None,
        "odometer_departure":   float(prf.km_depart_scene) if prf.km_depart_scene is not None else None,
        "odometer_destination": float(prf.km_at_destination) if prf.km_at_destination is not None else None,
        "odometer_rtb":         float(prf.km_back_to_base) if prf.km_back_to_base is not None else None,

        # ── Timestamps for scene-time calculation ──
        "on_scene_time":                  _as_hhmm(prf.time_on_scene),
        "departure_from_scene_time":      _as_hhmm(prf.time_depart_scene),

        # ── Call-type routing flags ───────────────────────────────────────────
        # These flags tell every downstream engine (mileage, tariff, adjudication)
        # exactly why certain legs are absent — so a zero is a correct decision,
        # not a silent data gap. Add new no-transport call types here and in
        # _build_partial_context above.
        "call_type_raw":         fd.get("call_type", "").upper(),
        "no_transport_call":     fd.get("call_type", "").upper() in ("DOD", "RHT"),
        "declaration_of_death":  fd.get("call_type", "").upper() == "DOD",
        "refused_transport":     fd.get("call_type", "").upper() == "RHT",
    }


def _validate_prf_for_submission(prf: DigitalPRF) -> list[str]:
    """Server-side safety net run before a PRF is submitted to billing.

    The mobile form does the detailed validation; this is a deliberately
    conservative backend gate so a blank or structurally-incomplete PRF can
    never reach the billing pipeline even if the client is bypassed, buggy, or
    replaying an old payload. It intentionally does NOT re-implement every
    clinical rule (that would risk blocking legitimate edge cases like an
    unidentified trauma patient) — it blocks only on clearly-invalid records.
    """
    errors: list[str] = []
    fd = prf.form_data or {}

    if not fd:
        errors.append("PRF has no data captured.")
        return errors  # nothing else is meaningful on an empty form

    call_type = (fd.get("call_type") or "").strip().upper()
    if not call_type:
        errors.append("Call type is required.")

    if prf.crew_member_1_id is None:
        errors.append("A primary crew member must be assigned.")

    # Note: there is intentionally NO server-side vital-signs count check. The
    # fewer-than-3-sets case (including zero) is handled entirely by the crew's
    # Submit-time motivation prompt on the frontend — that is the single gate.
    # A hard server rule here previously rejected motivated submissions with
    # "At least one set of vital signs is required.", so it has been removed.

    return errors


@router.post("/{prf_id}/submit", status_code=202)
async def submit_prf(
    prf_id: str,
    crew: CrewMember = Depends(get_current_crew),
    db: AsyncSession = Depends(get_db),
):
    """Submit a completed PRF — queues the billing pipeline as a Celery task.

    Returns 202 Accepted immediately. The mileage engine, tariff engine, and
    Case/Claim creation run in the background via Celery so that long-running
    calculations don't block Uvicorn workers (critical at scale with 500+
    ambulances submitting concurrently).

    Idempotent: if the PRF was already processed, returns the existing result.
    """
    prf = await _load_crew_prf(db, prf_id, crew)

    # Idempotent retry: if already processed, return existing case/claim
    if prf.status == PRFStatus.PROCESSED and prf.case_id:
        existing_claim_id = None
        existing_total = 0.0
        existing_line_count = 0
        claim_res = await db.execute(
            select(Claim).where(Claim.case_id == prf.case_id).limit(1)
        )
        existing_claim = claim_res.scalar_one_or_none()
        if existing_claim:
            existing_claim_id = str(existing_claim.id)
            existing_total = float(existing_claim.total_amount or 0.0)
            from app.models.claim_line import ClaimLine
            line_res = await db.execute(
                select(func.count(ClaimLine.id)).where(ClaimLine.claim_id == existing_claim.id)
            )
            existing_line_count = int(line_res.scalar() or 0)
        return {
            "status": "processed",
            "prf_number": prf.prf_number,
            "case_number": prf.case_number,
            "case_id": str(prf.case_id),
            "document_id": str(prf.document_id) if prf.document_id else None,
            "claim_id": existing_claim_id,
            "submitted_at": prf.submitted_at.isoformat() if prf.submitted_at else None,
            "claim_total": existing_total,
            "line_count": existing_line_count,
            "tariff_engine": {"idempotent_replay": True},
        }

    if prf.status == PRFStatus.SUBMITTED:
        # Already queued but not yet processed — return the pending status
        return {
            "status": "submitted",
            "prf_number": prf.prf_number,
            "case_number": prf.case_number,
            "message": "PRF is being processed. Billing pipeline is running.",
        }

    # Server-side safety net — block structurally-invalid PRFs from billing.
    validation_errors = _validate_prf_for_submission(prf)
    if validation_errors:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "PRF cannot be submitted — please complete the form.",
                "errors": validation_errors,
            },
        )

    # Mark as SUBMITTED so the form can't be re-edited
    prf.status = PRFStatus.SUBMITTED
    prf.submitted_at = datetime.now(timezone.utc)
    await db.commit()

    # Determine queue priority from PRF data.
    # P1 calls and resuscitations go to ems_critical (highest priority).
    # Everything else goes to ems_default for routine processing.
    fd = prf.form_data or {}
    call_priority = (fd.get("priority") or "").upper()
    is_resus = any(
        k in (fd.get("management_notes") or "").lower()
        for k in ("cpr", "resuscitat", "defib", "rosc")
    )
    queue_priority = "critical" if (call_priority == "P1" or is_resus) else "normal"

    # Queue the heavy billing pipeline to Celery. If the broker is unreachable
    # the enqueue can raise — revert the status so the PRF stays an editable
    # DRAFT and can be re-submitted, rather than being stranded in SUBMITTED
    # with no task ever running.
    # Enqueue the real Celery task (`process_prf_submission`) onto the queue the
    # worker actually consumes (--queues=ems_critical,ems_default,ems_batch).
    # P1 / resus → ems_critical; everything else → ems_default.
    from app.tasks.prf_processing import process_prf_submission
    target_queue = "ems_critical" if queue_priority == "critical" else "ems_default"
    try:
        process_prf_submission.apply_async(args=[str(prf.id)], queue=target_queue)
    except Exception as enqueue_err:
        logger.error(
            "PRF #%d: failed to enqueue billing task: %s", prf.prf_number, enqueue_err
        )
        prf.status = PRFStatus.DRAFT
        prf.submitted_at = None
        await db.commit()
        raise HTTPException(
            status_code=503,
            detail="Could not queue PRF for processing. Please try submitting again.",
        )

    # Invalidate cache so the status change (DRAFT → SUBMITTED) is immediately
    # visible on any admin page that may have cached the DRAFT response.
    from app.cache import invalidate_prf as _invalidate_prf
    await _invalidate_prf(str(prf.id))

    logger.info(
        "PRF #%d submitted by %s → %s queue",
        prf.prf_number, crew.full_name, queue_priority,
    )

    return {
        "status": "submitted",
        "prf_number": prf.prf_number,
        "case_number": prf.case_number,
        "queue": queue_priority,
        "message": "PRF submitted successfully. Billing is being processed.",
    }


@router.get("")
async def list_prfs(
    crew: CrewMember = Depends(get_current_crew),
    db: AsyncSession = Depends(get_db),
):
    """List PRFs the authenticated crew member created.

    Scoped to `crew_member_1_id` (not the whole provider) so a returning crew
    member sees their own in-progress drafts on the dashboard — not every
    other crew's drafts at the same provider.
    """
    result = await db.execute(
        select(DigitalPRF)
        .where(
            DigitalPRF.provider_id == crew.provider_id,
            DigitalPRF.crew_member_1_id == crew.id,
        )
        .order_by(DigitalPRF.created_at.desc())
        .limit(50)
    )
    prfs = result.scalars().all()

    items = []
    for p in prfs:
        # Load crew names
        crew1_name = None
        crew2_name = None
        if p.crew_member_1_id:
            c1 = await db.execute(select(CrewMember.full_name).where(CrewMember.id == p.crew_member_1_id))
            crew1_name = c1.scalar()
        if p.crew_member_2_id:
            c2 = await db.execute(select(CrewMember.full_name).where(CrewMember.id == p.crew_member_2_id))
            crew2_name = c2.scalar()

        # Get patient name from form_data
        patient_name = (p.form_data or {}).get("patient_name") or (p.form_data or {}).get("patient_surname", "")

        items.append({
            "id": str(p.id),
            "prf_number": p.prf_number,
            "case_number": p.case_number,
            "status": p.status.value,
            "patient_name": patient_name,
            "crew_1": crew1_name,
            "crew_2": crew2_name,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "submitted_at": p.submitted_at.isoformat() if p.submitted_at else None,
        })

    return items


@router.get("/{prf_id}")
async def get_prf(
    prf_id: str,
    crew: CrewMember = Depends(get_current_crew),
    db: AsyncSession = Depends(get_db),
):
    """Get full PRF data for editing or review. Results are Redis-cached."""
    from app.cache import get_cache, set_cache
    from app.config import get_settings

    settings = get_settings()
    cache_key = f"prf:detail:{prf_id}:crew:{crew.id}"

    # Check cache first — fast path (no DB round-trip on cache hit)
    cached = await get_cache(cache_key)
    if cached is not None:
        return cached

    prf = await _load_crew_prf(db, prf_id, crew, allow_crew2=True)

    async def _crew(crew_id):
        if not crew_id:
            return None
        r = await db.execute(select(CrewMember).where(CrewMember.id == crew_id))
        c = r.scalar_one_or_none()
        if not c:
            return None
        return {
            "full_name": c.full_name,
            "initials": c.initials,
            "hpcsa_number": c.hpcsa_number,
            "qualification": c.qualification,
        }

    result = {
        "id": str(prf.id),
        "prf_number": prf.prf_number,
        "case_number": prf.case_number,
        "status": prf.status.value,
        "provider_id": str(prf.provider_id),
        "vehicle_id": str(prf.vehicle_id) if prf.vehicle_id else None,
        "crew_member_1_id": str(prf.crew_member_1_id) if prf.crew_member_1_id else None,
        "crew_member_2_id": str(prf.crew_member_2_id) if prf.crew_member_2_id else None,
        "crew_member_1": await _crew(prf.crew_member_1_id),
        "crew_member_2": await _crew(prf.crew_member_2_id),
        "form_data": prf.form_data or {},
        # Timestamps
        "time_call_received": prf.time_call_received.isoformat() if prf.time_call_received else None,
        "time_dispatched": prf.time_dispatched.isoformat() if prf.time_dispatched else None,
        "time_mobile": prf.time_mobile.isoformat() if prf.time_mobile else None,
        "time_on_scene": prf.time_on_scene.isoformat() if prf.time_on_scene else None,
        "time_depart_scene": prf.time_depart_scene.isoformat() if prf.time_depart_scene else None,
        "time_at_destination": prf.time_at_destination.isoformat() if prf.time_at_destination else None,
        "time_handover": prf.time_handover.isoformat() if prf.time_handover else None,
        "time_available": prf.time_available.isoformat() if prf.time_available else None,
        "time_back_to_base": prf.time_back_to_base.isoformat() if prf.time_back_to_base else None,
        # KMs
        "km_call_received": prf.km_call_received,
        "km_dispatched": prf.km_dispatched,
        "km_mobile": prf.km_mobile,
        "km_on_scene": prf.km_on_scene,
        "km_depart_scene": prf.km_depart_scene,
        "km_at_destination": prf.km_at_destination,
        "km_handover": prf.km_handover,
        "km_available": prf.km_available,
        "km_back_to_base": prf.km_back_to_base,
        # Geo captures keyed by timestamp field name
        "geo_locations": prf.geo_locations or {},
        # Signatures
        "patient_signature": prf.patient_signature,
        "witness_signature": prf.witness_signature,
        "handover_signature": prf.handover_signature,
        "crew_signature": prf.crew_signature,
        "valuables_signature": prf.valuables_signature,
        # Meta
        "submitted_at": prf.submitted_at.isoformat() if prf.submitted_at else None,
        "created_at": prf.created_at.isoformat() if prf.created_at else None,
        # Optimistic-concurrency token — the client echoes this back on save.
        "updated_at": prf.updated_at.isoformat() if prf.updated_at else None,
    }

    # Cache with TTL based on status:
    # - DRAFT:     60s  — crew is actively editing, don't serve stale data
    # - SUBMITTED: 1hr  — processing pipeline runs, no crew edits
    # - PROCESSED: 1hr  — immutable billing record
    ttl = settings.CACHE_TTL_PRF_DRAFT_SECONDS
    if prf.status.value in ("submitted", "processed"):
        ttl = settings.CACHE_TTL_PRF_SUBMITTED_SECONDS
    await set_cache(cache_key, result, ttl=ttl)

    return result


# ── Admin: fetch full PRF + branding for scheme-facing rendering ─────────────

@router.get("/admin/by-case/{case_id}")
async def get_prf_by_case_for_admin(
    case_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Return the full submitted PRF joined with provider + crew + vehicle
    info. Used by the admin-side PRF viewer (medical-scheme submission) AND
    by the crew's post-submit PDF-share flow, so the auth is dual-mode:

      • An admin User JWT — full access (used by the admin viewer).
      • A crew JWT — only when the authenticated crew member created
        the PRF being requested. This lets the crew immediately render
        and share their just-submitted PRF as a PDF without granting
        them blanket access to every case in the system.
    """
    # Both admin and crew JWTs come through Authorization: Bearer <token>.
    # `decode_token` validates the signature; the scope distinction comes
    # from claim shape: admin tokens carry `sub` (user UUID), crew tokens
    # carry `token_scope: "crew"` and `crew_id`.
    from app.utils.security import decode_token
    auth_header = request.headers.get("Authorization") or ""
    token = auth_header.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(token)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")

    is_admin = bool(payload.get("sub")) and payload.get("token_scope") != "crew"

    crew_member: CrewMember | None = None
    if not is_admin:
        if payload.get("token_scope") != "crew":
            raise HTTPException(status_code=401, detail="Invalid token")
        crew_id = payload.get("crew_id")
        if not crew_id:
            raise HTTPException(status_code=401, detail="Invalid crew token")
        crew_res = await db.execute(select(CrewMember).where(CrewMember.id == crew_id))
        crew_member = crew_res.scalar_one_or_none()
        if not crew_member or not crew_member.is_active:
            raise HTTPException(status_code=401, detail="Crew member not found or inactive")

    result = await db.execute(
        select(DigitalPRF).where(DigitalPRF.case_id == uuid.UUID(case_id))
    )
    prf = result.scalar_one_or_none()
    if not prf:
        raise HTTPException(404, "No PRF found for this case")

    # Access check for crew callers:
    #   • provider-admin crew may read any PRF belonging to their own provider
    #     (drives the PRF section on the client admin dashboard);
    #   • regular crew may only read PRFs they created themselves.
    # A cross-provider request always fails — the admin branch requires a
    # provider match and the owner branch requires being crew_member_1.
    if crew_member:
        is_provider_admin = (
            crew_member.role == "admin"
            and prf.provider_id == crew_member.provider_id
        )
        if not is_provider_admin and prf.crew_member_1_id != crew_member.id:
            raise HTTPException(403, "This PRF was not created by you")

    # Provider (for branding)
    provider_res = await db.execute(
        select(ServiceProvider).where(ServiceProvider.id == prf.provider_id)
    )
    provider = provider_res.scalar_one_or_none()

    # Crew 1 & 2
    async def _crew(crew_id):
        if not crew_id:
            return None
        r = await db.execute(select(CrewMember).where(CrewMember.id == crew_id))
        c = r.scalar_one_or_none()
        if not c:
            return None
        return {
            "full_name": c.full_name,
            "initials": c.initials,
            "hpcsa_number": c.hpcsa_number,
            "qualification": c.qualification,
        }

    crew1 = await _crew(prf.crew_member_1_id)
    crew2 = await _crew(prf.crew_member_2_id)

    # Vehicle
    vehicle = None
    if prf.vehicle_id:
        v_res = await db.execute(select(Vehicle).where(Vehicle.id == prf.vehicle_id))
        v = v_res.scalar_one_or_none()
        if v:
            vehicle = {
                "callsign": v.callsign,
                "registration": v.registration,
                "vehicle_type": v.vehicle_type,
            }

    return {
        "id": str(prf.id),
        "prf_number": prf.prf_number,
        "case_number": prf.case_number,
        "status": prf.status.value,
        "form_data": prf.form_data or {},
        "timestamps": {
            "time_call_received": prf.time_call_received.isoformat() if prf.time_call_received else None,
            "time_dispatched": prf.time_dispatched.isoformat() if prf.time_dispatched else None,
            "time_mobile": prf.time_mobile.isoformat() if prf.time_mobile else None,
            "time_on_scene": prf.time_on_scene.isoformat() if prf.time_on_scene else None,
            "time_depart_scene": prf.time_depart_scene.isoformat() if prf.time_depart_scene else None,
            "time_at_destination": prf.time_at_destination.isoformat() if prf.time_at_destination else None,
            "time_handover": prf.time_handover.isoformat() if prf.time_handover else None,
            "time_available": prf.time_available.isoformat() if prf.time_available else None,
            "time_back_to_base": prf.time_back_to_base.isoformat() if prf.time_back_to_base else None,
        },
        "kms": {
            "km_call_received": prf.km_call_received,
            "km_dispatched": prf.km_dispatched,
            "km_mobile": prf.km_mobile,
            "km_on_scene": prf.km_on_scene,
            "km_depart_scene": prf.km_depart_scene,
            "km_at_destination": prf.km_at_destination,
            "km_handover": prf.km_handover,
            "km_available": prf.km_available,
            "km_back_to_base": prf.km_back_to_base,
        },
        "signatures": {
            "patient_signature": prf.patient_signature,
            "witness_signature": prf.witness_signature,
            "handover_signature": prf.handover_signature,
            "crew_signature": prf.crew_signature,
            "valuables_signature": prf.valuables_signature,
        },
        "provider": {
            "name": provider.name if provider else None,
            "prf_name": provider.prf_name if provider else None,
            "slug": provider.slug if provider else None,
            "pr_number": provider.pr_number if provider else None,
            "pty_reg_number": provider.pty_reg_number if provider else None,
            "phone": provider.phone if provider else None,
            "email": provider.email if provider else None,
            "address": provider.address if provider else None,
            "logo_url": provider.logo_url if provider else None,
        } if provider else None,
        "crew_1": crew1,
        "crew_2": crew2,
        "vehicle": vehicle,
        "submitted_at": prf.submitted_at.isoformat() if prf.submitted_at else None,
        # Optimistic-concurrency token — the client stores this and echoes it
        # back on saves; without it the 409-recovery refetch could never
        # converge (it always read null and retried against a stale base).
        "updated_at": prf.updated_at.isoformat() if prf.updated_at else None,
    }


# ═══════════════════════════════════════════════════════════════════════════
# EMAIL HELPERS — used by the submit-time PRF-PDF-to-receiving-facility flow
# ═══════════════════════════════════════════════════════════════════════════
# On a successful PRF submission we enqueue a Celery task that renders the
# final PRF view to a PDF using Playwright (running in the celery_worker
# container) and emails it to the Receiving Facility Email captured at
# handover. The crew never has to do anything — submitting the PRF IS the
# trigger.
#
# `_send_email` is the SMTP wrapper used by that flow. It accepts optional
# binary attachments so the Celery task can attach the rendered PDF.

def _send_email(
    to: str,
    subject: str,
    body: str,
    attachments: list[dict] | None = None,
) -> tuple[bool, str | None]:
    """Send a plain-text email, optionally with binary attachments.

    `attachments` is a list of dicts: `{filename, content (bytes), mime_type}`.
    Returns `(sent, reason_if_failed)`. When SMTP_HOST is unset we report
    `smtp_not_configured` so callers (including Celery tasks) can log a
    helpful diagnostic instead of crashing.
    """
    from app.config import get_settings
    settings = get_settings()
    if not settings.SMTP_HOST:
        return False, "smtp_not_configured"

    import smtplib
    from email.message import EmailMessage

    msg = EmailMessage()
    sender = settings.SMTP_FROM_EMAIL or settings.SMTP_USERNAME or "noreply@emsclaims.local"
    msg["From"] = f"{settings.SMTP_FROM_NAME} <{sender}>"
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)

    for att in (attachments or []):
        filename = att.get("filename") or "attachment.bin"
        content = att.get("content") or b""
        mime = att.get("mime_type") or "application/octet-stream"
        maintype, _, subtype = mime.partition("/")
        if not subtype:
            maintype, subtype = "application", "octet-stream"
        msg.add_attachment(content, maintype=maintype, subtype=subtype, filename=filename)

    try:
        if settings.SMTP_USE_TLS:
            with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=30) as s:
                s.starttls()
                if settings.SMTP_USERNAME:
                    s.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
                s.send_message(msg)
        else:
            with smtplib.SMTP_SSL(settings.SMTP_HOST, settings.SMTP_PORT, timeout=30) as s:
                if settings.SMTP_USERNAME:
                    s.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
                s.send_message(msg)
        return True, None
    except Exception as exc:
        logger.warning("SMTP send failed: %s", exc)
        return False, "smtp_error"


def _public_app_url() -> str:
    from app.config import get_settings
    settings = get_settings()
    return (settings.PUBLIC_APP_URL or settings.FRONTEND_URL or "").rstrip("/")


# Doctor-portal endpoints and token-handling code were removed during the
# live rollout. The PRF is no longer shared as a link the doctor edits —
# instead, a Celery task renders the final PRF view to a PDF on submit and
# emails it to the Receiving Facility Email (see app/tasks/prf_email.py).


# ── OCR Hospital Sticker ────────────────────────────────────────────────────
# When the crew photographs a hospital sticker, send it to Mistral Vision to
# extract patient/medical-scheme fields. The crew then verifies the result in
# a confirmation modal before the fields are written to their PRF.
# This eliminates manual typing of sticker data and reduces transcription errors.

class OcrStickerRequest(BaseModel):
    """Base64-encoded JPEG/PNG image of a hospital sticker or medical document."""
    image_data: str  # data URL: "data:image/jpeg;base64,..." or raw base64


class OcrStickerResponse(BaseModel):
    """Extracted fields from the sticker OCR. All fields are optional — Mistral
    returns only what it can confidently read from the image."""
    patient_name:       str | None = None
    patient_id_number:  str | None = None
    patient_dob:        str | None = None
    medical_scheme:     str | None = None
    medical_aid_number: str | None = None
    plan_name:          str | None = None
    dependent_number:   str | None = None
    preauth_number:     str | None = None
    raw_text:           str | None = None   # full OCR text (for debugging)
    confidence:         str        = "low"  # "high" | "medium" | "low"


@router.post("/ocr-sticker", response_model=OcrStickerResponse)
async def ocr_hospital_sticker(
    body: OcrStickerRequest,
    crew: CrewMember = Depends(get_current_crew),
):
    """OCR a hospital sticker photo using Mistral Vision.

    The crew photographs the hospital sticker → frontend sends the base64 image
    here → Mistral reads it → we return structured fields → crew verifies in a
    modal → confirmed fields auto-populate the PRF form.

    Returns OcrStickerResponse with whatever fields could be extracted.
    On failure (Mistral unavailable, unreadable image), returns all-None fields
    so the crew falls back to manual entry without blocking the workflow.
    """
    from app.config import get_settings

    settings = get_settings()
    if not settings.MISTRAL_API_KEY:
        logger.warning("OCR sticker called but MISTRAL_API_KEY is not configured")
        raise HTTPException(503, "OCR service not configured — enter details manually")

    # Strip the data URL prefix if present (data:image/jpeg;base64,...)
    raw = body.image_data
    if "," in raw:
        raw = raw.split(",", 1)[1]

    # Validate it's a plausible base64 image (not empty / not text)
    if len(raw) < 100:
        raise HTTPException(400, "Image data too short — please retake the photo")

    prompt = """You are reading a South African hospital patient identifier sticker
or medical aid card. Extract the following fields exactly as printed.
Return ONLY a JSON object with these keys (use null for missing fields):

{
  "patient_name": "...",        // Full name as printed
  "patient_id_number": "...",   // SA ID number (13 digits) or passport
  "patient_dob": "...",         // Date of birth in YYYY-MM-DD format if visible
  "medical_scheme": "...",      // Medical aid scheme name (e.g. "Discovery Health")
  "medical_aid_number": "...",  // Member/medical aid number
  "plan_name": "...",           // Plan/option name (e.g. "Executive Plan")
  "dependent_number": "...",    // Dependent code (usually 2 digits)
  "preauth_number": "...",      // Pre-authorisation number if visible
  "raw_text": "...",            // All readable text from the sticker/card
  "confidence": "high"          // "high" if clearly readable, "medium" if partially, "low" if mostly unreadable
}

Return ONLY the JSON object. No explanation, no markdown fences."""

    try:
        import httpx, json as _json
        headers = {
            "Authorization": f"Bearer {settings.MISTRAL_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": "pixtral-12b-2409",   # Mistral's vision model
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": f"data:image/jpeg;base64,{raw}",
                        },
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
            "max_tokens": 512,
            "temperature": 0.0,   # Deterministic — no creative guessing on IDs
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://api.mistral.ai/v1/chat/completions",
                headers=headers,
                json=payload,
            )

        if resp.status_code != 200:
            logger.error(
                "Mistral OCR failed for crew %s: HTTP %d — %s",
                crew.full_name, resp.status_code, resp.text[:200],
            )
            raise HTTPException(502, "OCR service returned an error — please enter details manually")

        content = resp.json()["choices"][0]["message"]["content"].strip()

        # Strip markdown fences if Mistral wrapped the JSON
        if content.startswith("```"):
            content = content.split("```")[1]
            if content.startswith("json"):
                content = content[4:]
            content = content.strip()

        extracted = _json.loads(content)

        logger.info(
            "OCR sticker: crew=%s confidence=%s scheme=%s member=%s",
            crew.full_name,
            extracted.get("confidence", "unknown"),
            extracted.get("medical_scheme", "—"),
            extracted.get("medical_aid_number", "—"),
        )

        return OcrStickerResponse(
            patient_name       = extracted.get("patient_name"),
            patient_id_number  = extracted.get("patient_id_number"),
            patient_dob        = extracted.get("patient_dob"),
            medical_scheme     = extracted.get("medical_scheme"),
            medical_aid_number = extracted.get("medical_aid_number"),
            plan_name          = extracted.get("plan_name"),
            dependent_number   = extracted.get("dependent_number"),
            preauth_number     = extracted.get("preauth_number"),
            raw_text           = extracted.get("raw_text"),
            confidence         = extracted.get("confidence", "low"),
        )

    except HTTPException:
        raise
    except _json.JSONDecodeError as je:
        logger.warning("OCR sticker: Mistral returned non-JSON for crew %s: %s", crew.full_name, je)
        raise HTTPException(502, "OCR could not parse the sticker — please enter details manually")
    except Exception as exc:
        logger.error("OCR sticker unexpected error for crew %s: %s", crew.full_name, exc, exc_info=True)
        raise HTTPException(502, "OCR service unavailable — please enter details manually")
