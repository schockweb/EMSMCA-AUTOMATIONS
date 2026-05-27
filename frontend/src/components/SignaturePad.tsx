/**
 * SignaturePad — Touch-to-sign canvas component.
 * Works on mobile touch screens. Outputs base64 PNG.
 */
import { useRef, useEffect, useState, useCallback } from 'react';

interface SignaturePadProps {
  label: string;
  value?: string | null;   // base64 PNG
  onChange: (base64: string | null) => void;
  height?: number;
}

export default function SignaturePad({ label, value, onChange, height = 140 }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasContent, setHasContent] = useState(false);

  const getCtx = () => canvasRef.current?.getContext('2d');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Set canvas resolution
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(2, 2);
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }
    // Restore existing signature
    if (value) {
      const img = new Image();
      img.onload = () => {
        ctx?.drawImage(img, 0, 0, rect.width, rect.height);
        setHasContent(true);
      };
      img.src = value;
    }
  }, []);

  const getPos = (e: React.TouchEvent | React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    if ('touches' in e) {
      return {
        x: e.touches[0].clientX - rect.left,
        y: e.touches[0].clientY - rect.top,
      };
    }
    return {
      x: (e as React.MouseEvent).clientX - rect.left,
      y: (e as React.MouseEvent).clientY - rect.top,
    };
  };

  const startDraw = (e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    const ctx = getCtx();
    if (!ctx) return;
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    setIsDrawing(true);
  };

  const draw = (e: React.TouchEvent | React.MouseEvent) => {
    if (!isDrawing) return;
    e.preventDefault();
    const ctx = getCtx();
    if (!ctx) return;
    const pos = getPos(e);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    setHasContent(true);
  };

  const endDraw = useCallback(() => {
    setIsDrawing(false);
    const canvas = canvasRef.current;
    if (canvas && hasContent) {
      onChange(canvas.toDataURL('image/png'));
    }
  }, [hasContent, onChange]);

  const clear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const rect = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
    }
    setHasContent(false);
    onChange(null);
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <label style={{
          fontSize: '0.72rem', fontWeight: 700,
          color: '#475569',
          textTransform: 'uppercase', letterSpacing: '0.08em',
        }}>
          {label}
        </label>
        {hasContent && (
          <button type="button" onClick={clear} style={{
            background: '#fff', color: '#b91c1c',
            border: '1px solid #fecaca', borderRadius: 6,
            padding: '3px 10px', fontSize: '0.68rem', fontWeight: 700, cursor: 'pointer',
          }}>
            Clear
          </button>
        )}
      </div>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height,
          borderRadius: 10,
          border: '1.5px solid #cbd5e1',
          background: '#f8fafc',
          touchAction: 'none',
          cursor: 'crosshair',
          display: 'block',
        }}
        onMouseDown={startDraw}
        onMouseMove={draw}
        onMouseUp={endDraw}
        onMouseLeave={endDraw}
        onTouchStart={startDraw}
        onTouchMove={draw}
        onTouchEnd={endDraw}
      />
      {!hasContent && (
        <div style={{ textAlign: 'center', fontSize: '0.7rem', color: '#94a3b8', marginTop: 4 }}>
          Sign here with your finger
        </div>
      )}
    </div>
  );
}
