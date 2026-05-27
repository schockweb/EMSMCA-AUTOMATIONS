/**
 * FullscreenSignaturePad — Pencil-icon trigger that opens a fullscreen
 * signature canvas. Used where the small inline pad gives crew too little
 * room for an accurate signature (e.g. handover on mobile).
 */
import { useRef, useEffect, useState, useCallback } from 'react';

interface Props {
  label: string;
  value?: string | null;
  onChange: (base64: string | null) => void;
  /** Render as a small inline pen-icon trigger only (no label, no preview).
   *  Used when the trigger sits next to another input field. */
  compact?: boolean;
}

export default function FullscreenSignaturePad({ label, value, onChange, compact }: Props) {
  const [open, setOpen] = useState(false);

  // Dismiss any active soft keyboard before mounting the fullscreen overlay.
  // Without this, an input that had focus immediately before (e.g. the
  // "Receiving Name" field next to the compact handover pad) keeps the iOS
  // keyboard up. 100dvh then shrinks to exclude the keyboard, the overlay's
  // header gets pushed off-screen at the top, and the user can't reach
  // Save. Blurring first lets dvh expand back to full height.
  const openCanvas = () => {
    const active = document.activeElement as HTMLElement | null;
    if (active && typeof active.blur === 'function') active.blur();
    setOpen(true);
  };

  if (compact) {
    return (
      <>
        <button
          type="button"
          onClick={openCanvas}
          aria-label={value ? `Edit ${label}` : `Add ${label}`}
          title={label}
          style={{
            width: 42, height: 42, borderRadius: 10,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: value ? 'rgba(16,185,129,0.09)' : '#f8fafc',
            border: `1.5px solid ${value ? '#10b981' : '#cbd5e1'}`,
            color: value ? '#059669' : '#475569',
            cursor: 'pointer',
            transition: 'all 0.15s',
            flexShrink: 0,
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9"/>
            <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
          </svg>
        </button>
        {open && (
          <FullscreenCanvas
            label={label}
            initial={value || null}
            onCancel={() => setOpen(false)}
            onSave={(b64) => { onChange(b64); setOpen(false); }}
          />
        )}
      </>
    );
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{
        display: 'block',
        fontSize: '0.72rem', fontWeight: 700,
        color: '#475569',
        textTransform: 'uppercase', letterSpacing: '0.08em',
        marginBottom: 8,
      }}>
        {label}
      </label>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          onClick={openCanvas}
          aria-label={value ? `Edit ${label}` : `Add ${label}`}
          style={{
            width: 56, height: 56, borderRadius: 14,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: value ? 'rgba(16,185,129,0.09)' : '#f8fafc',
            border: `1.5px solid ${value ? '#10b981' : '#cbd5e1'}`,
            color: value ? '#059669' : '#475569',
            cursor: 'pointer',
            transition: 'all 0.15s',
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9"/>
            <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
          </svg>
        </button>

        {value ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
            <img
              src={value}
              alt={label}
              style={{
                height: 56, maxWidth: 180,
                borderRadius: 10, border: '1.5px solid #e2e8f0',
                background: '#fff', objectFit: 'contain',
              }}
            />
            <button
              type="button"
              onClick={() => onChange(null)}
              style={{
                background: '#fff', color: '#b91c1c',
                border: '1px solid #fecaca', borderRadius: 6,
                padding: '4px 10px', fontSize: '0.68rem', fontWeight: 700, cursor: 'pointer',
              }}
            >
              Clear
            </button>
          </div>
        ) : (
          <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>
            Tap pencil to sign
          </span>
        )}
      </div>

      {open && (
        <FullscreenCanvas
          label={label}
          initial={value || null}
          onCancel={() => setOpen(false)}
          onSave={(b64) => { onChange(b64); setOpen(false); }}
        />
      )}
    </div>
  );
}

interface CanvasProps {
  label: string;
  initial: string | null;
  onCancel: () => void;
  onSave: (b64: string) => void;
}

export function FullscreenCanvas({ label, initial, onCancel, onSave }: CanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drawingRef = useRef(false);
  const [hasContent, setHasContent] = useState(!!initial);

  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(2, 2);
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (initial) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = initial;
    }
  }, [initial]);

  useEffect(() => {
    setupCanvas();
    // Re-setup on the next frame too — the soft keyboard sometimes finishes
    // dismissing a tick after mount, which grows the dvh and changes the
    // canvas wrap dimensions. Without this re-setup the drawing surface
    // stays at the smaller pre-dismissal size and strokes land in the wrong
    // place. visualViewport's resize event covers iOS keyboard show/hide.
    const raf = requestAnimationFrame(setupCanvas);
    const onResize = () => setupCanvas();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, [setupCanvas]);

  const getPos = (e: React.TouchEvent | React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    if ('touches' in e) {
      return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
    }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const startDraw = (e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = getPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    drawingRef.current = true;
  };

  const draw = (e: React.TouchEvent | React.MouseEvent) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = getPos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    setHasContent(true);
  };

  const endDraw = () => { drawingRef.current = false; };

  const clear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    setHasContent(false);
  };

  const save = () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasContent) return;
    onSave(canvas.toDataURL('image/png'));
  };

  return (
    <div style={{
      // Anchor all four edges so the overlay can never be clipped if the
      // dynamic viewport unit reports an odd value mid-keyboard-dismiss.
      // height stays for browsers that don't honour `inset: 0` correctly
      // on fixed positioning. overflowX hidden is a final safety net —
      // children should be sized to fit, but if a long label or wide
      // canvas slips through, the page itself can never bleed sideways.
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      height: '100dvh',
      zIndex: 9999,
      background: '#0f172a',
      display: 'flex', flexDirection: 'column',
      touchAction: 'none',
      overflowX: 'hidden',
      boxSizing: 'border-box',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '14px 18px',
        paddingTop: 'calc(14px + env(safe-area-inset-top))',
        paddingLeft: 'calc(18px + env(safe-area-inset-left))',
        paddingRight: 'calc(18px + env(safe-area-inset-right))',
        background: 'rgba(15,23,42,0.92)',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        color: '#fff',
        flexShrink: 0,
        boxSizing: 'border-box',
      }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            background: 'transparent', border: 'none',
            color: '#fff', fontSize: '0.92rem', fontWeight: 700,
            cursor: 'pointer', padding: '6px 4px',
            flexShrink: 0,
          }}
        >
          Cancel
        </button>
        {/* Label takes the remaining space and truncates with ellipsis if
            it's too long for the viewport — without minWidth:0 + nowrap +
            overflow, a long label (e.g. the crew-pick "John Smith — sign
            to confirm administering this Medication") pushes the Save
            button past the right edge of the screen. */}
        <div style={{
          flex: 1, minWidth: 0, textAlign: 'center',
          fontSize: '0.82rem', fontWeight: 800,
          letterSpacing: '0.04em', textTransform: 'uppercase',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {label}
        </div>
        <button
          type="button"
          onClick={save}
          disabled={!hasContent}
          style={{
            background: hasContent ? '#10b981' : '#475569',
            border: 'none',
            color: '#fff', fontSize: '0.92rem', fontWeight: 800,
            cursor: hasContent ? 'pointer' : 'not-allowed',
            padding: '8px 16px', borderRadius: 8,
            flexShrink: 0,
          }}
        >
          Save
        </button>
      </div>

      <div ref={wrapRef} style={{ flex: 1, position: 'relative', background: '#fff', margin: 12, borderRadius: 12, overflow: 'hidden' }}>
        <canvas
          ref={canvasRef}
          style={{ display: 'block', width: '100%', height: '100%', cursor: 'crosshair' }}
          onMouseDown={startDraw}
          onMouseMove={draw}
          onMouseUp={endDraw}
          onMouseLeave={endDraw}
          onTouchStart={startDraw}
          onTouchMove={draw}
          onTouchEnd={endDraw}
        />
        {!hasContent && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '0.95rem', color: '#94a3b8',
            pointerEvents: 'none',
          }}>
            Sign anywhere in this box
          </div>
        )}
      </div>

      <div style={{
        display: 'flex', justifyContent: 'center',
        padding: '10px 18px 16px',
        paddingBottom: 'calc(16px + env(safe-area-inset-bottom))',
        flexShrink: 0,
      }}>
        <button
          type="button"
          onClick={clear}
          disabled={!hasContent}
          style={{
            background: 'transparent',
            border: '1.5px solid rgba(255,255,255,0.25)',
            color: hasContent ? '#fff' : '#64748b',
            fontSize: '0.82rem', fontWeight: 700,
            padding: '8px 18px', borderRadius: 8,
            cursor: hasContent ? 'pointer' : 'not-allowed',
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
