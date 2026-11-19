/**
 * Phone board: swipe left/right on the list to go to the next/previous list.
 * On the first list a swipe to the right opens the left sidebar, on the last list a
 * swipe to the left opens the right one (Obsidian's own drawer swipe is switched off on
 * the board with data-ignore-swipe, since it would fire on every list).
 *
 * The list follows the finger 1:1 (rubber-banded at the ends); on release, distance or
 * flick speed decides. A long press still starts a card drag: the swipe only takes over
 * after a clear sideways move within the long-press time.
 */
import { App } from 'obsidian';
import { RefObject, useEffect, useRef } from 'preact/compat';

interface Opts {
  enabled: boolean;
  count: number;
  active: number;
  onSelect: (index: number) => void;
  app: App;
}

const LOCK_PX = 10; // movement before deciding the direction
const LONG_PRESS_MS = 450; // the card drag starts at 500 ms
const rubberband = (over: number, dim: number, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));

function blocked(el: EventTarget | null, dx: number): boolean {
  for (let n = el as HTMLElement | null; n && n instanceof HTMLElement; n = n.parentElement) {
    if (n.matches('input, textarea, select, [contenteditable="true"], .cm-editor')) return true;
    if (n.classList.contains('kanban-plugin__phone-tabs')) return true;
    // Something inside that scrolls sideways itself (wide table, code) keeps the gesture.
    const max = n.scrollWidth - n.clientWidth;
    if (max > 1 && !n.classList.contains('kanban-plugin__board')) {
      const ox = getComputedStyle(n).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && ((dx > 0 && n.scrollLeft > 0) || (dx < 0 && n.scrollLeft < max - 1))) return true;
    }
  }
  return false;
}

export function usePhoneSwipe(rootRef: RefObject<HTMLElement>, opts: Opts) {
  const live = useRef(opts);
  live.current = opts;

  useEffect(() => {
    if (!opts.enabled) return;
    const root = rootRef.current;
    const board = root?.querySelector<HTMLElement>('.kanban-plugin__board');
    if (!board) return;
    board.dataset.ignoreSwipe = 'true';
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const content = () => board.firstElementChild as HTMLElement | null;

    let id: number | null = null;
    let x0 = 0;
    let y0 = 0;
    let t0 = 0;
    let mode: 'idle' | 'pending' | 'swipe' | 'off' = 'idle';
    let dx = 0;
    let samples: { x: number; t: number }[] = [];
    let suppressClick = 0;

    const setX = (x: number, animate: boolean) => {
      const el = content();
      if (!el) return;
      el.style.transition = animate && !reduce ? 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none';
      el.style.transform = x ? `translate3d(${x}px, 0, 0)` : '';
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        mode = 'off';
        return;
      }
      const t = e.touches[0];
      id = t.identifier;
      x0 = t.clientX;
      y0 = t.clientY;
      t0 = Date.now();
      dx = 0;
      samples = [{ x: x0, t: t0 }];
      mode = 'pending';
    };

    const touchOf = (e: TouchEvent) => Array.from(e.changedTouches).find((t) => t.identifier === id) || null;

    const onMove = (e: TouchEvent) => {
      if (mode !== 'pending' && mode !== 'swipe') return;
      const t = touchOf(e);
      if (!t) return;
      const mx = t.clientX - x0;
      const my = t.clientY - y0;
      if (mode === 'pending') {
        if (Math.abs(mx) < LOCK_PX && Math.abs(my) < LOCK_PX) return;
        // Held still first = card drag territory; mostly vertical = list scroll.
        if (Date.now() - t0 > LONG_PRESS_MS || Math.abs(mx) < Math.abs(my) * 1.2 || blocked(e.target, mx)) {
          mode = 'off';
          return;
        }
        mode = 'swipe';
        x0 = t.clientX; // start from here so the list doesn't jump by the lock distance
      }
      e.preventDefault();
      const { count, active } = live.current;
      const width = board.clientWidth || 1;
      dx = t.clientX - x0;
      const atEdge = (dx > 0 && active <= 0) || (dx < 0 && active >= count - 1);
      setX(atEdge ? rubberband(dx, width) : dx, false);
      samples.push({ x: t.clientX, t: Date.now() });
      if (samples.length > 5) samples.shift();
    };

    const onEnd = (e: TouchEvent) => {
      if (mode !== 'swipe') {
        mode = 'idle';
        return;
      }
      if (!touchOf(e)) return;
      mode = 'idle';
      suppressClick = Date.now();
      const { count, active, onSelect, app } = live.current;
      const width = board.clientWidth || 1;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const v = last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0; // px/ms
      const dir = Math.abs(v) > 0.35 ? Math.sign(v) : Math.abs(dx) > width * 0.25 ? Math.sign(dx) : 0;
      if (dir === 0 || Math.sign(dx) !== dir) {
        setX(0, true);
        return;
      }
      const next = active - dir; // finger to the left (dir -1) = next list
      if (next < 0 || next >= count) {
        setX(0, true);
        const ws = app.workspace as any;
        (next < 0 ? ws.leftSplit : ws.rightSplit)?.expand?.();
        return;
      }
      // Slide out the way the finger went, switch, slide the new list in from the other side.
      setX(dir * width, true);
      window.setTimeout(
        () => {
          onSelect(next);
          setX(-dir * width * 0.3, false);
          requestAnimationFrame(() => requestAnimationFrame(() => setX(0, true)));
        },
        reduce ? 0 : 140
      );
    };

    const onCancel = () => {
      if (mode === 'swipe') setX(0, true);
      mode = 'idle';
    };

    // A swipe that ends on a card must not open it.
    const onClick = (e: MouseEvent) => {
      if (Date.now() - suppressClick < 400) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    // Capture: card drag handles stop touchstart from bubbling.
    board.addEventListener('touchstart', onStart, { capture: true, passive: true });
    board.addEventListener('touchmove', onMove, { capture: true, passive: false });
    board.addEventListener('touchend', onEnd, { capture: true });
    board.addEventListener('touchcancel', onCancel, { capture: true });
    board.addEventListener('click', onClick, { capture: true });
    return () => {
      delete board.dataset.ignoreSwipe;
      board.removeEventListener('touchstart', onStart, { capture: true });
      board.removeEventListener('touchmove', onMove, { capture: true });
      board.removeEventListener('touchend', onEnd, { capture: true });
      board.removeEventListener('touchcancel', onCancel, { capture: true });
      board.removeEventListener('click', onClick, { capture: true });
      setX(0, false);
    };
  }, [opts.enabled, rootRef.current]);
}
