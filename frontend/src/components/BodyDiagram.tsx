/**
 * BodyDiagram — Interactive body chart for marking injuries on the PRF.
 *
 * The crew picks an injury symbol from the toolbar, then taps the
 * diagram to drop that symbol at the tap location. Tapping an existing
 * marker removes it. "Clear" wipes the chart.
 *
 * Renders the supplied body-diagram SVG (assets/body_diagram.svg) as a
 * background image with an SVG marker layer absolutely positioned on
 * top. Tap coordinates are normalised to the underlying SVG's 360×360
 * viewBox so marker positions are resolution-independent and survive a
 * resize / re-render.
 *
 * The diagram is collapsed by default — the header acts as a disclosure
 * trigger so the Clinical phase stays compact on phones until the crew
 * actively needs to mark injuries.
 *
 * Storage shape on form_data:
 *   Array<{ id, symbol, view, x, y }>  — x/y are coordinates in the
 *   image's viewBox.
 */
import { useState } from 'react';
import bodyDiagramUrl from '../assets/body_diagram.svg';
import headDiagramUrl from '../assets/Head diagram.svg';

export type InjurySymbol =
  | 'GSW'
  | 'Fracture'
  | 'Contusion'
  | 'Foreign Body'
  | 'Laceration'
  | 'Abrasion'
  | 'Burn';

// Single combined view — the supplied SVG is one cohesive chart. The
// 'view' field is preserved on each mark so historical PRFs that were
// saved with multi-view marks (front/back/head_*) keep their data
// intact; only marks with view === 'body' render against the new chart.
export type BodyView =
  | 'body'
  | 'head'                              // current — single head image, quadrant auto-tagged below
  | 'head_front' | 'head_left' | 'head_right' | 'head_back'
  | 'front' | 'back';                   // legacy values from earlier multi-view diagrams

export interface BodyMark {
  id: string;
  symbol: InjurySymbol;
  view: BodyView;
  x: number;
  y: number;
}

interface Props {
  value?: BodyMark[];
  onChange: (marks: BodyMark[]) => void;
}

const SYMBOLS: { id: InjurySymbol; glyph: string }[] = [
  { id: 'GSW',          glyph: '○' },
  { id: 'Fracture',     glyph: '#' },
  { id: 'Contusion',    glyph: '✻' },
  { id: 'Foreign Body', glyph: '✕' },
  { id: 'Laceration',   glyph: '/' },
  { id: 'Abrasion',     glyph: '//' },
  { id: 'Burn',         glyph: '≡' },
];

const MARK    = '#dc2626';
const CHIP_BG = '#ffffff';
const CHIP_ON = 'rgba(220,38,38,0.10)';
const S200    = '#e2e8f0';
const S600    = '#475569';

// Image viewBoxes — kept in sync with the source SVG files so click-to-
// coordinate maths stays accurate.
const VB_W = 360;
const VB_H = 360;
const HEAD_VB_W = 1092;
const HEAD_VB_H = 1433;

// The supplied head SVG includes Name/Date form fields at the very bottom
// (paths start around y=1357 in the 1433-tall viewBox) that the crew
// doesn't need on the digital PRF. Cropping at y=1320 cleanly hides those
// without clipping any head detail above. The image still renders at its
// natural aspect — we just clip the visible container so the bottom slice
// is hidden.
const HEAD_CROP_H = 1320;

// Mobile size budgets — the entire collapsible panel needs to fit roughly
// one phone viewport. Body and head each get capped so the stack
// (body + head + toolbar + header) stays around 600-700px tall.
const BODY_MAX_PX = 260;
const HEAD_MAX_W_PX = Math.round(BODY_MAX_PX * HEAD_VB_W / HEAD_CROP_H);

// The supplied head SVG arranges four views in a 2×2 grid. We auto-tag
// each tap with the quadrant so admin reviewers know which view the
// injury maps to. Layout matches the reference photo the crew shared
// when the chart was selected:
//   top-left  → FRONT
//   top-right → RIGHT side
//   bottom-left → LEFT side
//   bottom-right → BACK
const HEAD_QUADRANTS: { view: BodyView; label: string; x: number; y: number }[] = [
  { view: 'head_front', label: 'FRONT',      x: 24,                 y: 72 },
  { view: 'head_right', label: 'RIGHT SIDE', x: HEAD_VB_W - 24,     y: 72 },
  { view: 'head_left',  label: 'LEFT SIDE',  x: 24,                 y: HEAD_VB_H / 2 + 64 },
  { view: 'head_back',  label: 'BACK',       x: HEAD_VB_W - 24,     y: HEAD_VB_H / 2 + 64 },
];

