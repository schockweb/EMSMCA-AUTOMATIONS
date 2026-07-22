/**
 * LoadError — shared "couldn't load" UI for admin pages.
 *
 * Why this exists: pages used to swallow fetch errors (`catch {}`), so a dead
 * backend rendered the same screen as "no data" — KPIs showed 0, lists said
 * "No PRFs yet", Failed Forms celebrated "everything is processing smoothly".
 * Staff could not tell an empty system from a broken one. These two pieces
 * make failure look like failure:
 *
 *  - <LoadErrorPanel> replaces a page/section body when the FIRST load fails
 *    (there is nothing to show). Never rendered in place of real data.
 *  - <LoadErrorBar> sits above ALREADY-LOADED data when a background refresh
 *    fails — the stale rows stay visible, the bar says refreshing is broken.
 */

export function LoadErrorPanel({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '64px 24px', gap: 12, textAlign: 'center',
      background: 'var(--surface-0)', border: '1px solid rgba(220,38,38,0.25)',
      borderRadius: 'var(--radius-lg, 14px)',
    }}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="rgba(220,38,38,0.08)"
        stroke="#dc2626" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary, #0f172a)' }}>
        Couldn&apos;t load {what}
      </div>
      <div style={{ fontSize: '0.84rem', color: 'var(--text-muted, #64748b)', maxWidth: 420 }}>
        The server didn&apos;t respond — this is a connection problem, not an empty list.
        What you&apos;re not seeing may still exist.
      </div>
      <button onClick={onRetry} style={{
        marginTop: 6, padding: '10px 26px', borderRadius: 10, border: 'none',
        background: '#dc2626', color: '#fff', fontWeight: 700, fontSize: '0.85rem',
        cursor: 'pointer', fontFamily: 'inherit',
      }}>
        Retry
      </button>
    </div>
  );
}

export function LoadErrorBar({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      padding: '9px 14px', marginBottom: 14,
      background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.25)',
      borderRadius: 10, color: '#dc2626', fontSize: '0.8rem', fontWeight: 600,
    }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      Couldn&apos;t refresh {what} — showing the last loaded data.
      <button onClick={onRetry} style={{
        marginLeft: 'auto', padding: '5px 14px', borderRadius: 8,
        border: '1px solid rgba(220,38,38,0.4)', background: 'transparent',
        color: '#dc2626', fontWeight: 700, fontSize: '0.78rem',
        cursor: 'pointer', fontFamily: 'inherit',
      }}>
        Retry
      </button>
    </div>
  );
}
