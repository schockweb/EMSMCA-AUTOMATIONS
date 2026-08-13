import { useEffect, useRef, useState, type CSSProperties } from 'react';

export type DocKey = 'hospital_sticker' | 'admission_form_image' | 'id_document_image' | 'medical_aid_image' | 'aod_document' | 'additional_document_image';

interface Props {
  docs: {
    hospital_sticker?: string | null;
    admission_form_image?: string | null;
    id_document_image?: string | null;
    medical_aid_image?: string | null;
    aod_document?: string | null;
    additional_document_image?: string | null;
  };
  onChange: (key: DocKey, dataUrl: string | null) => void;
}

const G  = '#10b981';
const GD = '#059669';
const S700 = '#334155';
const S200 = '#e2e8f0';
const W    = '#ffffff';
const REDC = '#ef4444';

const DOC_LABELS: Record<DocKey, string> = {
  hospital_sticker: 'Hospital Sticker',
  admission_form_image: 'Admission Form',
  id_document_image: 'ID Document',
  medical_aid_image: 'Medical Aid Card',
  aod_document: 'AOD Document',
  additional_document_image: 'Additional Documents',
};

// Viewfinder shape per document: 'wide' = sticker strip (2:1), 'card' = an
// ID / membership card (~1.5:1), 'tall' = a full A4 page.
export type DocFrame = 'wide' | 'card' | 'tall';

const DOC_FRAMES: Record<DocKey, DocFrame> = {
  hospital_sticker: 'wide',
  admission_form_image: 'tall',
  id_document_image: 'card',
  medical_aid_image: 'card',
  aod_document: 'tall',
  additional_document_image: 'wide',
};

export default function PatientDocumentsCapture({ docs, onChange }: Props) {
  const [showMenu, setShowMenu] = useState(false);
  const [activeCapture, setActiveCapture] = useState<DocKey | null>(null);

  // When a capture completes, clear the active capture, and keep the menu open
  const handleCapture = (dataUrl: string) => {
    if (!activeCapture) return;
    onChange(activeCapture, dataUrl);
    setActiveCapture(null);
    setShowMenu(true);
  };

  const hasAnyDoc = Object.values(docs).some(Boolean);

  return (
    <div style={{ marginTop: 8 }}>
      {/* 1. Preview cards for all captured documents */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: hasAnyDoc ? 12 : 0 }}>
        {(Object.keys(DOC_LABELS) as DocKey[]).map(key => {
          const val = docs[key];
          if (!val) return null;
          return (
            <div key={key} style={{
              display: 'flex', gap: 12, alignItems: 'center', padding: 10,
              borderRadius: 10, border: `1.5px solid ${G}`, background: `${G}14`,
            }}>
              <img
                src={val}
                alt={DOC_LABELS[key]}
                style={{
                  width: 60, height: 40, objectFit: 'cover',
                  borderRadius: 6, border: `1px solid ${S200}`, background: W,
                }}
              />
              <div style={{ flex: 1, fontSize: '0.82rem', color: S700 }}>
                <div style={{ fontWeight: 800, color: GD }}>{DOC_LABELS[key]} captured</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => onChange(key, null)}
                  style={{
                    padding: '5px 10px', borderRadius: 7, border: `1px solid #fecaca`,
                    background: W, color: REDC, fontSize: '0.68rem', fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >Remove</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* 2. Main Trigger Button */}
      <button
        type="button"
        onClick={() => setShowMenu(true)}
        style={{
          width: '100%', padding: '14px 16px', borderRadius: 10,
          border: `2px dashed ${G}`, background: `${G}10`,
          color: GD, fontSize: '0.86rem', fontWeight: 800,
          cursor: 'pointer', letterSpacing: '0.02em',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        }}
      >
        <CameraIcon />
        Patient Documents
      </button>

      {/* 3. Document Selection Menu */}
      {showMenu && !activeCapture && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}>
          <div style={{
            background: W, width: '100%', borderTopLeftRadius: 20, borderTopRightRadius: 20,
            padding: '24px 20px', boxShadow: '0 -4px 20px rgba(0,0,0,0.1)',
            display: 'flex', flexDirection: 'column', gap: 12,
            animation: 'slideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: '1rem', fontWeight: 900, color: S700 }}>Select Document to Photograph</div>
              <button
                type="button"
                onClick={() => setShowMenu(false)}
                style={{ background: 'transparent', border: 'none', fontSize: '1.4rem', color: '#94a3b8', cursor: 'pointer', padding: '0 8px' }}
              >×</button>
            </div>
            {(Object.keys(DOC_LABELS) as DocKey[]).map(key => {
              const isCaptured = !!docs[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => { setActiveCapture(key); setShowMenu(false); }}
                  style={{
                    padding: '16px', borderRadius: 12, fontSize: '0.9rem', fontWeight: 700,
                    border: `1.5px solid ${isCaptured ? G : S200}`,
                    background: isCaptured ? `${G}10` : '#f8fafc',
                    color: isCaptured ? GD : S700,
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    cursor: 'pointer',
                  }}
                >
                  <span>Photograph {DOC_LABELS[key]}</span>
                  {isCaptured && <span style={{ fontSize: '1.1rem' }}>✓</span>}
                </button>
              );
            })}
            <style>{`
              @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
            `}</style>
          </div>
        </div>
      )}

      {/* 4. Fullscreen Camera Overlay */}
      {activeCapture && (
        <CameraOverlay
          title={DOC_LABELS[activeCapture]}
          frame={DOC_FRAMES[activeCapture]}
          onCancel={() => { setActiveCapture(null); setShowMenu(true); }}
          onCapture={handleCapture}
        />
      )}
    </div>
  );
}

// ── Icons ───────────────────────────────────────────────────────────────────

function CameraIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
      <circle cx="12" cy="13" r="4"/>
    </svg>
  );
}

function FlashIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"
         stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  );
}

// ── Fullscreen Overlay with Viewfinder Cutout ──────────────────────────────

interface OverlayProps {
  title: string;
  frame: DocFrame;
  onCancel: () => void;
  onCapture: (dataUrl: string) => void;
}

function CameraOverlay({ title, frame, onCancel, onCapture }: OverlayProps) {
  const videoRef    = useRef<HTMLVideoElement>(null);
  const fileInputId = 'doc-camera-fallback-input';
  const [stream,   setStream]   = useState<MediaStream | null>(null);
  const [error,    setError]    = useState<string | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);
  const [busy,     setBusy]     = useState(false);
  const [torchOn,  setTorchOn]  = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);

  useEffect(() => {
    let active = true;
    let s: MediaStream | null = null;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Camera not supported on this device. Use the upload fallback below.');
        return;
      }
      try {
        s = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width:  { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (!active) { s.getTracks().forEach(t => t.stop()); return; }
        setStream(s);
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          await videoRef.current.play().catch(() => { /* autoplay quirks */ });
        }
        const track = s.getVideoTracks()[0];
        if (track && typeof (track as any).getCapabilities === 'function') {
          const caps = (track as any).getCapabilities() || {};
          if (caps.torch) setTorchSupported(true);
        }
      } catch (e: any) {
        setError('Camera permission denied or unavailable. Use the upload fallback below.');
      }
    })();
    return () => {
      active = false;
      if (s) s.getTracks().forEach(t => t.stop());
    };
  }, []);

  const torchTurnedOnAtRef = useRef<number>(0);
  const toggleTorch = async () => {
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track || typeof track.applyConstraints !== 'function') return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as any] });
      setTorchOn(next);
      if (next) torchTurnedOnAtRef.current = Date.now();
      else torchTurnedOnAtRef.current = 0;
    } catch { }
  };

  const capture = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    setBusy(true);

    const TORCH_WARMUP_MS = 600;
    if (torchOn && torchTurnedOnAtRef.current) {
      const elapsed = Date.now() - torchTurnedOnAtRef.current;
      if (elapsed < TORCH_WARMUP_MS) {
        await new Promise(r => setTimeout(r, TORCH_WARMUP_MS - elapsed));
      }
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const dispW = video.clientWidth;
    const dispH = video.clientHeight;

    const scaleCover = Math.max(dispW / vw, dispH / vh);
    const renderedW  = vw * scaleCover;
    const renderedH  = vh * scaleCover;
    const offsetX    = (renderedW - dispW) / 2;
    const offsetY    = (renderedH - dispH) / 2;

    // We adjust the viewfinder based on the frame shape.
    // wide (sticker): 84% width, 42% height (2:1 aspect)
    // card (ID/Medical Aid): 84% width, ~1.5:1 aspect
    // tall (A4 forms): 80% width, 85% height
    let rectScreenW = dispW * 0.84;
    let rectScreenH = dispH * 0.42;
    if (frame === 'card') {
      rectScreenH = dispW * 0.84 * 0.65; // ~1.5:1 ratio
    } else if (frame === 'tall') {
      rectScreenW = dispW * 0.80;
      rectScreenH = dispH * 0.85;
    }
    const rectScreenX = (dispW - rectScreenW) / 2;
    const rectScreenY = (dispH - rectScreenH) / 2;

    const srcX = (rectScreenX + offsetX) / scaleCover;
    const srcY = (rectScreenY + offsetY) / scaleCover;
    const srcW =  rectScreenW / scaleCover;
    const srcH =  rectScreenH / scaleCover;

    let bitmap: ImageBitmap | HTMLVideoElement = video;
    let bw = vw, bh = vh;
    if (!torchOn) {
      try {
        const track = stream?.getVideoTracks()[0];
        if (track && typeof (window as any).ImageCapture === 'function') {
          const ic = new (window as any).ImageCapture(track);
          const blob: Blob = await ic.takePhoto();
          const ib = await createImageBitmap(blob);
          bitmap = ib;
          bw = ib.width;
          bh = ib.height;
        }
      } catch { }
    }

    if (bw !== vw || bh !== vh) {
      const rx = srcX / vw, ry = srcY / vh, rw = srcW / vw, rh = srcH / vh;
      drawCrop(bitmap, bw * rx, bh * ry, bw * rw, bh * rh);
    } else {
      drawCrop(bitmap, srcX, srcY, srcW, srcH);
    }
    setBusy(false);

    function drawCrop(src: CanvasImageSource, x: number, y: number, w: number, h: number) {
      const maxDim = 1600;
      const scale  = Math.min(1, maxDim / Math.max(w, h));
      const outW = Math.round(w * scale);
      const outH = Math.round(h * scale);
      const canvas = document.createElement('canvas');
      canvas.width  = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, x, y, w, h, 0, 0, outW, outH);
      setCaptured(canvas.toDataURL('image/jpeg', 0.92));
    }
  };

  const accept = () => {
    if (captured) onCapture(captured);
  };

  const onPickFile = (f: File | null) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) { alert('Please choose an image.'); return; }
    if (f.size > 12 * 1024 * 1024)    { alert('Image exceeds 12 MB.');     return; }
    const reader = new FileReader();
    reader.onload = () => setCaptured(String(reader.result));
    reader.readAsDataURL(f);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000, background: '#000',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        flexShrink: 0,
        padding: 'calc(12px + env(safe-area-inset-top)) 16px 12px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'rgba(15,23,42,0.95)', color: '#fff',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}>
        <button
          type="button"
          onClick={onCancel}
          style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '0.92rem', fontWeight: 700, cursor: 'pointer', padding: '6px 4px' }}
        >Cancel</button>
        <div style={{ fontSize: '0.78rem', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          {title}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {torchSupported && !captured && (
            <button
              type="button"
              onClick={toggleTorch}
              style={{
                width: 38, height: 38, borderRadius: 999,
                border: torchOn ? '2px solid #facc15' : '1.5px solid rgba(255,255,255,0.4)',
                background: torchOn ? '#facc15' : 'transparent',
                color: torchOn ? '#0f172a' : '#fff',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <FlashIcon />
            </button>
          )}
          <button
            type="button"
            onClick={accept}
            disabled={!captured}
            style={{
              background: captured ? G : '#475569', border: 'none', color: '#fff',
              fontSize: '0.86rem', fontWeight: 800, cursor: captured ? 'pointer' : 'not-allowed',
              padding: '8px 14px', borderRadius: 8,
            }}
          >Use Photo</button>
        </div>
      </div>

      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#000' }}>
        <video
          ref={videoRef} autoPlay playsInline muted
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000' }}
        />
        {!captured && <ViewfinderMask frame={frame} />}
        {!captured && <ViewfinderHint />}
        {captured && <img src={captured} alt="preview" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', background: '#000' }} />}
        {error && <div style={{ position: 'absolute', left: 16, right: 16, top: 16, background: 'rgba(220,38,38,0.95)', color: '#fff', padding: '10px 14px', borderRadius: 10, fontSize: '0.82rem', fontWeight: 700, lineHeight: 1.4 }}>{error}</div>}
      </div>

      <div style={{
        flexShrink: 0, padding: '14px 16px calc(14px + env(safe-area-inset-bottom))',
        background: 'rgba(15,23,42,0.95)', borderTop: '1px solid rgba(255,255,255,0.08)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
      }}>
        {captured ? (
          <button
            type="button"
            onClick={() => {
              setCaptured(null);
              const v = videoRef.current;
              if (v && stream && v.srcObject !== stream) v.srcObject = stream;
              v?.play().catch(() => {});
            }}
            style={{ padding: '12px 24px', borderRadius: 10, fontSize: '0.86rem', fontWeight: 700, border: '1.5px solid rgba(255,255,255,0.4)', background: 'transparent', color: '#fff', cursor: 'pointer' }}
          >Retake</button>
        ) : stream ? (
          <button
            type="button"
            onClick={capture} disabled={busy}
            style={{ width: 76, height: 76, borderRadius: 999, border: '4px solid #fff', background: '#fff', boxShadow: '0 0 0 4px rgba(255,255,255,0.25)', cursor: busy ? 'wait' : 'pointer' }}
          />
        ) : (
          <label
            htmlFor={fileInputId}
            style={{ padding: '12px 22px', borderRadius: 10, fontSize: '0.84rem', fontWeight: 800, background: G, color: '#fff', cursor: 'pointer', letterSpacing: '0.02em' }}
          >
            Use Camera / Pick Image
            <input id={fileInputId} type="file" accept="image/*" capture="environment" onChange={e => onPickFile(e.target.files?.[0] || null)} style={{ display: 'none' }} />
          </label>
        )}
      </div>
    </div>
  );
}

function ViewfinderMask({ frame }: { frame: DocFrame }) {
  // Determine rectangle coordinates based on the frame shape. (100x100 SVG viewbox)
  let w = 84, h = 42;
  if (frame === 'card') {
    // 84vw width, ~1.5 ratio height => 54vh (assuming portrait screen), let's use fixed SVG %s
    h = 54;
  } else if (frame === 'tall') {
    w = 80;
    h = 85;
  }
  const x = (100 - w) / 2;
  const y = (100 - h) / 2;

  return (
    <svg
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
    >
      <defs>
        <mask id="sticker-mask">
          <rect x="0" y="0" width="100" height="100" fill="white" />
          <rect x={x} y={y} width={w} height={h} rx="2" fill="black" />
        </mask>
      </defs>
      <rect x="0" y="0" width="100" height="100" fill="rgba(0,0,0,0.55)" mask="url(#sticker-mask)" />
      <rect x={x} y={y} width={w} height={h} rx="2" fill="none" stroke="#10b981" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
      
      {/* Corner ticks */}
      {[
        [x, y, x+6, y], [x, y, x, y+6],
        [x+w-6, y, x+w, y], [x+w, y, x+w, y+6],
        [x, y+h-6, x, y+h], [x, y+h, x+6, y+h],
        [x+w, y+h-6, x+w, y+h], [x+w-6, y+h, x+w, y+h],
      ].map(([x1, y1, x2, y2], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#10b981" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
      ))}
    </svg>
  );
}

function ViewfinderHint() {
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: '8%', textAlign: 'center', pointerEvents: 'none' }}>
      <div style={{ display: 'inline-block', padding: '6px 14px', background: 'rgba(15,23,42,0.7)', color: '#fff', fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.04em', borderRadius: 999, textTransform: 'uppercase' }}>
        Fit document inside frame
      </div>
    </div>
  );
}

// ── Reusable capture in the same design, for billing attachments ───────────
// The WCA / employee documents and the RAF OAR report store files on
// form_data as { name, size, data_url } (the shape the PDF's attachment
// sheets render: image data-URLs paint full-page, PDFs get a record block).
// These two components give those slots the same dashed-green camera button
// and in-app camera as the Patient Documents capture above, with a small
// attach-a-PDF path kept for documents that arrive as files rather than
// paper (payslips, medical reports, emailed OARs).

export interface AttachedDocFile { name?: string; size?: number; data_url?: string }

export interface DocSpec { key: string; label: string; frame?: DocFrame }

const dataUrlBytes = (dataUrl: string) =>
  Math.max(0, Math.round((dataUrl.length - (dataUrl.indexOf(',') + 1)) * 0.75));

const isPdfFile = (f: AttachedDocFile) =>
  (f.data_url || '').startsWith('data:application/pdf') || (f.name || '').toLowerCase().endsWith('.pdf');

function readPdfFile(f: File, onDone: (file: { name: string; size: number; data_url: string }) => void) {
  if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) { alert('Only PDF files are accepted.'); return; }
  if (f.size > 10 * 1024 * 1024) { alert('File exceeds 10 MB.'); return; }
  const reader = new FileReader();
  reader.onload = () => onDone({ name: f.name, size: f.size, data_url: String(reader.result) });
  reader.readAsDataURL(f);
}

function AttachedFileCard({ label, file, onRemove }: { label: string; file: AttachedDocFile; onRemove: () => void }) {
  return (
    <div style={{
      display: 'flex', gap: 12, alignItems: 'center', padding: 10,
      borderRadius: 10, border: `1.5px solid ${G}`, background: `${G}14`,
    }}>
      {isPdfFile(file) ? (
        <div style={{
          width: 60, height: 40, borderRadius: 6, border: `1px solid ${S200}`,
          background: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '0.8rem', fontWeight: 800, color: S700, flexShrink: 0,
        }}>PDF</div>
      ) : (
        <img
          src={file.data_url}
          alt={label}
          style={{ width: 60, height: 40, objectFit: 'cover', borderRadius: 6, border: `1px solid ${S200}`, background: W, flexShrink: 0 }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0, fontSize: '0.82rem', color: S700 }}>
        <div style={{ fontWeight: 800, color: GD }}>{label} attached</div>
        {file.name && (
          <div style={{ fontSize: '0.68rem', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {file.name}{typeof file.size === 'number' ? ` · ${(file.size / 1024).toFixed(1)} KB` : ''}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        style={{
          padding: '5px 10px', borderRadius: 7, border: `1px solid #fecaca`,
          background: W, color: REDC, fontSize: '0.68rem', fontWeight: 700,
          cursor: 'pointer', flexShrink: 0,
        }}
      >Remove</button>
    </div>
  );
}

const dashedCameraButton: CSSProperties = {
  width: '100%', padding: '14px 16px', borderRadius: 10,
  border: `2px dashed ${G}`, background: `${G}10`,
  color: GD, fontSize: '0.86rem', fontWeight: 800,
  cursor: 'pointer', letterSpacing: '0.02em',
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
};

/** One document slot (e.g. the RAF OAR report): camera button → in-app camera. */
export function SingleDocumentCapture({ label, frame = 'tall', file, onChange }: {
  label: string;
  frame?: DocFrame;
  file?: AttachedDocFile | null;
  onChange: (file: { name: string; size: number; data_url: string } | null) => void;
}) {
  const [cameraOpen, setCameraOpen] = useState(false);

  if (file && file.data_url) {
    return <AttachedFileCard label={label} file={file} onRemove={() => onChange(null)} />;
  }
  return (
    <div>
      <button type="button" onClick={() => setCameraOpen(true)} style={dashedCameraButton}>
        <CameraIcon />
        Photograph {label}
      </button>
      <label style={{
        display: 'block', textAlign: 'center', marginTop: 8,
        fontSize: '0.72rem', fontWeight: 700, color: '#64748b',
        cursor: 'pointer', textDecoration: 'underline',
      }}>
        or attach a PDF file
        <input
          type="file"
          accept="application/pdf,.pdf"
          onChange={e => { const f = e.target.files?.[0]; if (f) readPdfFile(f, onChange); e.target.value = ''; }}
          style={{ display: 'none' }}
        />
      </label>
      {cameraOpen && (
        <CameraOverlay
          title={label}
          frame={frame}
          onCancel={() => setCameraOpen(false)}
          onCapture={dataUrl => {
            onChange({ name: `${label}.jpg`, size: dataUrlBytes(dataUrl), data_url: dataUrl });
            setCameraOpen(false);
          }}
        />
      )}
    </div>
  );
}

/** A named set of document slots (the WCA / employee documents): one camera
 *  button → selection sheet → in-app camera, exactly like Patient Documents. */
export function DocumentSetCapture({ buttonLabel, docs, values, onChange }: {
  buttonLabel: string;
  docs: DocSpec[];
  values: Record<string, any>;
  onChange: (key: string, file: { name: string; size: number; data_url: string } | null) => void;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [active, setActive] = useState<DocSpec | null>(null);

  const attached = docs.filter(d => values[d.key] && values[d.key].data_url);

  return (
    <div style={{ marginTop: 8 }}>
      {attached.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {attached.map(d => (
            <AttachedFileCard key={d.key} label={d.label} file={values[d.key]} onRemove={() => onChange(d.key, null)} />
          ))}
        </div>
      )}

      <button type="button" onClick={() => setShowMenu(true)} style={dashedCameraButton}>
        <CameraIcon />
        {buttonLabel}
      </button>

      {showMenu && !active && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}>
          <div style={{
            background: W, width: '100%', borderTopLeftRadius: 20, borderTopRightRadius: 20,
            padding: '24px 20px', boxShadow: '0 -4px 20px rgba(0,0,0,0.1)',
            display: 'flex', flexDirection: 'column', gap: 12,
            animation: 'slideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: '1rem', fontWeight: 900, color: S700 }}>Select Document to Photograph</div>
              <button
                type="button"
                onClick={() => setShowMenu(false)}
                style={{ background: 'transparent', border: 'none', fontSize: '1.4rem', color: '#94a3b8', cursor: 'pointer', padding: '0 8px' }}
              >×</button>
            </div>
            {docs.map(d => {
              const isCaptured = !!(values[d.key] && values[d.key].data_url);
              return (
                <div key={d.key} style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => { setActive(d); setShowMenu(false); }}
                    style={{
                      flex: 1, minWidth: 0, padding: '16px', borderRadius: 12, fontSize: '0.9rem', fontWeight: 700,
                      border: `1.5px solid ${isCaptured ? G : S200}`,
                      background: isCaptured ? `${G}10` : '#f8fafc',
                      color: isCaptured ? GD : S700,
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      cursor: 'pointer',
                    }}
                  >
                    <span>Photograph {d.label}</span>
                    {isCaptured && <span style={{ fontSize: '1.1rem' }}>✓</span>}
                  </button>
                  {/* The paper-free path: payslips / medical reports often
                      arrive as PDFs, so each row keeps a file picker. */}
                  <label style={{
                    flexShrink: 0, padding: '16px 14px', borderRadius: 12,
                    border: `1.5px solid ${S200}`, background: '#f8fafc',
                    color: '#2563eb', fontSize: '0.78rem', fontWeight: 800,
                    display: 'flex', alignItems: 'center', cursor: 'pointer',
                  }}>
                    PDF
                    <input
                      type="file"
                      accept="application/pdf,.pdf"
                      onChange={e => {
                        const f = e.target.files?.[0];
                        if (f) readPdfFile(f, file => onChange(d.key, file));
                        e.target.value = '';
                      }}
                      style={{ display: 'none' }}
                    />
                  </label>
                </div>
              );
            })}
            <style>{`
              @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
            `}</style>
          </div>
        </div>
      )}

      {active && (
        <CameraOverlay
          title={active.label}
          frame={active.frame ?? 'tall'}
          onCancel={() => { setActive(null); setShowMenu(true); }}
          onCapture={dataUrl => {
            onChange(active.key, { name: `${active.label}.jpg`, size: dataUrlBytes(dataUrl), data_url: dataUrl });
            setActive(null);
            setShowMenu(true);
          }}
        />
      )}
    </div>
  );
}