function headViewForPoint(x: number, y: number): BodyView {
  const left = x < HEAD_VB_W / 2;
  const top  = y < HEAD_VB_H / 2;
  if (top && left) return 'head_front';
  if (top && !left) return 'head_right';
  if (!top && left) return 'head_left';
  return 'head_back';
}

function uid() {
  return 'm_' + Math.random().toString(36).slice(2, 9);
}

// ── Injury-symbol glyphs ───────────────────────────────────────────────────
function MarkGlyph({ symbol, cx, cy, size }: { symbol: InjurySymbol; cx: number; cy: number; size: number }) {
  const h = size / 2;
  switch (symbol) {
    case 'GSW':
      return <circle cx={cx} cy={cy} r={h} fill="none" stroke={MARK} strokeWidth={size * 0.18} />;
    case 'Fracture':
      return (
        <g stroke={MARK} strokeWidth={size * 0.16} strokeLinecap="round" fill="none">
          <line x1={cx - h} y1={cy - h * 0.35} x2={cx + h} y2={cy - h * 0.35} />
          <line x1={cx - h} y1={cy + h * 0.35} x2={cx + h} y2={cy + h * 0.35} />
          <line x1={cx - h * 0.35} y1={cy - h} x2={cx - h * 0.35} y2={cy + h} />
          <line x1={cx + h * 0.35} y1={cy - h} x2={cx + h * 0.35} y2={cy + h} />
        </g>
      );
    case 'Contusion':
      return (
        <g stroke={MARK} strokeWidth={size * 0.16} strokeLinecap="round" fill="none">
          <line x1={cx - h}        y1={cy}             x2={cx + h}        y2={cy} />
          <line x1={cx}             y1={cy - h}         x2={cx}             y2={cy + h} />
          <line x1={cx - h * 0.7}  y1={cy - h * 0.7}   x2={cx + h * 0.7}  y2={cy + h * 0.7} />
          <line x1={cx + h * 0.7}  y1={cy - h * 0.7}   x2={cx - h * 0.7}  y2={cy + h * 0.7} />
        </g>
      );
    case 'Foreign Body':
      return (
        <g stroke={MARK} strokeWidth={size * 0.2} strokeLinecap="round" fill="none">
          <line x1={cx - h} y1={cy - h} x2={cx + h} y2={cy + h} />
          <line x1={cx + h} y1={cy - h} x2={cx - h} y2={cy + h} />
        </g>
      );
    case 'Laceration':
      return (
        <line
          x1={cx + h * 0.7} y1={cy - h}
          x2={cx - h * 0.7} y2={cy + h}
          stroke={MARK} strokeWidth={size * 0.22} strokeLinecap="round"
        />
      );
    case 'Abrasion':
      return (
        <g stroke={MARK} strokeWidth={size * 0.18} strokeLinecap="round" fill="none">
          <line x1={cx + h * 0.2} y1={cy - h} x2={cx - h * 1.0} y2={cy + h * 0.6} />
          <line x1={cx + h * 1.0} y1={cy - h * 0.4} x2={cx - h * 0.2} y2={cy + h} />
        </g>
      );
    case 'Burn':
      return (
        <g stroke={MARK} strokeWidth={size * 0.18} strokeLinecap="round" fill="none">
          <line x1={cx - h} y1={cy - h * 0.6} x2={cx + h} y2={cy - h * 0.6} />
          <line x1={cx - h} y1={cy}              x2={cx + h} y2={cy} />
          <line x1={cx - h} y1={cy + h * 0.6} x2={cx + h} y2={cy + h * 0.6} />
        </g>
      );
  }
}

