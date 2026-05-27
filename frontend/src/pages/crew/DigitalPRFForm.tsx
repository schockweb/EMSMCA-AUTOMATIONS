/**
 * Digital PRF — Trip Journey Form
 * Follows the EMS call from dispatch to completion as a step-by-step journey.
 * Each phase mirrors the real-world call flow so crew always know where they are.
 */
import { useState, useEffect, useRef, useMemo, useCallback, createContext, useContext } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import SignaturePad from '../../components/SignaturePad';
import FullscreenSignaturePad, { FullscreenCanvas } from '../../components/FullscreenSignaturePad';
import StickerCameraCapture from '../../components/StickerCameraCapture';
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
const API = import.meta.env.VITE_API_URL || '';

// ── Design tokens ─────────────────────────────────────────────────────────────
const G = '#5b8def'; const GDK = '#3b6fde'; const GBG = 'rgba(91,141,239,0.09)';
const S900 = '#0f172a'; const S700 = '#334155'; const S600 = '#475569';
const S400 = '#94a3b8'; const S200 = '#e2e8f0'; const S100 = '#f1f5f9';
const S50 = '#f8fafc'; const W = '#ffffff';
const ROSE = '#e11d48'; const AMB = '#f59e0b'; const REDC = '#ef4444';

function api() {
  return axios.create({
    baseURL: API,
    headers: {
      Authorization: `Bearer ${localStorage.getItem('crew_token')}`,
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
  { label: 'Mobile', timeKey: 'time_mobile', kmKey: 'km_mobile', phase: 1 },
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
  { label: 'Pupil Size L', key: 'pupil_size_l', placeholder: 'e.g. 3' },
  { label: 'Pupil Size R', key: 'pupil_size_r', placeholder: 'e.g. 3' },
  { label: 'Pupil Reaction L/R', key: 'pupil_react', opts: ['Equal/Reactive', 'Unequal', 'Sluggish', 'Fixed/Dilated'] },
  { label: 'Neuro Deficit', key: 'neuro_def', opts: ['Yes', 'No'] },
  { label: 'HGT (mmol/L)', key: 'hgt', type: 'number', placeholder: 'mmol/L' },
  { label: 'Temp (°C)', key: 'temp', placeholder: 'e.g. 36.8' },
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
function inferPhase(ts: Record<string, string | null>): number {
  if (ts.time_available) return 6;
  if (ts.time_at_destination) return 5;
  if (ts.time_depart_scene) return 4;
  if (ts.time_on_scene) return 3;
  if (ts.time_mobile) return 2;
  if (ts.time_dispatched) return 1;
  return 0;
}

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
// fixed-position pill (bottom-left) that the crew can tap to jump straight to
// the vitals section in the Clinical phase. Footprint is intentionally small
// so it does not occlude form fields on phone screens.
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
  if (!lastVitalAt) return null;
  const intervalMs = vitalsIntervalMs(level);
  const remaining = intervalMs - (Date.now() - lastVitalAt);
  const overdue = remaining <= 0;
  const warn = !overdue && remaining <= 2 * 60 * 1000;
  const colour = overdue ? '#ef4444' : warn ? '#f59e0b' : '#3b6fde';
  const bg = overdue ? '#fef2f2' : warn ? '#fffbeb' : 'rgba(91,141,239,0.10)';
  const mins = Math.max(0, Math.ceil(Math.abs(remaining) / 60000));
  const text = overdue ? `Vitals overdue +${mins}m` : `Next vitals in ${mins}m`;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={overdue ? 'Vitals overdue — tap to record' : 'Next vitals due — tap to record'}
      style={{
        position: 'fixed', bottom: 90, left: 14, zIndex: 100,
        background: bg, border: `1.5px solid ${colour}`, color: colour,
        borderRadius: 999, padding: '7px 12px', fontSize: '0.7rem', fontWeight: 800,
        letterSpacing: '0.03em', cursor: 'pointer', boxShadow: `0 4px 16px ${colour}40`,
        display: 'flex', alignItems: 'center', gap: 6, maxWidth: 'calc(100vw - 90px)',
        whiteSpace: 'nowrap', fontFamily: 'inherit',
      }}
    >
      <span style={{ fontSize: '0.95rem', lineHeight: 1 }}>{overdue ? '⚠' : '⏱'}</span>
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
  const fmt = (v: string) => {
    if (!v) return '';
    const [whole, dec] = v.split('.');
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
      type="text"
      inputMode="decimal"
      pattern="[0-9. ]*"
      value={focused ? value : fmt(value)}
      placeholder=""
      autoComplete="off"
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
export const FormContext = createContext<any>(null);

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

// Placeholder hint text is suppressed across all input components for the
// live rollout — crew should see clean, empty fields rather than fine-print
// example text. The `ph` prop is kept on the type signature so the ~120
// callsites passing it continue to compile; we just ignore it. Re-enable
// hints by changing `placeholder=""` back to `placeholder={ph}` in Inp,
// ComboInp and Txt below.
const Inp = ({ fk, type = 'text' }: { fk: string; ph?: string; type?: string; req?: boolean }) => {
  const { fd, sf } = useContext(FormContext);
  return <input type={type} value={fd[fk] ?? ''} onChange={e => sf(fk, e.target.value)} onFocus={onF} onBlur={onB} placeholder="" autoComplete="off" style={{ ...base, marginBottom: 14, borderColor: '#e2e8f0' }} />
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
  };
};

const AddrInp = ({ fk, suburbKey }: { fk: string; ph?: string; req?: boolean; suburbKey?: string }) => {
  const { fd, sf } = useContext(FormContext);
  const val: string = fd[fk] ?? '';
  const [suggestions, setSuggestions] = useState<AddrSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);
  // Skips one re-query after the crew picks a suggestion: without this, sf()
  // re-triggers the input's onChange and re-opens the dropdown with the same
  // matched result still highlighted.
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
    setSuggestions([]);
    setOpen(false);
  };

  return (
    <div style={{ position: 'relative', marginBottom: 14 }}>
      <input
        type="text"
        value={val}
        onChange={e => onTextChange(e.target.value)}
        onFocus={(e) => { focusedRef.current = true; onF(e); if (val.length >= 3 && suggestions.length > 0) setOpen(true); }}
        onBlur={(e) => {
          focusedRef.current = false;
          onB(e);
          window.setTimeout(() => { if (!focusedRef.current) setOpen(false); }, 180);
        }}
        onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); (e.currentTarget as HTMLInputElement).blur(); } }}
        autoComplete="off"
        placeholder=""
        aria-label="Street address with autocomplete"
        aria-autocomplete="list"
        style={{ ...base, borderColor: '#e2e8f0' }}
      />
      {open && (loading || suggestions.length > 0) && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30,
            marginTop: 4, background: '#fff', border: `1.5px solid #cbd5e1`,
            borderRadius: 10, boxShadow: '0 8px 24px rgba(15,23,42,0.12)',
            maxHeight: 280, overflowY: 'auto',
          }}
        >
          {loading && suggestions.length === 0 && (
            <div style={{ padding: '10px 14px', fontSize: '0.82rem', color: '#475569', fontStyle: 'italic' }}>
              Searching addresses…
            </div>
          )}
          {suggestions.map((s, i) => (
            <div
              key={i}
              role="option"
              aria-selected={false}
              onMouseDown={(e) => { e.preventDefault(); pick(s); }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#f8fafc'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#fff'; }}
              style={{
                padding: '10px 14px', cursor: 'pointer',
                borderBottom: i < suggestions.length - 1 ? '1px solid #f1f5f9' : 'none',
                fontSize: '0.85rem',
              }}
            >
              <div style={{ fontWeight: 700, color: '#0f172a' }}>{s.formatted}</div>
              {s.display && s.display !== s.formatted && (
                <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: 2 }}>{s.display}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
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
        <input
          type="text"
          value={current}
          onChange={e => { sf(fk, e.target.value); setOpen(true); }}
          onFocus={e => { onF(e); setOpen(true); }}
          onBlur={onB}
          placeholder=""
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="words"
          spellCheck={false}
          style={{ ...borderStyle, marginBottom: 0 }}
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
  return <textarea value={fd[fk] ?? ''} onChange={e => sf(fk, e.target.value)} onFocus={onF} onBlur={onB} placeholder="" rows={rows} style={{ ...base, resize: 'vertical', marginBottom: 14, fontFamily: 'inherit' }} />
};

// VoiceTxt — textarea with an overlaid mic-icon trigger that dictates into
// the field via the Web Speech API. Used for the long-form clinical notes
// (chief complaint, findings on arrival, HPI, management notes) so crew can
// keep their gloves on and dictate while attending the patient.
//
// • Tap to start, tap again to stop. Recording state is a pulsing red mic.
// • Final transcripts are appended to whatever the crew already typed —
//   never overwrite, so the mic can extend partial entries.
// • Auto-hides on browsers that don't expose SpeechRecognition (no harm,
//   the plain textarea still works).
const SpeechRecognitionAPI: any =
  (typeof window !== 'undefined' &&
    ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) || null;

const VoiceTxt = ({ fk, rows = 3 }: { fk: string; ph?: string; rows?: number }) => {
  const { fd, sf } = useContext(FormContext);
  const [recording, setRecording] = useState(false);
  const recogRef = useRef<any>(null);
  const fdRef = useRef(fd);
  fdRef.current = fd;
  const supported = !!SpeechRecognitionAPI;
  // Snapshot of the field's value at the moment recording started. Live
  // transcript (final + interim) is rendered on top of this baseline on
  // every onresult event so the textarea reflects dictation in real time
  // without compounding into itself.
  const baselineRef = useRef<string>('');

  useEffect(() => () => {
    // Make sure we tear down any active recogniser if the field unmounts
    // mid-dictation (e.g. crew jumps phase).
    try { recogRef.current?.stop?.(); } catch { /* ignore */ }
    recogRef.current = null;
  }, []);

  const start = () => {
    if (!supported || recording) return;
    const recog = new SpeechRecognitionAPI();
    recog.lang = 'en-ZA';
    recog.continuous = true;
    recog.interimResults = true;

    // Capture what the crew already typed as the immutable prefix.
    // Streaming dictation appends on top — any manual edits made before
    // tapping the mic survive the session.
    const existing: string = fdRef.current[fk] || '';
    baselineRef.current = existing && !/\s$/.test(existing) ? existing + ' ' : existing;

    recog.onresult = (e: any) => {
      // The results array is cumulative for the session — iterate from 0
      // each time so we always rebuild the live transcript from source.
      let finalText = '';
      let interimText = '';
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interimText += t;
      }
      const live = (
        finalText.trim() +
        (finalText && interimText ? ' ' : '') +
        interimText.trim()
      ).trim();
      sf(fk, baselineRef.current + live);
    };
    recog.onend = () => { setRecording(false); recogRef.current = null; };
    recog.onerror = () => { setRecording(false); recogRef.current = null; };
    recogRef.current = recog;
    try {
      recog.start();
      setRecording(true);
    } catch {
      setRecording(false);
      recogRef.current = null;
    }
  };

  const stop = () => {
    try { recogRef.current?.stop?.(); } catch { /* ignore */ }
    setRecording(false);
  };

  return (
    <div style={{ position: 'relative', marginBottom: 14 }}>
      <textarea
        value={fd[fk] ?? ''}
        onChange={e => sf(fk, e.target.value)}
        onFocus={onF}
        onBlur={onB}
        placeholder=""
        rows={rows}
        style={{
          ...base,
          resize: 'vertical',
          marginBottom: 0,
          fontFamily: 'inherit',
          paddingRight: supported ? 50 : (base as any).padding,
        }}
      />
      {supported && (
        <>
          <button
            type="button"
            onClick={recording ? stop : start}
            aria-label={recording ? 'Stop dictation' : 'Dictate into field'}
            title={recording ? 'Stop dictation' : 'Tap to dictate'}
            style={{
              position: 'absolute',
              top: 8, right: 8,
              width: 36, height: 36, borderRadius: 9,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `1.5px solid ${recording ? '#ef4444' : '#cbd5e1'}`,
              background: recording ? 'rgba(239,68,68,0.12)' : '#ffffff',
              color: recording ? '#dc2626' : '#475569',
              cursor: 'pointer',
              boxShadow: recording ? '0 0 0 4px rgba(239,68,68,0.18)' : 'none',
              animation: recording ? 'voicePulse 1.4s ease-in-out infinite' : 'none',
              transition: 'all 0.15s',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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
  return <select value={fd[fk] ?? ''} onChange={e => sf(fk, e.target.value)} onFocus={onF} onBlur={onB} style={{ ...base, marginBottom: 14, appearance: 'menulist' }}>
    <option value="">— Select —</option>
    {opts.map((o: string) => <option key={o} value={o}>{o}</option>)}
  </select>
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
const CALL_TYPE_OPTS = ['PRIMARY', 'IHT', 'RHT', 'COURTESY', 'RESUS', 'DOD'] as const;
const CALL_TYPE_LABELS: Record<string, string> = {
  IHT: 'IFT/IHT',
  RESUS: 'Resus',
  DOD: 'Declaration of Death',
};

const CallTypePicker = () => {
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
    setOpen(false);
    if (firstPick) {
      setAnimating(true);
      window.setTimeout(() => setAnimating(false), 320);
    }
  };

  // No selection yet — render the full grid.
  if (!selected) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8, marginBottom: 14 }}>
        {CALL_TYPE_OPTS.map(o => (
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
const BILLING_TYPE_OPTS = ['MED AID', 'IOD', 'RAF', 'PVT', 'EVENT', 'CALL OUT FEE'] as const;

const BillingTypePicker = () => {
  const { fd, sf } = useContext(FormContext);
  const selected: string = fd.billing_type || '';
  const [animating, setAnimating] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const c = '#5b8def'; const cdk = '#3b6fde';
  // EVENT and CALL OUT FEE are hidden from the picker but kept in
  // BILLING_TYPE_OPTS so legacy records carrying those values still render
  // their conditional billing panels.
  // Declaration of Death call-outs cannot bill third-party payers (no live
  // patient to bill, no incident exposure) — also strip IOD / RAF.
  // Resus calls are restricted to MED AID and PVT only.
  const baseOpts = BILLING_TYPE_OPTS.filter(o => o !== 'EVENT' && o !== 'CALL OUT FEE');
  const billingOpts = fd.call_type === 'DOD'
    ? baseOpts.filter(o => o !== 'IOD' && o !== 'RAF')
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
      gap: narrow ? 0 : '0 12px',
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
const DodFormBody = () => {
  const { fd, sf } = useContext(FormContext);
  return (
    <>
      <DodG2>
        <div><Lbl t="Date" /><Inp fk="med_aid_dec_death_date" ph="YYYY-MM-DD" type="date" /></div>
        <div><Lbl t="Time Of Death" /><Inp fk="med_aid_dec_death_time" ph="HH:MM" type="time" /></div>
      </DodG2>

      <Lbl t="Case No." />
      <Inp fk="med_aid_dec_death_case_no" ph="Case number" />

      {/* For Resus calls the dispatch times already render inside
          the Resus subsection above — skip the duplicate here. */}
      {fd.call_type !== 'RESUS' && <DodDispatchTimesEmbed />}

      <Lbl t="Precise location of body" />
      <AddrInp fk="med_aid_dec_death_location" ph="Where the body is located" />

      <Lbl t="Deceased Identified by (Full Name and Surname)" />
      <Inp fk="med_aid_dec_death_identified_by" ph="Identifier's full name and surname" />

      <DodSubHdr t="Particulars of deceased" />
      <DodG2>
        <div><Lbl t="Surname" /><Inp fk="med_aid_dec_death_deceased_surname" ph="Surname" /></div>
        <div><Lbl t="First Name" /><Inp fk="med_aid_dec_death_deceased_first_name" ph="First name" /></div>
      </DodG2>
      <DodG2>
        <div><Lbl t="ID or Passport No" /><Inp fk="med_aid_dec_death_deceased_id" ph="ID or passport" /></div>
        <div><Lbl t="Sex" /><Toggle fk="med_aid_dec_death_deceased_sex" opts={['M', 'F']} size="sm" /></div>
      </DodG2>
      <Lbl t="Date of Birth (or approximate age if DOB unknown)" />
      <Inp fk="med_aid_dec_death_deceased_dob" ph="YYYY-MM-DD or approx. age" />

      <DodSubHdr t="Particulars of healthcare professional" />
      <DodG2>
        <div><Lbl t="Surname" /><Inp fk="med_aid_dec_death_hcp_surname" ph="Surname" /></div>
        <div><Lbl t="First Name" /><Inp fk="med_aid_dec_death_hcp_first_name" ph="First name" /></div>
      </DodG2>
      <DodG2>
        <div><Lbl t="Station" /><Inp fk="med_aid_dec_death_hcp_station" ph="Station / base" /></div>
        <div><Lbl t="Qualification" /><Inp fk="med_aid_dec_death_hcp_qualification" ph="e.g. ALS, Dr" /></div>
      </DodG2>
      <DodG2>
        <div><Lbl t="ID No" /><Inp fk="med_aid_dec_death_hcp_id" ph="ID number" /></div>
        <div><Lbl t="HPCSA No" /><Inp fk="med_aid_dec_death_hcp_hpcsa" ph="MP / PB number" /></div>
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

      <DodSubHdr t="Declaration" />
      <div style={{
        padding: '16px 18px',
        background: 'linear-gradient(135deg, rgba(245,158,11,0.12), rgba(225,29,72,0.08))',
        border: '2px solid #f59e0b',
        borderRadius: 12,
        marginBottom: 18,
        boxShadow: '0 4px 14px rgba(245,158,11,0.18)',
        color: '#7c2d12',
        lineHeight: 1.55,
        position: 'relative',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: '0.72rem', fontWeight: 900, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: '#b45309',
          marginBottom: 10,
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
        <div style={{ flex: 1 }}>
          <input
            type="text"
            value={fd.med_aid_dec_death_signatory_name ?? ''}
            onChange={e => sf('med_aid_dec_death_signatory_name', e.target.value)}
            onFocus={onF}
            onBlur={onB}
            placeholder=""
            autoComplete="off"
            style={{ ...base, marginBottom: 0, borderColor: '#e2e8f0' }}
          />
        </div>
        <FullscreenSignaturePad
          compact
          label="Signature"
          value={fd.med_aid_dec_death_signature}
          onChange={v => sf('med_aid_dec_death_signature', v)}
        />
      </div>

      <Lbl t="Crew Member 2" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <input
            type="text"
            value={fd.med_aid_dec_death_crew_attended_name ?? ''}
            onChange={e => sf('med_aid_dec_death_crew_attended_name', e.target.value)}
            onFocus={onF}
            onBlur={onB}
            placeholder=""
            autoComplete="off"
            style={{ ...base, marginBottom: 0, borderColor: '#e2e8f0' }}
          />
        </div>
        <FullscreenSignaturePad
          compact
          label="Crew Signature"
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
        <div style={{ flex: 1 }}>
          <input
            type="text"
            value={fd.med_aid_dec_death_witness_name ?? ''}
            onChange={e => sf('med_aid_dec_death_witness_name', e.target.value)}
            onFocus={onF}
            onBlur={onB}
            placeholder=""
            autoComplete="off"
            style={{ ...base, marginBottom: 0, borderColor: '#e2e8f0' }}
          />
        </div>
        <FullscreenSignaturePad
          compact
          label="Witness Signature"
          value={fd.med_aid_dec_death_witness_signature}
          onChange={v => sf('med_aid_dec_death_witness_signature', v)}
        />
      </div>

      <DodSubHdr t="Supporting Documents" />
      <DocumentsCapture
        value={fd.med_aid_dec_death_documents}
        onChange={v => sf('med_aid_dec_death_documents', v)}
        buttonLabel={(Array.isArray(fd.med_aid_dec_death_documents) && fd.med_aid_dec_death_documents.length) ? 'Add More Documents' : 'Add Document'}
      />
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
                      <Toggle fk="med_aid_resus_level" opts={['ILS', 'BLS']} size="sm" />
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

          {/* Declaration of Death — only surfaced when the call type is DOD.
              The manual Sub-toggle has been removed so the DoD form can
              never appear under MED AID for IFT/IHT/RHT/PRIMARY/etc; the
              call-type pick is the sole entry point. For RESUS the DoD
              form is surfaced inline at the bottom of the clinical
              section instead (so the crew never has to scroll back to
              the billing card mid-flow). */}
          {fd.call_type === 'DOD' && (
            <div>
              <DodFormBody />
            </div>
          )}

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
const ScopedInp = ({ fk, capabilityKey, ph, type = 'text' }: {
  fk: string; capabilityKey: string; ph?: string; type?: string;
}) => {
  const { fd } = useContext(FormContext);
  const cat = normaliseHpcsaCategory(fd.treating_practitioner_category);
  const ok = !cat || isAuthorised(cat, capabilityKey);
  if (ok) return <Inp fk={fk} ph={ph} type={type} />;
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
const G2 = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '0 12px' }}>{children}</div>
);

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
          {[{ l: 'HR', k: 'hr', t: 'number', ph: 'bpm' }, { l: 'BP', k: 'bp', ph: '120/80' }, { l: 'SpO₂%', k: 'spo2', t: 'number', ph: '%' }, { l: 'Resp Rate', k: 'resp_rate', t: 'number', ph: '/min' }].map(f => (
            <div key={f.k}><Lbl t={f.l} /><input type={f.t || 'text'} value={qv[f.k] ?? ''} onChange={e => setQv((p: any) => ({ ...p, [f.k]: e.target.value }))} placeholder="" autoComplete="off" onFocus={onF} onBlur={onB} style={{ ...base, marginBottom: 14 }} /></div>
          ))}
        </G2>
        <Lbl t="Pain /10" />
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 14 }}>
          {['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map(o => { const on = qv.pain === o; return <button key={o} type="button" onClick={() => setQv((p: any) => ({ ...p, pain: o }))} style={{ padding: '9px 10px', borderRadius: 8, fontSize: '0.8rem', fontWeight: 700, border: `2px solid ${on ? G : S200}`, background: on ? GBG : W, color: on ? GDK : S600, cursor: 'pointer' }}>{o}</button>; })}
        </div>
        <Lbl t="GCS — Eyes / Voice / Motor" />
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
  onConfirm: () => void;
  onRecapture: () => void;
  onCancel: () => void;
}) {
  const accColor = !coords
    ? S600
    : coords.accuracy <= 25 ? GDK
      : coords.accuracy <= 100 ? '#92400e'
        : REDC;
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

        {!capturing && coords && (
          <div style={{ padding: 16, background: GBG, borderRadius: 12, border: `1.5px solid ${G}40`, marginBottom: 16 }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 800, color: GDK, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Captured coordinates</div>
            <div style={{ fontFamily: 'monospace', fontSize: '0.95rem', fontWeight: 800, color: S900, marginBottom: 4 }}>
              {coords.latitude.toFixed(6)}, {coords.longitude.toFixed(6)}
            </div>
            <div style={{ fontSize: '0.78rem', color: accColor, fontWeight: 700, marginBottom: 10 }}>
              ± {Math.round(coords.accuracy)} m accuracy
            </div>
            <a
              href={`https://www.google.com/maps?q=${coords.latitude},${coords.longitude}`}
              target="_blank" rel="noreferrer"
              style={{ fontSize: '0.78rem', fontWeight: 700, color: GDK, textDecoration: 'underline' }}
            >
              View on map ↗
            </a>
          </div>
        )}

        {!capturing && !coords && (
          <div style={{ padding: 16, background: '#fef2f2', borderRadius: 12, border: `1.5px solid ${REDC}40`, marginBottom: 16 }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 800, color: REDC, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Location unavailable</div>
            <div style={{ fontSize: '0.85rem', color: S700, marginBottom: 6 }}>{error || 'No GPS coordinates were captured.'}</div>
            <div style={{ fontSize: '0.75rem', color: S600 }}>You can still mark the time without GPS, or retry the capture.</div>
          </div>
        )}

        {/* ── Resolved street address (shown for every Mark Time when coords resolved) ── */}
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
                    {`“${targetFieldLabel}” already has a value — your existing entry will be kept. Review above and edit the field manually if needed.`}
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
            onClick={onRecapture}
            disabled={capturing}
            style={{ width: '100%', padding: '12px 0', borderRadius: 10, fontWeight: 800, fontSize: '0.85rem', border: `2px solid ${S200}`, background: W, color: S700, cursor: capturing ? 'not-allowed' : 'pointer', opacity: capturing ? 0.5 : 1 }}
          >
            ↻ Re-capture
          </button>
        </div>
        <button
          type="button"
          onClick={onConfirm}
          disabled={capturing || !coords}
          style={{
            width: '100%', padding: 16, borderRadius: 12, fontWeight: 800, fontSize: '1rem',
            border: 'none',
            background: (capturing || !coords) ? S200 : `linear-gradient(135deg,${G},${GDK})`,
            color: (capturing || !coords) ? S600 : W,
            cursor: (capturing || !coords) ? 'not-allowed' : 'pointer',
            boxShadow: (capturing || !coords) ? 'none' : `0 4px 14px ${G}30`,
          }}
        >
          ✓ Confirm & Mark Time
        </button>
      </div>
    </div>
  );
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

  // When the crew advances or steps back through the journey, the new phase
  // should always land at the top of the screen — not wherever the previous
  // phase happened to be scrolled to. Without this, navigating from Clinical
  // (a long phase) to Transport drops the user mid-page, looking blank.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [phase]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // `saving` was previously surfaced in the sticky-header save icon which
  // has been removed. We keep the setter so doSave() still records the
  // in-flight state for any future indicator, but the value itself is unused.
  const [, setSaving] = useState(false);
  const [submitting, setSubmit] = useState(false);
  // `lastSaved` is no longer surfaced in the header but doSave() still
  // records it for any future indicator.
  const [, setLastSaved] = useState<Date | null>(null);
  const [prfMeta, setPrfMeta] = useState<any>({});

  const [fd, setFd] = useState<Record<string, any>>({});
  const [timestamps, setTs] = useState<Record<string, string | null>>({});
  const [kms, setKms] = useState<Record<string, string>>({});
  // GPS coordinates the crew has confirmed for each timestamp field.
  // Shape mirrors what /mark-time returns: {lat, lng, accuracy_m, captured_at}.
  type GeoCapture = { lat: number; lng: number; accuracy_m: number | null; captured_at: string };
  const [geos, setGeos] = useState<Record<string, GeoCapture>>({});
  const [sigs, setSigs] = useState<Record<string, string | null>>({
    patient_signature: null, witness_signature: null,
    handover_signature: null, crew_signature: null,
  });
  const [vehicle, setVehicle] = useState('');
  const [crew2Id, setCrew2Id] = useState('');
  const [vitals, setVitals] = useState<any[]>([]);
  const [editVital, setEditVital] = useState(-1);
  const [quickVital, setQV] = useState(false);
  const [vsAlphaKeys, setVsAlphaKeys] = useState<Set<string>>(() => new Set());
  const [ivRows, setIvRows] = useState<any[]>([]);
  const [medRows, setMedRows] = useState<any[]>([]);
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

  const profile = JSON.parse(localStorage.getItem('crew_profile') || '{}');
  const dirtyRef = useRef(false);

  // (Live header timer is owned by the <LiveTimer> component — keeping the
  //  ticker out of this component prevents form re-renders mid-keystroke,
  //  which on mobile dismisses the IME / on-screen keyboard.)

  // ── Load ─────────────────────────────────────────────────────────────────
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
      try { return JSON.parse(localStorage.getItem('crew2_profile') || '{}'); }
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

    setPrfMeta(prf);
    setFd(data);
    setVehicle(prf.vehicle_id || '');
    setCrew2Id(prf.crew_member_2_id || '');
    setVitals(data.vitals_sets || []);
    setIvRows(data.iv_therapy || []);
    setMedRows(data.medications || []);
    const ts: Record<string, string | null> = {};
    const km: Record<string, string> = {};
    ALL_TIME_ROWS.forEach(r => { ts[r.timeKey] = prf[r.timeKey] || null; km[r.kmKey] = prf[r.kmKey] || ''; });
    setTs(ts);
    setKms(km);
    setGeos(prf.geo_locations || {});
    setSigs({
      patient_signature: prf.patient_signature || null,
      witness_signature: prf.witness_signature || null,
      handover_signature: prf.handover_signature || null,
      crew_signature: prf.crew_signature || null,
    });
    setPhase(inferPhase({ ...ts }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prfId]);

  // Outer loader with hard retry cap. Retries only on network errors
  // (no HTTP response) and only up to MAX_RETRIES times. After that, the
  // error UI is shown — never an infinite "Reconnecting…" spin.
  const loadPrf = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const MAX_RETRIES = 1;          // 1 initial attempt + 1 retry = 2 tries total
    const RETRY_DELAY_MS = 700;
    setLoadError(null);
    let lastErr: any = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) return;
      try {
        await fetchPrfOnce(signal);
        setLoadError(null);
        setLoading(false);
        setRetrying(false);
        return;
      } catch (err: any) {
        if (signal?.aborted || err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') {
          return; // Expected — StrictMode double-mount cleanup
        }
        lastErr = err;
        // 401 / 404 / 403 etc. — don't retry, surface immediately
        if (err?.response) break;
        // Network error — retry if we still have attempts left
        if (attempt < MAX_RETRIES) {
          setRetrying(true);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }
    // All attempts exhausted (or non-retryable error)
    if (signal?.aborted) return;
    if (lastErr?.response?.status === 401) {
      navigate(`/${providerSlug}/login`, { replace: true });
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
    if (crewPicker) return;
    setCrewPicker({ phase: 'select', kind: 'treating' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, fd.treating_practitioner_category]);

  // ── Auto-save on change (debounced) ─────────────────────────────────────
  // The form saves automatically as the crew types — every keystroke
  // schedules a save ~400ms after the last change, so a burst of typing
  // collapses into a single PATCH instead of one-per-letter. This avoids
  // the out-of-order request hazard you'd get firing a network call on
  // every keypress, while still feeling instantaneous to the user.
  const initialLoadRef = useRef(true);
  useEffect(() => {
    // Skip the initial render — the form data was just hydrated from the
    // server, no need to save it straight back.
    if (initialLoadRef.current) { initialLoadRef.current = false; return; }
    if (!prfId) return;
    const t = setTimeout(() => { doSave(); dirtyRef.current = false; }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fd, vitals, ivRows, medRows, timestamps, kms, sigs, vehicle, crew2Id, prfId]);

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

  const sf = (k: string, v: any) => { setFd(p => ({ ...p, [k]: v })); dirtyRef.current = true; };
  const toggleArr = (k: string, v: string) => {
    const arr: string[] = Array.isArray(fd[k]) ? [...fd[k]] : [];
    const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v);
    sf(k, arr);
  };
  const inArr = (k: string, v: string) => Array.isArray(fd[k]) && (fd[k] as string[]).includes(v);

  const lastSavedPayloadRef = useRef<string | null>(null);

  const doSave = async () => {
    // Strip empty strings from kms and timestamps — the backend's
    // Numeric columns reject '' and the entire save crashes.
    const cleanKms: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(kms)) {
      cleanKms[k] = v && String(v).trim() ? v : null;
    }
    const cleanTs: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(timestamps)) {
      cleanTs[k] = v || null;
    }
    const payload = {
      form_data: { ...fd, vitals_sets: vitals, iv_therapy: ivRows, medications: medRows },
      vehicle_id: vehicle || null, crew_member_2_id: crew2Id || null,
      ...cleanTs, ...cleanKms, ...sigs,
    };
    
    const payloadStr = JSON.stringify(payload);
    if (payloadStr === lastSavedPayloadRef.current) return;
    lastSavedPayloadRef.current = payloadStr;

    setSaving(true);
    try {
      await api().patch(`/api/digital-prf/${prfId}`, payload);
      setLastSaved(new Date());
    } catch (err: any) {
      // Offline fallback: queue to IndexedDB outbox
      if (!navigator.onLine || err?.code === 'ECONNABORTED' || err?.code === 'ERR_NETWORK') {
        try {
          const { queueSave } = await import('../../services/offlineDb');
          await queueSave(prfId!, payload);
          window.dispatchEvent(new CustomEvent('outbox-change'));
        } catch { /* IndexedDB unavailable */ }
      }
    }
    setSaving(false);
  };


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
  type ResolvedAddress = {
    street: string;          // best human-readable single-line address
    suburb: string | null;   // suburb / neighbourhood, when available
    raw: any;                // full Nominatim payload, for debugging
  };
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
  const reverseGeocode = useCallback(async (
    lat: number, lng: number, signal: AbortSignal,
  ): Promise<ResolvedAddress | null> => {
    // Zoom 18 is street-level — high enough that we get house numbers and
    // road names rather than just a suburb pin. addressdetails=1 expands
    // the response with structured province / postcode / county fields
    // that `buildFullAddress` uses to assemble the full single-line
    // address written into the form.
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lng}`;
    const res = await fetch(url, { signal, headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`geocoder ${res.status}`);
    const data = await res.json();
    if (!data || !data.address) return null;
    const a = data.address;
    const street = buildFullAddress(a, data.display_name);
    return {
      street: street || (data.display_name || ''),
      suburb: a.suburb || a.neighbourhood || a.city_district || null,
      raw: data,
    };
  }, []);

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
  }, [reverseGeocode]);

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
  };
  const [kmConfirm, setKmConfirm] = useState<KmConfirm | null>(null);

  const handleKmCommit = useCallback((kmKey: string, raw: string) => {
    const newVal = parseInt(raw, 10);
    if (isNaN(newVal)) return;
    const idx = ALL_TIME_ROWS.findIndex(r => r.kmKey === kmKey);
    if (idx <= 0) return;  // first leg has nothing to compare against
    // Most recent earlier-in-sequence non-empty reading.
    let prevRow: typeof ALL_TIME_ROWS[number] | null = null;
    let prevVal = NaN;
    for (let i = idx - 1; i >= 0; i--) {
      const row = ALL_TIME_ROWS[i];
      const v = parseInt(kms[row.kmKey] ?? '', 10);
      if (!isNaN(v)) { prevRow = row; prevVal = v; break; }
    }
    if (!prevRow || isNaN(prevVal)) return;
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
      });
    }
  }, [kms]);

  // ── Scheme-based validation (Netcare CMG v5.2 rules + others) ───────────
  // Findings shown in a banner. Blockers prevent advance/submit; warnings
  // stay visible so the crew can address them but allow continuing.
  const [findings, setFindings] = useState<ValidationFinding[]>([]);

  const runValidation = (targetPhase: ValidationPhase): { ok: boolean; findings: ValidationFinding[] } => {
    const ctx = buildValidationContext({
      vitals, ivRows, medRows, sigs,
      crew2Id, prfMeta,
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

    if (fromPhase === 5 && vitals.length < MIN_VITALS && !fd.med_aid_dec_death) {
      blockers.push({
        id: 'INLINE-MIN-VITALS',
        severity: 'block',
        field: 'vitals_sets',
        message: `At least ${MIN_VITALS} sets of vitals are required (currently ${vitals.length}). Add more vitals on the Clinical or Transport phase before completing the call.`,
        source: 'Operational — minimum vitals capture per call.',
      });
    }

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
    } else if (fd.call_type === 'RESUS') {
      // Resus skips En Route (1) — the dispatch + on-scene times are
      // already captured inline on the Dispatch screen — Clinical (3)
      // since the clinical body is rendered inline there too, and
      // Complete (6) because the Available time + signatures + submit
      // render inline at the bottom of Handover. Auto-capture is
      // suppressed so the skip doesn't overwrite times the crew already
      // marked on a different screen.
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
      markTime(timeKey, kmKey || '', async () => {
        await doSave();
        setPhase(target);
      });
      return;
    }
    await doSave();
    setPhase(target);
  };

  const handleSubmit = async () => {
    // Hard floor — submission is blocked unless at least MIN_VITALS vital
    // sets are captured, regardless of how the crew navigated here.
    // RHT is exempt: the patient refused treatment, so there's no
    // assessment workflow that would yield vitals.
    if (vitals.length < MIN_VITALS && !fd.med_aid_dec_death && fd.call_type !== 'RHT') {
      const banner: ValidationFinding[] = [{
        id: 'INLINE-MIN-VITALS',
        severity: 'block',
        field: 'vitals_sets',
        message: `At least ${MIN_VITALS} sets of vitals are required to submit (currently ${vitals.length}).`,
        source: 'Operational — minimum vitals capture per call.',
      }];
      showBlockerBanner(banner);
      alert(`Cannot submit — minimum ${MIN_VITALS} vital sets required (currently ${vitals.length}).`);
      return;
    }

    // Final pre-submit validation runs the SUBMIT phase (6) ruleset, which
    // includes everything from earlier phases marked phases:[...,6].
    const { ok, findings: f } = runValidation(6);
    if (!ok) {
      alert(
        `Cannot submit yet — ${validationBlockers(f).length} required item(s) missing. See the highlighted issues at the top of the form.`,
      );
      return;
    }
    if (!confirm('Submit PRF? It will be saved to the Cases page and cannot be undone.')) return;
    setSubmit(true);
    await doSave();
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
          navigate(`/${providerSlug}/crew/prf-view/${newCaseId}?send=1`);
        } else {
          alert('PRF submitted successfully.');
          navigate(`/${providerSlug}/crew/dashboard`);
        }
      } else {
        alert('PRF submitted successfully.');
        navigate(`/${providerSlug}/crew/dashboard`);
      }
    } catch (e: any) {
      // Offline fallback: queue submission to outbox
      if (!navigator.onLine || e?.code === 'ECONNABORTED' || e?.code === 'ERR_NETWORK') {
        try {
          const { queueSubmit } = await import('../../services/offlineDb');
          await queueSubmit(prfId!, {
            form_data: { ...fd, vitals_sets: vitals, iv_therapy: ivRows, medications: medRows },
            vehicle_id: vehicle || null, crew_member_2_id: crew2Id || null,
            ...timestamps, ...kms, ...sigs,
          });
          window.dispatchEvent(new CustomEvent('outbox-change'));
          alert('You are offline. PRF has been saved locally and will submit automatically when connectivity returns.');
          navigate(`/${providerSlug}/crew/dashboard`);
        } catch {
          alert('Submission failed and offline save is unavailable. Please try again.');
        }
      } else {
        alert(e.response?.data?.detail || 'Submission failed');
      }
    }
    setSubmit(false);
  };

  // ── DEV ONLY: Fill form with test data ─────────────────────────────────────
  // Populates every field with realistic South African EMS data for a
  // Primary + MED AID scenario. Includes 3 vital sets, medications, IVs,
  // survey findings, ICD-10 codes, and patient/debtor demographics.
  // Only available in development mode (import.meta.env.DEV).
  const fillTestData = () => {
    const now = new Date();
    const hhmm = (d: Date) => `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    const t1 = new Date(now.getTime() - 45 * 60000);
    const t2 = new Date(now.getTime() - 30 * 60000);
    const t3 = new Date(now.getTime() - 15 * 60000);

    const testFd: Record<string, any> = {
      // ── Call & Billing ──
      call_type: 'PRIMARY',
      billing_type: 'MED AID',
      med_aid_dec_death: false,

      // ── Incident ──
      incident_location: '123 Main Road, Sandton, Johannesburg, Gauteng, 2196',
      suburb_ward: 'Sandton',
      receiving_facility: 'Milpark Hospital',
      ward: 'Emergency Department',
      receiving_doctor: 'Dr. P. van der Merwe',

      // ── Patient Demographics ──
      gender: 'Male',
      patient_name: 'Thabo',
      patient_surname: 'Mokoena',
      patient_id_number: '8503125432089',
      age: '41',
      patient_dob: '1985-03-12',
      patient_address: '45 Rivonia Boulevard, Sandton',
      patient_suburb: 'Sandton',
      patient_postal_code: '2196',
      patient_phone_cell: '0821234567',
      patient_phone_home: '0111234567',

      // ── Medical Aid ──
      medical_scheme: 'Discovery Health',
      scheme_option: 'Classic Comprehensive',
      medical_aid_number: 'DH12345678',
      dependent_number: '00',
      main_member_id: '8503125432089',
      preauth_number: 'PA-2026-00451',

      // ── Priority & Assessment ──
      priority: 'P2',
      assessment_level: 'ILS',
      monitoring_level: 'ILS',

      // ── Mechanism ──
      mechanism: 'Fall',
      mechanism_other: 'Fell from a 2m ladder while painting at home',

      // ── Chief Complaint & AMPLE ──
      chief_complaint: 'Fall from height — left wrist deformity, pain 8/10',
      findings_on_arrival: 'Patient found seated on ground, cradling left arm. Alert, oriented x4. Visible deformity left distal radius. No LOC reported. No head/spinal tenderness.',
      allergies: 'Penicillin',
      current_medications: 'Amlodipine 5mg daily, Metformin 500mg BD',
      past_medical_history: 'Hypertension, Type 2 DM — well controlled',
      last_meal: 'Breakfast — toast and coffee',
      last_meal_time: '07:30',
      events_hpi: 'Patient was painting the exterior of his house using a ladder. Ladder slipped on wet surface causing patient to fall approximately 2 metres onto paved area, landing on outstretched left hand. Immediate pain and swelling to left wrist. No LOC, no head injury, no back pain.',

      // ── Primary Survey ──
      survey_a: 'Patent, self-maintaining. No stridor.',
      survey_b: 'RR 18, bilateral air entry, SpO₂ 98% RA. No distress.',
      survey_c: 'Radial pulse strong & regular, CRT <2s. No active bleeding. BP 138/82.',
      survey_head_back: 'No tenderness, no deformity. PERRL.',
      survey_neuro: 'GCS 15 (E4 V5 M6). Alert and oriented x4.',
      survey_chest: 'No tenderness. Equal air entry bilaterally.',
      survey_abdo: 'Soft, non-tender. No guarding.',
      survey_limbs: 'Left distal radius — obvious deformity, swelling, TTP. NV intact distally. Right upper and both lower limbs — no injuries.',
      survey_back: 'No tenderness on palpation.',

      // ── Clinical Notes ──
      management_notes: 'Left wrist immobilised with SAM splint and sling. Ice pack applied. Analgesia administered (see medications). NV checks post-splinting — intact. Patient comfortable for transport.',

      // ── ICD-10 ──
      icd10_primary: 'S52.5',
      icd10_secondary: 'W11',

      // ── O₂ Therapy ──
      o2_flow_rate: '',
      o2_device: '',

      // ── Handover ──
      handover_name: 'Sr. N. Dlamini',
      handover_qualification: 'RN',
      handover_doctor_email: 'ed@milpark.co.za',
      handover_notes: 'Stable. Left Colles fracture, splinted. Vitals stable throughout transport. Analgesia given. For X-ray and ortho review.',

      // ── Debtor (same as patient) ──
      debtor_gender: 'Male',
      debtor_name: 'Thabo',
      debtor_surname: 'Mokoena',
      debtor_id_number: '8503125432089',
      debtor_age: '41',
      debtor_dob: '1985-03-12',
      debtor_address: '45 Rivonia Boulevard, Sandton',
      debtor_suburb: 'Sandton',
      debtor_postal_code: '2196',
      debtor_phone_cell: '0821234567',
      debtor_relation: 'Self',

      // ── Crew (auto-filled from session but set fallback) ──
      assessed_by: fd.assessed_by || 'A. Ishwar',
      assessor_qualifications: fd.assessor_qualifications || 'ILS',
      managed_by: fd.managed_by || 'A. Naidu',
      manager_qualifications: fd.manager_qualifications || 'ALS',
      treating_practitioner_name: fd.treating_practitioner_name || 'A. Ishwar',
      treating_practitioner_category: fd.treating_practitioner_category || 'ILS',
      treating_practitioner_hpcsa: fd.treating_practitioner_hpcsa || 'ANA-0049530',
    };

    // ── Vitals (3 sets — meets minimum requirement) ──
    const testVitals = [
      { time: hhmm(t1), bp: '138/82', hr: '92', rr: '18', spo2: '98', temp: '36.8', gcs_e: '4', gcs_v: '5', gcs_m: '6', pupils: 'PERRL', bgl: '6.2', pain: '8' },
      { time: hhmm(t2), bp: '132/78', hr: '88', rr: '16', spo2: '99', temp: '36.7', gcs_e: '4', gcs_v: '5', gcs_m: '6', pupils: 'PERRL', bgl: '6.0', pain: '6' },
      { time: hhmm(t3), bp: '128/76', hr: '84', rr: '16', spo2: '99', temp: '36.6', gcs_e: '4', gcs_v: '5', gcs_m: '6', pupils: 'PERRL', bgl: '5.8', pain: '4' },
    ];

    // ── IV Therapy ──
    const testIv = [
      { type: 'Ringers Lactate', site: 'Right ACF', gauge: '18G', vol_infused: '250ml', rate: 'TKO' },
    ];

    // ── Medications ──
    const testMeds = [
      { type: 'Morphine', dose: '5mg', route: 'IV', time: hhmm(t2) },
      { type: 'Ondansetron', dose: '4mg', route: 'IV', time: hhmm(t2) },
    ];

    setFd(prev => ({ ...prev, ...testFd }));
    setVitals(testVitals);
    setIvRows(testIv);
    setMedRows(testMeds);
    dirtyRef.current = true;
    alert('✅ Test data loaded — Primary + MED AID (Discovery Health)\n\nPatient: Thabo Mokoena — Colles fracture from fall\nScheme: Discovery Health Classic Comprehensive\n\nYou can now step through all phases and submit.');
  };

  // ── Computed smart values ─────────────────────────────────────────────────
  const criticalAlerts = useMemo(() => {
    const alerts: string[] = [];
    if (!vitals.length) return alerts;
    const v = vitals[vitals.length - 1];
    const spo2 = parseFloat(v.spo2), hr = parseFloat(v.hr);
    if (!isNaN(spo2) && spo2 < 90) alerts.push(`SpO₂ ${spo2}% — critical hypoxia`);
    if (!isNaN(hr) && hr > 180) alerts.push(`HR ${hr} bpm — severe tachycardia`);
    if (!isNaN(hr) && hr < 40) alerts.push(`HR ${hr} bpm — severe bradycardia`);
    if (v.bp) { const sys = parseInt(v.bp); if (!isNaN(sys) && sys < 90) alerts.push(`BP ${v.bp} — hypotension`); }
    const gcs = (+v.gcs_e || 0) + (+v.gcs_v || 0) + (+v.gcs_m || 0);
    if (gcs > 0 && gcs < 9) alerts.push(`GCS ${gcs}/15 — severe neurological compromise`);
    return alerts;
  }, [vitals]);

  const allergyAlert = useMemo(() => {
    const a = (fd.allergies || '').trim();
    if (!a) return null;
    if (['none', 'nka', 'nil known', 'no known', 'nkda'].some(t => a.toLowerCase().includes(t))) return null;
    return a;
  }, [fd.allergies]);

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
    const addressKey = `address_${row.timeKey}`;
    const addressVal: string = fd[addressKey] || '';
    const addressInput = (
      <input
        type="text"
        value={addressVal}
        onChange={e => sf(addressKey, e.target.value)}
        onFocus={onF}
        onBlur={onB}
        autoComplete="off"
        aria-label={`${row.label} address`}
        placeholder={timeRowsNarrow ? 'Address' : ''}
        style={{
          width: '100%', padding: '8px 10px', fontSize: '0.78rem',
          borderRadius: 7, border: `1px solid ${S200}`, background: W,
          color: S900, outline: 'none', boxSizing: 'border-box',
          fontFamily: 'inherit',
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
              <button type="button" onClick={() => markTime(row.timeKey, row.kmKey)} style={{ width: '100%', padding: '11px 0', borderRadius: 9, fontSize: '0.8rem', fontWeight: 800, border: `2px solid ${G}`, background: GBG, color: GDK, cursor: 'pointer' }}>Mark Time</button>
            )}
          </div>
          <div style={{ padding: '7px 4px', borderRight: timeRowsNarrow ? 'none' : `1px solid ${S200}`, minWidth: 0 }}>
            <KmInput kmKey={row.kmKey} value={kms[row.kmKey] ?? ''} onChange={handleKmChange} onCommit={handleKmCommit} />
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
          <div style={{ background: '#f0fdf4', border: `2px solid ${G}`, borderRadius: 14, padding: 18, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ fontWeight: 800, color: GDK }}>Vitals Set #{editVital + 1}</div>
              <button type="button" onClick={() => setEditVital(-1)} style={{ padding: '8px 18px', borderRadius: 8, fontSize: '0.82rem', fontWeight: 800, border: 'none', background: G, color: W, cursor: 'pointer' }}>Done</button>
            </div>
            <Lbl t="Time Recorded" />
            <input type="time" value={editing.time ?? ''} onChange={e => updVS('time', e.target.value)} onFocus={onF} onBlur={onB} style={{ ...base, marginBottom: 14 }} />

            {fields.map(f => {
              const hasOpts = 'opts' in f && f.opts;
              const isNumericField = 'type' in f && f.type === 'number';
              const alphaOn = vsAlphaKeys.has(f.key);
              const toggleAlpha = () => setVsAlphaKeys(prev => {
                const next = new Set(prev);
                if (next.has(f.key)) next.delete(f.key); else next.add(f.key);
                return next;
              });
              return (
                <div key={f.key} style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
                    <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{f.label}</div>
                    {isNumericField && !hasOpts && (
                      <div style={{ display: 'inline-flex', borderRadius: 6, border: `1.5px solid ${S200}`, overflow: 'hidden', flexShrink: 0 }}>
                        <button type="button" onClick={() => { if (alphaOn) toggleAlpha(); }} style={{ padding: '2px 9px', fontSize: '0.65rem', fontWeight: 800, border: 'none', background: !alphaOn ? G : W, color: !alphaOn ? W : S600, cursor: 'pointer' }}>123</button>
                        <button type="button" onClick={() => { if (!alphaOn) toggleAlpha(); }} style={{ padding: '2px 9px', fontSize: '0.65rem', fontWeight: 800, border: 'none', background: alphaOn ? G : W, color: alphaOn ? W : S600, cursor: 'pointer' }}>Aa</button>
                      </div>
                    )}
                  </div>
                  {hasOpts ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {f.opts!.map(o => {
                        const on = editing[f.key] === o;
                        return <button key={o} type="button" onClick={() => updVS(f.key, o)} style={{ padding: '9px 14px', borderRadius: 8, fontSize: '0.8rem', fontWeight: 700, border: `2px solid ${on ? G : S200}`, background: on ? GBG : W, color: on ? GDK : S600, cursor: 'pointer', transition: 'all 0.12s' }}>{o}</button>;
                      })}
                    </div>
                  ) : (
                    <input
                      type={isNumericField && !alphaOn ? 'number' : 'text'}
                      inputMode={isNumericField && !alphaOn ? 'decimal' : 'text'}
                      value={editing[f.key] ?? ''}
                      onChange={e => updVS(f.key, e.target.value)}
                      placeholder=""
                      autoComplete="off"
                      onFocus={onF}
                      onBlur={onB}
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
            <button type="button" onClick={() => setEditVital(-1)} style={{ width: '100%', padding: 14, borderRadius: 10, fontWeight: 800, fontSize: '0.92rem', border: 'none', background: `linear-gradient(135deg,${G},${GDK})`, color: W, cursor: 'pointer', marginTop: 4 }}>Save Set #{editVital + 1}</button>
          </div>
        )}

        {editVital < 0 && (
          <button type="button" onClick={() => {
            const t = new Date();
            const newSet = { time: `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` };
            const next = [...vitals, newSet]; setVitals(next); setEditVital(next.length - 1); dirtyRef.current = true;
          }} style={{ width: '100%', padding: 15, borderRadius: 12, fontSize: '0.9rem', fontWeight: 800, border: `2px dashed ${G}`, background: GBG, color: GDK, cursor: 'pointer', marginBottom: 4 }}>
            + Add Vitals Set #{vitals.length + 1}
          </button>
        )}
      </>
    );
  };

  // ── CTA Button ────────────────────────────────────────────────────────────
  const CTA = ({ label, color = G, onClick }: { label: string; color?: string; onClick: () => void }) => (
    <button type="button" onClick={onClick} style={{ width: '100%', padding: 18, borderRadius: 14, fontSize: '1rem', fontWeight: 800, border: 'none', background: `linear-gradient(135deg, ${color}, ${color}cc)`, color: W, cursor: 'pointer', marginTop: 8, boxShadow: `0 6px 20px ${color}40`, letterSpacing: '0.04em' }}>
      {label}
    </button>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE RENDERERS
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Phase 0: DISPATCH ─────────────────────────────────────────────────────
  const P0 = () => (
    <>
      <SHdr t="Call Type" />
      <CallTypePicker />

      {/* Resus Level — surfaces immediately when RESUS is selected, before
          billing type. Crew picks ILS or BLS to declare the resuscitation
          level of care. This is independent of billing type. */}
      {fd.call_type === 'RESUS' && (
        <div style={{ marginBottom: 14 }}>
          <Lbl t="Resus Level" req />
          <Toggle fk="med_aid_resus_level" opts={['ILS', 'BLS']} size="sm" />
        </div>
      )}

      {fd.call_type === 'RHT' && (
        <div style={{ marginBottom: 14 }}>
          <Lbl t="Call Out Fee" />
          <Sel
            fk="rht_call_out_fee"
            opts={['Standard', 'After Hours', 'Public Holiday', 'Standby Cancellation', 'No Patient Loaded', 'None']}
          />
        </div>
      )}

      {fd.call_type === 'IHT' && (
        <>
          <div style={{ marginBottom: 14 }}>
            <Lbl t="Why is this an IFT/IHT call?" req />
            <ComboInp
              fk="transfer_subtype"
              opts={[
                'Return Trip',
                'Social Transfer',
                'Upgrade Transfer',
                'Downgrade Transfer',
                'Hospital to Hospital',
                'Hospital to Residence',
                'Hospital to Stepdown',
                'Residence to Hospital',
                'Psychiatric',
              ]}
              listId="transfer-subtype-list"
              ph="Type or pick a reason…"
            />
          </div>

          <div style={{ marginBottom: 14 }}>
            <Lbl t="Quoted Payout Amount (R)" />
            <Inp fk="med_aid_quoted_amount" ph="0.00 — leave blank if not quoted" />
          </div>
        </>
      )}

      {['IHT', 'IFT'].includes(fd.call_type) && (
        <div style={{ marginBottom: 14 }}>
          <Lbl t="Pre-Auth No." req />
          <Inp fk="preauth_number" ph="Pre-authorisation reference" />
        </div>
      )}

      {/* Dispatch Times: DoD / RESUS calls embed the same rows inside their
          dedicated panel, so they're skipped here to avoid a duplicate widget
          on the same shared state. Billing Type has moved to Phase 2. */}
      {!fd.med_aid_dec_death && fd.call_type !== 'RESUS' && (
        <>
          <SHdr t="Dispatch Times" />
          {TimeTable({ rows: ALL_TIME_ROWS.filter(r => r.phase === 0 || r.phase === 2) })}
        </>
      )}

      {/* PRIMARY and COURTESY calls surface the clinical section inline so
          the crew can run the patient assessment without leaving Dispatch
          — same pattern as RESUS. Only shows after Dispatch and On Scene times & KMs are filled. */}
      {(fd.call_type === 'PRIMARY' || fd.call_type === 'COURTESY') && timestamps.time_dispatched && fd.km_dispatched && timestamps.time_on_scene && fd.km_on_scene && P3(true)}

      {/* Standalone slot for the DoD / Resus billing subsections. Fires
          for any billing channel once a Declaration of Death is flagged
          or the call type is RESUS — the Resus Level and embedded
          dispatch times surface through MedAidMore. */}
      {/* MedAidMore: shows for DoD (any billing type) and for RESUS (immediately
          — no billing_type gate, since Resus Level is needed before billing). */}
      {(fd.med_aid_dec_death || fd.call_type === 'RESUS') && (
        <Card>
          <MedAidMore />
        </Card>
      )}

      {/* Resus: surface the full clinical section only once On Scene is marked
          so the section doesn't pop in immediately on call-type selection. */}
      {fd.call_type === 'RESUS' && timestamps.time_dispatched && fd.km_dispatched && timestamps.time_on_scene && fd.km_on_scene && P3(true)}

      {/* IFT/IHT: inter-facility transfers — clinical section appears
          once On Scene time is marked. */}
      {['IHT', 'IFT'].includes(fd.call_type) && timestamps.time_dispatched && fd.km_dispatched && timestamps.time_on_scene && fd.km_on_scene && P3(true)}

      {/* RHT: clinical section appears once On Scene time is marked. */}
      {fd.call_type === 'RHT' && timestamps.time_dispatched && fd.km_dispatched && timestamps.time_on_scene && fd.km_on_scene && P3(true)}

      {/* Resus that fails — collapsible Declaration of Death tag at the
          bottom of the clinical section. Click toggles the DoD form open
          inline so the crew can fill it without leaving the dispatch
          screen. State lives in `fd.med_aid_dec_death` and is shared with
          the MedAidMore mount, so toggling here also reflects elsewhere. */}
      {fd.call_type === 'RESUS' && (
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

      {/* Hide Patient Information CTA until clinical data is inserted, 
          unless the patient was declared deceased on scene (where clinical is skipped). */}
      {(fd.med_aid_dec_death || !!fd.chief_complaint) && (
        CTA({ label: "Patient Information  →", onClick: () => advancePhase(2) })
      )}
    </>
  );

  // ── Phase 1: EN ROUTE ─────────────────────────────────────────────────────
  const P1 = () => (
    <>
      <SHdr t="En Route" />
      {TimeTable({ rows: ALL_TIME_ROWS.filter(r => r.phase === 1) })}

      <SHdr t="Call Information" />
      <Card>
        <Lbl t="Incident Address" /><AddrInp fk="incident_location" ph="e.g. Chatsmed Hospital" suburbKey="suburb_ward" />
        <Lbl t="Suburb / Ward" /><Inp fk="suburb_ward" ph="e.g. ICU" />
        {!fd.med_aid_dec_death && (
          <>
            <Lbl t="Referring Dr" /><Inp fk="referring_doctor" ph="e.g. Dr R.K. Naidoo" />
          </>
        )}
        <Lbl t="Destination" req /><AddrInp fk="receiving_facility" ph="e.g. Capital Hospital" req />
        {!fd.med_aid_dec_death && (
          <>
            <Lbl t="Ward" /><Inp fk="ward" ph="e.g. C.I.C.U" />
            <Lbl t="Receiving Dr" /><Inp fk="receiving_doctor" ph="e.g. Dr R.K. Naidoo" />
          </>
        )}
      </Card>

      {CTA({ label: "ON SCENE  →", onClick: () => advancePhase(2, 'time_on_scene', 'km_on_scene') })}
    </>
  );

  // ── Phase 2: ON SCENE ─────────────────────────────────────────────────────
  const P2 = () => (
    <>
      {/* Arrival timetable + Patient Priority are skipped for Declaration
          of Death — the Dispatch + On Scene timestamps are already captured
          in the DoD panel, and triage priority doesn't apply once the
          patient is deceased. */}
      {!fd.med_aid_dec_death && (
        <>
          {/* On Scene row is captured up-front on the Dispatch screen for
              PRIMARY calls (see the Dispatch Times block below Billing
              Type), so re-rendering it here would duplicate the same
              widget on shared state. */}
          {fd.call_type !== 'PRIMARY' && (
            <>
              <SHdr t="Arrival" />
              {TimeTable({ rows: ALL_TIME_ROWS.filter(r => r.phase === 2) })}
            </>
          )}

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
        <Lbl t="Residential Address" /><AddrInp fk="patient_address" ph="Street address" suburbKey="patient_suburb" />
        <G2>
          <div><Lbl t="Suburb" /><Inp fk="patient_suburb" ph="Suburb" /></div>
          <div><Lbl t="Code" /><Inp fk="patient_postal_code" ph="Code" /></div>
        </G2>
      </Card>

      {/* ── Billing details ────────────────────────────────────────────────
          The Billing Type selector and all channel-specific detail cards
          live here on Phase 2 so the crew completes triage and patient
          info before being asked to fill billing details. */}
      <SHdr t="Billing Type" />
      <BillingTypePicker />

      {fd.billing_type === 'PVT' && (
        <>
          <SHdr t="Private (PVT) Billing" />
          <Card>
            <Lbl t="Payment Method" req />
            <Toggle fk="pvt_payment_method" opts={['Cash', 'Card', 'EFT', 'Account', 'Indigent']} />
            <Lbl t="Account Holder Full Name" req /><Inp fk="pvt_account_holder" ph="Person responsible for payment" req />
            <G2>
              <div><Lbl t="Account Holder ID Number" /><Inp fk="pvt_account_holder_id" ph="13-digit SA ID" /></div>
              <div><Lbl t="Contact Number" req /><Inp fk="pvt_account_holder_phone" type="tel" ph="082 ..." req /></div>
            </G2>
            <Lbl t="Billing Address" /><AddrInp fk="pvt_account_holder_address" ph="For invoice delivery" />
          </Card>
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

            {fd.call_type !== 'RESUS' && <MedAidMore />}
          </Card>
        )}

        {fd.billing_type === 'IOD' && (
          <Card>
            <Lbl t="Employer Name" req /><Inp fk="wca_employer" ph="e.g. Eskom Holdings" req />
            <Lbl t="Compensation Reference" req /><Inp fk="compensation_reference" ph="IOD claim / reference number" req />
            <G2>
              <div><Lbl t="Date of Injury" req /><Inp fk="wca_injury_date" type="date" req /></div>
              <div><Lbl t="Employee Number" /><Inp fk="wca_employee_number" ph="Optional" /></div>
            </G2>
            <Lbl t="OAR Number" /><Inp fk="wca_oar_number" ph="Occupational Accident Report number" />
            <PdfDrop fk="wca_oar_report_pdf" />
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

        {fd.billing_type === 'EVENT' && (
          <Card>
            <Lbl t="Event Name" req /><Inp fk="event_name" ph="e.g. Comrades Marathon 2026" req />
            <G2>
              <div><Lbl t="Organiser / Client" req /><Inp fk="event_organiser" ph="Hosting company" req /></div>
              <div><Lbl t="Event Date" /><Inp fk="event_date" type="date" /></div>
            </G2>
            <Lbl t="Booking Reference" /><Inp fk="event_booking_ref" ph="Standby / event contract no." />
            <Lbl t="On-Site Contact" /><Inp fk="event_contact_person" ph="Name of organiser rep on scene" />
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
            <Lbl t="Residential Address" /><AddrInp fk="debtor_address" ph="Street address" suburbKey="debtor_suburb" />
            <G2>
              <div><Lbl t="Suburb" /><Inp fk="debtor_suburb" ph="Suburb" /></div>
              <div><Lbl t="Code" /><Inp fk="debtor_postal_code" ph="Code" /></div>
            </G2>
          </Card>
        )}

      </>)}

      <Lbl t="Persons Accompanying Patient in Ambulance" />
      <Inp fk="accompanying_persons_count" type="number" ph="0" />

      {/* Declaration of Death short-circuits the Clinical phase — the
          patient is deceased so there's no assessment / vitals / meds to
          record. The Undertaker handover happens at the scene, so the
          form lives here and the CTA jumps straight to Complete. */}
      {fd.med_aid_dec_death && (
        <>
          <SHdr t="Undertaker" />
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
        </>
      )}

      {fd.med_aid_dec_death ? (
        <>
          {/* Capture the crew's "Available" time before submitting so the
              shift's end-of-call timestamp is on the PRF. The same row
              normally lives on the Complete phase, which is hidden for DoD. */}
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
            <Inp fk="rht_waiver_signatory_name" ph="Full name" />
            <div style={{ marginBottom: 14 }}>
              <SignaturePad
                label="Patient / Responsible Person Signature"
                value={sigs.patient_signature}
                onChange={v => { setSigs(p => ({ ...p, patient_signature: v })); dirtyRef.current = true; }}
              />
            </div>

            <Lbl t="Witness" />
            <Inp fk="rht_waiver_witness_name" ph="Witness full name" />
            <div style={{ marginBottom: 14 }}>
              <SignaturePad
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
        CTA({ label: "DEPART SCENE  →", onClick: () => advancePhase(4) })
      )}
    </>
  );

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

        {/* Assessment level — prominent.
            Hidden for Resus calls: the assessment level is implicit (ILS / ALS
            picked on the Resus subsection at dispatch). */}
        {fd.call_type !== 'RESUS' && (
          <div style={{ background: GBG, border: `1.5px solid ${G}30`, borderRadius: 14, padding: 18, marginBottom: 20 }}>
            <G2>
              <div><SHdr t="Assessment" /><Toggle fk="assessment_level" opts={['BLS', 'ILS', 'ALS']} /></div>
              <div><SHdr t="Monitoring" /><Toggle fk="monitoring_level" opts={['BLS', 'ILS', 'ALS']} /></div>
            </G2>
            {(() => {
              const RANK: Record<string, number> = { BLS: 0, ILS: 1, ALS: 2 };
              const a = RANK[fd.assessment_level];
              const m = RANK[fd.monitoring_level];
              if (a === undefined || m === undefined || a === m) return null;
              const upgrade = m > a;
              return (
                <div role="alert" style={{
                  marginTop: 14,
                  padding: '12px 14px',
                  borderRadius: 10,
                  border: `1.5px solid ${upgrade ? '#f59e0b' : '#3b82f6'}`,
                  background: upgrade ? 'rgba(245,158,11,0.10)' : 'rgba(59,130,246,0.08)',
                  color: upgrade ? '#7c2d12' : '#1e3a8a',
                  display: 'flex', gap: 10, alignItems: 'flex-start',
                  fontSize: '0.82rem', lineHeight: 1.5, fontWeight: 600,
                }}>
                  <span style={{ fontSize: '1rem', flexShrink: 0 }}>{upgrade ? '↑' : '↓'}</span>
                  <span>
                    {upgrade ? (
                      <>
                        Monitoring at <b>{fd.monitoring_level}</b> exceeds the assessed level of <b>{fd.assessment_level}</b>.
                        Call dispatch to <b>upgrade the call</b> to {fd.monitoring_level}.
                      </>
                    ) : (
                      <>
                        Monitoring at <b>{fd.monitoring_level}</b> is below the assessed level of <b>{fd.assessment_level}</b>.
                        Call dispatch to <b>downgrade the call</b> to {fd.monitoring_level}.
                      </>
                    )}
                  </span>
                </div>
              );
            })()}
          </div>
        )}

        <SHdr t="Patient History" />
        <Card>
          <Lbl t="Chief Complaint / Signs and Symptoms" req /><VoiceTxt fk="chief_complaint" ph="Patient's primary complaint, signs and symptoms..." rows={2} />
          <Lbl t="Findings on Arrival" /><VoiceTxt fk="findings_on_arrival" ph="What you observed on arrival..." rows={2} />
          <Lbl t="Allergies" req /><Inp fk="allergies" ph="Known allergies (or None Known)" req />
          <Lbl t="Current Medications" /><Txt fk="current_medications" ph="List current medications..." rows={2} />
          <Lbl t="Past Medical / Surgical History" /><Txt fk="past_medical_history" ph="Relevant past history..." rows={2} />
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
            <div><Lbl t="Flow Rate (L/Min)" /><Inp fk="o2_flow_rate" ph="e.g. 15" type="number" /></div>
            <div><Lbl t="Device" /><Sel fk="o2_device" opts={['Mask', 'Nasal Cannula', 'Non-Rebreather', 'BVM', 'Nebuliser', 'Other']} /></div>
            <div><Lbl t="Start Time" /><Inp fk="o2_start_time" type="time" /></div>
            <div><Lbl t="Stop Time" /><Inp fk="o2_stop_time" type="time" /></div>
          </G2>
          <Lbl t="BVM" /><Inp fk="o2_bvm" ph="Rate (bpm) / notes" />
        </Card>

        <SHdr t="Airway" />
        <Card>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
            {['Self-maintained', 'Suction', 'OP Airway', 'Supraglottic Airway', 'Intubation', 'Chest Decompression', 'Surg. Airway'].map(i => {
              const cat = normaliseHpcsaCategory(fd.treating_practitioner_category);
              const verdict = scopeForFormLabel(i, cat);
              const disabled = verdict.kind === 'unauthorised';
              const hint = verdict.kind === 'authorised' && verdict.condition
                ? 'Senior ECP / MO consultation required'
                : undefined;
              return <Chk key={i} fk="airway_interventions" val={i} disabled={disabled} hint={hint} />;
            })}
          </div>
          {inArr('airway_interventions', 'OP Airway') && (
            <div style={{ padding: 14, background: GBG, borderRadius: 10, marginBottom: 14, border: `1px solid ${G}30` }}>
              <Lbl t="OP Airway Size" /><Inp fk="op_airway_size" ph="e.g. 3 / 80mm" />
            </div>
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
          <Lbl t="NG Tube Size" /><ScopedInp fk="ng_tube_size" capabilityKey="airway_oro_nasogastric_tube" ph="Size if applicable" />
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
              'CPR', 'Bleeding',
            ].map(i => {
              const cat = normaliseHpcsaCategory(fd.treating_practitioner_category);
              const verdict = scopeForFormLabel(i, cat);
              const disabled = verdict.kind === 'unauthorised';
              const hint = verdict.kind === 'authorised' && verdict.condition
                ? 'Senior ECP / MO consultation required'
                : undefined;
              return <Chk key={i} fk="circulation_interventions" val={i} disabled={disabled} hint={hint} />;
            })}
            {inArr('circulation_interventions', 'Bleeding') && (
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
                { l: 'Vol. Infused', k: 'vol_infused' },
                { l: 'Time Up', k: 'time_up' },
              ] as Array<{ l: string; k: string; opts?: string[] }>).map(f => (
                <div key={f.k}>
                  <Lbl t={f.l} />
                  {f.opts ? (
                    <select
                      value={row[f.k] ?? ''}
                      onChange={e => { const r = [...ivRows]; r[i] = { ...r[i], [f.k]: e.target.value }; setIvRows(r); dirtyRef.current = true; }}
                      onFocus={onF}
                      onBlur={onB}
                      style={{ ...base, marginBottom: 8, appearance: 'auto' }}
                    >
                      <option value=""></option>
                      {f.opts.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input
                      value={row[f.k] ?? ''}
                      onChange={e => { const r = [...ivRows]; r[i] = { ...r[i], [f.k]: e.target.value }; setIvRows(r); dirtyRef.current = true; }}
                      onFocus={onF}
                      onBlur={onB}
                      autoComplete="off"
                      style={{ ...base, marginBottom: 8 }}
                    />
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
        <button type="button" onClick={() => setCrewPicker({ phase: 'select', kind: 'iv' })} style={{ width: '100%', padding: 12, borderRadius: 10, fontWeight: 800, fontSize: '0.88rem', border: `2px dashed ${G}`, background: GBG, color: GDK, cursor: 'pointer', marginBottom: 20 }}>+ Add IV Line</button>

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
              <datalist id="med-drug-options">
                {authorised.map(n => <option key={n} value={n} />)}
              </datalist>
              {cat && (
                <div style={{ fontSize: '0.7rem', color: S600, marginBottom: 8, fontWeight: 600 }}>
                  Showing {authorised.length} medications authorised for {cat}.
                </div>
              )}
            </>
          );
        })()}
        {medRows.map((row, i) => {
          // Out-of-scope check for the medication's current treating practitioner.
          // Only flags rows where the typed drug matches a known catalogue entry
          // — free-text drugs (off-catalogue) are intentionally not checked per
          // the rollout decision. Triggers when the treating practitioner is
          // changed mid-call to a category that can't administer this drug.
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
                {[{ l: 'Drug / Type', k: 'type' }, { l: 'Route', k: 'route' }, { l: 'Dose', k: 'dose' }, { l: 'Time', k: 'time' }].map(f => (
                  <div key={f.k}><Lbl t={f.l} /><input
                    list={f.k === 'type' ? 'med-drug-options' : undefined}
                    autoComplete="off"
                    value={row[f.k] ?? ''}
                    onChange={e => { const r = [...medRows]; r[i] = { ...r[i], [f.k]: e.target.value }; setMedRows(r); dirtyRef.current = true; }}
                    onFocus={onF}
                    onBlur={e => {
                      onB(e);
                      // Free-text scope enforcement for the Drug/Type field.
                      // The datalist hides unauthorised meds but the input still
                      // accepts any typed value — so a determined BAA crew could
                      // type "Adrenaline" by hand. On blur, if the typed value
                      // matches a known catalogue drug that ISN'T authorised for
                      // the current treating practitioner, silently clear it. No
                      // popup (per the no-mid-call-validation rule); the empty
                      // field is the feedback. Off-catalogue free-text (brand
                      // names, abbreviations) still passes through since
                      // findMedicationByName returns undefined for those.
                      if (f.k !== 'type') return;
                      const typed = e.target.value.trim();
                      if (!typed) return;
                      const med = findMedicationByName(typed);
                      const tc = normaliseHpcsaCategory(fd.treating_practitioner_category);
                      if (med && tc && !med.authorised.includes(tc)) {
                        const r = [...medRows];
                        r[i] = { ...r[i], type: '' };
                        setMedRows(r);
                        dirtyRef.current = true;
                      }
                    }}
                    style={{ ...base, marginBottom: 8 }}
                  /></div>
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
        <button type="button" onClick={() => setCrewPicker({ phase: 'select', kind: 'med' })} style={{ width: '100%', padding: 12, borderRadius: 10, fontWeight: 800, fontSize: '0.88rem', border: `2px dashed ${G}`, background: GBG, color: GDK, cursor: 'pointer', marginBottom: 20 }}>+ Add Medication</button>

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
          {/* Destination confirmation */}
          <Card>
            <Lbl t="Destination" /><AddrInp fk="receiving_facility" ph="e.g. Capital Hospital" />
            <G2>
              <div><Lbl t="Ward / Unit" /><Inp fk="ward" ph="e.g. C.I.C.U" /></div>
              <div><Lbl t="Receiving Practitioner" /><Inp fk="receiving_doctor" ph="Practitioner Name" /></div>
            </G2>
          </Card>

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

          <SHdr t="Management Notes" />
          <VoiceTxt fk="management_notes" ph="Full clinical narrative — care provided, patient response, interventions..." rows={6} />
      </>

      {CTA({ label: "AT DESTINATION  →", color: "#7c3aed", onClick: () => advancePhase(5) })}
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
            <Lbl t="Handed Over To" /><Inp fk="handover_name" ph="Receiving person's full name" />
            <Lbl t="Qualification" /><Inp fk="handover_qualification" ph="e.g. RN, Dr, Paramedic" />
            <Lbl t="Receiving Facility Email" /><Inp fk="handover_doctor_email" ph="dr@hospital.co.za" type="email" />
            <Lbl t="Condition on Handover" /><Txt fk="handover_notes" ph="Patient condition at time of handover..." rows={2} />
            <div style={{ marginTop: 14 }}>
              <Lbl t="Hospital Sticker" />
              <StickerCameraCapture
                value={fd.hospital_sticker}
                onChange={v => sf('hospital_sticker', v)}
              />
            </div>
            <div style={{ marginTop: 14 }}>
              <FullscreenSignaturePad
                label="Handover Signature"
                value={sigs.handover_signature}
                onChange={v => { setSigs(p => ({ ...p, handover_signature: v })); dirtyRef.current = true; }}
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
                    <select
                      value={row.route ?? ''}
                      onChange={e => updateRow(i, 'route', e.target.value)}
                      onFocus={onF}
                      onBlur={onB}
                      style={{ ...base, marginBottom: 8, appearance: 'auto' }}
                    >
                      <option value=""></option>
                      {ROUTES.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                </DodG2>
              </Card>
            ))}
            <button type="button" onClick={addRow} style={{ width: '100%', padding: 12, borderRadius: 10, fontWeight: 800, fontSize: '0.88rem', border: `2px dashed ${G}`, background: GBG, color: GDK, cursor: 'pointer', marginBottom: 20 }}>+ Add Drug</button>
          </>
        );
      })()}

      <SHdr t={['IHT', 'IFT'].includes(fd.call_type) ? "Additional Documents / Nursing Notes" : "Additional Documents"} />
      <Card>
        <DocumentsCapture
          value={fd.additional_documents}
          onChange={v => sf('additional_documents', v)}
        />
      </Card>

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
          {(fd.billing_type === 'IOD' || fd.billing_type === 'RAF') && (
            <><Lbl t="Reference Number" /><Inp fk="compensation_reference" ph="Reference number" /></>
          )}
        </Card>
      )}

      <SHdr t="Valuables" />
      <Card>
        <Lbl t="Valuables Handed To" /><Inp fk="valuables_handed_to" ph="Name of person receiving valuables" />
        <Lbl t="Description" /><Txt fk="valuables_description" ph="List valuables..." rows={2} />
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
              <div style={{ background: GBG, border: `1.5px solid ${G}30`, borderRadius: 13, padding: 16 }}>
                <div style={{ fontSize: '0.62rem', fontWeight: 800, color: GDK, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Crew 1</div>
                <div style={{ fontWeight: 800, color: S900 }}>{profile.name}</div>
                <div style={{ fontSize: '0.7rem', color: S600, marginTop: 3, fontFamily: 'monospace' }}>{profile.hpcsa_number || '—'}</div>
                <div style={{ fontSize: '0.7rem', color: S600, marginTop: 2 }}>{profile.qualification}</div>
              </div>
              <div style={{ background: 'rgba(245,158,11,0.07)', border: '1.5px solid rgba(245,158,11,0.25)', borderRadius: 13, padding: 16 }}>
                <div style={{ fontSize: '0.62rem', fontWeight: 800, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Crew 2</div>
                {crew2 ? (<><div style={{ fontWeight: 800, color: S900 }}>{crew2.full_name}</div><div style={{ fontSize: '0.7rem', color: S600, marginTop: 3, fontFamily: 'monospace' }}>{crew2.hpcsa_number || '—'}</div><div style={{ fontSize: '0.7rem', color: S600, marginTop: 2 }}>{crew2.qualification}</div></>) : <div style={{ fontSize: '0.82rem', color: S400, marginTop: 8 }}>Not assigned</div>}
              </div>
            </div>

            <Card>
              <G2>
                <div><Lbl t="Assessed By" /><Inp fk="assessed_by" ph={profile.name || 'Full name'} /></div>
                <div><Lbl t="Qualifications" /><Inp fk="assessor_qualifications" ph={profile.qualification || 'e.g. ILS'} /></div>
                <div><Lbl t="Managed By" /><Inp fk="managed_by" ph={profile.name || 'Full name'} /></div>
                <div><Lbl t="Qualifications" /><Inp fk="manager_qualifications" ph={profile.qualification || 'e.g. ALS'} /></div>
              </G2>
            </Card>

            <SHdr t="Final Management Notes" />
            <VoiceTxt fk="management_notes" ph="Full clinical narrative — complete account of care provided..." rows={6} />

            <SHdr t="Signatures" />
            {[
              { sk: 'patient_signature', l: 'Patient / Guardian Signature' },
              { sk: 'witness_signature', l: 'Witness Signature' },
              { sk: 'crew_signature', l: 'Crew Member Signature' },
              { sk: 'handover_signature', l: 'Practitioner Signature' },
            ]
              // When Declaration of Death is selected the patient is deceased,
              // so the patient/guardian signature is meaningless — hide it.
              .filter(({ sk }) => !(fd.med_aid_dec_death && sk === 'patient_signature'))
              .map(({ sk, l }) => (
                <Card key={sk}>
                  <SignaturePad label={l} value={sigs[sk]} onChange={v => { setSigs(p => ({ ...p, [sk]: v })); dirtyRef.current = true; }} />
                </Card>
              ))}

            {!fd.med_aid_dec_death && (
              <div style={{ padding: '14px 16px', background: GBG, borderRadius: 12, border: `1.5px solid ${G}30`, marginBottom: 20, marginTop: 4 }}>
                <div style={{ fontWeight: 600, fontSize: '0.8rem', color: GDK, lineHeight: 1.5 }}>
                  By signing, the patient / representative acknowledges responsibility for all payments associated with the treatment and transport provided by JEMS Medical Services.
                </div>
              </div>
            )}
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
    if (!vitals.length) return null;
    const last = vitals[vitals.length - 1];
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
  }, [vitals, timestamps.time_dispatched]);

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
    <FormContext.Provider value={{ fd, sf, inArr, toggleArr, profile, prfMeta, renderDispatchTimes: () => TimeTable({ rows: ALL_TIME_ROWS.filter(r => r.phase === 0 || r.phase === 2) }) }}>
      <div style={{ minHeight: '100vh', maxWidth: '100vw', overflowX: 'clip', background: S50, color: S900, paddingBottom: 100, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' }}>

        {/* ── DEV: Fill Test Data button ── */}
        {import.meta.env.DEV && (
          <button
            type="button"
            onClick={fillTestData}
            style={{
              position: 'fixed', bottom: 80, right: 16, zIndex: 9999,
              width: 48, height: 48, borderRadius: '50%',
              background: 'linear-gradient(135deg, #7c3aed, #4f46e5)',
              color: '#fff', border: 'none', cursor: 'pointer',
              boxShadow: '0 4px 16px rgba(79,70,229,0.4)',
              fontSize: '1.2rem', fontWeight: 900,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            title="Fill test data (Primary + MED AID)"
          >🧪</button>
        )}
        {/* ── Sticky header — fancy journey-phase bar ──
          Gradient backdrop, glossy nodes with subtle inner highlight, active
          step lifted with a brand-green halo ring, completed steps filled
          with a green→teal gradient and a checkmark, connectors blend
          smoothly between filled and pending states.
          Now shown on brand-new PRFs (phase 0 / Dispatch) as well. */}
        {phase >= 0 && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 50,
          width: 'min(760px, calc(100% - 32px))', margin: '0 auto',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(248,250,252,0.96) 100%)',
          backdropFilter: 'blur(14px)',
          WebkitBackdropFilter: 'blur(14px)',
          border: `1px solid ${S200}`,
          borderRadius: 16,
          boxShadow: '0 6px 24px rgba(15,23,42,0.08)',
        }}>
          <div style={{ padding: '14px 18px 10px' }}>
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
                        width: 34, height: 34, borderRadius: 999, flexShrink: 0,
                        background: nodeFill,
                        border: `1.5px solid ${nodeBorder}`,
                        color: nodeColor,
                        fontSize: '0.74rem', fontWeight: 900,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer',
                        boxShadow: nodeShadow,
                        transition: 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
                        transform: active ? 'scale(1.08)' : 'scale(1)',
                        padding: 0,
                      }}
                    >
                      {done ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
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
            <div style={{ display: 'flex', marginTop: 8 }}>
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

        {/* ── Validation banner (rule findings from prfValidation.ts) ── */}
        {findings.length > 0 && (
          <div id="prf-validation-banner" style={{ padding: '16px 18px 0', maxWidth: 640, margin: '0 auto' }}>
            {validationBlockers(findings).length > 0 && (
              <div style={{
                background: '#fef2f2', border: `1px solid #fecaca`, borderRadius: 12,
                padding: '12px 14px', marginBottom: 8,
              }}>
                <div style={{ fontSize: '0.78rem', fontWeight: 800, color: REDC, marginBottom: 6, letterSpacing: '0.02em' }}>
                  {validationBlockers(findings).length} required item{validationBlockers(findings).length === 1 ? '' : 's'} missing
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.78rem', color: '#7f1d1d', lineHeight: 1.5 }}>
                  {validationBlockers(findings).map(f => (
                    <li key={f.id} style={{ marginBottom: 4 }}>
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
                  {validationWarnings(findings).length} warning{validationWarnings(findings).length === 1 ? '' : 's'} — claim may be downgraded if not addressed
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.78rem', color: '#78350f', lineHeight: 1.5 }}>
                  {validationWarnings(findings).map(f => (
                    <li key={f.id} style={{ marginBottom: 4 }}>
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
        <div style={{ padding: '20px 18px', maxWidth: 640, margin: '0 auto', overflowAnchor: 'none' }}>
          {renderPhase()}
        </div>

        {/* ── Floating quick-vitals button (clinical & transport phases) ── */}
        {(phase === 3 || phase === 4) && !quickVital && (
          <button type="button" onClick={() => setQV(true)} style={{ position: 'fixed', bottom: 90, right: 18, zIndex: 100, width: 56, height: 56, borderRadius: 28, background: `linear-gradient(135deg,${G},${GDK})`, border: 'none', color: W, fontSize: '0.65rem', fontWeight: 900, cursor: 'pointer', boxShadow: `0 4px 20px ${G}55`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, lineHeight: 1 }}>
            <span style={{ fontSize: '1.2rem', lineHeight: 1 }}>+</span>
            <span style={{ fontSize: '0.5rem', letterSpacing: '0.04em' }}>VITALS</span>
          </button>
        )}

        {/* ── Vitals reminder pill — interval driven by assessment_level
            (BLS 20m / ILS 15m / ALS 10m). Hidden on Complete phase. ── */}
        {phase < 6 && <VitalsReminder lastVitalAt={lastVitalAt} level={fd.assessment_level} onClick={jumpToVitals} />}

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
              onConfirm={async () => {
                const { timeKey, kmKey, coords, address, onAfterCommit } = pendingMark;
                setPendingMark(null);
                // Auto-fill the resolved address into the target field — but
                // only if the field is currently empty. The crew already saw
                // the address in the overlay; this is the "place into field
                // for review" step.
                if (target && address && !targetOccupied) {
                  sf(target.addressKey, address.street);
                  if (target.suburbKey && address.suburb && !fd[target.suburbKey]) {
                    sf(target.suburbKey, address.suburb);
                  }
                }
                // Also seed the per-row address field shown in the time
                // table (one input per timestamp). If the crew already typed
                // a manual address in that row before tapping Mark Time,
                // don't overwrite it.
                const rowAddressKey = `address_${timeKey}`;
                if (address && !fd[rowAddressKey]) {
                  sf(rowAddressKey, address.street);
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
          return (
            <div
              onClick={close}
              style={{
                position: 'fixed', inset: 0, zIndex: 200, padding: 16,
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
                    ? <>The reading you entered for <b>{kmConfirm.label}</b> is <b>lower</b> than the previous reading. Odometers don't go backwards — please double-check.</>
                    : <>The distance between readings is unusually large. Please confirm before continuing.</>}
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
                      color: rollback ? REDC : '#92400e',
                    }}>{kmConfirm.delta > 0 ? '+' : ''}{kmConfirm.delta.toLocaleString()} km</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    onClick={clearAndReenter}
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
                      const existing: any[] = Array.isArray(fd.km_review_flags) ? fd.km_review_flags : [];
                      const newFlag = {
                        field: kmConfirm.kmKey,
                        prev_field: kmConfirm.previousKey,
                        delta: kmConfirm.delta,
                        acknowledged: true,
                        timestamp: new Date().toISOString(),
                      };
                      sf('km_review_flags', [...existing, newFlag]);
                      close();
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
            </div>
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
          const opts: Array<{ id: string; tag: string; name: string; qualification: string; hpcsa: string; accent: string; bg: string; border: string }> = [];
          const c1Name = prfMeta.crew_member_1?.full_name || profile.name || '';
          if (c1Name) opts.push({
            id: 'crew1', tag: 'Crew 1',
            name: c1Name,
            qualification: prfMeta.crew_member_1?.qualification || profile.qualification || '',
            hpcsa: prfMeta.crew_member_1?.hpcsa_number || profile.hpcsa_number || '',
            accent: GDK, bg: GBG, border: `${G}55`,
          });
          const c2 = prfMeta.crew_member_2;
          if (c2?.full_name) opts.push({
            id: 'crew2', tag: 'Crew 2',
            name: c2.full_name,
            qualification: c2.qualification || '',
            hpcsa: c2.hpcsa_number || '',
            accent: '#92400e', bg: 'rgba(245,158,11,0.07)', border: 'rgba(245,158,11,0.35)',
          });
          const advance = (o: typeof opts[number]) => {
            if (crewPicker.kind === 'treating') {
              // Treating gate: write the identity straight into form_data —
              // autosave persists it, scope enforcement reads it. No signature
              // step; tapping IS the audit trail.
              sf('treating_practitioner_name', o.name);
              sf('treating_practitioner_category', o.qualification);
              sf('treating_practitioner_hpcsa', o.hpcsa);
              setCrewPicker(null);
              return;
            }
            // IV / Medication flow — proceed to the signature step.
            setCrewPicker({
              phase: 'signing',
              kind: crewPicker.kind,
              crew: { name: o.name, qualification: o.qualification, hpcsa: o.hpcsa },
            });
          };
          return (
            <div
              onClick={() => { if (!isTreating) setCrewPicker(null); }}
              style={{
                position: 'fixed', inset: 0, zIndex: 200, padding: 16,
                background: 'rgba(15,23,42,0.55)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <div
                onClick={e => e.stopPropagation()}
                style={{
                  maxWidth: 480, width: '100%',
                  background: '#fff', borderRadius: 16, padding: 22,
                  boxShadow: '0 20px 60px rgba(15,23,42,0.35)',
                }}
              >
                <div style={{ fontWeight: 900, fontSize: '1.05rem', color: S900, marginBottom: 6 }}>
                  {isTreating
                    ? 'Who is treating this patient?'
                    : `Who is administering this ${kindLabel}?`}
                </div>
                <div style={{ fontSize: '0.8rem', color: S600, marginBottom: 16, lineHeight: 1.45 }}>
                  {isTreating
                    ? 'Required before the clinical section can be filled in. Your HPCSA registration determines which procedures and medications can be recorded.'
                    : "Tap the crew member responsible. They'll be asked to sign on the next step to verify."}
                </div>
                {opts.length === 0 ? (
                  <div style={{ padding: 14, background: '#fef2f2', border: `1.5px solid ${REDC}40`, borderRadius: 10, fontSize: '0.82rem', color: REDC, marginBottom: 14 }}>
                    No crew profile loaded yet. Open the PRF from your dashboard so Crew 1 / Crew 2 are set.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: 10, marginBottom: 14 }}>
                    {opts.map(o => (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => advance(o)}
                        style={{
                          textAlign: 'left', cursor: 'pointer',
                          background: o.bg, border: `1.5px solid ${o.border}`,
                          borderRadius: 13, padding: '14px 16px',
                        }}
                      >
                        <div style={{ fontSize: '0.62rem', fontWeight: 800, color: o.accent, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>{o.tag}</div>
                        <div style={{ fontWeight: 800, color: S900, fontSize: '0.98rem' }}>{o.name}</div>
                        <div style={{ fontSize: '0.72rem', color: S600, marginTop: 4, fontFamily: 'monospace' }}>{o.hpcsa || '—'}</div>
                        <div style={{ fontSize: '0.72rem', color: S600, marginTop: 2 }}>{o.qualification || '—'}</div>
                      </button>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => {
                    // For the treating-practitioner gate the only way out without
                    // picking is to step back to the previous phase — closing the
                    // modal in-place would just trigger the auto-reopen useEffect.
                    if (isTreating) setPhase(2);
                    setCrewPicker(null);
                  }}
                  style={{
                    width: '100%', padding: 12, borderRadius: 10,
                    border: `1.5px solid ${S200}`, background: '#fff', color: S700,
                    fontWeight: 800, fontSize: '0.88rem', cursor: 'pointer',
                  }}
                >
                  {isTreating ? '← Back to previous step' : 'Cancel'}
                </button>
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
              if (kind === 'iv') setIvRows([...ivRows, newRow]);
              else setMedRows([...medRows, newRow]);
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

        {/* ── Bottom nav (Submit PRF on final phase only) ── */}
        {phase === PHASES.length - 1 && (
          <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 40, display: 'flex', gap: 10, padding: '12px 18px', background: 'rgba(255,255,255,0.97)', backdropFilter: 'blur(12px)', borderTop: `1px solid ${S200}`, boxShadow: '0 -4px 16px rgba(0,0,0,0.06)' }}>
            <button type="button" onClick={handleSubmit} disabled={submitting} style={{ flex: 1, padding: '15px 0', borderRadius: 12, fontSize: '0.88rem', fontWeight: 800, border: 'none', cursor: submitting ? 'wait' : 'pointer', background: submitting ? S400 : `linear-gradient(135deg,${ROSE},#be123c)`, color: W, boxShadow: submitting ? 'none' : `0 4px 14px rgba(225,29,72,0.3)` }}>{submitting ? 'Submitting...' : 'Submit PRF'}</button>
          </div>
        )}
      </div>
    </FormContext.Provider>
  );
}
