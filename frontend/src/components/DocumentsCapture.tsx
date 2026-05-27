/**
 * DocumentsCapture — Multi-photo capture for additional handover documents
 * (ID copies, referral letters, scheme cards, etc).
 *
 * UX: tap "Add Documents" → fullscreen in-app camera opens. The crew can
 * snap as many shots as they like; each capture lands as a thumbnail in
 * the strip along the bottom of the camera view, with the live video
 * staying active so they can immediately frame the next shot. Tapping a
 * thumbnail's × removes that capture. When done, tapping "Add (N)"
 * commits the whole batch to form_data and closes the camera. Cancel
 * discards the in-flight session.
 *
 * Each photo is downsized to a 1600px long-edge JPEG at quality 0.85
 * before being committed — keeps the PRF payload sane (~250KB/photo)
 * while leaving the scheme reviewer enough detail to read the document.
 *
 * Camera permission is requested when the overlay opens. If denied or
 * unavailable (desktop without webcam, browser without getUserMedia),
 * the overlay falls back to a hidden file input that lets the crew pick
 * one or more images from disk / OS camera — same data shape, same
 * commit path.
 *
 * Storage shape on form_data: an array of { data_url, captured_at, size? }.
 */
import { useEffect, useRef, useState, useCallback } from 'react';

export interface CapturedDocument {
  data_url: string;
  captured_at: string;
  size?: number;
}

interface Props {
  value?: CapturedDocument[];
  onChange: (docs: CapturedDocument[]) => void;
  buttonLabel?: string;
}

const G    = '#10b981';
const GD   = '#059669';
const S700 = '#334155';
const S200 = '#e2e8f0';
const W    = '#ffffff';

// Cap each captured image at a 1600px long edge — keeps the PRF payload
// well under a few MB even with a half-dozen documents attached.
const MAX_DIM       = 1600;
const JPEG_QUALITY  = 0.85;
const MAX_FILE_SIZE = 12 * 1024 * 1024;

function downsizeDataUrl(srcDataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width  * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Canvas unavailable.'));
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
    };
    img.onerror = () => reject(new Error('Failed to decode image.'));
    img.src = srcDataUrl;
  });
}

async function compressFile(file: File): Promise<string> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`"${file.name}" exceeds 12 MB.`);
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
  return downsizeDataUrl(dataUrl);
}

export default function DocumentsCapture({ value, onChange, buttonLabel }: Props) {
  const docs = Array.isArray(value) ? value : [];
  const [open, setOpen] = useState(false);
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);

  const commit = (newDataUrls: string[]) => {
    const stamp = new Date().toISOString();
    const next = newDataUrls.map(u => ({ data_url: u, captured_at: stamp }));
    onChange([...docs, ...next]);
  };

  const remove = (i: number) => {
    const next = [...docs];
    next.splice(i, 1);
    onChange(next);
    if (previewIdx === i) setPreviewIdx(null);
    else if (previewIdx !== null && i < previewIdx) setPreviewIdx(previewIdx - 1);
  };

  return (
    <div>
      {docs.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
          gap: 10,
          marginBottom: 14,
        }}>
          {docs.map((d, i) => (
            <div
              key={i}
              onClick={() => setPreviewIdx(i)}
              style={{
                position: 'relative',
                aspectRatio: '3 / 4',
                borderRadius: 10,
                overflow: 'hidden',
                border: `1.5px solid ${S200}`,
                background: '#f8fafc',
                cursor: 'pointer',
              }}
            >
              <img
                src={d.data_url}
                alt={`Document ${i + 1}`}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); remove(i); }}
                aria-label="Remove document"
                style={{
                  position: 'absolute', top: 4, right: 4,
                  width: 26, height: 26, borderRadius: 999,
                  border: 'none', background: 'rgba(0,0,0,0.65)', color: '#fff',
                  fontSize: '1rem', fontWeight: 800, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  lineHeight: 1, padding: 0,
                }}
              >×</button>
              <div style={{
                position: 'absolute', left: 0, right: 0, bottom: 0,
                background: 'linear-gradient(rgba(0,0,0,0), rgba(0,0,0,0.6))',
                color: '#fff', fontSize: '0.65rem', fontWeight: 700,
                padding: '8px 6px 4px', textAlign: 'center',
                letterSpacing: '0.04em',
              }}>#{i + 1}</div>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          width: '100%', padding: '14px 16px', borderRadius: 10,
          border: `2px dashed ${G}`, background: `${G}10`,
          color: GD, fontSize: '0.86rem', fontWeight: 800,
          cursor: 'pointer', letterSpacing: '0.02em',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        }}
      >
        <CameraIcon />
        {buttonLabel || (docs.length ? 'Add More Documents' : 'Add Documents')}
      </button>

      {open && (
        <MultiCaptureOverlay
          onCancel={() => setOpen(false)}
          onDone={(urls) => { commit(urls); setOpen(false); }}
        />
      )}

      {previewIdx !== null && docs[previewIdx] && (
        <div
          onClick={() => setPreviewIdx(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            background: 'rgba(0,0,0,0.92)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: 20,
          }}
        >
          <img
            src={docs[previewIdx].data_url}
            alt={`Document ${previewIdx + 1}`}
            style={{
              maxWidth: '100%', maxHeight: '85vh', objectFit: 'contain',
              borderRadius: 8, background: '#fff',
            }}
          />
          <button
            type="button"
            onClick={() => setPreviewIdx(null)}
            style={{
              marginTop: 14, padding: '10px 22px', borderRadius: 8,
              background: W, color: S700, fontWeight: 800,
              fontSize: '0.86rem', border: 'none', cursor: 'pointer',
              letterSpacing: '0.04em', textTransform: 'uppercase',
            }}
          >Close</button>
        </div>
      )}
    </div>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────────

function CameraIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
      <circle cx="12" cy="13" r="4"/>
    </svg>
  );
}

function FlashIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"
         stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round" aria-hidden>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  );
}

// ── Multi-capture fullscreen overlay ────────────────────────────────────────
// Live camera preview that stays running across captures. Snapped frames go
// into an in-memory strip at the bottom of the view; nothing is committed
// to the parent until the crew taps "Add (N)".

interface OverlayProps {
  onCancel: () => void;
  onDone: (dataUrls: string[]) => void;
}

function MultiCaptureOverlay({ onCancel, onDone }: OverlayProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputId = 'documents-camera-fallback-input';

  const [stream,   setStream]   = useState<MediaStream | null>(null);
  const [error,    setError]    = useState<string | null>(null);
  const [photos,   setPhotos]   = useState<string[]>([]);
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
        const msg = e?.name === 'NotAllowedError'
          ? 'Camera permission denied. Use the upload fallback below.'
          : 'Could not start the camera. Use the upload fallback below.';
        setError(msg);
      }
    })();
    return () => {
      active = false;
      if (s) s.getTracks().forEach(t => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      torchTurnedOnAtRef.current = next ? Date.now() : 0;
    } catch {
      /* some devices reject silently */
    }
  };

  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    setBusy(true);

    // Allow the torch hardware to warm up if it was just toggled on, so the
    // still doesn't land before the LED reaches full brightness.
    const TORCH_WARMUP_MS = 600;
    if (torchOn && torchTurnedOnAtRef.current) {
      const elapsed = Date.now() - torchTurnedOnAtRef.current;
      if (elapsed < TORCH_WARMUP_MS) {
        await new Promise(r => setTimeout(r, TORCH_WARMUP_MS - elapsed));
      }
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    let bitmap: ImageBitmap | HTMLVideoElement = video;
    let bw = vw, bh = vh;

    // Prefer ImageCapture for the full-sensor still (much sharper than the
    // live preview frame). Skip when torch is on — Chrome drops the flash
    // during the takePhoto reconfiguration.
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
      } catch {
        /* fall through to video sample */
      }
    }

    // Draw at the source resolution, then downsize.
    const fullCanvas = document.createElement('canvas');
    fullCanvas.width  = bw;
    fullCanvas.height = bh;
    const fctx = fullCanvas.getContext('2d');
    if (!fctx) { setBusy(false); return; }
    fctx.drawImage(bitmap, 0, 0, bw, bh);
    const raw = fullCanvas.toDataURL('image/jpeg', 0.95);

    try {
      const sized = await downsizeDataUrl(raw);
      setPhotos(prev => [...prev, sized]);
    } catch (e: any) {
      setError(e?.message || 'Capture failed.');
    } finally {
      setBusy(false);
    }
  }, [stream, torchOn]);

  const removePhoto = (i: number) => {
    setPhotos(prev => {
      const next = [...prev];
      next.splice(i, 1);
      return next;
    });
  };

  const onPickFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setBusy(true);
    try {
      const added: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!f.type.startsWith('image/')) continue;
        added.push(await compressFile(f));
      }
      if (added.length) setPhotos(prev => [...prev, ...added]);
    } catch (e: any) {
      setError(e?.message || 'Failed to read files.');
    } finally {
      setBusy(false);
    }
  };

  const done = () => {
    if (!photos.length) { onCancel(); return; }
    onDone(photos);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000, background: '#000',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Top bar */}
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
          style={{
            background: 'transparent', border: 'none', color: '#fff',
            fontSize: '0.92rem', fontWeight: 700, cursor: 'pointer', padding: '6px 4px',
          }}
        >Cancel</button>
        <div style={{ fontSize: '0.78rem', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          Additional Documents{photos.length ? ` · ${photos.length}` : ''}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {torchSupported && (
            <button
              type="button"
              onClick={toggleTorch}
              aria-label={torchOn ? 'Turn flash off' : 'Turn flash on'}
              aria-pressed={torchOn}
              style={{
                width: 38, height: 38, borderRadius: 999,
                border: torchOn ? '2px solid #facc15' : '1.5px solid rgba(255,255,255,0.4)',
                background: torchOn ? '#facc15' : 'transparent',
                color: torchOn ? '#0f172a' : '#fff',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <FlashIcon />
            </button>
          )}
          <button
            type="button"
            onClick={done}
            disabled={!photos.length}
            style={{
              background: photos.length ? G : '#475569', border: 'none', color: '#fff',
              fontSize: '0.86rem', fontWeight: 800, cursor: photos.length ? 'pointer' : 'not-allowed',
              padding: '8px 14px', borderRadius: 8,
            }}
          >Add{photos.length ? ` (${photos.length})` : ''}</button>
        </div>
      </div>

      {/* Stage: live video */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#000' }}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{
            position: 'absolute', inset: 0,
            width: '100%', height: '100%',
            objectFit: 'cover', background: '#000',
          }}
        />

        {error && (
          <div style={{
            position: 'absolute', left: 16, right: 16, top: 16,
            background: 'rgba(220,38,38,0.95)', color: '#fff',
            padding: '10px 14px', borderRadius: 10,
            fontSize: '0.82rem', fontWeight: 700, lineHeight: 1.4,
          }}>{error}</div>
        )}
      </div>

      {/* Bottom strip — captured thumbnails + capture button */}
      <div style={{
        flexShrink: 0,
        background: 'rgba(15,23,42,0.95)',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
        {/* Captured thumbnails */}
        {photos.length > 0 && (
          <div style={{
            display: 'flex', gap: 8,
            overflowX: 'auto', overflowY: 'hidden',
            padding: '10px 14px',
            scrollbarWidth: 'thin',
          }}>
            {photos.map((p, i) => (
              <div
                key={i}
                style={{
                  position: 'relative',
                  width: 64, height: 80,
                  flexShrink: 0,
                  borderRadius: 6,
                  overflow: 'hidden',
                  border: '1.5px solid rgba(255,255,255,0.4)',
                  background: '#000',
                }}
              >
                <img
                  src={p}
                  alt={`Capture ${i + 1}`}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
                <button
                  type="button"
                  onClick={() => removePhoto(i)}
                  aria-label={`Remove capture ${i + 1}`}
                  style={{
                    position: 'absolute', top: 2, right: 2,
                    width: 20, height: 20, borderRadius: 999,
                    border: 'none', background: 'rgba(0,0,0,0.75)', color: '#fff',
                    fontSize: '0.78rem', fontWeight: 800, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    lineHeight: 1, padding: 0,
                  }}
                >×</button>
              </div>
            ))}
          </div>
        )}

        {/* Capture button */}
        <div style={{
          padding: '8px 16px 14px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
        }}>
          {stream ? (
            <button
              type="button"
              onClick={capture}
              disabled={busy}
              aria-label="Capture"
              style={{
                width: 76, height: 76, borderRadius: 999,
                border: '4px solid #fff', background: '#fff',
                boxShadow: '0 0 0 4px rgba(255,255,255,0.25)',
                cursor: busy ? 'wait' : 'pointer',
                opacity: busy ? 0.7 : 1,
                transition: 'opacity 0.1s',
              }}
            />
          ) : (
            <label
              htmlFor={fileInputId}
              style={{
                padding: '12px 22px', borderRadius: 10, fontSize: '0.84rem', fontWeight: 800,
                background: G, color: '#fff', cursor: 'pointer', letterSpacing: '0.02em',
              }}
            >
              Use Camera / Pick Images
              <input
                id={fileInputId}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                onChange={e => onPickFiles(e.target.files)}
                style={{ display: 'none' }}
              />
            </label>
          )}
        </div>
      </div>
    </div>
  );
}
