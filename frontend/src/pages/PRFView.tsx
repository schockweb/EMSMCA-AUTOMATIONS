/**
 * PRFView — Service-provider-branded PRF display for medical-scheme submission.
 * Renders the submitted Digital PRF in a clean, print-ready paper-form layout
 * with the provider's branding (logo, PR number, address, phone) prominent.
 */
import { useEffect, useRef, useState, useCallback, Fragment } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router';
import axios from '../api/client';
import { getCrewToken, ensureProviderSession } from '../utils/crewSession';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';

// ── Paper-form tokens ────────────────────────────────────────────────
// Brand teal palette — matches the Case Management page (--brand-teal #088395)
// so the whole product reads as one brand. Hardcoded hex (not the CSS var) so
// html2canvas resolves the colour correctly during PDF export. GREEN/GREEN_DK/
// GREEN_TINT names retained so every header, border and tint recolours here.
const GREEN    = '#088395';      // section headers bar (brand teal)
const GREEN_DK = '#005f6b';      // accent + provider brand (dark teal)
const GREEN_TINT = '#e7f3f5';    // label cell background (teal tint)

import { PrintableInjuryDiagram } from '../components/BodyDiagram';
import {
  INSET_MM, MAX_W_MM, MAX_H_MM, SHEET_RATIO,
  DESIGN_W_PX, MAX_FIT_W, planPlacement, screenZoomFor,
  PX_PER_MM, printScaleFor,
} from './prfPdfLayout';
const INK      = '#0b1020';      // body text
const MUT      = '#5b6478';      // secondary text
const DIM      = '#94a3b8';      // placeholder / empty marker
const LN       = '#088395';      // borders (brand teal)
const SOFT_BG  = '#f8fafc';      // empty-state background

// ── Vitals table rows (PRINT schema) ─────────────────────────────────
// [label, form-data key] for the vitals table, shared by page 2 and the
// continuation sheet so the two can never drift apart.
// Deliberately DISTINCT from VS_QUICK/VS_FULL in DigitalPRFForm: those are the
// crew INPUT schema (widget metadata, units in the label), this is the compact
// PRINT schema, and it carries `gcs_total`, which is derived rather than typed.
const VITALS_PDF_ROWS = ([
  ['Resp. Rate', 'resp_rate'],
  ['Rhythm',     'rhythm'],
  ['A/E',        'ae'],
  ['SpO₂ %',     'spo2'],
  ['% Oxygen',   'o2_percent'],
  ['HR',         'hr'],
  ['ECG/Rhythm', 'ecg'],
  ['Cap Refill', 'cap_refill'],
  ['Perfusion',  'perfusion'],
  ['BP',         'bp'],
  ['GCS Eyes',   'gcs_e'],
  ['GCS Voice',  'gcs_v'],
  ['GCS Motor',  'gcs_m'],
  ['GCS Total',  'gcs_total'],
  ['Pupil Size L', 'pupil_size_l'],
  ['Pupil Size R', 'pupil_size_r'],
  ['Pupil React','pupil_react'],
  ['Neuro Def',  'neuro_def'],
  ['HGT',        'hgt'],
  ['Temp',       'temp'],
  ['Pain /10',   'pain'],
  ['Vent Mode',  'vent_mode'],
  ['ETCO₂',      'etco2'],
  ['Tidal Vol',  'tidal_vol'],
  ['Min Vol',    'min_vol'],
  ['Peep/CPAP',  'peep_cpap'],
  ['Pacing',     'pacing'],
] as const);

// ── Formatters ───────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0');
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
// Date-input values ("1982-05-19") print SA-style as 19/05/1982. String-split
// (not `new Date`) so the day can never shift across timezones; anything that
// isn't a plain YYYY-MM-DD passes through untouched.
function fmtDateValue(v: unknown): any {
  if (typeof v !== 'string') return v;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : v;
}

// ── Empty-value helpers ──────────────────────────────────────────────
function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}
function anyValue(obj: Record<string, unknown> | null | undefined, keys: string[]): boolean {
  if (!obj) return false;
  return keys.some(k => !isBlank(obj[k]));
}
const EmptyMark = () => (
  <span style={{ color: DIM, fontStyle: 'italic', fontSize: '0.78rem', letterSpacing: '0.02em' }}>—</span>
);
const EmptySignature = ({ label = 'Not captured', minHeight = 48 }: { label?: string; minHeight?: number }) => (
  <div style={{
    minHeight, width: '100%', maxWidth: 300, boxSizing: 'border-box',
    background: SOFT_BG, border: `2px dashed #475569`,
    borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
    position: 'relative',
  }}>
    <div style={{
      position: 'absolute', bottom: '25%', left: '10%', right: '10%',
      borderBottom: '2px dotted #94a3b8', zIndex: 0
    }} />
    <div style={{
      fontSize: '0.85rem', color: MUT, fontStyle: 'italic', fontWeight: 800,
      letterSpacing: '0.04em', position: 'relative', zIndex: 1,
      background: SOFT_BG, padding: '0 8px'
    }}>{label}</div>
  </div>
);

// Captured-signature block — a clearly bordered box so the signature area
// reads as a visible block on the printed / exported PRF (the bare <img>
// rendering used previously shrank to near-invisible once the page was
// scaled onto the A4 sheet). The ink is drawn as large as the box allows.
const SignatureBox = ({ src, minHeight = 56, label }: {
  src?: string | null; minHeight?: number; label?: string;
}) => (
  src ? (
    <div style={{
      minHeight, width: '100%', maxWidth: 300, boxSizing: 'border-box',
      border: '2px solid #475569', borderRadius: 4, background: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 2,
      position: 'relative',
    }}>
      <div style={{
        position: 'absolute', bottom: '25%', left: '10%', right: '10%',
        borderBottom: '2px dotted #cbd5e1', zIndex: 0
      }} />
      <img src={src} alt="signature"
           style={{ maxWidth: '100%', maxHeight: minHeight - 6, objectFit: 'contain', position: 'relative', zIndex: 1 }} />
    </div>
  ) : <EmptySignature label={label} minHeight={minHeight} />
);

// Provider logo — the client brand mark shown top-left on the PDF / print
// pages. Resolution order:
//   1. The provider's own uploaded logo (`logo_url`, returned by the
//      /admin/by-case endpoint) — works for every tenant.
//   2. The bundled JEMS asset for that specific tenant.
//   3. The provider name as text when no artwork is available.
// crossOrigin is set so html2canvas can paint a same-origin / CORS-enabled
// logo into the snapshot canvas without tainting it (which would otherwise
// break `canvas.toDataURL()` during PDF export).
const ProviderLogo = ({ prov, height = 36 }: { prov: any; height?: number }) => {
  // If a remote logo_url fails to load (404, or a host without CORS headers
  // which crossOrigin="anonymous" turns into a hard load failure) we fall
  // through to the provider name text instead of leaving a broken-image icon.
  const [failed, setFailed] = useState(false);
  const src: string | null =
    (prov?.logo_url && String(prov.logo_url).trim()) ||
    (prov?.slug?.toLowerCase() === 'jems' ? '/jems_logo.png' : null);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt={prov?.name || 'Service Provider'}
        crossOrigin="anonymous"
        onError={() => setFailed(true)}
        // maxWidth:'100%' keeps the logo inside whatever cell it sits in (the
        // narrow page-1 brand column included) regardless of its aspect ratio.
        style={{ height, width: 'auto', maxWidth: '100%', objectFit: 'contain', display: 'block' }}
      />
    );
  }
  return (
    <div style={{ fontWeight: 900, color: GREEN_DK, fontSize: '0.9rem', letterSpacing: '0.02em' }}>
      {prov?.name || 'Service Provider'}
    </div>
  );
};

// ── Primitives ───────────────────────────────────────────────────────
// Densities are deliberately tight: the whole form has to fit two A4
// landscape pages with every captured field rendered, so vertical
// padding is kept under 4 px and font sizes under 0.8 rem throughout.
const FieldRow = ({ label, value, labelWidth = 95, valueMin = 13, flex }: {
  label: string; value?: string | null | React.ReactNode; labelWidth?: number; valueMin?: number; flex?: number;
}) => {
  const blank = typeof value === 'string' ? value.trim() === '' : (value === null || value === undefined);
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', borderTop: `1px solid ${LN}`, flex }}>
      <div style={{
        padding: '2px 6px', fontSize: '0.56rem', fontWeight: 800, color: INK,
        textTransform: 'uppercase', letterSpacing: '0.04em',
        background: GREEN_TINT, minWidth: labelWidth, width: labelWidth,
        borderRight: `1px solid ${LN}`, display: 'flex', alignItems: 'center',
      }}>{label}</div>
      <div style={{
        padding: '2px 7px', fontSize: '0.76rem', color: blank ? DIM : INK,
        fontFamily: 'ui-monospace, "SF Mono", monospace',
        flex: 1, minHeight: valueMin, display: 'flex', alignItems: 'center',
        wordBreak: 'break-word',
        background: blank ? SOFT_BG : '#fff',
      }}>
        {blank ? <EmptyMark /> : value}
      </div>
    </div>
  );
};

const SectionHead = ({ label, rightLabel, rightValue }: {
  label: string; rightLabel?: string; rightValue?: string;
}) => (
  <div style={{
    background: GREEN, color: '#fff',
    fontSize: '0.62rem', fontWeight: 900, padding: '3px 8px',
    textTransform: 'uppercase', letterSpacing: '0.06em',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  }}>
    <span>{label}</span>
    {rightLabel && (
      <span style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.58rem' }}>
        <span style={{ opacity: 0.85 }}>{rightLabel}</span>
        <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 700 }}>{rightValue}</span>
      </span>
    )}
  </div>
);

const Chk = ({ label, checked, color }: { label: string; checked: boolean; color?: string }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 6, padding: '2px 7px',
    borderTop: `1px solid ${LN}`,
    fontSize: '0.66rem', fontWeight: 600, color: INK,
    background: checked && color ? color : checked ? 'rgba(47,143,74,0.08)' : '#fff',
  }}>
    <span style={{
      width: 11, height: 11, border: `1.4px solid ${checked ? (color ? '#fff' : GREEN_DK) : '#6b7280'}`,
      background: checked ? (color || GREEN_DK) : '#fff',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      color: '#fff', fontSize: '0.62rem', fontWeight: 900, flexShrink: 0,
    }}>{checked ? '✓' : ''}</span>
    <span style={{ textTransform: 'uppercase', letterSpacing: '0.04em', color: checked && color ? '#fff' : INK, fontWeight: checked ? 700 : 600 }}>{label}</span>
  </div>
);

// Sub-block used inside Medical-Aid / Channel-specific column. Renders a
// thin green strip + a stack of FieldRows for the populated keys only.
// Ruled write-in lines — converts leftover column height into intentional,
// usable space (like the ruled areas on paper PRFs) instead of a blank void.
// Columns are locked to the A4 sheet height, so sparse forms MUST absorb the
// slack somewhere; ruling reads as "room for more" rather than "missing data",
// and it satisfies the requirement that every extra field always has space —
// populated fields simply compress the ruling from above. Pure bordered DIVs
// (no CSS gradients) so html2canvas capture and browser print render
// identically; overflow:hidden clips to whole lines (tall gaps show more
// lines, short gaps fewer, never a half line).
// Printed in the Patient and Billing blocks when the patient refused.
//
// Both blocks are otherwise near-empty on a refusal — no transport happened and
// there is nothing to bill — and an empty block on this form is ambiguous in the
// worst way: it looks exactly like a call where the crew captured nothing. The
// distinction between "nothing was recorded" and "the patient declined" is the
// entire point of the document, so each block says which it is.
const RefusedNote = ({ detail }: { detail?: string }) => (
  <div style={{
    padding: '7px 9px', borderTop: `1px solid ${LN}`,
    background: SOFT_BG, textAlign: 'center',
  }}>
    <div style={{
      fontSize: '0.63rem', fontWeight: 900, color: GREEN_DK,
      letterSpacing: '0.04em', textTransform: 'uppercase',
    }}>
      Patient refused treatment
    </div>
    {detail && (
      <div style={{ fontSize: '0.55rem', color: MUT, marginTop: 3, lineHeight: 1.4 }}>
        {detail}
      </div>
    )}
  </div>
);

// Cash receipt: amounts, payer, and both signatures.
//
// ONE definition, rendered on the attachments sheet — see `cashOnOwnSheet`. It is the
// bulkiest thing that can appear in the Billing column (a section head, four
// rows and TWO signature boxes), and on page 1 it squeezed every other payer
// block. A second copy for the second location would drift, and the way that
// drift shows up is a cash receipt that prints differently depending on the
// call type.
const CashVerification = ({ fd, wide = false }: { fd: any; wide?: boolean }) => (
  <>
    <SectionHead label="Cash Verification" />
    <div style={wide
      ? { display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 0 }
      : undefined}>
      <div>
        <FieldRow label="Amount Paid" value={fd.pvt_cash_amount_paid ? `R ${fd.pvt_cash_amount_paid}` : ''} />
        {/* Who actually handed the cash over. The crew captures it, but it
            never reached the PDF — so the cash-receipt block was an
            unattributed signature against a rand amount. If the payer later
            disputes paying, or money goes missing between crew and office, the
            record could not say who handed it over. */}
        <FieldRow label="Payer" value={fd.pvt_cash_payer_name} />
        <div style={{ padding: '4px 6px', borderTop: `1px solid ${LN}` }}>
          <div style={{ fontSize: '0.48rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', marginBottom: 2 }}>Payer Signature</div>
          <SignatureBox src={fd.pvt_cash_payer_signature} minHeight={wide ? 54 : 40} />
        </div>
      </div>
      <div style={wide ? { borderLeft: `1px solid ${LN}` } : undefined}>
        <FieldRow label="Crew Received" value={fd.pvt_cash_crew_received ? `R ${fd.pvt_cash_crew_received}` : ''} />
        <div style={{ padding: '4px 6px', borderTop: `1px solid ${LN}` }}>
          <div style={{ fontSize: '0.48rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', marginBottom: 2 }}>Crew Signature</div>
          <SignatureBox src={fd.pvt_cash_crew_signature} minHeight={wide ? 54 : 40} />
        </div>
      </div>
    </div>
  </>
);

// The hospital sticker slot.
//
// Page 1 renders this ONLY as the empty "affix here" slot. A CAPTURED sticker
// prints full-size on its own "Patient Documents (Attachments)" sheet instead —
// see `stickerOnDocumentSheet`. With a
// sticker captured it is the tallest single element the sheet carries: the slot
// plus a 200px image plus its heading is ~230px, all of it in the same column
// as Billing, which is already the tallest.
//
// That matters because page 1 has a HARD one-sheet ceiling of ~944 CSS px. It
// comes from the legibility floor: text may not print below 0.9 of design size,
// so the widest the exporter may reflow to is 1220/0.9 ≈ 1355px, and at the A4
// landscape ratio (0.697) that is 944px of height. Reallocating budget between
// reflow-widening and uniform shrink does not move that number — widening lets a
// taller page fit but shrinks the text by exactly the same factor. The only way
// a too-tall page 1 stops being sliced across two half-empty sheets is to make
// it shorter, and this is the largest thing on it.
//
// It is NOT shrunk to win those pixels. A hospital sticker carries the
// receiving facility's own patient label in small print; scaling it down to fit
// trades one legibility problem for a worse one on the part of the page that is
// evidence rather than layout.
const HospitalSticker = ({ fd, wide = false }: { fd: any; wide?: boolean }) => (
  <>
    <SectionHead label="Hospital Sticker" />
    <div style={{
      borderTop: `1px solid ${LN}`, padding: 6,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: '96%', minHeight: wide ? 150 : 110,
        border: `1.6px dashed ${MUT}`, borderRadius: 4,
        background: SOFT_BG,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 6, overflow: 'hidden',
      }}>
        {fd.hospital_sticker ? (
          <img src={fd.hospital_sticker} alt="hospital sticker"
               style={{ maxWidth: '100%', maxHeight: wide ? 260 : 200, objectFit: 'contain' }} />
        ) : (
          <div style={{
            fontSize: '0.62rem', fontWeight: 700, color: DIM,
            textTransform: 'uppercase', letterSpacing: '0.08em', textAlign: 'center',
            lineHeight: 1.6,
          }}>Affix hospital sticker here</div>
        )}
      </div>
    </div>
  </>
);

const FillLines = ({ minHeight = 0 }: { minHeight?: number }) => (
  // The line stack is absolutely positioned so it contributes ZERO intrinsic
  // height — the container only ever absorbs the column's genuine leftover
  // space (flex:1), exactly like the blank fillers it replaces. Rendering the
  // lines in normal flow inflated every column by the full stack height and
  // ballooned the fixed A4 sheet to ~3× its size.
  <div style={{
    flex: 1, minHeight, borderTop: `1px solid ${LN}`,
    position: 'relative', overflow: 'hidden',
  }}>
    <div style={{ position: 'absolute', top: 4, left: 10, right: 10, bottom: 0 }}>
      {[...Array(40)].map((_, i) => (
        <div key={i} style={{ height: 26, borderBottom: '1px solid rgba(8,131,149,0.18)' }} />
      ))}
    </div>
  </div>
);

const SubBlock = ({ title, rows }: { title: string; rows: Array<[string, any, number?]> }) => {
  const visible = rows.filter(([, v]) => !isBlank(v));
  if (visible.length === 0) return null;
  return (
    <>
      <div style={{
        background: GREEN_DK, color: '#fff',
        fontSize: '0.55rem', fontWeight: 800, padding: '3px 8px',
        textTransform: 'uppercase', letterSpacing: '0.06em',
      }}>{title}</div>
      {visible.map(([label, v, vMin]) => (
        <FieldRow key={label} label={label} value={v} valueMin={vMin} />
      ))}
    </>
  );
};

// Filename for the exported / shared PDF, e.g. "JEM690 PRF Discovery IHT.pdf".
//   • prefix  — the admin-chosen PRF Name (provider.prf_name) when set, else the
//               full provider name; alphanumerics + spaces, uppercased
//   • number  — the provider-scoped PRF number
//   • scheme  — medical scheme from the form data
//   • call    — call type (Primary / IHT / …)
// Empty parts are dropped and filename-illegal characters stripped.
// Mirrored by _prf_display_name in backend api/cases.py — keep in sync.
const buildPrfFileName = (prf: any): string => {
  const prov = prf?.provider || {};
  const fd = prf?.form_data || {};
  const prefix = String(prov.prf_name || prov.name || '').replace(/[^A-Za-z0-9 ]/g, '').trim().toUpperCase();
  const parts = [
    `${prefix}${prf?.prf_number ?? ''}`.trim(),
    'PRF',
    String(fd.medical_scheme || '').trim(),
    String(fd.call_type || '').trim(),
  ].filter(Boolean);
  const base = parts.join(' ').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  return `${base || 'PRF_export'}.pdf`;
};

// Round buttons either side of the mobile reader-zoom readout.
const zoomBtn = (off: boolean): React.CSSProperties => ({
  width: 38, height: 38, padding: 0, border: 'none', borderRadius: '50%',
  background: off ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.16)',
  color: off ? 'rgba(255,255,255,0.35)' : '#fff',
  fontSize: '1.3rem', fontWeight: 700, lineHeight: 1, fontFamily: 'inherit',
  cursor: off ? 'default' : 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
});

// ── Component ────────────────────────────────────────────────────────
export interface PRFViewProps {
  /**
   * Render off-screen purely to send the facility email, with no crew watching.
   *
   * Used by SilentFacilityEmailSender after a PRF captured offline has synced.
   * In this mode the page must not touch anything the crew can perceive — see
   * the viewport-meta guard, which would otherwise re-enable iOS focus-zoom on
   * a form they are typing into mid-call.
   */
  silentMode?: boolean;
  /** Called once, with why the silent attempt finished. */
  onSilentDone?: (outcome: 'sent' | 'error' | 'no-smtp' | 'no-recipient' | 'already-sent') => void;
}

