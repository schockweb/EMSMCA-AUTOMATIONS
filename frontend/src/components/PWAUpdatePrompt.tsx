/**
 * PWAUpdatePrompt — non-intrusive "new version available" banner.
 *
 * With the PWA in 'prompt' mode (see vite.config.ts), a freshly-deployed build
 * is fetched in the background but held until the user confirms. This banner is
 * the confirmation UI: it appears only when an update is waiting, and tapping
 * "Update now" activates the new service worker and reloads. It NEVER reloads on
 * its own — so a crew member mid-PRF is never interrupted; they update between
 * calls. This removes any need to re-install the app to get changes.
 */
import { useRegisterSW } from 'virtual:pwa-register/react';

// How often to poll for a new version while the app stays open (crew often
// leave it running a whole shift, so relying on a fresh launch isn't enough).
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export default function PWAUpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      setInterval(() => {
        registration.update().catch(() => {/* offline — try again next tick */});
      }, UPDATE_CHECK_INTERVAL_MS);
    },
  });

  if (!needRefresh) return null;

  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: 'calc(16px + env(safe-area-inset-bottom))',
        zIndex: 2000,
        width: 'calc(100% - 32px)',
        maxWidth: 420,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        background: '#0f172a',
        color: '#fff',
        borderRadius: 12,
        boxShadow: '0 8px 30px rgba(0,0,0,0.28)',
      }}
    >
      <span aria-hidden style={{ fontSize: '1.2rem', lineHeight: 1 }}>⬆️</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: '0.86rem' }}>Update available</div>
        <div style={{ fontSize: '0.74rem', color: '#cbd5e1' }}>
          Finish your current form, then tap to update.
        </div>
      </div>
      <button
        type="button"
        onClick={() => updateServiceWorker(true)}
        style={{
          flexShrink: 0,
          padding: '8px 14px',
          background: '#22c55e',
          color: '#04210f',
          border: 'none',
          borderRadius: 8,
          fontSize: '0.8rem',
          fontWeight: 800,
          cursor: 'pointer',
        }}
      >
        Update
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setNeedRefresh(false)}
        style={{
          flexShrink: 0,
          width: 28,
          height: 28,
          background: 'transparent',
          color: '#94a3b8',
          border: 'none',
          fontSize: '1.1rem',
          cursor: 'pointer',
        }}
      >
        ×
      </button>
    </div>
  );
}
