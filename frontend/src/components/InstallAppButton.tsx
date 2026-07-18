/**
 * InstallAppButton — "Install app" affordance for the PWA.
 *
 * Layout differs by device:
 *   • Mobile (iOS / Android) — a download icon pinned to the top-right corner.
 *     Tapping it opens a confirmation popup ("the app will be downloaded and
 *     added to your home screen — continue?"). On "Yes" it either fires the
 *     browser's native install dialog (HTTPS + installable) or, when that isn't
 *     available, shows a short platform instruction sheet.
 *   • Desktop — the original inline button, shown only when the browser has
 *     captured a native install prompt.
 *   • Already installed (running standalone) — renders nothing.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

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

function isAndroid(): boolean {
  return /Android/i.test(window.navigator.userAgent);
}

export default function InstallAppButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone());
  const [sheet, setSheet] = useState<null | 'ios' | 'android'>(null);

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
  const android = isAndroid();
  const mobile = ios || android;

  // Tapping the icon runs this directly — native install dialog where the
  // browser supports it, otherwise the platform set-up guide.
  const runInstall = async () => {
    if (deferred) {
      await deferred.prompt();
      await deferred.userChoice;
      setDeferred(null); // a prompt can only be used once
    } else if (ios) {
      setSheet('ios');
    } else {
      setSheet('android');
    }
  };

  // ── Desktop: no install affordance. Desktop users work in the browser
  // (admin dashboard), so there's nothing to install here. ──
  if (!mobile) return null;

  // ── Mobile: top-right corner download icon ──
  // Portaled to <body> so it escapes the login card's backdrop-filter
  // containing block and is positioned against the viewport — top-right,
  // aligned with the Back button (same safe-area top offset, mirrored inset).
  return (
    <>
      {createPortal(
        <button
          type="button"
          aria-label="Install app"
          onClick={runInstall}
          style={{
            position: 'fixed',
            top: 'calc(env(safe-area-inset-top, 0px) + 24px)',
            right: 24,
            zIndex: 10,
            width: 40,
            height: 40,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(255, 255, 255, 0.8)',
            backdropFilter: 'blur(10px)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--glass-border)',
            borderRadius: '50%',
            boxShadow: '0 2px 10px rgba(0,0,0,0.05)',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = '#ffffff';
            e.currentTarget.style.color = 'var(--text-primary)';
            e.currentTarget.style.boxShadow = '0 4px 15px rgba(0,0,0,0.1)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.8)';
            e.currentTarget.style.color = 'var(--text-secondary)';
            e.currentTarget.style.boxShadow = '0 2px 10px rgba(0,0,0,0.05)';
          }}
        >
          {/* download-to-tray icon */}
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 21h14" />
          </svg>
        </button>,
        document.body,
      )}

      {sheet && createPortal(
        <div
          onClick={() => setSheet(null)}
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
              {sheet === 'ios' ? 'Install on your device' : 'Install on your phone'}
            </div>
            <div style={{ fontSize: '0.85rem', color: '#475569', marginBottom: 16 }}>
              {sheet === 'ios'
                ? 'Add this app to your home screen. Follow the steps for the browser you are using:'
                : 'Add this app to your home screen from the browser menu:'}
            </div>
            {sheet === 'ios' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Safari — the reliable path for a true installed PWA on iOS */}
                <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#088395', marginBottom: 8 }}>
                    Safari · recommended
                  </div>
                  <ol style={{ margin: 0, paddingLeft: 18, color: '#1f2937', fontSize: '0.88rem', lineHeight: 1.65 }}>
                    <li>Tap the <strong>Share</strong> icon <span aria-hidden>(□↑)</span> in the bottom toolbar.</li>
                    <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
                    <li>Tap <strong>Add</strong> in the top-right corner.</li>
                  </ol>
                </div>
                {/* Chrome on iOS */}
                <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#475569', marginBottom: 8 }}>
                    Chrome
                  </div>
                  <ol style={{ margin: 0, paddingLeft: 18, color: '#1f2937', fontSize: '0.88rem', lineHeight: 1.65 }}>
                    <li>Tap the <strong>Share</strong> icon <span aria-hidden>(□↑)</span> in the top-right toolbar.</li>
                    <li>Tap <strong>Add to Home Screen</strong>.</li>
                    <li>Tap <strong>Add</strong> to confirm.</li>
                  </ol>
                </div>
              </div>
            ) : (
              <ol style={{ margin: 0, paddingLeft: 20, color: '#1f2937', fontSize: '0.9rem', lineHeight: 1.7 }}>
                <li>Tap the <strong>⋮</strong> menu in the top-right of your browser.</li>
                <li>Tap <strong>Install app</strong> (or <strong>Add to Home screen</strong>).</li>
                <li>Confirm with <strong>Install</strong> / <strong>Add</strong>.</li>
              </ol>
            )}
            <button
              type="button"
              onClick={() => setSheet(null)}
              style={{
                marginTop: 22, width: '100%', padding: '12px 16px',
                background: '#0f172a', color: '#fff', border: 'none',
                borderRadius: 10, fontSize: '0.9rem', fontWeight: 700, cursor: 'pointer',
              }}
            >
              Got it
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
