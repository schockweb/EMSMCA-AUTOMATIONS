/**
 * StickerCameraCapture — Fullscreen camera view with a centred clear
 * "viewfinder" rectangle and shaded surrounding overlay, used by the crew
 * to photograph a hospital patient-identifier sticker at handover.
 *
 * Flow:
 *   • Tap the camera button → component mounts, requests rear camera
 *   • Live MediaStream renders behind a shaded mask with a transparent
 *     central rectangle sized to a typical SA hospital label
 *     (~70 × 35mm, ~2:1 aspect ratio)
 *   • Tap "Capture" → grabs a frame, crops to the viewfinder area, calls
 *     onCapture(dataUrl) and closes
 *   • The data URL is stored on form_data.hospital_sticker, which the
 *     hard-copy PRF view already renders in the Hospital Sticker section
 *
 * Camera permission is requested on open. If denied or unavailable (e.g.
 * desktop without webcam), the component falls back to a hidden file
 * input (`capture="environment"`) so the same UX still works.
 */
import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Existing sticker (if any) — shown as preview with a "retake" option. */
  value?: string | null;
  /** Called with a base64 JPEG data URL of the cropped sticker, or null to clear. */
  onChange: (dataUrl: string | null) => void;
  /** Optional label override for the trigger button. */
  buttonLabel?: string;
}

const G  = '#10b981';
const GD = '#059669';
const S700 = '#334155';
const S200 = '#e2e8f0';
const W    = '#ffffff';
const REDC = '#ef4444';

export default function StickerCameraCapture({ value, onChange, buttonLabel }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ marginTop: 8 }}>
      {/* Preview card: existing capture (if any) + open / clear actions */}
      {value ? (
        <div style={{
          display: 'flex', gap: 12, alignItems: 'flex-start', padding: 12,
          borderRadius: 10, border: `1.5px solid ${G}`, background: `${G}14`,
        }}>
          <img
            src={value}
            alt="hospital sticker"
            style={{
              maxWidth: 200, maxHeight: 130, objectFit: 'contain',
              borderRadius: 6, border: `1px solid ${S200}`, background: W,
            }}
          />
          <div style={{ flex: 1, fontSize: '0.82rem', color: S700 }}>
            <div style={{ fontWeight: 800, color: GD, marginBottom: 8 }}>Sticker captured</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => setOpen(true)}
                style={{
                  padding: '7px 12px', borderRadius: 7, border: `1px solid ${S200}`,
                  background: W, color: S700, fontSize: '0.74rem', fontWeight: 700,
                  cursor: 'pointer',
                }}
              >Retake</button>
              <button
                type="button"
                onClick={() => onChange(null)}
                style={{
                  padding: '7px 12px', borderRadius: 7, border: `1px solid #fecaca`,
                  background: W, color: REDC, fontSize: '0.74rem', fontWeight: 700,
                  cursor: 'pointer',
                }}
              >Remove</button>
            </div>
          </div>
        </div>
      ) : (
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
          {buttonLabel || 'Photograph Hospital Sticker'}
        </button>
      )}

      {open && (
        <CameraOverlay
          onCancel={() => setOpen(false)}
          onCapture={(dataUrl) => { onChange(dataUrl); setOpen(false); }}
        />
      )}
    </div>
  );
}

// ── Icon ────────────────────────────────────────────────────────────────────

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

// ── Fullscreen overlay with viewfinder cutout ──────────────────────────────

interface OverlayProps {
  onCancel: () => void;
  onCapture: (dataUrl: string) => void;
}

