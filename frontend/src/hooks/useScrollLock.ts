import { useEffect } from 'react';

/**
 * Locks background page scrolling while `active` is true, so the user cannot
 * scroll or otherwise manipulate the page behind a modal / pop-up card. The
 * previous `document.body` overflow is captured and restored on unlock/unmount,
 * so nested modals restore correctly (the last one to close wins).
 *
 * Pair with a full-screen backdrop (position: fixed; inset: 0) — that already
 * blocks pointer interaction with the page behind; this hook closes the
 * remaining gap of wheel / trackpad / touch scrolling.
 */
export function useScrollLock(active: boolean = true) {
  useEffect(() => {
    if (!active) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [active]);
}

export default useScrollLock;