export default function PRFView({ silentMode = false, onSilentDone }: PRFViewProps = {}) {
  const { providerSlug, caseId } = useParams<{ providerSlug: string; caseId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [prf, setPrf] = useState<any>(null);
  const [err, setErr] = useState('');
  // The crew's post-submit flow lands here with `?send=1`. We show a one-shot
  // prompt modal asking whether to send the rendered PRF to the receiving
  // facility. Crew taps the button → share sheet / Gmail compose opens. Crew
  // taps "Skip" → modal closes and the page stays as a read-only PRF view.
  //
  // Initial state stays false — we only flip it true once the PRF data has
  // loaded AND it carries a valid receiving-facility email. Otherwise the
  // modal would flash up before we know if there's anywhere to send it.
  const [showSharePrompt, setShowSharePrompt] = useState<boolean>(false);

  // Pre-built PDF File ready for the share sheet. We MUST have this in
  // hand before the user taps the Send button — iOS Safari refuses any
  // `navigator.share()` call that isn't synchronous inside the user
  // gesture, and awaiting the PDF build (~1-2s) consumes the gesture
  // flag. We start building as soon as the PRF data loads so the file
  // is usually ready by the time the crew taps.
  const [sharePdfFile, setSharePdfFile] = useState<File | null>(null);
  const pdfBuildStartedRef = useRef(false);
  // Ref mirror of sharePdfFile so the auto-send flow can await the prewarm
  // without racing React state (and without double-building on slow phones).
  const sharePdfFileRef = useRef<File | null>(null);

  // ── One-tap "email PRF to receiving facility" ──
  // When the provider has a sending account configured (smtp_configured on
  // the by-case payload), the post-submit popup shows the recipient email
  // for verification and a single Send button — the backend then emails the
  // PDF FROM the provider's own Gmail/Outlook. Falls back to the manual
  // share-sheet flow when unconfigured or on failure.
  const [sendEmailTo, setSendEmailTo] = useState('');
  const [sendStatus, setSendStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [sendError, setSendError] = useState('');
  // 'queued' = accepted by the server (worker still sending); 'delivered' =
  // the sent-stamp confirmed. The UI wording distinguishes them — claiming
  // "sent" on queue-acceptance hid real SMTP failures behind a checkmark.
  const [sentPhase, setSentPhase] = useState<'queued' | 'delivered'>('queued');
  // The PRF was already emailed on a previous open — show that state instead
  // of re-offering the send form; "Send again" flips this to re-enable it.
  const [resendMode, setResendMode] = useState(false);
  // True once the post-submit auto-send has kicked off for this page load —
  // the popup then runs as a gated status screen (no Skip) until delivery
  // is confirmed or the crew explicitly falls back to manual sending.
  const autoSendFiredRef = useRef(false);
  // Manual-send fallback bookkeeping: after the crew opens their mail app we
  // ask them to CONFIRM the send, then stamp the PRF as sent so no automatic
  // send (now or on a later open) can deliver a duplicate to the facility.
  const [manualConfirm, setManualConfirm] = useState(false);
  const [manualSent, setManualSent] = useState(false);
  const [manualMarkBusy, setManualMarkBusy] = useState(false);

  useEffect(() => {
    // Tenant guard for the crew route (/:providerSlug/crew/prf-view/...):
    // a crew session from a DIFFERENT provider is wiped and the user routed
    // to this provider's own login. EMSMCA admin tokens (access_token) are
    // exempt — staff legitimately view every provider's PRFs via /cases.
    if (providerSlug && !localStorage.getItem('access_token')) {
      if (!ensureProviderSession(providerSlug)) {
        navigate(`/${providerSlug}/login`, { replace: true });
        return;
      }
    }
    const token = localStorage.getItem('access_token') || getCrewToken() || '';
    axios.get(`/api/digital-prf/admin/by-case/${caseId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => {
        const data = r.data;
        // The admin/by-case endpoint returns signatures as flat top-level fields
        // (patient_signature, crew_signature, etc.) while PRFView reads them via
        // prf.signatures.xxx (the nested format used by the PDF render endpoint).
        // Normalise here so all SignatureBox references work regardless of which
        // endpoint shape is returned.
        if (!data.signatures) {
          data.signatures = {
            patient_signature:   data.patient_signature   || null,
            witness_signature:   data.witness_signature   || null,
            handover_signature:  data.handover_signature  || null,
            crew_signature:      data.crew_signature      || null,
            valuables_signature: data.valuables_signature || null,
          };
        }
        setPrf(data);
        // Prefill the send-to-facility recipient from the handover email the
        // crew captured; the popup lets them verify / correct it before sending.
        setSendEmailTo((data.form_data?.handover_doctor_email || '').trim());
      })
      .catch(e => setErr(e.response?.data?.detail || 'Failed to load PRF'));
  }, [caseId]);

  // Open the share prompt when the crew arrives from a `?send=1` post-submit
  // redirect and the PRF data has loaded. The prompt asks whether to send the
  // rendered PRF to the receiving facility via Gmail.
  useEffect(() => {
    if (searchParams.get('send') !== '1') return;
    if (!prf) return;
    setShowSharePrompt(true);
  }, [searchParams, prf]);

  // Pre-warm the PDF in the background as soon as PRF data lands. By the
  // time the crew taps "Send", the File is in state and handleShare()
  // can call navigator.share() synchronously with zero awaits — the only
  // way iOS Safari reliably honours the file-share request.
  useEffect(() => {
    if (!prf) return;
    if (pdfBuildStartedRef.current) return;
    pdfBuildStartedRef.current = true;
    // Give the layout a short beat to settle, THEN wait for every on-page
    // <img> to finish decoding before snapshotting. html2canvas paints
    // whatever has decoded at snapshot time, so without this gate a slow
    // remote provider logo could be baked into the shared PDF as a blank
    // box. Signatures / sketches / attachments are inline data-URLs and
    // decode instantly; the logo is the one image that can lag.
    const t = window.setTimeout(async () => {
      const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('.prf-page img'));
      await Promise.all(imgs.map(img =>
        (img.complete && img.naturalWidth > 0)
          ? Promise.resolve()
          : (img.decode ? img.decode().catch(() => undefined) : Promise.resolve()),
      ));
      const pdf = await buildPrfPdf();
      if (!pdf) return;
      const blob = pdf.output('blob');
      const file = new File(
        [blob],
        buildPrfFileName(prf),
        { type: 'application/pdf' },
      );
      sharePdfFileRef.current = file;
      setSharePdfFile(file);
    }, 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prf]);

  // ── On-screen fit-to-width + reader zoom ──────────────────────────────────
  // The PRF sheet is a FIXED 1220px A4 design. In the admin viewport that's
  // frequently wider than the available column, so the right edge (the alpha-
  // unit time grid) was clipped. Shrink the sheet with CSS `zoom` — which
  // reduces the layout box (unlike transform), so the page simply centres with
  // no horizontal scroll — to fit the container. `zoom` is CLEARED during PDF
  // capture and print (both read each .prf-page's offsetWidth, which Chrome's
  // zoom would scale) so the export always renders at full 1220px resolution.
  //
  // Fit-to-width is only a sensible DEFAULT on a big screen. On a phone it
  // resolves to ~0.31 — an A4 landscape form rendered 4px tall — and the
  // app-wide `maximum-scale=1.0` viewport meant the reader could not pinch out
  // of it either, so a PRF opened from the client-admin dashboard was simply
  // unreadable. `userZoom` now overrides the auto-fit, and .prf-screen-wrap
  // (overflow-x:auto) pans once the sheet is wider than the screen.
  const [fitScale, setFitScale] = useState(1);
  const [userZoom, setUserZoom] = useState<number | null>(null);
  const userZoomRef = useRef<number | null>(null);

  const clearScreenFit = () => {
    const el = document.getElementById('prf-pdf-content');
    if (el) el.style.zoom = '';
  };
  const applyScreenFit = useCallback(() => {
    const el = document.getElementById('prf-pdf-content');
    const wrap = el?.closest('.prf-screen-wrap') as HTMLElement | null;
    if (!el || !wrap) return;
    el.style.zoom = '';                        // measure at the true 1220px width
    const avail = wrap.clientWidth - 8;        // small breathing room
    // `fit` is the true fit-to-width and stays the zoom-out floor, so the
    // overview is still reachable on purpose. `applied` is where the reader
    // LANDS, and is never below MIN_SCREEN_ZOOM — on a phone plain fit-to-width
    // is ~0.30, which renders the sheet unreadable (see prfPdfLayout).
    const { fit, applied } = screenZoomFor(avail);
    setFitScale(fit);
    const z = userZoomRef.current ?? applied;
    el.style.zoom = z < 1 ? String(z) : '';
  }, []);
  useEffect(() => {
    userZoomRef.current = userZoom;
    applyScreenFit();
    window.addEventListener('resize', applyScreenFit);
    // Re-fit once fonts / logo settle and whenever the PRF data changes.
    const t = setTimeout(applyScreenFit, 150);
    return () => { window.removeEventListener('resize', applyScreenFit); clearTimeout(t); };
  }, [applyScreenFit, prf, userZoom]);

  // Step the reader zoom, keeping whatever is at the centre of the screen at
  // the centre afterwards — zooming in from the left edge otherwise dumps you
  // in the middle of the sheet with no idea which column you are looking at.
  const stepZoom = (dir: 1 | -1) => {
    const from = userZoomRef.current ?? fitScale;
    const next = Math.min(2, Math.max(fitScale, Math.round((from + dir * 0.25) * 100) / 100));
    if (next === from) return;
    const wrap = document.querySelector('.prf-screen-wrap') as HTMLElement | null;
    if (wrap) {
      const centre = (wrap.scrollLeft + wrap.clientWidth / 2) / from;
      requestAnimationFrame(() => {
        wrap.scrollLeft = Math.max(0, centre * next - wrap.clientWidth / 2);
      });
    }
    setUserZoom(next <= fitScale ? null : next);
  };

  // The app ships a `maximum-scale=1.0` viewport — that is what stops iOS
  // auto-zooming when a crew member focuses a field mid-call, so it stays as
  // the app-wide default. But this page is a DOCUMENT, and pinching is the
  // first thing anyone tries on one. Relax the meta while the viewer is
  // mounted and restore it on the way out, leaving every form page untouched.
  useEffect(() => {
    // NOT in silent mode. The silent sender mounts this page off-screen while
    // the crew is on some other page — usually the PRF form, mid-call.
    // Relaxing the app-wide viewport meta from there would re-enable iOS
    // focus-zoom on a form the crew is actively typing into, which is exactly
    // what maximum-scale=1.0 exists to prevent. The hidden copy is never
    // looked at, so it has no business touching the viewport at all.
    if (silentMode) return;
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    const original = meta.getAttribute('content') || '';
    meta.setAttribute('content',
      'width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover');
    return () => { meta.setAttribute('content', original); };
  }, [silentMode]);

  // ── Silent auto-send ──────────────────────────────────────────────────────
  //
  // Mounted off-screen by SilentFacilityEmailSender after an offline PRF has
  // synced. `?send=1` alone only GATES the UI (longer delivery poll, no Skip);
  // it never actually fired the send — the crew still had to tap. Offline there
  // is no crew watching, so the send has to fire itself.
  //
  // Waits for the PRF to load and for a valid recipient, then calls exactly the
  // same handler the button calls, so there is one send path rather than two.
  const silentFiredRef = useRef(false);
  useEffect(() => {
    if (!silentMode || silentFiredRef.current) return;
    if (!prf || sendStatus === 'sending') return;
    if (!prf.smtp_configured) { onSilentDone?.('no-smtp'); return; }
    if (prf.facility_email_sent_at) { onSilentDone?.('already-sent'); return; }
    const to = (prf.form_data?.handover_doctor_email || '').trim();
    if (!SEND_EMAIL_RE.test(to)) { onSilentDone?.('no-recipient'); return; }
    silentFiredRef.current = true;
    void handleAutoSend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [silentMode, prf]);

  // Report the outcome once the shared handler settles.
  useEffect(() => {
    if (!silentMode || !silentFiredRef.current) return;
    if (sendStatus === 'sent') onSilentDone?.('sent');
    else if (sendStatus === 'error') onSilentDone?.('error');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [silentMode, sendStatus]);

  // Build the PDF by snapshotting each .prf-page independently and placing
  // it on its own A4 landscape sheet. This bypasses the browser's CSS print
  // pagination (which fought with the 1220px-wide layout and produced 5–7
  // pages instead of the intended ones).
  //
  // Each .prf-page now grows to its NATURAL content height (min one A4
  // sheet) instead of being clamped to a fixed 862px box. We snapshot the
  // element at its full scroll size — so every captured field is included,
  // nothing clipped — then place it on its sheet scaled UNIFORMLY (same
  // factor on both axes) to fit inside the 297×210mm printable area. Because
  // the scale is uniform the aspect ratio is preserved: rows can never smear
  // or overlap one another. A denser page simply renders slightly smaller,
  // top-aligned and horizontally centred.
  //
  // Returns the jsPDF instance so callers can either `.save()` (download)
  // or `.output('blob')` (Web Share API attachment).
  const buildPrfPdf = async () => {
    const pages = Array.from(document.querySelectorAll<HTMLElement>('.prf-page'));
    if (pages.length === 0) return null;

    // Capture at the full 1220px design width — the on-screen fit `zoom` would
    // otherwise shrink each page's offsetWidth and the snapshot with it.
    clearScreenFit();

    // A4 geometry and the sizing policy live in ./prfPdfLayout so they can be
    // unit-tested: jsdom has no layout engine, which is why a defect that
    // printed the clinical page at ~3pt survived a green 72-test suite.
    const maxW = MAX_W_MM;   // 287mm
    const maxH = MAX_H_MM;   // 200mm

    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape', compress: true });
    let firstSheet = true;
    let skippedSheets = 0;
    const newSheet = () => {
      if (!firstSheet) pdf.addPage('a4', 'landscape');
      firstSheet = false;
    };

    try {
      for (let i = 0; i < pages.length; i++) {
        const el = pages[i];

        // ── Fill-the-sheet reflow ──
        // A page whose natural layout is TALLER than the sheet aspect would
        // otherwise be shrunk uniformly, leaving white gutters left/right.
        // Instead, temporarily WIDEN the layout box — text re-wraps into the
        // extra width and the page gets shorter — until the aspect matches
        // the sheet. The snapshot then fills the full printable area with no
        // distortion. Width is restored immediately after the snapshot.
        const prevWidth = el.style.width;
        const prevMinWidth = el.style.minWidth;
        let canvas: HTMLCanvasElement | null = null;
        // Hoisted: the placement branches below need the width the sheet was
        // actually reflowed to in order to know how small its text will print.
        let reflowW = DESIGN_W_PX;
        try {
          let w = el.offsetWidth || DESIGN_W_PX;
          let h = el.offsetHeight || 862;
          for (let pass = 0; pass < 4 && h / w > SHEET_RATIO + 0.002; pass++) {
            // Capped at MAX_FIT_W, not at an arbitrary 2400. The reflow's
            // premise is that widening lets text re-wrap and the page get
            // shorter — true for the prose rows, FALSE for the IV, medication
            // and vitals stacks, whose height comes from ROW COUNT. Those never
            // shorten, so the loop used to run to the cap and simply shrink the
            // whole sheet. Overflow is now the slicer's job, not the reflow's.
            w = Math.min(Math.ceil(h / SHEET_RATIO), MAX_FIT_W);
            el.style.width = `${w}px`;
            el.style.minWidth = `${w}px`;
            h = el.offsetHeight;                  // reflowed height
            w = el.offsetWidth || w;
            if (w >= MAX_FIT_W) break;            // no further widening is allowed
          }
          reflowW = w;
          canvas = await html2canvas(el, {
            // Scale 1.5 gives ~150 DPI on A4 — crisp enough for medical
            // forms while keeping canvas memory and PDF size manageable.
            scale: 1.5,
            useCORS: true,
            backgroundColor: '#ffffff',
            windowWidth: el.scrollWidth,
            windowHeight: el.scrollHeight,
          });
        } finally {
          el.style.width = prevWidth;
          el.style.minWidth = prevMinWidth;
        }

        const cw = canvas?.width || 0;
        const ch = canvas?.height || 0;
        if (!canvas || !cw || !ch) {
          // A sheet failed to rasterise. This used to `continue` silently, so
          // buildPrfPdf returned a valid, savable PDF that was simply missing a
          // page — and handleAutoSend would email that truncated document to the
          // receiving facility, stamp facility_email_sent_at, and show the crew
          // "sent". A PRF missing its clinical sheet must never be transmitted,
          // so record it and abort the whole build below.
          skippedSheets++;
          continue;
        }

        // Use JPEG at 0.72 quality — shrinks the PDF from ~64MB (PNG) to
        // ~2-4MB while keeping text perfectly readable on A4 printouts.
        const imgData = canvas.toDataURL('image/jpeg', 0.72);
        const imgFormat = 'JPEG';

        const wScale = maxW / cw;                  // mm per source px at full width

        // The placement decision (fit / shrink / slice, and the legibility
        // floor that governs it) is pure arithmetic and lives in prfPdfLayout
        // so it can be unit-tested without a layout engine.
        const plan = planPlacement(cw, ch, reflowW);

        if (plan.kind === 'fit') {
          newSheet();
          pdf.addImage(imgData, imgFormat, INSET_MM, INSET_MM, maxW, plan.drawHmm, undefined, 'FAST');
        } else if (plan.kind === 'shrink') {
          // Modest overflow — shrink uniformly onto ONE clean sheet, centred.
          // Aspect ratio is preserved so fields can never smear or overlap.
          newSheet();
          pdf.addImage(
            imgData, imgFormat,
            INSET_MM + (maxW - plan.drawWmm) / 2, INSET_MM,
            plan.drawWmm, plan.drawHmm, undefined, 'FAST',
          );
        } else {
          // Very tall page — slice into full-width A4 bands across consecutive
          // sheets so every row stays full size and readable, never clipped.
          //
          // The band height comes from the plan, NOT from a second copy of the
          // formula here. The two used to be independent expressions of the same
          // arithmetic, so making the policy emit even bands while this loop
          // still cut fill-then-remainder would have left the sliver in place
          // while the tests reported it fixed.
          const sliceHpx = plan.bandHpx;
          for (let sy = 0; sy < ch; sy += sliceHpx) {
            const hpx = Math.min(sliceHpx, ch - sy);
            const band = document.createElement('canvas');
            band.width = cw;
            band.height = hpx;
            const ctx = band.getContext('2d');
            if (ctx) {
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, cw, hpx);
              ctx.drawImage(canvas, 0, sy, cw, hpx, 0, 0, cw, hpx);
            }
            newSheet();
            pdf.addImage(band.toDataURL('image/jpeg', 0.72), imgFormat, INSET_MM, INSET_MM, maxW, hpx * wScale, undefined, 'FAST');
          }
        }
      }
    } catch {
      // A single bad image — e.g. a cross-origin logo that tainted the canvas
      // and made toDataURL throw — must never silently brick the whole export.
      // Returning null lets callers show their "couldn't build" fallback.
      return null;
    } finally {
      // Restore the on-screen fit-to-width zoom regardless of outcome.
      applyScreenFit();
    }

    if (skippedSheets > 0) {
      // Refuse to hand back a PDF that is missing pages. Callers already treat
      // null as "couldn't build": Save-as-PDF falls back to the native print
      // dialog, the share pre-warm caches nothing, and handleAutoSend raises
      // pdf_build_failed instead of emailing a truncated medical-legal record.
      // Silently returning the short document was the worse failure by far.
      return null;
    }

    return pdf;
  };

  // "Save as PDF" uses buildPrfPdf (jsPDF + html2canvas) — fully
  // deterministic: exactly ONE A4-landscape sheet per .prf-page (PRF =
  // 2 sheets; each attachment on its own sheet), full-width fill, and
  // zero dependence on the browser print dialog's margin / background-
  // graphics / scale settings. The native print pipeline (window.print)
  // is kept only as a hard-copy path and as a fallback if the canvas
  // snapshot fails (e.g. a CORS-tainted logo).
  const [savingPdf, setSavingPdf] = useState(false);
  const handleSavePdf = async () => {
    if (savingPdf) return;                  // guard double-taps
    setSavingPdf(true);
    try {
      const pdf = await buildPrfPdf();
      if (pdf) {
        pdf.save(buildPrfFileName(prf));
      } else {
        // Snapshot failed — fall back to the native print dialog so the
        // crew can still produce a PDF rather than being dead-ended.
        window.print();
      }
    } finally {
      setSavingPdf(false);
    }
  };

  // Hard-copy path (physical printer). Uses the @media print CSS below.
  const handlePrint = () => window.print();

  // Native browser print (Ctrl/Cmd-P). The on-screen pages now grow to their
  // natural height (≥ one A4 sheet) and are wider than a sheet (1220px), so
  // without scaling the @media print frame (297×210mm, overflow:hidden) would
  // clip them. Mirror the PDF export's fit-to-page logic: on `beforeprint`
  // shrink each .prf-page with CSS `zoom` so it lands inside one sheet, and
  // restore on `afterprint`. The "Save as PDF" button uses buildPrfPdf and is
  // unaffected by this.
  useEffect(() => {
    // Fit each page onto exactly one A4 landscape sheet. We use CSS transform
    // (which Chrome's print engine honours, unlike `zoom`): measure the design
    // page at its natural 1220px width, then scale it down so both width and
    // height fit inside one sheet. The .prf-print-frame (fixed sheet size,
    // overflow hidden) clips any rounding so nothing bleeds onto the next sheet.
    // Must stay ≤ the .prf-print-frame box (295×205mm) so the scaled page
    // never overflows the frame and bleeds onto a second (blank) sheet.
    const frameW = 293 * PX_PER_MM;   // 2mm under frame width (rounding safety)
    const frameH = 203 * PX_PER_MM;   // 2mm under frame height
    // The reflow target is the SHARED SHEET_RATIO imported from prfPdfLayout,
    // not a locally-derived frameH/frameW. This path used to shadow it with
    // 203/293 = 0.6928 while the PDF export used 200/287 = 0.6969, so the two
    // pipelines widened the same page to different widths and disagreed about
    // how it would print.
    const fit = () => {
      // Drop the on-screen fit zoom first — the measurements below read each
      // page's true offsetWidth, and an ancestor `zoom` would scale them.
      clearScreenFit();
      document.querySelectorAll<HTMLElement>('.prf-page').forEach(p => {
        p.style.transform = 'none';
        // Remember the design width so afterprint can restore it exactly.
        if (p.dataset.prfPrevWidth === undefined) {
          p.dataset.prfPrevWidth = p.style.width || '';
          p.dataset.prfPrevMinWidth = p.style.minWidth || '';
        }
        // ── Fill-the-sheet reflow (same trick as buildPrfPdf) ──
        // A page taller than the sheet aspect would scale height-bound,
        // landing narrower than the sheet with a white right gutter.
        // Widen its layout box instead — text re-wraps, the page gets
        // shorter — until the aspect matches, then scale by width so the
        // form fills the sheet edge-to-edge.
        let w = p.offsetWidth || DESIGN_W_PX;
        let h = p.offsetHeight || 862;
        for (let pass = 0; pass < 4 && h / w > SHEET_RATIO + 0.002; pass++) {
          // Same MAX_FIT_W cap as buildPrfPdf. Widening only shortens a page
          // whose height comes from text WRAPPING; the IV, medication and
          // vitals stacks are row-count-driven and never shorten, so an
          // uncapped reflow just made this path width-bound and shrank the
          // whole sheet at `s` below.
          w = Math.min(Math.ceil(h / SHEET_RATIO), MAX_FIT_W);
          p.style.width = `${w}px`;
          p.style.minWidth = `${w}px`;
          h = p.offsetHeight;                 // reflowed height
          w = p.offsetWidth || w;
          if (w >= MAX_FIT_W) break;
        }
        // Scale with a legibility floor. A page too tall to fit one sheet at a
        // readable size is NOT shrunk into illegibility — it holds the floor
        // and flows onto further sheets, the same trade the PDF export makes
        // when it slices instead of shrinking.
        const { scale, flow } = printScaleFor(w, h, frameW, frameH);
        const frame = p.closest('.prf-print-frame') as HTMLElement | null;
        if (flow) {
          // `zoom` (not transform) because it shrinks the LAYOUT BOX, so the
          // print engine paginates against the scaled-down page. transform
          // only moves pixels — the box would stay full height and the frame's
          // overflow:hidden would CLIP the overflow off the paper entirely,
          // silently losing fields. The frame is released from its fixed height
          // for this page only, via a class the print CSS understands.
          p.style.transform = 'none';
          p.style.zoom = String(scale > 0 ? scale : 1);
          frame?.classList.add('prf-frame-flow');
        } else {
          p.style.zoom = '';
          p.style.transformOrigin = 'top left';
          p.style.transform = `scale(${scale > 0 ? scale : 1})`;
          frame?.classList.remove('prf-frame-flow');
        }
      });
    };
    const reset = () => {
      document.querySelectorAll<HTMLElement>('.prf-page').forEach(p => {
        p.style.transform = '';
        p.style.zoom = '';
        (p.closest('.prf-print-frame') as HTMLElement | null)?.classList.remove('prf-frame-flow');
        if (p.dataset.prfPrevWidth !== undefined) {
          p.style.width = p.dataset.prfPrevWidth;
          p.style.minWidth = p.dataset.prfPrevMinWidth || '';
          delete p.dataset.prfPrevWidth;
          delete p.dataset.prfPrevMinWidth;
        }
      });
      // Re-apply the on-screen fit zoom once printing is done.
      applyScreenFit();
    };
    window.addEventListener('beforeprint', fit);
    window.addEventListener('afterprint', reset);
    return () => {
      window.removeEventListener('beforeprint', fit);
      window.removeEventListener('afterprint', reset);
    };
  }, [prf]);

  // Send-to-receiving-facility flow. Two paths depending on whether
  // the browser is on a secure context (HTTPS) with Web Share API
  // file support — and the order matters a lot:
  //
  //   • Path A (HTTPS): Web Share API can attach the PDF directly to
  //     the share sheet, where the crew picks Gmail and the PDF is
  //     pre-attached. PDF must be built before share() is called.
  //
  //   • Path B (HTTP / LAN IP / older browsers): Web Share is
  //     unavailable, so we open Gmail compose directly and download
  //     the PDF so the crew can attach via paperclip. CRITICAL:
  //     `window.open()` for the Gmail URL MUST fire synchronously
  //     inside this click handler — iOS Safari and most mobile
  //     browsers block popups after any `await`, so if we wait for
  //     the PDF build first, the Gmail window gets blocked and
  //     "nothing happens".
  //
  // The implementation decides path B vs A *before* any await, opens
  // the Gmail window immediately if needed, then proceeds with the
  // async PDF build.
  // Open Gmail web compose with To/Subject/Body pre-filled and simultaneously
  // download the PDF so the crew can attach it via the paperclip icon in Gmail.
  const handleShare = () => {
    const fileName = buildPrfFileName(prf);
    const toEmail = (prf.form_data?.handover_doctor_email || '').trim();
    const patientName = [prf.form_data?.patient_name, prf.form_data?.patient_surname]
      .filter(Boolean).join(' ') || 'the patient';
    const subject = `Digital PRF #${prf.prf_number} — ${patientName}`;
    const body = `Please find the Digital PRF for ${patientName} (Case ${prf.case_number || prf.prf_number}) attached.`;

    const to = encodeURIComponent(toEmail);
    const su = encodeURIComponent(subject);
    const bd = encodeURIComponent(body);

    // Build Gmail web compose URL with pre-filled fields
    const gmailUrl = toEmail
      ? `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${su}&body=${bd}`
      : `https://mail.google.com/mail/?view=cm&fs=1&su=${su}&body=${bd}`;

    // Open Gmail compose in a new tab — must fire synchronously inside the
    // click handler so popup blockers don't intercept it.
    window.open(gmailUrl, '_blank', 'noopener,noreferrer');

    // Download the PDF so the crew can attach it in Gmail via the paperclip.
    if (sharePdfFile) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(sharePdfFile);
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } else {
      (async () => {
        const pdf = await buildPrfPdf();
        if (pdf) pdf.save(fileName);
      })();
    }
  };

  // Confirm + share when the crew taps the modal button. We deliberately
  // do NOT await anything before handleShare() — iOS Safari only accepts
  // `googlegmail://` navigations inside the user-gesture window, and any
  // await between the tap and the location.href assignment drops the
  // gesture flag and the Gmail app refuses to open. handleShare itself
  // launches Gmail synchronously, then builds the PDF afterwards.
  const handleConfirmSend = () => {
    setShowSharePrompt(false);
    handleShare();
  };

  // Manual fallback inside the auto-send flow: open the crew's mail app but
  // KEEP the popup up in a confirmation state — the PRF is only stamped as
  // sent once the crew explicitly says they sent it (stamping on a mere tap
  // would mark PRFs sent that never left the phone).
  const handleManualFallback = () => {
    handleShare();
    setManualConfirm(true);
  };

  const markManualSent = async () => {
    if (manualMarkBusy) return;
    setManualMarkBusy(true);
    try {
      const token = localStorage.getItem('access_token') || getCrewToken() || '';
      const to = sendEmailTo.trim();
      await axios.post(
        `/api/digital-prf/admin/by-case/${caseId}/email-facility/manual`,
        { recipient: SEND_EMAIL_RE.test(to) ? to : null },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setManualSent(true);
      setManualConfirm(false);
      setSentPhase('delivered');
      setSendStatus('sent');
    } catch {
      setSendError('Could not record the manual send — check your connection and tap again.');
    } finally {
      setManualMarkBusy(false);
    }
  };

  const SEND_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Terminal send-failure codes stamped by the backend, in crew language.
  const FACILITY_EMAIL_ERRORS: Record<string, string> = {
    smtp_auth_failed: "The provider's sending email rejected its app password — update it in Client Settings, or send manually below.",
    smtp_recipient_refused: 'The receiving address rejected the email — check the address and try again.',
    smtp_not_configured: 'No PRF sending email is configured for this provider yet — send manually below.',
  };
  const friendlySendError = (code: string) =>
    FACILITY_EMAIL_ERRORS[code] || 'Sending failed — you can send the PRF manually below.';

  // One-tap send: upload the rendered PDF; the backend emails it to the
  // receiving facility FROM the provider's own account (Celery + provider
  // SMTP). Guarded in-handler (not via the disabled attribute — Samsung
  // Internet can leave a disabled control inert after the flag clears).
  // After the server accepts (202 queued), poll briefly for the sent-stamp /
  // error so the crew sees the real outcome, not just queue-acceptance.
  const handleAutoSend = async () => {
    if (sendStatus === 'sending') return;
    const to = sendEmailTo.trim();
    if (!SEND_EMAIL_RE.test(to)) {
      setSendError('Enter a valid email address for the receiving facility.');
      return;
    }
    setSendError('');
    setSendStatus('sending');
    try {
      // Prefer the pre-warmed PDF. In the auto-send flow the prewarm is
      // usually still rendering on phones — wait for it (up to ~20s) rather
      // than kicking off a second, competing html2canvas build.
      let file = sharePdfFileRef.current || sharePdfFile;
      if (!file && pdfBuildStartedRef.current) {
        for (let i = 0; i < 40 && !sharePdfFileRef.current; i++) {
          await new Promise(r => setTimeout(r, 500));
        }
        file = sharePdfFileRef.current;
      }
      if (!file) {
        const pdf = await buildPrfPdf();
        if (!pdf) throw new Error('pdf_build_failed');
        file = new File([pdf.output('blob')], buildPrfFileName(prf), { type: 'application/pdf' });
        sharePdfFileRef.current = file;
        setSharePdfFile(file);
      }
      const token = localStorage.getItem('access_token') || getCrewToken() || '';
      const form = new FormData();
      form.append('recipient', to);
      // Re-sending an already-sent PRF (corrected address / deliberate
      // resend) needs the explicit force flag past the duplicate guard.
      if (prf.facility_email_sent_at || resendMode) form.append('force', 'true');
      form.append('file', file);
      const res = await axios.post(`/api/digital-prf/admin/by-case/${caseId}/email-facility`, form, {
        // The shared api client defaults Content-Type to application/json,
        // which silently corrupts a FormData upload (server saw no multipart
        // boundary → 422). Overriding to multipart/form-data makes axios set
        // the real boundary — same pattern as the provider logo upload.
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data' },
      });
      if (res.data?.status === 'already_sent') {
        setSentPhase('delivered');
        setSendStatus('sent');
        return;
      }
      setSentPhase('queued');
      setSendStatus('sent');
      // Poll for the actual outcome (worker sends within seconds when
      // healthy). The auto-send flow GATES the crew's return-to-dashboard on
      // confirmed delivery, so it polls much longer (~2 min) than a manual
      // tap. On timeout, surface an honest still-sending message with the
      // manual fallback rather than trapping the crew on scene.
      const attempts = autoSendFiredRef.current ? 24 : 6;
      for (let i = 0; i < attempts; i++) {
        await new Promise(r => setTimeout(r, 5000));
        try {
          const check = await axios.get(`/api/digital-prf/admin/by-case/${caseId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (check.data?.facility_email_sent_at) {
            setSentPhase('delivered');
            return;
          }
          if (check.data?.facility_email_error) {
            setSendStatus('error');
            setSendError(friendlySendError(check.data.facility_email_error));
            return;
          }
        } catch { /* transient — keep polling */ }
      }
      if (autoSendFiredRef.current) {
        setSendStatus('error');
        setSendError(
          'The email is still sending in the background. You can wait and try again, or send it manually below so the facility definitely has it.',
        );
      }
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setSendStatus('error');
      setSendError(
        detail === 'smtp_not_configured'
          ? 'No PRF sending email is configured for this provider yet — send manually below, or add the sending account in Client Settings.'
          : (typeof detail === 'string' && detail) || 'Could not send the PRF — you can send it manually below.',
      );
    }
  };

  // ── Gated send session on the post-submit flow ──
  // When the crew lands here from Confirm & Submit (?send=1) with a
  // receiving-facility email + a configured sending account, the popup runs
  // as a GATED session: the crew first VERIFIES the address and taps Send
  // (deliberately NOT auto-fired — an auto-start yanked the popup into
  // "sending" before the crew could review the address), then the status
  // screen holds them until delivery is confirmed. The ref marks the gated
  // session (longer delivery poll, no Skip).
  useEffect(() => {
    if (!prf || autoSendFiredRef.current) return;
    if (searchParams.get('send') !== '1') return;
    if (!prf.smtp_configured || prf.facility_email_sent_at) return;
    const to = (prf.form_data?.handover_doctor_email || '').trim();
    if (!SEND_EMAIL_RE.test(to)) return;
    autoSendFiredRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prf]);

  if (err) return <div style={{ padding: 48, color: '#b91c1c', fontWeight: 700, textAlign: 'center' }}>{err}</div>;
  if (!prf) return <div style={{ padding: 48, color: MUT, textAlign: 'center' }}>Loading PRF...</div>;

  const fd = prf.form_data || {};
  const ts = prf.timestamps || {};
  const km = prf.kms || {};
  const prov = prf.provider || {};
  const vehicle = prf.vehicle || {};

  const vitals: any[] = Array.isArray(fd.vitals_sets) ? fd.vitals_sets : [];
  // The clinical page (page 2) is sized for at most 3 vital-sets columns
  // before the per-cell width gets squeezed and rows visually clip. Anything
  // captured beyond the third set spills onto a continuation page below so
  // long codes / resuscitations don't lose their later readings.
  const VITALS_PER_PAGE = 3;
  const vitalsPage1: any[] = vitals.slice(0, VITALS_PER_PAGE);
  const vitalsOverflow: any[] = vitals.slice(VITALS_PER_PAGE);
  // Only rows with actual content count — the form can save a blank row shell
  // (section opened, nothing entered), and an all-blank row must not resurrect
  // an otherwise-hidden IV / Medication section on the PDF.
  const ivRows: any[] = (Array.isArray(fd.iv_therapy) ? fd.iv_therapy : [])
    .filter((r: any) => anyValue(r, ['type', 'jelco_size', 'site', 'vol_infused', 'time_up', 'indication', 'sign']));
  const medRows: any[] = (Array.isArray(fd.medications) ? fd.medications : [])
    .filter((r: any) => anyValue(r, ['type', 'route', 'dose', 'time', 'reason', 'sign']));

  // Documents the crew attached on the form (WCA / employee docs, RAF OAR
  // report) — each renders on its own sheet after the clinical pages, so the
  // exported PDF carries the supporting evidence. Photographed documents are
  // stored as JPEG data-URLs and embed as a full-page image; an uploaded
  // PDF file can't be painted into the page snapshot, so it renders as a
  // labelled record block instead (the original stays with the PRF).
  const attachedDocs = ([
    { key: 'wca_oar_report_pdf',     label: 'WCA Document' },
    { key: 'wca_employee_id_pdf',    label: 'Employee ID' },
    { key: 'wca_payslip_pdf',        label: 'Payslip' },
    { key: 'wca_medical_report_pdf', label: 'Medical Report' },
    { key: 'raf_oar_report_pdf',     label: 'OAR Report' },
  ] as Array<{ key: string; label: string }>)
    .map(d => ({ ...d, file: fd[d.key] as { name?: string; size?: number; data_url?: string } | undefined }))
    .filter(d => d.file && typeof d.file === 'object' && typeof d.file.data_url === 'string' && d.file.data_url);
  const isImageDoc = (f: any) => typeof f?.data_url === 'string' && f.data_url.startsWith('data:image/');

  // Depart + Arrival At Facility don't apply when the patient was never
  // transported: a Declaration of Death (deceased at scene) or an RHT
  // (Refused Hospital Transport) — so those two rows are omitted for both.
  const noTransport = fd.call_type === 'DOD' || fd.call_type === 'RHT';

  // A refusal, however it was reached.
  //
  // NOT just `call_type === 'RHT'`: the crew can tap "Patient Refuses Treatment"
  // on a call that was dispatched as a PRIMARY, which is how most refusals
  // actually happen — nobody is dispatched to a refusal. Keying the printed
  // layout off the call type alone would give a refused PRIMARY the full
  // billing-and-debtor layout with the refusal squeezed into a quarter of the
  // page, which is the arrangement this change exists to remove.
  const refused = fd.call_type === 'RHT' || !!fd.patient_refused_treatment;

  // Must cover EVERY field the Return Trip rows render — a guard that misses one
  // silently drops captured times from the PDF that goes to the scheme.
  // `return_depart_time` was checked here but is never written by the crew form;
  // the real keys are return_depart_scene_time and return_at_destination_time.
  const returnTripHasContent = !!(
    fd.return_despatch_time || fd.return_on_scene_time ||
    fd.return_depart_scene_time || fd.return_at_destination_time ||
    fd.return_handover_time || fd.return_available_time
  );

  const timeRows: Array<{ label: string; t: string; k: string; ret?: boolean }> = [
    { label: 'Call Disp',           t: 'time_dispatched',     k: 'km_dispatched'     },
    { label: 'Scene',               t: 'time_on_scene',       k: 'km_on_scene'       },
    ...(!noTransport ? [
      { label: 'Depart', t: 'time_depart_scene', k: 'km_depart_scene' },
      { label: 'Arrival At Facility', t: 'time_at_destination', k: 'km_at_destination' }
    ] : []),
    { label: 'Available',           t: 'time_available',      k: 'km_available'      },
  ];

  // Return leg (inter-facility only), paired two-up.
  //
  // These six times used to render as their own SectionHead + six FieldRows
  // inside BAND B's fourth column. That column also carries the Terms &
  // Conditions and the signatures and is already the tallest on the sheet, so
  // the 166px block pushed page 1 from 862px to 1030px — past the ~944px at
  // which the exporter can still place it on one A4 sheet. The export then
  // sliced the sheet in two THROUGH the crew signature boxes, leaving a
  // near-empty second page. That is the IFT/IHT "page 1 overlaps page 2" bug.
  //
  // They render in the journey-times column instead: the two legs belong
  // together, and paired two-up the block costs ~70px, which fits inside the
  // slack that column already had. Page 1 returns to the same height as a
  // Primary call, so IFT no longer sits on the edge of the sheet limit.
  const returnTripPairs: Array<[string, string, string, string]> = [
    ['Despatch', fd.return_despatch_time,     'On Scene',  fd.return_on_scene_time],
    ['Depart',   fd.return_depart_scene_time, 'At Dest',   fd.return_at_destination_time],
    ['Handover', fd.return_handover_time,     'Available', fd.return_available_time],
  ];

  // The payer-specific block lives in the "Billing Information" column and is
  // driven by billing_type. (The separate "Channel Detail" block was removed.)
  const billingType = (fd.billing_type || '').toString().toUpperCase();

  // Where the cash receipt prints.
  //
  // It is the bulkiest block the Billing column can carry — a section head,
  // four rows and two signature boxes — and on page 1 it crushed everything
  // beside it. Page 2 has room.
  //
  // But page 2 is not always available, and the receipt must NEVER simply
  // vanish: money changed hands, and this is the only record of who handed it
  // over. Two cases keep it on page 1:
  //   DOD      — page 2 is not rendered at all for a Declaration of Death.
  //   refused  — page 2 is the "Patient Refused Treatment" watermark and
  //              nothing else, and a refusal can still carry a cash call-out
  //              fee. Page 1 has room on a refusal anyway: the payer column
  //              moved into the stacked left-hand column and is mostly empty.
  //
  // Exactly one of the two call sites renders it, so it cannot print twice.
  const isCash = billingType === 'PVT' && fd.pvt_payment_method === 'Cash';
  // Moved off page 1 onto a sheet of their own — NOT onto page 2.
  //
  // Page 2 was the first attempt and it was wrong: the clinical sheet is
  // already close to the same ~944px ceiling, so adding the cash receipt and
  // the sticker (~380px together) simply moved the slice from page 1 to page 2,
  // cutting the secondary survey in half instead of the patient panel.
  //
  // A dedicated sheet also removes the special cases the page-2 version needed.
  // There was a "keep it on page 1 when there is no page 2" fallback for a
  // Declaration of Death (no clinical sheet at all) and for a refusal (page 2 is
  // the watermark alone). A sheet that is created on demand always exists, so
  // the blocks can neither vanish nor be squeezed, whatever the call type.
  const cashOnOwnSheet = isCash;

  // The hospital sticker moves for the same reason and under the same rules.
  //
  // It is the single tallest element page 1 carries and it sits in the same
  // column as Billing, which is already the tallest — which is why an IFT/IHT
  // with a sticker captured went over the ~944px one-sheet ceiling and the
  // exporter cut it into two half-empty sheets, through the middle of the
  // patient panel.
  //
  // Same guarantee as the cash receipt: exactly one of the two call sites
  // renders it, so it can neither vanish nor print twice. It stays on page 1
  // wherever page 2 cannot carry it — a Declaration of Death has no page 2, and
  // on a refusal page 2 is the watermark alone.
  const stickerVisible = !(fd.call_type === 'DOD' && fd.med_aid_dec_death) && fd.call_type !== 'RHT';
  // Only a CAPTURED sticker moves. The empty "affix here" slot is ~110px and
  // sits on page 1 quite happily; it is the 200px image that takes the block to
  // ~230px and pushes the sheet past the ceiling.
  //
  // A captured sticker ALREADY gets a full sheet of its own further down, from
  // the "Patient Documents (Attachments)" loop, which renders one page per
  // captured image and lists `hospital_sticker` first. So page 1 does not need
  // to carry the image and the attachments sheet must not carry it either —
  // rendering it there produced the SAME picture twice, once compact on the
  // attachments sheet and once full-size on its own page.
  //
  // That is the identical mistake `raf_oar_report_pdf` made (see the NOTE in
  // the attachments loop): one field fed into two page-producing lists. The
  // rule this file follows is that exactly ONE call site renders any given
  // artefact.
  //
  // Because the document sheet exists whenever a sticker was captured, no
  // extra page is created by deferring to it — so this applies to every call
  // type, not just transfers, and it removes the duplicate on all of them.
  const stickerOnDocumentSheet = stickerVisible && !!fd.hospital_sticker;

  // The sheet exists only when it has something to carry. The sticker is no
  // longer a reason to create it — the document sheet above covers that.
  const hasAttachmentSheet = cashOnOwnSheet;

  // ── Empty-section detection ──
  const debtorKeys = [
    'debtor_gender', 'debtor_name', 'debtor_surname',
    'debtor_id_number', 'debtor_age', 'debtor_address',
    'debtor_phone_home', 'debtor_phone_cell',
  ];
  const patientHasData = anyValue(fd, ['patient_name', 'patient_surname', 'patient_id_number']);
  // "Same as patient" is shown when the crew explicitly ticked the flag (even
  // if stale debtor text lingers in the record) OR when no debtor data exists.
  const debtorSameAsPatient =
    (Array.isArray(fd.flags) && fd.flags.includes('debtor_same_as_patient')) ||
    (!anyValue(fd, debtorKeys) && patientHasData);
  const valuablesEmpty = isBlank(fd.valuables_handed_to) && isBlank(fd.valuables_description) && isBlank(fd.valuables_signature) && isBlank(prf.signatures?.valuables_signature);
  // Page-1 "Motivation / Other Notes" is its own field now — NO fallback to
  // management_notes (that made the Motivation and Management boxes identical).
  const motivationNotes: string = fd.motivation_notes || '';

  const vitalsCols = Math.max(vitalsPage1.length, 5);
  const vitalsOverflowCols = Math.max(vitalsOverflow.length, 5);

  const recipientEmail = (fd.handover_doctor_email || '').trim();
  const patientFullName = [fd.patient_name, fd.patient_surname].filter(Boolean).join(' ') || 'the patient';

  // Auto-send session: the post-submit popup runs as a gated status screen
  // (no Skip; exit only on confirmed delivery or explicit manual fallback).
  // Derived eagerly (not just from the fired-ref) so the gate applies from
  // the very first paint, before the 800ms auto-fire.
  const autoSendActive = autoSendFiredRef.current || (
    searchParams.get('send') === '1' &&
    !!prf.smtp_configured &&
    !prf.facility_email_sent_at &&
    SEND_EMAIL_RE.test(recipientEmail)
  );
  const returnToDashboard = () => {
    if (searchParams.get('from') === 'admin' && providerSlug) {
      navigate(`/${providerSlug}/admin/dashboard?tab=prfs`);
    } else if (providerSlug) {
      navigate(`/${providerSlug}/crew/dashboard`);
    } else {
      navigate(-1);
    }
  };

  return (
    <div className="prf-screen-wrap" style={{
      background: '#eef1f4', minHeight: '100vh', padding: '28px 0',
      fontFamily: '"Segoe UI", -apple-system, Roboto, Arial, sans-serif',
    }}>
      {showSharePrompt && (
        <div className="no-print" style={{
          position: 'fixed', inset: 0, background: 'rgba(11,16,32,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 9999, padding: 16,
        }}>
          <div style={{
            background: '#fff', borderRadius: 12, maxWidth: 440, width: '100%',
            padding: '28px 26px', boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
            border: `1px solid ${LN}`,
          }}>
            <div style={{
              fontSize: '1.1rem', fontWeight: 800, color: INK, marginBottom: 8,
            }}>PRF submitted</div>
            {prf.smtp_configured ? (
              sendStatus === 'sent' ? (
                sentPhase === 'delivered' ? (
                  <>
                    {/* Delivery confirmed (or manual send confirmed by the
                        crew) — they may now leave the page. */}
                    <div style={{ fontSize: '0.92rem', color: '#15803d', fontWeight: 700, lineHeight: 1.5, marginBottom: 22 }}>
                      {manualSent
                        ? '✓ Marked as sent to the facility — no automatic copy will be sent'
                        : <>✓ PRF sent to <span style={{ wordBreak: 'break-word' }}>{sendEmailTo.trim()}</span></>}
                    </div>
                    <div style={{ display: 'flex', gap: 10, flexDirection: 'column' }}>
                      <button onClick={returnToDashboard} style={{
                        padding: '12px 18px', border: 'none', borderRadius: 8,
                        background: `linear-gradient(135deg, ${GREEN}, ${GREEN_DK})`,
                        color: '#fff', fontWeight: 800, fontSize: '0.92rem', cursor: 'pointer',
                      }}>Return to Dashboard</button>
                      <button onClick={() => setShowSharePrompt(false)} style={{
                        padding: '11px 18px', border: `1px solid #cbd5e1`, borderRadius: 8,
                        background: '#fff', color: INK, fontWeight: 700, fontSize: '0.86rem',
                        cursor: 'pointer',
                      }}>View PRF</button>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Queued — the popup stays put until delivery confirms. */}
                    <div style={{ fontSize: '0.92rem', color: '#15803d', fontWeight: 700, lineHeight: 1.5, marginBottom: 6 }}>
                      Sending PRF to <span style={{ wordBreak: 'break-word' }}>{sendEmailTo.trim()}</span>…
                    </div>
                    <div style={{ fontSize: '0.8rem', color: MUT, marginBottom: autoSendActive ? 0 : 18 }}>
                      Confirming delivery — please stay on this page.
                    </div>
                    {!autoSendActive && (
                      <button onClick={() => setShowSharePrompt(false)} style={{
                        width: '100%', padding: '12px 18px', border: 'none', borderRadius: 8,
                        background: `linear-gradient(135deg, ${GREEN}, ${GREEN_DK})`,
                        color: '#fff', fontWeight: 800, fontSize: '0.92rem', cursor: 'pointer',
                      }}>Done</button>
                    )}
                  </>
                )
              ) : manualConfirm ? (
                <>
                  {/* Mail app opened — the PRF stays "unsent" until the crew
                      confirms, so a dismissed share can never suppress the
                      automatic send OR create an untracked gap. */}
                  <div style={{ fontSize: '0.9rem', color: MUT, lineHeight: 1.5, marginBottom: 8 }}>
                    Send the PRF from your email app, then confirm below.
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#92400e', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '9px 11px', lineHeight: 1.45, marginBottom: 14 }}>
                    Confirming stops the system from emailing another copy automatically.
                  </div>
                  {sendError && (
                    <div style={{ fontSize: '0.78rem', color: '#b91c1c', lineHeight: 1.45, marginBottom: 12 }}>{sendError}</div>
                  )}
                  <div style={{ display: 'flex', gap: 10, flexDirection: 'column' }}>
                    <button onClick={() => { void markManualSent(); }} style={{
                      padding: '12px 18px', border: 'none', borderRadius: 8,
                      background: manualMarkBusy ? '#94a3b8' : `linear-gradient(135deg, ${GREEN}, ${GREEN_DK})`,
                      color: '#fff', fontWeight: 800, fontSize: '0.92rem',
                      cursor: manualMarkBusy ? 'wait' : 'pointer',
                    }}>{manualMarkBusy ? 'Recording…' : 'I sent it — mark as sent'}</button>
                    <button onClick={() => { setManualConfirm(false); setSendError(''); }} style={{
                      padding: '11px 18px', border: `1px solid #cbd5e1`, borderRadius: 8,
                      background: '#fff', color: INK, fontWeight: 700, fontSize: '0.86rem',
                      cursor: 'pointer',
                    }}>I did not send it</button>
                  </div>
                </>
              ) : (sendStatus === 'sending' && autoSendActive) ? (
                <>
                  {/* Auto-send in flight — pure status, nothing to tap. */}
                  <div style={{ fontSize: '0.92rem', color: MUT, fontWeight: 700, lineHeight: 1.5, marginBottom: 8 }}>
                    Preparing the PDF and sending to <strong style={{ color: INK, wordBreak: 'break-word' }}>{sendEmailTo.trim()}</strong>…
                  </div>
                  <div style={{ fontSize: '0.8rem', color: MUT }}>
                    Please stay on this page — this takes a few seconds.
                  </div>
                </>
              ) : (prf.facility_email_sent_at && !resendMode && sendStatus === 'idle') ? (
                <>
                  {/* Already emailed on a previous open — don't re-offer the
                      send form; the duplicate guard makes resends deliberate. */}
                  <div style={{ fontSize: '0.92rem', color: '#15803d', fontWeight: 700, lineHeight: 1.5, marginBottom: 8 }}>
                    ✓ Already sent to <span style={{ wordBreak: 'break-word' }}>{prf.facility_email_sent_to}</span>
                  </div>
                  <div style={{ fontSize: '0.78rem', color: MUT, marginBottom: 18 }}>
                    {fmtDate(prf.facility_email_sent_at)} {fmtTime(prf.facility_email_sent_at)}
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexDirection: 'column' }}>
                    <button onClick={() => setShowSharePrompt(false)} style={{
                      padding: '12px 18px', border: 'none', borderRadius: 8,
                      background: `linear-gradient(135deg, ${GREEN}, ${GREEN_DK})`,
                      color: '#fff', fontWeight: 800, fontSize: '0.92rem', cursor: 'pointer',
                    }}>Done</button>
                    <button onClick={() => setResendMode(true)} style={{
                      padding: '11px 18px', border: `1px solid #cbd5e1`, borderRadius: 8,
                      background: '#fff', color: INK, fontWeight: 700, fontSize: '0.86rem',
                      cursor: 'pointer',
                    }}>Send again</button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: '0.9rem', color: MUT, lineHeight: 1.5, marginBottom: 14 }}>
                    Email the PRF for <strong style={{ color: INK }}>{patientFullName}</strong> to
                    the receiving facility. Check the address, then tap Send.
                  </div>
                  {prf.facility_email_error && sendStatus === 'idle' && !sendError && (
                    <div style={{
                      fontSize: '0.78rem', color: '#92400e', background: '#fffbeb',
                      border: '1px solid #fcd34d', borderRadius: 8, padding: '9px 11px',
                      lineHeight: 1.45, marginBottom: 12,
                    }}>
                      Previous attempt did not go through: {friendlySendError(prf.facility_email_error)}
                    </div>
                  )}
                  <div style={{ fontSize: '0.68rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                    Receiving Facility Email
                  </div>
                  <input
                    type="email"
                    value={sendEmailTo}
                    onChange={e => { setSendEmailTo(e.target.value); if (sendError) setSendError(''); }}
                    autoComplete="off"
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '11px 12px',
                      // 16px exactly: below that iOS auto-zooms the page on
                      // focus, which this viewer now permits (see the viewport
                      // effect above).
                      fontSize: 16, border: `1.5px solid ${sendError ? '#fca5a5' : '#cbd5e1'}`,
                      borderRadius: 8, marginBottom: sendError ? 6 : 16, outline: 'none',
                      fontFamily: 'inherit', color: INK,
                    }}
                  />
                  {sendError && (
                    <div style={{ fontSize: '0.78rem', color: '#b91c1c', lineHeight: 1.45, marginBottom: 12 }}>
                      {sendError}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 10, flexDirection: 'column' }}>
                    <button onClick={() => { void handleAutoSend(); }} style={{
                      padding: '12px 18px', border: 'none', borderRadius: 8,
                      background: sendStatus === 'sending' ? '#94a3b8' : `linear-gradient(135deg, ${GREEN}, ${GREEN_DK})`,
                      color: '#fff', fontWeight: 800, fontSize: '0.92rem',
                      cursor: sendStatus === 'sending' ? 'wait' : 'pointer',
                      boxShadow: sendStatus === 'sending' ? 'none' : `0 4px 14px rgba(47,143,74,0.3)`,
                      letterSpacing: '0.02em',
                    }}>{sendStatus === 'sending' ? 'Sending…' : 'Send PRF to Facility'}</button>
                    {sendStatus === 'error' && (
                      <button onClick={handleManualFallback} style={{
                        padding: '11px 18px', border: `1.5px solid ${GREEN_DK}`, borderRadius: 8,
                        background: '#fff', color: GREEN_DK, fontWeight: 800, fontSize: '0.88rem',
                        cursor: 'pointer',
                      }}>Send manually instead</button>
                    )}
                    {/* In the gated post-submit flow there is no Skip — the
                        crew leaves via confirmed delivery or the explicit
                        manual fallback above. */}
                    {!autoSendActive && (
                      <button onClick={() => setShowSharePrompt(false)} style={{
                        padding: '11px 18px', border: `1px solid #cbd5e1`, borderRadius: 8,
                        background: '#fff', color: INK, fontWeight: 700, fontSize: '0.86rem',
                        cursor: 'pointer',
                      }}>Skip</button>
                    )}
                  </div>
                </>
              )
            ) : (
              <>
                {/* No provider sending account configured — manual share flow. */}
                <div style={{ fontSize: '0.9rem', color: MUT, lineHeight: 1.5, marginBottom: 22 }}>
                  Send a copy of the PRF for <strong style={{ color: INK }}>{patientFullName}</strong> to the receiving facility?
                  {recipientEmail
                    ? <> Gmail will open with the address <strong style={{ color: INK }}>{recipientEmail}</strong> and the PDF ready to attach.</>
                    : <> Gmail will open with the PDF — type the receiving facility's email address in the To field.</>
                  }
                </div>
                <div style={{ display: 'flex', gap: 10, flexDirection: 'column' }}>
                  <button onClick={handleConfirmSend} style={{
                    padding: '12px 18px', border: 'none', borderRadius: 8,
                    background: `linear-gradient(135deg, ${GREEN}, ${GREEN_DK})`,
                    color: '#fff', fontWeight: 800, fontSize: '0.92rem', cursor: 'pointer',
                    boxShadow: `0 4px 14px rgba(47,143,74,0.3)`, letterSpacing: '0.02em',
                  }}>Send a copy to receiving facility</button>
                  <button onClick={() => setShowSharePrompt(false)} style={{
                    padding: '11px 18px', border: `1px solid #cbd5e1`, borderRadius: 8,
                    background: '#fff', color: INK, fontWeight: 700, fontSize: '0.86rem',
                    cursor: 'pointer',
                  }}>Skip</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {/* Toolbar — hidden on print */}
      <div className="no-print" style={{
        maxWidth: 1220, margin: '0 auto 20px', display: 'flex',
        justifyContent: 'space-between', alignItems: 'center', padding: '0 16px',
      }}>
        <button onClick={() => {
          // When opened from the admin dashboard (?from=admin), return to the
          // Patient Report Forms tab rather than relying on browser history
          // (which would reset the dashboard to its default tab).
          if (searchParams.get('from') === 'admin' && providerSlug) {
            navigate(`/${providerSlug}/admin/dashboard?tab=prfs`);
          } else if (searchParams.get('send') === '1' && providerSlug) {
            // Post-submit flow: the previous history entry is the now-locked
            // FORM — navigate(-1) reopened the submitted PRF on its last
            // phase. After submit the only sensible Back is the shift
            // dashboard.
            navigate(`/${providerSlug}/crew/dashboard`);
          } else {
            navigate(-1);
          }
        }} style={{
          padding: '9px 16px', border: `1px solid #cbd5e1`, background: '#fff', color: INK,
          fontSize: '0.84rem', fontWeight: 700, cursor: 'pointer', borderRadius: 6,
          boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        }}>← Back</button>
        <div style={{ flex: 1 }} />
        {/* Send a copy to receiving facility — builds the PDF then opens
            the device share sheet so the crew can pick Gmail. On Gmail
            the PDF arrives as a ready-attached file. On browsers without
            Web Share file support, the PDF downloads and Gmail compose
            opens with the recipient pre-filled — the crew attaches the
            PDF manually. The button is only visible once the email field
            has a value (no destination otherwise). */}
        <button onClick={handleShare} title="Send a copy to receiving facility" aria-label="Send a copy to receiving facility" style={{
            width: 40, height: 40, padding: 0, border: 'none', marginRight: 10,
            background: 'linear-gradient(135deg, #2563eb, #1d4ed8)', color: '#fff',
            cursor: 'pointer', borderRadius: 6,
            boxShadow: '0 3px 10px rgba(37,99,235,0.3)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-10 5L2 7" />
            </svg>
          </button>
        <button onClick={handlePrint} title="Print" aria-label="Print" style={{
          width: 40, height: 40, padding: 0, border: `1px solid #cbd5e1`, marginRight: 10,
          background: '#fff', color: INK,
          cursor: 'pointer', borderRadius: 6,
          boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 6 2 18 2 18 9" />
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
            <rect x="6" y="14" width="12" height="8" />
          </svg>
        </button>
        <button onClick={handleSavePdf} disabled={savingPdf} title={savingPdf ? 'Building PDF…' : 'Save as PDF'} aria-label="Save as PDF" style={{
          width: 40, height: 40, padding: 0, border: 'none',
          background: savingPdf ? '#94a3b8' : `linear-gradient(135deg, ${GREEN}, ${GREEN_DK})`, color: '#fff',
          cursor: savingPdf ? 'wait' : 'pointer', borderRadius: 6,
          boxShadow: `0 3px 10px rgba(47,143,74,0.3)`,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {savingPdf ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.5" strokeLinecap="round" style={{ animation: 'prfPdfSpin 0.8s linear infinite' }}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <line x1="10" y1="9" x2="8" y2="9" />
            </svg>
          )}
        </button>
      </div>

      {/* Reader zoom — small screens only (fit-to-width under ~0.7, i.e. phones
          and portrait tablets). The top toolbar is already tight on a phone, so
          this rides as a floating pill above the safe-area inset where it stays
          reachable no matter how far down the sheet you have scrolled. */}
      {fitScale < 0.7 && (
        <div className="no-print" style={{
          position: 'fixed', left: '50%', transform: 'translateX(-50%)',
          bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
          display: 'flex', alignItems: 'center', gap: 2, zIndex: 60,
          background: 'rgba(15,23,42,0.92)', borderRadius: 999, padding: 4,
          boxShadow: '0 8px 26px rgba(0,0,0,0.32)',
        }}>
          <button onClick={() => stepZoom(-1)} aria-label="Zoom out"
            disabled={(userZoom ?? fitScale) <= fitScale}
            style={zoomBtn((userZoom ?? fitScale) <= fitScale)}>−</button>
          <button onClick={() => setUserZoom(null)} aria-label="Fit the page to the screen" style={{
            minWidth: 76, height: 38, padding: '0 12px', border: 'none', borderRadius: 999,
            background: 'transparent', color: '#fff', fontWeight: 800, fontSize: '0.82rem',
            fontFamily: 'inherit', cursor: 'pointer', letterSpacing: '0.02em',
          }}>{userZoom ? `${Math.round(userZoom * 100)}%` : 'Fit'}</button>
          <button onClick={() => stepZoom(1)} aria-label="Zoom in"
            disabled={(userZoom ?? fitScale) >= 2}
            style={zoomBtn((userZoom ?? fitScale) >= 2)}>+</button>
        </div>
      )}

      <style>{`
        @keyframes prfPdfSpin { to { transform: rotate(360deg); } }
        /* On phones the 1220px A4 sheets are wider than the viewport, and the
           app's global overflow-x:hidden (html/body/#root) clips them with no
           way to pan. Make the PRF screen its own horizontal scroll container
           so the crew can scroll left-right across the sheet (touch momentum
           kept for older iOS). Screen only — print/PDF pipelines are
           unaffected (print styles below reset this wrapper anyway). */
        .prf-screen-wrap {
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
        }
        /* Print pipeline — fit each PRF page to ONE A4 landscape sheet:
             - @page is A4 landscape with zero printer margins (form has
               its own outer border, no need for OS margins).
             - Each .prf-page is wrapped in .prf-print-frame which is sized
               to the full A4 landscape sheet (297mm × 210mm). page-break-
               after on the frame guarantees exactly one sheet per page —
               no leading blanks, no overflow tail.
             - The .prf-page is rendered at its natural 1220px width and
               then shrunk via CSS zoom (computed per-page in JS at
               beforeprint). Unlike transform scale, zoom shrinks the
               layout box too — Chrome's print engine page-breaks against
               the scaled-down box, so the form fits cleanly inside the
               sheet without right-edge clipping.
        */
        @page { size: A4 landscape; margin: 0; }
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
        @media print {
          html, body {
            background: #fff !important;
            margin: 0 !important;
            padding: 0 !important;
            height: auto !important;
            min-height: 0 !important;
          }
          .no-print { display: none !important; }
          /* Collapse every layout ancestor of the print frames so the first
             frame starts at the very top of sheet 1 — no leading blank sheet
             from .app-layout's min-height: 100vh, .main-content's flex
             centring, or .prf-screen-wrap's screen padding/min-height. */
          .app-layout, .main-content, .prf-screen-wrap {
            display: block !important;
            padding: 0 !important;
            margin: 0 !important;
            min-height: 0 !important;
            height: auto !important;
            background: #fff !important;
            align-items: initial !important;
          }
          .prf-print-frame {
            /* Each frame is one A4 landscape sheet and clips its contents.
               The .prf-page inside is transform-scaled (in JS at beforeprint)
               to fit within this box, so each page lands on a single sheet.
               CRITICAL: both dimensions sit clearly UNDER the 297×210mm sheet.
               At exactly 297mm wide / 208mm tall, sub-mm print rounding made
               frames bleed a 1-2px sliver onto the next sheet; combined with
               break-inside:avoid that pushed every following form page down a
               sheet — producing the alternating-blank-page PDFs. */
            width: 295mm;
            height: 205mm;
            overflow: hidden;
            page-break-after: always;
            page-break-inside: avoid;
            break-inside: avoid;
            margin: 0 !important;
            padding: 0 !important;
            position: relative;
            display: block;
          }
          .prf-print-frame:last-child { page-break-after: auto; }
          /* A page too tall to fit ONE sheet at a readable size. beforeprint
             adds this class and shrinks that page with CSS zoom (which shrinks
             the layout box) rather than transform, so the print engine can
             paginate it. The frame must release its fixed height and its
             clipping here or the overflow would be cut off the paper instead
             of flowing — losing fields rather than spending an extra sheet. */
          .prf-print-frame.prf-frame-flow {
            height: auto;
            overflow: visible;
            page-break-inside: auto;
            break-inside: auto;
          }
          .prf-page {
            box-shadow: none !important;
            margin: 0 !important;
            border: 2px solid ${LN} !important;
            /* Width is NOT forced here — the beforeprint fit() may widen a
               too-tall page (fill-the-sheet reflow) and an !important rule
               would override that inline width and reintroduce the white
               right gutter on page 1. The inline style carries the 1220px
               design width by default. */
            /* Drop the on-screen 862px min-height in print. Transform only
               shrinks the page VISUALLY — its layout box keeps this height, and
               at 862px (~228mm) that box is taller than the 208mm sheet frame,
               so a sliver bled onto a second (blank) sheet. min-height:0 lets
               the layout box equal the real content height so nothing bleeds. */
            min-height: 0 !important;
            box-sizing: border-box !important;
            transform-origin: top left !important;
            /* transform: scale() is set per-page in JS at beforeprint so the
               fixed-width design shrinks to fit one sheet. transform-origin is
               top-left so the page anchors to the sheet's top-left corner (no
               centring offset that would clip the right edge). border-box keeps
               the 2px border inside the measured width. */
          }
        }
      `}</style>

      <div id="prf-pdf-content">
      {/* ═══════════════════ PAGE 1 — Administrative & Context ═══════════════════
          Sized to A4-landscape aspect (1220 × 862 ≈ 297×210mm @ 96dpi),
          locked to fixed height with overflow:hidden so the captured
          canvas matches the PDF destination exactly — no stretch, no
          slice. Three horizontal bands stack at natural height:
            • Band A — brand / address / call info / alpha-unit times
            • Band B — patient / clinical summary / med-aid / channel
            • Band C — debtor / handover+sticker / valuables+sigs / terms
          Every captured field is rendered; empty-only sections fold. */}
      <div className="prf-print-frame">
      <div className="prf-page" style={{
        width: 1220, minHeight: 862,
        margin: '0 auto', background: '#fff', color: INK,
        border: `2px solid ${LN}`, boxShadow: '0 6px 24px rgba(0,0,0,0.1)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* ── BAND A — Brand │ Address+Date+Call-Type │ Call Info │ Alpha Unit + Times ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.95fr 1.45fr 2.2fr 2.0fr' }}>
          {/* Brand block — framed logo placeholder + enlarged provider details */}
          <div style={{
            padding: '10px 12px', borderRight: `1px solid ${LN}`,
            display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 7,
          }}>
            {/* Dedicated, outlined logo placeholder — always shows the frame so
                the brand mark sits in a consistent box on every provider's PRF.
                The logo scales to fit (objectFit:contain + maxWidth:100%): it is
                never cropped or stretched — a wide logo just uses the extra
                width, a tall one fills the height. */}
            <div style={{
              border: `1.5px solid ${LN}`, borderRadius: 6, background: '#fff',
              height: 78, display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '5px 12px', overflow: 'hidden',
            }}>
              <ProviderLogo prov={prov} height={62} />
            </div>
            {prov.phone && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{ fontSize: '0.5rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', letterSpacing: '0.09em' }}>Phone</span>
                <span style={{
                  fontSize: '1.02rem', fontWeight: 900, color: INK,
                  fontFamily: 'ui-monospace, monospace', letterSpacing: '0.02em',
                }}>{prov.phone}</span>
              </div>
            )}
            {prov.pr_number && (
              <div style={{ fontSize: '0.74rem', fontWeight: 700, color: MUT, letterSpacing: '0.03em' }}>
                PR No: <span style={{ fontFamily: 'ui-monospace, monospace', color: INK, fontWeight: 800 }}>{prov.pr_number}</span>
              </div>
            )}
            {prov.pty_reg_number && (
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: MUT, letterSpacing: '0.03em' }}>
                Co Reg: <span style={{ fontFamily: 'ui-monospace, monospace', color: INK, fontWeight: 800 }}>{prov.pty_reg_number}</span>
              </div>
            )}
          </div>

          {/* Address + meta (date / case / call type) */}
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
            {prov.address && (
              <div style={{ padding: '8px 10px 3px', fontSize: '0.82rem', fontWeight: 600, color: INK, whiteSpace: 'pre-wrap', lineHeight: 1.3 }}>
                {prov.address}
              </div>
            )}
            {prov.email && (
              <div style={{ padding: '0 10px 7px', fontSize: '0.74rem', fontWeight: 700, color: GREEN_DK, wordBreak: 'break-word' }}>{prov.email}</div>
            )}
            <FieldRow label="Date" value={fmtDate(ts.time_call_received || prf.submitted_at)} />
            <FieldRow label="Case No" value={prf.case_number} />
            {/* "Basis", because the value is a category — Standard, After
                Hours, No Patient Loaded, Refusal Of Treatment — and not an
                amount. Printed under a bare "Call-Out Fee" heading, "Refusal Of
                Treatment" reads as a charge description on a document a scheme
                assesses.

                Deliberately left on the default label width: every other row in
                this stack uses it, and widening one would step the label column
                out of line. The longer label wraps to two lines, which the
                values in this block already do. */}
            {fd.rht_call_out_fee && <FieldRow label="Call-Out Fee Basis" value={fd.rht_call_out_fee} />}
            {/* Assessment level + Billing Type. PVT shows its payment method
                too ("PVT — Cash") so cash settlements are visible at a glance. */}
            {fd.call_type !== 'DOD' && <FieldRow label="Assessment"   value={fd.assessment_level} />}
            {/* Monitoring level — the level of care actually delivered DURING
                transport, as opposed to the level assessed on scene. The crew
                is required to record it and the form warns when the two differ,
                but only "Assessment" used to reach the PDF, so a call assessed
                BLS and monitored ALS printed as plain BLS. Hidden when it is
                the same as the assessment, to keep the band compact. */}
            {fd.call_type !== 'DOD' && fd.monitoring_level
              && fd.monitoring_level !== fd.assessment_level && (
              <FieldRow label="Monitoring" value={fd.monitoring_level} />
            )}
            {/* Transfer reason (IFT/IHT). A Social Transfer and an Upgrade
                Transfer are reimbursed completely differently — one is often
                not a benefit at all — yet both used to print only as the call
                type, so the scheme could not adjudicate what it was billed. */}
            {fd.transfer_subtype && <FieldRow label="Transfer Reason" value={fd.transfer_subtype} />}
            {/* Courtesy calls are non-billable transfers — no billing type is
                captured, so the row (which would render an empty "—") is hidden. */}
            {fd.call_type !== 'COURTESY' && (
              <FieldRow label="Billing Type" value={
                fd.billing_type === 'PVT' && fd.pvt_payment_method
                  ? `PVT — ${fd.pvt_payment_method}`
                  : fd.billing_type
              } />
            )}
            {/* Call type — rendered as a standard labelled field row; flex:1
                stretches it to fill the remaining column height. */}
            {(() => {
              const ct = (fd.call_type || '').toUpperCase();
              let display = 'Primary';
              if (ct === 'RESUS') display = 'Resus';
              else if (ct === 'DOD') display = 'DOD';
              else if (ct === 'WCA_IOD') display = 'WCA / IOD';
              // RHT is NOT a transfer — it is the opposite of one. Grouping it
              // with the transfer types printed "Transfer — RHT" on a call
              // where nobody was moved, which is what a scheme assessor, the
              // Council or a court reads off the face of the document.
              else if (ct === 'RHT') display = 'Refused Hospital Transport';
              else if (['IHT', 'IFT', 'COURTESY'].includes(ct)) display = `Transfer — ${ct}`;
              else if (ct && ct !== 'PRIMARY') display = ct;
              return <FieldRow label="Call Type" value={display} flex={1} />;
            })()}
          </div>

          {/* Call Information */}
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
            <SectionHead label="Call Information" />
            <FieldRow label="Incident Add"  value={fd.incident_location} />
            {/* Suburb/Ward + Destination + handover rows don't apply when the
                patient was never transported to a facility — a Declaration of
                Death (deceased at scene) or an RHT (Refused Hospital Transport)
                — so the whole block is omitted for both. */}
            {!noTransport && (
              <>
                <FieldRow label="Suburb / Ward" value={fd.suburb_ward} />
                <FieldRow label="Dest Facility" value={fd.receiving_facility} />
                <FieldRow label="Ward"          value={fd.ward} />
                <FieldRow label={fd.call_type === 'COURTESY' ? "Receiving Dr/Person" : "Receiving Dr"}  value={fd.receiving_doctor} />
                <FieldRow label="Qualification" value={fd.handover_qualification} />
                <FieldRow label="Condition" value={fd.handover_notes} valueMin={24} />
                <FieldRow label="Receiving Facility Email" value={fd.handover_doctor_email} />
              </>
            )}
            {fd.call_type === 'DOD'
              ? <div style={{ flex: 1, borderTop: `1px solid ${LN}`, background: GREEN_TINT }} />
              : <FillLines />}
          </div>

          {/* Ambulance Call sign + Times/KM grid. The column is a flex stack so
              the time rows can GROW to fill the column's full height — this
              pushes them down and closes the white gap that used to sit below
              AVAILABLE, so the rows span the same vertical extent as the Call
              Information column beside them. */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <SectionHead
              label="Ambulance Call sign"
              rightLabel={vehicle.callsign ? 'CALLSIGN' : undefined}
              rightValue={vehicle.callsign}
            />
            {vehicle.registration && (
              <div style={{
                padding: '2px 8px', minHeight: 17, fontSize: '0.64rem', fontWeight: 700,
                background: GREEN_TINT, borderBottom: `1px solid ${LN}`,
                fontFamily: 'ui-monospace, monospace', letterSpacing: '0.04em', color: INK,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <span>{vehicle.registration}</span>
                {vehicle.vehicle_type && <span style={{ color: MUT, fontWeight: 600 }}>{vehicle.vehicle_type}</span>}
              </div>
            )}
            <div style={{
              display: 'grid', gridTemplateColumns: '1.6fr 0.7fr 1fr',
              fontSize: '0.54rem', fontWeight: 800, textTransform: 'uppercase',
              letterSpacing: '0.06em', background: GREEN_TINT,
              borderBottom: `1px solid ${LN}`, color: INK,
            }}>
              <div style={{ padding: '2px 6px', minHeight: 13, display: 'flex', alignItems: 'center', borderRight: `1px solid ${LN}` }}>Event</div>
              <div style={{ padding: '2px 6px', minHeight: 13, display: 'flex', alignItems: 'center', borderRight: `1px solid ${LN}` }}>Time</div>
              <div style={{ padding: '2px 6px', minHeight: 13, display: 'flex', alignItems: 'center' }}>KM</div>
            </div>
            {/* Time rows fill the remaining height, distributed evenly so the
                last row (AVAILABLE) reaches the bottom of the band. */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              {timeRows.map(r => (
                <div key={r.t} style={{
                  flex: 1, display: 'grid', gridTemplateColumns: '1.6fr 0.7fr 1fr',
                  borderTop: `1px solid ${LN}`, fontSize: '0.76rem',
                }}>
                  <div style={{ padding: '2px 6px', display: 'flex', alignItems: 'center', fontWeight: 700, borderRight: `1px solid ${LN}`, background: GREEN_TINT, fontSize: '0.56rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: INK }}>{r.label}</div>
                  <div style={{ padding: '2px 6px', display: 'flex', alignItems: 'center', borderRight: `1px solid ${LN}`, fontFamily: 'ui-monospace, monospace' }}>{fmtTime(ts[r.t])}</div>
                  <div style={{ padding: '2px 6px', display: 'flex', alignItems: 'center', fontFamily: 'ui-monospace, monospace' }}>{(r.k && km[r.k]) || ''}</div>
                </div>
              ))}
            </div>
            {/* Return leg — inter-facility transfers only. Paired two-up so the
                six times cost ~70px here instead of 166px in the Band B column
                that was overflowing the sheet. See `returnTripPairs` above. */}
            {returnTripHasContent && (
              <div style={{ flexShrink: 0 }}>
                <div style={{
                  padding: '2px 6px', minHeight: 13, fontSize: '0.54rem', fontWeight: 800,
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                  background: GREEN_TINT, borderTop: `1px solid ${LN}`,
                  borderBottom: `1px solid ${LN}`, color: INK,
                }}>Return Trip</div>
                {returnTripPairs.map(([l1, v1, l2, v2]) => (
                  <div key={l1} style={{
                    display: 'grid', gridTemplateColumns: '1fr 0.62fr 1fr 0.62fr',
                    borderBottom: `1px solid ${LN}`, fontSize: '0.7rem',
                  }}>
                    <div style={{ padding: '1px 6px', display: 'flex', alignItems: 'center', fontWeight: 700, borderRight: `1px solid ${LN}`, background: GREEN_TINT, fontSize: '0.52rem', textTransform: 'uppercase', letterSpacing: '0.03em', color: INK }}>{l1}</div>
                    <div style={{ padding: '1px 4px', display: 'flex', alignItems: 'center', borderRight: `1px solid ${LN}`, fontFamily: 'ui-monospace, monospace' }}>{v1 || ''}</div>
                    <div style={{ padding: '1px 6px', display: 'flex', alignItems: 'center', fontWeight: 700, borderRight: `1px solid ${LN}`, background: GREEN_TINT, fontSize: '0.52rem', textTransform: 'uppercase', letterSpacing: '0.03em', color: INK }}>{l2}</div>
                    <div style={{ padding: '1px 4px', display: 'flex', alignItems: 'center', fontFamily: 'ui-monospace, monospace' }}>{v2 || ''}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── BAND B — For DOD calls the Declaration of Death renders first ──
            ⚠ SECOND IMPLEMENTATION EXISTS. The same statutory block is also
            rendered as its own dedicated A4 sheet further down this file,
            under the complementary guard `fd.med_aid_dec_death &&
            fd.call_type !== 'DOD'` — search for "DECLARATION OF DEATH SHEET".
            The two guards are mutually exclusive, so nothing renders twice and
            neither is dead; but roughly 40 FieldRows are repeated verbatim
            between them, so ANY change to the deceased/informant/sign-off
            fields must be made in BOTH places or the two drift apart.
            Deliberately NOT merged: the columns, grid ratios, masthead and
            sign-off placement genuinely differ, so a shared component would
            need enough props that the abstraction buys little while risking
            layout shift on a legal document. Revisit post-pilot. */}
        {fd.call_type === 'DOD' && fd.med_aid_dec_death && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', borderTop: `2px solid ${LN}` }}>
            {/* Column 1 — event + deceased */}
            <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
              <SectionHead label="Declaration of Death" />
              <FieldRow label="Date"                 value={fd.med_aid_dec_death_date} />
              <FieldRow label="Time of Death"        value={fd.med_aid_dec_death_time} />
              <FieldRow label="Location of Body"     value={fd.med_aid_dec_death_location} />
              <FieldRow label="Identified By"        value={fd.med_aid_dec_death_identified_by} />

              <SectionHead label="Particulars of Deceased" />
              <FieldRow label="Gender"       value={fd.med_aid_dec_death_deceased_gender} />
              <FieldRow label="First Name"   value={fd.med_aid_dec_death_deceased_first_name} />
              <FieldRow label="Surname"      value={fd.med_aid_dec_death_deceased_surname} />
              <FieldRow label="ID Number"    value={fd.med_aid_dec_death_deceased_id} />
              {!isBlank(fd.med_aid_dec_death_deceased_passport) && (
                <FieldRow label="Passport No" value={fd.med_aid_dec_death_deceased_passport} />
              )}
              <FieldRow label="Date of Birth" value={fd.med_aid_dec_death_deceased_dob} />
              <FieldRow label="Age"          value={fd.med_aid_dec_death_deceased_age} />
              <FieldRow label="Cell"         value={fd.med_aid_dec_death_deceased_cell} />
              <FieldRow label="Tel (H)"      value={fd.med_aid_dec_death_deceased_tel_home} />
              <FieldRow label="Tel (W)"      value={fd.med_aid_dec_death_deceased_tel_work} />
              <FieldRow label="Res. Address" value={fd.med_aid_dec_death_deceased_address} />
              <FieldRow label="Suburb"       value={fd.med_aid_dec_death_deceased_suburb} />
              <FieldRow label="Code"         value={fd.med_aid_dec_death_deceased_postal_code} />

              {/* Crew 1 sign-off — pre-submit Crew Sign-Off modal signature.
                  Crew 2's block lives at the bottom of column 2 and the
                  Undertaker block at the bottom of column 3, so the three
                  columns come out roughly equal in height. */}
              {(prf.crew_1 || fd.crew_signoff_sigs?.c1 || prf.signatures?.crew_signature || fd.assessed_by) && (
                <>
                  <SectionHead label="Crew 1 Sign-Off" />
                  <FieldRow label="Name"  value={prf.crew_1?.full_name || fd.assessed_by} />
                  <FieldRow label="Qual"  value={prf.crew_1?.qualification || fd.assessor_qualifications} />
                  <FieldRow label="HPCSA" value={prf.crew_1?.hpcsa_number} />
                  <div style={{ padding: '6px 8px', borderTop: `1px solid ${LN}` }}>
                    <div style={{ fontSize: '0.52rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Signature</div>
                    <SignatureBox src={fd.crew_signoff_sigs?.c1 || prf.signatures?.crew_signature} minHeight={56} />
                  </div>
                </>
              )}
            </div>

            {/* Column 2 — practitioner + medical confirmation + handover */}
            <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
              <SectionHead label="Healthcare Professional" />
              <FieldRow label="Surname"        value={fd.med_aid_dec_death_hcp_surname} />
              <FieldRow label="First Name"     value={fd.med_aid_dec_death_hcp_first_name} />
              <FieldRow label="Station"        value={fd.med_aid_dec_death_hcp_station} />
              <FieldRow label="Qualification"  value={fd.med_aid_dec_death_hcp_qualification} />
              <FieldRow label="ID No"          value={fd.med_aid_dec_death_hcp_id} />
              <FieldRow label="Practitioner No" value={fd.med_aid_dec_death_hcp_hpcsa} />

              <SectionHead label="Confirmation of Death" />
              <FieldRow label="Absent Carotid Pulse"   value={fd.med_aid_dec_death_med_carotid} />
              <FieldRow label="Absent Heart Sounds"    value={fd.med_aid_dec_death_med_heart_sounds} />
              <FieldRow label="Absent Resp. Activity"  value={fd.med_aid_dec_death_med_respiratory} />
              <FieldRow label="ECG Asystole (I/II/III)" value={fd.med_aid_dec_death_med_ecg} />
              <FieldRow label="Fixed/Dilated Pupils"   value={fd.med_aid_dec_death_med_pupils} />

              <SectionHead label="Deceased Handed Over To" />
              <FieldRow label="Surname"       value={fd.med_aid_dec_death_handover_surname} />
              <FieldRow label="First Name"    value={fd.med_aid_dec_death_handover_first_name} />
              <FieldRow label="Relationship"  value={fd.med_aid_dec_death_handover_relationship} />
              <FieldRow label="Contact No"    value={fd.med_aid_dec_death_handover_contact} />
              
              {!fd.undertaker_name && !fd.undertaker_collector_signature && (
                <div style={{ padding: '6px 8px', borderTop: `1px solid ${LN}` }}>
                  <div style={{ fontSize: '0.52rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Recipient Signature</div>
                  <SignatureBox src={prf.signatures?.handover_signature} minHeight={64} />
                </div>
              )}

              {/* Crew 2 sign-off — placed here (not under Crew 1) to balance
                  the three column heights. */}
              {(prf.crew_2 || fd.crew_signoff_sigs?.c2 || prf.signatures?.crew_2_signature || fd.managed_by) && (
                <>
                  <SectionHead label="Crew 2 Sign-Off" />
                  <FieldRow label="Name"  value={prf.crew_2?.full_name || fd.managed_by} />
                  <FieldRow label="Qual"  value={prf.crew_2?.qualification || fd.manager_qualifications} />
                  <FieldRow label="HPCSA" value={prf.crew_2?.hpcsa_number} />
                  <div style={{ padding: '6px 8px', borderTop: `1px solid ${LN}` }}>
                    <div style={{ fontSize: '0.52rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Signature</div>
                    <SignatureBox src={fd.crew_signoff_sigs?.c2 || prf.signatures?.crew_2_signature} minHeight={56} />
                  </div>
                </>
              )}
            </div>

            {/* Column 3 — the signed declaration */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <SectionHead label="Declaration" />
              <div style={{
                padding: '6px 8px', borderTop: `1px solid ${LN}`,
                fontSize: '0.62rem', color: INK, lineHeight: 1.5, background: SOFT_BG,
              }}>
                I, the undersigned, hereby declare that the deceased sustained no further harm while in my care, and
                that the above facts are, to the best of my knowledge, true and correct.
              </div>
              <FieldRow label="Date"  value={fd.med_aid_dec_death_signature_date} />
              <FieldRow label="Place" value={fd.med_aid_dec_death_signature_place} />

              {/* Signatory */}
              <FieldRow label="Full Name" value={fd.med_aid_dec_death_signatory_name} />
              <div style={{ padding: '6px 8px', borderTop: `1px solid ${LN}` }}>
                <div style={{ fontSize: '0.52rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Signature</div>
                <SignatureBox src={fd.med_aid_dec_death_signature} minHeight={64} />
              </div>

              {/* Crew member 2 */}
              <FieldRow label="Crew Member 2" value={fd.med_aid_dec_death_crew_attended_name} />
              <div style={{ padding: '6px 8px', borderTop: `1px solid ${LN}` }}>
                <div style={{ fontSize: '0.52rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Crew Signature</div>
                <SignatureBox src={fd.med_aid_dec_death_crew_attended_signature} minHeight={64} />
              </div>

              {/* Witness — a witness is optional on a DOD, so the whole block
                  (name + signature) is omitted unless one was captured, rather
                  than printing an empty "Not captured" box. */}
              {(!isBlank(fd.med_aid_dec_death_witness_name) || !isBlank(fd.med_aid_dec_death_witness_signature)) && (
                <>
                  <FieldRow label="Witness Name" value={fd.med_aid_dec_death_witness_name} />
                  <div style={{ padding: '6px 8px', borderTop: `1px solid ${LN}` }}>
                    <div style={{ fontSize: '0.52rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Witness Signature</div>
                    <SignatureBox src={fd.med_aid_dec_death_witness_signature} minHeight={64} />
                  </div>
                </>
              )}

              {/* Undertaker — moved from column 2 to fill this column's slack
                  and keep the three columns roughly equal in height. */}
              {(fd.undertaker_name || fd.undertaker_collector_signature) && (
                <>
                  <SectionHead label="Undertaker Details" />
                  <FieldRow label="Company Name" value={fd.undertaker_name} />
                  <FieldRow label="Phone No" value={fd.undertaker_phone} />
                  <FieldRow label="Collector" value={fd.undertaker_collector_name} />
                  <div style={{ padding: '6px 8px', borderTop: `1px solid ${LN}` }}>
                    <div style={{ fontSize: '0.52rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Undertaker Signature</div>
                    <SignatureBox src={fd.undertaker_collector_signature} minHeight={64} />
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        
        {/* On a refusal the four columns collapse to two, and the payer columns
            stack down the left.

            The refusal declaration, the practitioner's capacity checklist, the
            patient's stated reason and two signatures were being rendered into
            a quarter-width column, while three columns carried Patient, Debtor
            and Billing — of which Debtor and Billing are almost entirely blank,
            because nobody was transported and there is nothing to bill. The
            document's most important block had the least room on the page.

            Placed with CSS rather than by reordering the JSX: these four are
            long, deeply nested siblings, and moving them physically to change
            their visual order is a large edit with nothing to gain. Grid
            placement expresses the same result in one property each. */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: refused
            ? '1.5fr 2.7fr'
            : (fd.call_type === 'DOD' && fd.med_aid_dec_death) ? '1fr 1fr' : '1.64fr 1.36fr 1.8fr 1.6fr',
          // auto/auto/1fr: Patient and Billing take only the height they need,
          // Debtor absorbs the remainder so the left column still reaches the
          // bottom rule and the page does not end in a ragged edge.
          ...(refused ? { gridTemplateRows: 'auto auto 1fr' } : {}),
          borderTop: `2px solid ${LN}`, flex: 1, minHeight: 0,
        }}>
          {/* Patient Information — only fields the crew actually captured are
              shown; blank rows are omitted (no column of "—"). DOB prints
              dd/mm/yyyy. */}
          {!(fd.call_type === 'DOD' && fd.med_aid_dec_death) && (
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column',
                        ...(refused ? { gridColumn: 1, gridRow: 1 } : {}) }}>
            <SectionHead label="Patient Information" />
            {(([
              ['Gender',        fd.gender],
              ['Name',          fd.patient_name],
              ['Surname',       fd.patient_surname],
              ['ID No',         fd.patient_id_number],
              ['Passport',      fd.patient_passport_number],
              ['Age',           fd.age],
              ['DOB',           fmtDateValue(fd.patient_dob)],
              ['Res. Address',  fd.patient_address],
              ['Res. Suburb',   fd.patient_suburb],
              ['Res. Code',     fd.patient_postal_code],
              ['Postal Add',    fd.patient_postal_address],
              ['Postal Suburb', fd.patient_postal_suburb],
              ['Postal Code',   fd.patient_postal_address_code],
              ['Tel (H)',       fd.patient_phone_home],
              ['Tel (W)',       fd.patient_phone_work],
              ['Cell',          fd.patient_phone_cell],
              ['Accompanying',  fd.accompanying_persons_count],
            ] as Array<[string, any]>)
              .filter(([, v]) => !isBlank(v)))
              .map(([label, v]) => <FieldRow key={label} label={label} value={v} />)}
            {fd.call_type !== 'DOD' && (() => {
              const selected = Array.isArray(fd.mechanism)
                ? fd.mechanism.filter(Boolean)
                : (fd.mechanism ? [fd.mechanism] : []);
              const hasMechanism = selected.length > 0 || !isBlank(fd.mechanism_other);
              // Resus never captures a triage priority (the form hides the
              // picker), so it's always omitted there; otherwise show only when
              // a priority was actually captured.
              const hasPriority = fd.call_type !== 'RESUS' && !isBlank(fd.priority);
              return (
                <>
                  {/* Mechanism — hidden entirely when nothing was captured. */}
                  {hasMechanism && (
                    <>
                      <SectionHead label="Mechanism" />
                      {selected.map((m: string) => <Chk key={m} label={m} checked />)}
                      {fd.mechanism_other && (
                        <FieldRow label="Detail" value={fd.mechanism_other} valueMin={24} />
                      )}
                    </>
                  )}
                  {/* Patient Priority — hidden when not captured. */}
                  {hasPriority && (
                    <>
                      <SectionHead label="Patient Priority" />
                      <FieldRow label="Priority" value={fd.priority} />
                    </>
                  )}
                </>
              );
            })()}
            {/* Stated on the face of the patient block, not only in the refusal
                panel. Anyone scanning this form for "what happened to this
                patient" reads the left column first, and until now it ended in
                blank ruled lines that look identical to a call where the crew
                simply captured nothing. */}
            {refused && <RefusedNote />}
            <FillLines />
          </div>
          )}

          {/* Debtor Information — grouped here alongside Patient + Medical Aid.
              On a refusal it sits at the bottom of the left column, below
              Billing: there is no debtor when nothing was provided, so it is
              the least useful block on the page and takes the leftover height. */}
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column',
                        ...(refused ? { gridColumn: 1, gridRow: 3, borderTop: `1px solid ${LN}` } : {}) }}>
            <SectionHead label="Debtor Information" />
            {debtorSameAsPatient ? (
              <div style={{
                flex: 1, borderTop: `1px solid ${LN}`,
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', gap: 6, padding: '14px 12px',
                background: SOFT_BG, textAlign: 'center',
              }}>
                <div style={{
                  width: 26, height: 26, borderRadius: 999,
                  background: GREEN, color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.85rem', fontWeight: 900,
                }}>✓</div>
                <div style={{ fontSize: '0.66rem', fontWeight: 800, color: GREEN_DK, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Same as Patient</div>
                <div style={{ fontSize: '0.58rem', color: MUT, lineHeight: 1.45 }}>
                  Refer to Patient Information for full contact / ID details.
                </div>
              </div>
            ) : (
              <>
                {/* Full standard debtor row set — blanks print as "—", matching
                    the always-render Patient Information policy above. */}
                <FieldRow label="Gender"   value={fd.debtor_gender} />
                <FieldRow label="Name"     value={fd.debtor_name} />
                <FieldRow label="Surname"  value={fd.debtor_surname} />
                <FieldRow label="ID No"    value={fd.debtor_id_number} />
                {/* Passport is the alternative to an SA ID, not an extra field —
                    on a local debtor it is always blank, so a permanent row of
                    "—" is noise. Omit it unless captured (same rule the Patient
                    Information block already applies). */}
                {!isBlank(fd.debtor_passport_number) && (
                  <FieldRow label="Passport" value={fd.debtor_passport_number} />
                )}
                <FieldRow label="Age"      value={fd.debtor_age} />
                <FieldRow label="DOB"      value={fmtDateValue(fd.debtor_dob)} />
                <FieldRow label="Address"  value={fd.debtor_address} />
                <FieldRow label="Suburb"   value={fd.debtor_suburb} />
                <FieldRow label="Code"     value={fd.debtor_postal_code} />
                <FieldRow label="Tel (H)"  value={fd.debtor_phone_home} />
                <FieldRow label="Cell"     value={fd.debtor_phone_cell} />
                {fd.call_type === 'DOD'
                  ? <div style={{ flex: 1, borderTop: `1px solid ${LN}` }} />
                  : <FillLines />}
              </>
            )}
          </div>

          {/* Billing Information — content follows the selected billing type so
              the section reflects the actual payer (Med Aid / WCA / IOD / RAF / PVT /
              Event / Call-Out) rather than always showing medical-aid fields.
              Omitted entirely for Courtesy calls: they are non-billable transfers,
              so no payer block is captured or shown. The Handover Signature +
              Hospital Sticker below still render — they are handover artefacts,
              not billing. */}
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column',
                        ...(refused ? { gridColumn: 1, gridRow: 2, borderTop: `1px solid ${LN}` } : {}) }}>
            {fd.call_type !== 'COURTESY' && (
              <>
            <SectionHead label="Billing Information" />
            {/* The refusal is stated at the TOP of the billing block, above the
                payer rows — not instead of them.

                Replacing the payer grid was the first attempt and it was wrong:
                a refusal is still billable. "Refusal Of Treatment" is one of the
                call-out fee bases the crew can select, so the scheme, member
                number and authorisation are exactly what the call-out fee is
                claimed against. Dropping them would have removed the payer
                details from the one call type most likely to be queried. */}
            {refused && (
              <RefusedNote detail="No treatment or transport was provided. Any charge is limited to the call-out fee shown in the call details above." />
            )}
            {(billingType === 'WCA / IOD' || (fd.call_type || '').toUpperCase() === 'WCA_IOD') ? (
              <>
                <FieldRow label="Reference"    value={fd.compensation_reference} />
                <FieldRow label="Employer"     value={fd.wca_employer} />
                <FieldRow label="Company Add"  value={fd.wca_employer_address} valueMin={24} />
                <FieldRow label="Resp. Person" value={fd.wca_employer_responsible_person} />
                <FieldRow label="Contact"      value={fd.wca_employer_contact} />
                <FieldRow label="Employee No"  value={fd.wca_employee_number} />
                <FieldRow label="Injury Date"  value={fmtDateValue(fd.wca_injury_date)} />
                {!isBlank(fd.wca_oar_number) && <FieldRow label="OAR No" value={fd.wca_oar_number} />}
                <FieldRow label="Incident"     value={fd.wca_incident_description} valueMin={40} />
                {attachedDocs.some(d => d.key.startsWith('wca_')) && (
                  <FieldRow label="Documents" valueMin={24} value={
                    attachedDocs.filter(d => d.key.startsWith('wca_')).map(d => d.label).join(', ') + ' — see attached sheet(s)'
                  } />
                )}
              </>
            ) : billingType === 'RAF' ? (
              <>
                <FieldRow label="Reference"     value={fd.compensation_reference} />
                <FieldRow label="Accident Date" value={fd.raf_accident_date} />
                <FieldRow label="SAPS / OB No"  value={fd.raf_police_case_number} />
                <FieldRow label="Accident Loc"  value={fd.raf_accident_location} valueMin={24} />
              </>
            ) : billingType === 'PVT' ? (
              <>
                <FieldRow label="Method"    value={fd.pvt_payment_method} />
                {fd.pvt_payment_method !== 'Indigent' && (
                  <>
                    <FieldRow label="Holder"    value={fd.pvt_account_holder} />
                    <FieldRow label="Holder ID" value={fd.pvt_account_holder_id} />
                    <FieldRow label="Contact"   value={fd.pvt_account_holder_phone} />
                    <FieldRow label="Address"   value={fd.pvt_account_holder_address} valueMin={24} />
                  </>
                )}
                {/* The cash receipt always prints on its own sheet — it is the
                    bulkiest block this column can carry. */}
                {cashOnOwnSheet && (
                  <div style={{ padding: '3px 6px', borderTop: `1px solid ${LN}`, fontSize: '0.5rem', color: MUT, fontStyle: 'italic' }}>
                    Cash verification and signatures — see the attachments sheet.
                  </div>
                )}
              </>
            ) : billingType === 'CALL OUT FEE' ? (
              <>
                <FieldRow label="Requested By" value={fd.callout_requested_by} />
                <FieldRow label="Auth Ref"     value={fd.callout_authorisation} />
                <FieldRow label="Reason"       value={fd.callout_standdown_reason} valueMin={24} />
              </>
            ) : (
              <>
                {/* Medical-aid rows only appear when actually captured — an
                    empty medical-aid section shouldn't show a column of "—". */}
                {!isBlank(fd.medical_scheme)    && <FieldRow label="Scheme"      value={fd.medical_scheme} />}
                {!isBlank(fd.medical_aid_number) && <FieldRow label="Aid No"      value={fd.medical_aid_number} />}
                {!isBlank(fd.dependent_number)  && <FieldRow label="Dependent"   value={fd.dependent_number} />}
                {!isBlank(fd.main_member_id)    && <FieldRow label="Main Member" value={fd.main_member_id} />}
                {!isBlank(fd.scheme_option)     && <FieldRow label="Plan"        value={fd.scheme_option} />}
              </>
            )}
            {/* Pre-/Post-Auth are transfer authorisations relevant to any payer
                (IFT/IHT) — render whenever captured, regardless of billing type. */}
            {!isBlank(fd.preauth_number)   && <FieldRow label="Pre-Auth No"  value={fd.preauth_number} />}
            {!isBlank(fd.post_auth_number) && <FieldRow label="Post-Auth No" value={fd.post_auth_number} />}
            {fd.med_aid_resus && (
              <SubBlock title="Resus" rows={[
                ['Level',   fd.med_aid_resus_level],
                ['Fee (R)', fd.med_aid_resus_fee],
              ]} />
            )}
            {/* Declaration of Death is no longer squeezed into this billing
                column — when present it renders on its own dedicated A4 page
                (see the "Declaration of Death" page further below) so all its
                fields have room. */}
            {fd.med_aid_quoted && (
              <SubBlock title="Quoted (Med-Aid Decline)" rows={[
                ['Amount (R)', fd.med_aid_quoted_amount],
              ]} />
            )}
              </>
            )}
            {/* Handover Signature — hidden for DOD (shown in the DOD block) and
                for RHT (patient refused transport — there's no facility handover). */}
            {!(fd.call_type === 'DOD' && fd.med_aid_dec_death) && fd.call_type !== 'RHT' && (
              <>
                <SectionHead label="Handover Signature" />
                <div style={{ padding: '6px 8px', borderTop: `1px solid ${LN}`, flexShrink: 0 }}>
                  <SignatureBox src={prf.signatures?.handover_signature} minHeight={80} />
                </div>
              </>
            )}

            {/* Hospital Sticker. When one was captured it prints full-size on
                its own "Patient Documents (Attachments)" sheet, so page 1 only
                cross-references it — the image is the tallest element this
                column can carry and page 1 has a hard ~944px ceiling. With no
                sticker captured the empty slot still prints, so it can be
                affixed to the paper form by hand. Hidden entirely for RHT (no
                hospital transport, so no sticker). */}
            {stickerVisible && !stickerOnDocumentSheet && <HospitalSticker fd={fd} />}
            {stickerOnDocumentSheet && (
              <div style={{ padding: '3px 6px', borderTop: `1px solid ${LN}`, fontSize: '0.5rem', color: MUT, fontStyle: 'italic' }}>
                Hospital sticker — see the patient documents sheet.
              </div>
            )}
            <FillLines />
          </div>

          {/* Channel-specific + Return Trip (when present) + Terms & Conditions.
              The T&C live in this right-hand column next to Medical Aid
              Information, matching the JEMS paper form. This column always
              renders so the T&C are on every PRF. */}
          {!(fd.call_type === 'DOD' && fd.med_aid_dec_death) && (
          <div style={{ display: 'flex', flexDirection: 'column',
                        ...(refused ? { gridColumn: 2, gridRow: '1 / -1' } : {}) }}>
            {/* "Channel Detail" section removed per request. The return-trip
                times used to render here as a SectionHead + six FieldRows.
                They now render as "Ret. …" rows in the journey-times table in
                BAND A — see the `timeRows` comment for why: this column is the
                tallest on the sheet, and 166px of extra rows here pushed page 1
                past the one-A4-sheet limit, so the export sliced it in two
                through the crew signature boxes. Every one of the six times is
                still printed; only its position changed. */}

            {/* ── Refusal of Transport ─────────────────────────────────────
                THE GAP THIS CLOSES. The crew captures a refusal declaration,
                a capacity checklist, the patient's stated reason, printed
                names, a date and two signatures. NONE of it reached the PDF.
                The two signature images did render — but under "Terms and
                Conditions", above the billing and indemnity clauses.

                So the permanent record — the document that goes to a scheme,
                that is produced at an HPCSA inquiry, that a court reads —
                showed a patient assenting to PAYMENT TERMS, with nothing on it
                saying they had refused transport, who witnessed it, or when.

                A signature is only evidence of what sits above it. On the
                tablet those marks sit above a refusal; on the printed form they
                sat above different words entirely. That gap is the whole case.
                */}
            {fd.call_type === 'RHT' && (
              <>
                <SectionHead label="Refusal of Treatment / Transport" />
                {(() => {
                  const company = prov?.name || 'the Service Provider';
                  const checks: Array<[string, string]> = [
                    ['rht_cap_alert', 'Alert and fully oriented'],
                    ['rht_cap_no_impairment', 'No apparent impairment (alcohol, drugs, hypoxia, hypoglycaemia)'],
                    ['rht_cap_risks_explained', 'Risks of refusal explained in a language understood'],
                    ['rht_cap_questions', 'Questions invited and answered'],
                    ['rht_cap_advised_recall', 'Advised to call again if the condition changes'],
                    ['rht_cap_alternative_care', 'Alternative care advised'],
                  ];
                  return (
                    <div style={{ padding: '5px 7px', borderTop: `1px solid ${LN}`, fontSize: '0.62rem', lineHeight: 1.35 }}>
                      <div style={{ marginBottom: 4 }}>
                        The patient, or the person lawfully responsible for the patient, declared
                        that the practitioners of {company} examined and/or offered to examine,
                        treat and transport the patient; that the nature of the condition, the
                        recommended treatment and transport, and the risks of declining it —
                        including deterioration, permanent injury or death — were explained in a
                        language understood; that questions were invited and answered; that the
                        refusal is made of their own free will and against the advice given; and
                        that they may call {company} or another emergency service again at any
                        time. Responsibility for the decision was accepted and {company}, its
                        directors, employees and agents released from liability for consequences
                        arising from the refusal, save for any liability that cannot lawfully be
                        excluded.
                      </div>
                      <div style={{ fontWeight: 800, color: GREEN_DK, marginTop: 5, marginBottom: 2 }}>
                        Practitioner's confirmation before accepting the refusal
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 8 }}>
                        {checks.map(([k, label]) => (
                          <div key={k}>
                            <span style={{ fontWeight: 900 }}>{fd[k] ? '☑' : '☐'}</span> {label}
                          </div>
                        ))}
                      </div>
                      {!isBlank(fd.rht_refusal_reason) && (
                        <div style={{ marginTop: 5 }}>
                          <span style={{ fontWeight: 800, color: GREEN_DK }}>Reason given: </span>
                          {fd.rht_refusal_reason}
                        </div>
                      )}
                    </div>
                  );
                })()}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderTop: `1px solid ${LN}` }}>
                  <div style={{ padding: '5px 7px', borderRight: `1px solid ${LN}` }}>
                    <div style={{ fontSize: '0.6rem', fontWeight: 900, color: MUT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
                      Patient / Responsible Person
                    </div>
                    <div style={{ fontSize: '0.66rem', marginBottom: 2 }}>{fd.rht_waiver_signatory_name || '—'}</div>
                    <SignatureBox src={prf.signatures?.patient_signature} minHeight={64} />
                  </div>
                  <div style={{ padding: '5px 7px' }}>
                    <div style={{ fontSize: '0.6rem', fontWeight: 900, color: MUT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
                      Witness
                    </div>
                    <div style={{ fontSize: '0.66rem', marginBottom: 2 }}>{fd.rht_waiver_witness_name || '—'}</div>
                    <SignatureBox src={prf.signatures?.witness_signature} minHeight={64} />
                  </div>
                </div>
                <FieldRow label="Date of Refusal" value={fd.rht_waiver_date} />
              </>
            )}

            {/* Terms & Conditions (page-1 right column, like the paper form) */}
            {/* Terms and Conditions are omitted on a refusal.

                The digital PRF never presents them for an RHT, so nobody has
                agreed to them — and printing them anyway put clauses beginning
                "I acknowledge that the treatment and/or transportation noted on
                this document was received by the patient" and "I accept full
                responsibility for all payments" onto the one record whose whole
                content is that treatment was DECLINED. Unsigned or not, a
                scheme or a court reads what is on the page. */}
            {fd.call_type !== 'DOD' && (
              <>
                {!refused && (
                <>
                <SectionHead label="Terms and Conditions" />
                {(() => {
                  const company = prov?.name || 'the Service Provider';
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
                    <div style={{ padding: '5px 8px', borderTop: `1px solid ${LN}`, fontSize: '0.46rem', lineHeight: 1.3, color: INK }}>
                      {clauses.map(([h, b], idx) => (
                        <div key={idx} style={{ marginBottom: 5 }}>
                          <div style={{ fontWeight: 800, color: GREEN_DK, marginBottom: 1 }}>{idx + 1}. {h}</div>
                          <div>{b}</div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                </>
                )}
                {/* The signature block still runs on a refusal, even though the
                    clauses above do not.

                    The crew form presents Terms & Conditions for every call type
                    except RESUS — an RHT included — so a next-of-kin signature
                    CAN be captured on a refusal. Suppressing the whole section
                    dropped it from the printed record: a captured signature that
                    does not reach the PDF is precisely the defect this block was
                    rewritten to fix, and repeating it while fixing the layout
                    would be a poor trade. It self-hides when nothing was
                    captured, so a refusal with no next-of-kin prints nothing. */}
                {(() => {
                  const sigLabel: React.CSSProperties = { fontSize: '0.65rem', fontWeight: 900, color: MUT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 };
                  const witnessSig = fd.tc_witness_signature || prf.signatures?.witness_signature;
                  const nokSig      = fd.next_of_kin_signature || prf.signatures?.next_of_kin_signature;
                  // Patient / Rep always shows (it's a mandatory signature). Witness
                  // and Next of Kin only render when actually captured, so empty
                  // "Not captured" boxes don't clutter the form.
                  // On an RHT the patient and witness marks are the REFUSAL
                  // signatures and are printed in the Refusal block above.
                  // Repeating them here would put the same mark under two
                  // different headings — refusal and billing terms — which
                  // muddies precisely what was assented to. A signature is
                  // evidence of what sits above it, so it appears once.
                  const refusalOwnsSignatures = fd.call_type === 'RHT';

                  // Print the heading only if something will appear under it.
                  //
                  // Suppressing the duplicated marks on an RHT left the
                  // "Signatures" band sitting above empty white space on the
                  // printed form. On a legal record an empty section heading
                  // does not read as "nothing to show here" — it reads as
                  // "something failed to print", which invites exactly the
                  // question this document exists to answer. The refusal
                  // signatures are on the page, under the Refusal heading,
                  // where they belong.
                  const showPatientSig = fd.call_type !== 'DOD' && !refusalOwnsSignatures;
                  const showWitnessSig = (witnessSig || fd.call_type === 'DOD') && !refusalOwnsSignatures;
                  const showNokSig     = nokSig || fd.call_type === 'DOD';
                  if (!showPatientSig && !showWitnessSig && !showNokSig) return null;

                  return (
                    <>
                    <SectionHead label="Signatures" />
                    <div style={{ display: 'flex', flexDirection: 'column', borderTop: `1px solid ${LN}` }}>
                      {fd.call_type !== 'DOD' && !refusalOwnsSignatures && (
                        <div style={{ padding: '5px 7px', borderBottom: (witnessSig || nokSig || fd.call_type === 'DOD') ? `1px solid ${LN}` : 'none' }}>
                          <div style={sigLabel}>Patient / Rep.</div>
                          <SignatureBox src={fd.tc_patient_signature || prf.signatures?.patient_signature} minHeight={80} />
                        </div>
                      )}
                      {(witnessSig || fd.call_type === 'DOD') && !refusalOwnsSignatures && (
                        <div style={{ padding: '5px 7px', borderBottom: (nokSig || fd.call_type === 'DOD') ? `1px solid ${LN}` : 'none' }}>
                          <div style={sigLabel}>Witness</div>
                          <SignatureBox src={witnessSig} minHeight={80} />
                        </div>
                      )}
                      {(nokSig || fd.call_type === 'DOD') && (
                        <div style={{ padding: '5px 7px' }}>
                          <div style={sigLabel}>Next of Kin</div>
                          <SignatureBox src={nokSig} minHeight={70} />
                        </div>
                      )}
                    </div>
                    </>
                  );
                })()}
              </>
            )}
            <FillLines />
          </div>
          )}
        </div>

        {/* ── BAND C — Closeout: Valuables + Handover sig │ Crew sign-off (×2) │
              Motivation, all grouped in one band so nothing stretches across a
              sparse full-width row. ──
              Valuables is 1.54fr so the Crew · Assessed By left border lines up
              vertically with Band B's Patient/Debtor border (1.64/6.4). The
              freed width goes to Motivation, widening it. */}
        {fd.call_type !== 'DOD' && (
          <div style={{ display: 'grid', gridTemplateColumns: fd.call_type === 'RHT' ? '1.5fr 1.5fr 1.46fr' : '1.54fr 1.5fr 1.5fr 1.46fr', borderTop: `2px solid ${LN}` }}>
          {/* Valuables + Handover Signature (+ RAF sketch if any) — dropped for
              RHT (no hospital transport, so no valuables handover). */}
          {fd.call_type !== 'RHT' && (
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
            <SectionHead label="Valuables" />
            {valuablesEmpty ? (
              <div style={{
                borderTop: `1px solid ${LN}`, padding: '8px', background: SOFT_BG,
                fontSize: '0.6rem', color: MUT, fontStyle: 'italic', textAlign: 'center',
              }}>None recorded</div>
            ) : (
              <>
                <FieldRow label="Handed To"   value={fd.valuables_handed_to} />
                <FieldRow label="Description" value={fd.valuables_description} valueMin={80} flex={1} />
                {(fd.valuables_signature || prf.signatures?.valuables_signature) && (
                  <>
                    <div style={{ padding: '4px 7px', background: SOFT_BG, borderTop: `1px solid ${LN}` }}>
                      <div style={{ fontSize: '0.58rem', fontWeight: 900, color: MUT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Recipient Signature</div>
                      <SignatureBox src={fd.valuables_signature || prf.signatures?.valuables_signature} minHeight={60} />
                    </div>
                  </>
                )}
              </>
            )}
            {fd.raf_sketch && (
              <>
                <SectionHead label="RAF Sketch" />
                <div style={{
                  borderTop: `1px solid ${LN}`, padding: 4,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: SOFT_BG,
                }}>
                  <img src={fd.raf_sketch} alt="RAF sketch"
                       style={{ maxWidth: '100%', maxHeight: 80, objectFit: 'contain' }} />
                </div>
              </>
            )}
            <FillLines />
          </div>
          )}

          {/* Crew sign-off — one tidy column per crew member: details stacked
              above a properly-sized signature box (no full-width stretch). */}
          {([
            { c: prf.crew_1, sig: fd.crew_signoff_sigs?.c1 || prf.signatures?.crew_signature,   fbName: fd.assessed_by, fbQual: fd.assessor_qualifications, role: 'Assessed By' },
            { c: prf.crew_2, sig: fd.crew_signoff_sigs?.c2 || prf.signatures?.crew_2_signature, fbName: fd.managed_by,  fbQual: fd.manager_qualifications,  role: 'Managed By'  },
          ]).map(({ c, sig, fbName, fbQual, role }, i) => (
            <div key={i} style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
              <SectionHead label={`Crew · ${role}`} />
              <FieldRow label="Name"  value={c?.full_name || fbName} />
              <FieldRow label="Qual"  value={c?.qualification || fbQual} />
              <FieldRow label="HPCSA" value={c?.hpcsa_number} />
              <div style={{ padding: '6px 8px', borderTop: `1px solid ${LN}`, flex: 1, display: 'flex', alignItems: 'center' }}>
                <SignatureBox src={sig} minHeight={80} />
              </div>
            </div>
          ))}

          {/* Motivation / Other Notes — the captured text sits at natural
              height and the remaining space renders as ruled note lines (an
              empty section is ALL ruling — a proper blank notes area, not an
              italic apology in a void). */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <SectionHead label="Motivation / Other Notes" />
            {motivationNotes && (
              <div style={{
                borderTop: `1px solid ${LN}`,
                padding: '6px 9px',
                background: '#fff',
                color: INK,
                fontSize: '0.74rem', lineHeight: 1.45,
                whiteSpace: 'pre-wrap',
              }}>
                {motivationNotes}
              </div>
            )}
            <FillLines />
            {fd.extra_crew && fd.extra_crew.length > 0 && (
              <>
                <SectionHead label="Additional Crew" />
                <div style={{ padding: '4px 0', borderTop: `1px solid ${LN}`, flex: 1 }}>
                  {fd.extra_crew.map((c: any, idx: number) => (
                    <div key={idx} style={{ padding: '4px 8px', borderBottom: idx === fd.extra_crew.length - 1 ? 'none' : `1px solid ${LN}` }}>
                      <FieldRow label="Name" value={c.name || c.full_name} />
                      <FieldRow label="Qual." value={c.qualification} />
                      <FieldRow label="HPCSA" value={c.hpcsa_number} />
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          </div>
        )}
      </div>

      </div>{/* /prf-print-frame (page 1) */}

      {/* ═══════════════════ PAGE 2 — Clinical ═══════════════════
          Same A4-landscape aspect lock as page 1. Top = mini header +
          crew details table. Bottom = 3-col clinical grid (short
          checks | history narrative | vitals + IV + meds + management).
          Hidden entirely for Declaration of Death calls — no vitals needed. */}
      {fd.call_type !== 'DOD' && (
      <>
      <div className="prf-print-frame">
      <div className="prf-page" style={{
        width: 1220, minHeight: 862,
        margin: '28px auto 0', background: '#fff', color: INK,
        border: `2px solid ${LN}`, boxShadow: '0 6px 24px rgba(0,0,0,0.1)',
        display: 'flex', flexDirection: 'column',
        position: 'relative',   // anchor for the refused-treatment watermark
      }}>
        {/* Page-2 mini header removed (logo + Patient Name / Date / Case No /
            Sheet No). The whole row is freed so the clinical grid starts at
            the top of the sheet, giving the Management notes block at the
            bottom of column 3 enough vertical room for multiple lines.
            Identifying info still lives on page 1, and the page-1 → page-2
            order is preserved by the print frame sequence. */}

        {/* Crew Details moved to page 1 (bottom band) so this sheet has
            room for the full vitals + IV + medication + management stack
            without clipping the last rows. */}

        {/* Patient refused treatment — large diagonal watermark across the
            whole clinical sheet so the empty clinical sections read as
            intentional. pointer-events:none keeps the (empty) fields
            selectable; sits above the grid but translucent. */}
        {/* `refused`, not `patient_refused_treatment`: the clinical grid below
            is now hidden for ANY refusal, so gating the watermark on the
            narrower flag would leave an RHT that never had the button tapped
            printing a completely blank sheet — strictly worse than what this
            change replaced. The two conditions must not drift apart. */}
        {refused && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 5,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none', overflow: 'hidden',
          }}>
            <div style={{
              transform: 'rotate(-30deg)',
              fontSize: '5.6rem', fontWeight: 900, lineHeight: 1.05,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              textAlign: 'center', whiteSpace: 'nowrap',
              color: 'rgba(185,28,28,0.55)',
              WebkitTextStroke: '1px rgba(153,27,27,0.65)',
              border: '0.6rem solid rgba(185,28,28,0.5)',
              borderRadius: 18, padding: '1.4rem 3rem',
            }}>
              Patient Refused<br />Treatment
            </div>
          </div>
        )}

        {/* On a refusal the clinical sheet is the watermark and nothing else.

            No observations, interventions, vitals or medications exist, because
            the patient declined before any were made. Printing the full grid
            produced a page of section headings over empty rows — which does not
            read as "nothing was done", it reads as "the crew did not complete
            the form". The watermark above says exactly what happened; the
            headings underneath only argued with it. */}
        {refused ? null : (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1.3fr 2.5fr',
          borderTop: `2px solid ${LN}`, flex: 1, minHeight: 0,
        }}>
          {/* COL 1 — Oxygen / Airway / Circ / Immob / Primary + Secondary Survey */}
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
            {/* Hide the whole Oxygen Admin section (header + rows) when no
                oxygen was administered, so the PDF isn't a block of empty
                "—" rows under a stray title. */}
            {[fd.o2_flow_rate, fd.o2_percent, fd.o2_device, fd.o2_bvm, fd.o2_start_time, fd.o2_stop_time].some(v => !isBlank(v)) && (
              <>
                <SectionHead label="Oxygen Admin" />
                <FieldRow label="L / Min"    value={fd.o2_flow_rate} />
                <FieldRow label="% Oxygen"   value={fd.o2_percent} />
                <FieldRow label="Device"     value={fd.o2_device} />
                <FieldRow label="BVM"        value={fd.o2_bvm} />
                <FieldRow label="Start Time" value={fd.o2_start_time} />
                <FieldRow label="Stop Time"  value={fd.o2_stop_time} />
              </>
            )}

            {(() => {
              const airway = Array.isArray(fd.airway_interventions) ? fd.airway_interventions.filter(Boolean) : [];
              const subFields: Array<[string, any]> = [
                ['OP Airway Size', fd.op_airway_size],
                ['Intub. Att.', fd.intubation_attempts],
                ['ETT Size',    fd.ett_size],
                ['ETT Depth',   fd.ett_depth],
                ['NG Tube',     fd.ng_tube_size],
              ].filter(([, v]) => !isBlank(v)) as Array<[string, any]>;
              if (airway.length === 0 && subFields.length === 0) return null;
              return (
                <>
                  <SectionHead label="Airway" />
                  {airway.map((i: string) => <Chk key={i} label={i} checked />)}
                  {subFields.map(([label, v]) => <FieldRow key={label} label={label} value={v} />)}
                </>
              );
            })()}

            {(() => {
              const circ = Array.isArray(fd.circulation_interventions) ? fd.circulation_interventions.filter(Boolean) : [];
              const legacy: Array<[string, any]> = [
                ['IV Attempts', fd.iv_attempts],
                ['Defib J/NR',  fd.defib_joules],
              ].filter(([, v]) => !isBlank(v)) as Array<[string, any]>;
              if (circ.length === 0 && legacy.length === 0) return null;
              return (
                <>
                  <SectionHead label="Circulation" />
                  {circ.map((i: string) => <Chk key={i} label={i} checked />)}
                  {legacy.map(([label, v]) => <FieldRow key={label} label={label} value={v} />)}
                </>
              );
            })()}

            {(() => {
              const immob = Array.isArray(fd.immob_equipment) ? fd.immob_equipment.filter(Boolean) : [];
              const showOther = !isBlank(fd.other_equipment);
              if (immob.length === 0 && !showOther) return null;
              return (
                <>
                  <SectionHead label="Immobilisation" />
                  {immob.map((i: string) => <Chk key={i} label={i} checked />)}
                  {showOther && <FieldRow label="Other" value={fd.other_equipment} />}
                </>
              );
            })()}

            <SectionHead label="Primary Survey" />
            <FieldRow label="A — Airway"      value={fd.survey_a} />
            <FieldRow label="B — Breathing"   value={fd.survey_b} />
            <FieldRow label="C — Circulation" value={fd.survey_c} />

            <SectionHead label="Secondary Survey" />
            <FieldRow label="Head & Back" value={fd.survey_head_back} />
            <FieldRow label="Neuro"       value={fd.survey_neuro} />
            <FieldRow label="Chest"       value={fd.survey_chest} />
            <FieldRow label="Abdomen"     value={fd.survey_abdo} />
            <FieldRow label="Limbs"       value={fd.survey_limbs} />
            <FieldRow label="Back"        value={fd.survey_back} />
            <FillLines />
          </div>

          {/* COL 2 — History (narrative-heavy) + IV Therapy + Medication.
              IV + Medication were relocated here from col 3 so that col 3
              can absorb the full vitals time-series (all 26 rows when fully
              captured) without the IV / Medication tables getting clipped
              and breaking the layout. */}
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
            <SectionHead label="History" />
            <FieldRow label="Complaint"      value={fd.chief_complaint}      valueMin={24} />
            <FieldRow label="Primary Diagnosis" value={fd.primary_diagnosis} />
            <FieldRow label="Findings"       value={fd.findings_on_arrival}  valueMin={24} />
            <FieldRow label="Allergies"      value={fd.allergies} />
            <FieldRow label="Current Meds"   value={fd.current_medications}  valueMin={24} />
            <FieldRow label="Past History"   value={fd.past_medical_history} valueMin={24} />
            <FieldRow label="Last Meal"      value={fd.last_meal} />
            <FieldRow label="Last Meal Time" value={fd.last_meal_time} />
            <FieldRow label="Events / HPI"   value={fd.events_hpi}           valueMin={48} />

            {/* Intravenous Therapy (stacked vertically) — the whole section is
                omitted when no IV row was recorded, instead of printing an
                empty placeholder row with a "Not captured" signature box. */}
            {ivRows.length > 0 && (
              <>
            <SectionHead label="Intravenous Therapy" />
            {/* Clinical justification for the IV. The crew must answer these
                ("Reason for IV Therapy") before the section opens, and it is
                the first thing a scheme asks for when it queries an IV charge —
                yet none of the four answers reached the PDF, so the line and
                its consumables were billed with the indication missing and the
                crew's contemporaneous justification unavailable to defend it. */}
            {(() => {
              const reasons = [
                fd.ift_ongoing_iv_treatment && 'On-going IV treatment',
                fd.primary_iv_profuse_bleeding && 'Profuse bleeding',
                fd.primary_iv_fluid_resuscitation && 'Fluid resuscitation',
                fd.iv_medication_administration && 'Medication administered via IV',
              ].filter(Boolean) as string[];
              return reasons.length > 0
                ? <FieldRow label="Indication" value={reasons.join(' · ')} valueMin={24} />
                : null;
            })()}
            {ivRows.map((row: any, i: number) => (
              <Fragment key={`iv-${i}`}>
                {i > 0 && <div style={{ borderTop: `2px solid ${GREEN_DK}` }} />}
                <FieldRow label="Type / Fluid" value={[row.type, row.jelco_size].filter(Boolean).join(' · ')} />
                <FieldRow label="Site" value={row.site} />
                <div style={{ display: 'flex' }}>
                  <div style={{ flex: 1 }}><FieldRow label="Vol Inf." value={row.vol_infused} /></div>
                  <div style={{ flex: 1, borderLeft: `1px solid ${LN}` }}><FieldRow label="Time Up" value={row.time_up} /></div>
                </div>
                <FieldRow label="Reason" value={row.indication} />
                <div style={{ padding: '4px 7px', background: SOFT_BG, borderTop: `1px solid ${LN}` }}>
                  <div style={{ fontSize: '0.58rem', fontWeight: 900, color: MUT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Signature</div>
                  <div style={{
                    minHeight: 50, width: '100%', boxSizing: 'border-box',
                    border: '2px solid #475569', borderRadius: 4, background: '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 2,
                    position: 'relative',
                  }}>
                    <div style={{ position: 'absolute', bottom: '25%', left: '10%', right: '10%', borderBottom: '2px dotted #cbd5e1', zIndex: 0 }} />
                    {typeof row.sign === 'string' && row.sign.startsWith('data:image/') ? (
                      <img src={row.sign} alt="Sign" style={{ maxWidth: '100%', maxHeight: 44, objectFit: 'contain', position: 'relative', zIndex: 1 }} />
                    ) : (
                      <span style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: row.sign ? INK : DIM, position: 'relative', zIndex: 1 }}>{row.sign || 'Not captured'}</span>
                    )}
                  </div>
                </div>
              </Fragment>
            ))}
              </>
            )}

            {/* Medication / Infusion (stacked vertically) — likewise omitted
                entirely when no medication row was recorded. */}
            {medRows.length > 0 && (
              <>
            <SectionHead label="Medication / Infusion" />
            {medRows.map((row: any, i: number) => (
              <Fragment key={`med-${i}`}>
                {i > 0 && <div style={{ borderTop: `2px solid ${GREEN_DK}` }} />}
                <FieldRow label="Drug / Type" value={row.type} />
                <FieldRow label="Route" value={row.route} />
                <div style={{ display: 'flex' }}>
                  <div style={{ flex: 1 }}><FieldRow label="Dose" value={row.dose} /></div>
                  <div style={{ flex: 1, borderLeft: `1px solid ${LN}` }}><FieldRow label="Time" value={row.time} /></div>
                </div>
                <FieldRow label="Reason" value={row.reason} />
                <div style={{ padding: '4px 7px', background: SOFT_BG, borderTop: `1px solid ${LN}` }}>
                  <div style={{ fontSize: '0.58rem', fontWeight: 900, color: MUT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Signature</div>
                  <div style={{
                    minHeight: 50, width: '100%', boxSizing: 'border-box',
                    border: '2px solid #475569', borderRadius: 4, background: '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 2,
                    position: 'relative',
                  }}>
                    <div style={{ position: 'absolute', bottom: '25%', left: '10%', right: '10%', borderBottom: '2px dotted #cbd5e1', zIndex: 0 }} />
                    {typeof row.sign === 'string' && row.sign.startsWith('data:image/') ? (
                      <img src={row.sign} alt="Sign" style={{ maxWidth: '100%', maxHeight: 44, objectFit: 'contain', position: 'relative', zIndex: 1 }} />
                    ) : (
                      <span style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: row.sign ? INK : DIM, position: 'relative', zIndex: 1 }}>{row.sign || 'Not captured'}</span>
                    )}
                  </div>
                </div>
              </Fragment>
            ))}
              </>
            )}

            <FillLines />
          </div>

          {/* COL 3 — Vitals time-series + IV Therapy + Medication + Management */}
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <SectionHead label="Time Recorded" />
            <div style={{
              display: 'grid',
              gridTemplateColumns: `120px repeat(${vitalsCols}, minmax(0, 1fr))`,
              fontSize: '0.66rem',
            }}>
              {/* Header — empty corner cell + time-set headers */}
              <div style={{
                padding: '3px 6px', background: GREEN_TINT,
                borderRight: `1px solid ${LN}`, borderBottom: `1px solid ${LN}`, fontWeight: 800,
              }}></div>
              {[...Array(vitalsCols)].map((_, i) => (
                <div key={i} style={{
                  padding: '3px 3px', background: GREEN_TINT,
                  borderRight: i < vitalsCols - 1 ? `1px solid ${LN}` : 'none',
                  borderBottom: `1px solid ${LN}`,
                  fontWeight: 800, fontFamily: 'ui-monospace, monospace',
                  textAlign: 'center', fontSize: '0.64rem', color: INK,
                }}>{vitalsPage1[i]?.time || ''}</div>
              ))}

              {/* Data rows — only render rows where at least one vital
                  set (across BOTH the page-1 slice and any overflow) carries
                  a value, so the row layout is identical on the continuation
                  page even if the relevant readings were taken late in the
                  call. Drops vent/ETCO₂/tidal-vol/etc. rows for
                  non-ventilated patients, saving the height we need to keep
                  the page within A4-landscape aspect. */}
              {VITALS_PDF_ROWS.filter(([, key]) =>
                vitals.some((v: any) => !isBlank(v?.[key]))
              ).map(([label, key]) => (
                <Row key={key} label={label} keyName={key} vitals={vitalsPage1} cols={vitalsCols} />
              ))}
            </div>

            {/* Fewer-than-3-vitals motivation — shown directly under the vitals
                table so the medical scheme can see the crew's justification for
                the reduced number of recorded sets. */}
            {!isBlank(fd.vitals_shortfall_motivation) && vitals.length < 3 && (
              <>
                <SectionHead label="Vitals Shortfall Motivation" />
                <div style={{
                  padding: '6px 9px', fontSize: '0.72rem', color: INK,
                  whiteSpace: 'pre-wrap', lineHeight: 1.4,
                  borderTop: `1px solid ${LN}`, background: SOFT_BG,
                }}>
                  {fd.vitals_shortfall_motivation}
                </div>
              </>
            )}

            {/* IV Therapy + Medication / Infusion moved to column 2 (below
                History) so this column can host the full vitals time-series
                and let Management absorb any leftover height. */}

            {/* Management notes — text at natural height, remaining vertical
                space rendered as ruled note lines (blank section = a proper
                ruled notes area, not an italic placeholder in a void). */}
            <SectionHead label="Management" />
            {!isBlank(fd.management_notes) && (
              <div style={{
                padding: '6px 9px', fontSize: '0.74rem', color: INK,
                whiteSpace: 'pre-wrap', lineHeight: 1.45,
                borderTop: `1px solid ${LN}`,
              }}>
                {fd.management_notes}
              </div>
            )}
            <FillLines />
          </div>
        </div>
        )}


      </div>{/* /prf-page (page 2) */}
      </div>{/* /prf-print-frame (page 2) */}
      </>
      )}
      {/* ═══════════════════ PAGE 3 — Vitals Continuation ═══════════════════
          Rendered only when more than VITALS_PER_PAGE (3) vital sets were
          captured. Same A4-landscape frame as the earlier pages so the print
          / PDF pipeline picks it up via the existing .prf-page selector. */}
      {vitalsOverflow.length > 0 && (
        <div className="prf-print-frame">
          <div className="prf-page" style={{
            width: 1220, minHeight: 862,
            margin: '28px auto 0', background: '#fff', color: INK,
            border: `2px solid ${LN}`, boxShadow: '0 6px 24px rgba(0,0,0,0.1)',
            display: 'flex', flexDirection: 'column',
          }}>
            {/* Mini header so the continuation sheet is identifiable on its own */}
            <div style={{
              display: 'grid', gridTemplateColumns: '1.3fr 2.4fr 2fr',
              borderBottom: `2px solid ${LN}`,
            }}>
              <div style={{
                padding: '10px 12px', borderRight: `1px solid ${LN}`,
                display: 'flex', alignItems: 'center',
              }}>
                <ProviderLogo prov={prov} height={30} />
              </div>
              <div style={{
                padding: '10px 12px', borderRight: `1px solid ${LN}`,
                display: 'flex', alignItems: 'center',
                fontSize: '0.78rem', fontWeight: 800, color: INK,
                letterSpacing: '0.08em', textTransform: 'uppercase',
              }}>
                Vitals — Continuation
              </div>
              <div style={{
                padding: '10px 12px', display: 'flex', alignItems: 'center',
                justifyContent: 'flex-end', gap: 18,
                fontSize: '0.68rem', color: MUT,
              }}>
                <span>Patient: <b style={{ color: INK }}>{patientFullName}</b></span>
                {prf.case_number && <span>Case: <b style={{ color: INK, fontFamily: 'ui-monospace, monospace' }}>{prf.case_number}</b></span>}
              </div>
            </div>

            {/* Vitals table — same column structure as page 2, fed from the
                overflow slice (set #4 onwards). */}
            <SectionHead label="Time Recorded" />
            <div style={{
              display: 'grid',
              gridTemplateColumns: `120px repeat(${vitalsOverflowCols}, minmax(0, 1fr))`,
              fontSize: '0.66rem',
            }}>
              <div style={{
                padding: '3px 6px', background: GREEN_TINT,
                borderRight: `1px solid ${LN}`, borderBottom: `1px solid ${LN}`, fontWeight: 800,
              }}></div>
              {[...Array(vitalsOverflowCols)].map((_, i) => (
                <div key={i} style={{
                  padding: '3px 3px', background: GREEN_TINT,
                  borderRight: i < vitalsOverflowCols - 1 ? `1px solid ${LN}` : 'none',
                  borderBottom: `1px solid ${LN}`,
                  fontWeight: 800, fontFamily: 'ui-monospace, monospace',
                  textAlign: 'center', fontSize: '0.64rem', color: INK,
                }}>{vitalsOverflow[i]?.time || ''}</div>
              ))}

              {VITALS_PDF_ROWS.filter(([, key]) =>
                vitals.some((v: any) => !isBlank(v?.[key]))
              ).map(([label, key]) => (
                <Row key={key} label={label} keyName={key} vitals={vitalsOverflow} cols={vitalsOverflowCols} />
              ))}
            </div>

            <div style={{ flex: 1 }} />
          </div>
        </div>
      )}

      {/* ═══════════════════ RECEIPTS & ATTACHMENTS ═══════════════════
          The cash receipt and the hospital sticker, on a sheet of their own.

          Both used to sit in the Billing column on page 1, where together they
          are ~380px in the tallest column on the sheet — enough to push an
          IFT/IHT past the ~944px ceiling, after which the exporter slices the
          page into even bands and half of it lands on a second, mostly empty
          sheet. Moving them onto page 2 was the first attempt and merely moved
          the slice: the clinical sheet is already close to the same ceiling, so
          it began cutting through the secondary survey instead.

          A sheet of their own is the only placement that adds nothing to a page
          that is already full. It also removes every special case the page-2
          version needed — no "keep it on page 1 when there is no page 2"
          fallback for a Declaration of Death or a refusal — because a sheet
          created on demand always exists.

          Same A4-landscape frame as the other pages, so the print and PDF
          pipelines pick it up through the existing .prf-page selector. */}
      {hasAttachmentSheet && (
        <div className="prf-print-frame">
          <div className="prf-page" style={{
            width: 1220, minHeight: 862,
            margin: '28px auto 0', background: '#fff', color: INK,
            border: `2px solid ${LN}`, boxShadow: '0 6px 24px rgba(0,0,0,0.1)',
            display: 'flex', flexDirection: 'column',
          }}>
            {/* The cash receipt is the only thing this sheet carries. The
                hospital sticker used to render here too, which printed it twice
                — the "Patient Documents (Attachments)" loop below already gives
                a captured sticker a full sheet of its own. */}
            <div>
              {cashOnOwnSheet && <CashVerification fd={fd} wide />}
            </div>
            <FillLines />
          </div>
        </div>
      )}

      {/* ═══════════════════ ATTACHED DOCUMENTS ═══════════════════
          One A4-landscape sheet per document the crew attached on the form
          (WCA / employee documents, RAF OAR report). Photographed documents
          render as a full-page image; an uploaded PDF file renders as a
          labelled record block (a canvas snapshot cannot rasterise PDF pages
          — the original file stays stored with the PRF). Picked up by the
          PDF/print pipeline via the shared .prf-page selector. */}
      {attachedDocs.map(d => (
        <div className="prf-print-frame" key={`doc-${d.key}`}>
          <div className="prf-page" style={{
            width: 1220, minHeight: 862,
            margin: '28px auto 0', background: '#fff', color: INK,
            border: `2px solid ${LN}`, boxShadow: '0 6px 24px rgba(0,0,0,0.1)',
            display: 'flex', flexDirection: 'column',
          }}>
            {/* Mini header so the sheet is identifiable on its own */}
            <div style={{
              display: 'grid', gridTemplateColumns: '1.3fr 2.4fr 2fr',
              borderBottom: `2px solid ${LN}`,
            }}>
              <div style={{
                padding: '10px 12px', borderRight: `1px solid ${LN}`,
                display: 'flex', alignItems: 'center',
              }}>
                <ProviderLogo prov={prov} height={30} />
              </div>
              <div style={{
                padding: '10px 12px', borderRight: `1px solid ${LN}`,
                display: 'flex', alignItems: 'center',
                fontSize: '0.78rem', fontWeight: 800, color: INK,
                letterSpacing: '0.08em', textTransform: 'uppercase',
              }}>
                Attached Document — {d.label}
              </div>
              <div style={{
                padding: '10px 12px', display: 'flex', alignItems: 'center',
                justifyContent: 'flex-end', gap: 18,
                fontSize: '0.68rem', color: MUT,
              }}>
                <span>Patient: <b style={{ color: INK }}>{patientFullName}</b></span>
                {prf.case_number && <span>Case: <b style={{ color: INK, fontFamily: 'ui-monospace, monospace' }}>{prf.case_number}</b></span>}
              </div>
            </div>

            {isImageDoc(d.file) ? (
              <div style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 14, background: SOFT_BG,
              }}>
                <img
                  src={d.file!.data_url}
                  alt={d.label}
                  style={{ maxWidth: '100%', maxHeight: 770, objectFit: 'contain', border: `1px solid ${LN}`, background: '#fff' }}
                />
              </div>
            ) : (
              <div style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 24, background: SOFT_BG,
              }}>
                <div style={{
                  border: `2px dashed ${MUT}`, borderRadius: 8, background: '#fff',
                  padding: '46px 60px', textAlign: 'center', maxWidth: 640,
                }}>
                  <div style={{
                    fontSize: '1rem', fontWeight: 900, color: INK,
                    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10,
                  }}>PDF document attached</div>
                  <div style={{ fontSize: '0.86rem', fontWeight: 700, color: GREEN_DK, wordBreak: 'break-word', marginBottom: 8 }}>
                    {d.file!.name || 'document.pdf'}
                  </div>
                  {typeof d.file!.size === 'number' && d.file!.size > 0 && (
                    <div style={{ fontSize: '0.72rem', color: MUT, marginBottom: 12 }}>
                      {(d.file!.size / 1024).toFixed(1)} KB
                    </div>
                  )}
                  <div style={{ fontSize: '0.72rem', color: MUT, lineHeight: 1.5 }}>
                    The original PDF file is stored with this PRF in the portal.
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      ))}

      {/* ═══════════ DECLARATION OF DEATH SHEET ═══════════
          Rendered on its own dedicated A4-landscape sheet, and ONLY when a
          Declaration of Death was actually completed on the PRF. Previously
          these fields were crammed into the narrow Billing-Information column;
          giving them a full page lets every field (particulars of deceased,
          healthcare professional, medical confirmation, handover, and the
          signed declaration) render legibly. Picked up by the PDF/print
          pipeline via the shared .prf-page selector.

          ⚠ SECOND IMPLEMENTATION EXISTS. The same statutory block is also
          rendered inline as "BAND B" on page 1, under the complementary guard
          `fd.call_type === 'DOD' && fd.med_aid_dec_death`. The two guards are
          mutually exclusive — this sheet covers a Declaration of Death raised
          on a NON-DOD call — so nothing renders twice. But roughly 40
          FieldRows are repeated verbatim, so ANY change to the deceased /
          informant / sign-off fields must be made in BOTH places. See the
          matching note at BAND B for why they are deliberately not merged. */}
      {fd.med_aid_dec_death && fd.call_type !== 'DOD' && (
        <div className="prf-print-frame">
          <div className="prf-page" style={{
            width: 1220, minHeight: 862,
            margin: '28px auto 0', background: '#fff', color: INK,
            border: `2px solid ${LN}`, boxShadow: '0 6px 24px rgba(0,0,0,0.1)',
            display: 'flex', flexDirection: 'column',
          }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 2.4fr 2fr', flex: 1 }}>
              {/* Column 1 — company + event + deceased */}
              <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: 12, borderBottom: `2px solid ${LN}`, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 140 }}>
                  <div style={{
                    border: `1.5px solid ${LN}`, borderRadius: 6, background: '#fff',
                    height: 60, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: '4px 10px', overflow: 'hidden', marginBottom: 4
                  }}>
                    <ProviderLogo prov={prov} height={48} />
                  </div>
                  {prov.phone && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                      <span style={{ fontSize: '0.5rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', letterSpacing: '0.09em' }}>Phone</span>
                      <span style={{ fontSize: '0.9rem', fontWeight: 900, color: INK, fontFamily: 'ui-monospace, monospace' }}>{prov.phone}</span>
                    </div>
                  )}
                  {prov.pr_number && (
                    <div style={{ fontSize: '0.7rem', fontWeight: 700, color: MUT }}>
                      PR No: <span style={{ fontFamily: 'ui-monospace, monospace', color: INK, fontWeight: 800 }}>{prov.pr_number}</span>
                    </div>
                  )}
                  {prov.pty_reg_number && (
                    <div style={{ fontSize: '0.7rem', fontWeight: 700, color: MUT }}>
                      Co Reg: <span style={{ fontFamily: 'ui-monospace, monospace', color: INK, fontWeight: 800 }}>{prov.pty_reg_number}</span>
                    </div>
                  )}
                  {prov.address && (
                    <div style={{ marginTop: 2, fontSize: '0.7rem', fontWeight: 600, color: INK, whiteSpace: 'pre-wrap', lineHeight: 1.2 }}>
                      {prov.address}
                    </div>
                  )}
                  {prov.email && (
                    <div style={{ fontSize: '0.65rem', fontWeight: 700, color: GREEN_DK, wordBreak: 'break-word' }}>{prov.email}</div>
                  )}
                </div>
                <SectionHead label="Declaration of Death" />
                <FieldRow label="Date"                 value={fd.med_aid_dec_death_date} />
                <FieldRow label="Time of Death"        value={fd.med_aid_dec_death_time} />
                <FieldRow label="Location of Body"     value={fd.med_aid_dec_death_location} />
                <FieldRow label="Identified By"        value={fd.med_aid_dec_death_identified_by} />

                <SectionHead label="Particulars of Deceased" />
                <FieldRow label="Gender"       value={fd.med_aid_dec_death_deceased_gender} />
                <FieldRow label="First Name"   value={fd.med_aid_dec_death_deceased_first_name} />
                <FieldRow label="Surname"      value={fd.med_aid_dec_death_deceased_surname} />
                <FieldRow label="ID Number"    value={fd.med_aid_dec_death_deceased_id} />
                {!isBlank(fd.med_aid_dec_death_deceased_passport) && (
                  <FieldRow label="Passport No" value={fd.med_aid_dec_death_deceased_passport} />
                )}
                <FieldRow label="Date of Birth" value={fd.med_aid_dec_death_deceased_dob} />
                <FieldRow label="Age"          value={fd.med_aid_dec_death_deceased_age} />
                <FieldRow label="Cell"         value={fd.med_aid_dec_death_deceased_cell} />
                <FieldRow label="Tel (H)"      value={fd.med_aid_dec_death_deceased_tel_home} />
                <FieldRow label="Tel (W)"      value={fd.med_aid_dec_death_deceased_tel_work} />
                <FieldRow label="Res. Address" value={fd.med_aid_dec_death_deceased_address} />
                <FieldRow label="Suburb"       value={fd.med_aid_dec_death_deceased_suburb} />
                <FieldRow label="Code"         value={fd.med_aid_dec_death_deceased_postal_code} />
              </div>

              {/* Column 2 — title + practitioner + medical confirmation + handover */}
              <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
                <div style={{
                  padding: '20px', borderBottom: `2px solid ${LN}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1.6rem', fontWeight: 900, color: INK, letterSpacing: '0.12em', textTransform: 'uppercase', textAlign: 'center', minHeight: 140
                }}>
                  Declaration of Death
                </div>
                <SectionHead label="Healthcare Professional" />
                <FieldRow label="Surname"        value={fd.med_aid_dec_death_hcp_surname} />
                <FieldRow label="First Name"     value={fd.med_aid_dec_death_hcp_first_name} />
                <FieldRow label="Station"        value={fd.med_aid_dec_death_hcp_station} />
                <FieldRow label="Qualification"  value={fd.med_aid_dec_death_hcp_qualification} />
                <FieldRow label="ID No"          value={fd.med_aid_dec_death_hcp_id} />
                <FieldRow label="Practitioner No" value={fd.med_aid_dec_death_hcp_hpcsa} />

                <SectionHead label="Confirmation of Death" />
                <FieldRow label="Absent Carotid Pulse"   value={fd.med_aid_dec_death_med_carotid} />
                <FieldRow label="Absent Heart Sounds"    value={fd.med_aid_dec_death_med_heart_sounds} />
                <FieldRow label="Absent Resp. Activity"  value={fd.med_aid_dec_death_med_respiratory} />
                <FieldRow label="ECG Asystole (I/II/III)" value={fd.med_aid_dec_death_med_ecg} />
                <FieldRow label="Fixed/Dilated Pupils"   value={fd.med_aid_dec_death_med_pupils} />

                <SectionHead label="Deceased Handed Over To" />
                <FieldRow label="Surname"       value={fd.med_aid_dec_death_handover_surname} />
                <FieldRow label="First Name"    value={fd.med_aid_dec_death_handover_first_name} />
                <FieldRow label="Relationship"  value={fd.med_aid_dec_death_handover_relationship} />
                <FieldRow label="Contact No"    value={fd.med_aid_dec_death_handover_contact} />
              </div>

              {/* Column 3 — the signed declaration + undertaker */}
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <SectionHead label="Declaration" />
                <div style={{
                  padding: '6px 8px', borderTop: `1px solid ${LN}`,
                  fontSize: '0.62rem', color: INK, lineHeight: 1.5, background: SOFT_BG,
                }}>
                  I, the undersigned, hereby declare that the deceased sustained no further harm while in my care, and
                  that the above facts are, to the best of my knowledge, true and correct.
                </div>
                <FieldRow label="Date"  value={fd.med_aid_dec_death_signature_date} />
                <FieldRow label="Place" value={fd.med_aid_dec_death_signature_place} />

                {/* Signatory */}
                <FieldRow label="Full Name" value={fd.med_aid_dec_death_signatory_name} />
                <div style={{ padding: '6px 8px', borderTop: `1px solid ${LN}` }}>
                  <div style={{ fontSize: '0.52rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Signature</div>
                  <SignatureBox src={fd.med_aid_dec_death_signature} minHeight={64} />
                </div>

                {/* Crew member 2 */}
                <FieldRow label="Crew Member 2" value={fd.med_aid_dec_death_crew_attended_name} />
                <div style={{ padding: '6px 8px', borderTop: `1px solid ${LN}` }}>
                  <div style={{ fontSize: '0.52rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Crew Signature</div>
                  <SignatureBox src={fd.med_aid_dec_death_crew_attended_signature} minHeight={64} />
                </div>

                {/* Witness — optional; omit the whole block unless captured. */}
                {(!isBlank(fd.med_aid_dec_death_witness_name) || !isBlank(fd.med_aid_dec_death_witness_signature)) && (
                  <>
                    <FieldRow label="Witness Name" value={fd.med_aid_dec_death_witness_name} />
                    <div style={{ padding: '6px 8px', borderTop: `1px solid ${LN}` }}>
                      <div style={{ fontSize: '0.52rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Witness Signature</div>
                      <SignatureBox src={fd.med_aid_dec_death_witness_signature} minHeight={64} />
                    </div>
                  </>
                )}

                {/* Undertaker Details added underneath declaration for RESUS DOD */}
                {(fd.undertaker_name || fd.undertaker_collector_signature) && (
                  <>
                    <SectionHead label="Undertaker Details" />
                    <FieldRow label="Company Name" value={fd.undertaker_name} />
                    <FieldRow label="Phone No" value={fd.undertaker_phone} />
                    <FieldRow label="Collector" value={fd.undertaker_collector_name} />
                    <div style={{ padding: '6px 8px', borderTop: `1px solid ${LN}` }}>
                      <div style={{ fontSize: '0.52rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Undertaker Signature</div>
                      <SignatureBox src={fd.undertaker_collector_signature} minHeight={64} />
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════ ATTACHMENT PAGES ═══════════════════ */}
      {/* ═══════════════════ PAGE 4 — Injury Diagram ═══════════════════ */}
      {Array.isArray(fd.body_marks) && fd.body_marks.length > 0 && (
        <div className="prf-print-frame">
          <div className="prf-page" style={{
            width: 1220, minHeight: 862,
            margin: '28px auto 0', background: '#fff', color: INK,
            border: `2px solid ${LN}`, boxShadow: '0 6px 24px rgba(0,0,0,0.1)',
            display: 'flex', flexDirection: 'column',
          }}>
            <div style={{ background: GREEN, color: '#fff', padding: '12px 24px', fontSize: '1.2rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Injury Diagram
            </div>
            <div style={{ flex: 1, padding: 24, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', background: SOFT_BG }}>
              <div style={{ width: '100%', maxWidth: 1000, background: '#fff', padding: 24, borderRadius: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.05)' }}>
                <PrintableInjuryDiagram value={fd.body_marks} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════ PAGE 5+ — Attachments ═══════════════════ */}
      {[
        { label: 'Hospital Sticker', val: fd.hospital_sticker },
        { label: 'Admission Form', val: fd.admission_form_image },
        { label: 'ID Document', val: fd.id_document_image },
        { label: 'Medical Aid Card', val: fd.medical_aid_image },
        { label: 'AOD Document', val: fd.aod_document },
        { label: 'Additional Document', val: fd.additional_document_image },
        ...(Array.isArray(fd.nursing_notes) ? fd.nursing_notes : []).map((n: any, i: number) => ({
          label: `Nursing Note #${i + 1}`,
          val: n.data_url
        })),
        ...(Array.isArray(fd.med_aid_dec_death_documents) ? fd.med_aid_dec_death_documents : []).map((n: any, i: number) => ({
          label: `Declaration of Death Document #${i + 1}`,
          val: n.data_url
        })),
        // NOTE: raf_oar_report_pdf is deliberately NOT listed here. It is a
        // single form field that used to be fed into BOTH this loop and the
        // `attachedDocs` loop above, so a RAF OAR produced TWO sheets — and
        // this one rendered it in an <iframe>, which html2canvas cannot
        // rasterise, so the exported PDF carried a blank page. attachedDocs
        // serves it correctly, degrading to a labelled record block because a
        // canvas snapshot cannot render PDF pages at all.
      ].filter(d => d.val).map((doc, i) => (
        <div key={`attachment-${i}`} className="prf-print-frame">
          <div className="prf-page" style={{
            width: 1220, minHeight: 862,
            margin: '28px auto 0', background: '#fff', color: INK,
            border: `2px solid ${LN}`, boxShadow: '0 6px 24px rgba(0,0,0,0.1)',
            display: 'flex', flexDirection: 'column',
          }}>
            <div style={{ background: GREEN, color: '#fff', padding: '12px 24px', fontSize: '1.2rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Patient Documents (Attachments) - {doc.label}
            </div>
            {/* Fixed-height media box (same pattern as the injury-diagram page,
                which uses maxHeight:770). The previous maxHeight:'100%' resolved
                against an INDEFINITE flex height — the page grows to its natural
                content height — so a tall portrait photo blew the sheet out and
                the whole PDF view rendered squashed. A bounded height keeps the
                page at A4 proportions and objectFit preserves the aspect. */}
            <div style={{ flex: 1, padding: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', background: SOFT_BG, overflow: 'hidden' }}>
              {/* Every entry in this loop is a captured IMAGE. The former
                  `isPdf` <iframe> branch was reachable only via
                  raf_oar_report_pdf, which now renders through attachedDocs;
                  an iframe could never appear in the exported PDF anyway, so
                  keeping the branch would only invite the duplicate back. */}
              <img src={doc.val} alt={doc.label} style={{ maxWidth: '100%', maxHeight: 740, objectFit: 'contain', border: `1px solid ${LN}`, borderRadius: 8 }} />
            </div>
          </div>
        </div>
      ))}
      </div>{/* /prf-pdf-content */}
    </div>
  );
}

// ── Vitals table row (extracted to keep main render readable) ─────────
function Row({ label, keyName, vitals, cols }: {
  label: string; keyName: string; vitals: any[]; cols: number;
}) {
  return (
    <>
      <div style={{
        padding: '3px 7px', borderRight: `1px solid ${LN}`, borderBottom: `1px solid ${LN}`,
        fontWeight: 700, background: GREEN_TINT, fontSize: '0.55rem',
        textTransform: 'uppercase', letterSpacing: '0.04em', color: INK,
        display: 'flex', alignItems: 'center',
      }}>{label}</div>
      {[...Array(cols)].map((_, i) => (
        <div key={i} style={{
          padding: '3px 3px',
          borderRight: i < cols - 1 ? `1px solid ${LN}` : 'none',
          borderBottom: `1px solid ${LN}`,
          fontFamily: 'ui-monospace, monospace', textAlign: 'center',
          minHeight: 16, fontSize: '0.66rem',
        }}>{vitals[i]?.[keyName] || ''}</div>
      ))}
    </>
  );
}
