"""
Probes, remedies, and the rule that decides what may run without a human.

THE DESIGN PROBLEM
------------------
"Fix it automatically if you are confident" is the right instinct and the wrong
mechanism. A confidence score is a number somebody picks, and the moment it is a
number it gets tuned upward until the system is doing things nobody sanctioned.
An automated repair on a platform holding patient clinical records has to fail
towards asking, not towards acting.

So there is no score here. Eligibility is derived from PROPERTIES of the remedy,
each of which is a yes/no fact about the code being run, declared by whoever
wrote it:

  touches_patient_data   Does the action read, write or delete clinical data?
  idempotent             Is running it twice indistinguishable from once?
  destructive            Does it discard state that cannot be reconstructed?
  deterministic_probe    Is the detection an exact check, or an inference?
  blast_radius           What breaks if the remedy is wrong?

A remedy runs unattended only when every one of those answers is favourable.
Any single unfavourable answer routes it to a human — there is no combination of
"very confident" that overrides `touches_patient_data`.

WHY `deterministic_probe` IS IN THE LIST
----------------------------------------
It is the one people leave out. A remedy can be perfectly safe and still be the
wrong thing to do, because the DETECTION was a guess. "PHI reads are 5x the
weekly baseline" is a real and valuable signal, and it is also true on the
Monday after a public holiday. A statistical probe may raise a fault; it may
never trigger an unattended action.

WHY FLAP DETECTION IS NOT OPTIONAL
----------------------------------
A self-healer that fires every five minutes has not fixed anything. It has
converted a visible outage into an invisible one and is holding the system in a
degraded state where the underlying cause never gets looked at. Worse, some
remedies CAUSE the recurrence — restarting a consumer that dies on a poison
message re-reads the poison message. So a remedy that keeps succeeding on a
condition that keeps returning is treated as a FAILING remedy and escalated to a
human, which is the opposite of what a naive implementation does.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

from app.models.system_fault import FaultSeverity

logger = logging.getLogger("ems.monitor")


@dataclass(frozen=True)
class ProbeResult:
    """What a probe saw. `ok=True` means the condition holds and there is no fault."""
    ok: bool
    evidence: dict = field(default_factory=dict)
    # Lets a probe soften or sharpen severity from the static default — e.g.
    # disk at 80% is MEDIUM, at 95% it is CRITICAL, same probe.
    severity_override: Optional[FaultSeverity] = None
    # A probe can decline to judge (broker unreachable, so queue depth unknown).
    # That is NOT a pass and NOT a fault — it is a no-op, because guessing in
    # either direction is worse than saying nothing.
    inconclusive: bool = False

    @staticmethod
    def healthy(**evidence) -> "ProbeResult":
        return ProbeResult(ok=True, evidence=evidence)

    @staticmethod
    def faulty(severity: Optional[FaultSeverity] = None, **evidence) -> "ProbeResult":
        return ProbeResult(ok=False, evidence=evidence, severity_override=severity)

    @staticmethod
    def unknown(**evidence) -> "ProbeResult":
        return ProbeResult(ok=True, evidence=evidence, inconclusive=True)


@dataclass(frozen=True)
class RemedyResult:
    ok: bool
    detail: str = ""


@dataclass(frozen=True)
class Remedy:
    key: str
    description: str                    # in the operator's language, not the code's
    run: Callable[[], Awaitable[RemedyResult]]

    # ── The safety declaration. Every field is a claim about the action. ──
    touches_patient_data: bool          # clinical records, identifiers, PDFs
    idempotent: bool                    # running twice == running once
    destructive: bool                   # discards state that cannot be rebuilt
    blast_radius: str                   # plain words: what is affected if wrong

    # Loop protection.
    cooldown_minutes: int = 15
    max_attempts: int = 3
    # How many unattended repairs of the SAME condition inside the flap window
    # before the engine stops healing and escalates instead.
    flap_limit: int = 3
    flap_window_hours: int = 6


@dataclass(frozen=True)
class Probe:
    key: str
    title: str
    severity: FaultSeverity
    check: Callable[[], Awaitable[ProbeResult]]
    # Why the threshold is what it is. Written for the person who will one day
    # want to change it and deserves to know what it was chosen against.
    rationale: str
    deterministic: bool = True
    remedy: Optional[Remedy] = None
    # Explanation shown when there is no remedy at all — some conditions can
    # only be reported (a certificate expiring needs a human and a registrar).
    manual_guidance: Optional[str] = None


_PROBES: dict[str, Probe] = {}


def register(probe: Probe) -> Probe:
    if probe.key in _PROBES:
        raise ValueError(f"duplicate probe key: {probe.key}")
    _PROBES[probe.key] = probe
    return probe


def all_probes() -> list[Probe]:
    return list(_PROBES.values())


def get_probe(key: str) -> Optional[Probe]:
    return _PROBES.get(key)


# ── The rule ────────────────────────────────────────────────────────────────

def static_auto_eligibility(probe: Probe) -> tuple[bool, str]:
    """May this probe's remedy EVER run unattended? Independent of runtime state.

    Returns (eligible, reason). The reason is stored on the fault so an
    operator reading the queue can see why something is waiting for them
    instead of having to infer it.
    """
    r = probe.remedy
    if r is None:
        return False, "No automatic remedy exists for this condition."
    if r.touches_patient_data:
        return False, (
            "The fix touches patient clinical data. Nothing that reads, writes "
            "or deletes a patient record is ever performed unattended on this "
            "platform, regardless of how clear the fault is."
        )
    if not probe.deterministic:
        return False, (
            "Detection is statistical rather than exact, so the fault itself "
            "may be a false positive. An inferred problem never triggers an "
            "automatic action."
        )
    if r.destructive:
        return False, (
            "The fix discards state that cannot be reconstructed, so a wrong "
            "diagnosis cannot be undone."
        )
    if not r.idempotent:
        return False, (
            "The fix is not idempotent, so a retry or a duplicate run would "
            "have a different effect from a single run."
        )
    return True, (
        f"Operational only, idempotent and non-destructive. Blast radius: {r.blast_radius}."
    )
