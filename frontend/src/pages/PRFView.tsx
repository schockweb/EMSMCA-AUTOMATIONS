/**
 * PRFView — Service-provider-branded PRF display for medical-scheme submission.
 * Renders the submitted Digital PRF in a clean, print-ready paper-form layout
 * with the provider's branding (logo, PR number, address, phone) prominent.
 */
import { useEffect, useRef, useState, Fragment } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
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
const INK      = '#0b1020';      // body text
const MUT      = '#5b6478';      // secondary text
const DIM      = '#94a3b8';      // placeholder / empty marker
const LN       = '#088395';      // borders (brand teal)
const SOFT_BG  = '#f8fafc';      // empty-state background

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

// ── Component ────────────────────────────────────────────────────────
export default function PRFView() {
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
      setSharePdfFile(file);
    }, 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prf]);

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

    // A4 landscape printable area with a 5mm safety inset on every edge.
    const PAGE_W_MM = 297;
    const PAGE_H_MM = 210;
    const INSET_MM = 5;
    const maxW = PAGE_W_MM - INSET_MM * 2;   // 287mm
    const maxH = PAGE_H_MM - INSET_MM * 2;   // 200mm
    // Beyond this height we slice instead of shrinking, so a very tall page
    // never scales text below ~70% (1 / 1.4) and stays legible.
    const SHRINK_LIMIT_MM = maxH * 1.4;

    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape', compress: true });
    let firstSheet = true;
    const newSheet = () => {
      if (!firstSheet) pdf.addPage('a4', 'landscape');
      firstSheet = false;
    };

    // Sheet aspect (height / width) the page layout must match to fill the
    // printable area edge-to-edge.
    const SHEET_RATIO = maxH / maxW;               // ≈ 0.697

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
        try {
          let w = el.offsetWidth || 1220;
          let h = el.offsetHeight || 862;
          for (let pass = 0; pass < 4 && h / w > SHEET_RATIO + 0.002; pass++) {
            w = Math.min(Math.ceil(h / SHEET_RATIO), 2400);   // cap: sanity bound
            el.style.width = `${w}px`;
            el.style.minWidth = `${w}px`;
            h = el.offsetHeight;                  // reflowed height
            w = el.offsetWidth || w;
          }
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
        if (!canvas || !cw || !ch) continue;      // skip a zero-size snapshot

        // Use JPEG at 0.72 quality — shrinks the PDF from ~64MB (PNG) to
        // ~2-4MB while keeping text perfectly readable on A4 printouts.
        const imgData = canvas.toDataURL('image/jpeg', 0.72);
        const imgFormat = 'JPEG';

        const wScale = maxW / cw;                  // mm per source px at full width
        const fullH = ch * wScale;                 // page height in mm rendered full-width

        if (fullH <= maxH + 0.5) {
          const drawH = fullH >= maxH * 0.92 ? maxH : fullH;
          newSheet();
          pdf.addImage(imgData, imgFormat, INSET_MM, INSET_MM, maxW, drawH, undefined, 'FAST');
        } else if (fullH <= SHRINK_LIMIT_MM) {
          // Modest overflow — shrink uniformly onto ONE clean sheet, centred.
          // Aspect ratio is preserved so fields can never smear or overlap.
          const scale = Math.min(maxW / cw, maxH / ch);
          const drawW = cw * scale;
          const drawH = ch * scale;
          newSheet();
          pdf.addImage(imgData, imgFormat, INSET_MM + (maxW - drawW) / 2, INSET_MM, drawW, drawH, undefined, 'FAST');
        } else {
          // Very tall page — slice into full-width A4 bands across consecutive
          // sheets so every row stays full size and readable, never clipped.
          const sliceHpx = Math.max(1, Math.floor(maxH / wScale));   // source px per sheet
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
    } catch (_e) {
      // A single bad image — e.g. a cross-origin logo that tainted the canvas
      // and made toDataURL throw — must never silently brick the whole export.
      // Returning null lets callers show their "couldn't build" fallback.
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
    const PX_PER_MM = 96 / 25.4;
    // Must stay ≤ the .prf-print-frame box (295×205mm) so the scaled page
    // never overflows the frame and bleeds onto a second (blank) sheet.
    const frameW = 293 * PX_PER_MM;   // 2mm under frame width (rounding safety)
    const frameH = 203 * PX_PER_MM;   // 2mm under frame height
    const SHEET_RATIO = frameH / frameW;   // sheet aspect the page must match
    const fit = () => {
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
        let w = p.offsetWidth || 1220;
        let h = p.offsetHeight || 862;
        for (let pass = 0; pass < 4 && h / w > SHEET_RATIO + 0.002; pass++) {
          w = Math.min(Math.ceil(h / SHEET_RATIO), 2400);
          p.style.width = `${w}px`;
          p.style.minWidth = `${w}px`;
          h = p.offsetHeight;                 // reflowed height
          w = p.offsetWidth || w;
        }
        const s = Math.min(frameW / w, frameH / h, 1);
        p.style.transformOrigin = 'top left';
        p.style.transform = `scale(${s > 0 ? s : 1})`;
      });
    };
    const reset = () => {
      document.querySelectorAll<HTMLElement>('.prf-page').forEach(p => {
        p.style.transform = '';
        if (p.dataset.prfPrevWidth !== undefined) {
          p.style.width = p.dataset.prfPrevWidth;
          p.style.minWidth = p.dataset.prfPrevMinWidth || '';
          delete p.dataset.prfPrevWidth;
          delete p.dataset.prfPrevMinWidth;
        }
      });
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
      // Prefer the pre-warmed PDF; build on demand if the crew tapped fast.
      let file = sharePdfFile;
      if (!file) {
        const pdf = await buildPrfPdf();
        if (!pdf) throw new Error('pdf_build_failed');
        file = new File([pdf.output('blob')], buildPrfFileName(prf), { type: 'application/pdf' });
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
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.data?.status === 'already_sent') {
        setSentPhase('delivered');
        setSendStatus('sent');
        return;
      }
      setSentPhase('queued');
      setSendStatus('sent');
      // Short poll for the actual outcome (worker sends within seconds when
      // healthy). Give up quietly after ~30s — the queued wording stays
      // honest and the admin surfaces carry the final state.
      for (let i = 0; i < 6; i++) {
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

  if (err) return <div style={{ padding: 48, color: '#b91c1c', fontWeight: 700, textAlign: 'center' }}>{err}</div>;
  if (!prf) return <div style={{ padding: 48, color: MUT, textAlign: 'center' }}>Loading PRF...</div>;

  const fd = prf.form_data || {};
  const ts = prf.timestamps || {};
  const km = prf.kms || {};
  const prov = prf.provider || {};
  const vehicle = prf.vehicle || {};
  const isTransfer = (fd.call_type || '').toUpperCase() !== 'PRIMARY';

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
  const timeRows = [
    { label: 'Call Disp',           t: 'time_dispatched',     k: 'km_dispatched'     },
    { label: 'Scene',               t: 'time_on_scene',       k: 'km_on_scene'       },
    ...(!noTransport ? [
      { label: 'Depart', t: 'time_depart_scene', k: 'km_depart_scene' },
      { label: 'Arrival At Facility', t: 'time_at_destination', k: 'km_at_destination' }
    ] : []),
    { label: 'Available',           t: 'time_available',      k: 'km_available'      },
  ];

  const priorityColors: Record<string, string> = {
    RED: '#dc2626', ORANGE: '#ea580c', YELLOW: '#d97706',
    GREEN: '#16a34a', BLUE: '#2563eb',
  };

  const returnTripHasContent = !!(
    fd.return_despatch_time || fd.return_on_scene_time ||
    fd.return_handover_time || fd.return_available_time ||
    fd.return_depart_time
  );

  // The payer-specific block lives in the "Billing Information" column and is
  // driven by billing_type. (The separate "Channel Detail" block was removed.)
  const billingType = (fd.billing_type || '').toString().toUpperCase();

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
                <>
                  {/* Honest status: 'queued' until the worker's sent-stamp
                      confirms actual delivery to the mail server. */}
                  <div style={{ fontSize: '0.92rem', color: '#15803d', fontWeight: 700, lineHeight: 1.5, marginBottom: 22 }}>
                    {sentPhase === 'delivered' ? '✓ PRF sent to ' : '✓ PRF queued — sending to '}
                    <span style={{ wordBreak: 'break-word' }}>{sendEmailTo.trim()}</span>
                  </div>
                  <button onClick={() => setShowSharePrompt(false)} style={{
                    width: '100%', padding: '12px 18px', border: 'none', borderRadius: 8,
                    background: `linear-gradient(135deg, ${GREEN}, ${GREEN_DK})`,
                    color: '#fff', fontWeight: 800, fontSize: '0.92rem', cursor: 'pointer',
                  }}>Done</button>
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
                      fontSize: '0.92rem', border: `1.5px solid ${sendError ? '#fca5a5' : '#cbd5e1'}`,
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
                      <button onClick={handleConfirmSend} style={{
                        padding: '11px 18px', border: `1.5px solid ${GREEN_DK}`, borderRadius: 8,
                        background: '#fff', color: GREEN_DK, fontWeight: 800, fontSize: '0.88rem',
                        cursor: 'pointer',
                      }}>Send manually instead</button>
                    )}
                    <button onClick={() => setShowSharePrompt(false)} style={{
                      padding: '11px 18px', border: `1px solid #cbd5e1`, borderRadius: 8,
                      background: '#fff', color: INK, fontWeight: 700, fontSize: '0.86rem',
                      cursor: 'pointer',
                    }}>Skip</button>
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

      <style>{`
        @keyframes prfPdfSpin { to { transform: rotate(360deg); } }
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
            {fd.rht_call_out_fee && <FieldRow label="Call-Out Fee" value={fd.rht_call_out_fee} />}
            {/* Assessment level + Billing Type. PVT shows its payment method
                too ("PVT — Cash") so cash settlements are visible at a glance. */}
            {fd.call_type !== 'DOD' && <FieldRow label="Assessment"   value={fd.assessment_level} />}
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
              else if (['IHT', 'IFT', 'RHT', 'COURTESY'].includes(ct)) display = `Transfer — ${ct}`;
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
                  <div style={{ padding: '2px 6px', display: 'flex', alignItems: 'center', fontFamily: 'ui-monospace, monospace' }}>{km[r.k] || ''}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── BAND B — For DOD calls the Declaration of Death renders first ── */}
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
              <FieldRow label="Passport No"  value={fd.med_aid_dec_death_deceased_passport} />
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
        
        <div style={{
          display: 'grid', gridTemplateColumns: (fd.call_type === 'DOD' && fd.med_aid_dec_death) ? '1fr 1fr' : '1.64fr 1.36fr 1.8fr 1.6fr',
          borderTop: `2px solid ${LN}`, flex: 1, minHeight: 0,
        }}>
          {/* Patient Information — only fields the crew actually captured are
              shown; blank rows are omitted (no column of "—"). DOB prints
              dd/mm/yyyy. */}
          {!(fd.call_type === 'DOD' && fd.med_aid_dec_death) && (
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
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
            {fd.call_type !== 'DOD' && (
              <>
                <SectionHead label="Mechanism" />
                {(() => {
                  const selected = Array.isArray(fd.mechanism)
                    ? fd.mechanism.filter(Boolean)
                    : (fd.mechanism ? [fd.mechanism] : []);
                  if (selected.length === 0) return <FieldRow label="Mechanism" value="" />;
                  return selected.map((m: string) => <Chk key={m} label={m} checked />);
                })()}
                {fd.mechanism_other && (
                  <FieldRow label="Detail" value={fd.mechanism_other} valueMin={24} />
                )}
                
                {/* Resus never captures a triage priority (the form hides the
                    picker — the crew is already running the resus), so the row
                    is omitted rather than printing a permanent "—". */}
                {fd.call_type !== 'RESUS' && (
                  <>
                    <SectionHead label="Patient Priority" />
                    <FieldRow label="Priority" value={fd.priority || '—'} />
                  </>
                )}
              </>
            )}
            <FillLines />
          </div>
          )}

          {/* Debtor Information — grouped here alongside Patient + Medical Aid. */}
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
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
                <FieldRow label="Passport" value={fd.debtor_passport_number} />
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
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
            {fd.call_type !== 'COURTESY' && (
              <>
            <SectionHead label="Billing Information" />
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
                {fd.pvt_payment_method === 'Cash' && (
                  <>
                    <SectionHead label="Cash Verification" />
                    <FieldRow label="Amount Paid" value={fd.pvt_cash_amount_paid ? `R ${fd.pvt_cash_amount_paid}` : ''} />
                    <div style={{ padding: '4px 6px', borderTop: `1px solid ${LN}` }}>
                      <div style={{ fontSize: '0.48rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', marginBottom: 2 }}>Payer Signature</div>
                      <SignatureBox src={fd.pvt_cash_payer_signature} minHeight={40} />
                    </div>
                    <FieldRow label="Crew Received" value={fd.pvt_cash_crew_received ? `R ${fd.pvt_cash_crew_received}` : ''} />
                    <div style={{ padding: '4px 6px', borderTop: `1px solid ${LN}` }}>
                      <div style={{ fontSize: '0.48rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', marginBottom: 2 }}>Crew Signature</div>
                      <SignatureBox src={fd.pvt_cash_crew_signature} minHeight={40} />
                    </div>
                  </>
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

            {/* Hospital Sticker — dedicated placeholder, now positioned beneath
                Medical Aid Information. Shows the captured sticker inline when
                present, otherwise a reserved "affix here" box so the slot is
                always visible on the printed / exported PRF. Hidden for RHT
                (no hospital transport, so no sticker). */}
            {!(fd.call_type === 'DOD' && fd.med_aid_dec_death) && fd.call_type !== 'RHT' && (
              <>
                <SectionHead label="Hospital Sticker" />
                {/* Fixed-size slot (real stickers are ~credit-card sized) — it
                    used to flex-grow and swallow the column's leftover height
                    as a huge dashed void. Leftover space now becomes ruled
                    write-in lines below instead. */}
                <div style={{
                  borderTop: `1px solid ${LN}`, padding: 6,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <div style={{
                    width: '96%', minHeight: 110,
                    border: `1.6px dashed ${MUT}`, borderRadius: 4,
                    background: SOFT_BG,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: 6, overflow: 'hidden',
                  }}>
                    {fd.hospital_sticker ? (
                      <img src={fd.hospital_sticker} alt="hospital sticker"
                           style={{ maxWidth: '100%', maxHeight: 200, objectFit: 'contain' }} />
                    ) : (
                      <div style={{
                        fontSize: '0.62rem', fontWeight: 700, color: DIM,
                        textTransform: 'uppercase', letterSpacing: '0.08em', textAlign: 'center',
                        lineHeight: 1.6,
                      }}>Affix hospital sticker here</div>
                    )}
                  </div>
                </div>
                <FillLines />
              </>
            )}
          </div>

          {/* Channel-specific + Return Trip (when present) + Terms & Conditions.
              The T&C live in this right-hand column next to Medical Aid
              Information, matching the JEMS paper form. This column always
              renders so the T&C are on every PRF. */}
          {!(fd.call_type === 'DOD' && fd.med_aid_dec_death) && (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {/* "Channel Detail" section removed per request. The return-trip
                times are retained below for inter-facility transfers. */}
            {returnTripHasContent && (
              <>
                <SectionHead label="Return Trip" />
                <FieldRow label="Despatch"  value={fd.return_despatch_time} />
                <FieldRow label="On Scene"  value={fd.return_on_scene_time} />
                <FieldRow label="Depart"    value={fd.return_depart_scene_time} />
                <FieldRow label="At Dest"   value={fd.return_at_destination_time} />
                <FieldRow label="Handover"  value={fd.return_handover_time} />
                <FieldRow label="Available" value={fd.return_available_time} />
              </>
            )}

            {/* Terms & Conditions (page-1 right column, like the paper form) */}
            {fd.call_type !== 'DOD' && (
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
                <SectionHead label="Signatures" />
                {(() => {
                  const sigLabel: React.CSSProperties = { fontSize: '0.65rem', fontWeight: 900, color: MUT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 };
                  const witnessSig = fd.tc_witness_signature || prf.signatures?.witness_signature;
                  const nokSig      = fd.next_of_kin_signature || prf.signatures?.next_of_kin_signature;
                  // Patient / Rep always shows (it's a mandatory signature). Witness
                  // and Next of Kin only render when actually captured, so empty
                  // "Not captured" boxes don't clutter the form.
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', borderTop: `1px solid ${LN}` }}>
                      {fd.call_type !== 'DOD' && (
                        <div style={{ padding: '5px 7px', borderBottom: (witnessSig || nokSig || fd.call_type === 'DOD') ? `1px solid ${LN}` : 'none' }}>
                          <div style={sigLabel}>Patient / Rep.</div>
                          <SignatureBox src={fd.tc_patient_signature || prf.signatures?.patient_signature} minHeight={80} />
                        </div>
                      )}
                      {(witnessSig || fd.call_type === 'DOD') && (
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
        {fd.patient_refused_treatment && (
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

        {/* Main clinical grid: 3 cols (short checks + surveys | History | wide records) */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1.3fr 2.5fr',
          borderTop: `2px solid ${LN}`, flex: 1, minHeight: 0,
        }}>
          {/* COL 1 — Oxygen / Airway / Circ / Immob / Primary + Secondary Survey */}
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
            <SectionHead label="Oxygen Admin" />
            {/* Hide the rows when no oxygen was administered — keep just the
                section tag so the PDF isn't a column of empty "—" rows. */}
            {[fd.o2_flow_rate, fd.o2_percent, fd.o2_device, fd.o2_bvm, fd.o2_start_time, fd.o2_stop_time].some(v => !isBlank(v)) && (
              <>
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
              {(([
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
              ] as const).filter(([, key]) =>
                vitals.some((v: any) => !isBlank(v?.[key]))
              )).map(([label, key]) => (
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

              {(([
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
              ] as const).filter(([, key]) =>
                vitals.some((v: any) => !isBlank(v?.[key]))
              )).map(([label, key]) => (
                <Row key={key} label={label} keyName={key} vitals={vitalsOverflow} cols={vitalsOverflowCols} />
              ))}
            </div>

            <div style={{ flex: 1 }} />
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

      {/* ═══════════════════ DECLARATION OF DEATH ═══════════════════
          Rendered on its own dedicated A4-landscape sheet, and ONLY when a
          Declaration of Death was actually completed on the PRF. Previously
          these fields were crammed into the narrow Billing-Information column;
          giving them a full page lets every field (particulars of deceased,
          healthcare professional, medical confirmation, handover, and the
          signed declaration) render legibly. Picked up by the PDF/print
          pipeline via the shared .prf-page selector. */}
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
                <FieldRow label="Passport No"  value={fd.med_aid_dec_death_deceased_passport} />
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
        ...(fd.raf_oar_report_pdf ? [{
          label: `RAF OAR Report: ${fd.raf_oar_report_pdf.name || 'PDF'}`,
          val: fd.raf_oar_report_pdf.data_url,
          isPdf: true
        }] : [])
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
            <div style={{ flex: 1, padding: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', background: SOFT_BG, overflow: 'hidden' }}>
              {(doc as any).isPdf ? (
                <iframe src={doc.val} title={doc.label} style={{ width: '100%', height: '100%', border: `1px solid ${LN}`, borderRadius: 8 }} />
              ) : (
                <img src={doc.val} alt={doc.label} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', border: `1px solid ${LN}`, borderRadius: 8 }} />
              )}
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
