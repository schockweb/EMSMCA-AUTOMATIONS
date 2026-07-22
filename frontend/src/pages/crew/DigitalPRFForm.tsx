/**
 * Digital PRF — Trip Journey Form
 * Follows the EMS call from dispatch to completion as a step-by-step journey.
 * Each phase mirrors the real-world call flow so crew always know where they are.
 */
import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, createContext, useContext } from 'react';
import ReactDOM from 'react-dom';
import { useScrollLock } from '../../hooks/useScrollLock';
import { useParams, useNavigate } from 'react-router-dom';
// Raw axios — the PRF form builds its own crew_token-authenticated instance via
// api() below; it must not inherit the admin api/client interceptor.
import axios from 'axios';
import { getCrewToken, getCrewProfile, CREW_SESSION_KEYS } from '../../utils/crewSession';
import { inferResumePhase } from '../../utils/prfResumePhase';
import SignaturePad from '../../components/SignaturePad';
import FullscreenSignaturePad, { FullscreenCanvas } from '../../components/FullscreenSignaturePad';
import PatientDocumentsCapture from '../../components/PatientDocumentsCapture';
import DocumentsCapture from '../../components/DocumentsCapture';
import BodyDiagram from '../../components/BodyDiagram';
import {
  validatePhase as validatePhaseRules,
  buildContext as buildValidationContext,
  blockers as validationBlockers,
  warnings as validationWarnings,
  type Phase as ValidationPhase,
  type ValidationFinding,
} from './prfValidation';
import {
  CATEGORY_META,
  findMedicationByName,
  isAuthorised,
  medicationNamesForCategory,
  normaliseHpcsaCategory,
  scopeForFormLabel,
} from '../../data/hpcsaScope';

// Empty baseURL → axios uses relative paths → requests go to whatever origin
// the page was loaded from (localhost on desktop, ngrok/LAN IP on mobile),
// then through the Vite proxy to the backend. Hard-coding 'http://localhost:8000'
// here breaks mobile because the phone's own localhost has no backend running.
// Override with VITE_API_URL only when the API is on a genuinely different host.
const API = '';

// ── Design tokens ─────────────────────────────────────────────────────────────
const G = '#5b8def'; const GDK = '#3b6fde'; const GBG = 'rgba(91,141,239,0.09)';
// Full Tailwind "slate" scale S50–S900. Keep ALL shades defined even if a given
// shade isn't referenced yet — a missing rung (e.g. S300/S500) is an undefined
// global that crashes the whole page via the ErrorBoundary the instant any code
// touches it. Defining the complete scale removes that entire failure mode.
const S900 = '#0f172a'; const S800 = '#1e293b'; const S700 = '#334155'; const S600 = '#475569';
const S500 = '#64748b'; const S400 = '#94a3b8'; const S300 = '#cbd5e1'; const S200 = '#e2e8f0';
const S100 = '#f1f5f9'; const S50 = '#f8fafc'; const W = '#ffffff';
const ROSE = '#e11d48'; const AMB = '#f59e0b'; const REDC = '#ef4444';

function api() {
  return axios.create({
    baseURL: API,
    headers: {
      Authorization: `Bearer ${getCrewToken()}`,
      // Skips ngrok's HTML interstitial when accessed via an ngrok tunnel.
      // No effect on direct LAN / localhost access.
      'ngrok-skip-browser-warning': 'true',
    },
  });
}

// ── Medical schemes — SAPAESA Administration List (01 Jan 2026), alphabetical ──
const MEDICAL_SCHEMES = [
  '21st Century Life',
  'ADT Security',
  'AECI',
  'Adcorp',
  'Affinity Health',
  'African Unity',
  'Alliance Midmed Medical Scheme',
  'Anglo Medical Scheme',
  'Anglovaal Medical Scheme',
  'Asterio Health',
  'BCCCI (State Facilities Only)',
  'BEMAS (BMW Employees Medical Aid)',
  'BIBC / BCIMA Building & Construction Medical Aid',
  'BPMAS (BP Medical Scheme)',
  'Bankmed Medical Aid',
  'Barlow World Medical Scheme',
  'Bestmed',
  'Bonitas Medical Scheme',
  'CAMAF SA & Namibia',
  'Cape Medical Plan',
  'Compcare Wellness Medical Scheme',
  'Consumer Goods Medical Scheme (CGMS)',
  'Covision Life',
  'Crisis On Call',
  'Crisis Shield',
  'De Beers Benefit Society',
  'Dimaru Health',
  'Discovery Health Medical Scheme',
  'EMBF (Engen Benefit Medical Fund)',
  'Essential Employee Benefits',
  'Essential Med',
  'FMS - 1 Life',
  'FMS - Emerald Wealth Management',
  'Fedhealth Medical Scheme',
  'Fish-Med (Fishing Industry Medical Scheme)',
  'Flexicare',
  'Food Workers Medical Benefit Fund',
  'GEMS (Government Employees Medical Scheme)',
  'Genesis Medical Aid',
  'Get Savi Health',
  'Glencore Medical Aid Scheme',
  'Golden Arrow',
  'Health Squared Medical Scheme',
  'Hollard Fenominal Women',
  'Horizon Medical Scheme',
  'Impala Medical Plan',
  'Imperial Med (Imperial Group Medical Scheme)',
  'Infusion Financial Services',
  'KGA Life',
  'Kardiofit / Kardiopro',
  'Keyhealth',
  'LA Health',
  'Libcare Medical Scheme',
  'Liberty Medical Lifestyle Plus',
  'Lonmin Medical Scheme',
  'MBMED (Mercedes Benz Medical Scheme)',
  'Makoti',
  'Malcor',
  'Massmart Medical Scheme',
  'Medibond',
  'Medicall',
  'Medihelp Medical Scheme',
  'Medimed Medical Scheme',
  'Medipos',
  'Medpro',
  'Medshield Medical Scheme',
  'Metropolitan Medical Scheme',
  'Momentum Health',
  'Momentum Health4me',
  'Moto Health Medical Scheme',
  'Multichoice',
  'My Stroke',
  'NBCRFLI Sick Fund',
  'Nedlife',
  'Netcare Medical Aid Scheme',
  'New Apostolic Church',
  'New Law (State Facilities Only)',
  'Old Mutual Family Support Services',
  'Old Mutual Staff Medical Aid Fund',
  'One Plan Medical Insurance',
  'Opmed (Optimum Medical Scheme)',
  'PG Group Health',
  'Parmed Medical Aid',
  "Pick 'n Pay Medical Scheme",
  'Platinum Health',
  'Polmed Medical Scheme',
  'Profmed',
  'RUMED (Rhodes University Medical Scheme)',
  'Rand Water Medical Scheme',
  'Regular Force Medical Continuation Fund',
  'Remedi Medical Aid Scheme',
  'Retail Medical Scheme',
  'SABC Medical Aid Scheme',
  'SABMAS (South African Breweries Medical Aid)',
  'SASOLMED',
  'Samwumed',
  'Sedmed',
  'Sisonke Health Medical Scheme',
  'Sizwe-Hosmed Medical Fund',
  'Suremed Health (South Africa)',
  'The Foschini Group (TFG)',
  'Thebemed Medical Scheme',
  'Transmed Medical Fund',
  'Tsogo Sun Medical Scheme',
  'Umvuzo Health',
  'Unity Health',
  'University of KwaZulu Natal',
  'Wesmart',
  'Witbank Coalfields Medical Aid Scheme (WCMAS)',
  'Wooltru Medical Aid',
];

// ── Plan / option list per scheme (2026 product range) ─────────────────────
// Source: each scheme's published 2026 benefit brochure / launch material
// (Discovery, Bonitas, Bestmed, Medshield, Momentum, GEMS, Fedhealth,
//  Medihelp, Profmed, Bankmed, Keyhealth, LA Health, CAMAF, Polmed,
//  SASOLMED, Compcare, Genesis, Sizwe-Hosmed, Suremed, Cape Medical,
//  SAMWUMED, Umvuzo). Coverage is restricted to the larger open schemes
//  plus a few closed schemes with publicly listed options. Schemes not
//  present here fall back to the free-text Plan / Option input.
// Keys MUST match entries in MEDICAL_SCHEMES exactly.
const SCHEME_PLANS: Record<string, string[]> = {
  'Discovery Health Medical Scheme': [
    'Executive',
    'Classic Comprehensive',
    'Classic Smart Comprehensive',
    'Classic Priority',
    'Essential Priority',
    'Classic Saver',
    'Essential Saver',
    'Coastal Saver',
    'Classic Delta Saver',
    'Essential Delta Saver',
    'Classic Smart Saver',
    'Essential Smart Saver',
    'Classic Smart',
    'Essential Smart',
    'Dynamic Smart',
    'Active Smart',
    'Classic Core',
    'Essential Core',
    'Coastal Core',
    'Classic Delta Core',
    'Essential Delta Core',
    'KeyCare Plus',
    'KeyCare Start',
    'KeyCare Core',
  ],
  'Bonitas Medical Scheme': [
    'BonStart',
    'BonStart Plus',
    'Primary',
    'Standard',
    'Standard Select',
    'BonClassic',
    'BonComplete',
    'BonPrime',
    'BonComprehensive',
    'BonFit',
    'BonSave',
    'BonCore',
    'BonEssential',
    'BonEssential Select',
    'Hospital Standard',
    'BonCap',
  ],
  'Bestmed': [
    'Beat 1',
    'Beat 1 Network',
    'Beat 2',
    'Beat 2 Network',
    'Beat 3',
    'Beat 3 Network',
    'Beat 4',
    'Pace 1',
    'Pace 2',
    'Pace 3',
    'Pace 4',
    'Pulse 1',
    'Pulse 2',
    'Rhythm 1',
    'Rhythm 2',
  ],
  'Medshield Medical Scheme': [
    'PremiumPlus',
    'MediBonus',
    'MediPlus Prime',
    'MediPlus Compact',
    'MediSaver',
    'MediValue Prime',
    'MediValue Compact',
    'MediCore',
    'MediCurve',
    'Mediphila',
  ],
  'Momentum Health': [
    'Ingwe',
    'Evolve',
    'Incentive',
    'Extender',
    'Custom',
    'Summit',
  ],
  'GEMS (Government Employees Medical Scheme)': [
    'Tanzanite One',
    'Beryl',
    'Ruby',
    'Emerald Value',
    'Emerald',
    'Onyx',
  ],
  'Fedhealth Medical Scheme': [
    'flexiFED 1',
    'flexiFED 2',
    'flexiFED 3',
    'flexiFED 4',
    'flexiFED Savvy',
    'Maxima EXEC',
    'myFED',
  ],
  'Medihelp Medical Scheme': [
    'MedPrime',
    'MedPrime Elect',
    'MedPlus',
    'MedElite',
    'MedVital',
    'MedVital Elect',
    'MedSaver',
    'MedMove Student',
    'MedReach',
    'MedAdd',
    'MedAdd Elect',
  ],
  'Profmed': [
    'ProSelect',
    'ProSelect Savvy',
    'ProSecure',
    'ProSecure Savvy',
    'ProSecure Plus',
    'ProSecure Plus Savvy',
    'ProActive Plus',
    'ProActive Plus Savvy',
    'ProPinnacle',
    'ProPinnacle Savvy',
  ],
  'Bankmed Medical Aid': [
    'Essential',
    'Basic',
    'Core Saver',
    'Traditional',
    'Comprehensive',
    'Plus',
  ],
  'Keyhealth': [
    'Essence',
    'Origin',
    'Equilibrium',
    'Silver',
    'Gold',
    'Platinum',
  ],
  'LA Health': [
    'LA Comprehensive',
    'LA Core',
    'LA Engage',
    'LA Active',
    'LA Focus',
    'LA KeyPlus',
  ],
  'CAMAF SA & Namibia': [
    'Alliance Plus',
    'Alliance Network',
    'First Choice',
    'Vital',
    'Vital Network',
  ],
  'Polmed Medical Scheme': [
    'Marine',
    'Aquarium',
  ],
  'SASOLMED': [
    'Comprehensive Network',
    'Restricted Network',
  ],
  'Compcare Wellness Medical Scheme': [
    'Mumed',
    'Symmetry',
    'SelfNet',
    'Selfsure',
    'Dynamix',
    'Pinnacle',
  ],
  'Genesis Medical Aid': [
    'Private Choice',
    'Private',
    'Private Plus',
    'Private Comprehensive',
    'MED-100',
    'MED-200',
    'MED-200 Plus',
  ],
  'Sizwe-Hosmed Medical Fund': [
    'Essential Copper',
    'Access Saver',
    'Access Core',
    'Gold Ascend',
    'Gold Ascend EDO',
    'Value Platinum',
    'Value Platinum Core',
    'Titanium Executive',
  ],
  'Suremed Health (South Africa)': [
    'Challenger',
    'Navigator',
    'Shuttle',
    'Explorer',
  ],
  'Cape Medical Plan': [
    'MyHealth 200',
    'MyHealth 100',
    'MyHealth 100 Saver',
  ],
  'Samwumed': [
    'Option A',
    'Option B',
  ],
  'Umvuzo Health': [
    'Activator',
    'Ultra Affordable',
    'Ultra Affordable Value',
    'Standard',
    'Supreme',
    'Extreme',
  ],
  'Anglo Medical Scheme': [
    'Standard Care',
    'Managed Care',
    'Value Care',
  ],
  'Transmed Medical Fund': [
    'Prime',
    'Select',
  ],
  'Tsogo Sun Medical Scheme': [
    'Fundamental',
    'Standard',
    'De Luxe',
  ],
  'Massmart Medical Scheme': [
    'Network',
    'Essential',
  ],
  "Pick 'n Pay Medical Scheme": [
    'Plus',
    'Primary',
  ],
  'Sisonke Health Medical Scheme': [
    'Pride',
    'Heritage',
    'Diversity',
  ],
  'Wooltru Medical Aid': [
    'Network',
    'Saver',
    'Saver Choice',
    'Comprehensive',
  ],
  'Thebemed Medical Scheme': [
    'Universal',
    'Universal EDO',
    'Energy Core',
    'Energy Medium',
    'Energy Open',
  ],
  'Remedi Medical Aid Scheme': [
    'Standard',
    'Classic',
    'Comprehensive',
  ],
};

// ── Schemes that require a post-authorisation number ────────────────────────
// Per SAPAESA Medical Scheme Administration List (01 Jan 2026):
//   • Netcare 911-administered schemes (incl. their insurance clients)
//   • AZOZA-administered schemes (incl. their insurance clients)
//   • Polmed Medical Scheme
//   • Regular Force Medical Continuation Fund
// When the crew picks any of these in the Medical Scheme field, the form
// reveals an additional Post-Authorisation Number input.
const POSTAUTH_REQUIRED_SCHEMES = new Set<string>([
  // ── Netcare 911 ────────────────────────────────────────────
  'AECI',
  'Anglo Medical Scheme',
  'Bankmed Medical Aid',
  'Barlow World Medical Scheme',
  'Bestmed',
  'BPMAS (BP Medical Scheme)',
  'BEMAS (BMW Employees Medical Aid)',
  'BIBC / BCIMA Building & Construction Medical Aid',
  'CAMAF SA & Namibia',
  'Compcare Wellness Medical Scheme',
  'EMBF (Engen Benefit Medical Fund)',
  'Golden Arrow',
  'Health Squared Medical Scheme',
  'Keyhealth',
  'Libcare Medical Scheme',
  'MBMED (Mercedes Benz Medical Scheme)',
  'Medihelp Medical Scheme',
  'Medimed Medical Scheme',
  'Medshield Medical Scheme',
  'Momentum Health',
  'Netcare Medical Aid Scheme',
  'Opmed (Optimum Medical Scheme)',
  'Parmed Medical Aid',
  'PG Group Health',
  'Profmed',
  'SABC Medical Aid Scheme',
  'SABMAS (South African Breweries Medical Aid)',
  'Samwumed',
  'Sisonke Health Medical Scheme',
  'Sizwe-Hosmed Medical Fund',
  'Thebemed Medical Scheme',
  'Umvuzo Health',
  'Wooltru Medical Aid',
  'ADT Security',
  'Get Savi Health',
  'Momentum Health4me',
  // ── AZOZA ──────────────────────────────────────────────────
  'Alliance Midmed Medical Scheme',
  'Bonitas Medical Scheme',
  'Fedhealth Medical Scheme',
  'Glencore Medical Aid Scheme',
  'GEMS (Government Employees Medical Scheme)',
  'Imperial Med (Imperial Group Medical Scheme)',
  'Moto Health Medical Scheme',
  'Platinum Health',
  'Transmed Medical Fund',
  '21st Century Life',
  'Adcorp',
  'African Unity',
  'Covision Life',
  'Crisis On Call',
  'Crisis Shield',
  'Hollard Fenominal Women',
  'Infusion Financial Services',
  'KGA Life',
  'Liberty Medical Lifestyle Plus',
  'Nedlife',
  'New Apostolic Church',
  'Old Mutual Family Support Services',
  // ── Standalone schemes flagged by user ─────────────────────
  'Polmed Medical Scheme',
  'Regular Force Medical Continuation Fund',
]);

const TRANSFER_SUBTYPES = [
  'Return Trip',
  'Social Transfer',
  'Upgrade Transfer',
  'Downgrade Transfer',
  'Hospital to Hospital',
  'Hospital to Residence',
  'Hospital to Stepdown',
  'Residence to Hospital',
  'Psychiatric',
];

// ── Trip phases ────────────────────────────────────────────────────────────────
const PHASES = [
  { id: 'dispatch', label: 'Dispatch', short: 'DISP' },
  { id: 'enroute', label: 'En Route', short: 'MOB' },
  { id: 'scene', label: 'On Scene', short: 'PT INFO' },
  { id: 'clinical', label: 'Clinical', short: 'CLIN' },
  { id: 'transport', label: 'Transport', short: 'TRANS' },
  { id: 'handover', label: 'Handover', short: 'HNDVR' },
  { id: 'complete', label: 'Complete', short: 'DONE' },
];

// ── Timing rows (split across phases) ─────────────────────────────────────────
const ALL_TIME_ROWS = [
  { label: 'Dispatch Time', timeKey: 'time_dispatched', kmKey: 'km_dispatched', phase: 0 },
  // Mobile / En Route tracker was removed (replaced by an in-phase timer); its
  // time row and time_mobile/km_mobile fields are gone. Phase 1 (En Route) stays
  // in PHASES only to preserve the existing 0-based phase indices.
  { label: 'On Scene', timeKey: 'time_on_scene', kmKey: 'km_on_scene', phase: 2 },
  { label: 'Depart Scene', timeKey: 'time_depart_scene', kmKey: 'km_depart_scene', phase: 4 },
  { label: 'Arrival At Facility', timeKey: 'time_at_destination', kmKey: 'km_at_destination', phase: 5 },
  { label: 'Available', timeKey: 'time_available', kmKey: 'km_available', phase: 6 },
];

// When a timestamp is geo-captured, the resolved street address is auto-filled
// into the matching form field — but only if that field is currently empty, so
// crew-typed values are never overwritten. Crew reviews the address in the
// confirmation overlay before it's committed.
const GEO_TARGET_FIELD: Record<string, { addressKey: string; suburbKey?: string; label: string }> = {
  time_on_scene: { addressKey: 'incident_location', suburbKey: 'suburb_ward', label: 'Incident Address' },
  time_at_destination: { addressKey: 'receiving_facility', label: 'Destination Address' },
};

// ── Vitals fields ─────────────────────────────────────────────────────────────
const VS_QUICK = [
  { label: 'HR', key: 'hr', type: 'number', placeholder: 'bpm' },
  { label: 'BP', key: 'bp', placeholder: '120/80' },
  { label: 'SpO₂%', key: 'spo2', type: 'number', placeholder: '%' },
  { label: 'Resp. Rate /min', key: 'resp_rate', type: 'number', placeholder: '/min' },
  { label: 'Pain /10', key: 'pain', opts: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] },
  { label: 'GCS Eyes (4)', key: 'gcs_e', opts: ['1', '2', '3', '4'] },
  { label: 'GCS Voice (5)', key: 'gcs_v', opts: ['1', '2', '3', '4', '5'] },
  { label: 'GCS Motor (6)', key: 'gcs_m', opts: ['1', '2', '3', '4', '5', '6'] },
];

const VS_FULL = [
  ...VS_QUICK,
  { label: 'Rhythm', key: 'rhythm', opts: ['Regular', 'Irregular'] },
  { label: 'A/E', key: 'ae', placeholder: 'e.g. Bilat Equal and Clear' },
  { label: '% Oxygen', key: 'o2_percent', placeholder: 'e.g. R/A or 40%' },
  { label: 'ECG / Rhythm', key: 'ecg', opts: ['NSR', 'Sinus Tachy', 'Sinus Brady', 'AF', 'SVT', 'VT', 'VF', 'Paced', 'Asystole', 'PEA', 'Other'] },
  { label: 'Cap Refill (sec)', key: 'cap_refill', opts: ['< 2sec', '> 2sec'] },
  { label: 'Perfusion Colour', key: 'perfusion', opts: ['Well Perfused', 'Pale', 'Cyanosed', 'Mottled'] },
  { label: 'Pupil Size L', key: 'pupil_size_l', type: 'number', placeholder: 'e.g. 3' },
  { label: 'Pupil Size R', key: 'pupil_size_r', type: 'number', placeholder: 'e.g. 3' },
  { label: 'Pupil Reaction L/R', key: 'pupil_react', opts: ['Equal/Reactive', 'Unequal', 'Sluggish', 'Fixed/Dilated'] },
  { label: 'Neuro Deficit', key: 'neuro_def', opts: ['Yes', 'No'] },
  { label: 'HGT (mmol/L)', key: 'hgt', type: 'number', placeholder: 'mmol/L' },
  { label: 'Temp (°C)', key: 'temp', placeholder: '°C' },
  { label: 'Vent Mode', key: 'vent_mode', placeholder: 'e.g. SIMV, CPAP' },
  { label: 'ETCO₂', key: 'etco2', type: 'number', placeholder: 'mmHg' },
  { label: 'Tidal Vol', key: 'tidal_vol', type: 'number', placeholder: 'ml' },
  { label: 'Min Vol', key: 'min_vol', type: 'number', placeholder: 'L/min' },
  { label: 'Peep / CPAP', key: 'peep_cpap', type: 'number', placeholder: 'cmH₂O' },
  { label: 'Pacing mA/Rate', key: 'pacing', placeholder: 'e.g. 70mA @ 70bpm' },
];

// Single-select incident-type dropdown. The crew picks ONE primary mechanism
// here; situational modifiers (high-speed / passenger / restrained / etc.)
// move into the free-text mechanism_other field where they belong as
// narrative detail, since the scheme rule engine only branches on the
// primary mechanism category.
const MECHANISM_OPTS = [
  'MVA (Motor Vehicle Accident)',
  'MBA (Motorbike Accident)',
  'PVA (Pedestrian vehicle accident)',
  'Assault — Penetrating',
  'Assault — Blunt',
  'Fall',
  'Burns',
  'Drowning / Near-Drowning',
  'Sporting Injury',
  'Animal Attack',
  'Workplace / Industrial Accident',
  'Medical Emergency',
  'Obstetric Emergency',
  'Psychiatric Emergency',
  'Other',
];
const IMMOB_OPTS = ['Collar', 'Trac Splint', 'Head Blocks', 'Splint', 'Scoop/Spine Board', 'Dressing', 'Spider Harness', 'KED', 'Vacuum Mattress'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
// inferResumePhase (draft-resume phase mapping) lives in utils/prfResumePhase.ts
// so it can be unit-tested and never returns a hidden phase (En Route 1 /
// Clinical 3 / Complete 6). The old version here returned those.

// ── SA-ID derivation ─────────────────────────────────────────────────────────
// South African ID numbers are 13 digits with YYMMDD as the leading 6.
// Year disambiguation: if (2000+YY) is greater than the current year, the
// person was born in 1900+YY (no future births). Returns null if the ID is
// not yet 6+ digits or the date components don't form a valid calendar date.
function parseSaIdDob(id: string): Date | null {
  const digits = (id || '').replace(/\D/g, '');
  if (digits.length < 6) return null;
  const yy = parseInt(digits.slice(0, 2), 10);
  const mm = parseInt(digits.slice(2, 4), 10) - 1;
  const dd = parseInt(digits.slice(4, 6), 10);
  if (Number.isNaN(yy) || Number.isNaN(mm) || Number.isNaN(dd)) return null;
  if (mm < 0 || mm > 11 || dd < 1 || dd > 31) return null;
  const currentYear = new Date().getFullYear();
  const candidate2000 = 2000 + yy;
  const year = candidate2000 > currentYear ? 1900 + yy : candidate2000;
  const dob = new Date(year, mm, dd);
  if (dob.getFullYear() !== year || dob.getMonth() !== mm || dob.getDate() !== dd) return null;
  return dob;
}

function ageFromDob(dob: Date, ref: Date = new Date()): number {
  let age = ref.getFullYear() - dob.getFullYear();
  const m = ref.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < dob.getDate())) age -= 1;
  return Math.max(0, age);
}

// ── VitalsReminder — level-of-care-aware countdown to next vital screening ──
// Self-contained ticker: owns its own setInterval so the parent form does not
// re-render every second. On mobile, parent re-renders mid-keystroke dismiss
// the keyboard — same isolation pattern as <LiveTimer>. Renders a small
// fixed-position pill in the TOP-RIGHT corner (below the sticky journey
// header) with a solid colour fill — it used to sit translucent bottom-left
// where crews reported it hiding. Tap jumps straight to the vitals section
// in the Clinical phase. Footprint stays small so it doesn't occlude fields.
//
// Cadence by level of care: BLS → 20 min, ILS → 15 min, ALS → 10 min.
// Higher acuity = tighter monitoring window. 15 min is the default fallback
// for unset/legacy values.
function vitalsIntervalMs(level: string | null | undefined): number {
  const L = (level || '').toUpperCase();
  if (L === 'BLS') return 20 * 60 * 1000;
  if (L === 'ALS' || L === 'ICU') return 10 * 60 * 1000;
  return 15 * 60 * 1000; // ILS or unset
}
function VitalsReminder({ lastVitalAt, level, onClick }: { lastVitalAt: number | null; level: string | null | undefined; onClick: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!lastVitalAt) return;
    const id = setInterval(() => tick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [lastVitalAt]);
  if (!lastVitalAt || !level) return null;
  const intervalMs = vitalsIntervalMs(level);
  const remaining = intervalMs - (Date.now() - lastVitalAt);
  const overdue = remaining <= 0;
  const warn = !overdue && remaining <= 2 * 60 * 1000;
  // Solid fills (white text) so the pill reads at a glance instead of the old
  // translucent tint that blended into the page.
  const bg = overdue ? '#dc2626' : warn ? '#f59e0b' : '#3b6fde';
  const border = overdue ? '#b91c1c' : warn ? '#d97706' : '#2f5ac7';
  const mins = Math.max(0, Math.ceil(Math.abs(remaining) / 60000));
  // Label: just "Vitals" until the last 5 minutes, then a plain-language
  // countdown ("Vitals in 5 minutes" → "... 1 minute"), then overdue.
  const text = overdue
    ? `Vitals overdue +${mins}m`
    : mins <= 5
    ? `Vitals in ${mins} minute${mins === 1 ? '' : 's'}`
    : 'Vitals';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={overdue ? 'Vitals overdue — tap to record' : 'Next vitals due — tap to record'}
      style={{
        // Top-right, clear of the sticky journey header (expanded height ≈100px).
        position: 'fixed', top: 112, right: 14, zIndex: 100,
        background: bg, border: `1.5px solid ${border}`, color: '#ffffff',
        borderRadius: 999, padding: '8px 14px', fontSize: '0.72rem', fontWeight: 800,
        letterSpacing: '0.03em', cursor: 'pointer', boxShadow: `0 4px 16px ${bg}66`,
        display: 'flex', alignItems: 'center', gap: 6, maxWidth: 'calc(100vw - 90px)',
        whiteSpace: 'nowrap', fontFamily: 'inherit',
      }}
    >
      {overdue && <span style={{ fontSize: '0.95rem', lineHeight: 1 }}>⚠</span>}
      <span>{text}</span>
    </button>
  );
}

// ── KM odometer input — formats with spaces (1 200, 12 000) on blur ───────────
function KmInput({ kmKey, value, onChange, onCommit }: {
  kmKey: string;
  value: string;
  onChange: (kmKey: string, value: string) => void;
  // Fires when the user finishes editing (blur) — used by the parent to run
  // sanity checks (e.g. flag absurdly large odometer jumps for review). Kept
  // optional so unrelated callers can opt out.
  onCommit?: (kmKey: string, value: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const nf = useNoAutofill(kmKey);
  const fmt = (v: string) => {
    // Coerce defensively: loaded data may arrive as a number despite the string type.
    const str = String(v ?? '');
    if (!str) return '';
    const [whole, dec] = str.split('.');
    const formatted = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return dec !== undefined ? `${formatted}.${dec}` : formatted;
  };
  const s: React.CSSProperties = {
    width: '100%', padding: '10px 6px', fontSize: '0.82rem', color: '#0f172a',
    background: '#ffffff', border: '1.5px solid #e2e8f0', borderRadius: 10,
    outline: 'none', boxSizing: 'border-box', fontFamily: 'monospace',
    textAlign: 'center', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.03)',
  };
  return (
    <input
      id={`input-${kmKey}`}
      type="text"
      inputMode="decimal"
      pattern="[0-9. ]*"
      value={fmt(value)}
      placeholder=""
      {...nf}
      onChange={e => {
        let v = e.target.value.replace(/[^0-9.]/g, '');
        // Prevent multiple decimal points
        const parts = v.split('.');
        if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
        onChange(kmKey, v);
      }}
      onFocus={e => {
        setFocused(true);
        e.currentTarget.style.borderColor = '#3b6fde';
        e.currentTarget.style.boxShadow = '0 0 0 3px rgba(91,141,239,0.125), inset 0 1px 2px rgba(0,0,0,0.03)';
      }}
      onBlur={e => {
        setFocused(false);
        e.currentTarget.style.borderColor = '#e2e8f0';
        e.currentTarget.style.boxShadow = 'inset 0 1px 2px rgba(0,0,0,0.03)';
        if (onCommit) onCommit(kmKey, e.currentTarget.value.replace(/[^0-9.]/g, ''));
      }}
      style={s}
    />
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

// ── Shared UI Context & Primitives ──────────────────────────────────────────────────
// NOT exported on purpose: this is used only within this file. Exporting a
// non-component value from a module that also exports components disables React
// Fast Refresh, forcing a full page reload on every edit (and losing the crew's
// place in the form). Keep all non-component values in this file un-exported.
const FormContext = createContext<any>(null);

const base: React.CSSProperties = {
  width: '100%', padding: '13px 14px', fontSize: '0.93rem', color: '#0f172a',
  background: '#ffffff', border: `1.5px solid #e2e8f0`, borderRadius: 10,
  outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
  boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.03)',
};
const onF = (e: React.FocusEvent<any>) => { e.currentTarget.style.borderColor = '#5b8def'; e.currentTarget.style.boxShadow = `0 0 0 3px rgba(91,141,239,0.125), inset 0 1px 2px rgba(0,0,0,0.03)`; };
const onB = (e: React.FocusEvent<any>) => { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.boxShadow = 'inset 0 1px 2px rgba(0,0,0,0.03)'; };

const Lbl = ({ t, req }: { t: string; req?: boolean }) => (
  <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 7 }}>
    {t}{req && <span style={{ color: '#ef4444', marginLeft: 3 }}>*</span>}
  </div>
);

// Browser form-history / autofill suppression. PRF data is unique per patient,
// so the browser re-offering previously typed values (e.g. "23" on a KM field)
// is never useful and can mislead. `autocomplete="off"` alone is ignored by
// Chrome, so we also give the field a randomised `name` the browser can't match
// against any stored value. The Ward field is exempted (returns only the plain
// autocomplete attr) so its behaviour is left exactly as it was, per request.
// One random token per page load — appended to field names so the browser
// can't match them against values stored in a previous session.
const NF_NONCE = Math.random().toString(36).slice(2);
const NO_AUTOFILL = {
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
} as const;
function useNoAutofill(fk?: string): Record<string, any> {
  const nameRef = useRef(`nf-${fk || 'x'}-${NF_NONCE}`);
  if (fk === 'ward') return { autoComplete: 'off' };
  return { ...NO_AUTOFILL, name: nameRef.current };
}

// Placeholder hint text is suppressed across all input components for the
// live rollout — crew should see clean, empty fields rather than fine-print
// example text. The `ph` prop is kept on the type signature so the ~120
// callsites passing it continue to compile; we just ignore it. Re-enable
// hints by changing `placeholder=""` back to `placeholder={ph}` in Inp,
// ComboInp and Txt below.
const SpeechRecognitionAPI: any =
  (typeof window !== 'undefined' &&
    ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) || null;

// The OS speech service is a SINGLE shared resource: a browser throws if you
// start a second recognition while one is still active. Press-and-hold mics on
// adjacent fields could leave a prior recogniser finalising (onend fires late
// on mobile), so the next field's start() threw and its mic silently did
// nothing ("voice won't work on the fields lower down"). This module-level
// handle lets every mic force-stop any still-active recogniser before starting
// its own, so dictation always works no matter which field was used last.
// Un-exported so it never breaks Fast Refresh (see project crash-patterns note).
let activeRecognition: any = null;

// True while ANY field is actively dictating. The sticky journey-header
// collapse (isScrolled) must NOT reflow the layout while a mic is held — the
// mic button holds focus (not the textarea), so the "skip while an input is
// focused" guard is bypassed, the auto-growing field crosses the 40px scroll
// threshold, the header resizes, the page jumps, and that layout shift fires
// pointercancel which kills the recogniser. Suppressing header reflow during
// dictation fixes both the Resus/Samsung screen-jump AND the dropped voice.
let dictationActive = false;

// Dictating while the on-screen keyboard is open is what makes Samsung
// Internet "snap": the mic button preventDefaults its pointerdown, so
// whichever input the crew last tapped KEEPS focus, and Android re-scrolls
// that focused field into view on every transcript update — yanking the
// page away from the field actually being dictated into (crew on field B
// gets dragged back to still-focused field A, over and over). Closing the
// keyboard by blurring the focused input before recognition starts removes
// the scroll anchor, so the page stays put no matter whose mic is held.
const blurFocusedField = () => {
  const ae = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) {
    try { ae.blur(); } catch { /* ignore */ }
  }
};

// ── Robust incremental dictation builder ──────────────────────────────────
// Android engines (Chrome AND Samsung Internet, both backed by the system
// speech service) misbehave in `continuous` mode in ways a result-index
// high-water mark alone cannot absorb:
//   • a final segment may RE-CONTAIN everything said so far (cumulative
//     transcripts), so plain appending doubles every word;
//   • an interim update repeats words that were already finalised;
//   • the engine may silently restart its session mid-hold, resetting the
//     results list back to index 0.
// Every commit therefore goes through `mergeDictation`, which drops the
// longest overlap between the already-committed text and the incoming
// segment before appending — duplicates vanish regardless of which of the
// above shapes the engine emits.
type DictationState = { committed: string; finalCount: number };

const newDictationState = (baseline: string): DictationState => ({
  committed: (baseline || '').trim(),
  finalCount: 0,
});

// Append `next` to `base`, dropping whatever prefix of `next` already ends
// `base` (word-level comparison, case-insensitive). Handles exact repeats,
// cumulative re-emissions, and partial overlaps.
const mergeDictation = (base: string, next: string): string => {
  const b = base.replace(/\s+$/, '');
  const n = next.trim().replace(/\s+/g, ' ');
  if (!n) return b;
  if (!b) return n;
  const bl = b.toLowerCase();
  const nl = n.toLowerCase();
  // Cumulative re-emission: the new segment starts with everything so far.
  if (nl === bl) return b;
  if (nl.startsWith(bl + ' ')) return b + n.slice(b.length);
  // Longest word-suffix of `base` that matches a word-prefix of `next`.
  const bWords = bl.split(/\s+/);
  const nWordsL = nl.split(/\s+/);
  const nWords = n.split(/\s+/);
  let overlap = 0;
  for (let k = Math.min(bWords.length, nWordsL.length); k > 0; k--) {
    if (bWords.slice(-k).join(' ') === nWordsL.slice(0, k).join(' ')) { overlap = k; break; }
  }
  const addition = nWords.slice(overlap).join(' ');
  return addition ? b + ' ' + addition : b;
};

// ── Context-aware homophone corrections ───────────────────────────────────
// The OS speech engine "smart-formats" ambiguous words as digits, so spoken
// "patient ate at 5" arrives as "patient 8 at 5". Nothing in the Web Speech
// API lets us bias its vocabulary, so we repair the transcript instead.
// Every rule is CONTEXT-GATED so genuine clinical numbers are never touched
// ("GCS 8 at scene", "gave 2 puffs", "4 mg morphine" all stay as digits):
// a digit is only rewritten when the words around it make the homophone the
// only sensible reading. Rules run on the OUTPUT string only — the raw
// committed transcript is preserved so overlap-dedup keeps matching the
// engine's cumulative re-emissions. Extend the lists as crews report more.
const DICTATION_FIXES: Array<[RegExp, string]> = [
  // "8" → "ate": an eater before it AND a meal/time word after it.
  [/\b(patient|pt|he|she|they|the patient|resident|child|baby|mom|mother|father|wife|husband|family says he|family says she)\s+8\s+(at|around|about|approximately|breakfast|lunch|dinner|supper|earlier|last|this|nothing|some|food|porridge|pap)\b/gi, '$1 ate $2'],
  // "last ate at/around ..." — gated so "last 8 hours" is left alone.
  [/\blast\s+8\s+(at|around|about|approximately|this|yesterday|earlier)\b/gi, 'last ate $1'],
  // "2" → "to" before articles / pronouns ("handed 2 the nurse").
  [/\b2\s+(the|him|her|them|a|an)\b/gi, 'to $1'],
  // "4" → "for" before articles ("treated 4 the pain").
  [/\b4\s+(the|a|an)\b/gi, 'for $1'],
];
// Meal-history fields get one extra, more assertive rule: a phrase STARTING
// with "8 at/around <time>" can only mean "ate ..." there ("ate at 5"). Not
// applied globally — in clinical fields a leading 8 is usually a real vital.
const MEAL_FIELDS = /^(last_meal|events_hpi|past_medical_history|findings_on_arrival)$/;
const MEAL_FIELD_FIXES: Array<[RegExp, string]> = [
  [/(^|[.,]\s*)8\s+(at|around|about|approximately|this|last|nothing)\b/gi, '$1ate $2'],
];
const correctDictation = (text: string, fk?: string): string => {
  let out = text;
  for (const [re, sub] of DICTATION_FIXES) out = out.replace(re, sub);
  if (fk && MEAL_FIELDS.test(fk)) {
    for (const [re, sub] of MEAL_FIELD_FIXES) out = out.replace(re, sub);
  }
  return out;
};

// With maxAlternatives raised, each final result carries up to 5 candidate
// transcripts (confidence-ordered; [0] is the engine's pick). When our
// correction rules flag the top pick as suspicious ("patient 8 at 5"), scan
// the engine's OWN alternatives for one that already matches the corrected
// reading ("patient ate at 5") and use it verbatim — the engine's natural
// phrasing beats a regex splice. If no alternative agrees, keep the top pick;
// the output-side corrections still apply. Never deviates from the top pick
// when nothing looks wrong, so ordinary dictation is untouched.
const pickTranscript = (res: any, fk?: string): string => {
  const top: string = res[0]?.transcript ?? '';
  const n: number = Math.min(res.length ?? 1, 5);
  if (n <= 1) return top;
  const corrected = correctDictation(top, fk);
  if (corrected === top) return top;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const wanted = norm(corrected);
  for (let i = 1; i < n; i++) {
    const alt: string = res[i]?.transcript ?? '';
    if (alt && norm(alt) === wanted) return alt;
  }
  return top;
};

const applyDictation = (e: any, st: DictationState, fk?: string): string => {
  // Session restarted internally (results list shrank) — realign the
  // high-water mark so the new session's finals still commit.
  if (e.results.length < st.finalCount) st.finalCount = 0;
  let interim = '';
  for (let i = 0; i < e.results.length; i++) {
    const res = e.results[i];
    if (res.isFinal) {
      // Commit each final index only once, deduped via overlap-merge. Finals
      // go through the alternatives picker (homophone-aware); interims stay
      // on the engine's top pick for speed.
      if (i >= st.finalCount) {
        st.finalCount = i + 1;
        st.committed = mergeDictation(st.committed, pickTranscript(res, fk));
      }
    } else {
      interim += ' ' + (res[0]?.transcript ?? '');
    }
  }
  // Interim words layer on transiently (never persisted into `committed`),
  // deduped against the committed text the same way. Homophone corrections
  // apply to the returned string only — `committed` stays raw so dedup
  // still matches the engine's re-emissions verbatim.
  return correctDictation(mergeDictation(st.committed, interim), fk);
};

// ── Global "fields expand downwards" rule ─────────────────────────────────
// Text fields render as auto-growing textareas so long values (typed or
// dictated) wrap and push the field taller instead of scrolling out of view.
// Mirrors the proven VoiceTxt pattern: height tracks scrollHeight with the
// initial height as the floor, and the mic button stays anchored to the TOP
// of the field so growth never moves it mid-press (moving/re-centring the
// button during dictation is what broke hold-to-talk on mobile previously).
const useAutoGrow = (value: string) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const minHRef = useRef<number>(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!minHRef.current) minHRef.current = el.offsetHeight;
    el.style.height = 'auto';
    el.style.height = Math.max(el.scrollHeight, minHRef.current) + 'px';
  }, [value]);
  return ref;
};

// Single-line-semantics fields swallow Enter so wrapped display never puts
// literal newlines into form data (matching the old <input> behaviour).
const blockEnter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') e.preventDefault(); };

// Auto-growing replacement for raw single-line <input type="text"> fields
// (e.g. the Declaration-of-Death signatory names). Standard textarea props
// pass straight through.
const GrowTa = ({ value, style, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) => {
  const ref = useAutoGrow(value);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onKeyDown={blockEnter}
      style={{ resize: 'none', overflow: 'hidden', fontFamily: 'inherit', ...style }}
      {...rest}
    />
  );
};

const Inp = ({ fk, type = 'text', onBlur, noMic }: { fk: string; ph?: string; type?: string; req?: boolean; noMic?: boolean; onBlur?: (e: React.FocusEvent<any>) => void }) => {
  const { fd, sf } = useContext(FormContext);
  // PRF data is unique per patient, so browser form-history suggestions (e.g.
  // re-offering the last value you typed) are never useful and are turned off.
  // The Ward field is deliberately left untouched per request.
  const nf = useNoAutofill(fk);

  // â”€â”€ Voice dictation for text fields â”€â”€
  // Exclude: number, tel, date, time, email types + ID/passport/phone field keys
  const excludedTypes = ['number', 'tel', 'date', 'time', 'email'];
  // Voice dictation is unreliable/unwanted for identity + code fields, so the
  // mic is hidden for names, surnames, practitioner numbers, IDs, passports,
  // relationship, etc. (applies app-wide).
  const excludedKeyPatterns = /(id_number|passport|phone|_id$|_dob$|dependant_code|med_aid_number|postal_code|suburb|surname|_name$|hpcsa|relationship|identified_by)/i;
  const showMic = !noMic && !!SpeechRecognitionAPI && !excludedTypes.includes(type) && !excludedKeyPatterns.test(fk);

  const [recording, setRecording] = useState(false);
  const recogRef = useRef<any>(null);
  const heldRef = useRef(false);   // true while the mic button is physically held
  const fdRef = useRef(fd);
  fdRef.current = fd;
  const dictRef = useRef<DictationState>(newDictationState(''));

  // Only plain text fields grow; date/time/number/tel/email keep native inputs.
  const growable = type === 'text';
  const taRef = useAutoGrow(growable ? (fd[fk] ?? '') : '');

  useEffect(() => () => {
    heldRef.current = false;
    dictationActive = false;
    try { recogRef.current?.stop?.(); } catch { /* ignore */ }
    recogRef.current = null;
  }, []);

  const startVoice = () => {
    if (!SpeechRecognitionAPI || recording) return;
    heldRef.current = true;
    dictationActive = true;
    // Close the keyboard first (dictationActive is already set, so the
    // keyboard-close scroll never reflows the sticky header mid-hold).
    blurFocusedField();
    // Free the shared speech service if another field's recogniser is still
    // active/finalising, so this start() never throws and silently no-ops.
    try { activeRecognition?.stop?.(); } catch { /* ignore */ }
    dictRef.current = newDictationState(fdRef.current[fk] || '');
    // Spawn a recogniser. Samsung Internet / Android Chrome fire `onend` on the
    // first pause even with continuous=true, which used to kill dictation
    // mid-hold. While the button is still held we RE-SPAWN so the mic keeps
    // listening until the crew releases — re-baselining from the field so the
    // committed text carries across sessions.
    let busyRetries = 0;
    const spawn = () => {
      const recog = new SpeechRecognitionAPI();
      recog.lang = 'en-ZA';
      recog.continuous = true;
      recog.interimResults = true;
      // Ask the engine for its runner-up transcripts too — pickTranscript uses
      // them to resolve homophones ("8" vs "ate") with the engine's own words.
      recog.maxAlternatives = 5;
      recog.onresult = (e: any) => {
        // Ignore stragglers from a session we've already replaced (iOS can fire
        // a late result from a stopped recogniser) — only the current session
        // writes to the field, so a superseded one can't corrupt the text.
        if (recogRef.current !== recog) return;
        sf(fk, applyDictation(e, dictRef.current, fk));
      };
      recog.onend = () => {
        if (heldRef.current) {
          // Respawn to keep listening — iOS Safari (and Samsung) ignore
          // `continuous` and end the session after every pause. Do NOT
          // re-baseline from the field here: dictRef.current.committed is the
          // authoritative running transcript for this hold, and re-reading
          // fd[fk] races React's async state flush — the just-spoken word may
          // not be in fd yet, so baselining off it dropped that word (the iOS
          // "talk, come back, talk again — it deletes a word" bug).
          // applyDictation already re-aligns its finalCount when the fresh
          // session's results list restarts at index 0, so the committed text
          // simply continues to accumulate across sessions.
          startWithRetry();
          return;
        }
        setRecording(false); recogRef.current = null;
        dictationActive = false;
        if (activeRecognition === recog) activeRecognition = null;
      };
      recog.onerror = (ev: any) => {
        // Permission / service errors are fatal — stop for good. Transient
        // errors (no-speech, network) fall through to onend, which respawns
        // while the button is still held.
        if (ev?.error === 'not-allowed' || ev?.error === 'service-not-allowed') {
          heldRef.current = false;
        }
      };
      recogRef.current = recog;
      activeRecognition = recog;
      recog.start();          // throws InvalidStateError if the engine is busy
      busyRetries = 0;        // started cleanly — reset the backoff
    };
    // Samsung's single OS speech engine releases asynchronously, so a start()
    // that lands while a previous recogniser is still tearing down throws.
    // Retry with a short backoff (rather than silently dying) for as long as
    // the button is held — this is what makes switching between adjacent
    // fields' mics reliable and keeps dictation alive across Samsung's
    // premature onend restarts.
    const startWithRetry = () => {
      if (!heldRef.current) return;
      try {
        spawn();
      } catch {
        if (heldRef.current && busyRetries++ < 10) {
          window.setTimeout(startWithRetry, 130);
        } else {
          setRecording(false);
          recogRef.current = null;
          heldRef.current = false;
          dictationActive = false;
          if (activeRecognition === recogRef.current) activeRecognition = null;
        }
      }
    };
    startWithRetry();
    setRecording(true);
  };

  const stopVoice = () => {
    heldRef.current = false;   // release BEFORE stop so onend doesn't respawn
    dictationActive = false;
    try { recogRef.current?.stop?.(); } catch { /* ignore */ }
    setRecording(false);
  };

  if (!showMic) {
    if (!growable) {
      return <input id={`prf-field-${fk}`} type={type} value={fd[fk] ?? ''} onChange={e => sf(fk, e.target.value)} onFocus={onF} onBlur={e => { onB(e); if (onBlur) onBlur(e); }} placeholder="" {...nf} style={{ ...base, marginBottom: 14, borderColor: '#e2e8f0' }} />;
    }
    return <textarea id={`prf-field-${fk}`} ref={taRef} rows={1} value={fd[fk] ?? ''} onChange={e => sf(fk, e.target.value)} onKeyDown={blockEnter} onFocus={onF} onBlur={e => { onB(e); if (onBlur) onBlur(e); }} placeholder="" {...nf} style={{ ...base, marginBottom: 14, borderColor: '#e2e8f0', resize: 'none', overflow: 'hidden' }} />;
  }

  return (
    <div style={{ position: 'relative', marginBottom: 14 }}>
      <textarea
        id={`prf-field-${fk}`}
        ref={taRef}
        rows={1}
        value={fd[fk] ?? ''}
        onChange={e => sf(fk, e.target.value)}
        onKeyDown={blockEnter}
        onFocus={onF}
        onBlur={e => { onB(e); if (onBlur) onBlur(e); }}
        placeholder=""
        {...nf}
        style={{ ...base, marginBottom: 0, borderColor: '#e2e8f0', paddingRight: 54, resize: 'none', overflow: 'hidden' }}
      />
      <button
        type="button"
        onPointerDown={e => {
          e.preventDefault();
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
          startVoice();
        }}
        onPointerUp={e => { e.preventDefault(); stopVoice(); }}
        onPointerCancel={() => stopVoice()}
        onLostPointerCapture={() => { if (recording) stopVoice(); }}
        onContextMenu={e => e.preventDefault()}
        aria-label={recording ? 'Recording â€” release to stop' : 'Hold to dictate'}
        title={recording ? 'Release to stop' : 'Hold to dictate'}
        style={{
          // Top-anchored (NOT vertically centred): the field grows downward as
          // dictation fills it, and a centred button would drift out from
          // under the crew's held finger and cancel the recording.
          position: 'absolute',
          top: 4, right: 6,
          width: 40, height: 40, borderRadius: 10,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: `2.5px solid \$\{recording \? '#991b1b' : '#1e3a8a'\}`,
          background: recording ? '#ef4444' : '#3b82f6',
          color: '#ffffff',
          cursor: 'pointer',
          boxShadow: recording ? '0 0 0 4px rgba(239,68,68,0.4)' : '0 6px 12px rgba(0,0,0,0.3)',
          animation: recording ? 'voicePulse 1.4s ease-in-out infinite' : 'none',
          transition: 'all 0.15s',
          touchAction: 'none',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="22" />
        </svg>
      </button>
    </div>
  );
};

// ── Address autocomplete (forward-search via Nominatim) ─────────────────────
// As the crew types a street, query OpenStreetMap Nominatim for matching SA
// addresses and show a dropdown. Selecting a suggestion writes the canonical
// formatted address back into the field — so "chatsmed" becomes
// "Chatsmed Candlewood Hospital, Mobeni, Durban". An optional `suburbKey`
// auto-fills a sibling suburb field on selection (only when that field is
// empty, so we never clobber what the crew already typed).
//
// Uses the same Nominatim service as the Mark-Time reverse-geocode, free with
// no API key. Their usage policy asks for ≤1 req/sec — satisfied by debouncing
// input by 400ms and aborting in-flight requests when the crew keeps typing.
type AddrSuggestion = {
  formatted: string;
  display: string;
  suburb: string | null;
  postcode: string | null;
};

// Builds a complete, comma-separated South African street address from a
// Nominatim `address` object (returned by both /reverse and /search). Used
// for both the Mark-Time GPS auto-fill and the type-to-search autocomplete
// dropdown, so what the crew sees as a suggestion is exactly what gets
// written to the form field.
//
// Order: street (house# + road, or a named place like a hospital), then
// suburb, town/city, district (eThekwini etc.), province, and postcode.
// Country is omitted — this app is SA-only and ", South Africa" on every
// row would be noise. Empty segments are skipped so we never produce
// double commas. If Nominatim returned nothing useful, we fall back to
// trimming display_name so the field is at least populated.
const buildFullAddress = (addrObj: any, displayName?: string): string => {
  const a = addrObj || {};
  const parts: string[] = [];

  // 1. Street-level line — house number + road, or the named place
  //    (amenity / building / shop). Hospitals and clinics show up as
  //    amenities and read better as "Chatsmed Candlewood Hospital" than
  //    as the parking-lot road name they're keyed off.
  if (a.house_number && a.road) parts.push(`${a.house_number} ${a.road}`);
  else if (a.road) parts.push(a.road);
  else if (a.pedestrian) parts.push(a.pedestrian);
  else if (a.amenity) parts.push(a.amenity);
  else if (a.building) parts.push(a.building);
  else if (a.shop) parts.push(a.shop);

  // 2. Suburb / neighbourhood
  if (a.suburb) parts.push(a.suburb);
  else if (a.neighbourhood) parts.push(a.neighbourhood);
  else if (a.city_district) parts.push(a.city_district);
  else if (a.quarter) parts.push(a.quarter);
  else if (a.hamlet) parts.push(a.hamlet);

  // 3. City / town / village
  const cityLevel = a.city || a.town || a.village || a.municipality;
  if (cityLevel) parts.push(cityLevel);

  // 4. Metro / district (eThekwini, City of Cape Town, etc.) — only
  //    when it's not the same as the city we already pushed.
  if (a.county && a.county !== cityLevel) parts.push(a.county);

  // 5. Province (state in Nominatim's vocabulary — KwaZulu-Natal,
  //    Gauteng, Western Cape, etc.)
  if (a.state) parts.push(a.state);

  // 6. Postcode
  if (a.postcode) parts.push(a.postcode);

  if (parts.length > 0) return parts.join(', ');
  // Fallback: trim the full display_name so we never return empty.
  return (displayName || '').split(',').slice(0, 6).map(s => s.trim()).filter(Boolean).join(', ');
};

const formatNominatimSuggestion = (item: any): AddrSuggestion => {
  const a = item.address || {};
  const formatted = buildFullAddress(a, item.display_name);
  return {
    formatted: formatted || (item.display_name || ''),
    display: item.display_name || formatted,
    suburb: a.suburb || a.neighbourhood || a.city_district || null,
    postcode: a.postcode || null,
  };
};

type ResolvedAddress = {
  street: string;
  suburb: string | null;
  postcode: string | null;
  raw: any;
};

// Not exported — used only in this file. See the FormContext note above: any
// non-component runtime export here breaks Fast Refresh for the whole module.
const reverseGeocode = async (
  lat: number, lng: number, signal: AbortSignal,
): Promise<ResolvedAddress | null> => {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lng}&email=system@jemsmedical.co.za`;
  const res = await fetch(url, { 
    signal, 
    headers: { 
      'Accept': 'application/json',
      'Accept-Language': 'en-ZA,en-US;q=0.9,en;q=0.8'
    } 
  });
  if (!res.ok) throw new Error(`geocoder ${res.status}`);
  const data = await res.json();
  if (!data || !data.address) return null;
  const a = data.address;
  const street = buildFullAddress(a, data.display_name);
  return {
    street: street || (data.display_name || ''),
    suburb: a.suburb || a.neighbourhood || a.city_district || null,
    postcode: a.postcode || null,
    raw: data,
  };
};

// ── SA Hospital database ────────────────────────────────────────────────────
const SA_HOSPITALS: { province: string; hospitals: { name: string; wards: string[] }[] }[] = [
  {
    province: 'Gauteng',
    hospitals: [
      { name: 'Netcare Akasia Hospital', wards: ['Emergency', 'ICU', 'Maternity', 'General Ward', 'Theatre', 'Casualty'] },
      { name: 'Netcare Alberton Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Paediatrics', 'Theatre'] },
      { name: 'Netcare Constantia Clinic', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Netcare Femina Hospital', wards: ['Emergency', 'Maternity', 'NICU', 'General Ward', 'Theatre'] },
      { name: 'Netcare Garden City Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Paediatrics', 'Theatre'] },
      { name: 'Netcare Jakaranda Hospital', wards: ['Emergency', 'ICU', 'Maternity', 'NICU', 'General Ward', 'Theatre'] },
      { name: 'Netcare Krugersdorp Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Netcare Lakeview Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Netcare Linksfield Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Theatre', 'Orthopaedics'] },
      { name: 'Netcare Milpark Hospital', wards: ['Emergency', 'ICU', 'CCU', 'Trauma', 'General Ward', 'Theatre', 'Neurosurgery'] },
      { name: 'Netcare Montana Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Netcare Moot Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Netcare Mulbarton Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Netcare Olivedale Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Paediatrics', 'Theatre'] },
      { name: 'Netcare Park Lane Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Oncology', 'Theatre'] },
      { name: 'Netcare Pinehaven Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Netcare Pretoria East Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre', 'Oncology'] },
      { name: 'Netcare Rehabilitation Hospital', wards: ['Rehabilitation', 'Neurological Rehab', 'Orthopaedic Rehab', 'General Ward'] },
      { name: 'Netcare Rosebank Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre', 'Oncology'] },
      { name: 'Netcare Sunninghill Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Netcare Sunward Park Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Netcare Unitas Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre', 'Paediatrics'] },
      { name: 'Netcare Waterfall City Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre', 'Paediatrics', 'Oncology'] },
      { name: 'Life Bedford Gardens Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Life Brenthurst Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Oncology', 'Theatre'] },
      { name: 'Life Carstenhof Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Life Eugene Marais Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Life Faerie Glen Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Life Flora Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Life Fourways Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Paediatrics', 'Theatre'] },
      { name: 'Life Groenkloof Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Life Roseacres Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Life Springs Parkland Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Life Wilgeheuwel Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Paediatrics', 'Theatre'] },
      { name: 'Life Wilgers Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre', 'Oncology'] },
      { name: 'Mediclinic Heart Hospital', wards: ['Emergency', 'ICU', 'CCU', 'Cardiac ICU', 'Cardiology', 'Theatre', 'General Ward'] },
      { name: 'Mediclinic Kloof', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Mediclinic Medforum', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Mediclinic Midstream', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Mediclinic Morningside', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre', 'Oncology'] },
      { name: 'Mediclinic Sandton', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre', 'Paediatrics'] },
      { name: 'Mediclinic Vereeniging', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Busamed Modderfontein Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Ahmed Kathrada Private Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Lenmed Randfontein Private Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
    ],
  },
  {
    province: 'KwaZulu-Natal',
    hospitals: [
      { name: 'Netcare Alberlito Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Netcare Kingsway Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Netcare Margate Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Netcare Parklands Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: "Netcare St Augustine's Hospital", wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre', 'Neurosurgery'] },
      { name: "Netcare St Anne's Hospital", wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Netcare The Bay Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Netcare Umhlanga Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre', 'Oncology'] },
      { name: 'Life Chatsmed Garden Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Life Empangeni Private Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Life Entabeni Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre', 'Oncology'] },
      { name: 'Life Hilton Private Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Life Mount Edgecombe Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Life The Crompton Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Life Westville Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre', 'Paediatrics'] },
      { name: 'Busamed Gateway Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Busamed Hillcrest Private Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Ethekwini Hospital & Heart Centre', wards: ['Emergency', 'ICU', 'CCU', 'Cardiac ICU', 'Cardiology', 'General Ward', 'Theatre'] },
      { name: 'Mediclinic Newcastle', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Mediclinic Pietermaritzburg', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Mediclinic Victoria', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'City Hospital Durban', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Lenmed Durdoc Centre', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
    ],
  },
  {
    province: 'Western Cape',
    hospitals: [
      { name: 'Netcare Blaauwberg Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Netcare Christiaan Barnard Memorial Hospital', wards: ['Emergency', 'ICU', 'CCU', 'Cardiac ICU', 'Cardiology', 'General Ward', 'Theatre'] },
      { name: 'Netcare Kuilsriver Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Netcare N1 City Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Netcare UCT Private Academic Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Theatre', 'Oncology', 'Neurology'] },
      { name: 'Life Bay View Private Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Life Kingsbury Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre', 'Oncology'] },
      { name: 'Life Knysna Private Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Life Paarl Valley Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Life Vincent Pallotti Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre', 'Oncology'] },
      { name: 'Life West Coast Private Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Mediclinic Cape Gate', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Mediclinic Cape Town', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre', 'Oncology'] },
      { name: 'Mediclinic Constantiaberg', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre', 'Oncology'] },
      { name: 'Mediclinic Durbanville', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Mediclinic George', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Mediclinic Hermanus', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Mediclinic Louis Leipoldt', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Mediclinic Milnerton', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Mediclinic Panorama', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre', 'Paediatrics'] },
      { name: 'Mediclinic Paarl', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Mediclinic Stellenbosch', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Mediclinic Vergelegen', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Mediclinic Worcester', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Melomed Bellville', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Melomed Claremont', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Melomed Gatesville', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: "Melomed Mitchell's Plain", wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Melomed Tokai', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
    ],
  },
  {
    province: 'Eastern Cape',
    hospitals: [
      { name: 'Netcare Greenacres Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Netcare Cuyler Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Life Beacon Bay Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Life East London Private Hospital', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Life Mercantile Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Life Queenstown Private Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: "Life St Dominic's Hospital", wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: "Life St George's Hospital", wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre', 'Oncology'] },
      { name: 'Life Hunterscraig Private Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Disa Clinic', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
    ],
  },
  {
    province: 'Limpopo',
    hospitals: [
      { name: 'Netcare Pholoso Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Mediclinic Polokwane', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Mediclinic Tzaneen', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Busamed Bela Bela Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
    ],
  },
  {
    province: 'Mpumalanga',
    hospitals: [
      { name: 'Mediclinic Nelspruit', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Mediclinic Trichardt', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Life The Glynnwood', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Rob Ferreira Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
    ],
  },
  {
    province: 'Free State',
    hospitals: [
      { name: 'Netcare Vaalpark Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Netcare Kroon Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Mediclinic Bloemfontein', wards: ['Emergency', 'ICU', 'CCU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Mediclinic Welkom', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Life Pasteur Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
    ],
  },
  {
    province: 'Northern Cape',
    hospitals: [
      { name: 'Mediclinic Kimberley', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Mediclinic Upington', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Lenmed Kathu Private Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
    ],
  },
  {
    province: 'North West',
    hospitals: [
      { name: 'Netcare Ferncrest Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Mediclinic Klerksdorp', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Mediclinic Potchefstroom', wards: ['Emergency', 'ICU', 'General Ward', 'Maternity', 'Theatre'] },
      { name: 'Life Wilmed Park Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
      { name: 'Busamed Harrismith Private Hospital', wards: ['Emergency', 'ICU', 'General Ward', 'Theatre'] },
    ],
  },
];

// Common ward options shown for any hospital (fallback if no specific wards listed)
const COMMON_WARDS = [
  'Emergency', 'ICU', 'CCU', 'CICU (Cardiac ICU)', 'NICU', 'High Care',
  'General Ward', 'Maternity', 'Paediatrics', 'Theatre', 'Casualty',
  'Orthopaedics', 'Oncology', 'Neurology', 'Neurosurgery', 'Psychiatry',
  'Renal / Dialysis', 'Burns Unit', 'Rehabilitation',
];

// ── HospitalPicker ──────────────────────────────────────────────────────────
// Inline autocomplete: type to see up to 3 matching hospitals, pick one,
// then choose the ward from a compact list below the input.
const HospitalPicker = ({ wardKey }: { wardKey?: string }) => {
  const { fd, sf } = useContext(FormContext);
  const fk = 'receiving_facility';
  const val: string = fd[fk] ?? '';
  const [showDropdown, setShowDropdown] = useState(false);
  const [showWards, setShowWards] = useState(false);
  const [selectedHospital, setSelectedHospital] = useState<{ name: string; wards: string[] } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Flat list filtered to top 3 matches
  const allHospitals = SA_HOSPITALS.flatMap(p => p.hospitals);
  const suggestions = val.trim().length >= 1
    ? allHospitals.filter(h => h.name.toLowerCase().includes(val.toLowerCase())).slice(0, 3)
    : [];

  const handleInputChange = (v: string) => {
    sf(fk, v);
    setShowDropdown(true);
    setShowWards(false);
    setSelectedHospital(null);
  };

  const handlePick = (h: { name: string; wards: string[] }) => {
    sf(fk, h.name);
    setSelectedHospital(h);
    setShowDropdown(false);
    setShowWards(true);
  };

  const handleSelectWard = (w: string) => {
    if (wardKey) sf(wardKey, w);
    setShowWards(false);
  };

  const wardOptions = selectedHospital?.wards?.length ? selectedHospital.wards : COMMON_WARDS;

  return (
    <div ref={wrapRef} style={{ position: 'relative', marginBottom: 14 }}>
      {/* Text input */}
      <input
        type="text"
        value={val}
        onChange={e => handleInputChange(e.target.value)}
        onFocus={() => { if (val.trim().length >= 1) setShowDropdown(true); }}
        placeholder=""
        autoComplete="off"
        style={{ ...base, marginBottom: 0, borderColor: showDropdown && suggestions.length > 0 ? G : '#e2e8f0' }}
      />

      {/* 3-suggestion dropdown */}
      {showDropdown && suggestions.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
          marginTop: 3, background: W,
          border: `1.5px solid ${G}`,
          borderRadius: 10,
          boxShadow: '0 8px 24px rgba(91,141,239,0.13)',
          overflow: 'hidden',
        }}>
          {suggestions.map((h, idx) => (
            <button
              key={h.name}
              type="button"
              onMouseDown={e => { e.preventDefault(); handlePick(h); }}
              style={{
                width: '100%', padding: '11px 14px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: W, border: 'none',
                borderBottom: idx < suggestions.length - 1 ? `1px solid ${S200}` : 'none',
                cursor: 'pointer', textAlign: 'left',
              }}
              onMouseOver={e => { e.currentTarget.style.background = S100; }}
              onMouseOut={e => { e.currentTarget.style.background = W; }}
            >
              <div>
                <div style={{ fontWeight: 700, fontSize: '0.88rem', color: S900 }}>{h.name}</div>
                <div style={{ fontSize: '0.7rem', color: S400, marginTop: 2 }}>
                  {SA_HOSPITALS.find(p => p.hospitals.some(ph => ph.name === h.name))?.province ?? ''}
                </div>
              </div>
              <span style={{ color: G, fontSize: '0.8rem', fontWeight: 700 }}>›</span>
            </button>
          ))}
        </div>
      )}

      {/* Ward picker — shown after a hospital is selected */}
      {showWards && selectedHospital && (
        <div style={{
          marginTop: 8, border: `1.5px solid ${S200}`,
          borderRadius: 10, overflow: 'hidden',
          boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
        }}>
          <div style={{
            padding: '7px 12px', fontSize: '0.62rem', fontWeight: 800,
            color: S600, textTransform: 'uppercase', letterSpacing: '0.09em',
            background: S100, borderBottom: `1px solid ${S200}`,
          }}>
            📋 Select Ward / Unit
          </div>
          {wardOptions.map((w, idx) => (
            <button
              key={w}
              type="button"
              onClick={() => handleSelectWard(w)}
              style={{
                width: '100%', padding: '10px 14px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: fd[wardKey ?? 'ward'] === w ? 'rgba(91,141,239,0.06)' : W,
                border: 'none',
                borderBottom: idx < wardOptions.length - 1 ? `1px solid ${S200}` : 'none',
                cursor: 'pointer', textAlign: 'left',
              }}
              onMouseOver={e => { e.currentTarget.style.background = S100; }}
              onMouseOut={e => { e.currentTarget.style.background = fd[wardKey ?? 'ward'] === w ? 'rgba(91,141,239,0.06)' : W; }}
            >
              <span style={{ fontWeight: 600, fontSize: '0.87rem', color: S900 }}>{w}</span>
              {fd[wardKey ?? 'ward'] === w && (
                <span style={{ color: G, fontWeight: 800, fontSize: '0.9rem' }}>✓</span>
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShowWards(false)}
            style={{
              width: '100%', padding: '9px 14px', background: S50,
              border: 'none', borderTop: `1px solid ${S200}`,
              cursor: 'pointer', textAlign: 'center',
              fontSize: '0.78rem', color: S600, fontWeight: 600,
            }}
          >Skip — set ward later</button>
        </div>
      )}
    </div>
  );
};

const AddrInp = ({ fk, suburbKey, codeKey, ph, containerStyle, inputStyle, label, manualOnly }: { fk: string; ph?: string; req?: boolean; suburbKey?: string; codeKey?: string; containerStyle?: React.CSSProperties; inputStyle?: React.CSSProperties; label?: string; manualOnly?: boolean }) => {
  const { fd, sf } = useContext(FormContext);
  const val: string = fd[fk] ?? '';
  const [modalOpen, setModalOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<AddrSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  
  const [gpsCapturing, setGpsCapturing] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);
  const skipNextRef = useRef(false);
  const focusedRef = useRef(false);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
  }, []);

  const runSearch = (q: string) => {
    abortRef.current?.abort();
    if (q.trim().length < 3) { setSuggestions([]); setLoading(false); return; }
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&countrycodes=za&addressdetails=1&limit=6`;
    fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`geocoder ${r.status}`)))
      .then((data: any[]) => {
        if (ac.signal.aborted) return;
        const items = Array.isArray(data) ? data.map(formatNominatimSuggestion).filter(x => x.formatted) : [];
        setSuggestions(items);
        setLoading(false);
      })
      .catch(err => {
        if (err?.name === 'AbortError') return;
        setLoading(false);
        setSuggestions([]);
      });
  };

  const onTextChange = (next: string) => {
    sf(fk, next);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (skipNextRef.current) { skipNextRef.current = false; return; }
    setOpen(true);
    debounceRef.current = window.setTimeout(() => runSearch(next), 400);
  };

  const pick = (s: AddrSuggestion) => {
    skipNextRef.current = true;
    sf(fk, s.formatted);
    if (suburbKey && s.suburb && !fd[suburbKey]) sf(suburbKey, s.suburb);
    // Fill the postal Code field from the selected address' postcode so the
    // crew doesn't have to re-type it. Only when the code field is still empty.
    if (codeKey && s.postcode && !fd[codeKey]) sf(codeKey, s.postcode);
    setSuggestions([]);
    setOpen(false);
  };

  const captureGps = () => {
    if (!('geolocation' in navigator)) {
      setGpsError('GPS not supported on this device');
      return;
    }
    setGpsCapturing(true);
    setGpsError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const ac = new AbortController();
        reverseGeocode(pos.coords.latitude, pos.coords.longitude, ac.signal)
          .then(addr => {
            if (addr && addr.street) {
              skipNextRef.current = true;
              sf(fk, addr.street);
              if (suburbKey && addr.suburb && !fd[suburbKey]) sf(suburbKey, addr.suburb);
              if (codeKey && addr.postcode && !fd[codeKey]) sf(codeKey, addr.postcode);
            } else {
              setGpsError('Address not found');
            }
            setGpsCapturing(false);
          })
          .catch(err => {
            setGpsError('Could not look up address');
            setGpsCapturing(false);
          });
      },
      (err) => {
        const msg = err.code === err.PERMISSION_DENIED
          ? 'Location permission denied'
          : err.code === err.POSITION_UNAVAILABLE
            ? 'GPS signal unavailable'
            : err.code === err.TIMEOUT
              ? 'GPS request timed out'
              : 'Could not capture location';
        setGpsError(msg);
        setGpsCapturing(false);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  };

  // Shared suggestion dropdown — used by both the manual-only inline field and
  // the modal's search input.
  const suggestionDropdown = open && (loading || suggestions.length > 0) && (
    <div
      role="listbox"
      style={{
        position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30,
        marginTop: 4, background: '#fff', border: `1.5px solid #cbd5e1`,
        borderRadius: 10, boxShadow: '0 8px 24px rgba(15,23,42,0.12)',
        maxHeight: 200, overflowY: 'auto',
      }}
    >
      {loading && suggestions.length === 0 && <div style={{ padding: '10px 14px', fontSize: '0.82rem', color: '#475569', fontStyle: 'italic' }}>Searching addresses…</div>}
      {suggestions.map((s, i) => (
        <div
          key={i} role="option" aria-selected={false}
          onMouseDown={(e) => { e.preventDefault(); pick(s); }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#f8fafc'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#fff'; }}
          style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: i < suggestions.length - 1 ? '1px solid #f1f5f9' : 'none', fontSize: '0.85rem' }}
        >
          <div style={{ fontWeight: 700, color: '#0f172a' }}>{s.formatted}</div>
          {s.display && s.display !== s.formatted && <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: 2 }}>{s.display}</div>}
        </div>
      ))}
    </div>
  );

  // Manual-only mode (residential addresses): plain inline text field with the
  // type-to-search autocomplete, NO GPS-capture pop-up — the crew types the
  // address. Selecting a suggestion still fills suburb + code.
  if (manualOnly) {
    return (
      <div style={{ position: 'relative', marginBottom: 14 }}>
        <input
          type="text"
          value={val}
          onChange={e => onTextChange(e.target.value)}
          onFocus={(e) => { focusedRef.current = true; onF(e); if (val.length >= 3 && suggestions.length > 0) setOpen(true); }}
          onBlur={(e) => { focusedRef.current = false; onB(e); window.setTimeout(() => { if (!focusedRef.current) setOpen(false); }, 180); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); (e.currentTarget as HTMLInputElement).blur(); } }}
          autoComplete="off"
          placeholder={ph || 'Type street address…'}
          style={{ ...base, marginBottom: 0, borderColor: '#e2e8f0', ...containerStyle, ...inputStyle }}
        />
        {suggestionDropdown}
      </div>
    );
  }

  return (
    <>
      <div
        onClick={() => setModalOpen(true)}
        style={{ ...base, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', marginBottom: 14, borderColor: '#e2e8f0', color: val ? S900 : S400, ...containerStyle }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{val || ph || "Tap to set address"}</span>
        <span style={{ fontSize: '0.7rem', color: S400 }}>▼</span>
      </div>

      {modalOpen && (
        <Modal open={true} onClose={() => setModalOpen(false)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <div style={{ fontWeight: 900, fontSize: '1.05rem', color: S900 }}>Confirm Location {label ? `· ${label}` : ''}</div>
              <button type="button" onClick={() => setModalOpen(false)} style={{ background: S100, border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: '0.8rem', fontWeight: 700, color: S600, cursor: 'pointer' }}>Cancel</button>
            </div>

            <button
              type="button"
              onClick={captureGps}
              disabled={gpsCapturing}
              style={{
                width: '100%', padding: 14, borderRadius: 12, fontWeight: 800, fontSize: '0.9rem', marginBottom: 16,
                border: `2px solid ${S200}`, background: W, color: S700, cursor: gpsCapturing ? 'not-allowed' : 'pointer',
                display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8
              }}
            >
              {gpsCapturing ? '📍 Capturing GPS…' : '📍 Capture Current GPS Location'}
            </button>
            {gpsError && <div style={{ fontSize: '0.8rem', color: REDC, marginBottom: 16, textAlign: 'center' }}>{gpsError}</div>}

            <div style={{ background: W, borderRadius: 16, padding: '16px 14px', border: `1.5px solid ${S200}`, marginBottom: 16 }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 800, color: S600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                Manual Entry / Search
              </div>
              <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
                <input
                  type="text"
                  value={val}
                  onChange={e => onTextChange(e.target.value)}
                  onFocus={(e) => { focusedRef.current = true; onF(e); if (val.length >= 3 && suggestions.length > 0) setOpen(true); }}
                  onBlur={(e) => { focusedRef.current = false; onB(e); window.setTimeout(() => { if (!focusedRef.current) setOpen(false); }, 180); }}
                  onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); (e.currentTarget as HTMLInputElement).blur(); } }}
                  autoComplete="off"
                  placeholder={ph || "Type street address manually..."}
                  style={{ ...base, width: '100%', background: W, borderColor: '#cbd5e1', ...inputStyle }}
                />
                {open && (loading || suggestions.length > 0) && (
                  <div
                    role="listbox"
                    style={{
                      position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30,
                      marginTop: 4, background: '#fff', border: `1.5px solid #cbd5e1`,
                      borderRadius: 10, boxShadow: '0 8px 24px rgba(15,23,42,0.12)',
                      maxHeight: 200, overflowY: 'auto',
                    }}
                  >
                    {loading && suggestions.length === 0 && <div style={{ padding: '10px 14px', fontSize: '0.82rem', color: '#475569', fontStyle: 'italic' }}>Searching addresses…</div>}
                    {suggestions.map((s, i) => (
                      <div
                        key={i} role="option" aria-selected={false}
                        onMouseDown={(e) => { e.preventDefault(); pick(s); }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#f8fafc'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#fff'; }}
                        style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: i < suggestions.length - 1 ? '1px solid #f1f5f9' : 'none', fontSize: '0.85rem' }}
                      >
                        <div style={{ fontWeight: 700, color: '#0f172a' }}>{s.formatted}</div>
                        {s.display && s.display !== s.formatted && <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: 2 }}>{s.display}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setModalOpen(false)}
              style={{
                width: '100%', padding: 16, borderRadius: 12, fontWeight: 800, fontSize: '1rem',
                border: 'none', background: `linear-gradient(135deg,${G},${GDK})`, color: W,
                cursor: 'pointer', boxShadow: `0 4px 14px ${G}30`, marginTop: 16
              }}
            >
              ✓ Confirm Address
            </button>
          </Modal>
      )}
    </>
  );
};

// DateInp — split YYYY / MM / DD inputs that auto-advance once each
// segment fills. Native <input type="date"> accepts a 6-digit year which
// is awful for the crew typing on a phone. This component caps each
// segment to its real width (4 / 2 / 2) and moves focus forward as soon
// as the segment is full.
//
// The three segments are held in LOCAL state while the crew is typing so
// partial entries (e.g. just the year) don't get thrown away. The parent
// `form_data` is updated whenever the composition is either fully complete
// (ISO `YYYY-MM-DD`) or fully cleared. This keeps the on-disk shape stable
// while still letting the user type freely.
const DateInp = ({ fk }: { fk: string }) => {
  const { fd, sf } = useContext(FormContext);
  const stored: string = fd[fk] ?? '';

  // Local mirror of the three segments. Initialised from the stored ISO
  // value, then re-sync if the stored value changes externally (e.g. the
  // SA-ID autofill writes a DOB).
  const initial = stored.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const [y, setY] = useState<string>(initial?.[1] ?? '');
  const [m, setM] = useState<string>(initial?.[2] ?? '');
  const [d, setD] = useState<string>(initial?.[3] ?? '');
  const lastStoredRef = useRef(stored);
  useEffect(() => {
    if (stored === lastStoredRef.current) return;
    lastStoredRef.current = stored;
    const next = stored.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    setY(next?.[1] ?? '');
    setM(next?.[2] ?? '');
    setD(next?.[3] ?? '');
  }, [stored]);

  const yRef = useRef<HTMLInputElement>(null);
  const mRef = useRef<HTMLInputElement>(null);
  const dRef = useRef<HTMLInputElement>(null);

  // Push to form_data only when all 3 segments are full + the date is real,
  // or when everything's been cleared. Partial-entry states stay local.
  const syncToParent = (yy: string, mm: string, dd: string) => {
    if (yy.length === 4 && mm.length === 2 && dd.length === 2) {
      const iso = `${yy}-${mm}-${dd}`;
      const parsed = new Date(iso);
      if (!Number.isNaN(parsed.getTime()) && iso !== stored) {
        lastStoredRef.current = iso;
        sf(fk, iso);
      }
    } else if (!yy && !mm && !dd && stored) {
      lastStoredRef.current = '';
      sf(fk, '');
    }
  };

  const seg = (
    ref: React.RefObject<HTMLInputElement | null>,
    nextRef: React.RefObject<HTMLInputElement | null> | null,
    prevRef: React.RefObject<HTMLInputElement | null> | null,
    max: number,
    val: string,
    setLocal: (v: string) => void,
    _placeholder: string,
    width: number,
  ) => (
    <input
      ref={ref}
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      maxLength={max}
      value={val}
      placeholder=""
      autoComplete="off"
      onFocus={e => { onF(e); e.currentTarget.select(); }}
      onBlur={onB}
      onKeyDown={e => {
        if (e.key === 'Backspace' && !e.currentTarget.value && prevRef?.current) {
          prevRef.current.focus();
          prevRef.current.setSelectionRange(prevRef.current.value.length, prevRef.current.value.length);
          e.preventDefault();
        }
      }}
      onChange={e => {
        const v = e.target.value.replace(/\D/g, '').slice(0, max);
        setLocal(v);
        if (v.length === max && nextRef?.current) {
          nextRef.current.focus();
          nextRef.current.select();
        }
        // Try to push to parent — only succeeds when full date is valid
        // or every segment is empty.
        if (ref === yRef) syncToParent(v, m, d);
        else if (ref === mRef) syncToParent(y, v, d);
        else syncToParent(y, m, v);
      }}
      style={{
        width, padding: '11px 8px', fontSize: '0.92rem',
        fontFamily: 'ui-monospace, "SF Mono", monospace',
        textAlign: 'center', borderRadius: 8, border: `1.5px solid #e2e8f0`,
        color: '#0f172a', outline: 'none', background: '#ffffff',
        boxSizing: 'border-box',
      }}
    />
  );

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14,
      padding: '2px', borderRadius: 10,
      border: `1.5px solid #e2e8f0`,
      background: '#fff',
    }}>
      {seg(yRef, mRef, null, 4, y, setY, 'YYYY', 64)}
      <span style={{ color: '#94a3b8', fontWeight: 700 }}>/</span>
      {seg(mRef, dRef, yRef, 2, m, setM, 'MM', 48)}
      <span style={{ color: '#94a3b8', fontWeight: 700 }}>/</span>
      {seg(dRef, null, mRef, 2, d, setD, 'DD', 48)}
    </div>
  );
};

// Reveals a Post-Authorisation Number input when the selected medical scheme
// is administered by Netcare 911, AZOZA, or is Polmed / Regular Force —
// per SAPAESA Medical Scheme Administration List (01 Jan 2026), these all
// require post-auth submission within 72 hours of case completion.
const PostAuthField = () => {
  const { fd } = useContext(FormContext);
  const scheme = (fd.medical_scheme || '').trim();
  if (!POSTAUTH_REQUIRED_SCHEMES.has(scheme)) return null;
  return (
    <>
      <Lbl t="Post-Authorisation Number" />
      <Inp fk="post_auth_number" ph="Post-auth ref, or N/A / Nill if not required" />
    </>
  );
};

// Plan / Option input that adapts to the selected medical scheme:
//   • If the scheme has a published 2026 plan list in SCHEME_PLANS, render a
//     searchable combo dropdown of those plans (mobile-friendly picker on
//     touch devices, datalist autocomplete on desktop). Crew can still type
//     a value that isn't in the list — useful for legacy / regional names.
//   • If the scheme isn't in SCHEME_PLANS (or none is selected yet), fall
//     back to the original free-text input so nothing is blocked.
const SchemeOptionField = () => {
  const { fd } = useContext(FormContext);
  const scheme = (fd.medical_scheme || '').trim();
  const plans = SCHEME_PLANS[scheme];
  if (plans && plans.length > 0) {
    // listId namespaced by scheme so multiple schemes' datalists don't collide
    // if the field is re-rendered on scheme change.
    const listId = `scheme-plans-${scheme.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`;
    return <ComboInp fk="scheme_option" opts={plans} listId={listId} ph="Select or type plan…" />;
  }
  return <Inp fk="scheme_option" ph="e.g. Bonfit Select" />;
};

// Combo input — type-to-search on desktop, native dropdown picker on mobile.
//   Desktop: <input list=...> + <datalist> gives keyboard search + suggestions.
//   Mobile (touch + narrow): a real <select> so iOS opens the fullscreen wheel
//   picker and Android opens the bottom-sheet picker — much easier to use on a
//   phone than typing 30 characters of a scheme name with one thumb. If the
//   stored value isn't in the option list (legacy / regional scheme), it's
//   added as a transient option so it still shows as selected.
const isTouchDevice = () =>
  typeof window !== 'undefined' &&
  (matchMedia('(hover: none) and (pointer: coarse)').matches ||
    window.innerWidth < 720);

const ComboInp = ({ fk, opts, listId }: { fk: string; ph?: string; opts: string[]; req?: boolean; listId: string }) => {
  const { fd, sf } = useContext(FormContext);
  const [useDropdown, setUseDropdown] = useState(isTouchDevice());
  useEffect(() => {
    const onResize = () => setUseDropdown(isTouchDevice());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const current = fd[fk] ?? '';
  const borderStyle = { ...base, marginBottom: 14, borderColor: '#e2e8f0' };
  // Mobile branch renders an auto-growing textarea (long scheme names wrap);
  // the desktop branch keeps a native <input> because <datalist> needs one.
  const taRef = useAutoGrow(current);

  // Touch / mobile: typeable input with a custom 3-suggestion popdown.
  // Native <datalist> is unreliable on mobile (and blocks typing inside a
  // native <select>), so we render our own filtered list. Suggestions are
  // capped at three so the keyboard stays visible above them.
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [open]);

  if (useDropdown) {
    const q = current.toLowerCase().trim();
    const matches = q ? opts.filter(o => o.toLowerCase().includes(q)) : opts;
    const suggestions = matches.slice(0, 3);
    const showSuggestions =
      open &&
      suggestions.length > 0 &&
      !(suggestions.length === 1 && suggestions[0].toLowerCase() === q);

    return (
      <div ref={wrapRef} style={{ position: 'relative', marginBottom: 14 }}>
        <textarea
          id={`prf-field-${fk}`}
          ref={taRef}
          rows={1}
          value={current}
          onChange={e => { sf(fk, e.target.value); setOpen(true); }}
          onKeyDown={blockEnter}
          onFocus={e => { onF(e); setOpen(true); }}
          onBlur={onB}
          placeholder=""
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="words"
          spellCheck={false}
          style={{ ...borderStyle, marginBottom: 0, resize: 'none', overflow: 'hidden' }}
        />
        {showSuggestions && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
            background: '#ffffff', border: '1px solid #e2e8f0',
            borderRadius: 10, boxShadow: '0 8px 24px rgba(15,23,42,0.10)',
            zIndex: 30, overflow: 'hidden',
          }}>
            {suggestions.map((o, i) => (
              <button
                key={o}
                type="button"
                onMouseDown={e => e.preventDefault()}
                onTouchStart={e => e.preventDefault()}
                onClick={() => { sf(fk, o); setOpen(false); }}
                style={{
                  display: 'block', width: '100%',
                  padding: '11px 14px', textAlign: 'left',
                  background: '#ffffff', color: '#334155',
                  border: 'none',
                  borderBottom: i < suggestions.length - 1 ? '1px solid #f1f5f9' : 'none',
                  cursor: 'pointer', fontSize: '0.88rem', fontWeight: 600,
                  WebkitTapHighlightColor: 'transparent',
                }}
              >{o}</button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <input
        id={`prf-field-${fk}`}
        type="text"
        list={listId}
        value={current}
        onChange={e => sf(fk, e.target.value)}
        onFocus={onF}
        onBlur={onB}
        placeholder=""
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="words"
        spellCheck={false}
        style={borderStyle}
      />
      <datalist id={listId}>
        {opts.map(o => <option key={o} value={o} />)}
      </datalist>
    </>
  );
};

const Txt = ({ fk, rows = 3 }: { fk: string; ph?: string; rows?: number }) => {
  const { fd, sf } = useContext(FormContext);
  // Auto-grows with content (initial `rows` height as the floor) so long
  // entries expand the field downward instead of scrolling inside it.
  const taRef = useAutoGrow(fd[fk] ?? '');
  return <textarea id={`prf-field-${fk}`} ref={taRef} value={fd[fk] ?? ''} onChange={e => sf(fk, e.target.value)} onFocus={onF} onBlur={onB} placeholder="" rows={rows} style={{ ...base, resize: 'none', overflow: 'hidden', marginBottom: 14, fontFamily: 'inherit' }} />
};

// VoiceTxt — textarea with an overlaid mic-icon trigger that dictates into
// the field via the Web Speech API. Used for the long-form clinical notes
// (chief complaint, findings on arrival, HPI, management notes) so crew can
// keep their gloves on and dictate while attending the patient.
//
// • Push and hold to dictate; release to stop. Recording is a pulsing red mic.
// • Final transcripts are appended to whatever the crew already typed —
//   never overwrite, so the mic can extend partial entries.
// • Auto-hides on browsers that don't expose SpeechRecognition (no harm,
//   the plain textarea still works).

const VoiceTxt = ({ fk, rows = 3 }: { fk: string; ph?: string; rows?: number }) => {
  const { fd, sf } = useContext(FormContext);
  const [recording, setRecording] = useState(false);
  const recogRef = useRef<any>(null);
  const heldRef = useRef(false);   // true while the mic button is physically held
  const fdRef = useRef(fd);
  fdRef.current = fd;
  const supported = !!SpeechRecognitionAPI;
  // Incremental dictation state (baseline + committed finals). Interim words are
  // layered on transiently; see applyDictation for the duplicate-word guard.
  const dictRef = useRef<DictationState>(newDictationState(''));
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Floor height = the natural `rows` height, captured before we ever set an
  // explicit height, so the field never shrinks below its default size.
  const minHRef = useRef<number>(0);

  const autoGrow = () => {
    const el = taRef.current;
    if (!el) return;
    if (!minHRef.current) minHRef.current = el.offsetHeight;
    el.style.height = 'auto';
    el.style.height = Math.max(el.scrollHeight, minHRef.current) + 'px';
  };
  // Grow the textarea to fit its content so dictated words wrap and expand
  // downward instead of scrolling out of view.
  useLayoutEffect(() => { autoGrow(); }, [fd[fk]]);

  useEffect(() => () => {
    // Make sure we tear down any active recogniser if the field unmounts
    // mid-dictation (e.g. crew jumps phase).
    heldRef.current = false;
    dictationActive = false;
    try { recogRef.current?.stop?.(); } catch { /* ignore */ }
    recogRef.current = null;
  }, []);

  const start = () => {
    if (!supported || recording) return;
    heldRef.current = true;
    dictationActive = true;
    // Close the keyboard first (dictationActive is already set, so the
    // keyboard-close scroll never reflows the sticky header mid-hold).
    blurFocusedField();
    // Free the shared speech service if another field's recogniser is still
    // active/finalising, so this start() never throws and silently no-ops.
    try { activeRecognition?.stop?.(); } catch { /* ignore */ }
    // Capture what the crew already typed as the immutable prefix. Streaming
    // dictation appends on top — any manual edits made before tapping the mic
    // survive the session.
    dictRef.current = newDictationState(fdRef.current[fk] || '');
    // Re-spawn on `onend` while the button is held: Samsung Internet / Android
    // Chrome end the session on the first pause even with continuous=true,
    // which used to kill dictation mid-hold. Re-baseline from the field so the
    // committed text carries across sessions.
    let busyRetries = 0;
    const spawn = () => {
      const recog = new SpeechRecognitionAPI();
      recog.lang = 'en-ZA';
      recog.continuous = true;
      recog.interimResults = true;
      // Ask the engine for its runner-up transcripts too — pickTranscript uses
      // them to resolve homophones ("8" vs "ate") with the engine's own words.
      recog.maxAlternatives = 5;
      recog.onresult = (e: any) => {
        // Ignore stragglers from a session we've already replaced (iOS can fire
        // a late result from a stopped recogniser) — only the current session
        // writes to the field, so a superseded one can't corrupt the text.
        if (recogRef.current !== recog) return;
        sf(fk, applyDictation(e, dictRef.current, fk));
      };
      recog.onend = () => {
        if (heldRef.current) {
          // Respawn to keep listening — iOS Safari (and Samsung) ignore
          // `continuous` and end the session after every pause. Do NOT
          // re-baseline from the field here: dictRef.current.committed is the
          // authoritative running transcript for this hold, and re-reading
          // fd[fk] races React's async state flush — the just-spoken word may
          // not be in fd yet, so baselining off it dropped that word (the iOS
          // "talk, come back, talk again — it deletes a word" bug).
          // applyDictation already re-aligns its finalCount when the fresh
          // session's results list restarts at index 0, so the committed text
          // simply continues to accumulate across sessions.
          startWithRetry();
          return;
        }
        setRecording(false); recogRef.current = null;
        dictationActive = false;
        if (activeRecognition === recog) activeRecognition = null;
      };
      recog.onerror = (ev: any) => {
        if (ev?.error === 'not-allowed' || ev?.error === 'service-not-allowed') {
          heldRef.current = false;   // fatal — don't respawn
        }
      };
      recogRef.current = recog;
      activeRecognition = recog;
      recog.start();          // throws InvalidStateError if the engine is busy
      busyRetries = 0;        // started cleanly — reset the backoff
    };
    // Samsung's single OS speech engine releases asynchronously, so a start()
    // that lands while a previous recogniser is still tearing down throws.
    // Retry with a short backoff (rather than silently dying) for as long as
    // the button is held — this is what makes switching between adjacent
    // fields' mics reliable and keeps dictation alive across Samsung's
    // premature onend restarts.
    const startWithRetry = () => {
      if (!heldRef.current) return;
      try {
        spawn();
      } catch {
        if (heldRef.current && busyRetries++ < 10) {
          window.setTimeout(startWithRetry, 130);
        } else {
          setRecording(false);
          recogRef.current = null;
          heldRef.current = false;
          dictationActive = false;
        }
      }
    };
    // NB: do NOT scrollIntoView here — starting dictation must leave the page
    // exactly where it is. Auto-scrolling on press moved the field out from
    // under the crew's thumb mid-hold (reported "screen scrolls into place").
    startWithRetry();
    setRecording(true);
  };

  const stop = () => {
    heldRef.current = false;   // release BEFORE stop so onend doesn't respawn
    dictationActive = false;
    try { recogRef.current?.stop?.(); } catch { /* ignore */ }
    setRecording(false);
  };

  return (
    <div style={{ position: 'relative', marginBottom: 14 }}>
      <textarea
        id={`prf-field-${fk}`}
        ref={taRef}
        value={fd[fk] ?? ''}
        onChange={e => { sf(fk, e.target.value); autoGrow(); }}
        onFocus={onF}
        onBlur={onB}
        placeholder=""
        rows={rows}
        style={{
          ...base,
          resize: 'none',
          overflow: 'hidden',
          marginBottom: 0,
          fontFamily: 'inherit',
          paddingRight: supported ? 60 : (base as any).padding,
        }}
      />
      {supported && (
        <>
          <button
            type="button"
            // Push and hold: start dictating on press, stop on release. Pointer
            // capture keeps the release event on the button even if the finger
            // drifts off it while speaking.
            onPointerDown={e => {
              e.preventDefault();
              try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
              start();
            }}
            onPointerUp={e => { e.preventDefault(); stop(); }}
            onPointerCancel={() => stop()}
            onLostPointerCapture={() => { if (recording) stop(); }}
            onContextMenu={e => e.preventDefault()}
            aria-label={recording ? 'Recording — release to stop' : 'Hold to dictate'}
            title={recording ? 'Release to stop' : 'Hold to dictate'}
            style={{
              position: 'absolute',
              top: 8, right: 8,
              width: 46, height: 46, borderRadius: 12,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `2.5px solid \$\{recording \? '#991b1b' : '#1e3a8a'\}`,
              background: recording ? '#ef4444' : '#3b82f6',
              color: '#ffffff',
              cursor: 'pointer',
              boxShadow: recording ? '0 0 0 4px rgba(239,68,68,0.4)' : '0 6px 12px rgba(0,0,0,0.3)',
              animation: recording ? 'voicePulse 1.4s ease-in-out infinite' : 'none',
              transition: 'all 0.15s',
              touchAction: 'none',
              userSelect: 'none',
              WebkitUserSelect: 'none',
              WebkitTouchCallout: 'none',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          </button>
          <style>{`@keyframes voicePulse { 0%, 100% { box-shadow: 0 0 0 4px rgba(239,68,68,0.18); } 50% { box-shadow: 0 0 0 8px rgba(239,68,68,0.05); } }`}</style>
        </>
      )}
    </div>
  );
};

const Sel = ({ fk, opts }: { fk: string; opts: string[] }) => {
  const { fd, sf } = useContext(FormContext);
  const val = fd[fk] ?? '';
  const isCustom = val !== '' && !opts.includes(val);
  const [showCustom, setShowCustom] = useState(isCustom);

  useEffect(() => {
    if (val !== '' && !opts.includes(val)) setShowCustom(true);
  }, [val, opts]);

  if (showCustom) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <GrowTa
          autoFocus
          value={val}
          onChange={e => sf(fk, e.target.value)}
          onFocus={onF}
          onBlur={onB}
          autoComplete="off"
          placeholder="Type custom value..."
          style={{ ...base, marginBottom: 0, flex: 1 }}
        />
        <button 
          type="button" 
          onClick={() => { sf(fk, ''); setShowCustom(false); }} 
          style={{ fontSize: '0.72rem', fontWeight: 600, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline', flexShrink: 0 }}
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <select 
      value={val} 
      onChange={e => {
        if (e.target.value === '__custom__') {
          setShowCustom(true);
          sf(fk, '');
        } else {
          sf(fk, e.target.value);
        }
      }} 
      onFocus={onF} 
      onBlur={onB} 
      style={{ ...base, marginBottom: 14, appearance: 'auto' }}
    >
      <option value="">— Select —</option>
      {opts.map((o: string) => <option key={o} value={o}>{o}</option>)}
      <option value="__custom__">Other (Type Custom...)</option>
    </select>
  );
};

const Toggle = ({ fk, opts, colors, size, labels }: { fk: string; opts: string[]; colors?: Record<string, string>; size?: 'sm'; labels?: Record<string, string> }) => {
  const { fd, sf } = useContext(FormContext);
  const sm = size === 'sm';
  // Use grid so every button on a row gets equal width, and rows wrap
  // automatically when buttons can't fit. Min column width ~110px gives
  // common labels like "COURTESY" room to fit on a single line; multi-
  // word labels ("Declaration Of Death") wrap between words rather than
  // breaking mid-word.
  const cols = sm ? 'repeat(auto-fit, minmax(64px, 1fr))' : 'repeat(auto-fit, minmax(110px, 1fr))';
  return <div style={{ display: 'grid', gridTemplateColumns: cols, gap: sm ? 6 : 8, marginBottom: 14 }}>
    {opts.map((o: string) => {
      const on = fd[fk] === o; const c = colors?.[o] || '#5b8def';
      const display = labels?.[o] ?? o;
      return <button key={o} type="button" onClick={() => sf(fk, o)} style={{
        minHeight: sm ? 36 : 48,
        padding: sm ? '7px 8px' : '10px 10px',
        borderRadius: sm ? 7 : 10,
        fontSize: sm ? '0.74rem' : '0.82rem',
        fontWeight: 700,
        lineHeight: 1.2,
        textAlign: 'center',
        whiteSpace: 'normal',
        wordBreak: 'normal',
        overflowWrap: 'break-word',
        hyphens: 'auto',
        border: `${sm ? 1.5 : 2}px solid ${on ? c : '#e2e8f0'}`,
        background: on ? `${c}18` : '#ffffff',
        color: on ? c : '#475569',
        cursor: 'pointer',
        transition: 'all 0.15s',
        boxShadow: on ? `0 0 0 ${sm ? 2 : 3}px ${c}22` : '0 1px 2px rgba(0,0,0,0.03)',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
      }}>{display}</button>;
    })}
  </div>
};

const DepCodePicker = () => {
  const { fd, sf } = useContext(FormContext);
  const PRESETS = ['00', '01', '02', '03', '04', '05', '06'];
  const cur: string = fd.dependent_number || '';
  const isCustom = cur !== '' && !PRESETS.includes(cur);
  const [editing, setEditing] = useState(isCustom);
  const c = '#5b8def';
  const btn = (label: string, on: boolean, onClick: () => void) => (
    <button key={label} type="button" onClick={onClick} style={{ flex: '0 0 auto', minWidth: 40, padding: '7px 10px', borderRadius: 7, fontSize: '0.74rem', fontWeight: 700, border: `1.5px solid ${on ? c : '#e2e8f0'}`, background: on ? `${c}18` : '#ffffff', color: on ? c : '#475569', cursor: 'pointer', transition: 'all 0.15s', boxShadow: on ? `0 0 0 2px ${c}22` : '0 1px 2px rgba(0,0,0,0.03)' }}>{label}</button>
  );
  return <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
    {PRESETS.map(o => btn(o, !editing && cur === o, () => { setEditing(false); sf('dependent_number', o); }))}
    {btn('…', editing || isCustom, () => { setEditing(true); if (PRESETS.includes(cur)) sf('dependent_number', ''); })}
    {(editing || isCustom) && (
      <input
        type="text" inputMode="numeric" maxLength={2} placeholder=""
        autoComplete="off"
        value={isCustom ? cur : ''}
        onChange={e => sf('dependent_number', e.target.value.replace(/\D/g, '').slice(0, 2))}
        autoFocus={editing && !isCustom}
        style={{ width: 56, padding: '7px 10px', borderRadius: 7, fontSize: '0.78rem', fontWeight: 700, textAlign: 'center', border: `1.5px solid ${c}`, color: '#0f172a', outline: 'none', background: '#ffffff' }}
      />
    )}
  </div>;
};

// Call Type picker — full grid until first pick, then collapse-into-corner
// animation, then a single highlighted pill at the top-left that opens a
// dropdown of all call types. Replaces the generic Toggle for call_type so
// the dispatch phase reclaims vertical space once the type is locked in.
const CALL_TYPE_OPTS = ['PRIMARY', 'IHT', 'RHT', 'WCA_IOD', 'COURTESY', 'RESUS', 'DOD'] as const;
const CALL_TYPE_LABELS: Record<string, string> = {
  IHT: 'IFT/IHT',
  WCA_IOD: 'WCA / IOD',
  RESUS: 'Resus',
  DOD: 'Declaration of Death',
};

// "Why is this an IFT/IHT call?" — the transfer reasons as tappable cards.
// Picking one collapses the grid to show ONLY the chosen reason (tap "Change"
// to reopen the full set). Mobile-first: an auto-fill grid gives 2 columns on
// a phone and more on wider screens, every card a large (≥56px) touch target.
const TransferSubtypeCards = () => {
  const { fd, sf } = useContext(FormContext);
  const BRAND = '#088395', BRAND_DK = '#005f6b', BRAND_TINT = '#e7f3f5';
  const selected: string = fd.transfer_subtype || '';
  const [expanded, setExpanded] = useState(false);
  const showAll = !selected || expanded;

  // Collapsed — only the picked reason, with a Change affordance.
  if (!showAll) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        style={{
          width: '100%', padding: '14px 16px', borderRadius: 12,
          border: `1.5px solid ${BRAND}`, background: BRAND_TINT,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 10, cursor: 'pointer', touchAction: 'manipulation', textAlign: 'left',
          boxShadow: '0 2px 8px rgba(8,131,149,0.12)',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{
            flexShrink: 0, width: 22, height: 22, borderRadius: 11, background: BRAND,
            color: W, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '0.8rem', fontWeight: 900,
          }}>✓</span>
          <span style={{ fontWeight: 800, fontSize: '0.9rem', color: BRAND_DK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selected}
          </span>
        </span>
        <span style={{ flexShrink: 0, fontSize: '0.72rem', fontWeight: 800, color: BRAND, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Change
        </span>
      </button>
    );
  }

  // Expanded — every reason as a card; the current pick (if any) is highlighted.
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8,
    }}>
      {TRANSFER_SUBTYPES.map(r => {
        const isSel = r === selected;
        return (
          <button
            key={r} type="button"
            onClick={() => { sf('transfer_subtype', r); setExpanded(false); }}
            style={{
              minHeight: 56, padding: '10px', borderRadius: 12,
              border: `1.5px solid ${isSel ? BRAND : S200}`,
              background: isSel ? BRAND_TINT : W,
              color: isSel ? BRAND_DK : S700,
              fontWeight: isSel ? 800 : 600, fontSize: '0.8rem', lineHeight: 1.25,
              textAlign: 'center', whiteSpace: 'normal', wordBreak: 'normal',
              overflowWrap: 'break-word', hyphens: 'auto',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', touchAction: 'manipulation',
              boxShadow: isSel ? '0 2px 8px rgba(8,131,149,0.15)' : '0 1px 3px rgba(0,0,0,0.03)',
              transition: 'border-color 0.15s, background 0.15s',
            }}
          >
            {r}
          </button>
        );
      })}
    </div>
  );
};

const CallTypePicker = ({ onPick }: { onPick?: (o: string) => void }) => {
  const { fd, sf } = useContext(FormContext);
  const selected: string = fd.call_type || '';
  const [animating, setAnimating] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const display = (o: string) => CALL_TYPE_LABELS[o] ?? o;
  const c = '#5b8def'; const cdk = '#3b6fde';

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const pick = (o: string) => {
    const firstPick = !selected;
    sf('call_type', o);
    // RESUS / DOD imply their matching MED-AID sub-section — auto-set the
    // flag so the panel (which auto-expands on these call types) shows
    // the right body without an extra crew tap.
    // Declaration of Death is gated strictly on the call type — only DOD
    // turns the flag on, every other pick clears it. This prevents the DoD
    // form from leaking into MED AID billing for IFT/IHT/RHT/PRIMARY/etc
    // calls if the crew had toggled it on a previous selection.
    sf('med_aid_dec_death', o === 'DOD');
    if (o === 'RESUS') {
      sf('med_aid_resus', true);
    }
    // WCA / IOD call type implies its billing type — auto-set so the
    // WCA billing detail panel appears automatically on Phase 2.
    if (o === 'WCA_IOD') {
      sf('billing_type', 'WCA / IOD');
    }
    setOpen(false);
    if (firstPick) {
      setAnimating(true);
      window.setTimeout(() => {
        setAnimating(false);
        onPick?.(o);
      }, 320);
    } else {
      onPick?.(o);
    }
  };

  // No selection yet — render full-screen grid filling the mobile viewport.
  if (!selected) {
    return (
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)',
        gridAutoRows: '1fr', gap: 8, marginBottom: 14,
        minHeight: 'min(340px, calc(100vh - 260px))',
      }}>
        {CALL_TYPE_OPTS.map(o => (
          <button
            key={o} type="button" onClick={() => pick(o)}
            style={{
              padding: '10px 8px', borderRadius: 10,
              fontSize: '0.83rem', fontWeight: 800, lineHeight: 1.25,
              textAlign: 'center', whiteSpace: 'normal', wordBreak: 'normal',
              overflowWrap: 'break-word', hyphens: 'auto', cursor: 'pointer',
              border: `2px solid #e2e8f0`, background: '#ffffff', color: '#334155',
              transition: 'all 0.15s',
              boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
              WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >{display(o)}</button>
        ))}
      </div>
    );
  }

  // Animating — non-selected chips fade & shrink toward the top-left,
  // selected chip highlights in place before the layout collapses.
  if (animating) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8, marginBottom: 14 }}>
        {CALL_TYPE_OPTS.map(o => {
          const on = o === selected;
          return (
            <button
              key={o} type="button" disabled
              style={{
                minHeight: 48, padding: '10px 10px', borderRadius: 10,
                fontSize: '0.82rem', fontWeight: 700, lineHeight: 1.2,
                textAlign: 'center', cursor: 'default',
                border: `2px solid ${on ? c : '#e2e8f0'}`,
                background: on ? `${c}18` : '#ffffff',
                color: on ? cdk : '#475569',
                transformOrigin: 'top left',
                transform: on ? 'scale(1)' : 'translate(-30%, -30%) scale(0.25)',
                opacity: on ? 1 : 0,
                transition: 'transform 0.3s ease, opacity 0.3s ease, box-shadow 0.2s',
                boxShadow: on ? `0 0 0 3px ${c}22` : 'none',
              }}
            >{display(o)}</button>
          );
        })}
      </div>
    );
  }

  // Collapsed — single pill at top-left that opens a dropdown of all types.
  return (
    <div ref={wrapRef} style={{ position: 'relative', marginBottom: 14, display: 'flex', justifyContent: 'flex-start' }}>
      <button
        type="button" onClick={() => setOpen(v => !v)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 10,
          padding: '10px 16px', borderRadius: 10,
          fontSize: '0.95rem', fontWeight: 800, color: cdk,
          background: `${c}18`, border: `2px solid ${c}`,
          cursor: 'pointer', letterSpacing: '0.02em',
          boxShadow: `0 0 0 3px ${c}22`,
          transition: 'all 0.15s',
          animation: 'callTypePopIn 0.22s ease-out',
          WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation',
        }}
      >
        <span>{display(selected)}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0,
          minWidth: 200, background: '#ffffff', border: '1px solid #e2e8f0',
          borderRadius: 10, boxShadow: '0 8px 24px rgba(15,23,42,0.10)',
          zIndex: 20, overflow: 'hidden',
        }}>
          {CALL_TYPE_OPTS.map(o => {
            const on = o === selected;
            return (
              <button
                key={o} type="button" onClick={() => pick(o)}
                style={{
                  display: 'block', width: '100%',
                  padding: '11px 14px', textAlign: 'left',
                  background: on ? `${c}12` : '#ffffff',
                  color: on ? cdk : '#334155',
                  border: 'none', cursor: 'pointer',
                  fontSize: '0.86rem', fontWeight: on ? 800 : 600,
                  borderBottom: '1px solid #f1f5f9',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >{display(o)}</button>
            );
          })}
        </div>
      )}
      <style>{`@keyframes callTypePopIn { from { transform: scale(0.85); opacity: 0; } to { transform: scale(1); opacity: 1; } }`}</style>
    </div>
  );
};

// Billing Type picker — same UX as CallTypePicker. Full grid until first pick,
// then non-selected chips slide toward the top-left while the chosen chip
// highlights, finally collapsing to a single pill that opens a dropdown.
const BILLING_TYPE_OPTS = ['MED AID', 'RAF', 'PVT', 'CALL OUT FEE'] as const;

const BillingTypePicker = () => {
  const { fd, sf } = useContext(FormContext);
  let selected: string = fd.billing_type || '';
  // The 'EVENT' billing type was deprecated and removed. If a legacy record
  // still carries it, treat it as unselected to force the crew to pick a valid one.
  if (selected === 'EVENT') selected = '';
  const [animating, setAnimating] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const c = '#5b8def'; const cdk = '#3b6fde';
  // EVENT and CALL OUT FEE are hidden from the picker but kept in
  // BILLING_TYPE_OPTS so legacy records carrying those values still render
  // their conditional billing panels.
  // Declaration of Death call-outs cannot bill third-party payers (no live
  // patient to bill, no incident exposure) — strip RAF.
  // Resus calls are restricted to MED AID and PVT only.
  const baseOpts = BILLING_TYPE_OPTS.filter(o => o !== 'CALL OUT FEE');
  const billingOpts = fd.call_type === 'DOD'
    ? baseOpts.filter(o => o !== 'RAF')
    : fd.call_type === 'RESUS'
    ? baseOpts.filter(o => o === 'MED AID' || o === 'PVT')
    : baseOpts;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const pick = (o: string) => {
    const firstPick = !selected;
    sf('billing_type', o);
    setOpen(false);
    if (firstPick) {
      setAnimating(true);
      window.setTimeout(() => setAnimating(false), 320);
    }
  };

  if (!selected) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8, marginBottom: 14 }}>
        {billingOpts.map(o => (
          <button
            key={o} type="button" onClick={() => pick(o)}
            style={{
              minHeight: 48, padding: '10px 10px', borderRadius: 10,
              fontSize: '0.82rem', fontWeight: 700, lineHeight: 1.2,
              textAlign: 'center', whiteSpace: 'normal', wordBreak: 'normal',
              overflowWrap: 'break-word', hyphens: 'auto', cursor: 'pointer',
              border: `2px solid #e2e8f0`, background: '#ffffff', color: '#475569',
              transition: 'all 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
              WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation',
            }}
          >{o}</button>
        ))}
      </div>
    );
  }

  if (animating) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8, marginBottom: 14 }}>
        {billingOpts.map(o => {
          const on = o === selected;
          return (
            <button
              key={o} type="button" disabled
              style={{
                minHeight: 48, padding: '10px 10px', borderRadius: 10,
                fontSize: '0.82rem', fontWeight: 700, lineHeight: 1.2,
                textAlign: 'center', cursor: 'default',
                border: `2px solid ${on ? c : '#e2e8f0'}`,
                background: on ? `${c}18` : '#ffffff',
                color: on ? cdk : '#475569',
                transformOrigin: 'top left',
                transform: on ? 'scale(1)' : 'translate(-30%, -30%) scale(0.25)',
                opacity: on ? 1 : 0,
                transition: 'transform 0.3s ease, opacity 0.3s ease, box-shadow 0.2s',
                boxShadow: on ? `0 0 0 3px ${c}22` : 'none',
              }}
            >{o}</button>
          );
        })}
      </div>
    );
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', marginBottom: 14, display: 'flex', justifyContent: 'flex-start' }}>
      <button
        type="button" onClick={() => setOpen(v => !v)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 10,
          padding: '10px 16px', borderRadius: 10,
          fontSize: '0.95rem', fontWeight: 800, color: cdk,
          background: `${c}18`, border: `2px solid ${c}`,
          cursor: 'pointer', letterSpacing: '0.02em',
          boxShadow: `0 0 0 3px ${c}22`,
          transition: 'all 0.15s',
          animation: 'billingTypePopIn 0.22s ease-out',
          WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation',
        }}
      >
        <span>{selected}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0,
          minWidth: 200, background: '#ffffff', border: '1px solid #e2e8f0',
          borderRadius: 10, boxShadow: '0 8px 24px rgba(15,23,42,0.10)',
          zIndex: 20, overflow: 'hidden',
        }}>
          {billingOpts.map(o => {
            const on = o === selected;
            return (
              <button
                key={o} type="button" onClick={() => pick(o)}
                style={{
                  display: 'block', width: '100%',
                  padding: '11px 14px', textAlign: 'left',
                  background: on ? `${c}12` : '#ffffff',
                  color: on ? cdk : '#334155',
                  border: 'none', cursor: 'pointer',
                  fontSize: '0.86rem', fontWeight: on ? 800 : 600,
                  borderBottom: '1px solid #f1f5f9',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >{o}</button>
            );
          })}
        </div>
      )}
      <style>{`@keyframes billingTypePopIn { from { transform: scale(0.85); opacity: 0; } to { transform: scale(1); opacity: 1; } }`}</style>
    </div>
  );
};

// Smaller section heading used inside the Declaration-of-Death sub-panel.
// Kept distinct from the top-level SHdr so visual hierarchy stays clean
// while the panel is open inside the MED-AID extras card.
const DodSubHdr = ({ t }: { t: string }) => (
  <div style={{
    fontSize: '0.72rem', fontWeight: 800, color: '#334155',
    textTransform: 'uppercase', letterSpacing: '0.08em',
    marginTop: 16, marginBottom: 10,
    paddingBottom: 6, borderBottom: '1px solid #e2e8f0',
  }}>{t}</div>
);

// Mobile-safe 2-column grid for the Declaration-of-Death panel. The DoD
// content lives 3 cards deep (MED-AID card → "More" panel → DoD panel),
// so a strict `1fr 1fr` grid squishes the inputs on narrow phones — and
// native `<input type="date">` / `<input type="time">` have an intrinsic
// min-content on iOS Safari (placeholder + picker icon) that pushes them
// past their column even when CSS `width:100%` is set. JS-based viewport
// detection sidesteps that by collapsing to a single column outright on
// any device narrower than ~480px (i.e. every phone in portrait).
const useIsNarrowViewport = (threshold = 480) => {
  const [narrow, setNarrow] = useState(
    typeof window !== 'undefined' && window.innerWidth < threshold,
  );
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < threshold);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [threshold]);
  return narrow;
};

const DodG2 = ({ children }: { children: React.ReactNode }) => {
  const narrow = useIsNarrowViewport(480);
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: narrow ? '1fr' : '1fr 1fr',
      gap: narrow ? '14px 0' : '0 12px',
    }}>{children}</div>
  );
};

// MED AID expandable extras — Resus, Declaration of Death, Quoted payout.
// Replaces the previous standalone "Quoted" toggle with a single "More" panel
// so the MED AID card stays compact until the crew explicitly needs to log
// any of these scheme-specific extras.
// Renders the main P0 Dispatch-Times TimeTable (Dispatch + On Scene rows)
// inside the DoD panel. The actual table is built at the FormContext provider
// site so it closes over the same `timestamps`, `markTime`, `kms` state as
// the rest of the form — values flow both ways without duplication.
const DodDispatchTimesEmbed = () => {
  const { renderDispatchTimes } = useContext(FormContext);
  if (typeof renderDispatchTimes !== 'function') return null;
  return <>{renderDispatchTimes()}</>;
};

// Declaration of Death form body — extracted so it can render both inside
// MedAidMore (for calls that started as DoD) and inline at the bottom of
// the clinical section on a Resus call that fails. State is shared via
// FormContext so it doesn't matter which mount point captures the data.
// `showDeclaration` toggles the Declaration sub-section (button + inline
// sign-off fields). It's hidden on the Dispatch screen so the declaration is
// only signed once, on the final phase where the DOD form is completed.
const DodFormBody = ({ showDeclaration = true }: { showDeclaration?: boolean }) => {
  const { fd, sf, sigs, setSig } = useContext(FormContext);

  useEffect(() => {
    if (!fd['med_aid_dec_death_date']) {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      sf('med_aid_dec_death_date', `${yyyy}-${mm}-${dd}`);
    }
  }, []);

  return (
    <>
      <DodG2>
        <div><Lbl t="Date" /><Inp fk="med_aid_dec_death_date" ph="YYYY-MM-DD" type="date" /></div>
        <div><Lbl t="Time Of Death" /><Inp fk="med_aid_dec_death_time" ph="HH:MM" type="time" /></div>
      </DodG2>


      <Lbl t="Precise location of body" />
      <Inp fk="med_aid_dec_death_location" ph="Where the body is located" />

      <Lbl t="Deceased Identified by (Full Name and Surname)" />
      <Inp fk="med_aid_dec_death_identified_by" ph="Identifier's full name and surname" />

      {/* Particulars of deceased — mirrors the Patient Information section's
          field set and layout so the deceased's demographics are captured to
          the same standard as a living patient. Uses deceased-specific keys
          (billing still reads the separate patient_* fields). Fields are left
          optional here because a DOD may involve an unidentified body. */}
      <DodSubHdr t="Particulars of deceased" />
      <Lbl t="Gender" />
      <Toggle fk="med_aid_dec_death_deceased_gender" opts={['Male', 'Female', 'Other']} />
      <DodG2>
        <div><Lbl t="First Name" /><Inp fk="med_aid_dec_death_deceased_first_name" ph="First name" /></div>
        <div><Lbl t="Surname" /><Inp fk="med_aid_dec_death_deceased_surname" ph="Surname" /></div>
      </DodG2>
      <DodG2>
        <div><Lbl t="ID Number" /><Inp fk="med_aid_dec_death_deceased_id" ph="13-digit SA ID" /></div>
        <div><Lbl t="Passport Number" /><Inp fk="med_aid_dec_death_deceased_passport" ph="For foreign nationals" /></div>
      </DodG2>
      <DodG2>
        <div><Lbl t="Date of Birth" /><DateInp fk="med_aid_dec_death_deceased_dob" /></div>
        <div><Lbl t="Age" /><Inp fk="med_aid_dec_death_deceased_age" ph="Age" type="number" /></div>
      </DodG2>
      <DodG2>
        <div><Lbl t="Cell" /><Inp fk="med_aid_dec_death_deceased_cell" ph="Cell" type="tel" /></div>
        <div><Lbl t="Tel (H)" /><Inp fk="med_aid_dec_death_deceased_tel_home" ph="Home" type="tel" /></div>
      </DodG2>
      <Lbl t="Tel (W)" /><Inp fk="med_aid_dec_death_deceased_tel_work" ph="Work number" type="tel" />
      <Lbl t="Residential Address" /><AddrInp fk="med_aid_dec_death_deceased_address" ph="Street address" suburbKey="med_aid_dec_death_deceased_suburb" codeKey="med_aid_dec_death_deceased_postal_code" manualOnly />
      <DodG2>
        <div><Lbl t="Suburb" /><Inp fk="med_aid_dec_death_deceased_suburb" ph="Suburb" /></div>
        <div><Lbl t="Code" /><Inp fk="med_aid_dec_death_deceased_postal_code" ph="Code" /></div>
      </DodG2>

      <DodSubHdr t="Particulars of healthcare professional" />
      <DodG2>
        <div><Lbl t="Surname" /><Inp fk="med_aid_dec_death_hcp_surname" ph="Surname" noMic /></div>
        <div><Lbl t="First Name" /><Inp fk="med_aid_dec_death_hcp_first_name" ph="First name" noMic /></div>
      </DodG2>
      <DodG2>
        <div><Lbl t="Station" /><Inp fk="med_aid_dec_death_hcp_station" ph="Station / base" noMic /></div>
        <div><Lbl t="Qualification" /><Inp fk="med_aid_dec_death_hcp_qualification" ph="e.g. ALS, Dr" noMic /></div>
      </DodG2>
      <DodG2>
        <div><Lbl t="ID No" /><Inp fk="med_aid_dec_death_hcp_id" ph="ID number" /></div>
        <div><Lbl t="Practitioner Number" /><Inp fk="med_aid_dec_death_hcp_hpcsa" ph="MP / PB number" /></div>
      </DodG2>

      <DodSubHdr t="Medical Information" />
      <Lbl t="Absent Bilateral Carotid Pulse" />
      <Inp fk="med_aid_dec_death_med_carotid" ph="" />
      <Lbl t="Absent Heart Sounds" />
      <Inp fk="med_aid_dec_death_med_heart_sounds" ph="" />
      <Lbl t="Absent Respiratory Activity" />
      <Inp fk="med_aid_dec_death_med_respiratory" ph="" />
      <Lbl t="ECG-asystole in Std Lead I, II and III" />
      <Inp fk="med_aid_dec_death_med_ecg" ph="" />
      <Lbl t="Bilaterally fixed and dilated / midpoint pupils" />
      <Inp fk="med_aid_dec_death_med_pupils" ph="" />

      <DodSubHdr t="Deceased handed over to" />
      <DodG2>
        <div><Lbl t="Surname" /><Inp fk="med_aid_dec_death_handover_surname" ph="Surname" /></div>
        <div><Lbl t="First Name" /><Inp fk="med_aid_dec_death_handover_first_name" ph="First name" /></div>
      </DodG2>
      <DodG2>
        <div><Lbl t="Relationship to deceased" /><Inp fk="med_aid_dec_death_handover_relationship" ph="e.g. Spouse, Undertaker" /></div>
        <div><Lbl t="Contact No" /><Inp fk="med_aid_dec_death_handover_contact" ph="Phone number" type="tel" /></div>
      </DodG2>
      {/* Recipient signature — stored in the PRF-level `handover_signature`
          column, which is what the certificate's "Recipient Signature" box
          renders. Only offered when the context provides the signature state
          (it always does from the main form mount). */}
      {typeof setSig === 'function' && (
        <>
          <Lbl t="Recipient Signature" />
          <div style={{ marginBottom: 14 }}>
            <FullscreenSignaturePad
              label="Recipient Signature — Deceased Handed Over"
              value={sigs?.handover_signature}
              onChange={(v: string | null) => setSig('handover_signature', v)}
            />
          </div>
        </>
      )}

      {showDeclaration && <DodDeclarationSection />}

      <DodSubHdr t="Supporting Documents" />
      <DocumentsCapture
        value={fd.med_aid_dec_death_documents}
        onChange={v => sf('med_aid_dec_death_documents', v)}
        buttonLabel={(Array.isArray(fd.med_aid_dec_death_documents) && fd.med_aid_dec_death_documents.length) ? 'Add More Documents' : 'Add Document'}
      />
    </>
  );
};

// Declaration sign-off — its OWN top-level section, rendered SEPARATELY from
// the collapsible "Declaration of Death Form" dropdown (per request) so the
// crew reads and signs the declaration outside the certificate body. State
// lives in form_data / PRF signatures, so mounting it apart from DodFormBody
// changes nothing about what's captured.
const DodDeclarationSection = () => {
  const { fd, sf } = useContext(FormContext);
  const [declarationOpen, setDeclarationOpen] = useState(false);
  return (
    <>
      <SHdr t="Declaration" />
      <button
        type="button"
        onClick={() => setDeclarationOpen(v => !v)}
        style={{
          width: '100%', padding: '15px 16px', borderRadius: 12,
          border: `2px solid ${fd.med_aid_dec_death_signature ? '#16a34a' : '#f59e0b'}`,
          background: '#ffffff',
          color: fd.med_aid_dec_death_signature ? '#15803d' : '#b45309',
          fontWeight: 900, fontSize: '0.98rem', cursor: 'pointer', letterSpacing: '0.02em',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          marginBottom: 18,
        }}
      >
        {fd.med_aid_dec_death_signature ? '✓ Declaration — Signed (tap to review)' : '⚠ Declaration — Tap to Read & Sign'}
      </button>

      {declarationOpen && (
        <div style={{
          background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12,
          padding: '16px 14px', marginBottom: 18,
        }}>
          <div style={{
            padding: '16px 18px',
            background: 'linear-gradient(135deg, rgba(245,158,11,0.12), rgba(225,29,72,0.08))',
            border: '2px solid #f59e0b', borderRadius: 12, marginBottom: 18,
            boxShadow: '0 4px 14px rgba(245,158,11,0.18)', color: '#7c2d12', lineHeight: 1.55,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              fontSize: '0.72rem', fontWeight: 900, letterSpacing: '0.12em',
              textTransform: 'uppercase', color: '#b45309', marginBottom: 10,
            }}>
              <span style={{ fontSize: '1rem' }}>⚠</span> Read Before Signing
            </div>
            <div style={{ fontSize: '0.92rem', fontWeight: 700, marginBottom: 8 }}>
              I, undersigned, hereby declare that the deceased sustained no further harm while in my care.
            </div>
            <div style={{ fontSize: '0.92rem', fontWeight: 700 }}>
              I, undersigned, hereby confirm that the above facts are to the best of my knowledge, true and correct.
            </div>
          </div>

          <Lbl t="Full name" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <GrowTa
                value={fd.med_aid_dec_death_signatory_name ?? ''}
                onChange={e => sf('med_aid_dec_death_signatory_name', e.target.value)}
                onFocus={onF} onBlur={onB} placeholder="" autoComplete="off"
                style={{ ...base, marginBottom: 0, borderColor: '#e2e8f0' }}
              />
            </div>
            <FullscreenSignaturePad
              compact label="Signature"
              value={fd.med_aid_dec_death_signature}
              onChange={v => sf('med_aid_dec_death_signature', v)}
            />
          </div>

          <Lbl t="Crew Member 2" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <GrowTa
                value={fd.med_aid_dec_death_crew_attended_name ?? ''}
                onChange={e => sf('med_aid_dec_death_crew_attended_name', e.target.value)}
                onFocus={onF} onBlur={onB} placeholder="" autoComplete="off"
                style={{ ...base, marginBottom: 0, borderColor: '#e2e8f0' }}
              />
            </div>
            <FullscreenSignaturePad
              compact label="Crew Signature"
              value={fd.med_aid_dec_death_crew_attended_signature}
              onChange={v => sf('med_aid_dec_death_crew_attended_signature', v)}
            />
          </div>

          <DodG2>
            <div><Lbl t="Date" /><Inp fk="med_aid_dec_death_signature_date" ph="YYYY-MM-DD" type="date" /></div>
            <div><Lbl t="Place" /><Inp fk="med_aid_dec_death_signature_place" ph="Place" /></div>
          </DodG2>

          <Lbl t="Witness name" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <GrowTa
                value={fd.med_aid_dec_death_witness_name ?? ''}
                onChange={e => sf('med_aid_dec_death_witness_name', e.target.value)}
                onFocus={onF} onBlur={onB} placeholder="" autoComplete="off"
                style={{ ...base, marginBottom: 0, borderColor: '#e2e8f0' }}
              />
            </div>
            <FullscreenSignaturePad
              compact label="Witness Signature"
              value={fd.med_aid_dec_death_witness_signature}
              onChange={v => sf('med_aid_dec_death_witness_signature', v)}
            />
          </div>

          <button
            type="button"
            onClick={() => setDeclarationOpen(false)}
            style={{
              width: '100%', padding: 14, borderRadius: 12, fontWeight: 800, fontSize: '0.95rem',
              border: 'none', background: 'linear-gradient(135deg,#16a34a,#15803d)', color: '#fff',
              cursor: 'pointer', marginTop: 6,
            }}
          >
            Done
          </button>
        </div>
      )}
    </>
  );
};

const MedAidMore = () => {
  const { fd, sf } = useContext(FormContext);

  // Sub-toggle button — same minimal slate→green palette as parent toggle.
  const Sub = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        width: '100%', padding: '9px 12px', borderRadius: 7,
        fontSize: '0.78rem', fontWeight: 600, letterSpacing: '0.04em',
        cursor: 'pointer', textAlign: 'left',
        border: `1px solid ${active ? '#5b8def' : '#e2e8f0'}`,
        background: active ? 'rgba(91,141,239,0.09)' : '#ffffff',
        color: active ? '#3b6fde' : '#334155',
        display: 'flex', alignItems: 'center', gap: 10,
        transition: 'all 0.15s',
      }}
    >
      <span style={{
        width: 16, height: 16, borderRadius: 4, flexShrink: 0,
        border: `1.5px solid ${active ? '#5b8def' : '#94a3b8'}`,
        background: active ? '#5b8def' : '#ffffff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#fff', fontSize: '0.65rem', fontWeight: 900,
      }}>{active ? '✓' : ''}</span>
      {children}
    </button>
  );

  // Resus / DoD sub-sections only apply when the call type is RESUS or
  // DOD, at which point the panel auto-expands. The manual "More" toggle
  // has been removed — those call types are now the sole entry point, so
  // there's nothing to expose for other call types.
  const isOpen = fd.call_type === 'DOD' || fd.call_type === 'RESUS';
  return (
    <>
      {isOpen && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Resus — hidden under Declaration of Death (the patient is
              deceased so a resus billing line doesn't apply), EXCEPT when
              the call started as a Resus that subsequently failed —
              we keep the resus billing line visible so the resus attempt
              is still billed.
              For Resus call types the Sub-toggle is hidden and the body
              is auto-expanded: ticking "Resus" on a Resus call would be
              redundant, and the call type itself implies the section. */}
          {(!fd.med_aid_dec_death || fd.call_type === 'RESUS') && (
            <div>
              {fd.call_type !== 'RESUS' && (
                <Sub active={!!fd.med_aid_resus} onClick={() => sf('med_aid_resus', !fd.med_aid_resus)}>
                  Resus
                </Sub>
              )}
              {(fd.med_aid_resus || fd.call_type === 'RESUS') && (
                <div style={{ marginTop: 8, paddingLeft: fd.call_type === 'RESUS' ? 0 : 12, borderLeft: fd.call_type === 'RESUS' ? 'none' : `2px solid #e2e8f0` }}>
                  {fd.call_type !== 'RESUS' && (
                    <>
                      <Lbl t="Resus Level" />
                      <Toggle fk="med_aid_resus_level" opts={['ILS', 'ALS']} size="sm" />
                    </>
                  )}
                  <DodDispatchTimesEmbed />
                  {fd.call_type !== 'RESUS' && (
                    <>
                      <Lbl t="Fee Amount (R)" />
                      <Inp fk="med_aid_resus_fee" ph="0.00" type="number" />
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Declaration of Death is NOT rendered here anymore. For a DOD call
              type the certificate is its own top-level "Declaration of Death"
              section on the PT-INFO phase (split out from this Debtor / medical-
              aid card so the two aren't visually merged). For RESUS the DoD form
              is surfaced inline at the bottom of the clinical section. */}

          {/* Quoted is captured as an IFT/IHT subtype on the Call Type
              picker — not repeated here. */}
        </div>
      )}
    </>
  );
};

const RafSketchPad = () => {
  const { fd, sf } = useContext(FormContext);
  const has = !!fd.raf_sketch;
  const [open, setOpen] = useState(has);
  return (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-pressed={open}
        title="Sketch the accident scene"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 600,
          cursor: 'pointer',
          border: `1px solid ${open || has ? '#5b8def' : '#e2e8f0'}`,
          background: open || has ? 'rgba(91,141,239,0.09)' : '#ffffff',
          color: open || has ? '#3b6fde' : '#475569',
          transition: 'all 0.15s',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 19l7-7 3 3-7 7-3-3z" />
          <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
          <path d="M2 2l7.586 7.586" />
          <circle cx="11" cy="11" r="2" />
        </svg>
        {has ? 'Edit accident sketch' : 'Sketch accident scene'}
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          <SignaturePad
            label="Accident Sketch"
            height={220}
            value={fd.raf_sketch}
            onChange={v => sf('raf_sketch', v)}
          />
        </div>
      )}
    </div>
  );
};

const Chk = ({ fk, val, label, disabled, hint }: { fk: string; val: string; label?: string; disabled?: boolean; hint?: string }) => {
  const { inArr, toggleArr } = useContext(FormContext);
  const on = inArr(fk, val);
  // When disabled (HPCSA scope), render as a non-interactive pill with a
  // small inline reason. Never silently strip an already-on selection — that
  // would erase audit data. If the value is on and now out-of-scope (treating
  // practitioner was changed mid-call), surface that with an amber accent so
  // it can be reviewed; if off, render greyed.
  if (disabled) {
    const accent = on ? '#f59e0b' : '#cbd5e1';
    const tint = on ? '#fffbeb' : '#f8fafc';
    const text = on ? '#78350f' : '#94a3b8';
    return (
      <button type="button" disabled aria-disabled="true" style={{ padding: '11px 14px', borderRadius: 10, width: '100%', textAlign: 'left', border: `1.5px dashed ${accent}`, background: tint, color: text, fontWeight: on ? 700 : 500, fontSize: '0.85rem', cursor: 'not-allowed', display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: 10, rowGap: 4, alignItems: 'center' }}>
        <span style={{ width: 18, height: 18, borderRadius: 5, border: `2px solid ${accent}`, background: on ? accent : '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ffffff', fontSize: '0.7rem', fontWeight: 900 }}>{on ? '✓' : ''}</span>
        <span style={{ minWidth: 0, overflowWrap: 'break-word' }}>{label || val}</span>
        <span style={{ gridColumn: '2', justifySelf: 'start', fontSize: '0.62rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: text, background: '#fff', border: `1px solid ${accent}`, padding: '2px 6px', borderRadius: 4 }}>
          {hint || 'Out of scope'}
        </span>
      </button>
    );
  }
  return (
    <div>
      <button type="button" onClick={() => toggleArr(fk, val)} style={{ padding: '11px 14px', borderRadius: 10, width: '100%', textAlign: 'left', border: `1.5px solid ${on ? '#5b8def' : '#e2e8f0'}`, background: on ? 'rgba(91,141,239,0.09)' : '#ffffff', color: on ? '#3b6fde' : '#0f172a', fontWeight: on ? 700 : 500, fontSize: '0.85rem', cursor: 'pointer', transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: 10, boxShadow: on ? `0 0 0 2px rgba(91,141,239,0.13)` : '0 1px 2px rgba(0,0,0,0.02)' }}>
        <span style={{ width: 18, height: 18, borderRadius: 5, border: `2px solid ${on ? '#5b8def' : '#94a3b8'}`, background: on ? '#5b8def' : '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#ffffff', fontSize: '0.7rem', fontWeight: 900 }}>{on ? '✓' : ''}</span>
        {label || val}
      </button>
      {hint && (
        <div style={{ fontSize: '0.65rem', color: '#92400e', marginTop: 3, paddingLeft: 6, fontWeight: 600 }}>
          {hint}
        </div>
      )}
    </div>
  );
};

// Scope-gated free-text field. Wraps the standard `Inp` for use on fields
// that are themselves a procedure marker (e.g. "NG Tube Size", "No. IV
// Attempts") — when the treating practitioner's HPCSA category isn't
// authorised for `capabilityKey`, the input is replaced with a non-editable
// pill that preserves any pre-existing value and surfaces an out-of-scope
// badge. Mirrors the `Chk` disabled-state pattern.
const ScopedInp = ({ fk, capabilityKey, ph, type = 'text', noMic }: {
  fk: string; capabilityKey: string; ph?: string; type?: string; noMic?: boolean;
}) => {
  const { fd } = useContext(FormContext);
  const cat = normaliseHpcsaCategory(fd.treating_practitioner_category);
  const ok = !cat || isAuthorised(cat, capabilityKey);
  if (ok) return <Inp fk={fk} ph={ph} type={type} noMic={noMic} />;
  const existing = fd[fk];
  const accent = existing ? '#f59e0b' : '#cbd5e1';
  const tint = existing ? '#fffbeb' : '#f8fafc';
  const text = existing ? '#78350f' : '#94a3b8';
  return (
    <div style={{
      padding: '11px 14px', borderRadius: 10, marginBottom: 8,
      border: `1.5px dashed ${accent}`, background: tint, color: text,
      fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between',
    }}>
      <span style={{ flex: 1, minWidth: 0 }}>{existing || 'No value entered'}</span>
      <span style={{
        fontSize: '0.62rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em',
        background: '#fff', border: `1px solid ${accent}`, padding: '2px 6px', borderRadius: 4,
        whiteSpace: 'nowrap', flexShrink: 0,
      }}>
        Out of scope for {cat}
      </span>
    </div>
  );
};

// (StickerCapture moved to the doctor portal page — the receiving doctor
// photographs and crops the hospital sticker, not the crew.)

// PDF drop zone — accepts a single PDF via drag-drop or file picker, stores
// it as a base64 data URL inside form_data so it persists with the existing
// PRF save flow (no separate upload endpoint needed).
const PdfDrop = ({ fk, label = 'OAR Report (PDF)' }: { fk: string; label?: string }) => {
  const { fd, sf } = useContext(FormContext);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const file = fd[fk] as { name: string; size: number; data_url: string } | undefined;
  const inputId = `pdfdrop-${fk}`;

  const handleFile = (f: File | null) => {
    setErr('');
    if (!f) return;
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      setErr('Only PDF files are accepted.'); return;
    }
    if (f.size > 10 * 1024 * 1024) { setErr('File exceeds 10 MB.'); return; }
    setBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      sf(fk, { name: f.name, size: f.size, data_url: String(reader.result) });
      setBusy(false);
    };
    reader.onerror = () => { setErr('Failed to read file.'); setBusy(false); };
    reader.readAsDataURL(f);
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <Lbl t={label} />
      {file ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 10, border: '1.5px solid #5b8def', background: 'rgba(91,141,239,0.08)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
            <div style={{ fontSize: '0.7rem', color: '#475569', marginTop: 2 }}>{(file.size / 1024).toFixed(1)} KB · attached</div>
          </div>
          <button type="button" onClick={() => sf(fk, undefined)} style={{ padding: '6px 12px', borderRadius: 8, fontSize: '0.72rem', fontWeight: 700, border: '1px solid #e2e8f0', background: '#fff', color: '#ef4444', cursor: 'pointer' }}>Remove</button>
        </div>
      ) : (
        <label htmlFor={inputId}
          onDragOver={e => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files?.[0] || null); }}
          style={{
            display: 'block', textAlign: 'center', padding: '20px 14px', borderRadius: 10,
            border: `2px dashed ${drag ? '#5b8def' : '#cbd5e1'}`,
            background: drag ? 'rgba(91,141,239,0.08)' : '#f8fafc',
            cursor: 'pointer', transition: 'all 0.12s',
          }}
        >
          <div style={{ fontSize: '0.86rem', fontWeight: 700, color: '#334155' }}>Drop PDF here, or tap to choose</div>
          <div style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: 4 }}>{busy ? 'Reading file…' : 'Max 10 MB · PDF only'}</div>
        </label>
      )}
      <input id={inputId} type="file" accept="application/pdf,.pdf" onChange={e => handleFile(e.target.files?.[0] || null)} style={{ display: 'none' }} />
      {err && <div style={{ fontSize: '0.72rem', color: '#ef4444', marginTop: 6, fontWeight: 600 }}>{err}</div>}
    </div>
  );
};

const SHdr = ({ t, c = '#3b6fde' }: { t: string; c?: string }) => (
  <div style={{ fontSize: '0.72rem', fontWeight: 800, color: c, textTransform: 'uppercase', letterSpacing: '0.1em', borderBottom: `2px solid ${c}28`, paddingBottom: 8, marginBottom: 16, marginTop: 6 }}>{t}</div>
);

const Card = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <div style={{ background: '#ffffff', borderRadius: 14, border: `1.5px solid #e2e8f0`, boxShadow: '0 1px 4px rgba(0,0,0,0.04)', padding: 18, marginBottom: 16, ...style }}>{children}</div>
);

// `minmax(0, 1fr)` rather than `1fr` so the implicit `auto` (min-content) track
// minimum can't expand: native `<input type="time">` / `<input type="date">` on
// iOS Safari have an intrinsic min-content (picker chrome + 16px font from the
// auto-zoom guard in index.css) that otherwise pushes each track past half the
// container, blowing the whole form past the viewport on phone widths.
const G2 = ({ children }: { children: React.ReactNode }) => {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: isMobile ? '12px' : '0 12px' }}>
      {children}
    </div>
  );
};

// ── Quick Vitals Overlay ────────────────────────────────────────────────────
// Module-scope so its identity stays stable across parent re-renders.
// Holds its own draft state via useState; parent passes callbacks for close/save.
function QuickVitalsOverlay({ onClose, onSave }: { onClose: () => void; onSave: (v: any) => void }) {
  const [qv, setQv] = useState<any>(() => {
    const t = new Date();
    return { time: `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` };
  });
  const gcsT = (+qv.gcs_e || 0) + (+qv.gcs_v || 0) + (+qv.gcs_m || 0);
  const save = () => {
    const final = { ...qv };
    if (qv.gcs_e && qv.gcs_v && qv.gcs_m) final.gcs_total = String(gcsT);
    onSave(final);
  };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div style={{ background: W, borderRadius: '20px 20px 0 0', padding: 24, maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ fontWeight: 900, fontSize: '1.05rem', color: S900 }}>Quick Vitals</div>
          <button type="button" onClick={onClose} style={{ background: S100, border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: '0.8rem', fontWeight: 700, color: S600, cursor: 'pointer' }}>Cancel</button>
        </div>
        <Lbl t="Time" />
        <input type="time" value={qv.time ?? ''} onChange={e => setQv((p: any) => ({ ...p, time: e.target.value }))} onFocus={onF} onBlur={onB} style={{ ...base, marginBottom: 14 }} />
        <G2>
          {[{ l: 'HR', k: 'hr', t: 'number', ph: 'bpm' }, { l: 'BP', k: 'bp', ph: '120/80' }, { l: 'SpO\u2082%', k: 'spo2', t: 'number', ph: '%' }, { l: 'Resp Rate', k: 'resp_rate', t: 'number', ph: '/min' }].map(f => (
            <div key={f.k}><Lbl t={f.l} /><input type={f.t || 'text'} value={qv[f.k] ?? ''} onChange={e => setQv((p: any) => ({ ...p, [f.k]: e.target.value }))} placeholder="" autoComplete="off" onFocus={onF} onBlur={onB} style={{ ...base, marginBottom: 14 }} /></div>
          ))}
        </G2>
        <Lbl t="Pain /10" />
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 14 }}>
          {['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map(o => { const on = qv.pain === o; return <button key={o} type="button" onClick={() => setQv((p: any) => ({ ...p, pain: o }))} style={{ padding: '9px 10px', borderRadius: 8, fontSize: '0.8rem', fontWeight: 700, border: `2px solid ${on ? G : S200}`, background: on ? GBG : W, color: on ? GDK : S600, cursor: 'pointer' }}>{o}</button>; })}
        </div>
        <Lbl t="GCS \u2014 Eyes / Voice / Motor" />
        {[{ l: 'Eyes (4)', k: 'gcs_e', opts: ['1', '2', '3', '4'] }, { l: 'Voice (5)', k: 'gcs_v', opts: ['1', '2', '3', '4', '5'] }, { l: 'Motor (6)', k: 'gcs_m', opts: ['1', '2', '3', '4', '5', '6'] }].map(f => (
          <div key={f.k} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: '0.65rem', fontWeight: 700, color: S600, marginBottom: 5 }}>{f.l}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {f.opts.map(o => { const on = qv[f.k] === o; return <button key={o} type="button" onClick={() => setQv((p: any) => ({ ...p, [f.k]: o }))} style={{ padding: '8px 12px', borderRadius: 8, fontSize: '0.82rem', fontWeight: 700, border: `2px solid ${on ? G : S200}`, background: on ? GBG : W, color: on ? GDK : S600, cursor: 'pointer' }}>{o}</button>; })}
            </div>
          </div>
        ))}
        {gcsT > 0 && (
          <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 10, background: `${gcsT < 9 ? REDC : gcsT < 14 ? AMB : G}15`, border: `1.5px solid ${gcsT < 9 ? REDC : gcsT < 14 ? AMB : G}40` }}>
            <span style={{ fontWeight: 800, color: gcsT < 9 ? REDC : gcsT < 14 ? AMB : GDK }}>GCS {gcsT}/15 — {gcsT < 9 ? 'Severe' : gcsT < 14 ? 'Moderate' : 'Normal'}</span>
          </div>
        )}
        <button type="button" onClick={save} style={{ width: '100%', padding: 16, borderRadius: 12, fontWeight: 800, fontSize: '1rem', border: 'none', background: `linear-gradient(135deg,${G},${GDK})`, color: W, cursor: 'pointer', boxShadow: `0 4px 14px ${G}30` }}>Save Vitals</button>
      </div>
    </div>
  );
}

// ── Geo-Capture Confirmation Overlay ────────────────────────────────────────
// Shown after the crew taps "Mark Time" on a journey timestamp. Displays the
// captured GPS coordinates (or the failure reason) so the crew can confirm
// they're correct before the timestamp is committed. If GPS is unavailable
// the crew can still proceed without coords — capturing location must never
// block an active call.
function GeoConfirmOverlay({
  label, capturing, coords, error,
  geocoding, address, geocodeError, targetFieldLabel, targetFieldOccupied,
  onConfirm, onRecapture, onCancel,
}: {
  label: string;
  capturing: boolean;
  coords: { latitude: number; longitude: number; accuracy: number } | null;
  error: string | null;
  geocoding: boolean;
  address: { street: string; suburb: string | null } | null;
  geocodeError: string | null;
  // The form field this address would auto-fill (e.g. "Incident Address").
  // Undefined when this timestamp has no associated address field.
  targetFieldLabel?: string;
  // True when that field already has a value the crew typed — we don't
  // overwrite, but we still show the resolved address so they can compare.
  targetFieldOccupied: boolean;
  onConfirm: (manualAddress?: string) => void;
  onRecapture: () => void;
  onCancel: () => void;
}) {
  const [manualAddress, setManualAddress] = useState('');
  const gpsUnavailable = !capturing && !coords;
  const permissionDenied = error === 'Location permission denied';
  // iPadOS 13+ reports as "MacIntel" — the touch-points check catches it.
  const isIOS = typeof navigator !== 'undefined' && (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 250, background: 'rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div style={{ background: W, borderRadius: '20px 20px 0 0', padding: 24, maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ fontWeight: 900, fontSize: '1.05rem', color: S900 }}>Confirm Location · {label}</div>
          <button type="button" onClick={onCancel} style={{ background: S100, border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: '0.8rem', fontWeight: 700, color: S600, cursor: 'pointer' }}>Cancel</button>
        </div>

        {capturing && (
          <div style={{ padding: '24px 16px', textAlign: 'center', background: GBG, borderRadius: 12, border: `1.5px solid ${G}40`, marginBottom: 16 }}>
            <div style={{ fontSize: '0.95rem', fontWeight: 800, color: GDK, marginBottom: 6 }}>📍 Capturing GPS…</div>
            <div style={{ fontSize: '0.78rem', color: S600 }}>Hold still for a moment for an accurate fix.</div>
          </div>
        )}

        {gpsUnavailable && (
          <>
            <div style={{ padding: 16, background: '#fef2f2', borderRadius: 12, border: `1.5px solid ${REDC}40`, marginBottom: 16 }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 800, color: REDC, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Location unavailable</div>
              <div style={{ fontSize: '0.85rem', color: S700, marginBottom: 6 }}>{error || 'No GPS coordinates were captured.'}</div>
              {permissionDenied ? (
                <div style={{ fontSize: '0.75rem', color: S600 }}>
                  Tap <strong>↻ Re-capture</strong> below and choose <strong>Allow</strong> when asked for location.
                  {isIOS && <> If no prompt appears, open <strong>Settings → Privacy &amp; Security → Location Services</strong>, make sure it's <strong>On</strong> and <strong>Safari Websites</strong> is set to <strong>While Using the App</strong>, then reload this page.</>}
                  {' '}Or enter the address manually below.
                </div>
              ) : (
                <div style={{ fontSize: '0.75rem', color: S600 }}>Tap <strong>↻ Re-capture</strong> to try again, or enter the address manually below and tap <strong>Confirm &amp; Mark Time</strong>.</div>
              )}
            </div>

            {/* Manual address entry when GPS fails */}
            <div style={{ background: '#f8fafc', padding: '16px 14px', borderRadius: 16, border: `1.5px solid ${S200}`, marginBottom: 16 }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 800, color: S600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                {targetFieldLabel || 'Location'} (manual entry)
              </div>
              <input
                type="text"
                value={manualAddress}
                onChange={e => setManualAddress(e.target.value)}
                onFocus={onF}
                onBlur={onB}
                placeholder="e.g. 12 Main Street, Sandton"
                autoComplete="off"
                style={{ ...base, background: W, borderColor: '#cbd5e1', width: '100%', marginBottom: 0 }}
              />
            </div>
          </>
        )}

        {/* ── Resolved street address (shown when GPS succeeded) ── */}
        {coords && (
          <div style={{ padding: 16, background: '#eff6ff', borderRadius: 12, border: `1.5px solid #93c5fd`, marginBottom: 16 }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 800, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
              {targetFieldLabel || 'Street Address'}
            </div>
            {geocoding && (
              <div style={{ fontSize: '0.85rem', color: '#1e3a8a', fontStyle: 'italic' }}>Looking up street address…</div>
            )}
            {!geocoding && address && (
              <>
                <div style={{ fontSize: '0.95rem', fontWeight: 700, color: S900, marginBottom: 6 }}>{address.street}</div>
                {targetFieldLabel && targetFieldOccupied && (
                  <div style={{ fontSize: '0.72rem', color: '#92400e' }}>
                    {`"${targetFieldLabel}" already has a value — your existing entry will be kept. Review above and edit the field manually if needed.`}
                  </div>
                )}
              </>
            )}
            {!geocoding && !address && (
              <div style={{ fontSize: '0.82rem', color: S700 }}>
                {geocodeError || 'Could not resolve a street address for this location.'}
              </div>
            )}
          </div>
        )}

        <div style={{ marginBottom: 10 }}>
          <button
            type="button"
            // iOS Safari only shows the native location prompt when
            // getCurrentPosition fires as a DIRECT result of this tap. An
            // intervening alert() breaks that user-gesture chain and causes a
            // silent denial, so re-request immediately with no dialog first.
            // Guidance for the hard-denied case lives in the panel above.
            onClick={onRecapture}
            disabled={capturing}
            style={{ width: '100%', padding: '12px 0', borderRadius: 10, fontWeight: 800, fontSize: '0.85rem', border: `2px solid ${S200}`, background: W, color: S700, cursor: capturing ? 'not-allowed' : 'pointer', opacity: capturing ? 0.5 : 1 }}
          >
            ↻ Re-capture
          </button>
        </div>
        <button
          type="button"
          onClick={() => onConfirm(gpsUnavailable ? (manualAddress.trim() || undefined) : undefined)}
          disabled={capturing}
          style={{
            width: '100%', padding: 16, borderRadius: 12, fontWeight: 800, fontSize: '1rem',
            border: 'none',
            background: capturing ? S200 : `linear-gradient(135deg,${G},${GDK})`,
            color: capturing ? S600 : W,
            cursor: capturing ? 'not-allowed' : 'pointer',
            boxShadow: capturing ? 'none' : `0 4px 14px ${G}30`,
          }}
        >
          ✓ Confirm &amp; Mark Time
        </button>
      </div>
    </div>
  );
}

const FadeIn = ({ children, show, delay = 0 }: { children: React.ReactNode; show: boolean; delay?: number }) => {
  const [visible, setVisible] = useState(false);
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  
  // Scale down delay for mobile to make it super snappy (max 50ms)
  const activeDelay = isMobile ? Math.min(delay, 50) : delay;
  const duration = isMobile ? '0.18s' : '0.28s';
  const translateAmt = isMobile ? '6px' : '10px';

  useEffect(() => {
    if (show) {
      const t = setTimeout(() => setVisible(true), activeDelay);
      return () => clearTimeout(t);
    }
    setVisible(false);
  }, [show, activeDelay]);

  if (!show && !visible) return null;
  return (
    <div style={{
      opacity: visible ? 1 : 0,
      transform: visible ? 'translateY(0)' : `translateY(${translateAmt})`,
      transition: `opacity ${duration} cubic-bezier(0.25, 1, 0.5, 1), transform ${duration} cubic-bezier(0.25, 1, 0.5, 1)`,
      pointerEvents: visible ? 'auto' : 'none',
      position: 'relative',
      zIndex: visible ? 1 : 0,
    }}>
      {children}
    </div>
  );
};

// ── Portal Modal ────────────────────────────────────────────────────────────
// ALL pop-up overlays MUST use this component. It renders into document.body
// via React Portal, which guarantees position:fixed is relative to the viewport
// and not broken by any parent CSS (backdrop-filter, transform, overflow, etc.).
// This permanently prevents the mobile "cursor misalignment" bug.
const Modal = ({ open, onClose, children, dismissOnBackdrop = true, centerOnMobile = false }: { open: boolean; onClose: () => void; children: React.ReactNode; dismissOnBackdrop?: boolean; centerOnMobile?: boolean }) => {
  useScrollLock(open);   // block scrolling of the page behind this pop-up
  // Track the VISUAL viewport so the overlay follows what the user actually
  // sees when the mobile keyboard opens. Without this, the position:fixed
  // overlay fills the taller LAYOUT viewport while the visible area is offset,
  // so taps land on the wrong control (e.g. Start Route instead of the odometer
  // field). This is the Chrome-mobile "click misalignment" the crew hit.
  const [vv, setVv] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    if (!open || typeof window === 'undefined' || !window.visualViewport) { setVv(null); return; }
    const vp = window.visualViewport;
    const update = () => setVv({ top: vp.offsetTop, height: vp.height });
    update();
    vp.addEventListener('resize', update);
    vp.addEventListener('scroll', update);
    return () => { vp.removeEventListener('resize', update); vp.removeEventListener('scroll', update); };
  }, [open]);

  // Auto-focus the first text field so the keyboard comes up without an extra
  // tap (Android/desktop raise it immediately; on iOS the field is focused and
  // ready — iOS's user-gesture rule may still want one tap to lift the keyboard).
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      contentRef.current?.querySelector<HTMLElement>('input:not([type="hidden"]), textarea')?.focus();
    }, 80);
    return () => clearTimeout(t);
  }, [open]);

  if (!open) return null;
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  // Keyboard is up when the visual viewport is much shorter than the layout
  // viewport — then anchor the tile to the BOTTOM of the visible area so it sits
  // right above the keyboard instead of floating at the top with a big gap.
  const keyboardOpen = !!vv && typeof window !== 'undefined' && (window.innerHeight - vv.height) > 120;
  // Anchor to the visual viewport when available (keyboard-safe on mobile),
  // otherwise fall back to filling the layout viewport.
  const anchor = vv
    ? { position: 'fixed' as const, top: vv.top, left: 0, width: '100%', height: vv.height }
    : { position: 'fixed' as const, inset: 0 };
  return ReactDOM.createPortal(
    <div
      style={{
        ...anchor, zIndex: 99999,
        background: 'rgba(15,23,42,0.6)',
        backdropFilter: 'blur(4px)',
        display: 'flex', flexDirection: 'column',
        // Mobile modals normally anchor to the top so a keyboard-driven field
        // (e.g. odometer) stays put; centerOnMobile opts a keyboard-less card
        // (e.g. Assessment Level) into vertical centering so it isn't cramped
        // against the top of the screen.
        justifyContent: isMobile
          ? (keyboardOpen ? 'flex-end' : (centerOnMobile ? 'center' : 'flex-start'))
          : 'center',
        alignItems: 'center',
        padding: 20,
        paddingTop: keyboardOpen ? 12 : (isMobile ? 40 : 20),
        paddingBottom: keyboardOpen ? 12 : 20,
        boxSizing: 'border-box',
        overflowY: 'auto',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
      }}
      onClick={e => { if (dismissOnBackdrop && e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={contentRef}
        style={{
          background: '#f8fafc', borderRadius: 24,
          padding: '24px 16px', width: '100%', maxWidth: 500,
          // border-box so width:100% + padding doesn't exceed the container and
          // push content sideways.
          boxSizing: 'border-box',
          maxHeight: '100%', display: 'flex', flexDirection: 'column',
          // Let tall modal content (e.g. the Declaration-of-Death form: warning
          // + fields + signature pad) scroll INSIDE the card instead of
          // overflowing off the bottom of the pop-up on short mobile screens.
          // Lock the horizontal axis: overflow-y:auto would otherwise promote
          // overflow-x to auto too, letting the user throw fields left/right.
          overflowY: 'auto',
          overflowX: 'hidden',
          WebkitOverflowScrolling: 'touch',
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body
  );
};

const CTA = ({ label, color = '#0f172a', onClick }: { label: string; color?: string; onClick: () => void }) => {
  const isPrimary = color === '#0f172a' || color === '#22c55e';
  const bg = isPrimary ? '#0f172a' : color;
  const shadow = isPrimary ? 'rgba(15, 23, 42, 0.25)' : `${color}40`;
  
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        padding: '18px 24px',
        borderRadius: 16,
        fontSize: '1.05rem',
        fontWeight: 700,
        border: `1px solid ${isPrimary ? '#1e293b' : 'transparent'}`,
        background: bg,
        color: '#ffffff',
        cursor: 'pointer',
        marginTop: 16,
        boxShadow: `0 4px 12px ${shadow}`,
        letterSpacing: '0.03em',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
        WebkitTapHighlightColor: 'transparent',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-2px)';
        (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 8px 24px ${shadow}`;
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.transform = 'none';
        (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 4px 12px ${shadow}`;
      }}
      onMouseDown={e => {
        (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(1px)';
        (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 2px 8px ${shadow}`;
      }}
    >
      <span>{label.replace('→', '').replace('  ', ' ').trim()}</span>
      <span style={{ fontSize: '1.2rem', fontWeight: 600 }}>→</span>
    </button>
  );
};

const EnRouteOverlay = ({ dispatchedAt, onDoubleTap }: { dispatchedAt: string; onDoubleTap: () => void }) => {
  const [, tick] = useState(0);
  const lastTapRef = useRef<number>(0);
  // A double-tap can happen by accident (phone in a pocket, a fumbled tap), so
  // we confirm the arrival was intentional before actually marking On Scene.
  const [confirmOpen, setConfirmOpen] = useState(false);

  // ── Timer anchor ─────────────────────────────────────────────────────────
  // dispatchedAt is the SERVER's stamp but the ticking clock is the PHONE's.
  // A phone clock that lags the server (bad NTP is common on field tablets)
  // made `now - dispatchedAt` negative, so the display started at "-1:-1" and
  // could count backwards. Fix: anchor once on mount — start from the true
  // elapsed when it's positive (resume after reload), else 00:00 — and advance
  // on performance.now(), which is monotonic (immune to the phone clock being
  // adjusted mid-run). The wall-clock diff is still consulted each tick so the
  // timer catches up forward after a device sleep, but the shown value is
  // clamped to never be negative and never decrease.
  const anchorRef = useRef<{ initial: number; perf0: number } | null>(null);
  if (anchorRef.current === null) {
    const parsed = new Date(dispatchedAt).getTime();
    const wallDiff = Math.floor((Date.now() - parsed) / 1000);
    anchorRef.current = {
      initial: Number.isFinite(wallDiff) ? Math.max(0, wallDiff) : 0,
      perf0: performance.now(),
    };
  }
  const lastShownRef = useRef(0);

  useEffect(() => {
    const id = setInterval(() => tick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const parsedDispatch = new Date(dispatchedAt).getTime();
  const wall = Number.isFinite(parsedDispatch)
    ? Math.floor((Date.now() - parsedDispatch) / 1000)
    : 0;
  const mono = anchorRef.current.initial
    + Math.floor((performance.now() - anchorRef.current.perf0) / 1000);
  const elapsed = Math.max(0, mono, wall, lastShownRef.current);
  lastShownRef.current = elapsed;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  const handleTap = () => {
    if (confirmOpen) return;   // ignore background taps while confirming
    const now = Date.now();
    if (now - lastTapRef.current < 400) {
      setConfirmOpen(true);
    }
    lastTapRef.current = now;
  };

  return (
    <div
      onClick={handleTap}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999, background: '#0f172a', display: 'flex',
        flexDirection: 'column', justifyContent: 'center', alignItems: 'center', color: '#ffffff',
        userSelect: 'none', WebkitUserSelect: 'none'
      }}
    >
      <div style={{ fontSize: '1rem', fontWeight: 700, color: '#94a3b8', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 20 }}>
        En Route to Scene
      </div>
      <div style={{ fontSize: '5rem', fontWeight: 900, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em', textShadow: '0 0 40px rgba(91,141,239,0.3)', color: '#5b8def' }}>
        {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
      </div>
      <div style={{ marginTop: 40, padding: '16px 24px', background: 'rgba(255,255,255,0.05)', borderRadius: 100, backdropFilter: 'blur(10px)', color: '#94a3b8', fontSize: '0.9rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 10, animation: 'pulse 2s infinite' }}>
        <div style={{ width: 10, height: 10, borderRadius: 5, background: '#5b8def' }} />
        Double tap anywhere when on scene
      </div>

      {/* Purposeful-action confirmation — guards against an accidental double-tap
          marking arrival on scene before the crew actually arrived. */}
      {confirmOpen && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: 'absolute', inset: 0, zIndex: 1,
            background: 'rgba(15,23,42,0.72)', backdropFilter: 'blur(2px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
          }}
        >
          <div style={{
            width: '100%', maxWidth: 360, background: '#ffffff', borderRadius: 16,
            padding: 24, textAlign: 'center', boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
          }}>
            <div style={{ fontSize: '1.15rem', fontWeight: 900, color: '#0f172a', marginBottom: 8 }}>
              Arrived on scene?
            </div>
            <div style={{ fontSize: '0.9rem', color: '#475569', lineHeight: 1.5, marginBottom: 20 }}>
              Confirm you meant to mark arrival — a double-tap can happen by accident.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                style={{
                  flex: 1, padding: '12px 14px', borderRadius: 10,
                  border: '1.5px solid #cbd5e1', background: '#fff', color: '#334155',
                  fontSize: '0.9rem', fontWeight: 800, cursor: 'pointer', touchAction: 'manipulation',
                }}
              >
                Not yet
              </button>
              <button
                type="button"
                onClick={onDoubleTap}
                style={{
                  flex: 1, padding: '12px 14px', borderRadius: 10, border: 'none',
                  background: '#5b8def', color: '#fff',
                  fontSize: '0.9rem', fontWeight: 800, cursor: 'pointer', touchAction: 'manipulation',
                }}
              >
                Yes, we've arrived
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};


// ── Loaded-data normalization ────────────────────────────────────────────────
// The backend can hand back fields whose runtime type differs from what the form
// assumes: DB columns are numeric, and the OCR/extraction pipeline pre-fills
// form_data with whatever it parsed. TypeScript can't catch this — the API
// response is `any` — so a single field arriving as a number where the UI calls
// `.trim()`/`.split()` used to throw a ReferenceError and the ErrorBoundary took
// down the whole form (e.g. a numeric `rht_call_out_fee`, or `km_dispatched`).
//
// Coerce every field the UI consumes as text/list to the right type here, at the
// one load boundary, so that entire class of crash can't recur.
//
// ⚠️  When you add a field the form treats as text or a list, add its key to the
//     matching set below. This is the single place that guarantees its type.
const PRF_TEXT_FIELDS = [
  'allergies', 'handover_doctor_email', 'medical_scheme',
  'preauth_number', 'rht_call_out_fee',
];
const PRF_ARRAY_FIELDS = [
  'airway_interventions', 'circulation_interventions',
  'km_review_flags', 'med_aid_dec_death_documents',
];

function normalizeFormData(data: Record<string, any>): Record<string, any> {
  const out = { ...(data || {}) };
  for (const k of PRF_TEXT_FIELDS) {
    // Leave null/undefined (callers guard with `|| ''`); stringify anything that
    // isn't already a string so string methods are always safe. These are all
    // free-text/identifier fields — none are 0/1 flags, so String() is lossless.
    if (out[k] != null && typeof out[k] !== 'string') out[k] = String(out[k]);
  }
  for (const k of PRF_ARRAY_FIELDS) {
    // A non-array here means corrupt/legacy data; the UI iterates these, so an
    // empty array degrades gracefully instead of crashing on `.map`.
    if (out[k] != null && !Array.isArray(out[k])) out[k] = [];
  }
  return out;
}

export default function DigitalPRFForm() {
  const { prfId, providerSlug } = useParams<{ prfId: string; providerSlug: string }>();
  const navigate = useNavigate();

  const [phase, setPhase] = useState(0);
  // Highest phase the crew has reached so far. The stepper hides nodes ahead
  // of this so future phases only appear once the crew actually unlocks them
  // by advancing forward. Backward navigation doesn't shrink it.
  const [maxPhase, setMaxPhase] = useState(0);
  useEffect(() => {
    setMaxPhase(prev => (phase > prev ? phase : prev));
  }, [phase]);

  const forceScrollToTop = () => {
    if (typeof window === 'undefined') return;
    const docEl = document.documentElement;
    const originalBehavior = docEl ? docEl.style.scrollBehavior : '';
    if (docEl) docEl.style.scrollBehavior = 'auto';

    const performScroll = () => {
      window.scrollTo(0, 0);
      if (docEl) docEl.scrollTop = 0;
      if (document.body) document.body.scrollTop = 0;
    };

    performScroll();
    requestAnimationFrame(performScroll);
    setTimeout(performScroll, 50);
    setTimeout(performScroll, 150);
    setTimeout(performScroll, 300);

    setTimeout(() => {
      if (docEl) docEl.style.scrollBehavior = originalBehavior;
    }, 400);
  };

  // When the crew advances or steps back through the journey, the new phase
  // should always land at the top of the screen — not wherever the previous
  // phase happened to be scrolled to. Without this, navigating from Clinical
  // (a long phase) to Transport drops the user mid-page, looking blank.
  useEffect(() => {
    forceScrollToTop();
  }, [phase]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      // Don't collapse/expand the sticky journey header while an input is
      // focused. On mobile the keyboard scrolls the page around the 40px
      // threshold, and resizing the header mid-type reflows the layout — that's
      // the "page jumps up and down while typing in the vitals set" bug.
      // Also freeze the header while a mic is held: dictation focuses the mic
      // BUTTON (not the field), so the input-focus check below misses it, and a
      // header reflow mid-dictation jumps the page and cancels the recogniser.
      if (dictationActive) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return;
      setIsScrolled(window.scrollY > 40);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Ensure that when the PRF successfully loads, the page scrolls to the top
  // so the Call Type title and choices are fully visible without any scroll drift.
  useEffect(() => {
    if (!loading) {
      forceScrollToTop();
    }
  }, [loading]);
  // Save state is tracked internally but intentionally NOT surfaced to the crew —
  // they don't need a "saved" notification; the form just saves silently after
  // every change. Setters are kept so doSave() records state for any future use.
  const [, setSaving] = useState(false);
  const [submitting, setSubmit] = useState(false);
  const [, setLastSaved] = useState<Date | null>(null);
  const [, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'offline' | 'error'>('idle');
  // Shown when the crew submits with fewer than 3 vital sets — they must record
  // a motivation before the PRF can go through.
  const [vitalsMotivationOpen, setVitalsMotivationOpen] = useState(false);
  // Crew sign-off gate — on Submit, every crew member must sign before the PRF
  // can go through. Signatures are stored in fd.crew_signoff_sigs keyed by crew.
  const [crewSignOffOpen, setCrewSignOffOpen] = useState(false);
  const [undertakerOpen, setUndertakerOpen] = useState(false);
  // Summary review gate — before crew sign-off, show all entered data so crew
  // can spot typos or missing info. The modal's "Looks Good" continues to submit.
  const [summaryReviewOpen, setSummaryReviewOpen] = useState(false);
  const [prfMeta, setPrfMeta] = useState<any>({});

  const [fd, setFd] = useState<Record<string, any>>({});

  // Auto-skip hidden phases if the user lands on them (e.g. from an old draft)
  useEffect(() => {
    const hidden = fd.med_aid_dec_death
      ? new Set([1, 3, 4, 5, 6])
      : fd.call_type === 'RESUS'
      ? new Set([1, 3, 6])
      : fd.call_type === 'PRIMARY'
      ? new Set([1, 3, 6])
      : fd.call_type === 'RHT'
      ? new Set([1, 3, 4, 5, 6])
      : new Set<number>([1, 3, 6]);

    if (hidden.has(phase)) {
      let next = phase + 1;
      while (next < PHASES.length && hidden.has(next)) next++;
      if (next < PHASES.length) setPhase(next);
    }
  }, [phase, fd.call_type, fd.med_aid_dec_death]);
  const [timestamps, setTs] = useState<Record<string, string | null>>({});
  const [kms, setKms] = useState<Record<string, string>>({});
  // GPS coordinates the crew has confirmed for each timestamp field.
  // Shape mirrors what /mark-time returns: {lat, lng, accuracy_m, captured_at}.
  type GeoCapture = { lat: number; lng: number; accuracy_m: number | null; captured_at: string };
  const [geos, setGeos] = useState<Record<string, GeoCapture>>({});
  const [sigs, setSigs] = useState<Record<string, string | null>>({
    patient_signature: null, witness_signature: null,
    handover_signature: null, crew_signature: null,
    valuables_signature: null,
  });
  const [vehicle, setVehicle] = useState('');
  const [crew2Id, setCrew2Id] = useState('');
  const [vitals, setVitals] = useState<any[]>([]);
  const [editVital, setEditVital] = useState(-1);
  const [quickVital, setQV] = useState(false);
  // Dev/QA test-fill — opens a chooser to auto-populate the form for a given
  // call-type × billing-type combination so testers don't retype everything.
  const [testFillOpen, setTestFillOpen] = useState(false);
  const [vsAlphaKeys, setVsAlphaKeys] = useState<Set<string>>(() => new Set());
  const [ivRows, setIvRows] = useState<any[]>([]);
  const [medRows, setMedRows] = useState<any[]>([]);
  // Toggle buttons: crew activates IV Therapy / Medication sections explicitly
  const [ivSectionOpen, setIvSectionOpen] = useState(false);
  const [medSectionOpen, setMedSectionOpen] = useState(false);
  // Crew-picker overlay drives three flows:
  //   • IV / med rows — each new line is attributed to a specific crew member
  //     AND signed for, so the PRF carries an audit trail of who administered
  //     what. `kind` is the target list; `phase` runs select → signing.
  //   • Treating practitioner gate — on entry to the Clinical phase the crew
  //     must explicitly identify who is treating the patient. Locked into
  //     `fd.treating_practitioner_*` and used by HPCSA scope enforcement so a
  //     BAA-registered crew member can't be recorded performing an ANT/ECP
  //     procedure. Single-step select; no signing.
  type CrewPickedIdentity = { name: string; qualification: string; hpcsa: string };
  type CrewPickerState =
    | { phase: 'select'; kind: 'iv' | 'med' }
    | { phase: 'signing'; kind: 'iv' | 'med'; crew: CrewPickedIdentity }
    | { phase: 'select'; kind: 'treating' };
  const [crewPicker, setCrewPicker] = useState<CrewPickerState | null>(null);
  const [dismissedTreating, setDismissedTreating] = useState(false);
  const [startedExam, setStartedExam] = useState(false);
  // Phase-2 (PT INFO) Declaration of Death form: collapsed behind a button until
  // the crew opens it, so the DOD certificate doesn't crowd the billing fields.
  const [dodFormOpen, setDodFormOpen] = useState(false);
  const [transferSubtypeOpen, setTransferSubtypeOpen] = useState(false);
  const [quotedAmountModalOpen, setQuotedAmountModalOpen] = useState(false);
  const [preauthModalOpen, setPreauthModalOpen] = useState(false);
  const [rhtCallOutFeeOpen, setRhtCallOutFeeOpen] = useState(false);
  const [enRouteOverlay, setEnRouteOverlay] = useState(false);
  const [assessmentModalOpen, setAssessmentModalOpen] = useState(false);
  const [monitoringModalOpen, setMonitoringModalOpen] = useState(false);
  const [wcaDocKey, setWcaDocKey] = useState<string | null>(null);
  const [wcaPromptOpen, setWcaPromptOpen] = useState(false);
  const [tempMedReason, setTempMedReason] = useState<string | null>(null);
  const [medReasonPromptOpen, setMedReasonPromptOpen] = useState(false);
  const [ivReasonModalOpen, setIvReasonModalOpen] = useState(false);

  const handleWcaPhoto = (key: string, file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, w, h);
          sf(key, { name: file.name, size: file.size, data_url: canvas.toDataURL('image/jpeg', 0.85) });
        } else {
          sf(key, { name: file.name, size: file.size, data_url: String(reader.result) });
        }
        setWcaPromptOpen(false);
        setWcaDocKey(null);
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const handleWcaPdf = (key: string, file: File | null) => {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      alert('Only PDF files are accepted.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      sf(key, { name: file.name, size: file.size, data_url: String(reader.result) });
      setWcaPromptOpen(false);
      setWcaDocKey(null);
    };
    reader.readAsDataURL(file);
  };

  const [preauthVisible, setPreauthVisible] = useState(false);
  const quotedAmountRef = useRef<HTMLInputElement>(null);
  const preauthRef = useRef<HTMLInputElement>(null);
  const [dispatchPromptOpen, setDispatchPromptOpen] = useState(false);
  const dispatchKmRef = useRef<HTMLInputElement>(null);
  const [onScenePromptOpen, setOnScenePromptOpen] = useState(false);
  const onSceneKmRef = useRef<HTMLInputElement>(null);
  const [departPromptOpen, setDepartPromptOpen] = useState(false);
  const departKmRef = useRef<HTMLInputElement>(null);
  const [destinationPromptOpen, setDestinationPromptOpen] = useState(false);
  const destinationKmRef = useRef<HTMLInputElement>(null);
  const chiefComplaintRef = useRef<HTMLDivElement>(null);
  const isMobileView = typeof window !== 'undefined' && window.innerWidth < 768;


  // ── IFT/IHT Automation Flow ──

  // 2. Pre-auth field visibility — show once transfer subtype is selected (IHT)
  // or immediately for IFT. No modal automation needed — fields are native inputs.
  useEffect(() => {
    if (fd.call_type === 'IHT' && !!fd.transfer_subtype) {
      setPreauthVisible(true);
    } else if (fd.call_type === 'IFT') {
      setPreauthVisible(true);
    }
    if (fd.preauth_number) {
      setPreauthVisible(true);
    }
  }, [fd.call_type, fd.transfer_subtype, fd.preauth_number, loading]);

  // getCrewProfile() guards against a corrupted localStorage value — an
  // unguarded JSON.parse here would throw during render and white-screen the
  // whole form.
  const profile = getCrewProfile();
  const dirtyRef = useRef(false);

  // (Live header timer is owned by the <LiveTimer> component — keeping the
  //  ticker out of this component prevents form re-renders mid-keystroke,
  //  which on mobile dismisses the IME / on-screen keyboard.)

  // ── Local Draft Persistence (Hybrid Save) ───────────────────────────────
  // Form data is saved to localStorage on every change (instant, zero network).
  // The server is only contacted on phase changes, visibility change (phone
  // locked), periodic backup (5 min), and submit.
  const LOCAL_DRAFT_KEY = `prf-draft:${prfId}`;

  const saveToLocal = () => {
    if (!prfId) return;
    try {
      const draft = {
        fd, vitals, ivRows, medRows, timestamps, kms, sigs, geos,
        vehicle, crew2Id, phase,
        savedAt: Date.now(),
      };
      localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify(draft));
    } catch { /* localStorage full or unavailable — non-fatal */ }
  };

  const loadFromLocal = (): boolean => {
    if (!prfId) return false;
    try {
      const raw = localStorage.getItem(LOCAL_DRAFT_KEY);
      if (!raw) return false;
      const draft = JSON.parse(raw);
      if (!draft || !draft.fd) return false;
      setFd(draft.fd);
      setVitals(draft.vitals || []);
      setIvRows(draft.ivRows || []);
      setMedRows(draft.medRows || []);
      setTs(draft.timestamps || {});
      setKms(draft.kms || {});
      setSigs(draft.sigs || { patient_signature: null, witness_signature: null, handover_signature: null, crew_signature: null, valuables_signature: null });
      setGeos(draft.geos || {});
      setVehicle(draft.vehicle || '');
      setCrew2Id(draft.crew2Id || '');
      if (typeof draft.phase === 'number') setPhase(draft.phase);
      return true;
    } catch { return false; }
  };

  const clearLocalDraft = () => {
    try { localStorage.removeItem(LOCAL_DRAFT_KEY); } catch { /* ignore */ }
  };

  // ── Load ─────────────────────────────────────────────────────────────────
  // Hybrid load: try localStorage first for instant display, then background-
  // fetch from server to get any server-side updates (e.g. PRF metadata,
  // crew member details). If no local draft exists, fetch from server as before.
  //
  // Robust loader for mobile/flaky networks:
  //   • AbortController cancels duplicate in-flight requests on React 18
  //     StrictMode double-mount, preventing two stacked error dialogs.
  //   • Network errors trigger one automatic retry after 600ms before
  //     surfacing to the user — covers the common race where a freshly-
  //     created PRF hasn't yet propagated.
  //   • Errors set inline state instead of calling blocking alert().
  //   • 401 redirects to login; 404 / 403 show a clear message; network
  //     errors offer a retry button.
  // Single attempt against the API. No retries inside — retries are owned by
  // the outer loop so we can cap them and never spin forever.
  const fetchPrfOnce = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const res = await api().get(`/api/digital-prf/${prfId}`, { signal });
    if (signal?.aborted) return;
    const prf = res.data;
    const data = prf.form_data || {};

    // ── Auto-prefill assessor / manager from authenticated crew session ──
    const crew2Profile = (() => {
      try { return JSON.parse(localStorage.getItem(CREW_SESSION_KEYS.partner) || '{}'); }
      catch { return {}; }
    })();
    const crew1FromMeta = prf.crew_member_1 || null;
    const crew2FromMeta = prf.crew_member_2 || null;
    const lead = crew1FromMeta?.full_name || profile.name || '';
    // HPCSA category fallback ('AEA' = Ambulance Emergency Assistant) — matches
    // the backend default in `CrewMember.qualification`. Only used when no crew
    // profile is loaded yet, which shouldn't happen for an authenticated session.
    const leadQ = crew1FromMeta?.qualification || profile.qualification || 'AEA';
    const partner = crew2FromMeta?.full_name || crew2Profile.full_name || '';
    const partnerQ = crew2FromMeta?.qualification || crew2Profile.qualification || 'AEA';
    if (!data.assessed_by && lead) data.assessed_by = lead;
    if (!data.assessor_qualifications && leadQ) data.assessor_qualifications = leadQ;
    if (!data.managed_by && partner) data.managed_by = partner;
    if (!data.manager_qualifications && partnerQ) data.manager_qualifications = partnerQ;

    const extraCrews = (() => {
      try {
        const raw = JSON.parse(localStorage.getItem(CREW_SESSION_KEYS.extraCrew) || 'null');
        return Array.isArray(raw) ? raw : [];
      } catch { return []; }
    })();
    if (prf.status === 'draft' && prf.crew_member_1_id === profile.id) {
      if (extraCrews.length > 1) {
        data.extra_crew = extraCrews.slice(1);
      }
    }

    setPrfMeta(prf);
    // Seed the optimistic-concurrency token from the freshly loaded row.
    baseUpdatedAtRef.current = prf.updated_at || null;

    // If there is an active local draft, DO NOT overwrite the form state
    // with the server's version. The local draft contains the user's
    // most recent auto-saved keystrokes that haven't been pushed yet.
    if (!localStorage.getItem(`prf-draft:${prfId}`)) {
      setFd(normalizeFormData(data));
      setVehicle(prf.vehicle_id || '');
      setCrew2Id(prf.crew_member_2_id || '');
      setVitals(data.vitals_sets || []);
      setIvRows(data.iv_therapy || []);
      setMedRows(data.medications || []);
      const ts: Record<string, string | null> = {};
      const km: Record<string, string> = {};
      // Coerce km to a string — the backend stores odometer values numerically, and
      // KmInput / fmt() call .split() on them. `?? ''` (not `|| ''`) so a legit 0 is kept.
      ALL_TIME_ROWS.forEach(r => { ts[r.timeKey] = prf[r.timeKey] || null; km[r.kmKey] = prf[r.kmKey] != null ? String(prf[r.kmKey]) : ''; });
      setTs(ts);
      setKms(km);
      setGeos(prf.geo_locations || {});
      setSigs({
        patient_signature:   prf.patient_signature   || null,
        witness_signature:   prf.witness_signature   || null,
        handover_signature:  prf.handover_signature  || null,
        crew_signature:      prf.crew_signature      || null,
        valuables_signature: prf.valuables_signature || null,
      });
      // RHT and Declaration of Death are "compressed" — they hide TRANS + HNDVR
      // and capture every leg on the first two screens, so they resume only to
      // DISP / PT INFO.
      const compressed = !!data.med_aid_dec_death || data.call_type === 'RHT';
      setPhase(inferResumePhase({ ...ts }, { compressed }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prfId]);

  // Outer loader with hard retry cap. Retries only on network errors
  // (no HTTP response) and only up to MAX_RETRIES times. After that, the
  // error UI is shown — never an infinite "Reconnecting…" spin.
  const loadPrf = useCallback(async (signal?: AbortSignal): Promise<void> => {
    // Initial attempt + up to 3 retries with backoff. Transient failures
    // (a network blip, a 5xx, or a brief race when opening a just-created
    // PRF) are absorbed here so the crew never has to hit "Try Again".
    const MAX_RETRIES = 3;
    const RETRY_DELAYS_MS = [400, 900, 1600];
    setLoadError(null);

    // ── Hybrid: try loading from localStorage first ──
    // If we have a local draft, hydrate from it immediately so the form is
    // instantly visible (no spinner). Then continue to fetch from server in
    // the background for metadata (crew details, PRF status, OCC token).
    const hadLocal = loadFromLocal();
    if (hadLocal) {
      setLoading(false);
    }

    let lastErr: any = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) return;
      try {
        await fetchPrfOnce(signal);
        setLoadError(null);
        setLoading(false);
        setRetrying(false);
        // The auto-save useEffect (which depends on fd, vitals, etc.) will
        // persist the fresh server data to localStorage once React flushes
        // the state updates from fetchPrfOnce. We must NOT call saveToLocal()
        // here — it's a closure that captures the previous render's state,
        // so it would overwrite the good data with stale/empty values.
        return;
      } catch (err: any) {
        if (signal?.aborted || err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') {
          return; // Expected — StrictMode double-mount cleanup
        }
        lastErr = err;
        // Definitive, non-transient failures surface immediately (no retry):
        // 401 (handled below -> re-login), 403 (not this crew's PRF), 400
        // (bad id). Everything else -- a network error, a 5xx, or a 404 in the
        // brief window right after create+navigate -- is transient: retry it.
        const status = err?.response?.status;
        if (status === 401 || status === 403 || status === 400) break;
        if (attempt < MAX_RETRIES) {
          setRetrying(true);
          await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt] ?? 1600));
        }
      }
    }
    // All attempts exhausted (or non-retryable error)
    if (signal?.aborted) return;
    if (lastErr?.response?.status === 401) {
      navigate(`/${providerSlug}/login`, { replace: true });
      return;
    }
    // If we already loaded from local, don't show an error — the crew can
    // continue working offline and the next doSave/submit will sync.
    if (hadLocal) {
      setRetrying(false);
      return;
    }
    const isNetwork = !lastErr?.response;
    const detail =
      lastErr?.response?.data?.detail ||
      (lastErr?.response?.status === 404 ? 'PRF not found. It may have been deleted.' : null) ||
      (isNetwork ? 'Could not reach the server. Check your connection and try again.' : lastErr?.message) ||
      'Unable to load PRF.';
    setLoadError(detail);
    setLoading(false);
    setRetrying(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPrfOnce, providerSlug]);

  useEffect(() => {
    const controller = new AbortController();
    loadPrf(controller.signal);
    return () => controller.abort();
  }, [loadPrf]);

  // ── Clinical-phase gate: identify the treating practitioner ───────────────
  // HPCSA scope of practice enforcement starts here. Before any clinical field
  // can be edited, the crew must explicitly say who is treating the patient
  // (so we can later block a BAA-registered crew from being recorded
  // performing ANT/ECP procedures). Auto-opens the picker; closing without
  // selecting drops back to Phase 2 (handled inside the picker's Cancel).
  useEffect(() => {
    if (phase !== 3) return;
    if (fd.treating_practitioner_category) return;
    if (dismissedTreating) return;
    if (crewPicker) return;
    setCrewPicker({ phase: 'select', kind: 'treating' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, fd.treating_practitioner_category, dismissedTreating]);

  // ── Auto-save on change — LOCAL ONLY (Hybrid Save) ─────────────────────
  // Every keystroke saves to localStorage (instant, zero network). The server
  // is only contacted on phase changes, visibility change, periodic backup,
  // and submit. This reduces server load from ~100 req/s (500 users auto-
  // saving every 400ms) to ~1-2 req/s (phase changes + periodic backups).
  const initialLoadRef = useRef(true);
  useEffect(() => {
    // Skip the initial render — the form data was just hydrated from the
    // server or localStorage, no need to save it straight back.
    if (initialLoadRef.current) { initialLoadRef.current = false; return; }
    if (!prfId) return;
    const t = setTimeout(() => { saveToLocal(); dirtyRef.current = true; }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fd, vitals, ivRows, medRows, timestamps, kms, sigs, vehicle, crew2Id, prfId]);

  // ── Server backup on visibility change ─────────────────────────────────
  // When the crew locks their phone or switches apps, push a server backup
  // so the data is safe even if the device is lost. This is a lightweight
  // safety net — at most 1 PATCH per app-switch.
  useEffect(() => {
    const onVisChange = () => {
      if (document.visibilityState === 'hidden' && prfId && dirtyRef.current) {
        doSaveRef.current();
        dirtyRef.current = false;
      }
    };
    document.addEventListener('visibilitychange', onVisChange);
    return () => document.removeEventListener('visibilitychange', onVisChange);
  }, [prfId]);

  // ── Periodic server backup (every 5 minutes) ──────────────────────────
  // Safety net: even if the crew never changes phases or locks their phone,
  // the server gets a backup every 5 minutes. This means the maximum data
  // exposure from a lost/broken device is 5 minutes of work.
  useEffect(() => {
    if (!prfId) return;
    const interval = setInterval(() => {
      if (dirtyRef.current) {
        doSaveRef.current();
        dirtyRef.current = false;
      }
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [prfId]);

  // ── Auto-fill age & DOB from SA ID ──────────────────────────────────────
  // First 6 digits of the SA ID are YYMMDD. As soon as enough digits are
  // entered to compute a valid date we set both `age` and `patient_dob`,
  // and continue to update them on every keystroke so the Age field always
  // reflects the current ID. If the ID is cleared, age and DOB clear too —
  // otherwise stale age numbers from a prior patient could linger on the
  // form. The crew can still type over Age manually after the auto-fill.
  // Both the patient (Patient Information) and the debtor (Debtor Information)
  // sections share this logic — only the field-key prefixes differ.
  const autofillAgeFromId = (
    idValue: string | undefined,
    ageKey: string,
    dobKey: string,
  ) => {
    const idDigits = (idValue || '').replace(/\D/g, '');
    const dob = parseSaIdDob(idValue || '');
    setFd(prev => {
      const next = { ...prev };
      let changed = false;
      if (dob) {
        const computedAge = String(ageFromDob(dob));
        const isoDob = `${dob.getFullYear()}-${String(dob.getMonth() + 1).padStart(2, '0')}-${String(dob.getDate()).padStart(2, '0')}`;
        if (next[ageKey] !== computedAge) { next[ageKey] = computedAge; changed = true; }
        if (next[dobKey] !== isoDob) { next[dobKey] = isoDob; changed = true; }
      } else if (idDigits.length === 0) {
        if (next[ageKey]) { next[ageKey] = ''; changed = true; }
        if (next[dobKey]) { next[dobKey] = ''; changed = true; }
      }
      if (changed) dirtyRef.current = true;
      return changed ? next : prev;
    });
  };

  useEffect(() => {
    autofillAgeFromId(fd.patient_id_number, 'age', 'patient_dob');
  }, [fd.patient_id_number]);

  useEffect(() => {
    autofillAgeFromId(fd.debtor_id_number, 'debtor_age', 'debtor_dob');
  }, [fd.debtor_id_number]);

  // Auto-fill Age from Date of Birth whenever the DOB picker fills in a
  // complete date. Mirrors the SA-ID autofill above but uses the DOB
  // field as the source. Runs for both patient and debtor independently.
  const autofillAgeFromDob = (dobValue: string | undefined, ageKey: string) => {
    if (!dobValue) return;
    const match = String(dobValue).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return;
    const [, yy, mm, dd] = match;
    const dob = new Date(Number(yy), Number(mm) - 1, Number(dd));
    if (Number.isNaN(dob.getTime())) return;
    const computed = String(ageFromDob(dob));
    setFd(prev => {
      if (prev[ageKey] === computed) return prev;
      dirtyRef.current = true;
      return { ...prev, [ageKey]: computed };
    });
  };

  useEffect(() => { autofillAgeFromDob(fd.patient_dob, 'age'); }, [fd.patient_dob]);
  useEffect(() => { autofillAgeFromDob(fd.debtor_dob, 'debtor_age'); }, [fd.debtor_dob]);

  // ── DOD: mirror "Particulars of deceased" → Patient Information ──────────
  // On a Declaration of Death the deceased IS the patient, and both the
  // Patient Information section and the billing pipeline read the patient_*
  // keys — not the deceased-specific ones. As the crew fills (or corrects) the
  // deceased particulars, copy each non-empty value into its matching patient
  // field so Patient Information auto-populates. One-way and DOD-only; a blank
  // deceased field never wipes the patient side. Runs whenever any deceased
  // field changes so later corrections propagate too.
  useEffect(() => {
    if (!fd.med_aid_dec_death) return;
    const MAP: [string, string][] = [
      ['med_aid_dec_death_deceased_gender',      'gender'],
      ['med_aid_dec_death_deceased_first_name',  'patient_name'],
      ['med_aid_dec_death_deceased_surname',     'patient_surname'],
      ['med_aid_dec_death_deceased_id',          'patient_id_number'],
      ['med_aid_dec_death_deceased_passport',    'patient_passport_number'],
      ['med_aid_dec_death_deceased_dob',         'patient_dob'],
      ['med_aid_dec_death_deceased_age',         'age'],
      ['med_aid_dec_death_deceased_cell',        'patient_phone_cell'],
      ['med_aid_dec_death_deceased_tel_home',    'patient_phone_home'],
      ['med_aid_dec_death_deceased_tel_work',    'patient_phone_work'],
      ['med_aid_dec_death_deceased_address',     'patient_address'],
      ['med_aid_dec_death_deceased_suburb',      'patient_suburb'],
      ['med_aid_dec_death_deceased_postal_code', 'patient_postal_code'],
    ];
    setFd(prev => {
      let changed = false;
      const next = { ...prev };
      for (const [src, dst] of MAP) {
        const v = prev[src];
        if (v != null && String(v).trim() !== '' && prev[dst] !== v) {
          next[dst] = v;
          changed = true;
        }
      }
      if (changed) dirtyRef.current = true;
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    fd.med_aid_dec_death,
    fd.med_aid_dec_death_deceased_gender,
    fd.med_aid_dec_death_deceased_first_name,
    fd.med_aid_dec_death_deceased_surname,
    fd.med_aid_dec_death_deceased_id,
    fd.med_aid_dec_death_deceased_passport,
    fd.med_aid_dec_death_deceased_dob,
    fd.med_aid_dec_death_deceased_age,
    fd.med_aid_dec_death_deceased_cell,
    fd.med_aid_dec_death_deceased_tel_home,
    fd.med_aid_dec_death_deceased_tel_work,
    fd.med_aid_dec_death_deceased_address,
    fd.med_aid_dec_death_deceased_suburb,
    fd.med_aid_dec_death_deceased_postal_code,
  ]);

  const sf = (k: string, v: any) => { setFd(p => ({ ...p, [k]: v })); dirtyRef.current = true; };
  const toggleArr = (k: string, v: string) => {
    const arr: string[] = Array.isArray(fd[k]) ? [...fd[k]] : [];
    const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v);
    sf(k, arr);
  };
  const inArr = (k: string, v: string) => Array.isArray(fd[k]) && (fd[k] as string[]).includes(v);

  // When the crew ticks "Debtor is same as patient", wipe any debtor details
  // they had already typed. Previously the values lingered in the record (the
  // input card is merely hidden) and then resurfaced on the submitted PDF
  // instead of the "Same as Patient" panel. Defined AFTER sf/inArr so it isn't
  // in their temporal dead zone.
  const debtorSameAsPatient = inArr('flags', 'debtor_same_as_patient');
  useEffect(() => {
    if (!debtorSameAsPatient) return;
    const debtorKeys = [
      'debtor_gender', 'debtor_name', 'debtor_surname', 'debtor_id_number',
      'debtor_passport_number', 'debtor_dob', 'debtor_age', 'debtor_phone_cell',
      'debtor_phone_home', 'debtor_address', 'debtor_suburb', 'debtor_postal_code',
    ];
    debtorKeys.forEach(k => { if ((fd[k] ?? '') !== '') sf(k, ''); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debtorSameAsPatient]);

  // Handover Ward/Unit defaults to 'casualty' (the most common destination).
  // Set once after the PRF loads if the field is empty; the input itself clears
  // it on focus and restores it on a blank blur.
  const wardDefaultedRef = useRef(false);
  useEffect(() => {
    if (loading || wardDefaultedRef.current) return;
    wardDefaultedRef.current = true;
    if (!fd.med_aid_dec_death && !(fd.ward ?? '').trim()) sf('ward', 'casualty');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const lastSavedPayloadRef = useRef<string | null>(null);
  // Optimistic-concurrency token echoed back to the server on each save.
  const baseUpdatedAtRef = useRef<string | null>(null);
  // Save serialization — never allow two PATCHes in flight (the source of
  // last-write-wins clobbering when an older request lands after a newer one).
  const savingInFlightRef = useRef(false);
  const savePendingRef = useRef(false);
  const sessionExpiredRef = useRef(false);
  // Set when the server answers 423: the PRF is SUBMITTED/PROCESSED and can
  // never be edited again — every further save attempt would be rejected, so
  // saving stops permanently for this mount.
  const prfLockedRef = useRef(false);
  // Delay before a queued retry runs (ms). Zero for normal coalesced saves;
  // raised on a 409 concurrency conflict so two devices ping-ponging over the
  // same draft back off instead of hammering the API into the rate limiter.
  const retryDelayRef = useRef(0);
  // Synchronous guard against a double-tap submitting the PRF twice (the
  // `submitting` state flips a render later, which is too slow on laggy phones).
  const submitInFlightRef = useRef(false);

  const buildSavePayload = (): any => {
    // Strip empty strings from kms and timestamps — the backend's Numeric
    // columns reject '' and the entire save crashes.
    const cleanKms: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(kms)) {
      cleanKms[k] = v && String(v).trim() ? v : null;
    }
    const cleanTs: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(timestamps)) {
      cleanTs[k] = v || null;
    }
    return {
      form_data: { ...fd, vitals_sets: vitals, iv_therapy: ivRows, medications: medRows },
      vehicle_id: vehicle || null, crew_member_2_id: crew2Id || null,
      ...cleanTs, ...cleanKms, ...sigs,
    };
  };

  const queueToOutbox = async (payload: any) => {
    try {
      const { queueSave } = await import('../../services/offlineDb');
      await queueSave(prfId!, payload);
      window.dispatchEvent(new CustomEvent('outbox-change'));
    } catch { /* IndexedDB unavailable */ }
  };

  const handleSessionExpired = () => {
    // Session/token expired mid-shift. The work has already been queued to the
    // offline outbox by the caller, so it will sync after re-login. Send the
    // crew to log in again — never silently drop their PRF.
    if (sessionExpiredRef.current) return;
    sessionExpiredRef.current = true;
    setSaveState('offline');
    alert('Your session has expired. Your PRF has been saved on this device and will finish saving automatically once you log in again.');
    navigate(`/${providerSlug}/login`, { replace: true });
  };

  const doSave = async () => {
    if (!prfId || prfLockedRef.current) return;
    // Coalesce concurrent saves: if one is already running, request exactly one
    // more pass when it finishes rather than racing a second request.
    if (savingInFlightRef.current) { savePendingRef.current = true; return; }

    const payload = buildSavePayload();
    const payloadStr = JSON.stringify(payload);
    if (payloadStr === lastSavedPayloadRef.current) return;

    if (baseUpdatedAtRef.current) payload.client_base_updated_at = baseUpdatedAtRef.current;

    savingInFlightRef.current = true;
    setSaving(true);
    setSaveState('saving');
    try {
      const resp = await api().patch(`/api/digital-prf/${prfId}`, payload);
      lastSavedPayloadRef.current = payloadStr;
      if (resp?.data?.updated_at) baseUpdatedAtRef.current = resp.data.updated_at;
      setLastSaved(new Date());
      setSaveState('saved');
    } catch (err: any) {
      const statusCode = err?.response?.status;
      if (statusCode === 401) {
        // Expired session — preserve the work offline, then route to login.
        await queueToOutbox(payload);
        handleSessionExpired();
        return;
      }
      if (statusCode === 423) {
        // The PRF was submitted (possibly from another device) — it is now a
        // billing record and permanently uneditable. Stop saving for good and
        // send the crew back to the dashboard; retrying would loop forever
        // and trip the API rate limiter, blocking the whole device.
        prfLockedRef.current = true;
        savePendingRef.current = false;
        setSaveState('saved');
        alert('This PRF has already been submitted and can no longer be edited. Returning to the dashboard.');
        navigate(`/${providerSlug}/crew/dashboard`, { replace: true });
        return;
      }
      if (statusCode === 409) {
        // Another writer touched this PRF. Refresh the version token and force a
        // retry on the next pass so this device's data still persists — but
        // back the retry off so two live devices can't hammer the API.
        try {
          const fresh = await api().get(`/api/digital-prf/${prfId}`);
          baseUpdatedAtRef.current = fresh?.data?.updated_at || null;
        } catch { /* ignore */ }
        lastSavedPayloadRef.current = null;
        savePendingRef.current = true;
        retryDelayRef.current = 1500;
        setSaveState('saving');
      } else if (!navigator.onLine || err?.code === 'ECONNABORTED' || err?.code === 'ERR_NETWORK') {
        // Offline / network error — queue to the outbox so nothing is lost.
        await queueToOutbox(payload);
        setSaveState('offline');
      } else {
        // Unknown server error (e.g. 500). Do NOT advance lastSavedPayloadRef so
        // the same data is retried on the next change/cycle.
        setSaveState('error');
      }
    } finally {
      savingInFlightRef.current = false;
      setSaving(false);
      if (savePendingRef.current) {
        savePendingRef.current = false;
        const delay = retryDelayRef.current;
        retryDelayRef.current = 0;
        setTimeout(() => { doSaveRef.current(); }, delay);
      }
    }
  };

  // Always hold the latest doSave so unmount/beforeunload flushes current data
  // (not a stale closure).
  const doSaveRef = useRef(doSave);
  doSaveRef.current = doSave;

  // ── Warn before leaving with unsaved changes + best-effort final save ──────
  // Covers the back-swipe / tab-close / refresh case so a crew can't lose the
  // last edits inside the 400ms autosave debounce window.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (dirtyRef.current && prfId) { doSaveRef.current(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prfId]);


  // ── In-form adjudication ──────────────────────────────────────────────────
  // Calls /api/digital-prf/{id}/scrub-phase before allowing the crew to leave a
  // phase. Critical / high rules block; medium / low warnings appear inline but
  // don't stop progression. The same hardcoded scheme rules drive both this and
  // the back-office adjudication, so what blocks here will block at submit time.
  type ScrubIssue = { rule: string; reason: string; severity: string; rfi_code?: string | null };
  const [scrubBlockers, setScrubBlockers] = useState<ScrubIssue[]>([]);
  const [scrubWarnings, setScrubWarnings] = useState<ScrubIssue[]>([]);

  // ── Mark-time + geo capture ──────────────────────────────────────────────
  // Pending capture awaiting crew confirmation. While set, the GeoConfirm
  // overlay renders and the crew sees the captured coordinates before they're
  // committed. `coords` is null when the browser denied geolocation or the
  // request timed out — the crew can still mark the time without GPS.

  type PendingMark = {
    timeKey: string;
    kmKey: string;
    coords: { latitude: number; longitude: number; accuracy: number } | null;
    error: string | null;
    capturing: boolean;
    // Reverse-geocoded address. `null` = not resolved yet (or no target field
    // for this timestamp). `geocoding` distinguishes "still looking up" from
    // "lookup finished but failed" so the overlay can show a spinner.
    address: ResolvedAddress | null;
    geocoding: boolean;
    geocodeError: string | null;
    // Optional follow-up after the crew confirms or skips the GPS capture.
    // Used by advancePhase so the journey can step forward in one flow.
    onAfterCommit?: () => void | Promise<void>;
  };
  const [pendingMark, setPendingMark] = useState<PendingMark | null>(null);

  // Low-level commit. Called once the crew has confirmed (or skipped) the GPS
  // capture. Sends coords to the backend if present; backend stores them on
  // the PRF and returns them so we can update local state.
  const commitMarkTime = useCallback(async (
    timeKey: string,
    kmKey: string,
    coords: { latitude: number; longitude: number; accuracy: number } | null,
  ) => {
    const payload: any = { field: timeKey, km: kms[kmKey] || null };
    if (coords) {
      payload.latitude = coords.latitude;
      payload.longitude = coords.longitude;
      payload.accuracy_m = coords.accuracy;
    }
    try {
      const r = await api().post(`/api/digital-prf/${prfId}/mark-time`, payload);
      setTs(p => ({ ...p, [timeKey]: r.data.timestamp }));
      if (r.data.geo) setGeos(p => ({ ...p, [timeKey]: r.data.geo }));
    } catch {
      // Offline / network error — still record locally so the crew isn't blocked.
      setTs(p => ({ ...p, [timeKey]: new Date().toISOString() }));
      if (coords) {
        setGeos(p => ({
          ...p,
          [timeKey]: {
            lat: coords.latitude,
            lng: coords.longitude,
            accuracy_m: coords.accuracy,
            captured_at: new Date().toISOString(),
          },
        }));
      }
    }
    dirtyRef.current = true;
  }, [prfId, kms]);

  // Reverse-geocode via OpenStreetMap Nominatim. Free, no API key required;
  // their usage policy asks for a descriptive User-Agent and ≤1 req/sec — both
  // satisfied here (one request per Mark-Time tap). Nominatim ignores the
  // User-Agent header from browsers anyway (the browser overrides it), so the
  // Referer carries identification.


  // Public trigger from "Mark Time" / "Edit" buttons and the auto-advance hook.
  // Captures GPS asynchronously, then reverse-geocodes the coords so the crew
  // can verify the resolved street address before committing. The address is
  // shown for every Mark Time, but only auto-filled into a form field when
  // there's a target mapping in GEO_TARGET_FIELD (On Scene → incident_location,
  // Arrival At Facility → receiving_facility). If geo is unavailable the
  // overlay still appears so the crew can choose to proceed.
  const geocodeAbortRef = useRef<AbortController | null>(null);
  const markTime = useCallback((
    timeKey: string,
    kmKey: string,
    onAfterCommit?: () => void | Promise<void>,
  ) => {
    // Cancel any in-flight geocode from a previous Mark-Time tap.
    geocodeAbortRef.current?.abort();

    const baseline: PendingMark = {
      timeKey, kmKey, coords: null, error: null, capturing: true,
      address: null, geocoding: false, geocodeError: null,
      onAfterCommit,
    };

    if (!('geolocation' in navigator)) {
      setPendingMark({ ...baseline, capturing: false, error: 'GPS not supported on this device' });
      return;
    }
    setPendingMark(baseline);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        setPendingMark(prev => ({
          ...baseline,
          onAfterCommit: prev?.onAfterCommit ?? onAfterCommit,
          coords,
          capturing: false,
          geocoding: true,
        }));

        const ac = new AbortController();
        geocodeAbortRef.current = ac;
        reverseGeocode(coords.latitude, coords.longitude, ac.signal)
          .then(addr => {
            setPendingMark(prev => {
              // Stale callback — the crew started a different mark in the
              // meantime; ignore the late result.
              if (!prev || prev.timeKey !== timeKey) return prev;
              return { ...prev, geocoding: false, address: addr, geocodeError: addr ? null : 'Address not found' };
            });
          })
          .catch(err => {
            if (err?.name === 'AbortError') return;
            setPendingMark(prev => {
              if (!prev || prev.timeKey !== timeKey) return prev;
              return { ...prev, geocoding: false, address: null, geocodeError: 'Could not look up address' };
            });
          });
      },
      (err) => {
        const msg = err.code === err.PERMISSION_DENIED
          ? 'Location permission denied'
          : err.code === err.POSITION_UNAVAILABLE
            ? 'GPS signal unavailable'
            : err.code === err.TIMEOUT
              ? 'GPS request timed out'
              : 'Could not capture location';
        setPendingMark(prev => ({
          ...baseline,
          onAfterCommit: prev?.onAfterCommit ?? onAfterCommit,
          capturing: false,
          error: msg,
        }));
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  }, []);

  const handleKmChange = (kmKey: string, value: string) => {
    setKms(prev => ({ ...prev, [kmKey]: value }));
    dirtyRef.current = true;
  };

  // ── Odometer sanity check ───────────────────────────────────────────────
  // Fires on KmInput blur. Walks ALL_TIME_ROWS backwards from the field that
  // was just edited, finds the most recent previous reading, and surfaces a
  // confirmation dialog if the delta is implausible — either a very large
  // jump (likely typo: 25 → 256) or the odometer going backwards.
  //
  // Per the no-mid-call-validation rule this is a passive prompt, not a
  // blocker — the crew can confirm "yes that's right" and carry on, OR clear
  // the field and re-enter. Threshold tuned for SA EMS legs: most metro
  // calls are <50km per leg, even long inter-facility transfers rarely
  // exceed ~100km in a single hop.
  const ABSURD_KM_DELTA = 100;
  type KmConfirm = {
    kmKey: string;
    label: string;
    newValue: number;
    previousKey: string;
    previousLabel: string;
    previousValue: number;
    delta: number;            // signed — negative when odometer rolls backwards
    onConfirmCallback?: () => void;
  };
  const [kmConfirm, setKmConfirm] = useState<KmConfirm | null>(null);

  const handleKmCommit = useCallback((kmKey: string, raw: string, onConfirmCallback?: () => void): boolean => {
    const newVal = parseFloat(raw);
    if (isNaN(newVal)) return false;
    const idx = ALL_TIME_ROWS.findIndex(r => r.kmKey === kmKey);
    if (idx <= 0) return false;  // first leg has nothing to compare against
    // Most recent earlier-in-sequence non-empty reading.
    let prevRow: typeof ALL_TIME_ROWS[number] | null = null;
    let prevVal = NaN;
    for (let i = idx - 1; i >= 0; i--) {
      const row = ALL_TIME_ROWS[i];
      const v = parseFloat(kms[row.kmKey] ?? '');
      if (!isNaN(v)) { prevRow = row; prevVal = v; break; }
    }
    if (!prevRow || isNaN(prevVal)) return false;
    const delta = newVal - prevVal;
    if (delta > ABSURD_KM_DELTA || delta < 0) {
      setKmConfirm({
        kmKey,
        label: ALL_TIME_ROWS[idx].label,
        newValue: newVal,
        previousKey: prevRow.kmKey,
        previousLabel: prevRow.label,
        previousValue: prevVal,
        delta,
        onConfirmCallback,
      });
      return true;
    }
    return false;
  }, [kms]);

  // ── Scheme-based validation (Netcare CMG v5.2 rules + others) ───────────
  // Findings shown in a banner. Blockers prevent advance/submit; warnings
  // stay visible so the crew can address them but allow continuing.
  const [findings, setFindings] = useState<ValidationFinding[]>([]);

  const runValidation = (targetPhase: ValidationPhase): { ok: boolean; findings: ValidationFinding[] } => {
    const ctx = buildValidationContext({
      vitals, ivRows, medRows, sigs,
      crew2Id, prfMeta, timestamps, kms,
    });
    const all = validatePhaseRules(targetPhase, fd, ctx, fd.medical_scheme);
    setFindings(all);
    const blocking = validationBlockers(all);
    if (blocking.length > 0) {
      // Smooth-scroll to the banner so the crew sees it immediately on mobile
      setTimeout(() => {
        document.getElementById('prf-validation-banner')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    }
    return { ok: blocking.length === 0, findings: all };
  };

  // ── Tap-to-jump: tapping a banner finding takes the crew straight to the
  //    field that needs attention (scroll + amber flash). When the field is not
  //    on screen we navigate to its phase first. Robust to the embedded clinical
  //    phase (P3 renders inside Dispatch) via a small candidate-phase sweep.
  const FIELD_ANCHOR: Record<string, string> = {
    vitals_sets: 'vitals-section-anchor',
  };
  const FIELD_HOME_PHASE: Record<string, number> = {
    preauth_number: 0, transfer_subtype: 0, incident_classification: 0, pre_planned_event: 0,
    incident_location: 1,
    patient_name: 2, patient_surname: 2, patient_id_number: 2, patient_weight_kg: 2,
    billing_type: 2, medical_scheme: 2, medical_aid_number: 2, scheme_option: 2,
    priority: 2, patient_count: 2,
    chief_complaint: 0, primary_diagnosis: 0, icd10_primary: 0, icd10_external_cause: 0,
    assessment_level: 0, iv_therapy: 0, vitals_sets: 0, resuscitation_attempted: 0,
    has_ecg_attached: 0,
    closest_facility_bypassed: 4, direct_admission: 4,
    receiving_facility: 5, handover_qualification: 5, handover_name: 5,
    patient_index_of_total: 6,
    emed_notified: 6, lifesaving_intervention_required: 6, second_vehicle_present: 6,
    cardiac_incident: 6, rosc_achieved: 6, perfusing_rhythm_on_handover: 6,
    patient_refused_transport: 6, vehicle_tracking_report: 6, is_multi_patient: 6,
    supervising_practitioner_pr: 6, signature_refused_reason: 6,
  };
  const jumpSweepRef = useRef<{ field: string; queue: number[] } | null>(null);
  const flashFieldEl = (field: string): boolean => {
    const id = FIELD_ANCHOR[field] || `prf-field-${field}`;
    const el = document.getElementById(id);
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('prf-jump-flash');
    window.setTimeout(() => el.classList.remove('prf-jump-flash'), 1700);
    return true;
  };
  const advanceJumpSweep = () => {
    const st = jumpSweepRef.current;
    if (!st) return;
    const next = st.queue.shift();
    if (next === undefined) { jumpSweepRef.current = null; return; }
    setPhase(next);
  };
  const jumpToField = (field?: string) => {
    if (!field) return;
    if (flashFieldEl(field)) return;
    const home = FIELD_HOME_PHASE[field];
    const order = [home, 0, 2, 1, 4, 5].filter((p): p is number => typeof p === 'number');
    jumpSweepRef.current = { field, queue: Array.from(new Set(order)) };
    advanceJumpSweep();
  };
  useEffect(() => {
    const st = jumpSweepRef.current;
    if (!st) return;
    let tries = 0;
    const tick = () => {
      if (!jumpSweepRef.current) return;
      if (flashFieldEl(st.field)) { jumpSweepRef.current = null; return; }
      if (tries++ < 5) { window.setTimeout(tick, 80); return; }
      advanceJumpSweep();
    };
    const t = window.setTimeout(tick, 110);
    return () => window.clearTimeout(t);
  }, [phase]);
  useEffect(() => {
    if (document.getElementById('prf-jump-flash-style')) return;
    const st = document.createElement('style');
    st.id = 'prf-jump-flash-style';
    st.textContent = '@keyframes prfJumpFlash{0%{box-shadow:0 0 0 0 rgba(245,158,11,0)}25%{box-shadow:0 0 0 4px rgba(245,158,11,0.55)}100%{box-shadow:0 0 0 0 rgba(245,158,11,0)}}.prf-jump-flash{animation:prfJumpFlash 1.6s ease-out;border-radius:10px}';
    document.head.appendChild(st);
  }, []);

  // Collects the inline blockers that must clear before the crew can leave the
  // given phase. The broader RULES table in prfValidation.ts is short-circuited
  // for the live rollout, but the team explicitly wants these gates enforced
  // before any forward navigation:
  //   (1) The current phase's odometer reading must be captured.
  //   (2) At least 3 vital-sign sets must be captured before leaving Handover
  //       (i.e. before Complete / Submit).
  // Used by both the CTA buttons (via advancePhase) and the phase-node tabs at
  // the top of the form, so direct phase jumps can't bypass the gates.
  const MIN_VITALS = 3;
  const collectLeavePhaseBlockers = (fromPhase: number): ValidationFinding[] => {
    const blockers: ValidationFinding[] = [];

    const kmRow = ALL_TIME_ROWS.find(r => r.phase === fromPhase);
    if (kmRow) {
      const hasTime = !!timestamps[kmRow.timeKey];
      if (!hasTime) {
        blockers.push({
          id: `INLINE-TIME-${kmRow.timeKey}`,
          severity: 'block',
          field: kmRow.timeKey,
          message: `Capture the ${kmRow.label} before advancing.`,
          source: 'Operational — time captures required at every leg.',
        });
      }

      const v = kms[kmRow.kmKey];
      const blank = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
      if (blank) {
        blockers.push({
          id: `INLINE-KM-${kmRow.kmKey}`,
          severity: 'block',
          field: kmRow.kmKey,
          message: `Enter the ${kmRow.label} odometer reading (km) before advancing.`,
          source: 'Operational — odometer captures required at every leg.',
        });
      }
    }

    if (fromPhase === 1) {
      if (!timestamps.time_dispatched || !kms.km_dispatched) {
        blockers.push({
          id: 'INLINE-MISSING-DISPATCH',
          severity: 'block',
          field: 'time_dispatched',
          message: 'Dispatch Information (Time & KM) is required before advancing. Please return to the Dispatch tab.',
          source: 'Operational — required sequential flow.',
        });
      }

      if (['IFT', 'IHT'].includes(fd.call_type)) {
        const blankQuoted = !fd.med_aid_quoted_amount || String(fd.med_aid_quoted_amount).trim() === '';
        if (blankQuoted) {
          blockers.push({
            id: 'INLINE-QUOTED-AMOUNT',
            severity: 'block',
            field: 'med_aid_quoted_amount',
            message: 'Quoted Payout Amount (R) is required before advancing.',
            source: 'Operational — required for IFT/IHT billing.',
          });
        }
        const blankPreauth = !fd.preauth_number || String(fd.preauth_number).trim() === '';
        if (blankPreauth) {
          blockers.push({
            id: 'INLINE-PREAUTH',
            severity: 'block',
            field: 'preauth_number',
            message: 'Pre-Auth No. is required before advancing.',
            source: 'Operational — required for IFT/IHT billing.',
          });
        }
      }
    }

    // Note: fewer than 3 vital sets no longer blocks leaving the Handover
    // phase. The crew is gated at Submit instead, where a motivation popup
    // captures why fewer than 3 sets were taken (rare, but valid) before the
    // PRF can go through.

    return blockers;
  };

  const showBlockerBanner = (blockers: ValidationFinding[]) => {
    setFindings(blockers);
    setTimeout(() => {
      document.getElementById('prf-validation-banner')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  };

  // Once an inline gate-blocker banner is showing, re-evaluate the gates as
  // the crew fills the offending field(s) so the banner clears itself rather
  // than persisting until the next advance attempt. Touches only findings
  // whose id is namespaced `INLINE-*` so any scheme-rule findings from
  // runValidation() are left alone.
  useEffect(() => {
    setFindings(prev => {
      const hasInline = prev.some(f => f.id.startsWith('INLINE-'));
      if (!hasInline) return prev;
      const others = prev.filter(f => !f.id.startsWith('INLINE-'));
      const fresh = collectLeavePhaseBlockers(phase);
      const next = [...others, ...fresh];
      if (next.length === prev.length && next.every((f, i) => f.id === prev[i].id)) {
        return prev;
      }
      return next;
    });
    // collectLeavePhaseBlockers closes over fd / kms / phase / vitals — these
    // are the only inputs that can change the result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kms, fd.preauth_number, fd.call_type, phase, vitals.length]);

  // ── Live (debounced) scheme-rule validation ──────────────────────────────
  // Re-checks the active scheme's billing rules ~600ms after the crew stops
  // acting, so the gentle amber nudge appears in the banner near the moment of
  // the action - not only when they leave the phase. Warn-only (never blocks).
  // CPU-trivial: a handful of predicate checks, debounced so it never runs on
  // every keystroke (each keystroke only resets a timer). Preserves any
  // INLINE-* advance-gate blockers; only the scheme findings are refreshed, and
  // findings are left untouched when nothing changed (no needless re-render).
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const liveCtx = buildValidationContext({ vitals, ivRows, medRows, sigs, crew2Id, prfMeta, timestamps, kms });
      const live = validatePhaseRules(phase as ValidationPhase, fd, liveCtx, fd.medical_scheme);
      setFindings(prev => {
        const inline = prev.filter(f => f.id.startsWith('INLINE-'));
        const next = [...inline, ...live];
        const unchanged =
          next.length === prev.length &&
          next.every((f, i) => f.id === prev[i].id && f.message === prev[i].message);
        return unchanged ? prev : next;
      });
    }, 600);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fd, vitals, ivRows, medRows, sigs, timestamps, kms, phase]);

  // Show en-route overlay when dispatch time is first marked
  useEffect(() => {
    if (timestamps.time_dispatched && !timestamps.time_on_scene) {
      setEnRouteOverlay(true);
    } else {
      setEnRouteOverlay(false);
    }
  }, [timestamps.time_dispatched, timestamps.time_on_scene]);

  // Auto-scroll to the "Start Examination" button once On Scene time + km are
  // captured. On a phone the button renders below the fold, so bring it to the
  // bottom of the screen (block:'end'). Keyed on the capture COMPLETING — not
  // the button tap — so it still fires when async GPS capture delays the state
  // update (the old fixed 150ms timeout raced the button's mount and scrolled
  // to nothing). Polls via requestAnimationFrame until the button exists, runs
  // once per capture, and skips resume (on-scene already set at mount) so the
  // page never jumps on load.
  const startExamScrolled = useRef<boolean>(!!timestamps.time_on_scene);
  useEffect(() => {
    const ready = !!(timestamps.time_on_scene && kms.km_on_scene) && !startedExam;
    if (!ready) { startExamScrolled.current = false; return; }
    if (startExamScrolled.current) return;
    if (typeof window === 'undefined' || window.innerWidth >= 768) return;
    let raf = 0;
    let tries = 0;
    const toButton = () => {
      const el = document.getElementById('start-exam-button');
      if (el) {
        startExamScrolled.current = true;
        el.scrollIntoView({ behavior: 'smooth', block: 'end' });
        return;
      }
      if (tries++ < 40) raf = requestAnimationFrame(toButton);
    };
    raf = requestAnimationFrame(toButton);
    return () => cancelAnimationFrame(raf);
  }, [timestamps.time_on_scene, kms.km_on_scene, startedExam]);

  const advancePhase = async (nextPhase: number, autoTimeKey?: string, autoKmKey?: string) => {
    const inlineBlockers = collectLeavePhaseBlockers(phase);
    if (inlineBlockers.length > 0) {
      showBlockerBanner(inlineBlockers);
      return;
    }

    // Validate the CURRENT phase against scheme rules before advancing.
    // The crew can still save drafts at any time — we only block the forward step.
    const { ok } = runValidation(phase as ValidationPhase);
    if (!ok) return;

    // Declaration of Death short-circuits En Route (1), Clinical (3),
    // Transport (4), and Handover (5) — the deceased patient doesn't have
    // those legs. The Undertaker form moves onto the On Scene phase so the
    // whole handover happens there. Auto-capture is suppressed at the same
    // time because the crew already recorded the relevant times via the
    // DoD panel's embedded table.
    let target = nextPhase;
    let timeKey = autoTimeKey;
    let kmKey = autoKmKey;
    if (fd.med_aid_dec_death) {
      // DoD also hides Complete (6) — submission happens from the On Scene
      // CTA directly, so advancePhase never has reason to land there.
      const hidden = new Set([1, 3, 4, 5, 6]);
      if (hidden.has(target)) {
        while (target < PHASES.length && hidden.has(target)) target++;
        timeKey = undefined;
        kmKey = undefined;
      }
    } else if (['RESUS', 'PRIMARY', 'COURTESY', 'IFT', 'IHT', 'WCA_IOD'].includes(fd.call_type)) {
      // These call types skip En Route (1), Clinical (3), and Complete (6).
      // The clinical body is rendered inline on Dispatch or skipped, and
      // submission happens on Handover (or On Scene for some). WCA_IOD is a
      // clinical Primary-style call — without it here, advancePhase would step
      // onto the hidden En Route/Clinical nodes that the stepper doesn't show.
      const hidden = new Set([1, 3, 6]);
      if (hidden.has(target)) {
        while (target < PHASES.length && hidden.has(target)) target++;
        timeKey = undefined;
        kmKey = undefined;
      }
    } else if (fd.call_type === 'RHT') {
      // RHT (Refused Hospital Transport): patient declined transport so
      // the Clinical (3), Transport (4), and Handover (5) legs don't
      // apply — there's no full assessment workflow, no journey to a
      // destination, and no receiving facility to hand over to. The
      // refusal waiver, Available time, and Submit all live inline at
      // the bottom of On Scene (2), so auto-capture is suppressed when
      // stepping past the skipped phases.
      const hidden = new Set([1, 3, 4, 5]);
      if (hidden.has(target)) {
        while (target < PHASES.length && hidden.has(target)) target++;
        timeKey = undefined;
        kmKey = undefined;
      }
    }

    // If this phase transition auto-captures a timestamp and it isn't yet set,
    // open the geo-confirm dialog. Advance happens in the dialog's onAfterCommit
    // callback so the crew confirms GPS before the journey moves forward.
    if (timeKey && !timestamps[timeKey]) {
      if (timeKey === 'time_depart_scene') {
        if (!kms.km_depart_scene && kms.km_on_scene) {
          handleKmChange('km_depart_scene', kms.km_on_scene);
        }
        setDepartPromptOpen(true);
        return;
      }
      if (timeKey === 'time_at_destination') {
        setDestinationPromptOpen(true);
        return;
      }
      markTime(timeKey, kmKey || '', async () => {
        await doSave();
        setPhase(target);
      });
      return;
    }
    await doSave();
    setPhase(target);
  };

  // Crew members on this PRF, used for the submit sign-off list. Crew 1 is the
  // logged-in crew; crew 2 + any extra crew come from the PRF record.
  const getCrewSignList = (): Array<{ key: string; name: string; sub: string }> => {
    const c2 = prfMeta?.crew_member_2 || null;
    const sub = (q?: string, h?: string) => [q, h].filter(Boolean).join(' · ');
    const list = [{ key: 'c1', name: profile?.name || 'Crew 1', sub: sub(profile?.qualification, profile?.hpcsa_number) }];
    if (c2) list.push({ key: 'c2', name: c2.full_name || 'Crew 2', sub: sub(c2.qualification, c2.hpcsa_number) });
    if (Array.isArray(fd.extra_crew)) {
      fd.extra_crew.forEach((c: any, i: number) => list.push({
        key: `c${i + 3}`,
        name: c.name || c.full_name || `Crew ${i + 3}`,
        sub: sub(c.qualification, c.hpcsa_number),
      }));
    }
    return list;
  };
  const allCrewSigned = (): boolean => {
    const sigs = fd.crew_signoff_sigs || {};
    return getCrewSignList().every(c => !!(sigs[c.key] && String(sigs[c.key]).trim()));
  };

  const handleSubmit = async () => {
    // Vitals-shortfall motivation gate. Three sets of vitals is the norm; in
    // rare cases (e.g. very short transport) the crew can record fewer — that's
    // allowed, but they must give a motivation first. RHT / death are exempt.
    //
    // This gate is evaluated BEFORE the in-flight guard below so the prompt can
    // ALWAYS (re)open: if a previous submit attempt ever left submitInFlightRef
    // stuck true, gating the popup behind that ref made every later tap return
    // silently and the motivation block could never be reopened. We also clear
    // the ref here defensively so the subsequent real submit isn't blocked.
    if (vitals.length < MIN_VITALS && !fd.med_aid_dec_death && fd.call_type !== 'RHT' && !fd.patient_refused_treatment) {
      if (!(fd.vitals_shortfall_motivation ?? '').trim()) {
        submitInFlightRef.current = false;
        setVitalsMotivationOpen(true);
        return;
      }
    }

    // Synchronous double-tap guard — bail immediately if a submit is already
    // running so a fast double-tap can't create two cases.
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;

    // Final pre-submit validation runs the SUBMIT phase (6) ruleset, which
    // includes everything from earlier phases marked phases:[...,6].
    const { ok, findings: f } = runValidation(6);
    if (!ok) {
      alert(
        `Cannot submit yet — ${validationBlockers(f).length} required item(s) missing. See the highlighted issues at the top of the form.`,
      );
      submitInFlightRef.current = false;
      return;
    }
    // Summary review gate — show the crew a read-only summary of everything
    // they entered so they can spot typos before signing. The "Looks Good"
    // button in the modal closes it and calls handleSubmit again.
    if (!summaryReviewOpen && !allCrewSigned()) {
      submitInFlightRef.current = false;
      setSummaryReviewOpen(true);
      return;
    }
    // Crew sign-off gate (replaces the plain confirm). Every crew member must
    // sign in the popup before the PRF goes through. The popup's "Confirm &
    // Submit" calls handleSubmit again once everyone has signed.
    if (!allCrewSigned()) {
      submitInFlightRef.current = false;
      setCrewSignOffOpen(true);
      return;
    }
    setSubmit(true);
    saveToLocal();  // Persist locally before server attempt

    // Drain any in-flight / pending autosave first so it can't clobber the
    // authoritative save below.
    while (savingInFlightRef.current || savePendingRef.current) {
      await new Promise(r => setTimeout(r, 100));
    }

    // Authoritative final save — MUST land before we lock the PRF via /submit.
    // The crew sign-off and patient signatures were drawn seconds ago in the
    // pre-submit modals; going through doSave()'s dedup + coalescing could skip
    // or defer this save (a deferred save then 423s after submit and is lost),
    // which dropped every signature captured at submit time — crew + patient
    // saved NULL while the earlier handover signature persisted. Patch the full
    // payload directly and await it, retrying once on a 409 version conflict.
    {
      let saved = false;
      for (let attempt = 0; attempt < 2 && !saved; attempt++) {
        const finalPayload = buildSavePayload();
        if (baseUpdatedAtRef.current) finalPayload.client_base_updated_at = baseUpdatedAtRef.current;
        try {
          const resp = await api().patch(`/api/digital-prf/${prfId}`, finalPayload);
          if (resp?.data?.updated_at) baseUpdatedAtRef.current = resp.data.updated_at;
          lastSavedPayloadRef.current = JSON.stringify(finalPayload);
          saved = true;
        } catch (err: any) {
          const code = err?.response?.status;
          if (code === 409) {
            // Another writer bumped the version — refresh the token and retry.
            try {
              const fresh = await api().get(`/api/digital-prf/${prfId}`);
              baseUpdatedAtRef.current = fresh?.data?.updated_at || null;
            } catch { /* ignore */ }
            continue;
          }
          if (code === 423) { saved = true; break; } // already submitted — nothing to save
          if (code === 401) {
            // Session expired — preserve everything (incl. signatures) offline.
            await queueToOutbox(finalPayload);
            handleSessionExpired();
            return;
          }
          // Offline / 500: fall through to the submit below, which routes to the
          // offline outbox (buildSavePayload carries the signatures) so nothing
          // is lost.
          break;
        }
      }
    }

    try {
      const r = await api().post(`/api/digital-prf/${prfId}/submit`);
      const status: string = r.data?.status;
      const newCaseId: string | undefined = r.data?.case_id;

      // The submit endpoint now returns 202 with status:"submitted" when the
      // billing pipeline runs in the background (Celery task). If the PRF was
      // already processed (idempotent replay), it returns status:"processed"
      // with the existing case_id.
      if (status === 'submitted' || status === 'processed') {
        // Only trigger the share-to-receiving-facility flow when we have a
        // case_id (already processed) AND a valid handover email.
        const rawEmail = (fd.handover_doctor_email || '').trim();
        const hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail);

        if (newCaseId && hasEmail) {
          clearLocalDraft();
          navigate(`/${providerSlug}/crew/prf-view/${newCaseId}?send=1`);
        } else {
          clearLocalDraft();
          alert('PRF submitted successfully.');
          navigate(`/${providerSlug}/crew/dashboard`);
        }
      } else {
        clearLocalDraft();
        alert('PRF submitted successfully.');
        navigate(`/${providerSlug}/crew/dashboard`);
      }
    } catch (e: any) {
      const statusCode = e?.response?.status;
      if (statusCode === 401) {
        // Session expired — preserve the submission offline so it completes
        // automatically after re-login, then route to login.
        try {
          const { queueSubmit } = await import('../../services/offlineDb');
          await queueSubmit(prfId!, buildSavePayload());
          window.dispatchEvent(new CustomEvent('outbox-change'));
        } catch { /* IndexedDB unavailable */ }
        submitInFlightRef.current = false;
        setSubmit(false);
        handleSessionExpired();
        return;
      }
      // Self-heal: the PRF row is gone server-side (404) — e.g. an End Shift
      // in another tab swept drafts while this tab still holds the full form.
      // Rather than lose the crew's work, re-create the PRF from the in-memory
      // data and submit the fresh row. (A 404 here is deterministic — the row
      // truly doesn't exist — so this can't create a duplicate of a live PRF.)
      if (statusCode === 404) {
        try {
          const supervisor = (() => {
            try { return JSON.parse(localStorage.getItem('shift_supervisor') || 'null'); }
            catch { return null; }
          })();
          const createRes = await api().post('/api/digital-prf', {
            vehicle_id: vehicle || null,
            crew_member_2_id: crew2Id || null,
            supervising_practitioner_pr: supervisor?.hpcsa_number || null,
            supervising_practitioner_name: supervisor?.name || null,
            supervising_practitioner_qualification: supervisor?.qualification || null,
          });
          const newId = createRes.data?.id;
          if (newId) {
            await api().patch(`/api/digital-prf/${newId}`, buildSavePayload());
            const subRes = await api().post(`/api/digital-prf/${newId}/submit`);
            const st = subRes.data?.status;
            const caseId = subRes.data?.case_id;
            if (st === 'submitted' || st === 'processed') {
              clearLocalDraft();
              const rawEmail = (fd.handover_doctor_email || '').trim();
              const hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail);
              if (caseId && hasEmail) {
                navigate(`/${providerSlug}/crew/prf-view/${caseId}?send=1`);
              } else {
                alert('PRF submitted successfully.');
                navigate(`/${providerSlug}/crew/dashboard`);
              }
              setSubmit(false);
              submitInFlightRef.current = false;
              return;
            }
          }
        } catch { /* fall through to the generic message below */ }
        alert('This PRF was removed from the server (a shift may have been ended in another tab) and could not be recovered automatically. Please note any critical details and start a new PRF.');
        setSubmit(false);
        submitInFlightRef.current = false;
        return;
      }
      // Offline fallback: queue submission to outbox
      if (!navigator.onLine || e?.code === 'ECONNABORTED' || e?.code === 'ERR_NETWORK') {
        try {
          const { queueSubmit } = await import('../../services/offlineDb');
          await queueSubmit(prfId!, buildSavePayload());
          window.dispatchEvent(new CustomEvent('outbox-change'));
          alert('You are offline. PRF has been saved locally and will submit automatically when connectivity returns.');
          navigate(`/${providerSlug}/crew/dashboard`);
        } catch {
          alert('Submission failed and offline save is unavailable. Please try again.');
        }
      } else {
        // Surface server-side validation errors (422) clearly to the crew.
        const detail = e?.response?.data?.detail;
        if (statusCode === 422 && detail) {
          const msgs = Array.isArray(detail?.errors) ? detail.errors.join('\n• ') : (detail?.message || detail);
          alert(`Cannot submit:\n• ${msgs}`);
        } else {
          alert((typeof detail === 'string' ? detail : detail?.message) || 'Submission failed');
        }
      }
    }
    setSubmit(false);
    submitInFlightRef.current = false;
  };

  // ── Computed smart values ─────────────────────────────────────────────────
  // Debounced copy of `vitals` used ONLY for the critical-vitals banner.
  // Evaluating on every keystroke made the banner flap: a half-typed HR ("1",
  // then "12" on the way to "120") reads as severe bradycardia (<40), so the
  // banner appeared then vanished per digit, shifting the whole phase layout
  // under the crew's finger — the reported "HR field page jump". Lagging it
  // ~700ms means the banner only re-evaluates once typing settles, so partial
  // values never trigger a transient alert or a layout shift.
  const [debouncedVitals, setDebouncedVitals] = useState(vitals);
  useEffect(() => {
    const h = window.setTimeout(() => setDebouncedVitals(vitals), 700);
    return () => window.clearTimeout(h);
  }, [vitals]);

  const criticalAlerts = useMemo(() => {
    const alerts: string[] = [];
    if (!debouncedVitals.length) return alerts;
    const v = debouncedVitals[debouncedVitals.length - 1];
    const spo2 = parseFloat(v.spo2), hr = parseFloat(v.hr);
    if (!isNaN(spo2) && spo2 < 90) alerts.push(`SpO₂ ${spo2}% — critical hypoxia`);
    if (!isNaN(hr) && hr > 180) alerts.push(`HR ${hr} bpm — severe tachycardia`);
    if (!isNaN(hr) && hr < 40) alerts.push(`HR ${hr} bpm — severe bradycardia`);
    if (v.bp) { const sys = parseInt(v.bp); if (!isNaN(sys) && sys < 90) alerts.push(`BP ${v.bp} — hypotension`); }
    const gcs = (+v.gcs_e || 0) + (+v.gcs_v || 0) + (+v.gcs_m || 0);
    if (gcs > 0 && gcs < 9) alerts.push(`GCS ${gcs}/15 — severe neurological compromise`);
    return alerts;
  }, [debouncedVitals]);

  // Debounce the allergies value the same way as vitals: the Allergy banner
  // sits directly above the Allergies input, so re-evaluating it on every
  // keystroke / dictation commit popped the banner in mid-hold, shifted the
  // field down under the crew's thumb ("screen snaps"), and that layout reflow
  // cancelled the speech recogniser — words then dropped repeatedly. Settling
  // ~700ms after input stops means the banner never flips while dictating.
  const [debouncedAllergies, setDebouncedAllergies] = useState(fd.allergies || '');
  useEffect(() => {
    const h = window.setTimeout(() => setDebouncedAllergies(fd.allergies || ''), 700);
    return () => window.clearTimeout(h);
  }, [fd.allergies]);

  const allergyAlert = useMemo(() => {
    const a = (debouncedAllergies || '').trim();
    if (!a) return null;
    if (['none', 'nka', 'nil known', 'no known', 'nkda'].some(t => a.toLowerCase().includes(t))) return null;
    return a;
  }, [debouncedAllergies]);

  // sceneSeconds / transportSeconds were derived from a per-second `now` state
  // that re-rendered the whole form. <LiveTimer> in the header now owns the
  // tick, so the form is left alone while the user types on mobile.

  const handoverSummary = useMemo(() => {
    const last = vitals[vitals.length - 1];
    return {
      patient: [fd.patient_name, fd.patient_surname].filter(Boolean).join(' ') || '—',
      age: fd.age ? `${fd.age}${fd.gender ? fd.gender[0].toUpperCase() : ''}` : '—',
      complaint: fd.chief_complaint || '—',
      priority: fd.priority || '—',
      level: fd.assessment_level || '—',
      allergies: fd.allergies || 'None Known',
      hr: last?.hr || '—', bp: last?.bp || '—', spo2: last?.spo2 ? `${last.spo2}%` : '—',
      meds: medRows.filter(r => r.type).map(r => `${r.type}${r.dose ? ` ${r.dose}` : ''}${r.route ? ` ${r.route}` : ''}`).join(', ') || 'None',
      procedures: [
        ...(Array.isArray(fd.airway_interventions) ? fd.airway_interventions : []),
        ...(Array.isArray(fd.circulation_interventions) ? fd.circulation_interventions : []),
      ].join(', ') || 'None',
    };
  }, [fd, vitals, medRows]);


  // ── Timing row with Mark button + manual address field ───────────────────
  // Each row now has a per-timestamp address text field (stored in form_data
  // under `address_<timeKey>`). When GPS + reverse-geocode succeed at Mark
  // Time, that resolved street is auto-written into this field so the crew
  // doesn't have to retype it. When GPS is unavailable / inaccurate or
  // there's no signal for the geocoder, the crew can type the address
  // manually here. The grid is 4 columns on desktop and stacks the address
  // beneath time+km on mobile so the input stays a comfortable width.
  // Responsive: on phones (< 640px) the 4-col layout squeezes each cell
  // to ~50–70 px, so a 6-digit km value (e.g. "120 000") spills across the
  // border into the address column. Below the threshold we drop the
  // address out of the row grid and place it on a second row beneath,
  // full-width — leaves the km cell comfortable.
  const timeRowsNarrow = useIsNarrowViewport(640);
  const TIME_ROW_COLS = timeRowsNarrow ? '1.3fr 1.5fr 1.5fr' : '1.4fr 1.7fr 1.7fr 2.4fr';
  const TIME_HEADERS = timeRowsNarrow ? ['EVENT', 'TIME', 'KM'] : ['EVENT', 'TIME', 'KM', 'ADDRESS'];
  const TimeRow = ({ row }: { row: typeof ALL_TIME_ROWS[0] }) => {
    const has = !!timestamps[row.timeKey];
    const geo = geos[row.timeKey];
    // The On Scene arrival address IS the incident address. Bind this row's
    // ADDRESS field directly to `incident_location` (the field the PDF renders
    // as "Incident Add"), so the On Scene geo-locator — or an address typed
    // into this row — is the SINGLE source of the PDF's Incident Address.
    // Every other leg keeps its own per-row address field. This is the one and
    // only path from the On Scene arrival to the incident address field.
    const addressKey = row.timeKey === 'time_on_scene' ? 'incident_location' : `address_${row.timeKey}`;
    const addressVal: string = fd[addressKey] || '';
    const isIftDispatch = row.timeKey === 'time_dispatched' && ['IFT', 'IHT'].includes(fd.call_type);
    const handleMark = () => {
      // A leg prompt / geo-capture is already in progress → ignore this tap.
      // On mobile a tap on the odometer inside the Dispatch modal was leaking
      // through to this (behind-the-modal) row cell and firing a second mark,
      // which popped the "Confirm Location" overlay. Never mark twice.
      if (dispatchPromptOpen || onScenePromptOpen || departPromptOpen || destinationPromptOpen || pendingMark) return;
      if (isIftDispatch) {
        setDispatchPromptOpen(true);
        window.setTimeout(() => dispatchKmRef.current?.focus(), 50);
      } else {
        markTime(row.timeKey, row.kmKey);
      }
    };
    const addressInput = has ? (
      <AddrInp
        fk={addressKey}
        ph={timeRowsNarrow ? 'Address' : ''}
        containerStyle={{ marginBottom: 0 }}
        inputStyle={{
          width: '100%', padding: '8px 10px', fontSize: '0.78rem',
          borderRadius: 7, border: `1px solid ${S200}`, background: W,
          color: S900, outline: 'none', boxSizing: 'border-box',
          fontFamily: 'inherit',
        }}
      />
    ) : (
      <div
        onClick={handleMark}
        style={{
          width: '100%', padding: '16.5px 10px',
          borderRadius: 7, border: `1px solid ${S200}`, background: W,
          cursor: 'pointer', boxSizing: 'border-box'
        }}
      />
    );
    return (
      <div style={{ borderTop: `1px solid ${S200}`, background: W }}>
        <div style={{ display: 'grid', gridTemplateColumns: TIME_ROW_COLS, alignItems: 'center' }}>
          <div style={{ padding: '10px 14px', fontSize: '0.78rem', fontWeight: 700, color: S600, borderRight: `1px solid ${S200}`, minWidth: 0, overflow: 'hidden' }}>
            {row.label}
            {geo && (
              <a
                href={`https://www.google.com/maps?q=${geo.lat},${geo.lng}`}
                target="_blank" rel="noreferrer"
                title={`${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}${geo.accuracy_m ? ` ±${Math.round(geo.accuracy_m)}m` : ''}`}
                style={{ marginLeft: 6, fontSize: '0.7rem', textDecoration: 'none' }}
              >📍</a>
            )}
          </div>
          <div style={{ padding: '7px 10px', borderRight: `1px solid ${S200}`, minWidth: 0 }}>
            {has ? (
              <input
                type="time"
                value={fmtTime(timestamps[row.timeKey]) || ''}
                onChange={e => {
                  const v = e.target.value;
                  if (!v) return;
                  const [hh, mm] = v.split(':').map(s => parseInt(s, 10));
                  if (Number.isNaN(hh) || Number.isNaN(mm)) return;
                  const prevIso = timestamps[row.timeKey];
                  const d = prevIso ? new Date(prevIso) : new Date();
                  d.setHours(hh, mm, 0, 0);
                  setTs(p => ({ ...p, [row.timeKey]: d.toISOString() }));
                }}
                aria-label={`${row.label} time`}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  fontFamily: 'monospace', fontWeight: 800, fontSize: '1rem',
                  color: GDK, background: GBG,
                  padding: '7px 8px', borderRadius: 8,
                  border: 'none', outline: 'none',
                  textAlign: 'center', cursor: 'pointer',
                  appearance: 'none', WebkitAppearance: 'none',
                }}
              />
            ) : (
              <button type="button" onClick={handleMark} style={{ width: '100%', padding: '11px 0', borderRadius: 9, fontSize: '0.8rem', fontWeight: 800, border: `2px solid ${G}`, background: GBG, color: GDK, cursor: 'pointer' }}>Mark Time</button>
            )}
          </div>
          <div style={{ padding: '7px 4px', borderRight: timeRowsNarrow ? 'none' : `1px solid ${S200}`, minWidth: 0 }}>
            {has ? (
              <KmInput kmKey={row.kmKey} value={kms[row.kmKey] ?? ''} onChange={handleKmChange} onCommit={handleKmCommit} />
            ) : (
              <div
                onClick={handleMark}
                style={{
                  width: '100%', padding: '17px 6px',
                  borderRadius: 10, border: `1.5px solid #e2e8f0`, background: '#ffffff',
                  cursor: 'pointer', boxSizing: 'border-box'
                }}
              />
            )}
          </div>
          {!timeRowsNarrow && (
            <div style={{ padding: '7px 8px', minWidth: 0 }}>{addressInput}</div>
          )}
        </div>
        {timeRowsNarrow && (
          <div style={{ padding: '4px 10px 10px', borderTop: `1px dashed ${S200}` }}>{addressInput}</div>
        )}
      </div>
    );
  };

  const TimeTable = ({ rows }: { rows: typeof ALL_TIME_ROWS }) => (
    <div style={{ borderRadius: 14, overflow: 'hidden', border: `1.5px solid ${S200}`, marginBottom: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: TIME_ROW_COLS, background: G }}>
        {TIME_HEADERS.map((h, i, a) => (
          <div key={h} style={{ padding: '10px 14px', fontSize: '0.65rem', fontWeight: 800, color: W, letterSpacing: '0.1em', borderRight: i < a.length - 1 ? '1px solid rgba(255,255,255,0.15)' : 'none' }}>{h}</div>
        ))}
      </div>
      {rows.map(r => <div key={r.timeKey}>{TimeRow({ row: r })}</div>)}
    </div>
  );

  // ── Critical alerts banner ────────────────────────────────────────────────
  const CriticalBanner = () => criticalAlerts.length === 0 ? null : (
    <div style={{ background: `${REDC}12`, border: `2px solid ${REDC}`, borderRadius: 12, padding: '12px 16px', marginBottom: 16 }}>
      <div style={{ fontSize: '0.72rem', fontWeight: 800, color: REDC, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Critical Vitals Alert</div>
      {criticalAlerts.map((a, i) => (
        <div key={i} style={{ fontSize: '0.85rem', fontWeight: 600, color: '#7f1d1d', marginTop: 3 }}>• {a}</div>
      ))}
    </div>
  );

  // ── Allergy banner ────────────────────────────────────────────────────────
  const AllergyBanner = () => !allergyAlert ? null : (
    <div style={{ background: `${AMB}15`, border: `2px solid ${AMB}`, borderRadius: 12, padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      <div style={{ fontSize: '1.1rem', flexShrink: 0 }}>⚠</div>
      <div>
        <div style={{ fontSize: '0.72rem', fontWeight: 800, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>Allergy Alert</div>
        <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#78350f' }}>{allergyAlert}</div>
      </div>
    </div>
  );

  // ── Vitals section (shared between Clinical and Transport) ────────────────
  const VitalsSection = ({ showFull = false }: { showFull?: boolean }) => {
    const fields = showFull ? VS_FULL : VS_QUICK;
    const editing = editVital >= 0 ? vitals[editVital] : null;
    const updVS = (k: string, v: any) => {
      const next = [...vitals]; next[editVital] = { ...next[editVital], [k]: v };
      // GCS auto-sum
      if (['gcs_e', 'gcs_v', 'gcs_m'].includes(k)) {
        const updated = { ...next[editVital], [k]: v };
        const total = (+updated.gcs_e || 0) + (+updated.gcs_v || 0) + (+updated.gcs_m || 0);
        if (total > 0) updated.gcs_total = String(total);
        next[editVital] = updated;
      }
      setVitals(next); dirtyRef.current = true;
    };
    const gcsTotal = editing ? (+editing.gcs_e || 0) + (+editing.gcs_v || 0) + (+editing.gcs_m || 0) : 0;
    const gcsColor = gcsTotal < 9 ? REDC : gcsTotal < 14 ? AMB : G;

    return (
      <>
        {/* Completed vital cards */}
        {vitals.map((vs, i) => i === editVital ? null : (
          <div key={i} style={{ background: W, borderRadius: 12, border: `1.5px solid ${S200}`, padding: '12px 16px', marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: '0.88rem', color: S900 }}>
                Set #{i + 1}
                {vs.time && <span style={{ fontFamily: 'monospace', fontWeight: 500, color: S400, marginLeft: 8, fontSize: '0.8rem' }}>{vs.time}</span>}
              </div>
              <div style={{ fontSize: '0.72rem', color: S600, marginTop: 3, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {vs.hr && <span style={{ fontWeight: 700 }}>HR <b>{vs.hr}</b></span>}
                {vs.bp && <span style={{ fontWeight: 700 }}>BP <b>{vs.bp}</b></span>}
                {vs.spo2 && <span style={{ fontWeight: 700, color: +vs.spo2 < 90 ? REDC : S600 }}>SpO₂ <b>{vs.spo2}%</b></span>}
                {vs.pain && <span style={{ fontWeight: 700 }}>Pain <b>{vs.pain}/10</b></span>}
                {(vs.gcs_e && vs.gcs_v && vs.gcs_m) && (
                  <span style={{ fontWeight: 700, color: (+vs.gcs_e || 0) + (+vs.gcs_v || 0) + (+vs.gcs_m || 0) < 9 ? REDC : S600 }}>
                    GCS <b>{(+vs.gcs_e || 0) + (+vs.gcs_v || 0) + (+vs.gcs_m || 0)}</b>
                  </span>
                )}
              </div>
            </div>
            <button type="button" onClick={() => setEditVital(i)} style={{ padding: '8px 14px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 700, border: `1.5px solid ${S200}`, background: S50, color: S600, cursor: 'pointer' }}>Edit</button>
          </div>
        ))}

        {/* Active editor */}
        {editing && (
          <div style={{ background: '#ffffff', border: `1.5px solid ${S200}`, borderRadius: 14, padding: 18, marginBottom: 16, boxShadow: '0 4px 14px rgba(0,0,0,0.03)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ fontWeight: 800, color: S900 }}>Vitals Set #{editVital + 1}</div>
              <button type="button" onClick={() => {
                setEditVital(-1);
                window.setTimeout(() => document.getElementById('vitals-add-button')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 10);
              }} style={{ padding: '8px 18px', borderRadius: 8, fontSize: '0.82rem', fontWeight: 800, border: 'none', background: S800, color: W, cursor: 'pointer' }}>Done</button>
            </div>
            <Lbl t="Time Recorded" />
            <input type="time" value={editing.time ?? ''} onChange={e => updVS('time', e.target.value)} onFocus={onF} onBlur={onB} style={{ ...base, marginBottom: 14 }} />

            {fields.map(f => {
              const hasOpts = 'opts' in f && f.opts;
              const isNumericField = 'type' in f && f.type === 'number';
              return (
                <div key={f.key} style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
                    <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{f.label}</div>
                  </div>
                  {f.key === 'bp' ? (
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <input
                        type="text" inputMode="decimal" placeholder="SYS"
                        value={editing.bp ? editing.bp.split('/')[0] : ''}
                        onChange={e => {
                          const sys = e.target.value.replace(/[^0-9]/g, '');
                          const dia = editing.bp ? editing.bp.split('/')[1] : '';
                          updVS('bp', dia ? `${sys}/${dia}` : sys);
                        }}
                        onFocus={onF} onBlur={onB} {...NO_AUTOFILL} name={`nf-vit-${editVital}-bp-sys-${NF_NONCE}`}
                        style={{ ...base, marginBottom: 0, flex: 1, textAlign: 'center' }}
                      />
                      <span style={{ color: '#94a3b8', fontWeight: 700, fontSize: '1.2rem' }}>/</span>
                      <input
                        type="text" inputMode="decimal" placeholder="DIA"
                        value={editing.bp && editing.bp.includes('/') ? editing.bp.split('/')[1] : ''}
                        onChange={e => {
                          const dia = e.target.value.replace(/[^0-9]/g, '');
                          const sys = editing.bp ? editing.bp.split('/')[0] : '';
                          updVS('bp', sys ? `${sys}/${dia}` : `/${dia}`);
                        }}
                        onFocus={onF} onBlur={onB} {...NO_AUTOFILL} name={`nf-vit-${editVital}-bp-dia-${NF_NONCE}`}
                        style={{ ...base, marginBottom: 0, flex: 1, textAlign: 'center' }}
                      />
                    </div>
                  ) : hasOpts ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {f.opts!.map(o => {
                        const on = editing[f.key] === o;
                        return <button key={o} type="button" onClick={() => updVS(f.key, o)} style={{ padding: '9px 14px', borderRadius: 8, fontSize: '0.8rem', fontWeight: 700, border: `2px solid ${on ? S700 : S200}`, background: on ? S50 : W, color: on ? S900 : S600, cursor: 'pointer', transition: 'all 0.12s' }}>{o}</button>;
                      })}
                    </div>
                  ) : (
                    <input
                      type="text"
                      // `decimal` opens the numeric keypad first for number
                      // fields AND Temp (a decimal like 36.5). type stays
                      // "text" so the crew can still switch to letters where
                      // the keyboard offers it and the auto-appended "°C"/unit
                      // suffix is preserved.
                      inputMode={(isNumericField || f.key === 'temp') ? 'decimal' : 'text'}
                      value={editing[f.key] ?? ''}
                      onChange={e => updVS(f.key, e.target.value)}
                      placeholder={'placeholder' in f ? f.placeholder : ''}
                      {...NO_AUTOFILL}
                      name={`nf-vit-${editVital}-${f.key}-${NF_NONCE}`}
                      onFocus={onF}
                      onBlur={e => {
                        onB(e);
                        // Auto-populate units for HGT and Temp if a value was typed
                        if (f.key === 'hgt') {
                          const v = e.target.value.trim();
                          if (v && !v.toLowerCase().includes('mmol')) updVS(f.key, `${v} mmol/L`);
                        } else if (f.key === 'temp') {
                          const v = e.target.value.trim();
                          if (v && !v.toLowerCase().includes('c')) updVS(f.key, `${v} °C`);
                        }
                      }}
                      style={{ ...base, marginBottom: 0 }}
                    />
                  )}
                  {/* GCS total auto-display */}
                  {f.key === 'gcs_m' && gcsTotal > 0 && (
                    <div style={{ marginTop: 10, padding: '10px 14px', borderRadius: 10, background: `${gcsColor}15`, border: `1.5px solid ${gcsColor}40`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: 700, color: gcsColor }}>GCS Total</span>
                      <span style={{ fontSize: '1.1rem', fontWeight: 900, color: gcsColor, fontFamily: 'monospace' }}>
                        {gcsTotal}/15 — {gcsTotal < 9 ? 'Severe' : gcsTotal < 14 ? 'Moderate' : 'Normal'}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
            <button type="button" onClick={() => {
              setEditVital(-1);
              window.setTimeout(() => document.getElementById('vitals-add-button')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 10);
            }} style={{ width: '100%', padding: 14, borderRadius: 10, fontWeight: 800, fontSize: '0.92rem', border: 'none', background: `linear-gradient(135deg,${G},${GDK})`, color: W, cursor: 'pointer', marginTop: 4 }}>Save Set #{editVital + 1}</button>
          </div>
        )}

        {editVital < 0 && (
          <div id="vitals-add-button">
            <button type="button" onClick={() => {
              const t = new Date();
              const newSet = { time: `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` };
              const next = [...vitals, newSet]; setVitals(next); setEditVital(next.length - 1); dirtyRef.current = true;
            }} style={{ width: '100%', padding: 15, borderRadius: 12, fontSize: '0.9rem', fontWeight: 800, border: `2px dashed ${G}`, background: GBG, color: GDK, cursor: 'pointer', marginBottom: 4 }}>
              + Add Vitals Set #{vitals.length + 1}
            </button>
          </div>
        )}
      </>
    );
  };



  // ── QA test-fill ──────────────────────────────────────────────────────────
  // Auto-populates the whole PRF for a chosen call-type × billing-type combo so
  // testers can reach Submit / PDF quickly without retyping every field.
  const TEST_MATRIX: Record<string, string[]> = {
    PRIMARY:  ['MED AID', 'RAF', 'PVT', 'EVENT', 'CALL OUT FEE'],
    IHT:      ['MED AID', 'RAF', 'PVT', 'EVENT', 'CALL OUT FEE'],
    RHT:      ['MED AID', 'RAF', 'PVT', 'EVENT', 'CALL OUT FEE'],
    WCA_IOD:  ['WCA / IOD'],
    COURTESY: ['MED AID', 'RAF', 'PVT', 'EVENT', 'CALL OUT FEE'],
    RESUS:    ['MED AID', 'PVT'],
    DOD:      ['MED AID', 'PVT'],
  };
  const TEST_CALL_LABEL: Record<string, string> = { IHT: 'IFT/IHT', WCA_IOD: 'WCA / IOD' };

  const applyTestFill = (callType: string, billingType: string) => {
    const base: Record<string, any> = {
      call_type: callType,
      billing_type: billingType,
      med_aid_dec_death: callType === 'DOD',
      med_aid_resus: callType === 'RESUS',
      // Call information
      incident_location: '12 Test Incident Road, Durban',
      suburb_ward: 'Testville',
      referring_doctor: 'Dr Test Referrer',
      receiving_facility: 'Test General Hospital',
      ward: 'casualty',
      receiving_doctor: 'Dr Test Receiver',
      // Patient (debtor marked same-as-patient for speed)
      gender: 'Male',
      patient_name: 'Test', patient_surname: 'Patient',
      patient_id_number: '9001015800086', patient_dob: '1990-01-01', age: '36',
      patient_address: '34 Test Residence Ave', patient_suburb: 'Testville', patient_postal_code: '4001',
      patient_phone_cell: '0820000001', patient_phone_home: '0310000001', patient_phone_work: '0310000002',
      accompanying_persons_count: '1',
      flags: ['debtor_same_as_patient'],
      // Priority / assessment / mechanism
      priority: (callType === 'RESUS' || callType === 'DOD') ? '' : 'RED',
      assessment_level: 'BLS', monitoring_level: 'BLS',
      mechanism: ['FALL'], mechanism_other: 'Test mechanism detail',
      // Handover / valuables / notes
      handover_name: 'Test Handover Nurse', handover_qualification: 'PN',
      handover_doctor_email: 'test@hospital.example', handover_notes: 'Stable on handover',
      valuables_handed_to: 'Test Security', valuables_description: 'Phone and wallet',
      management_notes: 'Test management narrative for QA fill.',
      motivation_notes: 'Test motivation / other notes for QA fill.',
      // Oxygen / airway / circulation / immobilisation
      o2_flow_rate: '8', o2_percent: '60', o2_device: 'NRB', o2_bvm: 'No',
      o2_start_time: '09:40', o2_stop_time: '10:00',
      airway_interventions: ['SELF-MAINTAINED'],
      circulation_interventions: ['PERIPH. IV LINE'], iv_attempts: '1',
      immob_equipment: ['COLLAR'],
      // Surveys
      survey_a: 'Clear', survey_b: 'Equal AE', survey_c: 'Strong pulse',
      survey_head_back: 'NAD', survey_neuro: 'GCS 15', survey_chest: 'Clear',
      survey_abdo: 'Soft', survey_limbs: 'Intact', survey_back: 'NAD',
      // History
      chief_complaint: 'Test chief complaint', primary_diagnosis: 'Test diagnosis',
      findings_on_arrival: 'Test findings', allergies: 'NKDA', current_medications: 'None',
      past_medical_history: 'None', last_meal: 'Breakfast', last_meal_time: '07:00',
      events_hpi: 'Test HPI narrative',
    };

    // Call-type-specific extras
    if (callType === 'DOD') {
      // Declaration of Death — populate the full current field set so a
      // QA-filled DOD renders complete on its dedicated PDF page. (The old
      // `declared_by` / bare `hpcsa` keys were retired when the DOD form was
      // expanded, so they're replaced by the hcp_* + deceased_* fields below.)
      base.med_aid_dec_death_time = '09:45';
      base.med_aid_dec_death_case_no = 'DOD-TEST-001';
      base.med_aid_dec_death_location = 'Bedroom, 34 Test Residence Ave';
      base.med_aid_dec_death_identified_by = 'Test Patient (per SA ID)';
      // Particulars of deceased (same person as the Patient Information above)
      base.med_aid_dec_death_deceased_gender = 'Male';
      base.med_aid_dec_death_deceased_first_name = 'Test';
      base.med_aid_dec_death_deceased_surname = 'Patient';
      base.med_aid_dec_death_deceased_id = '9001015800086';
      base.med_aid_dec_death_deceased_dob = '1990-01-01';
      base.med_aid_dec_death_deceased_age = '36';
      base.med_aid_dec_death_deceased_cell = '0820000001';
      base.med_aid_dec_death_deceased_tel_home = '0310000001';
      base.med_aid_dec_death_deceased_tel_work = '0310000002';
      base.med_aid_dec_death_deceased_address = '34 Test Residence Ave';
      base.med_aid_dec_death_deceased_suburb = 'Testville';
      base.med_aid_dec_death_deceased_postal_code = '4001';
      // Healthcare professional
      base.med_aid_dec_death_hcp_surname = 'Medic';
      base.med_aid_dec_death_hcp_first_name = 'Test';
      base.med_aid_dec_death_hcp_station = 'Test Base 1';
      base.med_aid_dec_death_hcp_qualification = 'ALS';
      base.med_aid_dec_death_hcp_id = '8501015800088';
      base.med_aid_dec_death_hcp_hpcsa = 'PHC123';
      // Confirmation of death
      base.med_aid_dec_death_med_carotid = 'Confirmed';
      base.med_aid_dec_death_med_heart_sounds = 'Confirmed';
      base.med_aid_dec_death_med_respiratory = 'Confirmed';
      base.med_aid_dec_death_med_ecg = 'Asystole';
      base.med_aid_dec_death_med_pupils = 'Fixed & dilated';
      // Deceased handed over to
      base.med_aid_dec_death_handover_surname = 'Undertaker';
      base.med_aid_dec_death_handover_first_name = 'Test';
      base.med_aid_dec_death_handover_relationship = 'Undertaker';
      base.med_aid_dec_death_handover_contact = '0829999999';
      // Declaration
      base.med_aid_dec_death_signatory_name = 'Test Medic';
      base.med_aid_dec_death_signature_date = '2026-07-18';
      base.med_aid_dec_death_signature_place = 'Testville';
      base.med_aid_dec_death_crew_attended_name = 'Test Crew 2';
      base.med_aid_dec_death_witness_name = 'Test Witness';
    }
    if (callType === 'RESUS') {
      base.med_aid_resus_level = 'ALS';
      base.med_aid_resus_fee = '1500';
    }
    if (callType === 'IHT') {
      base.transfer_subtype = 'IHT';
      base.preauth_number = 'PRE-TEST-001';
      base.post_auth_number = 'POST-TEST-001';
    }
    if (callType === 'RHT') {
      base.rht_call_out_fee = '750';
      base.return_despatch_time = '11:00';
      base.return_on_scene_time = '11:10';
      base.return_depart_scene_time = '11:20';
      base.return_at_destination_time = '11:40';
      base.return_handover_time = '11:45';
      base.return_available_time = '11:55';
    }

    // Billing-type-specific extras
    switch (billingType) {
      case 'MED AID':
        Object.assign(base, { medical_scheme: 'Discovery Health', medical_aid_number: 'MA-TEST-123', dependent_number: '01', main_member_id: 'MM-TEST-1', scheme_option: 'Classic Comprehensive' });
        break;
      case 'WCA / IOD':
        Object.assign(base, { compensation_reference: 'IOD-REF-1', wca_employer: 'Test Employer', wca_employee_number: 'EMP-1', wca_injury_date: '2026-06-10', wca_oar_number: 'OAR-1' });
        break;
      case 'RAF':
        Object.assign(base, { compensation_reference: 'RAF-REF-1', raf_accident_date: '2026-06-10', raf_police_case_number: 'CAS-1', raf_accident_location: 'N2 Highway' });
        break;
      case 'PVT':
        Object.assign(base, { pvt_payment_method: 'EFT', pvt_account_holder: 'Test Holder', pvt_account_holder_id: '9001015800086', pvt_account_holder_phone: '0820000009', pvt_account_holder_address: '34 Test Ave' });
        break;

      case 'CALL OUT FEE':
        Object.assign(base, { callout_requested_by: 'Test Requester', callout_authorisation: 'AUTH-1', callout_standdown_reason: 'Stood down on arrival' });
        break;
    }

    setFd(prev => ({ ...prev, ...base }));

    // Times + odometer
    const now = Date.now();
    const iso = (m: number) => new Date(now + m * 60000).toISOString();
    setTs(prev => ({ ...prev,
      time_dispatched: iso(0), time_on_scene: iso(6),
      time_depart_scene: iso(20), time_at_destination: iso(30), time_available: iso(40),
    }));
    setKms(prev => ({ ...prev,
      km_dispatched: '23', km_on_scene: '24',
      km_depart_scene: '45', km_at_destination: '45', km_available: '70',
    }));

    // 3 vitals sets + IV / medication rows
    setVitals([
      { time: '09:45', resp_rate: '18', spo2: '97', hr: '88', bp: '130/85', gcs_e: '4', gcs_v: '5', gcs_m: '6', gcs_total: '15', temp: '36.8', pain: '6' },
      { time: '09:55', resp_rate: '17', spo2: '98', hr: '84', bp: '128/84', gcs_e: '4', gcs_v: '5', gcs_m: '6', gcs_total: '15', temp: '36.7', pain: '4' },
      { time: '10:05', resp_rate: '16', spo2: '99', hr: '80', bp: '126/82', gcs_e: '4', gcs_v: '5', gcs_m: '6', gcs_total: '15', temp: '36.6', pain: '3' },
    ]);
    setIvRows([{ type: 'Ringers', jelco_size: '18G', site: 'L cubital', vol_infused: '500', time_up: '09:50', indication: 'Volume', sign: 'TT' }]);
    setMedRows([{ type: 'Morphine', route: 'IV', dose: '5mg', time: '09:55', reason: 'Analgesia', sign: 'TT' }]);

    dirtyRef.current = true;
    setTestFillOpen(false);
  };

  // ── Phase 0: DISPATCH ─────────────────────────────────────────────────────
  const P0 = () => {
    const startExamBtn = (
      <>
        <style>{`@keyframes startExamSlideIn { from { transform: translateY(32px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`}</style>
        <button
          type="button"
          id="start-exam-button"
          onClick={() => {
            setStartedExam(true);
            if (!fd.treating_practitioner_category) {
              setCrewPicker({ phase: 'select', kind: 'treating' });
            }
          }}
          style={{
            width: '100%', padding: '14px 16px', borderRadius: 12,
            background: '#eff6ff', color: '#1d4ed8', border: '1.5px dashed #93c5fd',
            fontWeight: 800, fontSize: '0.9rem', cursor: 'pointer', marginTop: 16,
            // Slides up into view when it appears after On Scene time is marked.
            animation: 'startExamSlideIn 0.45s cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          Start Examination ↓
        </button>
      </>
    );

    const isMobileView = typeof window !== 'undefined' && window.innerWidth < 768;

    return (
    <div>

      {/* QA / Dev test-fill — quickly populate the whole PRF for a chosen
          call-type × billing-type combination. Lives on the Dispatch screen so
          it's reachable for every call type.
          Only visible for the 'test' provider account. */}
      {providerSlug?.toLowerCase() === 'test' && (
        <button
          type="button"
          onClick={() => setTestFillOpen(true)}
          style={{
            width: '100%', padding: '12px', borderRadius: 12, marginBottom: 16,
            border: `2px dashed ${S300}`, background: S50, color: S700,
            fontSize: '0.85rem', fontWeight: 800, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}
        >
          🧪 Test Fill — auto-populate for testing
        </button>
      )}

      {testFillOpen && (
        <div
          onClick={() => setTestFillOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: W, borderRadius: 16, padding: '22px 20px', maxWidth: 460, width: '100%', maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 16px 48px rgba(0,0,0,0.3)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontSize: '1.05rem', fontWeight: 900, color: S900 }}>Test Fill</div>
              <button type="button" onClick={() => setTestFillOpen(false)} style={{ background: S100, border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: '0.8rem', fontWeight: 700, color: S600, cursor: 'pointer' }}>Close</button>
            </div>
            <div style={{ fontSize: '0.82rem', color: S600, lineHeight: 1.45, marginBottom: 16 }}>
              Pick a call type, then a billing type. The form will be auto-filled with realistic test data for that combination.
            </div>
            {Object.keys(TEST_MATRIX).map(ct => (
              <div key={ct} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: '0.72rem', fontWeight: 800, color: S700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                  {TEST_CALL_LABEL[ct] ?? ct}
                  {(ct === 'RESUS' || ct === 'DOD') && <span style={{ color: S400, fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}> · restricted</span>}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {TEST_MATRIX[ct].map(bt => (
                    <button
                      key={bt}
                      type="button"
                      onClick={() => applyTestFill(ct, bt)}
                      style={{ padding: '8px 12px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 700, border: `1.5px solid ${S200}`, background: S50, color: S700, cursor: 'pointer' }}
                    >
                      {bt}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <SHdr t="Call Type" />

      <CallTypePicker onPick={(type) => {
        if (type === 'PRIMARY' || type === 'RESUS' || type === 'COURTESY' || type === 'DOD' || type === 'WCA_IOD') {
          setDispatchPromptOpen(true);
          // Wait briefly for the modal to render before focusing the input
          window.setTimeout(() => dispatchKmRef.current?.focus(), 50);
        } else if (type === 'RHT') {
          setRhtCallOutFeeOpen(true);
        }
      }} />

      <FadeIn show={fd.call_type === 'IHT'} delay={150}>
        <div style={{ marginBottom: 14 }}>
          <Lbl t="Why is this an IFT/IHT call?" req />
          <TransferSubtypeCards />
        </div>
      </FadeIn>

      <FadeIn show={fd.call_type === 'IHT' && !!fd.transfer_subtype} delay={150}>
        <div style={{ marginBottom: 14 }}>
          <Lbl t="Quoted Payout Amount (R)" />
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 14, top: 12, fontWeight: 800, color: S900 }}>R</span>
            <input
              type="number"
              value={fd.med_aid_quoted_amount || ''}
              onChange={e => sf('med_aid_quoted_amount', e.target.value)}
              placeholder="Amount..."
              onFocus={onF} onBlur={onB}
              style={{ ...base, paddingLeft: 36, background: W }}
            />
          </div>
        </div>
      </FadeIn>

      <FadeIn show={['IHT', 'IFT'].includes(fd.call_type) && (fd.call_type !== 'IHT' || !!fd.transfer_subtype) && preauthVisible} delay={150}>
        <div style={{ marginBottom: 14 }}>
          <Lbl t="Pre-Auth No." req />
          {/* noMic: Pre-Auth is a reference code — the voice-dictation box is
              removed (dictating a code is error-prone and unwanted here). */}
          <Inp fk="preauth_number" ph="Tap to enter Pre-Auth No.…" noMic />
        </div>
      </FadeIn>

      {/* ── RHT flow ── */}
      <FadeIn show={fd.call_type === 'RHT'} delay={150}>
        <div style={{ marginBottom: 14 }}>
          <Lbl t="Call Out Fee" />
          <div
            onClick={() => setRhtCallOutFeeOpen(true)}
            style={{
              width: '100%', padding: '12px 14px', fontSize: '0.88rem',
              borderRadius: 10, border: `1.5px solid ${S200}`, background: W,
              color: fd.rht_call_out_fee ? S900 : S400, cursor: 'pointer',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              boxShadow: '0 1px 3px rgba(0,0,0,0.03)'
            }}
          >
            <span style={{ fontWeight: fd.rht_call_out_fee ? 700 : 400 }}>{fd.rht_call_out_fee || 'Tap to select…'}</span>
            <span style={{ fontSize: '0.7rem' }}>▼</span>
          </div>
        </div>
      </FadeIn>

      {/* ── Dispatch Time — all call types except IFT/IHT (which waits for preauth) ── */}
      <FadeIn show={
        (fd.call_type === 'PRIMARY' || fd.call_type === 'COURTESY' || fd.call_type === 'RESUS' || fd.call_type === 'WCA_IOD') ||
        (fd.call_type === 'RHT' && !!(fd.rht_call_out_fee || '').trim()) ||
        (fd.call_type === 'DOD') ||
        (['IHT', 'IFT'].includes(fd.call_type) && !!(fd.preauth_number || '').trim())
      } delay={200}>
        <SHdr t="Dispatch Times" />
        <div style={{ borderRadius: 14, overflow: 'hidden', border: `1.5px solid ${S200}`, marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: TIME_ROW_COLS, background: G }}>
            {TIME_HEADERS.map((h, i, a) => (
              <div key={h} style={{ padding: '10px 14px', fontSize: '0.65rem', fontWeight: 800, color: W, letterSpacing: '0.1em', borderRight: i < a.length - 1 ? '1px solid rgba(255,255,255,0.15)' : 'none' }}>{h}</div>
            ))}
          </div>
          {TimeRow({ row: ALL_TIME_ROWS.find(r => r.timeKey === 'time_dispatched')! })}
        </div>
      </FadeIn>

      {/* ── On Scene Time — shows after dispatch time is marked ── */}
      <FadeIn show={!!timestamps.time_dispatched && !!kms.km_dispatched} delay={200}>
        <div style={{ borderRadius: 14, overflow: 'hidden', border: `1.5px solid ${S200}`, marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: TIME_ROW_COLS, background: G }}>
            {TIME_HEADERS.map((h, i, a) => (
              <div key={h} style={{ padding: '10px 14px', fontSize: '0.65rem', fontWeight: 800, color: W, letterSpacing: '0.1em', borderRight: i < a.length - 1 ? '1px solid rgba(255,255,255,0.15)' : 'none' }}>{h}</div>
            ))}
          </div>
          {TimeRow({ row: ALL_TIME_ROWS.find(r => r.timeKey === 'time_on_scene')! })}
        </div>
      </FadeIn>

      {/* ── En Route Overlay — shows after dispatch time is marked but before on scene ── */}
      {enRouteOverlay && timestamps.time_dispatched && !timestamps.time_on_scene && (
        <EnRouteOverlay
          dispatchedAt={timestamps.time_dispatched}
          onDoubleTap={() => {
            setEnRouteOverlay(false);
            setOnScenePromptOpen(true);
          }}
        />
      )}

      {/* ── DOD: Declaration of Death form button — visible after on-scene captured ── */}
      {fd.call_type === 'DOD' && timestamps.time_on_scene && kms.km_on_scene && (
        <div style={{ marginTop: 8 }}>
          {/* Toggle button — neutral system style, no red */}
          <button
            type="button"
            onClick={() => sf('med_aid_dec_death', !fd.med_aid_dec_death)}
            aria-pressed={!!fd.med_aid_dec_death}
            aria-expanded={!!fd.med_aid_dec_death}
            style={{
              width: '100%', padding: '14px 16px',
              borderRadius: fd.med_aid_dec_death ? '12px 12px 0 0' : 12,
              fontSize: '0.88rem', fontWeight: 800,
              cursor: 'pointer', textAlign: 'left',
              border: `1.5px solid ${fd.med_aid_dec_death ? S300 : S200}`,
              borderBottom: fd.med_aid_dec_death ? `1.5px solid ${S200}` : `1.5px solid ${S200}`,
              background: fd.med_aid_dec_death ? S50 : W,
              color: S800,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 12, transition: 'all 0.2s ease',
              boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
            }}
          >
            <span style={{ fontWeight: 800 }}>Declaration of Death Form</span>
            <div style={{
              width: 26, height: 26, borderRadius: 7, flexShrink: 0,
              background: S100,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.72rem', color: S600,
              transform: fd.med_aid_dec_death ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.25s ease',
            }}>
              ▼
            </div>
          </button>

          {/* Expanded form body */}
          {fd.med_aid_dec_death && (
            <div style={{
              border: `1.5px solid ${S200}`,
              borderTop: 'none',
              borderRadius: '0 0 12px 12px',
              padding: '20px 16px',
              background: W,
              boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
            }}>
              {/* Dispatch screen: DOD form WITHOUT the declaration — the crew
                  signs the declaration once, on the final phase. */}
              <DodFormBody showDeclaration={false} />
              {/* Patient Information CTA sits at the bottom of the DOD form */}
              <div style={{ marginTop: 20 }}>
                {CTA({ label: 'Patient Information  →', onClick: () => advancePhase(2) })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Clinical section gate ──
          Every call type EXCEPT Declaration of Death renders the clinical body
          inline on Dispatch, once dispatch + on-scene time/km are captured.
          (Was four call-type-split lines with identical bodies — collapsed to
          one; same set.) */}
      {['PRIMARY', 'COURTESY', 'WCA_IOD', 'RESUS', 'IHT', 'IFT', 'RHT'].includes(fd.call_type) &&
        timestamps.time_dispatched && kms.km_dispatched && timestamps.time_on_scene && kms.km_on_scene &&
        (startedExam ? P3(true) : startExamBtn)}

      {/* Resus: Declaration of Death at bottom of clinical section */}
      {fd.call_type === 'RESUS' && startedExam && (
        <>
          <button
            type="button"
            onClick={() => sf('med_aid_dec_death', !fd.med_aid_dec_death)}
            aria-pressed={!!fd.med_aid_dec_death}
            aria-expanded={!!fd.med_aid_dec_death}
            style={{
              width: '100%', marginTop: 16, padding: '12px 14px',
              borderRadius: 8, fontSize: '0.82rem', fontWeight: 700,
              letterSpacing: '0.04em', cursor: 'pointer', textAlign: 'left',
              border: `1px solid ${fd.med_aid_dec_death ? '#e11d48' : '#e2e8f0'}`,
              background: fd.med_aid_dec_death ? 'rgba(225,29,72,0.08)' : '#ffffff',
              color: fd.med_aid_dec_death ? '#be123c' : '#334155',
              display: 'flex', alignItems: 'center', gap: 10,
              transition: 'all 0.15s',
            }}
          >
            <span style={{
              width: 16, height: 16, borderRadius: 4, flexShrink: 0,
              border: `1.5px solid ${fd.med_aid_dec_death ? '#e11d48' : '#94a3b8'}`,
              background: fd.med_aid_dec_death ? '#e11d48' : '#ffffff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: '0.65rem', fontWeight: 900,
            }}>{fd.med_aid_dec_death ? '✓' : ''}</span>
            Declaration of Death
          </button>
          {fd.med_aid_dec_death && (
            <div style={{ marginTop: 10, paddingLeft: 12, borderLeft: `2px solid #fecaca` }}>
              <DodFormBody />
            </div>
          )}
        </>
      )}

      {startedExam && ['IFT', 'IHT'].includes(fd.call_type) && (
        <div style={{ marginTop: 14, marginBottom: 20 }}>
          <SHdr t="Nursing Notes" />
          <Card>
            <DocumentsCapture
              value={fd.nursing_notes}
              onChange={v => sf('nursing_notes', v)}
              buttonLabel="Photograph Nursing Notes"
            />
          </Card>
        </div>
      )}

      {/* Patient Information CTA — DOD shows CTA inside its own form body.
          Normally gated on a chief complaint (proof the clinical section was
          started), but that section is hidden when the patient refused
          treatment — so a refusal also unlocks the CTA, otherwise the crew has
          no way off the Dispatch screen. A refusal likewise skips the
          monitoring-level modal (no monitoring to record). */}
      {(!!fd.chief_complaint || fd.patient_refused_treatment) && fd.call_type !== 'DOD' && (
        CTA({
          label: "Patient Information  →",
          onClick: () => {
            if (!fd.monitoring_level && !fd.patient_refused_treatment) {
              setMonitoringModalOpen(true);
            } else {
              advancePhase(2);
            }
          }
        })
      )}
    </div>
    );
  };

  // ── Phase 1: EN ROUTE ─────────────────────────────────────────────────────
  const P1 = () => (
    <>
      <SHdr t="En Route" />

      <SHdr t="Call Information" />
      <Card>
        <Lbl t="Incident Address" /><AddrInp fk="incident_location" ph="e.g. Chatsmed Hospital" suburbKey="suburb_ward" />
        <Lbl t="Suburb / Ward" /><Inp fk="suburb_ward" ph="e.g. ICU" />
        {!fd.med_aid_dec_death && (
          <>
            <Lbl t="Referring Dr" /><Inp fk="referring_doctor" ph="e.g. Dr R.K. Naidoo" />
          </>
        )}
        <Lbl t="Destination" req /><HospitalPicker wardKey="ward" />
        {!fd.med_aid_dec_death && (
          <>
            <Lbl t="Ward" /><Inp fk="ward" ph="e.g. C.I.C.U" />
            <Lbl t={fd.call_type === 'COURTESY' ? "Receiving Dr / Person" : "Receiving Dr"} /><Inp fk="receiving_doctor" ph={fd.call_type === 'COURTESY' ? "Name" : "e.g. Dr R.K. Naidoo"} />
          </>
        )}
      </Card>



      {CTA({ label: "ON SCENE  →", onClick: () => advancePhase(2, 'time_on_scene', 'km_on_scene') })}
    </>
  );

  // ── Phase 2: ON SCENE ─────────────────────────────────────────────────────
  const P2 = () => (
    <>
      {/* Patient Priority is skipped for Declaration
          of Death — triage priority doesn't apply once the
          patient is deceased. */}
      {!fd.med_aid_dec_death && (
        <>
          {/* Priority — large, colour-coded, dominant.
              Hidden for Resus calls: triage priority doesn't apply when the
              crew is already running a resus. */}
          {fd.call_type !== 'RESUS' && (
            <>
              <SHdr t="Patient Priority" />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 8, marginBottom: 20 }}>
                {[{ v: 'RED', c: '#ef4444' }, { v: 'ORANGE', c: '#f97316' }, { v: 'YELLOW', c: '#eab308' }, { v: 'GREEN', c: '#22c55e' }, { v: 'BLUE', c: '#3b82f6' }].map(({ v, c }) => {
                  const on = fd.priority === v;
                  return <button key={v} type="button" onClick={() => sf('priority', v)} style={{ padding: '18px 4px', borderRadius: 12, fontSize: '0.68rem', fontWeight: 900, border: `3px solid ${on ? c : S200}`, background: on ? c : W, color: on ? W : S600, cursor: 'pointer', boxShadow: on ? `0 4px 14px ${c}55` : '0 1px 3px rgba(0,0,0,0.03)', transition: 'all 0.15s', letterSpacing: '0.04em' }}>{v}</button>;
                })}
              </div>
            </>
          )}
        </>
      )}

      {/* Patient Information — hidden for a Declaration of Death: the deceased's
          details are captured once in the DOD form's "Particulars of deceased"
          section, and a mirror effect copies them into the patient_* fields, so
          repeating the section here would be duplicate data entry. */}
      {fd.call_type !== 'DOD' && (
      <>
      <SHdr t="Patient Information" />
      <Card>
        <Lbl t="Gender" />
        <Toggle fk="gender" opts={['Male', 'Female', 'Other']} />
        <G2>
          <div><Lbl t="First Name" req /><Inp fk="patient_name" ph="First name" req /></div>
          <div><Lbl t="Surname" req /><Inp fk="patient_surname" ph="Surname" req /></div>
          <div><Lbl t="ID Number" req /><Inp fk="patient_id_number" ph="13-digit SA ID" req /></div>
          <div><Lbl t="Passport Number" /><Inp fk="patient_passport_number" ph="For foreign nationals" /></div>
          <div><Lbl t="Date of Birth" /><DateInp fk="patient_dob" /></div>
          <div><Lbl t="Age" /><Inp fk="age" ph="Age" type="number" /></div>
          <div><Lbl t="Cell" /><Inp fk="patient_phone_cell" ph="Cell" type="tel" /></div>
          <div><Lbl t="Tel (H)" /><Inp fk="patient_phone_home" ph="Home" type="tel" /></div>
        </G2>
        <Lbl t="Tel (W)" /><Inp fk="patient_phone_work" ph="Work number" type="tel" />
        <Lbl t="Residential Address" /><AddrInp fk="patient_address" ph="Street address" suburbKey="patient_suburb" codeKey="patient_postal_code" manualOnly />
        <G2>
          <div><Lbl t="Suburb" /><Inp fk="patient_suburb" ph="Suburb" /></div>
          <div><Lbl t="Code" /><Inp fk="patient_postal_code" ph="Code" /></div>
        </G2>
      </Card>
      </>
      )}

      {/* ── Billing details ────────────────────────────────────────────────
          The Billing Type selector and all channel-specific detail cards
          live here on Phase 2 so the crew completes triage and patient
          info before being asked to fill billing details. */}
      {fd.call_type !== 'COURTESY' && (
        <>
          {/* WCA_IOD call type implies billing — skip the picker */}
          {fd.call_type !== 'WCA_IOD' && (
            <div id="billing-type-anchor">
              <SHdr t="Billing Type" />
              <BillingTypePicker />
            </div>
          )}

      {fd.billing_type === 'PVT' && (
        <>
          <SHdr t="Private (PVT) Billing" />
          <Card>
            <Lbl t="Payment Method" req />
            <Toggle fk="pvt_payment_method" opts={['Cash', 'Card', 'EFT', 'Account', 'Indigent']} />
            {fd.pvt_payment_method !== 'Indigent' && (
              <>
                <Lbl t="Amount Quoted (R)" /><Inp fk="pvt_amount_quoted" ph="e.g. 1500.00" type="number" />
                <Lbl t="Account Holder Full Name" req /><Inp fk="pvt_account_holder" ph="Person responsible for payment" req noMic />
                <G2>
                  <div><Lbl t="Account Holder ID Number" /><Inp fk="pvt_account_holder_id" ph="13-digit SA ID" /></div>
                  <div><Lbl t="Contact Number" req /><Inp fk="pvt_account_holder_phone" type="tel" ph="082 ..." req /></div>
                </G2>
                <Lbl t="Billing Address" /><AddrInp fk="pvt_account_holder_address" ph="For invoice delivery" />
              </>
            )}
          </Card>

          {/* Cash payment verification — only shown when Cash is selected */}
          {fd.pvt_payment_method === 'Cash' && (
            <>
              <SHdr t="Cash Payment Verification" />
              <Card>
                {/* Amount paid dropdown */}
                <Lbl t="Amount Paid (R)" req />
                <input
                  list="cash-amounts"
                  type="text"
                  value={fd.pvt_cash_amount_paid ?? ''}
                  onChange={e => sf('pvt_cash_amount_paid', e.target.value)}
                  onFocus={onF}
                  onBlur={onB}
                  placeholder="e.g. 1500"
                  style={{ ...base, marginBottom: 14 }}
                />
                <datalist id="cash-amounts">
                  {['100','200','300','400','500','600','700','800','900','1000',
                    '1100','1200','1300','1400','1500','1600','1700','1800','1900','2000',
                    '2500','3000','3500','4000','4500','5000','6000','7000','8000','9000','10000',
                    'Other'].map(v => <option key={v} value={v} />)}
                </datalist>

                {/* Payer signature block */}
                <div style={{ padding: '12px 14px', border: `1.5px solid ${S200}`, borderRadius: 10, marginBottom: 14 }}>
                  <div style={{ fontSize: '0.76rem', color: S600, lineHeight: 1.55, marginBottom: 12, fontStyle: 'italic' }}>
                    By signing below, I confirm that I have handed over{' '}
                    <strong style={{ color: S900 }}>R {fd.pvt_cash_amount_paid || '___'}</strong>{' '}
                    in cash to the attending crew member.
                  </div>
                  <Lbl t="Payer Full Name" />
                  <Inp fk="pvt_cash_payer_name" ph="Full name of person handing over cash" />
                  <FullscreenSignaturePad
                    label="Payer Signature — Cash Handover Confirmation"
                    value={fd.pvt_cash_payer_signature}
                    onChange={v => { sf('pvt_cash_payer_signature', v); dirtyRef.current = true; }}
                  />
                </div>

                {/* Crew receipt confirmation block */}
                <div style={{ padding: '12px 14px', border: `1.5px solid ${S200}`, borderRadius: 10, marginBottom: 4 }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, color: S500, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
                    Crew Receipt Confirmation
                  </div>
                  <Lbl t="Amount Received by Person Paying (R)" req />
                  <Inp fk="pvt_cash_crew_received" ph="Exact amount received" type="number" />
                  <div style={{ fontSize: '0.76rem', color: S600, lineHeight: 1.55, marginBottom: 12, fontStyle: 'italic' }}>
                    By signing below, I confirm that I have received{' '}
                    <strong style={{ color: S900 }}>R {fd.pvt_cash_crew_received || '___'}</strong>{' '}
                    in cash from the patient / responsible person.
                  </div>
                  <FullscreenSignaturePad
                    label="Crew Member Signature — Cash Receipt Confirmation"
                    value={fd.pvt_cash_crew_signature}
                    onChange={v => { sf('pvt_cash_crew_signature', v); dirtyRef.current = true; }}
                  />
                </div>
              </Card>
            </>
          )}
        </>
      )}

      {fd.billing_type !== 'PVT' && (<>
        <SHdr t="Debtor Information" />

        {/* Channel-specific billing detail cards. MedAidMore is omitted
            for Resus — already mounted on the Dispatch screen, so
            rendering it again would duplicate the Resus / DoD controls
            bound to the same state. */}
        {fd.billing_type === 'MED AID' && (
          <Card>
            <Lbl t="Medical Scheme" req /><ComboInp fk="medical_scheme" opts={MEDICAL_SCHEMES} listId="medical-schemes-list" ph="Type to search…" req />
            <Lbl t="Membership Number" req /><Inp fk="medical_aid_number" ph="9-digit member number" req />
            <G2>
              <div><Lbl t="Dependent Code" /><DepCodePicker /></div>
              <div><Lbl t="Plan / Option" /><SchemeOptionField /></div>
            </G2>
            <Lbl t="Main Member ID" /><Inp fk="main_member_id" ph="13-digit SA ID" />
            <PostAuthField />

            {fd.call_type !== 'RESUS' && fd.call_type !== 'DOD' && <MedAidMore />}
          </Card>
        )}

        {(fd.billing_type === 'WCA / IOD' || fd.call_type === 'WCA_IOD') && (
          <Card>
            <Lbl t="Company Name" req /><Inp fk="wca_employer" ph="e.g. Eskom Holdings" req />
            <Lbl t="Company Address" /><AddrInp fk="wca_employer_address" ph="Physical address of employer" manualOnly />
            <Lbl t="Employer Responsible Person" /><Inp fk="wca_employer_responsible_person" ph="Name of person responsible for the claim" />
            <G2>
              <div><Lbl t="Employer Contact Number" /><Inp fk="wca_employer_contact" ph="Office / HR number" type="tel" /></div>
              <div><Lbl t="Employee Number" /><Inp fk="wca_employee_number" ph="Optional" /></div>
            </G2>
            <Lbl t="Compensation Reference" req /><Inp fk="compensation_reference" ph="IOD claim / reference number" req />
            <G2>
              <div><Lbl t="Date of Injury" req /><Inp fk="wca_injury_date" type="date" req /></div>
            </G2>
            <Lbl t="Description of Incident" />
            <VoiceTxt fk="wca_incident_description" ph="Describe how the injury occurred, what happened, mechanism of injury..." rows={3} />
            <div style={{ marginBottom: 14 }}>
              <Lbl t="Documents (WCA / Employee)" />
              <select
                onChange={e => {
                  const val = e.target.value;
                  if (val) {
                    setWcaDocKey(val);
                    setWcaPromptOpen(true);
                    e.target.value = ""; // Reset dropdown
                  }
                }}
                style={{ ...base, appearance: 'auto', marginBottom: 14 }}
              >
                <option value="">-- Add / Photograph a Document --</option>
                {[
                  { key: 'wca_oar_report_pdf', label: 'WCA Document (PDF)' },
                  { key: 'wca_employee_id_pdf', label: 'Employee ID (PDF)' },
                  { key: 'wca_payslip_pdf', label: 'Payslip (PDF)' },
                  { key: 'wca_medical_report_pdf', label: 'Medical Report (PDF)' },
                ].map(d => {
                  const attached = !!fd[d.key];
                  return (
                    <option key={d.key} value={d.key}>
                      {d.label}{attached ? ' (Attached)' : ''}
                    </option>
                  );
                })}
              </select>

              {/* List of attached documents */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { key: 'wca_oar_report_pdf', label: 'WCA Document' },
                  { key: 'wca_employee_id_pdf', label: 'Employee ID' },
                  { key: 'wca_payslip_pdf', label: 'Payslip' },
                  { key: 'wca_medical_report_pdf', label: 'Medical Report' },
                ].map(d => {
                  const file = fd[d.key];
                  if (!file) return null;
                  const isPdf = file.name.toLowerCase().endsWith('.pdf');
                  return (
                    <div key={d.key} style={{
                      display: 'flex', gap: 12, alignItems: 'center', padding: '10px 14px',
                      borderRadius: 10, border: `1.5px solid ${G}`, background: GBG
                    }}>
                      {isPdf ? (
                        <div style={{
                          width: 50, height: 40, borderRadius: 6, border: `1px solid ${S200}`,
                          background: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '0.8rem', fontWeight: 800, color: '#475569'
                        }}>PDF</div>
                      ) : (
                        <img
                          src={file.data_url}
                          alt={d.label}
                          style={{
                            width: 50, height: 40, objectFit: 'cover',
                            borderRadius: 6, border: `1px solid ${S200}`, background: W
                          }}
                        />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 800, fontSize: '0.82rem', color: GDK }}>{d.label} attached</div>
                        <div style={{ fontSize: '0.68rem', color: S500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name} · {(file.size / 1024).toFixed(1)} KB</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => sf(d.key, undefined)}
                        style={{
                          padding: '6px 12px', borderRadius: 8, fontSize: '0.72rem', fontWeight: 700,
                          border: '1px solid #fecaca', background: W, color: REDC, cursor: 'pointer'
                        }}
                      >Remove</button>
                    </div>
                  );
                })}
              </div>
            </div>
          </Card>
        )}

        {fd.billing_type === 'RAF' && (
          <Card>
            <G2>
              <div><Lbl t="Patient Date of Birth" req /><Inp fk="patient_dob" type="date" req /></div>
              <div><Lbl t="Passport Number" /><Inp fk="patient_passport_number" ph="For foreign nationals" /></div>
            </G2>
            <Lbl t="ID Number" /><Inp fk="patient_id_number" ph="13-digit SA ID" />
            <G2>
              <div><Lbl t="Date of Accident" req /><Inp fk="raf_accident_date" type="date" req /></div>
              <div><Lbl t="SAPS Case / OB Number" /><Inp fk="raf_police_case_number" ph="Police case number" /></div>
            </G2>
            <Lbl t="Accident Location" /><AddrInp fk="raf_accident_location" ph="Where the accident occurred" />
            <PdfDrop fk="raf_oar_report_pdf" />
            <RafSketchPad />
          </Card>
        )}



        {fd.billing_type === 'CALL OUT FEE' && (
          <Card>
            <Lbl t="Requested By" req /><Inp fk="callout_requested_by" ph="Person / facility that called us out" req />
            <G2>
              <div><Lbl t="Pre-Authorisation Number" /><Inp fk="callout_authorisation" ph="Pre-auth number" /></div>
              <div><Lbl t="Stand-Down Reason" /><Inp fk="callout_standdown_reason" ph="e.g. patient refused, deceased, false alarm" /></div>
            </G2>
          </Card>
        )}

        <div style={{ marginBottom: 12 }}><Chk fk="flags" val="debtor_same_as_patient" label="Debtor is same as patient" /></div>
        {!inArr('flags', 'debtor_same_as_patient') && (
          <Card>
            <Lbl t="Gender" /><Toggle fk="debtor_gender" opts={['Male', 'Female', 'Other']} />
            <G2>
              <div><Lbl t="First Name" /><Inp fk="debtor_name" ph="First name" /></div>
              <div><Lbl t="Surname" /><Inp fk="debtor_surname" ph="Surname" /></div>
              <div><Lbl t="ID Number" /><Inp fk="debtor_id_number" ph="13-digit SA ID" /></div>
              <div><Lbl t="Passport Number" /><Inp fk="debtor_passport_number" ph="For foreign nationals" /></div>
              <div><Lbl t="Date of Birth" /><DateInp fk="debtor_dob" /></div>
              <div><Lbl t="Age" /><Inp fk="debtor_age" ph="Age" type="number" /></div>
              <div><Lbl t="Cell" /><Inp fk="debtor_phone_cell" ph="Cell" type="tel" /></div>
              <div><Lbl t="Tel (H)" /><Inp fk="debtor_phone_home" ph="Home" type="tel" /></div>
            </G2>
            <Lbl t="Residential Address" /><AddrInp fk="debtor_address" ph="Street address" suburbKey="debtor_suburb" codeKey="debtor_postal_code" manualOnly />
            <G2>
              <div><Lbl t="Suburb" /><Inp fk="debtor_suburb" ph="Suburb" /></div>
              <div><Lbl t="Code" /><Inp fk="debtor_postal_code" ph="Code" /></div>
            </G2>
          </Card>
        )}

      </>)}
      </>)}

      {fd.call_type !== 'DOD' && (
        <>
          <Lbl t="Persons Accompanying Patient in Ambulance" />
          <Inp fk="accompanying_persons_count" type="number" ph="0" />
        </>
      )}

      {/* Declaration of Death — its own section, split out from the Debtor
          Information / medical-aid card above so the deceased's certificate is
          no longer visually merged with the billing fields. Shown for a DOD
          call type regardless of billing type (MED AID or PVT); the crew signs
          the declaration here (the dispatch-screen copy omits it). */}
      {fd.call_type === 'DOD' && (
        <>
          <SHdr t="Declaration of Death" />
          <div style={{ marginBottom: 20 }}>
            {/* Toggle button — the certificate is long, so it stays collapsed
                until the crew taps to reveal it. Neutral system style. */}
            <button
              type="button"
              onClick={() => setDodFormOpen(o => !o)}
              aria-pressed={dodFormOpen}
              aria-expanded={dodFormOpen}
              style={{
                width: '100%', padding: '14px 16px',
                borderRadius: dodFormOpen ? '12px 12px 0 0' : 12,
                fontSize: '0.88rem', fontWeight: 800,
                cursor: 'pointer', textAlign: 'left',
                border: `1.5px solid ${dodFormOpen ? S300 : S200}`,
                borderBottom: `1.5px solid ${S200}`,
                background: dodFormOpen ? S50 : W,
                color: S800,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 12, transition: 'all 0.2s ease',
                boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
              }}
            >
              <span style={{ fontWeight: 800 }}>Declaration of Death Form</span>
              <div style={{
                width: 26, height: 26, borderRadius: 7, flexShrink: 0,
                background: S100,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.72rem', color: S600,
                transform: dodFormOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.25s ease',
              }}>
                ▼
              </div>
            </button>

            {/* Expanded certificate body */}
            {dodFormOpen && (
              <div style={{
                border: `1.5px solid ${S200}`,
                borderTop: 'none',
                borderRadius: '0 0 12px 12px',
                padding: '20px 16px',
                background: W,
                boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
              }}>
                {/* Certificate body only — the Declaration sign-off is a
                    SEPARATE section below, not nested in this dropdown. */}
                <DodFormBody showDeclaration={false} />
              </div>
            )}
          </div>

          {/* Declaration — its own section, separate from the form dropdown. */}
          <div style={{ marginBottom: 20 }}>
            <DodDeclarationSection />
          </div>
        </>
      )}

      {/* Declaration of Death short-circuits the Clinical phase — the
          patient is deceased so there's no assessment / vitals / meds to
          record. The Undertaker handover happens at the scene, so the
          form lives here and the CTA jumps straight to Complete. */}
      {fd.med_aid_dec_death && (
        <>
          <SHdr t="Undertaker" />
          <button
            type="button"
            onClick={() => setUndertakerOpen(v => !v)}
            style={{
              width: '100%', padding: '16px 20px', borderRadius: 12,
              border: `1px solid ${fd.undertaker_name && fd.undertaker_collector_signature ? '#16a34a' : '#cbd5e1'}`,
              background: fd.undertaker_name && fd.undertaker_collector_signature ? '#f0fdf4' : '#f8fafc',
              color: fd.undertaker_name && fd.undertaker_collector_signature ? '#16a34a' : '#334155',
              fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              marginBottom: 18,
              boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
              transition: 'all 0.2s',
            }}
          >
            {fd.undertaker_name && fd.undertaker_collector_signature ? 'Undertaker Details Captured' : 'Enter Undertaker Details'}
          </button>

          {undertakerOpen && (
            <Card>
              <Lbl t="Undertaker Name" req />
              <Inp fk="undertaker_name" ph="e.g. Doves Funeral Services" req />

              <Lbl t="Phone Number" />
              <Inp fk="undertaker_phone" ph="Phone number" type="tel" />

              <Lbl t="Person Collecting Deceased" />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <div style={{ flex: 1 }}>
                  <input
                    type="text"
                    value={fd.undertaker_collector_name ?? ''}
                    onChange={e => sf('undertaker_collector_name', e.target.value)}
                    onFocus={onF}
                    onBlur={onB}
                    placeholder="Full name of person collecting"
                    autoComplete="off"
                    style={{ ...base, marginBottom: 0, borderColor: '#e2e8f0' }}
                  />
                </div>
                <FullscreenSignaturePad
                  compact
                  label="Collector Signature"
                  value={fd.undertaker_collector_signature}
                  onChange={v => sf('undertaker_collector_signature', v)}
                />
              </div>
            </Card>
          )}
        </>
      )}

      {fd.med_aid_dec_death ? (
        <>
          {/* Capture the crew's "Available" time before submitting so the
              shift's end-of-call timestamp is on the PRF. The same row
              normally lives on the Complete phase, which is hidden for DoD. */}
          <SHdr t="Available" />
          {TimeTable({ rows: ALL_TIME_ROWS.filter(r => r.timeKey === 'time_available') })}

          {/* A DOD PRF needs a Billing Type (without one the certificate
              renders "—" and can't be billed). The button is NOT disabled via
              the DOM `disabled` attribute for this — Samsung Internet does not
              reliably re-enable a disabled control after React clears the flag,
              so crews reported "even after picking a billing type I can't
              submit". Instead the button is always tappable; the billing check
              lives in the handler and just scrolls the crew back to the picker
              when it's genuinely missing. It only truly disables while a submit
              is in flight. */}
          <button
            type="button"
            onClick={() => {
              if (!fd.billing_type) {
                document.getElementById('billing-type-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
              }
              void handleSubmit();
            }}
            disabled={submitting}
            style={{
              width: '100%', padding: 18, borderRadius: 14,
              fontSize: '1.05rem', fontWeight: 800, border: 'none',
              cursor: submitting ? 'wait' : 'pointer',
              background: (submitting || !fd.billing_type) ? S400 : `linear-gradient(135deg,${ROSE},#be123c)`,
              color: W,
              boxShadow: (submitting || !fd.billing_type) ? 'none' : `0 6px 24px rgba(225,29,72,0.3)`,
              letterSpacing: '0.04em',
              marginTop: 8,
            }}
          >
            {submitting ? 'Submitting PRF...' : !fd.billing_type ? 'Select Billing Type to Submit' : 'Complete & Submit'}
          </button>
        </>
      ) : fd.call_type === 'DOD' ? (
        CTA({ label: "UNDERTAKER  →", onClick: () => advancePhase(4, 'time_depart_scene', 'km_depart_scene') })
      ) : fd.call_type === 'RESUS' ? (
        // Resus: clinical is captured inline on Dispatch, so skip the
        // Clinical phase entirely and head straight to Transport.
        CTA({ label: "LOAD &amp; GO  →", color: ROSE, onClick: () => advancePhase(4, 'time_depart_scene', 'km_depart_scene') })
      ) : fd.call_type === 'RHT' ? (
        // RHT: patient refused transport. The refusal waiver, Available
        // timestamp, and Submit all live on this screen — Handover is
        // hidden because there's no receiving facility to hand over to.
        <>
          <SHdr t="Refusal of Treatment / Transportation Waiver" />
          <Card>
            <div style={{
              padding: '14px 16px',
              background: 'rgba(245,158,11,0.08)',
              border: `1.5px solid rgba(245,158,11,0.3)`,
              borderRadius: 10,
              marginBottom: 16,
            }}>
              <div style={{ fontSize: '0.82rem', color: '#78350f', lineHeight: 1.55, fontWeight: 500 }}>
                I, the patient or the responsible person, hereby waive any treatment offered to me by JEMS Medical Services and understand that by signing this waiver, I indemnify JEMS Medical Services from all further responsibility for my well-being hereonforth.
              </div>
            </div>

            <Lbl t="Patient / Responsible Person" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <Inp fk="rht_waiver_signatory_name" ph="Full name" noMic />
              </div>
              <FullscreenSignaturePad
                compact
                label="Patient / Responsible Person Signature"
                value={sigs.patient_signature}
                onChange={v => { setSigs(p => ({ ...p, patient_signature: v })); dirtyRef.current = true; }}
              />
            </div>

            <Lbl t="Witness" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <Inp fk="rht_waiver_witness_name" ph="Witness full name" noMic />
              </div>
              <FullscreenSignaturePad
                compact
                label="Witness Signature"
                value={sigs.witness_signature}
                onChange={v => { setSigs(p => ({ ...p, witness_signature: v })); dirtyRef.current = true; }}
              />
            </div>

            <Lbl t="Date" />
            <DateInp fk="rht_waiver_date" />
          </Card>

          <SHdr t="Available" />
          {TimeTable({ rows: ALL_TIME_ROWS.filter(r => r.timeKey === 'time_available') })}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            style={{
              width: '100%', padding: 18, borderRadius: 14,
              fontSize: '1.05rem', fontWeight: 800, border: 'none',
              cursor: submitting ? 'wait' : 'pointer',
              background: submitting ? S400 : `linear-gradient(135deg,${ROSE},#be123c)`,
              color: W,
              boxShadow: submitting ? 'none' : `0 6px 24px rgba(225,29,72,0.3)`,
              letterSpacing: '0.04em',
              marginTop: 8,
            }}
          >
            {submitting ? 'Submitting PRF...' : 'Complete & Submit'}
          </button>
        </>
      ) : (
        CTA({ label: "DEPART SCENE  →", onClick: () => advancePhase(4, 'time_depart_scene', 'km_depart_scene') })
      )}
    </>
  );


  const IvAndMedsSection = (options: { hideCheckboxes?: boolean; showOnly?: 'both' | 'med_only'; forceOpen?: boolean } = {}) => {
    const { hideCheckboxes = false, showOnly = 'both', forceOpen = false } = options;
    const isIft = ['IFT', 'IHT'].includes(fd.call_type);
    const isPrimary = ['PRIMARY', 'COURTESY'].includes(fd.call_type);
    const requiresToggle = !hideCheckboxes && (isIft || isPrimary) && !forceOpen;

    // Derive effective open-state: button toggle OR already has data loaded
    const ivOpen = ivSectionOpen || ivRows.length > 0 ||
      (isIft && (!!fd.ift_ongoing_iv_treatment || !!fd.primary_iv_profuse_bleeding || !!fd.primary_iv_fluid_resuscitation)) ||
      (isPrimary && (!!fd.primary_iv_profuse_bleeding || !!fd.primary_iv_fluid_resuscitation));
    const medOpen = forceOpen || medSectionOpen || medRows.length > 0 || !!fd.iv_medication_administration || !!fd.medication_administered_on_route;

    const showIvAndMeds =
      hideCheckboxes ||
      ivOpen ||
      medOpen ||
      (!isIft && !isPrimary);

    const eitherActive = requiresToggle ? (ivOpen || medOpen) : true;
    const showIvReasons = !hideCheckboxes && (isIft || isPrimary);
    const showMedReasons = !hideCheckboxes && (isIft || isPrimary);

    // Shared warning note — outlined box, no background fill
    const MedAidNote = () => (
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 14, padding: '11px 13px', border: `1.5px solid ${S200}`, borderRadius: 10 }}>
        <span style={{ fontSize: '0.85rem', lineHeight: 1.4, marginTop: 1, flexShrink: 0 }}>⚠️</span>
        <div style={{ fontSize: '0.76rem', color: S600, lineHeight: 1.55, fontStyle: 'italic' }}>
          Please note that the IV is only warranted and payable by the medical aid scheme if and
          when there is <strong style={{ color: S700 }}>profuse bleeding</strong>, <strong style={{ color: S700 }}>fluid resuscitation</strong> required
          or <strong style={{ color: S700 }}>medication administered</strong> while the patient is in your care.
        </div>
      </div>
    );

    return (
    <>
      {/* ── Toggle card-buttons for IV Therapy and Medication ── */}
      {requiresToggle && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>

          {/* IV Therapy — dashed blue button matching "+ Add IV Line" style */}
          <button
            type="button"
            onClick={() => setIvReasonModalOpen(true)}
            style={{
              width: '100%',
              padding: 12,
              borderRadius: 10,
              border: `2px dashed ${G}`,
              background: GBG,
              color: GDK,
              fontWeight: 800,
              fontSize: '0.88rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              transition: 'all 0.15s ease',
            }}
          >
            {ivOpen ? '✓ IV Therapy (Active)' : '+ IV Therapy'}
          </button>

          {/* Medication — dashed blue button matching "+ Add Medication" style */}
          <button
            type="button"
            onClick={() => setMedReasonPromptOpen(true)}
            style={{
              width: '100%',
              padding: 12,
              borderRadius: 10,
              border: `2px dashed ${G}`,
              background: GBG,
              color: GDK,
              fontWeight: 800,
              fontSize: '0.88rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              transition: 'all 0.15s ease',
            }}
          >
            {medOpen ? '✓ Medication (Active)' : '+ Medication'}
          </button>

        </div>
      )}

      {/* ── Medical aid scheme warning note ── */}
      {requiresToggle && eitherActive && showOnly === 'both' && <MedAidNote />}

      {/* ════════════════════════════════════════════════════
          IV THERAPY — inline section (reason checkboxes +
          IV line cards with crew member & signature)
          ════════════════════════════════════════════════════ */}
      {showOnly === 'both' && (requiresToggle ? ivOpen : showIvAndMeds) && (
        <>
          {/* Reason checkboxes */}
          {showIvReasons && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: S500, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                Reason for IV Therapy
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
                {isIft && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', background: W, borderRadius: 8, border: `1.5px solid ${fd.ift_ongoing_iv_treatment ? S700 : S200}`, cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!fd.ift_ongoing_iv_treatment} onChange={e => sf('ift_ongoing_iv_treatment', e.target.checked)} style={{ width: 16, height: 16, accentColor: S700, cursor: 'pointer' }} />
                    <span style={{ fontSize: '0.82rem', fontWeight: 600, color: S900 }}>On-going IV treatment</span>
                  </label>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', background: W, borderRadius: 8, border: `1.5px solid ${fd.primary_iv_profuse_bleeding ? S700 : S200}`, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!fd.primary_iv_profuse_bleeding} onChange={e => sf('primary_iv_profuse_bleeding', e.target.checked)} style={{ width: 16, height: 16, accentColor: S700, cursor: 'pointer' }} />
                  <span style={{ fontSize: '0.82rem', fontWeight: 600, color: S900 }}>Profuse Bleeding</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', background: W, borderRadius: 8, border: `1.5px solid ${fd.primary_iv_fluid_resuscitation ? S700 : S200}`, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!fd.primary_iv_fluid_resuscitation} onChange={e => sf('primary_iv_fluid_resuscitation', e.target.checked)} style={{ width: 16, height: 16, accentColor: S700, cursor: 'pointer' }} />
                  <span style={{ fontSize: '0.82rem', fontWeight: 600, color: S900 }}>Fluid Resuscitation</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', background: W, borderRadius: 8, border: `1.5px solid ${fd.iv_medication_administration ? S700 : S200}`, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!fd.iv_medication_administration} onChange={e => sf('iv_medication_administration', e.target.checked)} style={{ width: 16, height: 16, accentColor: S700, cursor: 'pointer' }} />
                  <span style={{ fontSize: '0.82rem', fontWeight: 600, color: S900 }}>Medication Administered via IV</span>
                </label>
              </div>
            </div>
          )}

          {/* IV line cards */}
          <SHdr t="IV Therapy" />
          {ivRows.map((row, i) => (
            <Card key={i} style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.82rem', color: S600 }}>IV Line #{i + 1}</div>
                  {row.administered_by && (
                    <div style={{ fontSize: '0.7rem', color: S700, marginTop: 3, wordBreak: 'break-word' }}>
                      Administered by <b style={{ color: S900 }}>{row.administered_by}</b>
                      {row.administered_by_qualification ? ` · ${row.administered_by_qualification}` : ''}
                    </div>
                  )}
                </div>
                <button type="button" onClick={() => { setIvRows(ivRows.filter((_, j) => j !== i)); dirtyRef.current = true; }} style={{ padding: '4px 10px', fontSize: '0.72rem', fontWeight: 700, borderRadius: 6, border: `1px solid ${S200}`, background: S50, color: REDC, cursor: 'pointer', flexShrink: 0 }}>Remove</button>
              </div>
              <G2>
                {([
                  { l: 'Type / Fluid', k: 'type' },
                  { l: 'Jelco Size', k: 'jelco_size', opts: ['24g', '22g', '20g', '18g', '16g', '14g'] },
                  { l: 'Site', k: 'site' },
                  { l: 'Vol. Infused', k: 'vol_infused', placeholder: 'ml' },
                  { l: 'Time Up', k: 'time_up' },
                  { l: 'Indication / Reason', k: 'indication' },
                ] as Array<{ l: string; k: string; opts?: string[]; placeholder?: string }>).map(f => (
                  <div key={f.k}>
                    <Lbl t={f.l} />
                    {f.k === 'time_up' ? (
                      <input
                        type="time"
                        value={row.time_up ?? ''}
                        onClick={() => {
                          if (!row.time_up) {
                            const now = new Date();
                            const hh = String(now.getHours()).padStart(2, '0');
                            const mm = String(now.getMinutes()).padStart(2, '0');
                            const r = [...ivRows]; r[i] = { ...r[i], time_up: `${hh}:${mm}` }; setIvRows(r); dirtyRef.current = true;
                          }
                        }}
                        onChange={e => { const r = [...ivRows]; r[i] = { ...r[i], time_up: e.target.value }; setIvRows(r); dirtyRef.current = true; }}
                        onFocus={onF}
                        onBlur={onB}
                        style={{ ...base, marginBottom: 8 }}
                      />
                    ) : (
                      <input
                        list={f.opts ? `iv-${f.k}-${i}` : undefined}
                        value={row[f.k] ?? ''}
                        onChange={e => { const r = [...ivRows]; r[i] = { ...r[i], [f.k]: e.target.value }; setIvRows(r); dirtyRef.current = true; }}
                        placeholder={f.placeholder || ''}
                        onFocus={onF}
                        onBlur={e => {
                          onB(e);
                          if (f.k === 'vol_infused') {
                            const v = e.target.value.trim();
                            if (v && !v.toLowerCase().includes('ml')) {
                              const r = [...ivRows];
                              r[i] = { ...r[i], [f.k]: `${v} ml` };
                              setIvRows(r);
                              dirtyRef.current = true;
                            }
                          }
                        }}
                        autoComplete="off"
                        style={{ ...base, marginBottom: 8 }}
                      />
                    )}
                    {f.opts && (
                      <datalist id={`iv-${f.k}-${i}`}>
                        {f.opts.map(o => <option key={o} value={o} />)}
                      </datalist>
                    )}
                  </div>
                ))}
              </G2>
              <FullscreenSignaturePad
                label="Sign"
                value={row.sign}
                onChange={v => { const r = [...ivRows]; r[i] = { ...r[i], sign: v }; setIvRows(r); dirtyRef.current = true; }}
              />
            </Card>
          ))}
          {(() => {
            const cat = normaliseHpcsaCategory(fd.treating_practitioner_category);
            const canIv = !cat || isAuthorised(cat, 'circ_iv_cannulation_limbs_over_1yr');
            if (!canIv) return null;
            return <button type="button" onClick={() => setCrewPicker({ phase: 'select', kind: 'iv' })} style={{ width: '100%', padding: 12, borderRadius: 10, fontWeight: 800, fontSize: '0.88rem', border: `2px dashed ${G}`, background: GBG, color: GDK, cursor: 'pointer', marginBottom: 20 }}>+ Add IV Line</button>;
          })()}
        </>
      )}

      {/* ════════════════════════════════════════════════════
          MEDICATION — inline section (reason checkboxes +
          medication cards with crew member & signature)
          ════════════════════════════════════════════════════ */}
      {(forceOpen || (requiresToggle ? medOpen : showIvAndMeds)) && (
        <>
          {/* Reason checkboxes */}

          {/* Medication cards */}
          <SHdr t="Medication / Infusion" />
          {/* Native typeahead — crew can pick from the HPCSA medication catalogue
            but free-text entry is still permitted so a missing drug never blocks
            documentation. Source of truth: frontend/src/data/hpcsaScope.ts
            The list is filtered to the treating practitioner's authorised meds
            so unauthorised drugs are simply not suggested. Free-text bypass is
            intentional — the crew may need to record something off-list. */}
          {(() => {
            const cat = normaliseHpcsaCategory(fd.treating_practitioner_category);
            const authorised = medicationNamesForCategory(cat);
            return (
              <>
                {medRows.map((row, i) => {
                  const treatingCat = normaliseHpcsaCategory(fd.treating_practitioner_category);
                  const medCap = findMedicationByName(row.type);
                  const medOutOfScope = !!(treatingCat && medCap && !medCap.authorised.includes(treatingCat));
                  return (
                    <Card key={i} style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 8 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: '0.82rem', color: S600, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            Medication #{i + 1}
                            {medOutOfScope && (
                              <span style={{ fontSize: '0.6rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: '#78350f', background: '#fffbeb', border: '1px solid #f59e0b', padding: '2px 6px', borderRadius: 4 }}>
                                Out of scope for {treatingCat}
                              </span>
                            )}
                          </div>
                          {row.administered_by && (
                            <div style={{ fontSize: '0.7rem', color: S700, marginTop: 3, wordBreak: 'break-word' }}>
                              Administered by <b style={{ color: S900 }}>{row.administered_by}</b>
                              {row.administered_by_qualification ? ` · ${row.administered_by_qualification}` : ''}
                            </div>
                          )}
                        </div>
                        <button type="button" onClick={() => { setMedRows(medRows.filter((_, j) => j !== i)); dirtyRef.current = true; }} style={{ padding: '4px 10px', fontSize: '0.72rem', fontWeight: 700, borderRadius: 6, border: `1px solid ${S200}`, background: S50, color: REDC, cursor: 'pointer', flexShrink: 0 }}>Remove</button>
                      </div>
                      <G2>
                        {([
                          { l: 'Drug / Type', k: 'type' },
                          { l: 'Route', k: 'route' },
                          { l: 'Dose', k: 'dose' },
                          { l: 'Time', k: 'time' },
                          { l: 'Why medication is needed', k: 'reason', opts: [
                            'Medication / IV Administered On Route',
                            'Medication Administered via IV',
                            'Fluid Resuscitation Required',
                            'Profuse Bleeding'
                          ] }
                        ] as Array<{ l: string; k: string; opts?: string[] }>).map(f => (
                          <div key={f.k}>
                            <Lbl t={f.l} />
                            {f.k === 'type' ? (
                              <>
                                <input
                                  list={`med-type-${i}`}
                                  value={row.type ?? ''}
                                  onChange={e => { const r = [...medRows]; r[i] = { ...r[i], type: e.target.value }; setMedRows(r); dirtyRef.current = true; }}
                                  onFocus={onF}
                                  onBlur={onB}
                                  placeholder="Search or type drug name…"
                                  autoComplete="off"
                                  style={{ ...base, marginBottom: 8 }}
                                />
                                <datalist id={`med-type-${i}`}>
                                  {authorised.map(n => <option key={n} value={n} />)}
                                </datalist>
                              </>
                            ) : f.k === 'route' ? (() => {
                              const QUICK_ROUTES = ['IM', 'IV', 'ORAL', 'IN'];
                              const isCustom = !!row.route && !QUICK_ROUTES.includes(row.route) && row.route !== '__custom__';
                              const showCustomInput = isCustom || row.route === '__custom__';
                              const isSelected = !!row.route && QUICK_ROUTES.includes(row.route);

                              if (isSelected) {
                                return (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                    <span style={{
                                      display: 'inline-flex', alignItems: 'center',
                                      padding: '7px 18px', borderRadius: 20, fontWeight: 800,
                                      fontSize: '0.88rem', background: '#0f172a', color: '#ffffff',
                                      letterSpacing: '0.06em',
                                    }}>{row.route}</span>
                                    <button type="button"
                                      onClick={() => { const r = [...medRows]; r[i] = { ...r[i], route: '' }; setMedRows(r); dirtyRef.current = true; }}
                                      style={{ fontSize: '0.72rem', fontWeight: 600, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
                                      Change
                                    </button>
                                  </div>
                                );
                              }
                              if (showCustomInput) {
                                return (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                    <input
                                      autoFocus
                                      autoComplete="off"
                                      value={isCustom ? (row.route ?? '') : ''}
                                      placeholder="Type route…"
                                      onChange={e => { const r = [...medRows]; r[i] = { ...r[i], route: e.target.value }; setMedRows(r); dirtyRef.current = true; }}
                                      onFocus={onF}
                                      onBlur={onB}
                                      style={{ ...base, marginBottom: 0, flex: 1 }}
                                    />
                                    <button type="button"
                                      onClick={() => { const r = [...medRows]; r[i] = { ...r[i], route: '' }; setMedRows(r); dirtyRef.current = true; }}
                                      style={{ fontSize: '0.72rem', fontWeight: 600, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline', flexShrink: 0 }}>
                                      Back
                                    </button>
                                  </div>
                                );
                              }
                              // Default: quick-pick pill grid
                              return (
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, marginBottom: 8 }}>
                                  {QUICK_ROUTES.map(opt => (
                                    <button key={opt} type="button"
                                      onClick={() => { const r = [...medRows]; r[i] = { ...r[i], route: opt }; setMedRows(r); dirtyRef.current = true; }}
                                      style={{
                                        padding: '10px 4px', borderRadius: 10, fontWeight: 800,
                                        fontSize: '0.82rem', border: '2px solid #e2e8f0',
                                        background: '#f8fafc', color: '#334155', cursor: 'pointer',
                                        textAlign: 'center', WebkitTapHighlightColor: 'transparent',
                                      }}>
                                      {opt}
                                    </button>
                                  ))}
                                  <button type="button"
                                    onClick={() => { const r = [...medRows]; r[i] = { ...r[i], route: '__custom__' }; setMedRows(r); dirtyRef.current = true; }}
                                    style={{
                                      padding: '10px 4px', borderRadius: 10, fontWeight: 800,
                                      fontSize: '1.1rem', border: '2px dashed #cbd5e1',
                                      background: '#f8fafc', color: '#94a3b8', cursor: 'pointer',
                                      textAlign: 'center', letterSpacing: '0.08em',
                                      WebkitTapHighlightColor: 'transparent',
                                    }}>
                                    ···
                                  </button>
                                </div>
                              );
                            })() : f.k === 'time' ? (
                              <input
                                type="time"
                                value={row.time ?? ''}
                                onClick={() => {
                                  if (!row.time) {
                                    const now = new Date();
                                    const hh = String(now.getHours()).padStart(2, '0');
                                    const mm = String(now.getMinutes()).padStart(2, '0');
                                    const r = [...medRows]; r[i] = { ...r[i], time: `${hh}:${mm}` }; setMedRows(r); dirtyRef.current = true;
                                  }
                                }}
                                onChange={e => { const r = [...medRows]; r[i] = { ...r[i], time: e.target.value }; setMedRows(r); dirtyRef.current = true; }}
                                onFocus={onF}
                                onBlur={onB}
                                style={{ ...base, marginBottom: 8 }}
                              />
                            ) : f.opts ? (
                              <>
                                <input
                                  list={`med-${f.k}-${i}`}
                                  value={row[f.k] ?? ''}
                                  onChange={e => { const r = [...medRows]; r[i] = { ...r[i], [f.k]: e.target.value }; setMedRows(r); dirtyRef.current = true; }}
                                  onFocus={onF}
                                  onBlur={onB}
                                  placeholder=""
                                  autoComplete="off"
                                  style={{ ...base, marginBottom: 8 }}
                                />
                                <datalist id={`med-${f.k}-${i}`}>
                                  {f.opts?.map(o => <option key={o} value={o} />)}
                                </datalist>
                              </>
                            ) : (
                              <input
                                autoComplete="off"
                                value={row[f.k] ?? ''}
                                onChange={e => { const r = [...medRows]; r[i] = { ...r[i], [f.k]: e.target.value }; setMedRows(r); dirtyRef.current = true; }}
                                onFocus={onF}
                                onBlur={onB}
                                placeholder=""
                                style={{ ...base, marginBottom: 8 }}
                              />
                            )}
                          </div>
                        ))}
                      </G2>
                      <FullscreenSignaturePad
                        label="Sign"
                        value={row.sign}
                        onChange={v => { const r = [...medRows]; r[i] = { ...r[i], sign: v }; setMedRows(r); dirtyRef.current = true; }}
                      />
                    </Card>
                  );
                })}
              </>
            );
          })()}
          <button type="button" onClick={() => setMedReasonPromptOpen(true)} style={{ width: '100%', padding: 12, borderRadius: 10, fontWeight: 800, fontSize: '0.88rem', border: `2px dashed ${G}`, background: GBG, color: GDK, cursor: 'pointer', marginBottom: 20 }}>+ Add Medication</button>
        </>
      )}
    </>
  );
};

  // ── Phase 3: CLINICAL (assessment & treatment on scene) ───────────────────
  // `embedded=true` renders the clinical body without the LOAD & GO CTA so
  // it can be inlined into another phase (e.g. RESUS surfaces the full
  // clinical section on Dispatch so the crew can capture vitals immediately).
  const P3 = (embedded = false) => {
    // Declaration of Death — the patient is deceased, no clinical
    // assessment / vitals / medications apply. Render a short stub
    // and jump straight to Transport, which renders the DOD-specific
    // Undertaker form.
    if (fd.call_type === 'DOD') {
      return (
        <>
          <div style={{
            padding: '18px 16px', borderRadius: 12,
            background: '#fef2f2', border: `1.5px solid #fecaca`,
            marginBottom: 16,
          }}>
            <div style={{ fontSize: '0.78rem', fontWeight: 800, color: '#991b1b', letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 6 }}>
              Declaration of Death
            </div>
            <div style={{ fontSize: '0.86rem', color: '#7f1d1d', lineHeight: 1.5 }}>
              Clinical assessment is skipped — the patient has been declared
              deceased on scene. Proceed to the Transport phase to record
              the undertaker handover.
            </div>
          </div>
          {CTA({ label: "UNDERTAKER  →", onClick: () => advancePhase(4, 'time_depart_scene', 'km_depart_scene') })}
        </>
      );
    }
    return (
      <>
        {CriticalBanner()}
        {AllergyBanner()}

        {/* Treating practitioner — set by the gate modal on entry to Clinical.
          Determines which HPCSA scope governs procedure/medication entries
          downstream. Tap Change to swap mid-call (e.g. when a higher-cat
          crew member takes over). */}
        {(() => {
          // Normalise so legacy tier values ("ALS"/"ILS"/"BLS") from pre-migration
          // crew profiles still resolve correctly. Without this every scope check
          // below treats the practitioner as unrecognised and the banner shows
          // the fallback "Pick" alert when the practitioner is actually set.
          const cat = normaliseHpcsaCategory(fd.treating_practitioner_category);
          const meta = cat ? CATEGORY_META[cat] : undefined;
          const name = fd.treating_practitioner_name;
          if (!cat || !name) {
            // Fallback panel — only ever visible if the auto-open modal is
            // dismissed via dev tools or a stale state, since the gate normally
            // covers the Clinical content immediately on entry.
            return (
              <div role="alert" style={{
                padding: '12px 14px', marginBottom: 16, borderRadius: 12,
                background: '#fef3c7', border: '1.5px solid #f59e0b',
                color: '#78350f', fontSize: '0.82rem', fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
              }}>
                <span>Pick the treating practitioner before completing this section.</span>
                <button
                  type="button"
                  onClick={() => setCrewPicker({ phase: 'select', kind: 'treating' })}
                  style={{
                    padding: '6px 12px', borderRadius: 8, border: '1.5px solid #78350f',
                    background: '#fff', color: '#78350f', fontSize: '0.78rem',
                    fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap',
                  }}
                >Pick</button>
              </div>
            );
          }
          return (
            <div style={{
              padding: '10px 14px', marginBottom: 16, borderRadius: 12,
              background: GBG, border: `1.5px solid ${G}40`,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
            }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '0.62rem', fontWeight: 800, color: GDK, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Treating Practitioner
                </div>
                <div style={{ fontSize: '0.92rem', fontWeight: 800, color: S900, marginTop: 2 }}>
                  {name} · <span style={{ fontFamily: 'monospace' }}>{cat}</span>
                </div>
                {meta && (
                  <div style={{ fontSize: '0.68rem', color: S600, marginTop: 1 }}>
                    {meta.label}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Change treating practitioner mid-call? Downstream scope checks will switch to the new selection.')) {
                    setCrewPicker({ phase: 'select', kind: 'treating' });
                  }
                }}
                style={{
                  padding: '6px 12px', borderRadius: 8, border: `1.5px solid ${GDK}`,
                  background: '#fff', color: GDK, fontSize: '0.74rem',
                  fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >Change</button>
            </div>
          );
        })()}

        {/* Assessment level chip — shown once picked, tap to re-open modal.
            Never shown for DOD. */}
        {fd.call_type !== 'DOD' && fd.assessment_level && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: GBG, border: `1.5px solid ${G}30`,
            borderRadius: 12, padding: '10px 14px', marginBottom: 16,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '0.62rem', fontWeight: 800, color: GDK, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Assessment Level</div>
              <div style={{ fontSize: '0.96rem', fontWeight: 900, color: S900, marginTop: 2 }}>{fd.assessment_level}</div>
            </div>
            <button
              type="button"
              onClick={() => setAssessmentModalOpen(true)}
              style={{ padding: '6px 12px', borderRadius: 8, border: `1.5px solid ${GDK}`, background: '#fff', color: GDK, fontSize: '0.74rem', fontWeight: 800, cursor: 'pointer' }}
            >Change</button>
          </div>
        )}
        {/* Prompt to pick assessment if not yet chosen.
            Never shown for DOD. */}
        {fd.call_type !== 'DOD' && !fd.assessment_level && fd.treating_practitioner_name && (
          <button
            type="button"
            onClick={() => setAssessmentModalOpen(true)}
            style={{
              width: '100%', padding: '12px 14px', borderRadius: 12, marginBottom: 16,
              border: '1.5px dashed #93c5fd', background: '#eff6ff', color: '#1d4ed8',
              fontWeight: 800, fontSize: '0.88rem', cursor: 'pointer',
            }}
          >Select Assessment Level ↓</button>
        )}

        {/* Patient refuses treatment — hides the entire clinical capture block
            below (history, mechanism, surveys, injury diagram, vitals, oxygen,
            airway, circulation, immobilisation, equipment, IV/meds): there is
            nothing to record when the patient declines care. Tap again to undo
            and restore the sections. */}
        <button
          type="button"
          onClick={() => sf('patient_refused_treatment', !fd.patient_refused_treatment)}
          aria-pressed={!!fd.patient_refused_treatment}
          style={{
            width: '100%', padding: '13px 16px', borderRadius: 12, marginBottom: 16,
            border: `1.5px solid ${fd.patient_refused_treatment ? '#ef4444' : S200}`,
            background: fd.patient_refused_treatment ? '#fef2f2' : W,
            color: fd.patient_refused_treatment ? '#991b1b' : S700,
            fontWeight: 800, fontSize: '0.88rem', cursor: 'pointer', textAlign: 'center',
          }}
        >
          {fd.patient_refused_treatment ? '✓ Patient Refused Treatment — tap to undo' : 'Patient Refuses Treatment'}
        </button>

        <div ref={chiefComplaintRef} style={{ scrollMarginTop: 80 }}>
          {fd.call_type !== 'DOD' && (
            <>
              <SHdr t="Overseeing Practitioner Communication" />
              <Card>
                <Lbl t="Overseeing Practitioner Communication details" />
                <VoiceTxt fk="overseen_practitioner_communication" ph="Document communication with overseeing ALS or ILS practitioner here..." rows={3} />
              </Card>
            </>
          )}
        </div>

        {!fd.patient_refused_treatment && (<>
        <SHdr t="Patient History" />
        <Card>
          <Lbl t="Chief Complaint / Signs and Symptoms" req /><VoiceTxt fk="chief_complaint" ph="Patient's primary complaint, signs and symptoms..." rows={2} />
          <Lbl t="Primary Diagnosis" req /><Inp fk="primary_diagnosis" ph="e.g. Suspected appendicitis?" req onBlur={e => {
            const val = e.target.value.trim();
            if (val && !val.endsWith('?')) {
              sf('primary_diagnosis', val + '?');
            }
          }} />
          <Lbl t="Findings on Arrival" /><VoiceTxt fk="findings_on_arrival" ph="What you observed on arrival..." rows={2} />
          <Lbl t="Allergies" req /><Inp fk="allergies" ph="Known allergies (or None Known)" req />
          <Lbl t="Current Medications" /><VoiceTxt fk="current_medications" ph="List current medications..." rows={2} />
          <Lbl t="Past Medical / Surgical History" /><VoiceTxt fk="past_medical_history" ph="Relevant past history..." rows={2} />
          <G2>
            <div><Lbl t="Last Meal" /><Inp fk="last_meal" ph="e.g. Breakfast" /></div>
            <div><Lbl t="Time" /><Inp fk="last_meal_time" type="time" /></div>
          </G2>
          <Lbl t="Events / History of Presenting Illness or Injury" /><VoiceTxt fk="events_hpi" ph="Describe events / illness / injury leading to this call..." rows={4} />
        </Card>

        <SHdr t="Mechanism / Incident Type" />
        <Sel fk="mechanism" opts={MECHANISM_OPTS} />
        {fd.mechanism && (
          <>
            <Lbl t="Mechanism Detail" />
            <Inp
              fk="mechanism_other"
              ph={
                fd.mechanism === 'MVA (Motor Vehicle Accident)' ? 'e.g. Driver, restrained, high speed, rear collision'
                  : fd.mechanism === 'MBA (Motorbike Accident)' ? 'e.g. Rider, helmeted, ~80 km/h, single-vehicle / struck'
                    : fd.mechanism === 'PVA (Pedestrian vehicle accident)' ? 'e.g. Adult struck by sedan, ~60 km/h impact'
                      : fd.mechanism === 'Fall' ? 'Height of fall, surface landed on, conscious on arrival?'
                        : fd.mechanism === 'Burns' ? 'Source (flame / scald / chemical / electrical) + % BSA'
                          : fd.mechanism === 'Assault — Penetrating' ? 'Weapon, anatomical region, number of wounds'
                            : fd.mechanism === 'Assault — Blunt' ? 'Object used, anatomical region, time elapsed'
                              : 'Free-text detail to support the selected incident type'
              }
            /></>
        )}

        <SHdr t="Injury Diagram" />
        <BodyDiagram
          value={fd.body_marks}
          onChange={v => sf('body_marks', v)}
        />

        <SHdr t="Primary Survey" />
        <Card>
          {[{ k: 'survey_a', l: 'A — Airway', ph: 'Patent / Clear / Compromised' }, { k: 'survey_b', l: 'B — Breathing', ph: 'Spontaneous / Regular / Laboured' }, { k: 'survey_c', l: 'C — Circulation', ph: 'Radial pulse present / Good circulation' }].map(f => (
            <div key={f.k}><Lbl t={f.l} /><Inp fk={f.k} ph={f.ph} /></div>
          ))}
        </Card>

        <SHdr t="Secondary Survey" />
        <Card>
          {[{ k: 'survey_head_back', l: 'Head & Back', ph: 'No deformities noted' }, { k: 'survey_neuro', l: 'Neuro', ph: 'Alert / Bed confined' }, { k: 'survey_chest', l: 'Chest', ph: 'Clear air entry / Chest pain' }, { k: 'survey_abdo', l: 'Abdomen', ph: 'Soft / Non-tender' }, { k: 'survey_limbs', l: 'Limbs', ph: 'No deformities noted' }, { k: 'survey_back', l: 'Back', ph: 'Normal' }].map(f => (
            <div key={f.k}><Lbl t={f.l} /><Inp fk={f.k} ph={f.ph} /></div>
          ))}
        </Card>

        <div id="vitals-section-anchor" />
        <SHdr t="Vitals Monitoring" />
        {VitalsSection({ showFull: true })}

        <SHdr t="Oxygen Administration" />
        <Card>
          <G2>
            <div><Lbl t="Flow Rate (L/Min)" /><Sel fk="o2_flow_rate" opts={['1', '1.5', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15']} /></div>
            <div><Lbl t="Device" /><Sel fk="o2_device" opts={['Mask', 'Nasal Cannula', 'Non-Rebreather', 'Polymask Rebreather', 'Polymask Non-Rebreather', 'Nebulisation Mask', 'Venturi Mask', 'EtCO2 Device', 'BVM', 'Nebuliser']} /></div>
            <div><Lbl t="Start Time" /><Inp fk="o2_start_time" type="time" /></div>
            <div><Lbl t="Stop Time" /><Inp fk="o2_stop_time" type="time" /></div>
          </G2>
          <Lbl t="BVM" /><Inp fk="o2_bvm" ph="Rate (bpm) / notes" noMic />
        </Card>

        <SHdr t="Airway" />
        <Card>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
            {['Self-maintained', 'Suction', 'OP Airway', 'Supraglottic Airway', 'Intubation', 'Advanced Airway', 'Chest Decompression', 'Surg. Airway'].map(i => {
              const cat = normaliseHpcsaCategory(fd.treating_practitioner_category);
              const verdict = scopeForFormLabel(i, cat);
              const disabled = verdict.kind === 'unauthorised';
              const hint = verdict.kind === 'authorised' && verdict.condition
                ? 'Senior ECP / MO consultation required'
                : undefined;
              if (disabled) return null;
              return <Chk key={i} fk="airway_interventions" val={i} disabled={disabled} hint={hint} />;
            })}
          </div>
          {inArr('airway_interventions', 'OP Airway') && (
            <>
              <Lbl t="OP Airway Size" /><Inp fk="op_airway_size" noMic />
            </>
          )}
          {inArr('airway_interventions', 'Intubation') && (
            <div style={{ padding: 14, background: GBG, borderRadius: 10, marginBottom: 14, border: `1px solid ${G}30` }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 12px' }}>
                <div><Lbl t="Attempts" /><Inp fk="intubation_attempts" type="number" ph="0" /></div>
                <div><Lbl t="ETT Size" /><Inp fk="ett_size" ph="e.g. 7.5" /></div>
                <div><Lbl t="ETT Depth" /><Inp fk="ett_depth" ph="e.g. 21cm" /></div>
              </div>
            </div>
          )}
          <Lbl t="NG Tube Size" /><ScopedInp fk="ng_tube_size" capabilityKey="airway_oro_nasogastric_tube" ph="Size if applicable" noMic />
        </Card>

        <SHdr t="Circulation" />
        <Card>
          {/* Circulation interventions — matches the paper PRF: yes/no checkboxes
            for each intervention performed. "Defib J/NR" is a checkbox flag
            per the printed form. "No. IV Attempts" is a numeric input below
            so crews can record how many attempts were made. */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[
              'Periph. IV Line', 'Cardio Version',
              'IO Line', 'Pacing',
              'Central Line', 'Defib J/NR',
              'CPR', 'Bleeding'
            ].map(i => {
              const cat = normaliseHpcsaCategory(fd.treating_practitioner_category);
              const verdict = scopeForFormLabel(i, cat);
              const disabled = verdict.kind === 'unauthorised';
              const hint = verdict.kind === 'authorised' && verdict.condition
                ? 'Senior ECP / MO consultation required'
                : undefined;
              if (disabled) return null;
              return <Chk key={i} fk="circulation_interventions" val={i} disabled={disabled} hint={hint} />;
            })}
            {(inArr('circulation_interventions', 'Bleeding') || !!fd.primary_iv_profuse_bleeding) && (
              <div style={{ gridColumn: '1 / -1', marginTop: 6 }}>
                <Lbl t="Approx. Blood Loss (ml)" />
                <Sel fk="blood_loss_ml" opts={['< 50 ml', '50–100 ml', '100–250 ml', '250–500 ml', '500–1000 ml', '1000–1500 ml', '> 1500 ml']} />
              </div>
            )}
          </div>
          <div style={{ marginTop: 14 }}>
            <Lbl t="No. IV Attempts" />
            <ScopedInp fk="iv_attempts" capabilityKey="circ_iv_cannulation_limbs_over_1yr" type="number" ph="0" />
          </div>
        </Card>

        <SHdr t="Immobilisation Equipment" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
          {IMMOB_OPTS.map(i => <Chk key={i} fk="immob_equipment" val={i} />)}
        </div>
        <Card><Lbl t="Other Equipment / Adjuncts" /><Inp fk="other_equipment" ph="e.g. M17, other items" /></Card>

        {IvAndMedsSection()}
        </>)}

        {!embedded && CTA({ label: "LOAD &amp; GO  →", color: ROSE, onClick: () => advancePhase(4, 'time_depart_scene', 'km_depart_scene') })}
      </>
    );
  };

  // ── Phase 4: TRANSPORT ────────────────────────────────────────────────────
  const P4 = () => (
    <>
      {CriticalBanner()}
      {AllergyBanner()}

      <SHdr t="Departure" />
      {TimeTable({ rows: ALL_TIME_ROWS.filter(r => r.phase === 4) })}

      {/* Note: the DoD branch is gone — P4 is hidden when DoD is active
          and the Undertaker form now lives on the On Scene phase. */}
      <>
          {/* Medication/Infusion, Vitals Trend and Ongoing Monitoring are all
              clinical capture — hidden when the patient refused treatment (only
              Management Notes stays so the crew can narrate the refusal). */}
          {!fd.patient_refused_treatment && (<>
          {IvAndMedsSection({ showOnly: 'med_only', forceOpen: true })}

          {/* Vitals trend — last 3 sets side by side */}
          {vitals.length > 0 && (
            <>
              <SHdr t="Vitals Trend" />
              <div style={{ overflowX: 'auto', marginBottom: 16 }}>
                <div style={{ display: 'flex', gap: 10, minWidth: 'max-content' }}>
                  {vitals.slice(-3).map((vs, i, arr) => {
                    const prev = arr[i - 1];
                    const trend = (cur: string | undefined, pre: string | undefined) => {
                      if (!cur || !pre || isNaN(+cur) || isNaN(+pre)) return '';
                      return +cur > +pre ? ' ↑' : +cur < +pre ? ' ↓' : ' →';
                    };
                    return (
                      <div key={i} style={{ background: W, border: `1.5px solid ${S200}`, borderRadius: 12, padding: '12px 16px', minWidth: 140 }}>
                        <div style={{ fontSize: '0.65rem', fontWeight: 800, color: S400, textTransform: 'uppercase', marginBottom: 8 }}>{vs.time || `Set ${vitals.length - (arr.length - 1 - i)}`}</div>
                        {[{ l: 'HR', k: 'hr' }, { l: 'BP', k: 'bp' }, { l: 'SpO₂', k: 'spo2' }, { l: 'Pain', k: 'pain' }].map(f => (
                          vs[f.k] && <div key={f.k} style={{ fontSize: '0.82rem', fontWeight: 700, color: f.k === 'spo2' && +vs[f.k] < 90 ? REDC : S900, marginBottom: 4 }}>
                            {f.l}: <b>{vs[f.k]}{f.k === 'spo2' ? '%' : ''}</b>
                            {prev && <span style={{ color: trend(vs[f.k], prev[f.k]).includes('↑') ? REDC : trend(vs[f.k], prev[f.k]).includes('↓') ? G : S400, fontSize: '0.9rem' }}>{trend(vs[f.k], prev[f.k])}</span>}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          <SHdr t="Ongoing Monitoring" />
          {VitalsSection({ showFull: true })}
          </>)}

          <SHdr t="Management Notes" />
          <VoiceTxt fk="management_notes" ph="Full clinical narrative — care provided, patient response, interventions..." rows={6} />
      </>

      {CTA({ label: "AT DESTINATION  →", onClick: () => advancePhase(5, 'time_at_destination', 'km_at_destination') })}
    </>
  );

  // ── Phase 5: HANDOVER ─────────────────────────────────────────────────────
  const P5 = () => (
    <>
      <SHdr t="Arrival & Handover Times" />
      {TimeTable({ rows: ALL_TIME_ROWS.filter(r => r.phase === 5) })}

      {/* Auto-generated handover summary */}
      <div style={{ background: `${S700}08`, border: `1.5px solid ${S200}`, borderRadius: 14, padding: 18, marginBottom: 20 }}>
        <div style={{ fontSize: '0.72rem', fontWeight: 800, color: S600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 14, borderBottom: `1px solid ${S200}`, paddingBottom: 10 }}>Handover Summary</div>
        {[
          ['Patient', `${handoverSummary.patient}, ${handoverSummary.age}`],
          ['Complaint', handoverSummary.complaint],
          ['Priority', handoverSummary.priority],
          ['Level', handoverSummary.level],
          ['Allergies', handoverSummary.allergies],
          ['Last Vitals', `HR ${handoverSummary.hr} · BP ${handoverSummary.bp} · SpO₂ ${handoverSummary.spo2}`],
          ['Medications', handoverSummary.meds],
          ['Procedures', handoverSummary.procedures],
        ].map(([l, v]) => (
          <div key={l as string} style={{ display: 'flex', marginBottom: 8, gap: 10 }}>
            <div style={{ fontSize: '0.68rem', fontWeight: 700, color: S400, textTransform: 'uppercase', letterSpacing: '0.06em', minWidth: 80, paddingTop: 2 }}>{l}</div>
            <div style={{ fontSize: '0.88rem', fontWeight: 600, color: S900, flex: 1 }}>{v as string || '—'}</div>
          </div>
        ))}
      </div>

      <SHdr t={fd.med_aid_dec_death ? "Undertaker" : "Handover Details"} />
      <Card>
        {fd.med_aid_dec_death ? (
          <>
            <Lbl t="Receiving Name" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <input
                  type="text"
                  value={fd.handover_name ?? ''}
                  onChange={e => sf('handover_name', e.target.value)}
                  onFocus={onF}
                  onBlur={onB}
                  placeholder=""
                  autoComplete="off"
                  style={{ ...base, marginBottom: 0, borderColor: '#e2e8f0' }}
                />
              </div>
              <FullscreenSignaturePad
                compact
                label="Practitioner Signature"
                value={sigs.handover_signature}
                onChange={v => { setSigs(p => ({ ...p, handover_signature: v })); dirtyRef.current = true; }}
              />
            </div>
            <Lbl t="Receiving Facility Email" /><Inp fk="handover_doctor_email" ph="dr@hospital.co.za" type="email" />
          </>
        ) : (
          <>
            <Lbl t="Destination" /><HospitalPicker wardKey="ward" />
            <Lbl t="Ward / Unit" />
            <input
              type="text"
              value={fd.ward ?? ''}
              onChange={e => sf('ward', e.target.value)}
              onFocus={e => {
                // Clear the 'casualty' default the moment the crew taps in so
                // they can type the actual ward without deleting it manually.
                if ((fd.ward ?? '').trim().toLowerCase() === 'casualty') sf('ward', '');
                onF(e);
              }}
              onBlur={e => {
                // Field is always filled — restore the default if left blank.
                if (!(fd.ward ?? '').trim()) sf('ward', 'casualty');
                onB(e);
              }}
              placeholder=""
              autoComplete="off"
              style={{ ...base, marginBottom: 14, borderColor: '#e2e8f0' }}
            />

            <div style={{ marginBottom: 14 }}>
              <Lbl t={fd.call_type === 'COURTESY' ? "Receiving Practitioner / Person" : "Receiving Practitioner"} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                <div style={{ flex: 1 }}>
                  <input
                    type="text"
                    value={fd.receiving_doctor ?? ''}
                    onChange={e => sf('receiving_doctor', e.target.value)}
                    onFocus={onF}
                    onBlur={onB}
                    placeholder=""
                    autoComplete="off"
                    style={{ ...base, marginBottom: 0, borderColor: '#e2e8f0' }}
                  />
                </div>
                <FullscreenSignaturePad
                  compact
                  label="Handover Signature"
                  value={sigs.handover_signature}
                  onChange={v => { setSigs(p => ({ ...p, handover_signature: v })); dirtyRef.current = true; }}
                />
              </div>
            </div>

            <Lbl t="Practitioner Number" /><Inp fk="handover_qualification" ph="e.g. PR0123456" />
            <Lbl t="Receiving Facility Email" /><Inp fk="handover_doctor_email" ph="dr@hospital.co.za" type="email" />
            <Lbl t="Condition on Handover" /><VoiceTxt fk="handover_notes" ph="Patient condition at time of handover..." rows={2} />
            <div style={{ marginTop: 14 }}>
              <Lbl t="Patient Documents" />
              <PatientDocumentsCapture
                docs={{
                  hospital_sticker: fd.hospital_sticker,
                  admission_form_image: fd.admission_form_image,
                  id_document_image: fd.id_document_image,
                  medical_aid_image: fd.medical_aid_image,
                  aod_document: fd.aod_document,
                  additional_document_image: fd.additional_document_image,
                }}
                onChange={(key, v) => sf(key, v)}
              />
            </div>
          </>
        )}
      </Card>

      {/* ── Drugs Administered at Hospital ────────────────────────────────
           Records drugs given by the receiving facility's staff after
           handover. NOT subject to HPCSA EMS scope filtering (the hospital
           administers under its own scope), so the datalist shows the full
           medication catalogue and free-text entry is permitted. Stored in
           `fd.hospital_medications` as an array of {time, drug, dose, route};
           the existing autosave picks the array up automatically.
           Only relevant for inter-facility transfers (IFT / IHT), where the
           crew witnesses drugs administered by hospital staff. ── */}
      {['IFT', 'IHT'].includes(fd.call_type) && (() => {
        const rows = (fd.hospital_medications ?? []) as Array<{ time?: string; drug?: string; dose?: string; route?: string }>;
        const updateRow = (idx: number, key: string, value: string) => {
          sf('hospital_medications', rows.map((r, j) => j === idx ? { ...r, [key]: value } : r));
        };
        const addRow = () => sf('hospital_medications', [...rows, {}]);
        const removeRow = (idx: number) => sf('hospital_medications', rows.filter((_, j) => j !== idx));
        const ROUTES = ['IV', 'IM', 'SC', 'IO', 'PO', 'IN', 'SL', 'Inhaled', 'PR', 'Topical', 'Other'];
        return (
          <>
            <SHdr t="Drugs Administered at Hospital" />
            <datalist id="hospital-drug-options">
              {medicationNamesForCategory(undefined).map(n => <option key={n} value={n} />)}
            </datalist>
            {rows.map((row, i) => (
              <Card key={i} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.82rem', color: S600 }}>Hospital Drug #{i + 1}</div>
                  <button type="button" onClick={() => removeRow(i)} style={{ padding: '4px 10px', fontSize: '0.72rem', fontWeight: 700, borderRadius: 6, border: `1px solid ${S200}`, background: S50, color: REDC, cursor: 'pointer', flexShrink: 0 }}>Remove</button>
                </div>
                {/* DodG2 instead of G2: native `<input type="time">` and `<select>`
                    have an intrinsic min-content width on iOS Safari that pushes
                    past a strict 1fr/1fr column and overlaps the neighbour, so
                    we fold to a single column on phones <480px wide. */}
                <DodG2>
                  <div>
                    <Lbl t="Time" />
                    <input
                      type="time"
                      value={row.time ?? ''}
                      onChange={e => updateRow(i, 'time', e.target.value)}
                      onFocus={onF}
                      onBlur={onB}
                      style={{ ...base, marginBottom: 8 }}
                    />
                  </div>
                  <div>
                    <Lbl t="Drug Name" />
                    <input
                      list="hospital-drug-options"
                      autoComplete="off"
                      value={row.drug ?? ''}
                      onChange={e => updateRow(i, 'drug', e.target.value)}
                      onFocus={onF}
                      onBlur={onB}
                      style={{ ...base, marginBottom: 8 }}
                    />
                  </div>
                  <div>
                    <Lbl t="Dose" />
                    <input
                      value={row.dose ?? ''}
                      onChange={e => updateRow(i, 'dose', e.target.value)}
                      onFocus={onF}
                      onBlur={onB}
                      autoComplete="off"
                      style={{ ...base, marginBottom: 8 }}
                    />
                  </div>
                  <div>
                    <Lbl t="Route" />
                    <input
                      list={`hospital-route-${i}`}
                      value={row.route ?? ''}
                      onChange={e => updateRow(i, 'route', e.target.value)}
                      onFocus={onF}
                      onBlur={onB}
                      autoComplete="off"
                      style={{ ...base, marginBottom: 8 }}
                    />
                    <datalist id={`hospital-route-${i}`}>
                      {ROUTES.map(r => <option key={r} value={r} />)}
                    </datalist>
                  </div>
                </DodG2>
              </Card>
            ))}
            <button type="button" onClick={addRow} style={{ width: '100%', padding: 12, borderRadius: 10, fontWeight: 800, fontSize: '0.88rem', border: `2px dashed ${G}`, background: GBG, color: GDK, cursor: 'pointer', marginBottom: 20 }}>+ Add Drug</button>
          </>
        );
      })()}


      <SHdr t="Medical Aid Information" />
      {fd.billing_type === 'MED AID' && (
        <Card>
          <Lbl t="Medical Aid" /><ComboInp fk="medical_scheme" opts={MEDICAL_SCHEMES} listId="medical-schemes-list" ph="Type to search…" />
          <Lbl t="Medical Aid Number" /><Inp fk="medical_aid_number" ph="Member number" />
          <PostAuthField />
          <G2>
            <div><Lbl t="Dependent No." /><DepCodePicker /></div>
            <div><Lbl t="Main Member ID" /><Inp fk="main_member_id" ph="ID number" /></div>
          </G2>
          <Lbl t="Plan / Option" /><SchemeOptionField />
        </Card>
      )}
      {fd.billing_type !== 'MED AID' && (
        <Card>
          <Lbl t="Billing Type" />
          <div style={{ fontWeight: 700, fontSize: '0.9rem', color: GDK, marginBottom: 14 }}>{fd.billing_type || '— Not selected —'}</div>
          {(fd.billing_type === 'WCA / IOD' || fd.call_type === 'WCA_IOD' || fd.billing_type === 'RAF') && (
            <><Lbl t="Reference Number" /><Inp fk="compensation_reference" ph="Reference number" /></>
          )}
        </Card>
      )}

      <SHdr t="Valuables" />
      <Card>
        <Lbl t="Valuables Handed To" /><Inp fk="valuables_handed_to" ph="Name of person receiving valuables" />
        <Lbl t="Description" /><VoiceTxt fk="valuables_description" ph="List valuables..." rows={2} />
      </Card>

      {['IHT', 'IFT'].includes(fd.call_type) && (
        <>
          <SHdr t="Return Trip" />
          <Card>
            {/* DodG2 = JS-viewport-aware grid: 2 cols on tablet/desktop, 1 col
                on phones <480px wide. Native `<input type="time">` has an
                intrinsic min width on iOS Safari that pushes past a 1fr/1fr
                column and visually overlaps the neighbour, so we fold to a
                single column on narrow viewports. */}
            <DodG2>
              <div><Lbl t="Despatch" /><Inp fk="return_despatch_time" type="time" /></div>
              <div><Lbl t="On Scene" /><Inp fk="return_on_scene_time" type="time" /></div>
              <div><Lbl t="Arrival at Destination" /><Inp fk="return_at_destination_time" type="time" /></div>
              <div><Lbl t="Depart Scene" /><Inp fk="return_depart_scene_time" type="time" /></div>
              <div><Lbl t="Handover" /><Inp fk="return_handover_time" type="time" /></div>
              <div><Lbl t="Available" /><Inp fk="return_available_time" type="time" /></div>
            </DodG2>
          </Card>
        </>
      )}

      {/* The Complete phase is hidden from the stepper for every call type —
          Handover is the final screen. The Available time row, crew details,
          signatures and Submit button all render inline at the bottom here
          via P6(). */}
      {P6()}
    </>
  );

  // ── Terms & Conditions ───────────────────────────────────────────────────
  const renderTermsAndConditions = () => {
    return (
      <>
        <SHdr t="Terms and Conditions" />
        <Card>
          {(() => {
            const company = profile?.provider_name || 'the Service Provider';
            const clauses: Array<[string, string]> = [
              ['Acknowledgment of Treatment & Financial Responsibility',
                `I, the person whose name appears on this form as the patient, patient's parent, patient's guardian, or authorized representative, hereby acknowledge that the treatment and/or transportation noted on this document was received by the patient. I accept full responsibility for all payments associated with such treatment and/or transport as recorded on this document, irrespective of whether I am covered by a medical aid scheme or not.`],
              ['Authorization for Data Disclosure & Debt Collection',
                `I hereby authorize ${company} to disclose any patient details in this document to third parties (for example, the Road Accident Fund, Compensation Commissioner, or collection agencies) and to trace any details not contained in this document to assist in the collection of any overdue or outstanding amounts due in respect of the treatment or transport provided to the patient by ${company}.`],
              ['Assumption of Risk',
                `I hereby accept all risks associated with the emergency medical treatment and/or transportation provided or to be provided by ${company}.`],
              ['Indemnity & Release of Liability',
                `I hereby release ${company} (including its directors, employees, agents, and representatives) from any liability, and indemnify and hold ${company} harmless against all loss, damages, or claims arising from or related to the emergency medical treatment and/or transportation provided or to be provided by ${company} as noted in this form.`],
            ];
            return (
              <div style={{ fontSize: '0.8rem', color: S700, lineHeight: 1.5 }}>
                {clauses.map(([h, b], idx) => (
                  <div key={idx} style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 800, color: S900, marginBottom: 2 }}>{idx + 1}. {h}</div>
                    <div>{b}</div>
                  </div>
                ))}
              </div>
            );
          })()}
          <div style={{ marginTop: 8 }}>
            {fd.call_type !== 'DOD' && (
              <FullscreenSignaturePad
                label="Patient / Representative Signature"
                value={fd.tc_patient_signature}
                onChange={v => { sf('tc_patient_signature', v); setSigs(p => ({ ...p, patient_signature: v })); }}
              />
            )}
            <FullscreenSignaturePad
              label="Witness Signature"
              value={fd.tc_witness_signature}
              onChange={v => { sf('tc_witness_signature', v); setSigs(p => ({ ...p, witness_signature: v })); }}
            />
            <FullscreenSignaturePad
              label="Next of Kin Signature"
              value={fd.next_of_kin_signature}
              onChange={v => { sf('next_of_kin_signature', v); }}
            />
          </div>
        </Card>
      </>
    );
  };

  // ── Phase 6: COMPLETE ─────────────────────────────────────────────────────
  const P6 = () => {
    const crew2 = prfMeta.crew_member_2 || null;
    return (
      <>
        <SHdr t="Completion Times" />
        {TimeTable({ rows: ALL_TIME_ROWS.filter(r => r.phase === 6) })}

        {/* Crew Details, Assessed/Managed By, Final Management Notes,
            Signatures, and the patient-billing disclaimer are skipped for
            Resus — the Resus Handover page is the final screen and only
            needs the Available time plus the Submit button. */}
        {fd.call_type !== 'RESUS' && (
          <>
            <SHdr t="Crew Details" />
            <Card>
              <G2>
                <div>
                  <Lbl t="Crew 1" />
                  <div style={{ ...base, background: '#f8fafc', color: '#334155', fontWeight: 600 }}>
                    {profile.name || '—'}
                    {profile.qualification || profile.hpcsa_number ? (
                      <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: 2, fontWeight: 500 }}>
                        {profile.qualification || '—'} {profile.hpcsa_number ? `· ${profile.hpcsa_number}` : ''}
                      </div>
                    ) : null}
                  </div>
                </div>
                {crew2 && (
                  <div>
                    <Lbl t="Crew 2" />
                    <div style={{ ...base, background: '#f8fafc', color: '#334155', fontWeight: 600 }}>
                      {crew2.full_name || '—'}
                      {crew2.qualification || crew2.hpcsa_number ? (
                        <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: 2, fontWeight: 500 }}>
                          {crew2.qualification || '—'} {crew2.hpcsa_number ? `· ${crew2.hpcsa_number}` : ''}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
                {Array.isArray(fd.extra_crew) && fd.extra_crew.map((c: any, i: number) => (
                  <div key={i}>
                    <Lbl t={`Crew ${i + 3}`} />
                    <div style={{ ...base, background: '#f8fafc', color: '#334155', fontWeight: 600 }}>
                      {c.name || c.full_name || '—'}
                      {c.qualification || c.hpcsa_number ? (
                        <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: 2, fontWeight: 500 }}>
                          {c.qualification || '—'} {c.hpcsa_number ? `· ${c.hpcsa_number}` : ''}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </G2>
            </Card>

            <SHdr t="Final Management Notes" />
            <VoiceTxt fk="management_notes" ph="Full clinical narrative — complete account of care provided..." rows={6} />

            <SHdr t="Motivation / Other Notes" />
            <VoiceTxt fk="motivation_notes" ph="Billing motivation / other notes — e.g. times, A/B/C/D, IV, drugs, immobilisation." rows={3} />

            {/* Terms & Conditions — patient/representative acknowledgment of
                treatment, financial responsibility, data disclosure, assumption
                of risk and indemnity. Company name is the crew's provider. */}

            {renderTermsAndConditions()}
          </>
        )}

        <button type="button" onClick={handleSubmit} disabled={submitting} style={{ width: '100%', padding: 18, borderRadius: 14, fontSize: '1.05rem', fontWeight: 800, border: 'none', cursor: submitting ? 'wait' : 'pointer', background: submitting ? S400 : `linear-gradient(135deg,${ROSE},#be123c)`, color: W, boxShadow: submitting ? 'none' : `0 6px 24px rgba(225,29,72,0.3)` }}>
          {submitting ? 'Submitting PRF...' : 'Complete & Submit PRF'}
        </button>

      </>
    );
  };

  const RENDERERS = [P0, P1, P2, P3, P4, P5, P6];

  // ── Vitals reminder timestamp ────────────────────────────────────────────
  // Convert the most recent vital set's HH:mm into an absolute epoch on the
  // PRF's incident date. We anchor on `time_dispatched` so that if the shift
  // crosses midnight the latest vital is still placed on the correct
  // calendar day. Returns null until at least one vital set has been
  // recorded — that's the trigger for the reminder pill to appear.
  const lastVitalAt = useMemo<number | null>(() => {
    // Only count vital sets that are fully completed (not currently being edited)
    const completedVitals = vitals.filter((_, i) => i !== editVital);
    if (!completedVitals.length) return null;
    const last = completedVitals[completedVitals.length - 1];
    if (!last?.time) return null;
    const [hh, mm] = String(last.time).split(':').map((s: string) => parseInt(s, 10));
    if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
    const anchor = timestamps.time_dispatched
      ? new Date(timestamps.time_dispatched)
      : new Date();
    const d = new Date(anchor);
    d.setHours(hh, mm, 0, 0);
    // If anchor is later in the day than the recorded vital, the vital must
    // belong to the next calendar day (shift crossed midnight).
    if (d.getTime() < anchor.getTime() - 12 * 60 * 60 * 1000) {
      d.setDate(d.getDate() + 1);
    }
    return d.getTime();
  }, [vitals, editVital, timestamps.time_dispatched]);

  // Tap-to-jump: route the crew straight to the Clinical phase (vitals live
  // there) and scroll the vitals heading into view on the next paint.
  const jumpToVitals = useCallback(() => {
    setPhase(3);
    setTimeout(() => {
      const el = document.getElementById('vitals-section-anchor');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 60);
  }, []);

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: S50, padding: 20,
      }}>
        <div style={{
          background: W, borderRadius: 16, padding: '28px 24px',
          maxWidth: 360, width: '100%', textAlign: 'center',
          boxShadow: '0 8px 28px rgba(15,23,42,0.08)',
          border: `1px solid ${S200}`,
        }}>
          <div style={{
            width: 48, height: 48, borderRadius: 24, background: '#fef2f2',
            color: REDC, fontSize: '1.4rem', fontWeight: 800,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 14px',
          }}>!</div>
          <div style={{ fontSize: '1rem', fontWeight: 800, color: S900, marginBottom: 6 }}>
            Couldn't load the PRF
          </div>
          <div style={{ fontSize: '0.84rem', color: S600, lineHeight: 1.5, marginBottom: 18 }}>
            {loadError}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => navigate(-1)}
              style={{
                flex: 1, padding: '12px 0', borderRadius: 10,
                fontSize: '0.86rem', fontWeight: 700,
                border: `2px solid ${S200}`, background: W, color: S600,
                cursor: 'pointer',
              }}
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => { setLoading(true); setLoadError(null); loadPrf(); }}
              style={{
                flex: 2, padding: '12px 0', borderRadius: 10,
                fontSize: '0.86rem', fontWeight: 800,
                border: 'none', background: `linear-gradient(135deg,${G},${GDK})`,
                color: W, cursor: 'pointer',
                boxShadow: `0 4px 14px ${G}30`,
              }}
            >
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: S50, color: S600, fontWeight: 500, gap: 14, padding: 20,
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          border: `3px solid ${S200}`, borderTopColor: G,
          animation: 'spin 0.7s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <div style={{ fontSize: '0.9rem' }}>{retrying ? 'Reconnecting…' : 'Loading PRF…'}</div>
        {retrying && (
          <button
            type="button"
            onClick={() => navigate(-1)}
            style={{
              marginTop: 8, padding: '10px 22px', borderRadius: 10,
              fontSize: '0.78rem', fontWeight: 700,
              border: `1px solid ${S200}`, background: W, color: S600,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        )}
      </div>
    );
  }

  const renderPhase = RENDERERS[phase];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <FormContext.Provider value={{ fd, sf, inArr, toggleArr, profile, prfMeta,
      // Signature columns (PRF-level, not form_data) — exposed so DodFormBody
      // can capture the recipient signature into `handover_signature`, the key
      // the DOD certificate's "Recipient Signature" box reads.
      sigs,
      setSig: (k: string, v: string | null) => { setSigs(p => ({ ...p, [k]: v })); dirtyRef.current = true; },
      renderDispatchTimes: () => TimeTable({ rows: ALL_TIME_ROWS.filter(r => r.phase === 0 || r.phase === 2) }) }}>
      <div style={{ minHeight: '100vh', maxWidth: '100vw', overflowX: 'clip', background: S50, color: S900, paddingTop: 'var(--app-safe-top, env(safe-area-inset-top))', paddingBottom: 100, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' }}>

        {/* ── Sticky header — fancy journey-phase bar ──
          Gradient backdrop, glossy nodes with subtle inner highlight, active
          step lifted with a brand-green halo ring, completed steps filled
          with a green→teal gradient and a checkmark, connectors blend
          smoothly between filled and pending states.
          Now shown on brand-new PRFs (phase 0 / Dispatch) as well. */}
        {phase >= 0 && (
        <div style={{
          position: 'sticky', top: 'calc(8px + var(--app-safe-top, env(safe-area-inset-top)))', zIndex: 50,
          width: isScrolled ? 'min(400px, calc(100% - 64px))' : 'min(760px, calc(100% - 32px))', margin: '12px auto 0',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(248,250,252,0.96) 100%)',
          backdropFilter: 'blur(14px)',
          WebkitBackdropFilter: 'blur(14px)',
          border: `1px solid ${S200}`,
          borderRadius: isScrolled ? 999 : 16,
          boxShadow: isScrolled ? '0 4px 12px rgba(15,23,42,0.06)' : '0 6px 24px rgba(15,23,42,0.08)',
          transition: 'all 0.3s ease',
        }}>
          <div style={{ padding: isScrolled ? '6px 16px' : '14px 18px 10px', transition: 'padding 0.3s ease' }}>
            {/* Nodes + connectors row */}
            <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
              {(() => {
                // Declaration of Death: deceased patients don't have an
                // En Route, Clinical, or Handover leg, so those nodes are
                // dropped from the bar. The original phase indices are
                // preserved so `phase` state and `setPhase()` calls keep
                // working unchanged.
                // PRIMARY calls drop En Route and Clinical from the bar —
                // the clinical section renders inline in Dispatch, so the
                // standalone Clinical node would just duplicate it.
                // En Route (1) and Clinical (3) are hidden universally —
                // GO MOBILE jumps straight to On Scene, and DEPART SCENE
                // jumps straight to Transport, so neither node ever
                // represents a visited step.
                const hidden = fd.med_aid_dec_death
                  ? new Set([1, 3, 4, 5, 6])
                  : fd.call_type === 'RESUS'
                  ? new Set([1, 3, 6])
                  : fd.call_type === 'PRIMARY'
                  ? new Set([1, 3, 6])
                  : fd.call_type === 'RHT'
                  ? new Set([1, 3, 4, 5, 6])
                  : new Set<number>([1, 3, 6]);
                const visible = PHASES.map((_p, i) => i).filter(i => !hidden.has(i) && i <= maxPhase);
                return visible.map((origIdx, viewIdx) => {
                  const _p = PHASES[origIdx];
                  const i = origIdx;
                  const done = phase > i;
                  const active = phase === i;
                  const nodeFill = done || active
                    ? `linear-gradient(135deg, ${G} 0%, ${GDK} 100%)`
                    : '#ffffff';
                  const nodeBorder = done || active ? GDK : '#cbd5e1';
                  const nodeColor = done || active ? '#ffffff' : '#94a3b8';
                  const nodeShadow = active
                    ? `0 0 0 5px ${G}1f, 0 4px 12px ${G}40`
                    : done
                      ? `0 2px 6px ${G}30`
                      : '0 1px 2px rgba(15,23,42,0.06)';
                  const connectorFill = phase > i
                    ? `linear-gradient(90deg, ${G}, ${GDK})`
                    : S200;

                  return (
                    <div key={_p.id} style={{
                      display: 'flex', alignItems: 'center',
                      flex: viewIdx < visible.length - 1 ? '1 1 0' : (visible.length === 1 ? '1' : 'none'),
                      justifyContent: visible.length === 1 ? 'center' : 'flex-start',
                    }}>
                    <button
                      type="button"
                      onClick={() => {
                        // Backward / same-phase navigation: always allowed (the
                        // crew may want to review or amend an earlier leg).
                        // Forward navigation: must clear the same leave-phase
                        // gates the CTA buttons enforce, so jumping directly to
                        // a later phase node can't bypass the odometer / pre-auth
                        // requirement on the current phase.
                        if (i <= phase) { setPhase(i); return; }
                        const blockers = collectLeavePhaseBlockers(phase);
                        if (blockers.length > 0) { showBlockerBanner(blockers); return; }
                        setPhase(i);
                      }}
                      aria-label={`Go to ${_p.label}`}
                      style={{
                        width: isScrolled ? 26 : 34, height: isScrolled ? 26 : 34, borderRadius: 999, flexShrink: 0,
                        background: nodeFill,
                        border: `1.5px solid ${nodeBorder}`,
                        color: nodeColor,
                        fontSize: isScrolled ? '0.65rem' : '0.74rem', fontWeight: 900,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer',
                        boxShadow: nodeShadow,
                        transition: 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
                        transform: active ? 'scale(1.08)' : 'scale(1)',
                        padding: 0,
                      }}
                    >
                      {done ? (
                        <svg width={isScrolled ? 12 : 14} height={isScrolled ? 12 : 14} viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" strokeWidth="3.2"
                          strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        viewIdx + 1
                      )}
                    </button>
                    {viewIdx < visible.length - 1 && (
                      <div style={{
                        flex: 1, height: 3, margin: '0 4px', borderRadius: 999,
                        background: connectorFill,
                        transition: 'background 0.4s ease',
                      }} />
                    )}
                  </div>
                );
                });
              })()}
            </div>

            {/* Labels row */}
            <div style={{ 
              display: 'flex', 
              marginTop: isScrolled ? 0 : 8, 
              maxHeight: isScrolled ? 0 : 20, 
              opacity: isScrolled ? 0 : 1, 
              overflow: 'hidden', 
              transition: 'all 0.3s ease' 
            }}>
              {(() => {
                const hidden = fd.med_aid_dec_death
                  ? new Set([1, 3, 4, 5, 6])
                  : fd.call_type === 'RESUS'
                  ? new Set([1, 3, 6])
                  : fd.call_type === 'PRIMARY'
                  ? new Set([1, 3, 6])
                  : fd.call_type === 'RHT'
                  ? new Set([1, 3, 4, 5, 6])
                  : new Set<number>([1, 3, 6]);
                const visible = PHASES.map((_p, i) => i).filter(i => !hidden.has(i) && i <= maxPhase);
                return visible.map(origIdx => {
                  const p = PHASES[origIdx];
                  const i = origIdx;
                  const done = phase > i, active = phase === i;
                  return (
                    <div key={p.id} style={{
                      flex: 1, textAlign: 'center',
                      fontSize: '0.6rem',
                      fontWeight: active ? 900 : 600,
                      color: active ? GDK : done ? G : '#94a3b8',
                      textTransform: 'uppercase',
                      letterSpacing: '0.1em',
                      transition: 'color 0.25s',
                      whiteSpace: 'nowrap',
                    }}>
                      {p.short}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </div>
        )}

        <div style={{ paddingTop: isMobileView ? 72 : 110 }}>
          {/* ── Validation banner (rule findings from prfValidation.ts) ── */}
          {findings.length > 0 && (
            <div id="prf-validation-banner" style={{ padding: '0 18px 16px', maxWidth: 640, margin: '0 auto' }}>
              {validationBlockers(findings).length > 0 && (
                <div style={{
                  background: '#fee2e2', border: `2px solid #ef4444`, borderRadius: 12,
                  padding: '14px 15px', marginBottom: 8,
                  boxShadow: '0 4px 18px rgba(239,68,68,0.32)',
                }}>
                  <div style={{ fontSize: '0.88rem', fontWeight: 900, color: '#dc2626', marginBottom: 7, letterSpacing: '0.02em' }}>
                    ⚠️ {validationBlockers(findings).length} required item{validationBlockers(findings).length === 1 ? '' : 's'} missing
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.78rem', color: '#7f1d1d', lineHeight: 1.5 }}>
                    {validationBlockers(findings).map(f => (
                      <li
                        key={f.id}
                        onClick={() => jumpToField(f.field)}
                        style={{ marginBottom: 4, cursor: f.field ? 'pointer' : 'default', textDecoration: f.field ? 'underline dotted' : 'none' }}
                      >
                        {f.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {validationWarnings(findings).length > 0 && (
                <div style={{
                  background: '#fffbeb', border: `1px solid #fde68a`, borderRadius: 12,
                  padding: '12px 14px', marginBottom: 8,
                }}>
                  <div style={{ fontSize: '0.78rem', fontWeight: 800, color: '#92400e', marginBottom: 6, letterSpacing: '0.02em' }}>
                    {validationWarnings(findings).length} warning{validationWarnings(findings).length === 1 ? '' : 's'} — claim may be rejected if not addressed
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.78rem', color: '#78350f', lineHeight: 1.5 }}>
                    {validationWarnings(findings).map(f => (
                      <li
                        key={f.id}
                        onClick={() => jumpToField(f.field)}
                        style={{ marginBottom: 4, cursor: f.field ? 'pointer' : 'default', textDecoration: f.field ? 'underline dotted' : 'none' }}
                      >
                        {f.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <button
                type="button"
                onClick={() => setFindings([])}
                style={{
                  fontSize: '0.7rem', fontWeight: 600, color: S600, background: 'transparent',
                  border: 'none', cursor: 'pointer', padding: '4px 0', textDecoration: 'underline',
                }}
              >
                Dismiss
              </button>
            </div>
          )}

          {/* ── Phase content ── */}
          <div style={{ padding: '0 18px 20px', maxWidth: 640, margin: '0 auto', overflowAnchor: 'none' }}>
            {renderPhase()}
          </div>
        </div>

        {/* Motivation prompt — shown when submitting with fewer than 3 vital sets. */}
        {vitalsMotivationOpen && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <div style={{ background: W, borderRadius: 16, padding: '22px 20px', maxWidth: 420, width: '100%', boxShadow: '0 12px 40px rgba(0,0,0,0.25)' }}>
              <div style={{ fontSize: '1rem', fontWeight: 800, color: S900, marginBottom: 8 }}>
                Fewer than 3 sets of vitals
              </div>
              <div style={{ fontSize: '0.84rem', color: S600, lineHeight: 1.5, marginBottom: 14 }}>
                Only {vitals.length} set{vitals.length === 1 ? '' : 's'} of vitals {vitals.length === 1 ? 'was' : 'were'} recorded. Please give a brief motivation for why fewer than 3 sets were taken before submitting.
              </div>
              {/* Voice-to-text enabled — the crew can tap the mic and dictate
                  the motivation instead of typing (gloves-on friendly). */}
              <VoiceTxt fk="vitals_shortfall_motivation" ph="e.g. Very short transport time; patient handed over within minutes." rows={4} />
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  onClick={() => { setVitalsMotivationOpen(false); submitInFlightRef.current = false; }}
                  style={{ flex: 1, padding: '12px 0', borderRadius: 10, fontWeight: 700, border: `2px solid ${S200}`, background: W, color: S600, cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!(fd.vitals_shortfall_motivation ?? '').trim()}
                  onClick={() => { setVitalsMotivationOpen(false); submitInFlightRef.current = false; void handleSubmit(); }}
                  style={{
                    flex: 2, padding: '12px 0', borderRadius: 10, fontWeight: 800, border: 'none', color: W,
                    background: (fd.vitals_shortfall_motivation ?? '').trim() ? `linear-gradient(135deg,${ROSE},#be123c)` : S400,
                    cursor: (fd.vitals_shortfall_motivation ?? '').trim() ? 'pointer' : 'not-allowed',
                  }}
                >
                  Continue & Submit
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Crew sign-off — every crew member signs before the PRF is submitted. */}
        {crewSignOffOpen && (() => {
          const signList = getCrewSignList();
          const cs = fd.crew_signoff_sigs || {};
          const signedCount = signList.filter(c => !!(cs[c.key] && String(cs[c.key]).trim())).length;
          const totalCount = signList.length;
          const allSigned = signedCount === totalCount;
          return (
            <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
              <div style={{ background: W, borderRadius: 16, padding: '22px 20px', maxWidth: 460, width: '100%', maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 12px 40px rgba(0,0,0,0.25)' }}>
                <div style={{ fontSize: '1.05rem', fontWeight: 900, color: S900, marginBottom: 6 }}>Crew Sign-Off</div>
                <div style={{ fontSize: '0.84rem', color: S600, lineHeight: 1.5, marginBottom: 4 }}>
                  Each crew member must sign before the PRF can be submitted.
                </div>
                {/* Progress indicator */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                  background: allSigned ? 'rgba(22,163,74,0.08)' : 'rgba(245,158,11,0.08)',
                  border: `1px solid ${allSigned ? '#86efac' : '#fcd34d'}`,
                  borderRadius: 8, marginBottom: 14,
                }}>
                  <span style={{ fontSize: '1rem' }}>{allSigned ? '✅' : '✍️'}</span>
                  <span style={{ fontSize: '0.8rem', fontWeight: 700, color: allSigned ? '#15803d' : '#92400e' }}>
                    {allSigned
                      ? 'All crew members have signed — ready to submit!'
                      : `${signedCount} of ${totalCount} signed — tap the pencil icon to sign`}
                  </span>
                </div>
                {signList.map(c => {
                  const isSigned = !!(cs[c.key] && String(cs[c.key]).trim());
                  return (
                    <div key={c.key} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                      padding: '12px 10px', borderTop: `1px solid ${S100}`,
                      background: !isSigned ? 'rgba(245,158,11,0.04)' : 'transparent',
                      borderRadius: 6,
                    }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ fontWeight: 700, color: S900, fontSize: '0.9rem' }}>{c.name}</div>
                          {/* Signed / Unsigned badge */}
                          <span style={{
                            fontSize: '0.65rem', fontWeight: 800, padding: '1px 7px', borderRadius: 99,
                            background: isSigned ? 'rgba(22,163,74,0.12)' : 'rgba(245,158,11,0.15)',
                            color: isSigned ? '#15803d' : '#92400e',
                            textTransform: 'uppercase', letterSpacing: '0.05em',
                          }}>
                            {isSigned ? '✓ Signed' : 'Awaiting signature'}
                          </span>
                        </div>
                        {c.sub ? <div style={{ fontSize: '0.74rem', color: S500 }}>{c.sub}</div> : null}
                      </div>
                      <FullscreenSignaturePad
                        compact
                        label={`${c.name} Signature`}
                        value={cs[c.key] || null}
                        onChange={v => {
                          // Functional update — merge into the LATEST crew_signoff_sigs,
                          // not the render's fd closure, so two crew signing in quick
                          // succession can't clobber each other's signature.
                          setFd(p => ({ ...p, crew_signoff_sigs: { ...(p.crew_signoff_sigs || {}), [c.key]: v } }));
                          // Mirror crew 1 to the dedicated crew_signature column so it
                          // shows in the existing PDF crew strip.
                          if (c.key === 'c1') setSigs(p => ({ ...p, crew_signature: v }));
                          dirtyRef.current = true;
                        }}
                      />
                    </div>
                  );
                })}
                <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                  <button
                    type="button"
                    onClick={() => { setCrewSignOffOpen(false); submitInFlightRef.current = false; }}
                    style={{ flex: 1, padding: '12px 0', borderRadius: 10, fontWeight: 700, border: `2px solid ${S200}`, background: W, color: S600, cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    // Not DOM-disabled while awaiting signatures — Samsung
                    // Internet can leave a disabled button inert after the flag
                    // clears, stranding the crew on "can't submit". Always
                    // tappable; the all-signed check lives in the handler.
                    onClick={() => {
                      if (!allSigned) return;
                      setCrewSignOffOpen(false); submitInFlightRef.current = false; void handleSubmit();
                    }}
                    style={{
                      flex: 2, padding: '12px 0', borderRadius: 10, fontWeight: 800, border: 'none', color: W,
                      background: allSigned ? `linear-gradient(135deg,${ROSE},#be123c)` : S400,
                      cursor: allSigned ? 'pointer' : 'not-allowed',
                      transition: 'background 0.2s',
                    }}
                  >
                    {allSigned ? 'Confirm & Submit' : `${signedCount} / ${totalCount} Signed`}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Summary Review Modal (Swipeable Cards) ── */}
        {summaryReviewOpen && (() => {
          // Helper to extract non-empty fields
          const v = (key: string, label?: string) => {
            const val = fd[key];
            if (val === undefined || val === null || val === '') return null;
            return { label: label || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), value: String(val) };
          };

          type SummarySection = { title: string; items: { label: string; value: string }[] };

          // ── Card 1: Patient Information + Billing ──
          const card1Sections: SummarySection[] = [];
          const patient = [
            v('patient_name', 'First Name'), v('patient_surname', 'Surname'),
            v('gender', 'Gender'), v('patient_id_number', 'ID Number'),
            v('patient_passport_number', 'Passport Number'),
            v('patient_dob', 'Date of Birth'), v('age', 'Age'),
            v('patient_phone_cell', 'Cell Phone'), v('patient_phone_home', 'Home Phone'),
            v('patient_address', 'Address'), v('patient_suburb', 'Suburb'),
            v('patient_postal_code', 'Postal Code'),
          ].filter(Boolean) as { label: string; value: string }[];
          if (patient.length) card1Sections.push({ title: 'Patient Information', items: patient });

          const billing = [
            v('billing_type', 'Billing Type'),
            v('scheme_name', 'Medical Aid Scheme'), v('scheme_option', 'Plan / Option'),
            v('med_aid_number', 'Med Aid Number'), v('main_member_name', 'Main Member'),
            v('main_member_id', 'Main Member ID'), v('main_member_surname', 'Main Member Surname'),
            v('dependant_code', 'Dependant Code'), v('post_auth_number', 'Post-Auth Number'),
            v('pvt_payment_method', 'Payment Method'), v('pvt_amount_quoted', 'Amount Quoted'),
            v('pvt_account_holder', 'Account Holder'), v('pvt_account_holder_id', 'Account Holder ID'),
          ].filter(Boolean) as { label: string; value: string }[];
          if (billing.length) card1Sections.push({ title: 'Billing', items: billing });

          // ── Card 2: Dispatch & Scene ──
          const card2Sections: SummarySection[] = [];
          const dispatch = [
            v('call_type', 'Call Type'), v('transfer_subtype', 'Transfer Subtype'),
            v('preauth_number', 'Pre-Auth Number'), v('med_aid_quoted_amount', 'Quoted Amount'),
            v('rht_call_out_fee', 'RHT Call-Out Fee'),
          ].filter(Boolean) as { label: string; value: string }[];
          if (timestamps.time_dispatched) dispatch.push({ label: 'Dispatched', value: timestamps.time_dispatched });
          if (dispatch.length) card2Sections.push({ title: 'Dispatch & Mobilisation', items: dispatch });

          const scene = [
            v('incident_location', 'Incident Location'), v('suburb_ward', 'Suburb / Ward'),
            v('priority', 'Priority'),
          ].filter(Boolean) as { label: string; value: string }[];
          if (timestamps.time_on_scene) scene.push({ label: 'On Scene', value: timestamps.time_on_scene });
          if (scene.length) card2Sections.push({ title: 'Scene', items: scene });

          // ── Card 3: Clinical Notes ──
          const card3Sections: SummarySection[] = [];
          const clinical = [
            v('chief_complaint', 'Chief Complaint'), v('primary_diagnosis', 'Primary Diagnosis'),
            v('findings_on_arrival', 'Findings on Arrival'),
            v('allergies', 'Allergies'), v('current_medications', 'Current Medications'),
            v('past_medical_history', 'Past Medical History'),
            v('last_meal', 'Last Meal'), v('last_meal_time', 'Last Meal Time'),
            v('events_hpi', 'Events / HPI'), v('mechanism', 'Mechanism'),
          ].filter(Boolean) as { label: string; value: string }[];
          if (clinical.length) card3Sections.push({ title: 'Clinical Assessment', items: clinical });



          if (ivRows.length > 0) {
            const ivItems = ivRows.map((row: any, i: number) => {
              const parts: string[] = [];
              if (row.fluid) parts.push(row.fluid);
              if (row.volume) parts.push(`${row.volume}ml`);
              if (row.rate) parts.push(`${row.rate}ml/hr`);
              if (row.site) parts.push(`Site: ${row.site}`);
              return { label: `Line ${i + 1}`, value: parts.join(' · ') || 'No details' };
            });
            card3Sections.push({ title: 'IV Therapy', items: ivItems });
          }

          if (medRows.length > 0) {
            const medItems = medRows.map((row: any, i: number) => {
              const parts: string[] = [];
              if (row.drug) parts.push(row.drug);
              if (row.dose) parts.push(row.dose);
              if (row.route) parts.push(`Route: ${row.route}`);
              if (row.time) parts.push(`@ ${row.time}`);
              return { label: `Med ${i + 1}`, value: parts.join(' · ') || 'No details' };
            });
            card3Sections.push({ title: 'Medications', items: medItems });
          }

          const notes = [
            v('management_notes', 'Management Notes'), v('motivation_notes', 'Motivation'),
            v('vitals_shortfall_motivation', 'Vitals Shortfall Motivation'),
          ].filter(Boolean) as { label: string; value: string }[];
          if (notes.length) card3Sections.push({ title: 'Notes', items: notes });

          // ── Card 4: Handover ──
          const card4Sections: SummarySection[] = [];
          const transport: { label: string; value: string }[] = [];
          if (timestamps.time_depart_scene) transport.push({ label: 'Departed Scene', value: timestamps.time_depart_scene });
          if (timestamps.time_at_destination) transport.push({ label: 'At Destination', value: timestamps.time_at_destination });
          if (timestamps.time_available) transport.push({ label: 'Available', value: timestamps.time_available });
          if (transport.length) card4Sections.push({ title: 'Transport Times', items: transport });

          const handover = [
            v('handover_name', 'Handover To'), v('handover_doctor_email', 'Handover Email'),
            v('ward', 'Ward'), v('referring_doctor', 'Referring Doctor'),
            v('receiving_doctor', 'Receiving Doctor'),
          ].filter(Boolean) as { label: string; value: string }[];
          if (handover.length) card4Sections.push({ title: 'Handover', items: handover });

          // All 4 cards
          const cards = [
            { title: 'Patient & Billing', color: '#3b82f6', sections: card1Sections },
            { title: 'Dispatch & Scene', color: '#f59e0b', sections: card2Sections },
            { title: 'Clinical & Notes', color: '#10b981', sections: card3Sections },
            { title: 'Handover', color: '#8b5cf6', sections: card4Sections },
          ];

          // Render a section block
          const renderSection = (section: SummarySection, si: number) => (
            <div key={si} style={{ marginBottom: 14 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 0 6px', borderBottom: `1px solid ${S100}`,
              }}>
                <span style={{ fontSize: '0.76rem', fontWeight: 800, color: S800, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {section.title}
                </span>
              </div>
              {section.items.map((item, ii) => (
                <div key={ii} style={{
                  display: 'flex', flexDirection: 'column',
                  gap: 4, padding: '8px 2px',
                  borderBottom: ii < section.items.length - 1 ? `1px solid ${S50}` : 'none',
                  minWidth: 0, overflow: 'hidden',
                }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 600, color: S500, textTransform: 'uppercase' }}>
                    {item.label}
                  </div>
                  <div style={{
                    fontSize: '0.85rem', fontWeight: 700, color: S900,
                    wordBreak: 'break-word', overflowWrap: 'anywhere',
                    lineHeight: 1.4, minWidth: 0, maxWidth: '100%',
                    display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden'
                  }}>
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
          );

          // Swipeable carousel component (inline)
          const Carousel = () => {
            const [activeCard, setActiveCard] = useState(0);
            const touchStartX = useRef(0);
            const touchDeltaX = useRef(0);
            const containerRef = useRef<HTMLDivElement>(null);

            const goTo = (i: number) => setActiveCard(Math.max(0, Math.min(cards.length - 1, i)));

            const handleTouchStart = (e: React.TouchEvent) => {
              touchStartX.current = e.touches[0].clientX;
              touchDeltaX.current = 0;
            };
            const handleTouchMove = (e: React.TouchEvent) => {
              touchDeltaX.current = e.touches[0].clientX - touchStartX.current;
            };
            const handleTouchEnd = () => {
              if (Math.abs(touchDeltaX.current) > 50) {
                if (touchDeltaX.current < 0) goTo(activeCard + 1);
                else goTo(activeCard - 1);
              }
              touchDeltaX.current = 0;
            };

            return (
              <>
                {/* Card indicator dots + title */}
                <div style={{ padding: '14px 20px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ fontSize: '0.82rem', fontWeight: 800, color: cards[activeCard].color }}>
                    {activeCard + 1} / {cards.length} — {cards[activeCard].title}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {cards.map((card, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => goTo(i)}
                        style={{
                          width: i === activeCard ? 20 : 8, height: 8,
                          borderRadius: 99, border: 'none', cursor: 'pointer',
                          background: i === activeCard ? card.color : S200,
                          transition: 'all 0.3s ease',
                        }}
                      />
                    ))}
                  </div>
                </div>

                {/* Swipeable card area */}
                <div
                  ref={containerRef}
                  onTouchStart={handleTouchStart}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                  style={{
                    overflow: 'hidden', padding: '0 16px 8px',
                    minHeight: 280, minWidth: 0,
                  }}
                >
                  <div style={{
                    display: 'flex', transition: 'transform 0.35s cubic-bezier(0.4,0,0.2,1)',
                    transform: `translateX(-${activeCard * 100}%)`,
                    minWidth: 0,
                  }}>
                    {cards.map((card, ci) => (
                      <div key={ci} style={{
                        width: '100%', flexShrink: 0,
                        padding: '0 4px',
                        minWidth: 0, overflow: 'hidden',
                      }}>
                        <div style={{
                          background: W, borderRadius: 14,
                          border: `1.5px solid ${ci === activeCard ? card.color + '40' : S100}`,
                          padding: '14px 14px 10px',
                          maxHeight: '52vh', overflowY: 'auto', overflowX: 'hidden',
                          overscrollBehavior: 'contain',
                          boxShadow: ci === activeCard ? `0 4px 20px ${card.color}15` : 'none',
                          transition: 'border-color 0.3s, box-shadow 0.3s',
                          minWidth: 0,
                        }}>
                          {card.sections.length > 0 ? (
                            card.sections.map((s, si) => renderSection(s, si))
                          ) : (
                            <div style={{ textAlign: 'center', padding: '40px 0', color: S400, fontSize: '0.85rem' }}>
                              No data recorded for this section.
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Swipe hint (only on first card) */}
                {activeCard === 0 && (
                  <div style={{
                    textAlign: 'center', fontSize: '0.72rem', color: S400,
                    padding: '2px 0 6px', fontWeight: 600,
                  }}>
                    ← Swipe to review all cards →
                  </div>
                )}
              </>
            );
          };

          return (
            <div style={{
              position: 'fixed', inset: 0, zIndex: 9998,
              background: 'rgba(15,23,42,0.6)', backdropFilter: 'blur(4px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '16px 10px', overscrollBehavior: 'none',
            }}
              onClick={e => { if (e.target === e.currentTarget) { setSummaryReviewOpen(false); submitInFlightRef.current = false; } }}
            >
              <div style={{
                background: S50, borderRadius: 22, width: '100%', maxWidth: 440,
                boxShadow: '0 16px 56px rgba(0,0,0,0.3)', overflow: 'hidden',
                maxHeight: '90vh', display: 'flex', flexDirection: 'column',
                minWidth: 0,
              }}
                onClick={e => e.stopPropagation()}
              >
                {/* Header */}
                <div style={{
                  padding: '18px 20px 14px', borderBottom: `1px solid ${S100}`,
                  background: 'linear-gradient(135deg, #f0fdf4, #ecfdf5)',
                  flexShrink: 0,
                }}>
                  <div style={{ fontSize: '1.05rem', fontWeight: 900, color: S900, marginBottom: 3 }}>
                    Review Before Submitting
                  </div>
                  <div style={{ fontSize: '0.78rem', color: S600, lineHeight: 1.5 }}>
                    Swipe through each card to check for accuracy and spelling errors.
                  </div>
                </div>

                {/* Carousel */}
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <Carousel />
                </div>

                {/* Footer buttons */}
                <div style={{
                  padding: '12px 16px 16px', borderTop: `1px solid ${S100}`,
                  display: 'flex', gap: 10, background: S50, flexShrink: 0,
                }}>
                  <button
                    type="button"
                    onClick={() => { setSummaryReviewOpen(false); submitInFlightRef.current = false; }}
                    style={{
                      flex: 1, padding: '13px 0', borderRadius: 12, fontWeight: 700,
                      border: `2px solid ${S200}`, background: W, color: S600, cursor: 'pointer',
                      fontSize: '0.85rem',
                    }}
                  >
                    Go Back
                  </button>
                  <button
                    type="button"
                    onClick={() => { setSummaryReviewOpen(false); submitInFlightRef.current = false; void handleSubmit(); }}
                    style={{
                      flex: 2, padding: '13px 0', borderRadius: 12, fontWeight: 800,
                      border: 'none', color: W, fontSize: '0.85rem',
                      background: `linear-gradient(135deg, #16a34a, #15803d)`,
                      cursor: 'pointer', boxShadow: '0 4px 16px rgba(22,163,74,0.3)',
                    }}
                  >
                    ✓ Looks Good — Continue
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Floating quick-vitals button (clinical & transport phases) ── */}
        {(phase === 3 || phase === 4) && !quickVital && (
          <button type="button" onClick={() => setQV(true)} style={{ position: 'fixed', bottom: 90, right: 18, zIndex: 100, width: 56, height: 56, borderRadius: 28, background: `linear-gradient(135deg,${G},${GDK})`, border: 'none', color: W, fontSize: '0.65rem', fontWeight: 900, cursor: 'pointer', boxShadow: `0 4px 20px ${G}55`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, lineHeight: 1 }}>
            <span style={{ fontSize: '1.2rem', lineHeight: 1 }}>+</span>
            <span style={{ fontSize: '0.5rem', letterSpacing: '0.04em' }}>VITALS</span>
          </button>
        )}

        {/* ── Vitals reminder pill — interval driven by assessment_level
            (BLS 20m / ILS 15m / ALS 10m). Hidden on Complete phase. ── */}
        {phase < 6 && editVital < 0 && !quickVital && <VitalsReminder lastVitalAt={lastVitalAt} level={fd.assessment_level} onClick={jumpToVitals} />}

        {/* ── Quick vitals overlay ── */}
        {quickVital && (
          <QuickVitalsOverlay
            onClose={() => setQV(false)}
            onSave={v => { setVitals(p => [...p, v]); dirtyRef.current = true; setQV(false); }}
          />
        )}

        {/* ── Geo-capture confirmation overlay ── */}
        {pendingMark && (() => {
          const target = GEO_TARGET_FIELD[pendingMark.timeKey];
          const targetOccupied = !!(target && fd[target.addressKey] && String(fd[target.addressKey]).trim());
          return (
            <GeoConfirmOverlay
              label={ALL_TIME_ROWS.find(r => r.timeKey === pendingMark.timeKey)?.label || 'Timestamp'}
              capturing={pendingMark.capturing}
              coords={pendingMark.coords}
              error={pendingMark.error}
              geocoding={pendingMark.geocoding}
              address={pendingMark.address}
              geocodeError={pendingMark.geocodeError}
              targetFieldLabel={target?.label}
              targetFieldOccupied={targetOccupied}
              onCancel={() => setPendingMark(null)}
              onRecapture={() => markTime(pendingMark.timeKey, pendingMark.kmKey, pendingMark.onAfterCommit)}
              onConfirm={async (manualAddress?: string) => {
                const { timeKey, kmKey, coords, address, onAfterCommit } = pendingMark;
                setPendingMark(null);
                // Auto-fill the resolved address into the target field — but
                // only if the field is currently empty. The crew already saw
                // the address in the overlay; this is the "place into field
                // for review" step.
                // When GPS was unavailable, fall back to the manually typed address.
                const resolvedStreet = address?.street || manualAddress;
                const resolvedSuburb = address?.suburb || null;
                if (target && resolvedStreet && !targetOccupied) {
                  sf(target.addressKey, resolvedStreet);
                  if (target.suburbKey && resolvedSuburb && !fd[target.suburbKey]) {
                    sf(target.suburbKey, resolvedSuburb);
                  }
                }
                // Also seed the per-row address field shown in the time
                // table (one input per timestamp). If the crew already typed
                // a manual address in that row before tapping Mark Time,
                // don't overwrite it. On Scene's row is `incident_location`
                // itself (see TimeRow), which the target fill above already
                // handled — so we skip it here to avoid writing a dead field.
                const rowAddressKey = timeKey === 'time_on_scene' ? 'incident_location' : `address_${timeKey}`;
                if (resolvedStreet && !fd[rowAddressKey]) {
                  sf(rowAddressKey, resolvedStreet);
                }
                await commitMarkTime(timeKey, kmKey, coords);
                if (onAfterCommit) await onAfterCommit();
              }}
            />
          );
        })()}

        {/* ── Odometer plausibility confirm ──────────────────────────────────
           Fires when a KmInput blur produces a delta > 100 km from the
           previous reading, OR when the odometer rolls backwards. Passive
           prompt — the crew can confirm and carry on, or clear + re-enter.
           Never blocks Mark Time / phase advance, per the no-mid-call-
           validation rule. ─────────────────────────────────────────────── */}
        {kmConfirm && (() => {
          const rollback = kmConfirm.delta < 0;
          const close = () => setKmConfirm(null);
          const clearAndReenter = () => {
            setKms(prev => ({ ...prev, [kmConfirm.kmKey]: '' }));
            dirtyRef.current = true;
            setKmConfirm(null);
          };
          return ReactDOM.createPortal(
            <div
              onClick={close}
              style={{
                position: 'fixed', inset: 0, zIndex: 100000, padding: 16,
                background: 'rgba(15,23,42,0.55)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <div
                onClick={e => e.stopPropagation()}
                style={{
                  maxWidth: 460, width: '100%',
                  background: '#fff', borderRadius: 16, padding: 22,
                  boxShadow: '0 20px 60px rgba(15,23,42,0.35)',
                }}
              >
                <div style={{ fontWeight: 900, fontSize: '1.05rem', color: S900, marginBottom: 6 }}>
                  Confirm odometer reading
                </div>
                <div style={{ fontSize: '0.82rem', color: S700, marginBottom: 14, lineHeight: 1.5 }}>
                  {rollback
                    ? <>The reading you entered for <b>{kmConfirm.label}</b> is <b>lower</b> than the previous reading. Odometers don't go backwards — please double-check. If the KM entered is incorrect, please clear and re-enter. If it is correct, please confirm below.</>
                    : <>The distance between readings is unusually large. If the KM entered is incorrect, please clear and re-enter. If it is correct, please confirm below.</>}
                </div>
                <div style={{
                  background: GBG, border: `1.5px solid ${G}40`, borderRadius: 12,
                  padding: '12px 14px', marginBottom: 16, fontSize: '0.86rem',
                  color: S900,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ color: S600, fontWeight: 600 }}>{kmConfirm.previousLabel}</span>
                    <span style={{ fontFamily: 'monospace', fontWeight: 800 }}>{kmConfirm.previousValue.toLocaleString()} km</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ color: S600, fontWeight: 600 }}>{kmConfirm.label}</span>
                    <span style={{ fontFamily: 'monospace', fontWeight: 800 }}>{kmConfirm.newValue.toLocaleString()} km</span>
                  </div>
                  <div style={{
                    borderTop: `1px solid ${S200}`, paddingTop: 8, display: 'flex',
                    justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <span style={{ color: S600, fontSize: '0.74rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Difference</span>
                    <span style={{
                      fontFamily: 'monospace', fontWeight: 800,
                      color: kmConfirm.delta < 0 ? REDC : '#92400e',
                    }}>{kmConfirm.delta > 0 ? '+' : ''}{kmConfirm.delta.toLocaleString()} km</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => {
                      sf(kmConfirm.kmKey, '');
                      setKms(prev => ({ ...prev, [kmConfirm.kmKey]: '' }));
                      close();
                      setTimeout(() => {
                        if (kmConfirm.kmKey === 'km_dispatched') setDispatchPromptOpen(true);
                        if (kmConfirm.kmKey === 'km_on_scene') setOnScenePromptOpen(true);
                        if (kmConfirm.kmKey === 'km_depart_scene') {
                          if (!kms.km_depart_scene && kms.km_on_scene) {
                            handleKmChange('km_depart_scene', kms.km_on_scene);
                          }
                          setDepartPromptOpen(true);
                        }
                        if (kmConfirm.kmKey === 'km_at_destination') setDestinationPromptOpen(true);
                        setTimeout(() => document.getElementById(`input-${kmConfirm.kmKey}`)?.focus(), 50);
                      }, 10);
                    }}
                    style={{
                      flex: 1, padding: 12, borderRadius: 10,
                      border: `1.5px solid ${S200}`, background: '#fff', color: S700,
                      fontWeight: 800, fontSize: '0.86rem', cursor: 'pointer',
                    }}
                  >Clear &amp; re-enter</button>
                  <button
                    type="button"
                    onClick={() => {
                      // Persist acknowledgement into form_data so it survives save/reload
                      const existing = Array.isArray(fd.km_review_flags) ? fd.km_review_flags : [];
                      const newFlag = {
                        field: kmConfirm.kmKey,
                        prev_field: kmConfirm.previousKey,
                        delta: kmConfirm.delta,
                        acknowledged: true,
                        timestamp: new Date().toISOString(),
                      };
                      sf('km_review_flags', [...existing, newFlag]);
                      close();
                      if (kmConfirm.onConfirmCallback) kmConfirm.onConfirmCallback();
                    }}
                    style={{
                      flex: 1, padding: 12, borderRadius: 10,
                      border: 'none',
                      background: `linear-gradient(135deg, ${G}, ${GDK})`,
                      color: '#fff',
                      fontWeight: 800, fontSize: '0.86rem', cursor: 'pointer',
                    }}
                  >Yes, it's correct</button>
                </div>
              </div>
            </div>,
            document.body
          );
        })()}

        {/* ── Crew picker overlay ─────────────────────────────────────────────
           Opens for one of three flows:
             • IV Line  — pick administrator, then sign to confirm.
             • Medication — pick administrator, then sign to confirm.
             • Treating practitioner gate — pick who is treating the patient
               on entering the Clinical phase. Single-step; writes directly
               to `fd.treating_practitioner_*` for the scope-enforcement
               engine. No signing step (the act of picking is the audit).
           For IV / Medication, cancelling the signature returns to
           crew-select so the wrong crew member can be swapped without
           losing the overlay. ──────────────────────────────────────────── */}
        {crewPicker && crewPicker.phase === 'select' && (() => {
          const isTreating = crewPicker.kind === 'treating';
          const kindLabel = isTreating ? '' : crewPicker.kind === 'iv' ? 'IV Line' : 'Medication';
          const opts: Array<{ id: string; tag: string; name: string; qualification: string; hpcsa: string }> = [];
          const c1Name = prfMeta.crew_member_1?.full_name || profile.name || '';
          if (c1Name) opts.push({
            id: 'crew1', tag: 'Crew 1',
            name: c1Name,
            qualification: prfMeta.crew_member_1?.qualification || profile.qualification || '',
            hpcsa: prfMeta.crew_member_1?.hpcsa_number || profile.hpcsa_number || '',
          });
          const c2 = prfMeta.crew_member_2;
          if (c2?.full_name) opts.push({
            id: 'crew2', tag: 'Crew 2',
            name: c2.full_name,
            qualification: c2.qualification || '',
            hpcsa: c2.hpcsa_number || '',
          });
          if (Array.isArray(fd.extra_crew)) {
            fd.extra_crew.forEach((c: any, i: number) => {
              if (c.name || c.full_name) {
                opts.push({
                  id: `crew${i + 3}`, tag: `Crew ${i + 3}`,
                  name: c.name || c.full_name,
                  qualification: c.qualification || '',
                  hpcsa: c.hpcsa_number || '',
                });
              }
            });
          }

          const advance = (o: typeof opts[number]) => {
            if (crewPicker.kind === 'treating') {
              sf('treating_practitioner_name', o.name);
              sf('treating_practitioner_category', o.qualification);
              sf('treating_practitioner_hpcsa', o.hpcsa);
              setCrewPicker(null);
              return;
            }
            setCrewPicker({
              phase: 'signing',
              kind: crewPicker.kind,
              crew: { name: o.name, qualification: o.qualification, hpcsa: o.hpcsa },
            });
          };

          // Multi-select overlay for the treating-practitioner gate
          const TreatingPicker = () => {
            const getPreSelected = () => {
              try {
                const arr: Array<{name: string}> = fd.treating_practitioners_json
                  ? JSON.parse(fd.treating_practitioners_json as string)
                  : fd.treating_practitioner_name ? [{ name: fd.treating_practitioner_name }] : [];
                return new Set(opts.filter(o => arr.some(p => p.name === o.name)).map(o => o.id));
              } catch { return new Set<string>(); }
            };
            const [selected, setSelected] = useState<Set<string>>(getPreSelected);
            const toggle = (id: string) => setSelected(prev => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id); else next.add(id);
              return next;
            });
            const confirm = () => {
              const picked = opts.filter(o => selected.has(o.id));
              if (picked.length === 0) return;
              sf('treating_practitioner_name', picked[0].name);
              sf('treating_practitioner_category', picked[0].qualification);
              sf('treating_practitioner_hpcsa', picked[0].hpcsa);
              sf('treating_practitioners_json', JSON.stringify(
                picked.map(p => ({ name: p.name, qualification: p.qualification, hpcsa: p.hpcsa }))
              ));
              setCrewPicker(null);
              // Auto-open assessment modal — skip for DOD (no assessment needed)
              if (!fd.assessment_level && fd.call_type !== 'DOD') {
                setAssessmentModalOpen(true);
              }
            };
            return (
              <div style={{
                position: 'fixed', inset: 0, zIndex: 200, padding: 20,
                background: 'rgba(15,23,42,0.6)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                backdropFilter: 'blur(4px)',
              }}>
                <div onClick={e => e.stopPropagation()} style={{
                  maxWidth: 460, width: '100%', background: '#fff',
                  borderRadius: 20, overflow: 'hidden',
                  boxShadow: '0 24px 64px rgba(15,23,42,0.3)',
                }}>
                  {/* Header */}
                  <div style={{ padding: '22px 20px 8px' }}>
                    <div style={{ fontSize: '1.05rem', fontWeight: 900, color: S900, letterSpacing: '-0.01em', marginBottom: 4 }}>
                      Who is treating this patient?
                    </div>
                    {opts.length > 1 && (
                      <div style={{ fontSize: '0.78rem', color: S400 }}>
                        Select one or more crew members
                      </div>
                    )}
                  </div>

                  {/* Crew tiles */}
                  <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {opts.length === 0 ? (
                      <div style={{ padding: '14px 16px', background: '#fef2f2', border: `1.5px solid ${REDC}40`, borderRadius: 12, fontSize: '0.82rem', color: REDC }}>
                        No crew profile loaded. Open the PRF from your dashboard so Crew 1 / Crew 2 are set.
                      </div>
                    ) : opts.map(o => {
                      const isOn = selected.has(o.id);
                      const initials = o.name.split(' ').map((w: string) => w[0]).slice(0, 2).join('').toUpperCase();
                      return (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => toggle(o.id)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 14,
                            textAlign: 'left', cursor: 'pointer', width: '100%',
                            background: isOn ? '#fff' : '#f8fafc',
                            border: `1.5px solid ${isOn ? G : S200}`,
                            borderRadius: 14, padding: '13px 14px',
                            transition: 'all 0.15s ease',
                            boxShadow: isOn ? '0 2px 10px rgba(15,23,42,0.08)' : 'none',
                          }}
                        >
                          {/* Avatar circle */}
                          <div style={{
                            width: 42, height: 42, borderRadius: 21, flexShrink: 0,
                            background: isOn ? G : S200,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '0.88rem', fontWeight: 800, color: isOn ? '#fff' : S600,
                            transition: 'all 0.15s ease',
                          }}>
                            {initials}
                          </div>

                          {/* Name + badge row */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 700, fontSize: '0.92rem', color: S900, marginBottom: 3 }}>{o.name}</div>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              {o.qualification && (
                                <span style={{
                                  fontSize: '0.68rem', fontWeight: 700,
                                  color: isOn ? GDK : S600,
                                  background: isOn ? `${G}18` : S100,
                                  padding: '2px 7px', borderRadius: 5,
                                  textTransform: 'uppercase', letterSpacing: '0.05em',
                                }}>
                                  {o.qualification}
                                </span>
                              )}
                              {o.hpcsa && (
                                <span style={{ fontSize: '0.68rem', color: S400, fontFamily: 'monospace', alignSelf: 'center' }}>
                                  {o.hpcsa}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Checkbox */}
                          <div style={{
                            width: 22, height: 22, borderRadius: 11, flexShrink: 0,
                            border: `2px solid ${isOn ? G : S200}`,
                            background: isOn ? G : 'transparent',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            transition: 'all 0.15s ease',
                          }}>
                            {isOn && <span style={{ color: '#fff', fontSize: '0.72rem', fontWeight: 900, lineHeight: 1 }}>✓</span>}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* Footer */}
                  <div style={{ padding: '12px 20px 22px', display: 'flex', gap: 10 }}>
                    <button
                      type="button"
                      onClick={() => { setDismissedTreating(true); setCrewPicker(null); }}
                      style={{
                        flex: 1, padding: '12px 0', borderRadius: 12,
                        border: `1.5px solid ${S200}`, background: '#fff', color: S600,
                        fontWeight: 700, fontSize: '0.88rem', cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={confirm}
                      disabled={selected.size === 0}
                      style={{
                        flex: 2, padding: '12px 0', borderRadius: 12,
                        border: 'none',
                        background: selected.size > 0 ? `linear-gradient(135deg,${G},${GDK})` : S200,
                        color: selected.size > 0 ? '#fff' : S400,
                        fontWeight: 800, fontSize: '0.9rem',
                        cursor: selected.size > 0 ? 'pointer' : 'not-allowed',
                        boxShadow: selected.size > 0 ? `0 4px 14px ${G}35` : 'none',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      {selected.size === 0
                        ? 'Select a crew member'
                        : selected.size === 1
                        ? 'Confirm'
                        : `Confirm ${selected.size} members`}
                    </button>
                  </div>
                </div>
              </div>
            );
          };

          if (isTreating) return <TreatingPicker />;

          // Non-treating: single-pick overlay (IV / Med) ────────────────────
          return (
            <div
              onClick={() => setCrewPicker(null)}
              style={{
                position: 'fixed', inset: 0, zIndex: 200, padding: 20,
                background: 'rgba(15,23,42,0.6)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                backdropFilter: 'blur(4px)',
              }}
            >
              <div onClick={e => e.stopPropagation()} style={{
                maxWidth: 460, width: '100%', background: '#fff',
                borderRadius: 20, overflow: 'hidden',
                boxShadow: '0 24px 64px rgba(15,23,42,0.3)',
              }}>
                <div style={{ padding: '22px 20px 8px' }}>
                  <div style={{ fontSize: '1.05rem', fontWeight: 900, color: S900, letterSpacing: '-0.01em', marginBottom: 4 }}>
                    {`Who is administering this ${kindLabel}?`}
                  </div>
                  <div style={{ fontSize: '0.78rem', color: S400 }}>
                    They will be asked to sign on the next step to verify.
                  </div>
                </div>

                <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {opts.length === 0 ? (
                    <div style={{ padding: '14px 16px', background: '#fef2f2', border: `1.5px solid ${REDC}40`, borderRadius: 12, fontSize: '0.82rem', color: REDC }}>
                      No crew profile loaded. Open the PRF from your dashboard so Crew 1 / Crew 2 are set.
                    </div>
                  ) : opts.map(o => {
                    const initials = o.name.split(' ').map((w: string) => w[0]).slice(0, 2).join('').toUpperCase();
                    return (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => advance(o)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 14,
                          textAlign: 'left', cursor: 'pointer', width: '100%',
                          background: '#f8fafc', border: `1.5px solid ${S200}`,
                          borderRadius: 14, padding: '13px 14px',
                          transition: 'background 0.15s ease',
                        }}
                      >
                        <div style={{
                          width: 42, height: 42, borderRadius: 21, flexShrink: 0,
                          background: S200,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '0.88rem', fontWeight: 800, color: S600,
                        }}>
                          {initials}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: '0.92rem', color: S900, marginBottom: 3 }}>{o.name}</div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {o.qualification && (
                              <span style={{
                                fontSize: '0.68rem', fontWeight: 700, color: S600,
                                background: S100, padding: '2px 7px', borderRadius: 5,
                                textTransform: 'uppercase', letterSpacing: '0.05em',
                              }}>
                                {o.qualification}
                              </span>
                            )}
                            {o.hpcsa && (
                              <span style={{ fontSize: '0.68rem', color: S400, fontFamily: 'monospace', alignSelf: 'center' }}>
                                {o.hpcsa}
                              </span>
                            )}
                          </div>
                        </div>
                        <span style={{ color: S400, fontSize: '1.1rem', fontWeight: 300 }}>›</span>
                      </button>
                    );
                  })}
                </div>

                <div style={{ padding: '12px 20px 22px' }}>
                  <button
                    type="button"
                    onClick={() => setCrewPicker(null)}
                    style={{
                      width: '100%', padding: '12px 0', borderRadius: 12,
                      border: `1.5px solid ${S200}`, background: '#fff', color: S600,
                      fontWeight: 700, fontSize: '0.88rem', cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Step 2 of the administrator-verification flow: the picked crew
          member signs on a fullscreen canvas. On save, the new row is
          appended with name/qualification/HPCSA/signature all set. Cancel
          drops back to crew-select so they can pick a different name. */}
        {crewPicker && crewPicker.phase === 'signing' && (
          <FullscreenCanvas
            label={`${crewPicker.crew.name} — sign to confirm administering this ${crewPicker.kind === 'iv' ? 'IV Line' : 'Medication'}`}
            initial={null}
            onCancel={() => setCrewPicker({ phase: 'select', kind: crewPicker.kind })}
            onSave={(b64) => {
              const { crew, kind } = crewPicker;
              const newRow: Record<string, string> = {
                administered_by: crew.name,
                administered_by_qualification: crew.qualification,
                administered_by_hpcsa: crew.hpcsa,
                sign: b64,
              };
              if (kind === 'iv') {
                setIvRows([...ivRows, newRow]);
              } else {
                if (tempMedReason) {
                  newRow.reason = tempMedReason;
                }
                setMedRows([...medRows, newRow]);
                setTempMedReason(null);
              }
              dirtyRef.current = true;
              setCrewPicker(null);
            }}
          />
        )}

        {/* ── Inline scrub feedback (blockers + warnings) ── */}
        {(scrubBlockers.length > 0 || scrubWarnings.length > 0) && (
          <div style={{
            position: 'fixed', bottom: 80, left: 0, right: 0, zIndex: 41,
            padding: '0 14px',
          }}>
            <div style={{
              maxWidth: 640, margin: '0 auto',
              background: '#fff', border: `2px solid ${scrubBlockers.length > 0 ? REDC : AMB}`,
              borderRadius: 12, padding: '12px 14px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
              maxHeight: '40vh', overflowY: 'auto',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                marginBottom: 8,
              }}>
                <div style={{
                  fontSize: '0.78rem', fontWeight: 900,
                  color: scrubBlockers.length > 0 ? REDC : '#92400e',
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                }}>
                  {scrubBlockers.length > 0
                    ? `Cannot continue — ${scrubBlockers.length} ${scrubBlockers.length === 1 ? 'issue' : 'issues'} to fix`
                    : `${scrubWarnings.length} warning${scrubWarnings.length === 1 ? '' : 's'}`}
                </div>
                <button
                  type="button"
                  onClick={() => { setScrubBlockers([]); setScrubWarnings([]); }}
                  style={{
                    background: 'none', border: 'none', color: S600,
                    fontSize: '1.1rem', fontWeight: 700, cursor: 'pointer',
                    padding: '0 6px', lineHeight: 1,
                  }}>×</button>
              </div>
              {scrubBlockers.map((b, i) => (
                <div key={`b-${i}`} style={{
                  display: 'flex', gap: 10, padding: '8px 0',
                  borderTop: i > 0 ? `1px solid ${S200}` : 'none',
                }}>
                  <span style={{
                    fontSize: '0.65rem', fontWeight: 800, color: '#fff',
                    background: REDC, padding: '2px 7px', borderRadius: 4,
                    textTransform: 'uppercase', letterSpacing: '0.05em',
                    flexShrink: 0, alignSelf: 'flex-start', marginTop: 2,
                  }}>{b.severity}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.82rem', fontWeight: 700, color: S900 }}>{b.rule}</div>
                    <div style={{ fontSize: '0.78rem', color: S600, marginTop: 2 }}>{b.reason}</div>
                  </div>
                </div>
              ))}
              {scrubWarnings.map((w, i) => (
                <div key={`w-${i}`} style={{
                  display: 'flex', gap: 10, padding: '8px 0',
                  borderTop: (scrubBlockers.length + i) > 0 ? `1px solid ${S200}` : 'none',
                }}>
                  <span style={{
                    fontSize: '0.65rem', fontWeight: 800, color: '#fff',
                    background: AMB, padding: '2px 7px', borderRadius: 4,
                    textTransform: 'uppercase', letterSpacing: '0.05em',
                    flexShrink: 0, alignSelf: 'flex-start', marginTop: 2,
                  }}>{w.severity}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.82rem', fontWeight: 700, color: S900 }}>{w.rule}</div>
                    <div style={{ fontSize: '0.78rem', color: S600, marginTop: 2 }}>{w.reason}</div>
                  </div>
                </div>
              ))}
              {scrubBlockers.length > 0 && (
                <div style={{
                  marginTop: 10, padding: '8px 10px',
                  background: '#fef2f2', borderRadius: 8,
                  fontSize: '0.74rem', color: '#7f1d1d',
                }}>
                  Fix the items above, then tap <strong>Save & Continue</strong> again.
                </div>
              )}
            </div>
          </div>
        )}



        {/* ── IFT/IHT Quoted Payout Amount Overlay ── */}
        <Modal open={quotedAmountModalOpen} onClose={() => setQuotedAmountModalOpen(false)}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: '1.2rem', fontWeight: 900, color: S900, letterSpacing: '-0.02em' }}>Quoted Payout Amount</div>
              <button type="button" onClick={() => setQuotedAmountModalOpen(false)} style={{ width: 32, height: 32, borderRadius: 16, border: 'none', background: S200, color: S600, fontSize: '1.2rem', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', touchAction: 'manipulation' }}>×</button>
            </div>
            <div style={{ marginBottom: 14 }}>
              <Lbl t="Quoted Payout Amount (R)" />
              <input
                ref={quotedAmountRef}
                type="text"
                inputMode="decimal"
                pattern="[0-9. ]*"
                value={fd.med_aid_quoted_amount ?? ''}
                onChange={e => {
                  const val = e.target.value.replace(/[^0-9.]/g, '');
                  sf('med_aid_quoted_amount', val);
                }}
                onFocus={onF}
                onBlur={onB}
                placeholder="0.00"
                style={{ ...base, marginBottom: 0, borderColor: '#e2e8f0' }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button
              type="button"
              onClick={() => {
                setQuotedAmountModalOpen(false);
                setPreauthVisible(true);
                setPreauthModalOpen(true);
                preauthRef.current?.focus();
              }}
              style={{
                padding: '12px 24px', borderRadius: 12, fontSize: '0.9rem',
                fontWeight: 800, border: 'none', background: G, color: W,
                cursor: 'pointer', boxShadow: `0 4px 12px ${G}40`,
                touchAction: 'manipulation',
                width: '100%', textAlign: 'center'
              }}
            >
              Next →
            </button>
          </div>
        </Modal>

        {/* ── IFT/IHT Pre-Auth No. Overlay ── */}
        <Modal open={preauthModalOpen} onClose={() => setPreauthModalOpen(false)}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: '1.2rem', fontWeight: 900, color: S900, letterSpacing: '-0.02em' }}>Pre-Auth Number</div>
              <button type="button" onClick={() => setPreauthModalOpen(false)} style={{ width: 32, height: 32, borderRadius: 16, border: 'none', background: S200, color: S600, fontSize: '1.2rem', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', touchAction: 'manipulation' }}>×</button>
            </div>
            <div style={{ marginBottom: 14 }}>
              <Lbl t="Pre-Auth No." req />
              <input
                ref={preauthRef}
                type="text"
                value={fd.preauth_number ?? ''}
                onChange={e => sf('preauth_number', e.target.value)}
                onFocus={onF}
                onBlur={onB}
                placeholder="Pre-authorisation reference"
                style={{ ...base, marginBottom: 12, borderColor: '#e2e8f0' }}
              />
              <div style={{ fontSize: '0.78rem', color: S600, fontWeight: 500 }}>
                Enter the medical aid pre-authorisation reference number.
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button
              type="button"
              onClick={() => {
                setPreauthModalOpen(false);
                setDispatchPromptOpen(true);
                dispatchKmRef.current?.focus();
              }}
              style={{
                padding: '12px 24px', borderRadius: 12, fontSize: '0.9rem',
                fontWeight: 800, border: 'none', background: G, color: W,
                cursor: 'pointer', boxShadow: `0 4px 12px ${G}40`,
                touchAction: 'manipulation',
                width: '100%', textAlign: 'center'
              }}
            >
              Done →
            </button>
          </div>
        </Modal>

        {/* ── Dispatch Time & Location/KM Prompt Overlay ── */}
        <Modal open={dispatchPromptOpen} onClose={() => setDispatchPromptOpen(false)} dismissOnBackdrop={false}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: '1.2rem', fontWeight: 900, color: S900, letterSpacing: '-0.02em' }}>Dispatch Information</div>
              <button type="button" onClick={() => setDispatchPromptOpen(false)} style={{ width: 32, height: 32, borderRadius: 16, border: 'none', background: S200, color: S600, fontSize: '1.2rem', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', touchAction: 'manipulation' }}>×</button>
            </div>
            <div style={{ marginBottom: 18 }}>
              <Lbl t="Starting Odometer (KM)" req />
              <input
                id="input-km_dispatched"
                ref={dispatchKmRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                {...NO_AUTOFILL}
                name={`nf-km_dispatched-${NF_NONCE}`}
                value={kms.km_dispatched ?? ''}
                onChange={e => handleKmChange('km_dispatched', e.target.value.replace(/[^0-9.]/g, ''))}
                onFocus={onF}
                onBlur={e => {
                  onB(e);
                  handleKmCommit('km_dispatched', e.target.value.replace(/[^0-9.]/g, ''));
                }}
                placeholder="e.g. 14250"
                style={{ ...base, marginBottom: 12, borderColor: '#e2e8f0' }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button
              type="button"
              onClick={() => setDispatchPromptOpen(false)}
              style={{
                flex: 1, padding: '12px 16px', borderRadius: 12, fontSize: '0.9rem',
                fontWeight: 800, border: `1.5px solid ${S200}`, background: W, color: S700,
                cursor: 'pointer', touchAction: 'manipulation', textAlign: 'center'
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                const runMarkTime = () => markTime('time_dispatched', 'km_dispatched', () => setEnRouteOverlay(true));
                const hasError = handleKmCommit('km_dispatched', kms.km_dispatched || '', runMarkTime);
                setDispatchPromptOpen(false);
                if (hasError) return;
                runMarkTime();
              }}
              style={{
                flex: 2, padding: '12px 24px', borderRadius: 12, fontSize: '0.9rem',
                fontWeight: 800, border: 'none', background: G, color: W,
                cursor: 'pointer', boxShadow: `0 4px 12px ${G}40`,
                touchAction: 'manipulation', textAlign: 'center'
              }}
            >
              Start Route
            </button>
          </div>
        </Modal>

        {/* ── Arrive On Scene Time & Location/KM Prompt Overlay ── */}
        <Modal open={onScenePromptOpen} onClose={() => setOnScenePromptOpen(false)} dismissOnBackdrop={false}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: '1.2rem', fontWeight: 900, color: S900, letterSpacing: '-0.02em' }}>Arrival Information</div>
              <button type="button" onClick={() => setOnScenePromptOpen(false)} style={{ width: 32, height: 32, borderRadius: 16, border: 'none', background: S200, color: S600, fontSize: '1.2rem', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', touchAction: 'manipulation' }}>×</button>
            </div>
            <div style={{ marginBottom: 18 }}>
              <Lbl t="Arrival Odometer (KM)" req />
              <input
                id="input-km_on_scene"
                ref={onSceneKmRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={kms.km_on_scene ?? ''}
                onChange={e => handleKmChange('km_on_scene', e.target.value.replace(/[^0-9.]/g, ''))}
                onFocus={onF}
                onBlur={e => {
                  onB(e);
                  handleKmCommit('km_on_scene', e.target.value.replace(/[^0-9.]/g, ''));
                }}
                placeholder="e.g. 14265"
                style={{ ...base, marginBottom: 12, borderColor: '#e2e8f0' }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button
              type="button"
              onClick={() => {
                setOnScenePromptOpen(false);
                setEnRouteOverlay(true);
              }}
              style={{
                flex: 1, padding: '12px 16px', borderRadius: 12, fontSize: '0.9rem',
                fontWeight: 800, border: `1.5px solid ${S200}`, background: W, color: S700,
                cursor: 'pointer', touchAction: 'manipulation', textAlign: 'center'
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                const runMarkTime = () => markTime('time_on_scene', 'km_on_scene');
                const hasError = handleKmCommit('km_on_scene', kms.km_on_scene || '', runMarkTime);
                setOnScenePromptOpen(false);
                if (hasError) return;
                runMarkTime();
                // The scroll to the Start Examination button is handled by the
                // effect keyed on On Scene time+km being captured (see the
                // "Start Examination" scroll effect near the top of the
                // component). Keying it on the captured state — not this tap —
                // makes it robust to GPS capture delaying the button's render.
              }}
              style={{
                flex: 2, padding: '12px 24px', borderRadius: 12, fontSize: '0.9rem',
                fontWeight: 800, border: 'none', background: G, color: W,
                cursor: 'pointer', boxShadow: `0 4px 12px ${G}40`,
                touchAction: 'manipulation', textAlign: 'center'
              }}
            >
              Confirm Arrival
            </button>
          </div>
        </Modal>

        {/* ── Depart Scene Time & Location/KM Prompt Overlay ── */}
        <Modal open={departPromptOpen} onClose={() => setDepartPromptOpen(false)} dismissOnBackdrop={false}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: '1.2rem', fontWeight: 900, color: S900, letterSpacing: '-0.02em' }}>Depart Information</div>
              <button type="button" onClick={() => setDepartPromptOpen(false)} style={{ width: 32, height: 32, borderRadius: 16, border: 'none', background: S200, color: S600, fontSize: '1.2rem', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', touchAction: 'manipulation' }}>×</button>
            </div>
            <div style={{ marginBottom: 18 }}>
              <Lbl t="Depart Odometer (KM)" req />
              <input
                id="input-km_depart_scene"
                ref={departKmRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={kms.km_depart_scene ?? ''}
                onChange={e => handleKmChange('km_depart_scene', e.target.value.replace(/[^0-9.]/g, ''))}
                onFocus={onF}
                onBlur={e => {
                  onB(e);
                  handleKmCommit('km_depart_scene', e.target.value.replace(/[^0-9.]/g, ''));
                }}
                placeholder="e.g. 14270"
                style={{ ...base, marginBottom: 12, borderColor: '#e2e8f0' }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button
              type="button"
              onClick={() => {
                setDepartPromptOpen(false);
              }}
              style={{
                flex: 1, padding: '12px 16px', borderRadius: 12, fontSize: '0.9rem',
                fontWeight: 800, border: `1.5px solid ${S200}`, background: W, color: S700,
                cursor: 'pointer', touchAction: 'manipulation', textAlign: 'center'
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                // time_depart_scene always advances to phase 4 (Transport)
                const runMarkTime = () => markTime('time_depart_scene', 'km_depart_scene', async () => {
                  await doSave();
                  setPhase(4);
                });
                const hasError = handleKmCommit('km_depart_scene', kms.km_depart_scene || '', runMarkTime);
                setDepartPromptOpen(false);
                if (hasError) return;
                runMarkTime();
              }}
              style={{
                flex: 2, padding: '12px 24px', borderRadius: 12, fontSize: '0.9rem',
                fontWeight: 800, border: 'none', background: G, color: W,
                cursor: 'pointer', boxShadow: `0 4px 12px ${G}40`,
                touchAction: 'manipulation', textAlign: 'center'
              }}
            >
              Confirm Depart
            </button>
          </div>
        </Modal>

        {/* ── Arrival At Facility Time & Location/KM Prompt Overlay ── */}
        <Modal open={destinationPromptOpen} onClose={() => setDestinationPromptOpen(false)} dismissOnBackdrop={false}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: '1.2rem', fontWeight: 900, color: S900, letterSpacing: '-0.02em' }}>Arrival At Facility</div>
              <button type="button" onClick={() => setDestinationPromptOpen(false)} style={{ width: 32, height: 32, borderRadius: 16, border: 'none', background: S200, color: S600, fontSize: '1.2rem', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', touchAction: 'manipulation' }}>×</button>
            </div>
            <div style={{ marginBottom: 18 }}>
              <Lbl t="Arrival Odometer (KM)" req />
              <input
                id="input-km_at_destination"
                ref={destinationKmRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={kms.km_at_destination ?? ''}
                onChange={e => handleKmChange('km_at_destination', e.target.value.replace(/[^0-9.]/g, ''))}
                onFocus={onF}
                onBlur={e => {
                  onB(e);
                  handleKmCommit('km_at_destination', e.target.value.replace(/[^0-9.]/g, ''));
                }}
                placeholder="e.g. 14285"
                style={{ ...base, marginBottom: 12, borderColor: '#e2e8f0' }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button
              type="button"
              onClick={() => {
                setDestinationPromptOpen(false);
              }}
              style={{
                flex: 1, padding: '12px 16px', borderRadius: 12, fontSize: '0.9rem',
                fontWeight: 800, border: `1.5px solid ${S200}`, background: W, color: S700,
                cursor: 'pointer', touchAction: 'manipulation', textAlign: 'center'
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                // time_at_destination always advances to phase 5 (Handover)
                const runMarkTime = () => markTime('time_at_destination', 'km_at_destination', async () => {
                  await doSave();
                  setPhase(5);
                });
                const hasError = handleKmCommit('km_at_destination', kms.km_at_destination || '', runMarkTime);
                setDestinationPromptOpen(false);
                if (hasError) return;
                runMarkTime();
              }}
              style={{
                flex: 2, padding: '12px 24px', borderRadius: 12, fontSize: '0.9rem',
                fontWeight: 800, border: 'none', background: G, color: W,
                cursor: 'pointer', boxShadow: `0 4px 12px ${G}40`,
                touchAction: 'manipulation', textAlign: 'center'
              }}
            >
              Confirm Arrival
            </button>
          </div>
        </Modal>

        <Modal open={rhtCallOutFeeOpen} onClose={() => setRhtCallOutFeeOpen(false)}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <div style={{ fontSize: '1.2rem', fontWeight: 900, color: S900, letterSpacing: '-0.02em' }}>Call Out Fee</div>
            <button type="button" onClick={() => setRhtCallOutFeeOpen(false)} style={{ width: 32, height: 32, borderRadius: 16, border: 'none', background: S200, color: S600, fontSize: '1.2rem', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', touchAction: 'manipulation' }}>×</button>
          </div>
          <div style={{ overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
            {['Standard', 'After Hours', 'Public Holiday', 'Standby Cancellation', 'No Patient Loaded', 'None'].map(reason => {
              const on = fd.rht_call_out_fee === reason;
              return (
                <button
                  key={reason}
                  type="button"
                  onClick={() => { 
                    sf('rht_call_out_fee', reason); 
                    setRhtCallOutFeeOpen(false); 
                    setDispatchPromptOpen(true);
                    window.setTimeout(() => dispatchKmRef.current?.focus(), 50);
                  }}
                  style={{
                    padding: '16px 12px', borderRadius: 12, fontSize: '0.88rem', fontWeight: 800,
                    border: `2px solid ${on ? G : S200}`, background: on ? G : W, color: on ? W : S700,
                    cursor: 'pointer', textAlign: 'center', transition: 'all 0.15s',
                    boxShadow: on ? `0 4px 12px ${G}40` : '0 2px 4px rgba(0,0,0,0.02)',
                    touchAction: 'manipulation',
                  }}
                >
                  {reason}
                </button>
              );
            })}
          </div>
        </Modal>

        {/* ── Assessment Level Modal ──────────────────────────────────────────
            Auto-opens after treating practitioner is confirmed (if not yet set).
            Can also be re-opened by tapping "Change" in the assessment chip.
            BLS / ILS / ALS selection only — no other options. ────────────── */}
        {assessmentModalOpen && (() => {
          const LEVELS = fd.call_type === 'RESUS' ? (['ILS', 'ALS'] as const) : (['BLS', 'ILS', 'ALS'] as const);
          return (
            <Modal open={true} onClose={() => setAssessmentModalOpen(false)} centerOnMobile>
              <div style={{ padding: '0 4px 0px', borderBottom: `1px solid ${S100}`, marginBottom: 14, textAlign: 'center' }}>
                <div style={{ fontSize: '1.1rem', fontWeight: 900, color: S900, letterSpacing: '-0.01em' }}>
                  Assessment Level
                </div>
                <div style={{ fontSize: '0.78rem', color: S400, marginTop: 3, marginBottom: 12 }}>
                  Select the level at which this patient is being assessed
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {LEVELS.map(lvl => {
                  const isOn = fd.assessment_level === lvl;
                  return (
                    <button
                      key={lvl}
                      type="button"
                      onClick={() => {
                        sf('assessment_level', lvl);
                        setAssessmentModalOpen(false);
                        setTimeout(() => chiefComplaintRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 14,
                        textAlign: 'left', cursor: 'pointer', width: '100%',
                        background: isOn ? '#f0fdf4' : S50,
                        border: `1.5px solid ${isOn ? G : S200}`,
                        borderRadius: 14, padding: '13px 14px',
                        transition: 'all 0.15s ease',
                        boxShadow: isOn ? `0 2px 10px ${G}25` : 'none',
                        touchAction: 'manipulation',
                      }}
                    >
                      {/* Left spacer balances the checkbox so the level label sits truly centred */}
                      <div style={{ width: 22, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0, textAlign: 'center', fontWeight: 800, fontSize: '0.96rem', color: isOn ? GDK : S900 }}>{lvl}</div>
                      <div style={{
                        width: 22, height: 22, borderRadius: 11, flexShrink: 0,
                        border: `2px solid ${isOn ? G : S200}`,
                        background: isOn ? G : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'all 0.15s ease',
                      }}>
                        {isOn && <span style={{ color: '#fff', fontSize: '0.72rem', fontWeight: 900, lineHeight: 1 }}>✓</span>}
                      </div>
                    </button>
                  );
                })}
              </div>

              {fd.assessment_level && (
                <div style={{ marginTop: 14 }}>
                  <button
                    type="button"
                    onClick={() => setAssessmentModalOpen(false)}
                    style={{
                      width: '100%', padding: '11px 0', borderRadius: 12,
                      border: `1.5px solid ${S200}`, background: '#fff', color: S600,
                      fontWeight: 700, fontSize: '0.88rem', cursor: 'pointer',
                      touchAction: 'manipulation',
                    }}
                  >Cancel</button>
                </div>
              )}
            </Modal>
          );
        })()}

        {/* ── Monitoring Level Modal ──────────────────────────────────────────
            Intercepts "Patient Information →" CTA if monitoring level not yet set.
            Shows upgrade / downgrade warning when level differs from assessment. ── */}
        {monitoringModalOpen && (() => {
          const LEVELS = fd.call_type === 'RESUS' ? (['ILS', 'ALS'] as const) : (['BLS', 'ILS', 'ALS'] as const);
          type Level = typeof LEVELS[number];
          const DESC: Record<Level, string> = {
            BLS: 'Basic Life Support — ongoing care & transport',
            ILS: 'Intermediate Life Support — monitored transport',
            ALS: 'Advanced Life Support — critical monitoring en route',
          };
          const RANK: Record<string, number> = { BLS: 0, ILS: 1, ALS: 2 };
          const assessRank = RANK[fd.assessment_level ?? ''];
          const monRank = RANK[fd.monitoring_level ?? ''];
          const hasMismatch = fd.monitoring_level && fd.assessment_level && monRank !== assessRank;
          const isUpgrade = hasMismatch && monRank > assessRank;

          return (
            <Modal open={true} onClose={() => setMonitoringModalOpen(false)}>
              <div style={{ padding: '0 4px 0px', borderBottom: `1px solid ${S100}`, marginBottom: 14 }}>
                <div style={{ fontSize: '1.1rem', fontWeight: 900, color: S900, letterSpacing: '-0.01em' }}>
                  Monitoring Level
                </div>
                <div style={{ fontSize: '0.78rem', color: S400, marginTop: 3, marginBottom: 12 }}>
                  Level of care monitored during transport
                  {fd.assessment_level && (
                    <span style={{ marginLeft: 4 }}>
                      · Assessed at <b style={{ color: S700 }}>{fd.assessment_level}</b>
                    </span>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {LEVELS.map(lvl => {
                  const isOn = fd.monitoring_level === lvl;
                  return (
                    <button
                      key={lvl}
                      type="button"
                      onClick={() => sf('monitoring_level', lvl)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 14,
                        textAlign: 'left', cursor: 'pointer', width: '100%',
                        background: isOn ? '#f0fdf4' : S50,
                        border: `1.5px solid ${isOn ? G : S200}`,
                        borderRadius: 14, padding: '13px 14px',
                        transition: 'all 0.15s ease',
                        boxShadow: isOn ? `0 2px 10px ${G}25` : 'none',
                        touchAction: 'manipulation',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontWeight: 800, fontSize: '0.96rem', color: isOn ? GDK : S900 }}>{lvl}</span>
                        </div>
                        <div style={{ fontSize: '0.72rem', color: isOn ? GDK : S400, marginTop: 2, lineHeight: 1.4 }}>{DESC[lvl]}</div>
                      </div>
                      <div style={{
                        width: 22, height: 22, borderRadius: 11, flexShrink: 0,
                        border: `2px solid ${isOn ? G : S200}`,
                        background: isOn ? G : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'all 0.15s ease',
                      }}>
                        {isOn && <span style={{ color: '#fff', fontSize: '0.72rem', fontWeight: 900, lineHeight: 1 }}>✓</span>}
                      </div>
                    </button>
                  );
                })}
              </div>

              {hasMismatch && (
                <div style={{
                  marginTop: 12,
                  padding: '12px 14px', borderRadius: 12,
                  border: `1.5px solid ${S200}`,
                  background: S50,
                  color: S700,
                  fontSize: '0.8rem', fontWeight: 600, lineHeight: 1.5,
                  display: 'flex', gap: 8, alignItems: 'flex-start',
                }}>
                  <span style={{ fontSize: '1rem', flexShrink: 0, color: S400 }}>{isUpgrade ? '↑' : '↓'}</span>
                  <span>
                    {isUpgrade
                      ? <><b style={{ color: S900 }}>Upgrade required.</b> Monitoring ({fd.monitoring_level}) exceeds the assessed level ({fd.assessment_level}). Notify dispatch to upgrade this call to {fd.monitoring_level}.</>
                      : <><b style={{ color: S900 }}>Downgrade required.</b> Monitoring ({fd.monitoring_level}) is below the assessed level ({fd.assessment_level}). Notify dispatch to downgrade this call to {fd.monitoring_level}.</>
                    }
                  </span>
                </div>
              )}

              <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                <button
                  type="button"
                  onClick={() => setMonitoringModalOpen(false)}
                  style={{
                    flex: 1, padding: '11px 0', borderRadius: 12,
                    border: `1.5px solid ${S200}`, background: '#fff', color: S600,
                    fontWeight: 700, fontSize: '0.88rem', cursor: 'pointer',
                    touchAction: 'manipulation',
                  }}
                >Cancel</button>
                <button
                  type="button"
                  disabled={!fd.monitoring_level}
                  onClick={() => {
                    setMonitoringModalOpen(false);
                    advancePhase(2);
                  }}
                  style={{
                    flex: 2, padding: '11px 0', borderRadius: 12, border: 'none',
                    background: fd.monitoring_level ? `linear-gradient(135deg,${G},${GDK})` : S200,
                    color: fd.monitoring_level ? '#fff' : S400,
                    fontWeight: 800, fontSize: '0.9rem',
                    cursor: fd.monitoring_level ? 'pointer' : 'not-allowed',
                    boxShadow: fd.monitoring_level ? `0 4px 14px ${G}35` : 'none',
                    transition: 'all 0.15s ease',
                    touchAction: 'manipulation',
                  }}
                >
                  {fd.monitoring_level ? 'Continue →' : 'Select a level'}
                </button>
              </div>
            </Modal>
          );
        })()}

        {wcaPromptOpen && wcaDocKey && (() => {
          const doc = [
            { key: 'wca_oar_report_pdf', label: 'WCA Document (PDF)' },
            { key: 'wca_employee_id_pdf', label: 'Employee ID (PDF)' },
            { key: 'wca_payslip_pdf', label: 'Payslip (PDF)' },
            { key: 'wca_medical_report_pdf', label: 'Medical Report (PDF)' },
          ].find(d => d.key === wcaDocKey);
          if (!doc) return null;
          return (
            <Modal open={true} onClose={() => { setWcaPromptOpen(false); setWcaDocKey(null); }}>
              <div style={{ padding: '0 4px 0px', borderBottom: `1px solid ${S100}`, marginBottom: 14 }}>
                <div style={{ fontSize: '1.1rem', fontWeight: 900, color: S900, letterSpacing: '-0.01em' }}>
                  Attach {doc.label}
                </div>
                <div style={{ fontSize: '0.78rem', color: S400, marginTop: 3, marginBottom: 12 }}>
                  Select how you would like to upload this document
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {/* Option 1: Take Photo */}
                <label style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                  padding: '16px', borderRadius: 12, border: `2px dashed ${G}`, background: GBG,
                  color: GDK, fontSize: '0.94rem', fontWeight: 800, cursor: 'pointer', textAlign: 'center',
                  transition: 'all 0.15s ease',
                }}>
                  📷 Take a Photo
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={e => handleWcaPhoto(wcaDocKey, e.target.files?.[0] || null)}
                    style={{ display: 'none' }}
                  />
                </label>

                {/* Option 2: Upload PDF */}
                <label style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                  padding: '16px', borderRadius: 12, border: `2px dashed #3b82f6`, background: `rgba(59,130,246,0.09)`,
                  color: `#2563eb`, fontSize: '0.94rem', fontWeight: 800, cursor: 'pointer', textAlign: 'center',
                  transition: 'all 0.15s ease',
                }}>
                  📄 Choose PDF File
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    onChange={e => handleWcaPdf(wcaDocKey, e.target.files?.[0] || null)}
                    style={{ display: 'none' }}
                  />
                </label>
              </div>
            </Modal>
          );
        })()}

        {medReasonPromptOpen && (
          <Modal open={true} onClose={() => { setMedReasonPromptOpen(false); setTempMedReason(null); }} centerOnMobile>
            <div style={{ padding: '0 4px 0px', borderBottom: `1px solid ${S100}`, marginBottom: 14 }}>
              <div style={{ fontSize: '1.1rem', fontWeight: 900, color: S900, letterSpacing: '-0.01em' }}>
                Reason for Medication
              </div>
              <div style={{ fontSize: '0.78rem', color: S400, marginTop: 3, marginBottom: 12 }}>
                Why is this medication needed?
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                'Medication / IV Administered On Route',
                'Medication Administered via IV',
                'Fluid Resuscitation Required',
                'Profuse Bleeding',
                'Nebuliser',
                'Oral',
                'IV',
                'IMI',
                'Inhalation'
              ].map(opt => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => {
                    setTempMedReason(opt);
                    setMedReasonPromptOpen(false);
                    setCrewPicker({ phase: 'select', kind: 'med' });
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 14,
                    textAlign: 'left', cursor: 'pointer', width: '100%',
                    background: S50,
                    border: `1.5px solid ${S200}`,
                    borderRadius: 14, padding: '13px 14px',
                    transition: 'all 0.15s ease',
                    fontWeight: 700,
                    color: S900,
                  }}
                >
                  {opt}
                </button>
              ))}
            </div>
          </Modal>
        )}

        {/* ── IV Therapy Reason Modal ── */}
        {/* centerOnMobile: buttons-only picker (no keyboard field), so centre it
            vertically instead of anchoring to the top — easier thumb reach. */}
        {ivReasonModalOpen && (
          <Modal open={true} onClose={() => setIvReasonModalOpen(false)} centerOnMobile>
            <div style={{ padding: '0 4px 0px', borderBottom: `1px solid ${S100}`, marginBottom: 14 }}>
              <div style={{ fontSize: '1.1rem', fontWeight: 900, color: S900, letterSpacing: '-0.01em' }}>
                Reason for IV Therapy
              </div>
              <div style={{ fontSize: '0.78rem', color: S400, marginTop: 3, marginBottom: 12 }}>
                Why is this IV line needed?
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(['IFT', 'IHT'].includes(fd.call_type)) && (
                <button
                  type="button"
                  onClick={() => {
                    sf('ift_ongoing_iv_treatment', true);
                    sf('primary_iv_profuse_bleeding', false);
                    sf('primary_iv_fluid_resuscitation', false);
                    sf('iv_medication_administration', false);
                    setIvReasonModalOpen(false);
                    setIvSectionOpen(true);
                    setCrewPicker({ phase: 'select', kind: 'iv' });
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 14,
                    textAlign: 'left', cursor: 'pointer', width: '100%',
                    background: S50,
                    border: `1.5px solid ${S200}`,
                    borderRadius: 14, padding: '13px 14px',
                    transition: 'all 0.15s ease',
                    fontWeight: 700,
                    color: S900,
                  }}
                >
                  On-going IV treatment
                </button>
              )}
              
              {[
                { label: 'Profuse Bleeding', key: 'primary_iv_profuse_bleeding' },
                { label: 'Fluid Resuscitation', key: 'primary_iv_fluid_resuscitation' },
                { label: 'Medication Administered via IV', key: 'iv_medication_administration' }
              ].map(opt => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => {
                    sf('ift_ongoing_iv_treatment', false);
                    sf('primary_iv_profuse_bleeding', opt.key === 'primary_iv_profuse_bleeding');
                    sf('primary_iv_fluid_resuscitation', opt.key === 'primary_iv_fluid_resuscitation');
                    sf('iv_medication_administration', opt.key === 'iv_medication_administration');
                    setIvReasonModalOpen(false);
                    setIvSectionOpen(true);
                    setCrewPicker({ phase: 'select', kind: 'iv' });
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 14,
                    textAlign: 'left', cursor: 'pointer', width: '100%',
                    background: S50,
                    border: `1.5px solid ${S200}`,
                    borderRadius: 14, padding: '13px 14px',
                    transition: 'all 0.15s ease',
                    fontWeight: 700,
                    color: S900,
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </Modal>
        )}


        {phase === PHASES.length - 1 && (
          <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 40, display: 'flex', gap: 10, padding: '12px 18px', background: 'rgba(255,255,255,0.97)', backdropFilter: 'blur(12px)', borderTop: `1px solid ${S200}`, boxShadow: '0 -4px 16px rgba(0,0,0,0.06)' }}>
            <button type="button" onClick={handleSubmit} disabled={submitting} style={{ flex: 1, padding: '15px 0', borderRadius: 12, fontSize: '0.88rem', fontWeight: 800, border: 'none', cursor: submitting ? 'wait' : 'pointer', background: submitting ? S400 : `linear-gradient(135deg,${ROSE},#be123c)`, color: W, boxShadow: submitting ? 'none' : `0 4px 14px rgba(225,29,72,0.3)` }}>{submitting ? 'Submitting...' : 'Submit PRF'}</button>
          </div>
        )}
      </div>
    </FormContext.Provider>
  );
}
