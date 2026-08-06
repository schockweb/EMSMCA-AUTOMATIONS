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
 * NOTE: the crew pages carry their own copies of this hook tuned to 720px.
 * They are the highest-risk screens in the product and are deliberately left
 * alone — do not migrate them to this hook as a drive-by.
 */
export default function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth < breakpoint : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return isMobile;
}