function CameraOverlay({ onCancel, onCapture }: OverlayProps) {
  const videoRef    = useRef<HTMLVideoElement>(null);
  const fileInputId = 'sticker-camera-fallback-input';
  const [stream,   setStream]   = useState<MediaStream | null>(null);
  const [error,    setError]    = useState<string | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);
  const [busy,     setBusy]     = useState(false);
  const [torchOn,  setTorchOn]  = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);

  // Request the rear camera at the highest reasonable resolution. The
  // default getUserMedia stream is preview-quality (often ~640×480) so
  // the captured crop ends up soft and visibly upscaled. We ask for up to
  // 1080p ideal — the browser picks the closest the camera can deliver.
  // Torch capability is detected after the track is live; not all devices
  // / browsers support it (iOS Safari does not).
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
          await videoRef.current.play().catch(() => { /* autoplay quirks — user can tap to play */ });
        }
        // Detect torch / flash capability on the track.
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

  // Toggle the camera torch (Android Chrome only — see effect above).
  // After applyConstraints resolves, the LED still takes ~200-500ms to be
  // fully on. If the crew taps Capture immediately, the still can land
  // before the LED is bright. We track the moment of the most recent
  // torch-on so capture() can wait out any remaining warm-up.
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
    } catch {
      // Some devices reject torch toggles silently — surface nothing rather
      // than a confusing error; the button just stops responding.
    }
  };

  // Capture a frame and crop to the viewfinder rect. Crop math:
  //   - The video is rendered with `object-fit: cover`, so part of the
  //     stream is cropped off the top/bottom (or sides) by CSS to fill
  //     the screen. We have to mirror that crop in the source rect, or
  //     the captured image will be off-centre and stretched.
  //   - The viewfinder rect is defined in screen-space (84% of width,
  //     half as tall, centred). We project that rectangle from screen
  //     coordinates BACK into video-frame coordinates, accounting for
  //     the cover scaling.
  // ImageCapture.takePhoto() is preferred when available (Chrome on
  // Android) because it returns a still at the camera's full sensor
  // resolution rather than the live preview resolution — much sharper.
  const capture = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    setBusy(true);

    // If the torch was just turned on, wait for the LED to be fully bright.
    // applyConstraints resolves before the hardware finishes warming up the
    // flash module — taking the still immediately can land a frame from the
    // pre-flash period and the photo looks unlit. 600ms covers most Android
    // devices; the wait only happens on the first capture after torch-on.
    const TORCH_WARMUP_MS = 600;
    if (torchOn && torchTurnedOnAtRef.current) {
      const elapsed = Date.now() - torchTurnedOnAtRef.current;
      if (elapsed < TORCH_WARMUP_MS) {
        await new Promise(r => setTimeout(r, TORCH_WARMUP_MS - elapsed));
      }
    }

    const vw = video.videoWidth;     // intrinsic stream resolution
    const vh = video.videoHeight;
    const dispW = video.clientWidth; // on-screen render box
    const dispH = video.clientHeight;

    // object-fit:cover scale — the larger of the two ratios fills the box
    const scaleCover = Math.max(dispW / vw, dispH / vh);
    const renderedW  = vw * scaleCover;
    const renderedH  = vh * scaleCover;
    const offsetX    = (renderedW - dispW) / 2; // px of stream cropped off each side
    const offsetY    = (renderedH - dispH) / 2;

    // Viewfinder rectangle in screen-space (matches the SVG mask: x=8% y=29% w=84% h=42%)
    const rectScreenX = dispW * 0.08;
    const rectScreenY = dispH * 0.29;
    const rectScreenW = dispW * 0.84;
    const rectScreenH = dispH * 0.42;

    // Project to source-pixel coordinates (undo cover scaling + offset)
    const srcX = (rectScreenX + offsetX) / scaleCover;
    const srcY = (rectScreenY + offsetY) / scaleCover;
    const srcW =  rectScreenW / scaleCover;
    const srcH =  rectScreenH / scaleCover;

    // Try ImageCapture for a sharper full-resolution still. Falls back to
    // grabbing from <video> if not supported (iOS Safari, older browsers).
    // SKIP it when the torch is on: takePhoto() reconfigures the camera for
    // the still capture and Chrome drops the torch state during that
    // reconfiguration, so the photo lands without the flash. Grabbing from
    // the live <video> element keeps the torch lit.
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
      } catch {
        // Some devices (incl. some Pixel models) reject takePhoto mid-stream;
        // fall through to the <video> sample.
      }
    }

    // If takePhoto returned a different resolution to the live preview,
    // rescale the source rect proportionally so the crop stays centred
    // on the same on-screen region.
    if (bw !== vw || bh !== vh) {
      const rx = srcX / vw, ry = srcY / vh, rw = srcW / vw, rh = srcH / vh;
      drawCrop(bitmap, bw * rx, bh * ry, bw * rw, bh * rh);
    } else {
      drawCrop(bitmap, srcX, srcY, srcW, srcH);
    }
    setBusy(false);

    function drawCrop(src: CanvasImageSource, x: number, y: number, w: number, h: number) {
      // Cap output so we don't store a 4MB base64 in form_data.
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

  // File-input fallback (no camera permission / desktop). Browser opens the
  // OS picker on desktop, the camera app on mobile due to capture="environment".
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
          Hospital Sticker
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {torchSupported && !captured && (
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

      {/* Stage: live video + viewfinder mask + (optional) captured preview
          overlay. The <video> stays mounted at all times so its srcObject
          binding survives when the user taps Retake — unmounting it on
          state change leaves the stream pointing at a detached element
          and the camera goes blank when remounted. */}
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
        {!captured && <ViewfinderMask />}
        {!captured && <ViewfinderHint />}
        {captured && (
          <img
            src={captured}
            alt="sticker preview"
            style={{
              position: 'absolute', inset: 0,
              width: '100%', height: '100%',
              objectFit: 'contain', background: '#000',
            }}
          />
        )}

        {error && (
          <div style={{
            position: 'absolute', left: 16, right: 16, top: 16,
            background: 'rgba(220,38,38,0.95)', color: '#fff',
            padding: '10px 14px', borderRadius: 10,
            fontSize: '0.82rem', fontWeight: 700, lineHeight: 1.4,
          }}>{error}</div>
        )}
      </div>

      {/* Bottom action bar */}
      <div style={{
        flexShrink: 0,
        padding: '14px 16px calc(14px + env(safe-area-inset-bottom))',
        background: 'rgba(15,23,42,0.95)', borderTop: '1px solid rgba(255,255,255,0.08)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
      }}>
        {captured ? (
          <button
            type="button"
            onClick={() => {
              setCaptured(null);
              // Defensive: if the browser paused the stream while the
              // preview was on screen, kick the video back into play.
              const v = videoRef.current;
              if (v && stream && v.srcObject !== stream) v.srcObject = stream;
              v?.play().catch(() => { /* user-gesture quirks; tap-to-play handles */ });
            }}
            style={{
              padding: '12px 24px', borderRadius: 10, fontSize: '0.86rem', fontWeight: 700,
              border: '1.5px solid rgba(255,255,255,0.4)', background: 'transparent', color: '#fff',
              cursor: 'pointer',
            }}
          >Retake</button>
        ) : stream ? (
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
            Use Camera / Pick Image
            <input
              id={fileInputId}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={e => onPickFile(e.target.files?.[0] || null)}
              style={{ display: 'none' }}
            />
          </label>
        )}
      </div>
    </div>
  );
}

// SVG mask — a black overlay with a transparent central rectangle. The
// rectangle is 84% of width and half as tall (the standard SA hospital
// label is ~70mm × 35mm so we match that 2:1 aspect).
function ViewfinderMask() {
  return (
    <svg
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
    >
      <defs>
        <mask id="sticker-mask">
          <rect x="0" y="0" width="100" height="100" fill="white" />
          <rect x="8" y="29" width="84" height="42" rx="2" fill="black" />
        </mask>
      </defs>
      <rect x="0" y="0" width="100" height="100" fill="rgba(0,0,0,0.55)" mask="url(#sticker-mask)" />
      {/* Bright frame around the cut-out */}
      <rect x="8" y="29" width="84" height="42" rx="2" fill="none"
            stroke="#10b981" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
      {/* Corner ticks for stronger visual cue */}
      {[
        ['8',  '29',  '14', '29'],   // top-left horizontal
        ['8',  '29',  '8',  '35'],   // top-left vertical
        ['86', '29',  '92', '29'],   // top-right horizontal
        ['92', '29',  '92', '35'],   // top-right vertical
        ['8',  '65',  '8',  '71'],   // bottom-left vertical
        ['8',  '71',  '14', '71'],   // bottom-left horizontal
        ['92', '65',  '92', '71'],   // bottom-right vertical
        ['86', '71',  '92', '71'],   // bottom-right horizontal
      ].map(([x1,y1,x2,y2], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke="#10b981" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
      ))}
    </svg>
  );
}

function ViewfinderHint() {
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, top: '12%',
      textAlign: 'center', pointerEvents: 'none',
    }}>
      <div style={{
        display: 'inline-block', padding: '6px 14px',
        background: 'rgba(15,23,42,0.7)', color: '#fff',
        fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.04em',
        borderRadius: 999, textTransform: 'uppercase',
      }}>Fit the sticker inside the frame</div>
    </div>
  );
}