// ── Body chart — image with marker overlay ─────────────────────────────────
function BodyCanvas({
  marks, activeSymbol, onAdd, onRemoveMark,
}: {
  marks: BodyMark[];
  activeSymbol: InjurySymbol | null;
  onAdd: (x: number, y: number) => void;
  onRemoveMark: (id: string) => void;
}) {
  // Stage uses a 1:1 aspect ratio matching the imported SVG's viewBox.
  // Wrapper supplies the size; image fills it, marker SVG overlays on top.
  const onStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!activeSymbol) return;
    const stage = e.currentTarget;
    const rect = stage.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width)  * VB_W;
    const y = ((e.clientY - rect.top)  / rect.height) * VB_H;
    onAdd(x, y);
  };

  return (
    <div
      onClick={onStageClick}
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: BODY_MAX_PX,
        margin: '0 auto',
        aspectRatio: `${VB_W} / ${VB_H}`,
        background: '#fff',
        border: `1px solid ${S200}`,
        borderRadius: 8,
        cursor: activeSymbol ? 'crosshair' : 'default',
        touchAction: 'manipulation',
        overflow: 'hidden',
      }}
    >
      <img
        src={bodyDiagramUrl}
        alt="Body diagram"
        draggable={false}
        style={{
          position: 'absolute', inset: 0,
          width: '100%', height: '100%',
          objectFit: 'contain',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      />
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="xMidYMid meet"
        style={{
          position: 'absolute', inset: 0,
          width: '100%', height: '100%',
          pointerEvents: 'none',
        }}
      >
        {marks.map(m => {
          const size = Math.min(VB_W, VB_H) * 0.04;
          return (
            <g
              key={m.id}
              onClick={(e) => { e.stopPropagation(); onRemoveMark(m.id); }}
              style={{ cursor: 'pointer', pointerEvents: 'all' }}
            >
              <circle cx={m.x} cy={m.y} r={size * 1.4} fill="transparent" />
              <MarkGlyph symbol={m.symbol} cx={m.x} cy={m.y} size={size} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Head chart — image with quadrant labels + marker overlay ───────────────
function HeadCanvas({
  marks, activeSymbol, onAdd, onRemoveMark,
}: {
  marks: BodyMark[];
  activeSymbol: InjurySymbol | null;
  onAdd: (x: number, y: number, view: BodyView) => void;
  onRemoveMark: (id: string) => void;
}) {
  const onStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!activeSymbol) return;
    const stage = e.currentTarget;
    const rect = stage.getBoundingClientRect();
    // Inner image renders at width=rect.width and height=rect.width*(HEAD_VB_H/HEAD_VB_W),
    // anchored to the top with the bottom clipped by overflow:hidden. The
    // x/y scale factor is uniform (rect.width / HEAD_VB_W in px per unit),
    // so both axes convert with the same denominator.
    const x = ((e.clientX - rect.left) / rect.width) * HEAD_VB_W;
    const y = ((e.clientY - rect.top)  / rect.width) * HEAD_VB_W;
    if (y > HEAD_CROP_H) return;
    onAdd(x, y, headViewForPoint(x, y));
  };

  return (
    <div
      onClick={onStageClick}
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: HEAD_MAX_W_PX,
        margin: '0 auto',
        // Cropped aspect so the Name/Date footer in the source SVG is hidden.
        aspectRatio: `${HEAD_VB_W} / ${HEAD_CROP_H}`,
        background: '#fff',
        border: `1px solid ${S200}`,
        borderRadius: 8,
        cursor: activeSymbol ? 'crosshair' : 'default',
        touchAction: 'manipulation',
        overflow: 'hidden',
      }}
    >
      <img
        src={headDiagramUrl}
        alt="Head diagram"
        draggable={false}
        style={{
          // Render at natural aspect; container overflow:hidden clips bottom.
          position: 'absolute', top: 0, left: 0,
          width: '100%',
          aspectRatio: `${HEAD_VB_W} / ${HEAD_VB_H}`,
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      />
      <svg
        viewBox={`0 0 ${HEAD_VB_W} ${HEAD_VB_H}`}
        preserveAspectRatio="xMinYMin meet"
        style={{
          // Same natural aspect + top-left anchor, so marker viewBox
          // coordinates land exactly where the image renders them.
          position: 'absolute', top: 0, left: 0,
          width: '100%',
          aspectRatio: `${HEAD_VB_W} / ${HEAD_VB_H}`,
          pointerEvents: 'none',
        }}
      >
        {/* Quadrant labels */}
        {HEAD_QUADRANTS.map(q => (
          <text
            key={q.view}
            x={q.x}
            y={q.y}
            textAnchor={q.x > HEAD_VB_W / 2 ? 'end' : 'start'}
            fontSize="44"
            fontWeight="900"
            fill="#dc2626"
            stroke="#fff"
            strokeWidth="6"
            paintOrder="stroke"
            style={{ letterSpacing: '0.06em' }}
          >{q.label}</text>
        ))}

        {/* Markers */}
        {marks.map(m => {
          const size = Math.min(HEAD_VB_W, HEAD_VB_H) * 0.035;
          return (
            <g
              key={m.id}
              onClick={(e) => { e.stopPropagation(); onRemoveMark(m.id); }}
              style={{ cursor: 'pointer', pointerEvents: 'all' }}
            >
              <circle cx={m.x} cy={m.y} r={size * 1.4} fill="transparent" />
              <MarkGlyph symbol={m.symbol} cx={m.x} cy={m.y} size={size} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export default function BodyDiagram({ value, onChange }: Props) {
  const marks = Array.isArray(value) ? value : [];
  const [expanded, setExpanded] = useState(false);
  const [activeSymbol, setActiveSymbol] = useState<InjurySymbol | null>(null);

  // Body marks render against the body image. Head marks render against
  // the head image and carry the quadrant view in their `view` field.
  const bodyMarks = marks.filter(m => m.view === 'body');
  const headMarks = marks.filter(m =>
    m.view === 'head_front' || m.view === 'head_left' ||
    m.view === 'head_right' || m.view === 'head_back' || m.view === 'head'
  );

  const pickSymbol = (s: InjurySymbol) => {
    setActiveSymbol(prev => prev === s ? null : s);
    setExpanded(true);
  };

  const addBody = (x: number, y: number) => {
    if (!activeSymbol) return;
    onChange([...marks, { id: uid(), symbol: activeSymbol, view: 'body', x, y }]);
  };
  const addHead = (x: number, y: number, view: BodyView) => {
    if (!activeSymbol) return;
    onChange([...marks, { id: uid(), symbol: activeSymbol, view, x, y }]);
  };
  const removeMark = (id: string) => onChange(marks.filter(m => m.id !== id));
  const clearAll = () => onChange(
    marks.filter(m =>
      m.view !== 'body' &&
      m.view !== 'head' &&
      m.view !== 'head_front' && m.view !== 'head_left' &&
      m.view !== 'head_right' && m.view !== 'head_back'
    )
  );
  const totalVisible = bodyMarks.length + headMarks.length;

  return (
    <div style={{
      background: '#ffffff', border: `1.5px solid ${S200}`, borderRadius: 12,
      marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
      overflow: 'hidden',
    }}>
      <button
        type="button"
        onClick={() => setExpanded(o => !o)}
        aria-expanded={expanded}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', background: '#f8fafc',
          border: 'none', borderBottom: expanded ? `1px solid ${S200}` : 'none',
          cursor: 'pointer', textAlign: 'left',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <span style={{
          fontSize: '0.78rem', fontWeight: 800, color: '#0f172a',
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
          Injury Diagram
          {totalVisible > 0 && (
            <span style={{
              marginLeft: 8, padding: '2px 8px', borderRadius: 999,
              background: MARK, color: '#fff', fontSize: '0.68rem', fontWeight: 800,
              letterSpacing: '0.04em',
            }}>{totalVisible}</span>
          )}
        </span>
        <svg width="14" height="14" viewBox="0 0 12 12" aria-hidden
             style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
          <path d="M 3 4.5 L 6 7.5 L 9 4.5" stroke="#475569" strokeWidth="1.6"
                fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {expanded && (
        <div style={{ padding: 10 }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))',
            gap: 4,
            marginBottom: 8,
          }}>
            {SYMBOLS.map(s => {
              const on = activeSymbol === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => pickSymbol(s.id)}
                  aria-pressed={on}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
                    gap: 6, padding: '5px 8px', borderRadius: 6,
                    border: `1.5px solid ${on ? MARK : S200}`,
                    background: on ? CHIP_ON : CHIP_BG,
                    color: on ? MARK : '#0f172a',
                    fontSize: '0.7rem', fontWeight: 700,
                    cursor: 'pointer',
                    transition: 'all 0.12s',
                    WebkitTapHighlightColor: 'transparent',
                  }}
                >
                  <span style={{
                    width: 16, textAlign: 'center', fontSize: '0.88rem', fontWeight: 800,
                    fontFamily: 'ui-monospace, "SF Mono", monospace', color: MARK,
                  }}>{s.glyph}</span>
                  {s.id}
                </button>
              );
            })}
          </div>

          <div style={{ fontSize: '0.65rem', color: S600, marginBottom: 6, lineHeight: 1.3 }}>
            {activeSymbol
              ? <>Tap where the <b>{activeSymbol}</b> is — tap an existing mark to remove.</>
              : <>Pick a tag above, then tap the body to mark.</>}
          </div>

          <BodyCanvas
            marks={bodyMarks}
            activeSymbol={activeSymbol}
            onAdd={addBody}
            onRemoveMark={removeMark}
          />

          <div style={{ height: 8 }} />

          <HeadCanvas
            marks={headMarks}
            activeSymbol={activeSymbol}
            onAdd={addHead}
            onRemoveMark={removeMark}
          />

          {totalVisible > 0 && (
            <div style={{
              marginTop: 8, display: 'flex', alignItems: 'center',
              justifyContent: 'flex-end',
            }}>
              <button
                type="button"
                onClick={clearAll}
                style={{
                  padding: '4px 10px', borderRadius: 6,
                  border: '1px solid #fecaca', background: '#fff', color: '#b91c1c',
                  fontSize: '0.66rem', fontWeight: 700, cursor: 'pointer',
                }}
              >Clear all</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
