import { useEffect } from 'react';

/**
 * Locks background page scrolling while `active` is true, so the user cannot
 * scroll the page behind a modal / pop-up card.
 *
 * Why not just `document.body.style.overflow = 'hidden'`? On iOS Safari (and
 * some Android browsers) `overflow: hidden` on <body>/<html> does NOT stop
 * touch scrolling — the page behind the modal still scrolls under your finger,
 * which is exactly the bug this hook fixes. The reliable cross-browser lock is
 * to pin the body with `position: fixed` and offset it by the current scroll
 * position, then restore that scroll position on unlock.
 *
 * A module-level counter shares a single body lock across every mounted modal:
 * only the FIRST lock captures the scroll position and freezes the body, and
 * only the LAST unlock restores it. Without this, a second modal opening while
 * the first is still open would capture an already-frozen (scrollY 0) position
 * and snap the page to the top when it closed.
 */

let lockCount = 0;
let savedScrollY = 0;
let savedStyles: {
  overflow: string;
  position: string;
  top: string;
  width: string;
  paddingRight: string;
} | null = null;

function applyLock() {
  if (lockCount === 0 && typeof document !== 'undefined') {
    const body = document.body;
    savedScrollY = window.scrollY;
    savedStyles = {
      overflow: body.style.overflow,
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      paddingRight: body.style.paddingRight,
    };
    // Compensate for the removed scrollbar so desktop content doesn't jump
    // sideways when the body switches to position: fixed. On mobile there is
    // no persistent scrollbar, so this is a no-op there.
    const scrollBarWidth = window.innerWidth - document.documentElement.clientWidth;

    body.style.overflow = 'hidden';
    body.style.position = 'fixed';
    body.style.top = `-${savedScrollY}px`;
    body.style.width = '100%';
    if (scrollBarWidth > 0) body.style.paddingRight = `${scrollBarWidth}px`;
  }
  lockCount += 1;
}

function releaseLock() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0 && savedStyles && typeof document !== 'undefined') {
    const body = document.body;
    body.style.overflow = savedStyles.overflow;
    body.style.position = savedStyles.position;
    body.style.top = savedStyles.top;
    body.style.width = savedStyles.width;
    body.style.paddingRight = savedStyles.paddingRight;
    savedStyles = null;
    // Restore the scroll position the page had before it was frozen.
    window.scrollTo(0, savedScrollY);
  }
}

export function useScrollLock(active: boolean = true) {
  useEffect(() => {
    if (!active) return;
    applyLock();
    return releaseLock;
  }, [active]);
}

export default useScrollLock;
