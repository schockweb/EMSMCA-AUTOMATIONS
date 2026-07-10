/**
 * PRFView — Service-provider-branded PRF display for medical-scheme submission.
 * Renders the submitted Digital PRF in a clean, print-ready paper-form layout
 * with the provider's branding (logo, PR number, address, phone) prominent.
 */
import { useEffect, useRef, useState, Fragment } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import axios from '../api/client';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';

// ── Paper-form tokens ────────────────────────────────────────────────
const GREEN    = '#2f8f4a';      // section headers bar
const GREEN_DK = '#1f6a33';      // accent + provider brand
const GREEN_TINT = '#eaf6ed';    // label cell background

import { PrintableInjuryDiagram } from '../components/BodyDiagram';
const INK      = '#0b1020';      // body text
const MUT      = '#5b6478';      // secondary text
const DIM      = '#94a3b8';      // placeholder / empty marker
const LN       = '#2f8f4a';      // borders
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
    minHeight, width: '100%', boxSizing: 'border-box',
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
      minHeight, width: '100%', boxSizing: 'border-box',
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

// ── Component ────────────────────────────────────────────────────────
export default function PRFView() {
  const { caseId } = useParams<{ caseId: string }>();
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

  useEffect(() => {
    const token = localStorage.getItem('access_token') || localStorage.getItem('crew_token') || '';
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
        `PRF_${prf.prf_number || 'export'}.pdf`,
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
        pdf.save(`PRF_${prf?.prf_number || 'export'}.pdf`);
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
    const fileName = `PRF_${prf.prf_number || 'export'}.pdf`;
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
  const ivRows: any[] = Array.isArray(fd.iv_therapy) ? fd.iv_therapy : [];
  const medRows: any[] = Array.isArray(fd.medications) ? fd.medications : [];

  const timeRows = [
    { label: 'Call Disp',           t: 'time_dispatched',     k: 'km_dispatched'     },
    { label: 'Scene',               t: 'time_on_scene',       k: 'km_on_scene'       },
    { label: 'Depart',              t: 'time_depart_scene',   k: 'km_depart_scene'   },
    { label: 'Arrival At Facility', t: 'time_at_destination', k: 'km_at_destination' },
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
          </div>
        </div>
      )}
      {/* Toolbar — hidden on print */}
      <div className="no-print" style={{
        maxWidth: 1220, margin: '0 auto 20px', display: 'flex',
        justifyContent: 'space-between', alignItems: 'center', padding: '0 16px',
      }}>
        <button onClick={() => navigate(-1)} style={{
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
        <button onClick={handleShare} style={{
            padding: '9px 18px', border: 'none', marginRight: 10,
            background: 'linear-gradient(135deg, #2563eb, #1d4ed8)', color: '#fff',
            fontSize: '0.84rem', fontWeight: 800, cursor: 'pointer', borderRadius: 6,
            boxShadow: '0 3px 10px rgba(37,99,235,0.3)', letterSpacing: '0.02em',
            display: 'inline-flex', alignItems: 'center', gap: 8,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 2 11 13" />
              <path d="m22 2-7 20-4-9-9-4 20-7z" />
            </svg>
            Send a copy to receiving facility
          </button>
        <button onClick={handlePrint} style={{
          padding: '9px 16px', border: `1px solid #cbd5e1`, marginRight: 10,
          background: '#fff', color: INK,
          fontSize: '0.84rem', fontWeight: 700, cursor: 'pointer', borderRadius: 6,
          boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        }}>Print</button>
        <button onClick={handleSavePdf} disabled={savingPdf} style={{
          padding: '9px 20px', border: 'none',
          background: savingPdf ? '#94a3b8' : `linear-gradient(135deg, ${GREEN}, ${GREEN_DK})`, color: '#fff',
          fontSize: '0.84rem', fontWeight: 800, cursor: savingPdf ? 'wait' : 'pointer', borderRadius: 6,
          boxShadow: `0 3px 10px rgba(47,143,74,0.3)`, letterSpacing: '0.02em',
        }}>{savingPdf ? 'Building PDF…' : 'Save as PDF'}</button>
      </div>

      <style>{`
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
        <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1.5fr 2.4fr 2.2fr' }}>
          {/* Brand block — minimalist: small logo + provider details */}
          <div style={{
            padding: '10px 12px', borderRight: `1px solid ${LN}`,
            display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4,
          }}>
            <ProviderLogo prov={prov} height={40} />
            {prov.phone && (
              <div style={{
                fontSize: '0.82rem', fontWeight: 900, color: INK,
                fontFamily: 'ui-monospace, monospace', letterSpacing: '0.02em', marginTop: 2,
              }}>{prov.phone}</div>
            )}
            {prov.pr_number && (
              <div style={{ fontSize: '0.58rem', fontWeight: 700, color: MUT, letterSpacing: '0.04em' }}>
                PR No: <span style={{ fontFamily: 'ui-monospace, monospace', color: INK }}>{prov.pr_number}</span>
              </div>
            )}
            {prov.pty_reg_number && (
              <div style={{ fontSize: '0.55rem', fontWeight: 600, color: MUT }}>
                PTY Reg: <span style={{ fontFamily: 'ui-monospace, monospace' }}>{prov.pty_reg_number}</span>
              </div>
            )}
            {(() => {
              const lvl = (fd.assessment_level || '').toString().toUpperCase();
              if (!['BLS', 'ILS', 'ALS'].includes(lvl)) return null;
              const palette: Record<string, { bg: string; border: string; fg: string }> = {
                BLS: { bg: '#eff6ff', border: '#bfdbfe', fg: '#1d4ed8' },
                ILS: { bg: '#fff7ed', border: '#fed7aa', fg: '#c2410c' },
                ALS: { bg: '#fef2f2', border: '#fecaca', fg: '#b91c1c' },
              };
              const c = palette[lvl];
              return (
                <div style={{
                  marginTop: 6, padding: '3px 9px',
                  background: c.bg, border: `1px solid ${c.border}`, color: c.fg,
                  borderRadius: 6, fontSize: '0.66rem', fontWeight: 800,
                  letterSpacing: '0.12em', textTransform: 'uppercase',
                  fontFamily: 'Arial, "Helvetica Neue", Helvetica, system-ui, -apple-system, sans-serif',
                }}>{lvl}</div>
              );
            })()}
          </div>

          {/* Address + meta (date / case / call type) */}
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
            {prov.address && (
              <div style={{ padding: '6px 9px 3px', fontSize: '0.62rem', color: INK, whiteSpace: 'pre-wrap', lineHeight: 1.35 }}>
                {prov.address}
              </div>
            )}
            {prov.email && (
              <div style={{ padding: '0 9px 4px', fontSize: '0.56rem', color: MUT }}>{prov.email}</div>
            )}
            <FieldRow label="Date" value={fmtDate(ts.time_call_received || prf.submitted_at)} />
            <FieldRow label="Case No" value={prf.case_number} />
            {fd.rht_call_out_fee && <FieldRow label="Call-Out Fee" value={fd.rht_call_out_fee} />}
            {/* Assessment level + Billing Type */}
            <FieldRow label="Assessment"   value={fd.assessment_level} />
            <FieldRow label="Billing Type" value={fd.billing_type} />
            {/* Call type — moved to the bottom and stretched (flex:1) so it
                fills the otherwise-empty space, with its label(s) centered. */}
            {(() => {
              const ct = (fd.call_type || '').toUpperCase();
              const cells: string[] = [];
              if (!isTransfer) cells.push('Primary');
              else {
                cells.push('Transfer');
                if (['IHT', 'IFT', 'RHT', 'COURTESY'].includes(ct)) cells.push(ct);
              }
              return (
                <div style={{
                  flex: 1, display: 'flex', borderTop: `1px solid ${LN}`,
                  background: 'rgba(47,143,74,0.08)', minHeight: 40,
                }}>
                  {(cells.length ? cells : ['—']).map((label, i, arr) => (
                    <div key={label} style={{
                      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      gap: 7, padding: '6px 8px',
                      borderRight: i < arr.length - 1 ? `1px solid ${LN}` : 'none',
                    }}>
                      <span style={{
                        width: 13, height: 13, border: `1.4px solid ${GREEN_DK}`,
                        background: GREEN_DK, display: 'inline-flex', alignItems: 'center',
                        justifyContent: 'center', color: '#fff', fontSize: '0.7rem',
                        fontWeight: 900, flexShrink: 0,
                      }}>✓</span>
                      <span style={{
                        fontSize: '0.78rem', fontWeight: 800, color: INK,
                        textTransform: 'uppercase', letterSpacing: '0.06em',
                      }}>{label}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* Call Information */}
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
            <SectionHead label="Call Information" />
            <FieldRow label="Incident Add"  value={fd.incident_location} />
            <FieldRow label="Dest Facility" value={fd.receiving_facility} />
            <FieldRow label="Ward"          value={fd.ward} />
            <FieldRow label={fd.call_type === 'COURTESY' ? "Receiving Dr/Person" : "Receiving Dr"}  value={fd.receiving_doctor} />
            <FieldRow label="Qualification" value={fd.handover_qualification} />
            <FieldRow label="Condition" value={fd.handover_notes} valueMin={24} />
            <FieldRow label="Receiving Facility Email" value={fd.handover_doctor_email} />
            <div style={{ flex: 1, borderTop: `1px solid ${LN}`, background: GREEN_TINT }} />
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
              display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr',
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
                  flex: 1, display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr',
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

        {/* ── BAND B — Patient │ Clinical summary │ Medical Aid │ Channel + Return Trip ── */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1.7fr 1.3fr 1.8fr 1.6fr',
          borderTop: `2px solid ${LN}`, flex: 1, minHeight: 0,
        }}>
          {/* Patient Information — all populated fields rendered (16 max) */}
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
            <SectionHead label="Patient Information" />
            {(([
              ['Gender',        fd.gender],
              ['Name',          fd.patient_name],
              ['Surname',       fd.patient_surname],
              ['ID No',         fd.patient_id_number],
              ['Passport',      fd.patient_passport_number],
              ['Age',           fd.age],
              ['DOB',           fd.patient_dob],
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
            
            <SectionHead label="Patient Priority" />
            <FieldRow label="Priority" value={fd.priority || '—'} />
            <div style={{ flex: 1, borderTop: `1px solid ${LN}` }} />
          </div>

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
                {(([
                  ['Gender',   fd.debtor_gender],
                  ['Name',     fd.debtor_name],
                  ['Surname',  fd.debtor_surname],
                  ['ID No',    fd.debtor_id_number],
                  ['Passport', fd.debtor_passport_number],
                  ['Age',      fd.debtor_age],
                  ['DOB',      fd.debtor_dob],
                  ['Address',  fd.debtor_address],
                  ['Suburb',   fd.debtor_suburb],
                  ['Code',     fd.debtor_postal_code],
                  ['Tel (H)',  fd.debtor_phone_home],
                  ['Cell',     fd.debtor_phone_cell],
                ] as Array<[string, any]>)
                  .filter(([, v]) => !isBlank(v)))
                  .map(([label, v]) => <FieldRow key={label} label={label} value={v} />)}
                <div style={{ flex: 1, borderTop: `1px solid ${LN}` }} />
              </>
            )}
          </div>

          {/* Billing Information — content follows the selected billing type so
              the section reflects the actual payer (Med Aid / WCA / IOD / RAF / PVT /
              Event / Call-Out) rather than always showing medical-aid fields. */}
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
            <SectionHead label="Billing Information" />
            {billingType === 'WCA / IOD' ? (
              <>
                <FieldRow label="Reference"   value={fd.compensation_reference} />
                <FieldRow label="Employer"    value={fd.wca_employer} />
                <FieldRow label="Employee No" value={fd.wca_employee_number} />
                <FieldRow label="Injury Date" value={fd.wca_injury_date} />
                <FieldRow label="OAR No"      value={fd.wca_oar_number} />
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
                <FieldRow label="Holder"    value={fd.pvt_account_holder} />
                <FieldRow label="Holder ID" value={fd.pvt_account_holder_id} />
                <FieldRow label="Contact"   value={fd.pvt_account_holder_phone} />
                <FieldRow label="Address"   value={fd.pvt_account_holder_address} valueMin={24} />
              </>
            ) : billingType === 'EVENT' ? (
              <>
                <FieldRow label="Event"        value={fd.event_name} />
                <FieldRow label="Organiser"    value={fd.event_organiser} />
                <FieldRow label="Event Date"   value={fd.event_date} />
                <FieldRow label="Booking Ref"  value={fd.event_booking_ref} />
                <FieldRow label="On-Site Cont" value={fd.event_contact_person} />
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
            {fd.med_aid_dec_death && (
              <SubBlock title="Declaration of Death" rows={[
                ['Time',        fd.med_aid_dec_death_time],
                ['Declared By', fd.med_aid_dec_death_declared_by],
                ['Practitioner Number',    fd.med_aid_dec_death_hpcsa],
              ]} />
            )}
            {fd.med_aid_quoted && (
              <SubBlock title="Quoted (Med-Aid Decline)" rows={[
                ['Amount (R)', fd.med_aid_quoted_amount],
              ]} />
            )}
            {/* Handover Signature — moved here per user request */}
            <SectionHead label="Handover Signature" />
            <div style={{ padding: '6px 8px', borderTop: `1px solid ${LN}`, flexShrink: 0 }}>
              <SignatureBox src={prf.signatures?.handover_signature} minHeight={80} />
            </div>

            {/* Hospital Sticker — dedicated placeholder, now positioned beneath
                Medical Aid Information. Shows the captured sticker inline when
                present, otherwise a reserved "affix here" box so the slot is
                always visible on the printed / exported PRF. */}
            <SectionHead label="Hospital Sticker" />
            <div style={{
              borderTop: `1px solid ${LN}`, padding: 6,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flex: 1,
            }}>
              <div style={{
                width: '96%', minHeight: 120,
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
          </div>

          {/* Channel-specific + Return Trip (when present) + Terms & Conditions.
              The T&C live in this right-hand column next to Medical Aid
              Information, matching the JEMS paper form. This column always
              renders so the T&C are on every PRF. */}
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
            <div style={{ display: 'flex', flexDirection: 'column', borderTop: `1px solid ${LN}` }}>
              <div style={{ padding: '5px 7px', borderBottom: `1px solid ${LN}` }}>
                <div style={{ fontSize: '0.65rem', fontWeight: 900, color: MUT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Patient / Rep.</div>
                <SignatureBox src={fd.tc_patient_signature || prf.signatures?.patient_signature} minHeight={80} />
              </div>
              <div style={{ padding: '5px 7px', borderBottom: `1px solid ${LN}` }}>
                <div style={{ fontSize: '0.65rem', fontWeight: 900, color: MUT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Witness</div>
                <SignatureBox src={fd.tc_witness_signature || prf.signatures?.witness_signature} minHeight={80} />
              </div>
              <div style={{ padding: '5px 7px' }}>
                <div style={{ fontSize: '0.65rem', fontWeight: 900, color: MUT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Next of Kin</div>
                <SignatureBox src={fd.next_of_kin_signature || prf.signatures?.next_of_kin_signature} minHeight={70} />
              </div>
            </div>
            <div style={{ flex: 1, borderTop: `1px solid ${LN}` }} />
          </div>
        </div>

        {/* ── BAND C — Closeout: Valuables + Handover sig │ Crew sign-off (×2) │
              Motivation, all grouped in one band so nothing stretches across a
              sparse full-width row. ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1.3fr 1.3fr 1.9fr', borderTop: `2px solid ${LN}` }}>
          {/* Valuables + Handover Signature (+ RAF sketch if any) */}
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
            <div style={{ flex: 1, borderTop: `1px solid ${LN}` }} />
          </div>

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

          {/* Motivation / Other Notes */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <SectionHead label="Motivation / Other Notes" />
            <div style={{
              flex: 1,
              borderTop: `1px solid ${LN}`,
              padding: '6px 9px',
              background: '#fff',
              color: INK,
              fontSize: '0.74rem', lineHeight: 1.45,
              whiteSpace: 'pre-wrap',
            }}>
              {motivationNotes
                ? motivationNotes
                : <span style={{ fontStyle: 'italic', color: DIM }}>No motivation or additional notes recorded.</span>}
            </div>
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
      </div>

      </div>{/* /prf-print-frame (page 1) */}

      {/* ═══════════════════ PAGE 2 — Clinical ═══════════════════
          Same A4-landscape aspect lock as page 1. Top = mini header +
          crew details table. Bottom = 3-col clinical grid (short
          checks | history narrative | vitals + IV + meds + management). */}
      <div className="prf-print-frame">
      <div className="prf-page" style={{
        width: 1220, minHeight: 862,
        margin: '28px auto 0', background: '#fff', color: INK,
        border: `2px solid ${LN}`, boxShadow: '0 6px 24px rgba(0,0,0,0.1)',
        display: 'flex', flexDirection: 'column',
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

        {/* Main clinical grid: 3 cols (short checks + surveys | History | wide records) */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1.3fr 2.5fr',
          borderTop: `2px solid ${LN}`, flex: 1, minHeight: 0,
        }}>
          {/* COL 1 — Oxygen / Airway / Circ / Immob / Primary + Secondary Survey */}
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
            <SectionHead label="Oxygen Admin" />
            <FieldRow label="L / Min"    value={fd.o2_flow_rate} />
            <FieldRow label="% Oxygen"   value={fd.o2_percent} />
            <FieldRow label="Device"     value={fd.o2_device} />
            <FieldRow label="BVM"        value={fd.o2_bvm} />
            <FieldRow label="Start Time" value={fd.o2_start_time} />
            <FieldRow label="Stop Time"  value={fd.o2_stop_time} />

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
            <div style={{ flex: 1, borderTop: `1px solid ${LN}` }} />
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

            {/* Intravenous Therapy (stacked vertically) */}
            <SectionHead label="Intravenous Therapy" />
            {(ivRows.length ? ivRows : [{}]).map((row: any, i: number) => (
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

            {/* Medication / Infusion (stacked vertically) */}
            <SectionHead label="Medication / Infusion" />
            {(medRows.length ? medRows : [{}]).map((row: any, i: number) => (
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

            <div style={{ flex: 1, borderTop: `1px solid ${LN}` }} />
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

            {/* Management notes — fills remaining vertical space (flex:1) */}
            <SectionHead label="Management" />
            <div style={{
              padding: '6px 9px', fontSize: '0.74rem', color: INK,
              whiteSpace: 'pre-wrap', lineHeight: 1.45,
              borderTop: `1px solid ${LN}`,
              flex: 1,
            }}>
              {fd.management_notes
                ? fd.management_notes
                : <span style={{ color: DIM, fontStyle: 'italic' }}>No management notes recorded.</span>}
            </div>
          </div>
        </div>


      </div>
      </div>{/* /prf-print-frame (page 2) */}

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
        }))
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
              <img src={doc.val} alt={doc.label} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', border: `1px solid ${LN}`, borderRadius: 8 }} />
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
