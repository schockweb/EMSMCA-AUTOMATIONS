import { useState, useEffect } from 'react';

/**
 * True while the viewport is narrower than `breakpoint`.
 *
 * The admin pages (Dashboard, Cases, Clients) style almost everything with
 * INLINE styles, which always beat a class rule — so an `@media` block in
 * index.css cannot reach them and a JS flag is the only mechanism that works.
 * (That is why `.page-content { padding: 20px }` in index.css has no effect on
 * these pages: they never use the class.)
 *
 * The default is 768 so this flips on exactly the same pixel as every
 * `@media (max-width: 768px)` rule in index.css. A mismatched pair leaves a
 * band of widths where the CSS thinks "mobile" and the JS thinks "desktop",
 * which is how half-broken layouts ship.
 *
 * The crew pages pass their own breakpoints (720 for the provider dashboard,
 * 480/640 for the narrow-viewport form grids) — always pass the value that
 * screen was tuned to rather than relying on the default, or the layout flips
 * at a different width than it was designed for.
 *
 * `orientationchange` is listened to alongside `resize` because some older iOS
 * versions fire it WITHOUT a resize, which would otherwise leave a rotated
 * tablet rendering the portrait layout until something else forced a render —
 * on the PRF form, that is mid-call.
 */
export default function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth < breakpoint : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setIsMobile(window.innerWidth < breakpoint);
    onResize();   // re-sync in case the width changed before this effect ran
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [breakpoint]);
  return isMobile;
}
