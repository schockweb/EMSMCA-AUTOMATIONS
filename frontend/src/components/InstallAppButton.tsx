/**
 * InstallAppButton — "Install app" affordance for the PWA.
 *
 * Behaviour is context-aware because PWA install differs by platform:
 *   • Chrome / Edge / Android — captures the browser's `beforeinstallprompt`
 *     event and, on tap, fires the native install dialog.
 *   • iOS Safari — Apple exposes no programmatic install, so the button opens
 *     a short instruction sheet (Share → Add to Home Screen).
 *   • Already installed (running standalone) or an unsupported desktop browser
 *     — the button renders nothing, so it never shows up uselessly.
 */
import { useEffect, useState } from 'react';

// Minimal shape of the (non-standard) beforeinstallprompt event.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari exposes standalone on navigator, not via display-mode.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIOS(): boolean {
  const ua = window.navigator.userAgent;
  const iOSDevice = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ reports as Mac; detect it via touch support.
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return iOSDevice || iPadOS;
}

export default function InstallAppButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone());
  const [showIosSheet, setShowIosSheet] = useState(false);

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault(); // stop Chrome's default mini-infobar
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // Already installed → nothing to offer.
  if (installed) return null;

  const ios = isIOS();
  // Show the button only when we can actually do something: a captured
  // install prompt (Android/desktop) or iOS (instruction sheet). Otherwise
  // (desktop browser with no prompt yet / unsupported) render nothing.
  const canOffer = deferred !== null || ios;
  if (!canOffer) return null;

  const handleClick = async () => {
    if (deferred) {
      await deferred.prompt();
      await deferred.userChoice;
      setDeferred(null); // a prompt can only be used once
    } else if (ios) {
      setShowIosSheet(true);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          width: '100%',
          padding: '11px 16px',
          background: 'rgba(255, 255, 255, 0.7)',
          color: 'var(--text-secondary)',
          border: '1px solid var(--glass-border)',
          borderRadius: 10,
          fontSize: '0.82rem',
          fontWeight: 600,
          cursor: 'pointer',
          transition: 'all 0.15s ease',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.95)';
          e.currentTarget.style.color = 'var(--text-primary)';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.7)';
          e.currentTarget.style.color = 'var(--text-secondary)';
        }}
      >
        <span aria-hidden style={{ fontSize: '1rem', lineHeight: 1 }}>📲</span>
        Install app for offline use
      </button>

      {showIosSheet && (
        <div
          onClick={() => setShowIosSheet(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%', maxWidth: 460,
              background: '#fff', borderRadius: '18px 18px 0 0',
              padding: '24px 22px calc(24px + env(safe-area-inset-bottom))',
              boxShadow: '0 -8px 30px rgba(0,0,0,0.2)',
            }}
          >
            <div style={{ fontWeight: 800, fontSize: '1.05rem', color: '#0f172a', marginBottom: 6 }}>
              Install on your iPhone
            </div>
            <div style={{ fontSize: '0.85rem', color: '#475569', marginBottom: 18 }}>
              iPhone installs apps from Safari's share menu. It only takes a moment:
            </div>
            <ol style={{ margin: 0, paddingLeft: 20, color: '#1f2937', fontSize: '0.9rem', lineHeight: 1.7 }}>
              <li>Tap the <strong>Share</strong> icon <span aria-hidden>(the square with an arrow ↑)</span> in the Safari toolbar.</li>
              <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
              <li>Tap <strong>Add</strong> in the top-right corner.</li>
            </ol>
            <button
              type="button"
              onClick={() => setShowIosSheet(false)}
              style={{
                marginTop: 22, width: '100%', padding: '12px 16px',
                background: '#0f172a', color: '#fff', border: 'none',
                borderRadius: 10, fontSize: '0.9rem', fontWeight: 700, cursor: 'pointer',
              }}
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
