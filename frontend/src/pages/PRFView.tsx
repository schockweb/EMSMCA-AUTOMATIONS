/**
 * PRFView — Service-provider-branded PRF display for medical-scheme submission.
 * Renders the submitted Digital PRF in a clean, print-ready paper-form layout
 * with the provider's branding (logo, PR number, address, phone) prominent.
 */
import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';

// ── Paper-form tokens ────────────────────────────────────────────────
const GREEN    = '#2f8f4a';      // section headers bar
const GREEN_DK = '#1f6a33';      // accent + provider brand
const GREEN_TINT = '#eaf6ed';    // label cell background
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
const EmptySignature = ({ label = 'Not captured' }: { label?: string }) => (
  <div style={{
    minHeight: 48, background: SOFT_BG, border: `1px dashed #d1d5db`,
    borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '0.68rem', color: DIM, fontStyle: 'italic',
    letterSpacing: '0.04em',
  }}>{label}</div>
);

// ── Primitives ───────────────────────────────────────────────────────
// Densities are deliberately tight: the whole form has to fit two A4
// landscape pages with every captured field rendered, so vertical
// padding is kept under 4 px and font sizes under 0.8 rem throughout.
const FieldRow = ({ label, value, labelWidth = 95, valueMin = 16 }: {
  label: string; value?: string | null | React.ReactNode; labelWidth?: number; valueMin?: number;
}) => {
  const blank = typeof value === 'string' ? value.trim() === '' : (value === null || value === undefined);
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', borderTop: `1px solid ${LN}` }}>
      <div style={{
        padding: '3px 6px', fontSize: '0.56rem', fontWeight: 800, color: INK,
        textTransform: 'uppercase', letterSpacing: '0.04em',
        background: GREEN_TINT, minWidth: labelWidth, width: labelWidth,
        borderRight: `1px solid ${LN}`, display: 'flex', alignItems: 'center',
      }}>{label}</div>
      <div style={{
        padding: '3px 7px', fontSize: '0.76rem', color: blank ? DIM : INK,
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
    fontSize: '0.62rem', fontWeight: 900, padding: '4px 8px',
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
    display: 'flex', alignItems: 'center', gap: 6, padding: '3px 7px',
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
      .then(r => setPrf(r.data))
      .catch(e => setErr(e.response?.data?.detail || 'Failed to load PRF'));
  }, [caseId]);

  // Open the share prompt only when ALL of these hold:
  //   1. The crew arrived from a `?send=1` post-submit redirect
  //   2. The PRF data has loaded
  //   3. The PRF carries a valid Receiving Facility Email
  // Without all three the modal stays hidden — no point asking the crew
  // to send a PDF when there's nowhere to send it.
  useEffect(() => {
    if (searchParams.get('send') !== '1') return;
    if (!prf) return;
    const email = (prf.form_data?.handover_doctor_email || '').trim();
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (valid) setShowSharePrompt(true);
  }, [searchParams, prf]);

  // Pre-warm the PDF in the background as soon as PRF data lands. By the
  // time the crew taps "Send", the File is in state and handleShare()
  // can call navigator.share() synchronously with zero awaits — the only
  // way iOS Safari reliably honours the file-share request.
  useEffect(() => {
    if (!prf) return;
    if (pdfBuildStartedRef.current) return;
    pdfBuildStartedRef.current = true;
    // Wait a frame so the .prf-page DOM is laid out before html2canvas
    // tries to snapshot it. requestAnimationFrame fires after the next
    // paint; 200ms after that gives the green tables / signatures /
    // sticker box time to settle.
    const t = window.setTimeout(async () => {
      const pdf = await buildPrfPdf();
      if (!pdf) return;
      const blob = pdf.output('blob');
      const file = new File(
        [blob],
        `PRF_${prf.prf_number || 'export'}.pdf`,
        { type: 'application/pdf' },
      );
      setSharePdfFile(file);
    }, 800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prf]);

  // Build the 2-page PDF by snapshotting each .prf-page independently and
  // placing it on its own A4 landscape sheet. This bypasses the browser's
  // CSS print pagination (which fought with the 1220px-wide layout and
  // produced 5–7 pages instead of 2). Each .prf-page is rendered to a
  // canvas with html2canvas, then drawn into the jsPDF document scaled
  // to fit the 297mm × 210mm printable area exactly — never more than
  // one page per .prf-page in the DOM.
  //
  // Returns the jsPDF instance so callers can either `.save()` (download)
  // or `.output('blob')` (Web Share API attachment).
  const buildPrfPdf = async () => {
    const pages = Array.from(document.querySelectorAll<HTMLElement>('.prf-page'));
    if (pages.length === 0) return null;

    const PAGE_W_MM = 297;
    const PAGE_H_MM = 210;
    const INSET_MM = 5;
    const drawW = PAGE_W_MM - INSET_MM * 2;
    const drawH = PAGE_H_MM - INSET_MM * 2;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });

    // Each .prf-page in the DOM is sized to A4-landscape aspect
    // (1220×862 ≈ 1.415:1, vs the 287×200mm draw area at 1.435:1) and
    // clipped via overflow:hidden, so the captured canvas already
    // matches the destination — no slicing, no stretching, just a
    // straight 1:1 placement. PNG + scale:3 keeps text edges crisp.
    for (let i = 0; i < pages.length; i++) {
      const el = pages[i];
      const canvas = await html2canvas(el, {
        scale: 3,
        useCORS: true,
        backgroundColor: '#ffffff',
        windowWidth: el.scrollWidth,
        windowHeight: el.scrollHeight,
      });
      if (i > 0) pdf.addPage('a4', 'landscape');
      pdf.addImage(
        canvas.toDataURL('image/png'),
        'PNG', INSET_MM, INSET_MM, drawW, drawH, undefined, 'NONE',
      );
    }

    return pdf;
  };

  const handleDownloadPdf = async () => {
    const pdf = await buildPrfPdf();
    if (!pdf) return;
    pdf.save(`PRF_${prf.prf_number || 'export'}.pdf`);
  };

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
  // SYNCHRONOUS (no async / no await). iOS Safari requires
  // `navigator.share()` to be the very next thing executed inside a
  // user-gesture event — any await between the tap and the share call
  // drops the gesture flag and the share request is silently ignored.
  // The PDF File is pre-built in the background (see the effect above)
  // so we have it ready and can call share() instantly on tap.
  //
  // If the PDF isn't ready yet (rare — page loaded slowly, crew tapped
  // immediately) we fall back to opening Gmail compose and letting the
  // crew attach manually once the download completes.
  const handleShare = () => {
    const fileName = `PRF_${prf.prf_number || 'export'}.pdf`;
    const toEmail = (prf.form_data?.handover_doctor_email || '').trim();
    const patientName = [prf.form_data?.patient_name, prf.form_data?.patient_surname]
      .filter(Boolean).join(' ') || 'the patient';
    const subject = `Digital PRF #${prf.prf_number} — ${patientName}`;

    const nav = navigator as any;
    const canFileShare = !!(
      sharePdfFile &&
      window.isSecureContext &&
      nav.canShare &&
      nav.canShare({ files: [sharePdfFile] })
    );

    if (canFileShare && sharePdfFile) {
      // PATH A — synchronous Web Share with the pre-built PDF.
      // Auto-copy email is fire-and-forget so it doesn't break the
      // gesture chain.
      if (toEmail && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(toEmail).catch(() => { /* noop */ });
      }
      nav.share({
        files: [sharePdfFile],
        title: subject,
        text: toEmail ? `Send to: ${toEmail}` : '',
      }).catch(() => { /* user cancelled or unsupported, fine */ });
      return;
    }

    // PATH B — Web Share isn't available (or the pre-warmed PDF isn't
    // ready yet). Open the Gmail APP directly via platform-specific URL
    // schemes so the crew lands inside Gmail's compose screen, then
    // download the PDF so they can attach it via the paperclip.
    //
    //   iOS      → googlegmail://co?...   (Gmail iOS app)
    //   Android  → intent://...#Intent;package=com.google.android.gm
    //   Desktop  → mail.google.com/mail/?view=cm (web compose)
    //
    // The URL navigation MUST fire synchronously before the PDF save —
    // iOS Safari only allows `googlegmail://` from inside the user
    // gesture, and the synthetic download anchor click below doesn't
    // need a gesture so it can run after.
    const body = `Please find the Digital PRF for ${patientName} (Case ${prf.case_number || prf.prf_number}) attached.`;
    const to = encodeURIComponent(toEmail);
    const su = encodeURIComponent(subject);
    const bd = encodeURIComponent(body);
    const ua = navigator.userAgent || '';
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const isAndroid = /Android/i.test(ua);
    const gmailWebUrl = toEmail
      ? `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${su}&body=${bd}`
      : 'https://mail.google.com/mail/?view=cm&fs=1';

    if (isIOS) {
      // googlegmail://co opens the Gmail iOS app directly with the
      // To/Subject/Body fields pre-populated. If the app isn't
      // installed the navigation silently fails — a 1500ms fallback
      // timer routes to web compose so the crew still gets there.
      const appUrl = toEmail
        ? `googlegmail://co?to=${to}&subject=${su}&body=${bd}`
        : 'googlegmail://co';
      const fallback = window.setTimeout(() => {
        window.location.href = gmailWebUrl;
      }, 1500);
      window.addEventListener('pagehide', () => clearTimeout(fallback), { once: true });
      window.location.href = appUrl;
    } else if (isAndroid) {
      // Android intent pinned to package=com.google.android.gm so
      // the OS opens Gmail specifically (no app chooser). If Gmail
      // isn't installed, browser_fallback_url routes to web compose.
      const intentUrl =
        `intent://compose?to=${to}&subject=${su}&body=${bd}` +
        `#Intent;scheme=mailto;package=com.google.android.gm;` +
        `S.browser_fallback_url=${encodeURIComponent(gmailWebUrl)};end`;
      window.location.href = intentUrl;
    } else {
      window.open(gmailWebUrl, '_blank', 'noopener,noreferrer');
    }

    // Trigger PDF download in the background. Synthetic anchor clicks
    // don't need a user gesture so this works even after the Gmail
    // navigation above has fired.
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
    { label: 'Mobile',              t: 'time_mobile',         k: 'km_mobile'         },
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

  // ── Empty-section detection ──
  const debtorKeys = [
    'debtor_gender', 'debtor_name', 'debtor_surname',
    'debtor_id_number', 'debtor_age', 'debtor_address',
    'debtor_phone_home', 'debtor_phone_cell',
  ];
  const patientHasData = anyValue(fd, ['patient_name', 'patient_surname', 'patient_id_number']);
  const debtorSameAsPatient = !anyValue(fd, debtorKeys) && patientHasData;
  const valuablesEmpty = isBlank(fd.valuables_handed_to) && isBlank(fd.valuables_description);
  const motivationNotes: string = fd.management_notes || fd.events_hpi || '';

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
        {fd.handover_doctor_email && (
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
        )}
        <button onClick={handleDownloadPdf} style={{
          padding: '9px 20px', border: 'none',
          background: `linear-gradient(135deg, ${GREEN}, ${GREEN_DK})`, color: '#fff',
          fontSize: '0.84rem', fontWeight: 800, cursor: 'pointer', borderRadius: 6,
          boxShadow: `0 3px 10px rgba(47,143,74,0.3)`, letterSpacing: '0.02em',
        }}>Save as PDF</button>
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
            width: 297mm;
            height: 210mm;
            max-height: 210mm;
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
            margin: 0 auto !important;
            border: 2px solid ${LN} !important;
            width: 1220px !important;
            min-width: 1220px !important;
            /* The fit-to-page zoom factor is computed in JS at beforeprint
               and injected per-page so each PRF prints on exactly one A4
               sheet regardless of how tall its vitals/meds tables are. */
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
        width: 1220, height: 862, overflow: 'hidden',
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
            {prov.slug?.toLowerCase() === 'jems' ? (
              <img src="/jems_logo.png" alt={prov.name} style={{ height: 36, width: 'auto' }} />
            ) : (
              <div style={{ fontWeight: 900, color: GREEN_DK, fontSize: '0.9rem', letterSpacing: '0.02em' }}>
                {prov.name || 'Service Provider'}
              </div>
            )}
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
            {/* Call-type checks — only the actually selected one renders. */}
            {(() => {
              const ct = (fd.call_type || '').toUpperCase();
              const cells: string[] = [];
              if (!isTransfer) cells.push('Primary');
              else {
                cells.push('Transfer');
                if (['IHT', 'IFT', 'RHT', 'COURTESY'].includes(ct)) cells.push(ct);
              }
              if (cells.length === 0) return null;
              return (
                <div style={{ display: 'flex', borderTop: `1px solid ${LN}` }}>
                  {cells.map((label, i) => (
                    <div key={label} style={{ flex: 1, borderRight: i < cells.length - 1 ? `1px solid ${LN}` : 'none' }}>
                      <Chk label={label} checked />
                    </div>
                  ))}
                </div>
              );
            })()}
            {fd.rht_call_out_fee && <FieldRow label="Call-Out Fee" value={fd.rht_call_out_fee} />}
            <div style={{ flex: 1, borderTop: `1px solid ${LN}` }} />
          </div>

          {/* Call Information */}
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
            <SectionHead label="Call Information" />
            <FieldRow label="Incident Add"  value={fd.incident_location} />
            <FieldRow label="Suburb / Ward" value={fd.suburb_ward} />
            <FieldRow label="Referring Dr"  value={fd.referring_doctor} />
            <FieldRow label="Dest Facility" value={fd.receiving_facility} />
            <FieldRow label="Ward"          value={fd.ward} />
            <FieldRow label="Receiving Dr"  value={fd.receiving_doctor} />
            <div style={{ flex: 1, borderTop: `1px solid ${LN}` }} />
          </div>

          {/* Alpha Unit + Times/KM grid */}
          <div>
            <SectionHead
              label="Alpha Unit"
              rightLabel={vehicle.callsign ? 'CALLSIGN' : undefined}
              rightValue={vehicle.callsign}
            />
            {vehicle.registration && (
              <div style={{
                padding: '4px 8px', fontSize: '0.64rem', fontWeight: 700,
                background: GREEN_TINT, borderBottom: `1px solid ${LN}`,
                fontFamily: 'ui-monospace, monospace', letterSpacing: '0.04em', color: INK,
                display: 'flex', justifyContent: 'space-between',
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
              <div style={{ padding: '3px 6px', borderRight: `1px solid ${LN}` }}>Event</div>
              <div style={{ padding: '3px 6px', borderRight: `1px solid ${LN}` }}>Time</div>
              <div style={{ padding: '3px 6px' }}>KM</div>
            </div>
            {timeRows.map(r => (
              <div key={r.t} style={{
                display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr',
                borderTop: `1px solid ${LN}`, fontSize: '0.7rem',
              }}>
                <div style={{ padding: '3px 6px', fontWeight: 700, borderRight: `1px solid ${LN}`, background: GREEN_TINT, fontSize: '0.58rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{r.label}</div>
                <div style={{ padding: '3px 6px', borderRight: `1px solid ${LN}`, fontFamily: 'ui-monospace, monospace' }}>{fmtTime(ts[r.t])}</div>
                <div style={{ padding: '3px 6px', fontFamily: 'ui-monospace, monospace' }}>{km[r.k] || ''}</div>
              </div>
            ))}
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
            ] as Array<[string, any]>)
              .filter(([, v]) => !isBlank(v)))
              .map(([label, v]) => <FieldRow key={label} label={label} value={v} />)}
            <div style={{ flex: 1, borderTop: `1px solid ${LN}` }} />
          </div>

          {/* Clinical Summary: Priority → Assessment/Monitoring → Billing → Mechanism */}
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
            <SectionHead label="Priority" />
            {fd.priority ? (
              <div style={{
                padding: '8px 10px', textAlign: 'center',
                background: priorityColors[fd.priority] || '#fff',
                color: priorityColors[fd.priority] ? '#fff' : INK,
                borderTop: `1px solid ${LN}`,
                fontSize: '0.84rem', fontWeight: 900,
                textTransform: 'uppercase', letterSpacing: '0.08em',
              }}>{fd.priority}</div>
            ) : (
              <FieldRow label="Priority" value="" />
            )}

            <SectionHead label="Assessment / Monitoring" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
              <div style={{ borderRight: `1px solid ${LN}` }}>
                <div style={{
                  padding: '3px 7px', background: GREEN_TINT, fontSize: '0.54rem',
                  fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em',
                  borderTop: `1px solid ${LN}`, borderBottom: `1px solid ${LN}`, color: INK,
                }}>Assessment</div>
                {fd.assessment_level
                  ? <Chk label={fd.assessment_level} checked />
                  : <FieldRow label="Level" value="" />}
              </div>
              <div>
                <div style={{
                  padding: '3px 7px', background: GREEN_TINT, fontSize: '0.54rem',
                  fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em',
                  borderTop: `1px solid ${LN}`, borderBottom: `1px solid ${LN}`, color: INK,
                }}>Monitoring</div>
                {fd.monitoring_level
                  ? <Chk label={fd.monitoring_level} checked />
                  : <FieldRow label="Level" value="" />}
              </div>
            </div>

            <SectionHead label="Billing Type" />
            {fd.billing_type
              ? <Chk label={fd.billing_type} checked />
              : <FieldRow label="Type" value="" />}

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

            <div style={{ flex: 1, borderTop: `1px solid ${LN}` }} />
          </div>

          {/* Medical Aid + Declarations (resus / declaration-of-death / quoted) */}
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
            <SectionHead label="Medical Aid Information" />
            <FieldRow label="Scheme"       value={fd.medical_scheme} />
            <FieldRow label="Aid No"       value={fd.medical_aid_number} />
            <FieldRow label="Pre-Auth No"  value={fd.preauth_number} />
            <FieldRow label="Post-Auth No" value={fd.post_auth_number} />
            <FieldRow label="Dependent"    value={fd.dependent_number} />
            <FieldRow label="Main Member"  value={fd.main_member_id} />
            <FieldRow label="Plan"         value={fd.scheme_option} />
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
                ['HPCSA No',    fd.med_aid_dec_death_hpcsa],
              ]} />
            )}
            {fd.med_aid_quoted && (
              <SubBlock title="Quoted (Med-Aid Decline)" rows={[
                ['Amount (R)', fd.med_aid_quoted_amount],
              ]} />
            )}
            <div style={{ flex: 1, borderTop: `1px solid ${LN}` }} />
          </div>

          {/* Channel-specific + Return Trip (all conditional — empty sub-blocks fold) */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <SectionHead label="Channel Detail" />
            <SubBlock title="RAF" rows={[
              ['Reference',     fd.compensation_reference],
              ['Accident Date', fd.raf_accident_date],
              ['SAPS / OB No',  fd.raf_police_case_number],
              ['Accident Loc',  fd.raf_accident_location, 24],
            ]} />
            <SubBlock title="IOD / Compensation" rows={[
              ['Reference',   fd.compensation_reference],
              ['Employer',    fd.wca_employer],
              ['Employee No', fd.wca_employee_number],
              ['Injury Date', fd.wca_injury_date],
              ['OAR No',      fd.wca_oar_number],
            ]} />
            <SubBlock title="Requesting Provider" rows={[
              ['Provider',  fd.ems_provider_name],
              ['Reference', fd.ems_provider_ref],
              ['BHF No',    fd.ems_provider_bhf],
            ]} />
            <SubBlock title="Private / Account Holder" rows={[
              ['Method',    fd.pvt_payment_method],
              ['Holder',    fd.pvt_account_holder],
              ['Holder ID', fd.pvt_account_holder_id],
              ['Contact',   fd.pvt_account_holder_phone],
              ['Address',   fd.pvt_account_holder_address, 24],
            ]} />
            <SubBlock title="Event Standby" rows={[
              ['Event',        fd.event_name],
              ['Organiser',    fd.event_organiser],
              ['Event Date',   fd.event_date],
              ['Booking Ref',  fd.event_booking_ref],
              ['On-Site Cont', fd.event_contact_person],
            ]} />
            <SubBlock title="Call-Out / Stand-Down" rows={[
              ['Requested By', fd.callout_requested_by],
              ['Auth Ref',     fd.callout_authorisation],
              ['Reason',       fd.callout_standdown_reason, 24],
            ]} />
            <SubBlock title="Quoted" rows={[
              ['Quote No',      fd.quote_number],
              ['Amount (R)',    fd.quote_amount],
              ['Authorised By', fd.quote_authorised_by],
              ['Valid Until',   fd.quote_valid_until],
            ]} />
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
            <div style={{ flex: 1, borderTop: `1px solid ${LN}` }} />
          </div>
        </div>

        {/* ── BAND C — Debtor │ Handover+Sticker │ Valuables+Sigs │ Motivation+Terms ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.7fr 1.5fr 2.1fr', borderTop: `2px solid ${LN}` }}>
          {/* Debtor — same-as-patient tile OR full debtor rows (all populated). */}
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

          {/* Handed Over To + Hospital Sticker */}
          <div style={{ borderRight: `1px solid ${LN}`, display: 'flex', flexDirection: 'column' }}>
            <SectionHead label="Handed Over To" />
            <FieldRow label="Name"          value={fd.handover_name} />
            <FieldRow label="Qualification" value={fd.handover_qualification} />
            <FieldRow label="Doctor Email"  value={fd.handover_doctor_email} />
            <div style={{ padding: '6px 8px', borderTop: `1px solid ${LN}` }}>
              <div style={{
                fontSize: '0.52rem', fontWeight: 800, color: MUT,
                textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3,
              }}>Handover Signature</div>
              {prf.signatures?.handover_signature
                ? <img src={prf.signatures.handover_signature} alt="handover" style={{ maxWidth: '100%', maxHeight: 36 }} />
                : <EmptySignature />}
            </div>
            <FieldRow label="Condition" value={fd.handover_notes} valueMin={32} />
            <SectionHead label="Hospital Sticker" />
            <div style={{
              borderTop: `1px solid ${LN}`, padding: 4,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{
                width: '94%', minHeight: 38, maxHeight: 60,
                border: `1.3px dashed ${MUT}`, borderRadius: 3,
                background: SOFT_BG,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 3, overflow: 'hidden',
              }}>
                {fd.hospital_sticker ? (
                  <img src={fd.hospital_sticker} alt="hospital sticker"
                       style={{ maxWidth: '100%', maxHeight: 54, objectFit: 'contain' }} />
                ) : (
                  <div style={{
                    fontSize: '0.54rem', fontWeight: 700, color: MUT,
                    textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'center',
                  }}>Affix patient sticker here</div>
                )}
              </div>
            </div>
            <div style={{ flex: 1 }} />
          </div>

          {/* Valuables + Patient/Witness Signatures + RAF sketch (if any) */}
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
                <FieldRow label="Description" value={fd.valuables_description} valueMin={28} />
              </>
            )}
            <SectionHead label="Signatures" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderTop: `1px solid ${LN}` }}>
              <div style={{ padding: '6px 7px', borderRight: `1px solid ${LN}` }}>
                <div style={{ fontSize: '0.52rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Patient</div>
                {prf.signatures?.patient_signature
                  ? <img src={prf.signatures.patient_signature} alt="patient" style={{ maxWidth: '100%', maxHeight: 42 }} />
                  : <EmptySignature />}
              </div>
              <div style={{ padding: '6px 7px' }}>
                <div style={{ fontSize: '0.52rem', fontWeight: 800, color: MUT, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Witness</div>
                {prf.signatures?.witness_signature
                  ? <img src={prf.signatures.witness_signature} alt="witness" style={{ maxWidth: '100%', maxHeight: 42 }} />
                  : <EmptySignature />}
              </div>
            </div>
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

          {/* Motivation / Other Notes — single continuous block. The note
              sits at the top of the column with flex:1 absorbing the rest
              of the height, so the column reads as one clean card. */}
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
          </div>
        </div>

        {/* ── BAND D — Crew Details (compact one-row strip; lives on page 1
              so page 2 has room for the full clinical stack). Inline label
              chips replace the column-header row to keep the band height
              down — total ~28px so Band B (patient/clinical/medaid/channel)
              keeps the vertical space it needs to render every populated
              field without clipping. */}
        <div style={{
          borderTop: `2px solid ${LN}`,
          display: 'grid', gridTemplateColumns: '1fr 1fr',
          fontSize: '0.72rem', fontFamily: 'ui-monospace, monospace',
          background: '#fff',
        }}>
          {([
            { c: prf.crew_1, sig: prf.signatures?.crew_signature,   fbName: fd.assessed_by, fbQual: fd.assessor_qualifications, role: 'Assessed By' },
            { c: prf.crew_2, sig: prf.signatures?.crew_2_signature, fbName: fd.managed_by,  fbQual: fd.manager_qualifications,  role: 'Managed By'  },
          ]).map(({ c, sig, fbName, fbQual, role }, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '4px 10px',
              borderRight: i === 0 ? `1px solid ${LN}` : 'none',
              minHeight: 26,
            }}>
              <span style={{
                fontSize: '0.5rem', fontWeight: 900, color: '#fff',
                background: GREEN_DK, padding: '2px 6px', borderRadius: 3,
                textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0,
              }}>Crew · {role}</span>
              {([
                ['HPCSA', c?.hpcsa_number],
                ['Qual',  c?.qualification || fbQual],
                ['Name',  c?.full_name || fbName],
              ] as Array<[string, any]>).map(([label, v]) => (
                <span key={label} style={{ display: 'flex', alignItems: 'baseline', gap: 4, minWidth: 0 }}>
                  <span style={{
                    fontSize: '0.5rem', fontWeight: 800, color: MUT,
                    textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0,
                  }}>{label}</span>
                  <span style={{
                    color: INK, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{isBlank(v) ? <EmptyMark /> : v}</span>
                </span>
              ))}
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
                {sig
                  ? <img src={sig} alt={`crew ${i + 1} signature`} style={{ maxHeight: 22, maxWidth: 110 }} />
                  : <EmptySignature />}
              </span>
            </div>
          ))}
        </div>
      </div>

      </div>{/* /prf-print-frame (page 1) */}

      {/* ═══════════════════ PAGE 2 — Clinical ═══════════════════
          Same A4-landscape aspect lock as page 1. Top = mini header +
          crew details table. Bottom = 3-col clinical grid (short
          checks | history narrative | vitals + IV + meds + management). */}
      <div className="prf-print-frame">
      <div className="prf-page" style={{
        width: 1220, height: 862, overflow: 'hidden',
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
            <FieldRow label="Device"     value={fd.o2_device} />
            <FieldRow label="Start Time" value={fd.o2_start_time} />
            <FieldRow label="Stop Time"  value={fd.o2_stop_time} />

            {(() => {
              const airway = Array.isArray(fd.airway_interventions) ? fd.airway_interventions.filter(Boolean) : [];
              const subFields: Array<[string, any]> = [
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
            <FieldRow label="Findings"       value={fd.findings_on_arrival}  valueMin={24} />
            <FieldRow label="Allergies"      value={fd.allergies} />
            <FieldRow label="Current Meds"   value={fd.current_medications}  valueMin={24} />
            <FieldRow label="Past History"   value={fd.past_medical_history} valueMin={24} />
            <FieldRow label="Last Meal"      value={fd.last_meal} />
            <FieldRow label="Last Meal Time" value={fd.last_meal_time} />
            <FieldRow label="Events / HPI"   value={fd.events_hpi}           valueMin={48} />

            {/* IV Therapy */}
            <SectionHead label="Intravenous Therapy" />
            <div style={{
              display: 'grid', gridTemplateColumns: '2fr 1.4fr 1fr 1fr 0.8fr',
              background: GREEN_TINT, fontSize: '0.54rem', fontWeight: 800,
              textTransform: 'uppercase', letterSpacing: '0.06em',
              borderBottom: `1px solid ${LN}`, color: INK,
            }}>
              <div style={{ padding: '3px 8px', borderRight: `1px solid ${LN}` }}>Type</div>
              <div style={{ padding: '3px 8px', borderRight: `1px solid ${LN}` }}>Site</div>
              <div style={{ padding: '3px 8px', borderRight: `1px solid ${LN}` }}>Vol Inf.</div>
              <div style={{ padding: '3px 8px', borderRight: `1px solid ${LN}` }}>Time Up</div>
              <div style={{ padding: '3px 8px' }}>Sign</div>
            </div>
            {(ivRows.length ? ivRows : [{}, {}]).map((row: any, i: number) => (
              <div key={i} style={{
                display: 'grid', gridTemplateColumns: '2fr 1.4fr 1fr 1fr 0.8fr',
                borderTop: `1px solid ${LN}`, fontSize: '0.72rem',
                fontFamily: 'ui-monospace, monospace',
              }}>
                <div style={{ padding: '3px 8px', borderRight: `1px solid ${LN}`, minHeight: 18 }}>
                  {[row.type, row.jelco_size].filter(Boolean).join(' · ')}
                </div>
                <div style={{ padding: '3px 8px', borderRight: `1px solid ${LN}` }}>{row.site || ''}</div>
                <div style={{ padding: '3px 8px', borderRight: `1px solid ${LN}` }}>{row.vol_infused || ''}</div>
                <div style={{ padding: '3px 8px', borderRight: `1px solid ${LN}` }}>{row.time_up || ''}</div>
                <div style={{ padding: '3px 8px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, display: 'flex', alignItems: 'center' }}>
                  {typeof row.sign === 'string' && row.sign.startsWith('data:image/')
                    ? <img src={row.sign} alt="Sign" style={{ maxHeight: 22, maxWidth: '100%', objectFit: 'contain' }} />
                    : (row.sign || '')}
                </div>
              </div>
            ))}

            {/* Medication / Infusion */}
            <SectionHead label="Medication / Infusion" />
            <div style={{
              display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 0.8fr',
              background: GREEN_TINT, fontSize: '0.54rem', fontWeight: 800,
              textTransform: 'uppercase', letterSpacing: '0.06em',
              borderBottom: `1px solid ${LN}`, color: INK,
            }}>
              <div style={{ padding: '3px 8px', borderRight: `1px solid ${LN}` }}>Type</div>
              <div style={{ padding: '3px 8px', borderRight: `1px solid ${LN}` }}>Route</div>
              <div style={{ padding: '3px 8px', borderRight: `1px solid ${LN}` }}>Dose</div>
              <div style={{ padding: '3px 8px', borderRight: `1px solid ${LN}` }}>Time</div>
              <div style={{ padding: '3px 8px' }}>Sign</div>
            </div>
            {(medRows.length ? medRows : [{}, {}]).map((row: any, i: number) => (
              <div key={i} style={{
                display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 0.8fr',
                borderTop: `1px solid ${LN}`, fontSize: '0.72rem',
                fontFamily: 'ui-monospace, monospace',
              }}>
                <div style={{ padding: '3px 8px', borderRight: `1px solid ${LN}`, minHeight: 18 }}>{row.type || ''}</div>
                <div style={{ padding: '3px 8px', borderRight: `1px solid ${LN}` }}>{row.route || ''}</div>
                <div style={{ padding: '3px 8px', borderRight: `1px solid ${LN}` }}>{row.dose || ''}</div>
                <div style={{ padding: '3px 8px', borderRight: `1px solid ${LN}` }}>{row.time || ''}</div>
                <div style={{ padding: '3px 8px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, display: 'flex', alignItems: 'center' }}>
                  {typeof row.sign === 'string' && row.sign.startsWith('data:image/')
                    ? <img src={row.sign} alt="Sign" style={{ maxHeight: 22, maxWidth: '100%', objectFit: 'contain' }} />
                    : (row.sign || '')}
                </div>
              </div>
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

            {/* IV Therapy + Medication / Infusion moved to column 2 (below
                History) so this column can host the full vitals time-series
                and let Management absorb any leftover height. */}

            {/* Management notes — fills remaining vertical space (flex:1) */}
            <SectionHead label="Management" />
            <div style={{
              padding: '6px 9px', fontSize: '0.74rem', color: INK,
              whiteSpace: 'pre-wrap', lineHeight: 1.45,
              borderTop: `1px solid ${LN}`,
              flex: 1, overflow: 'hidden',
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
            width: 1220, height: 862, overflow: 'hidden',
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
                {prov.slug?.toLowerCase() === 'jems' ? (
                  <img src="/jems_logo.png" alt={prov.name} style={{ height: 30, width: 'auto' }} />
                ) : (
                  <div style={{ fontWeight: 900, color: GREEN_DK, fontSize: '0.86rem', letterSpacing: '0.02em' }}>
                    {prov.name || 'Service Provider'}
                  </div>
                )}
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
