/**
 * Time estimate on a card: `[estimate:: 2h]` on its first line (like priority).
 * Units m / h / d / w, combinable ("1d 4h"); 1d = 24h because the real time it's
 * compared with is clock time spent in In Progress / Review (server: work_ms + work_since).
 * Keep parseDuration / formatDuration in sync with server/progress.js.
 */
import { useEffect, useState } from 'preact/compat';

const UNITS: Record<string, number> = { m: 60e3, h: 3600e3, d: 24 * 3600e3, w: 7 * 24 * 3600e3 };
export const ESTIMATE_FIELD_RE = /\s*\[estimate::[^\]]*\]/gi;

/** "2h", "1d 4h", "90m", "1.5h" -> ms, or null when it isn't a duration. */
export function parseDuration(s: string | null | undefined): number | null {
  let rest = String(s || '').trim().toLowerCase();
  if (!rest) return null;
  let total = 0;
  const re = /^(\d+(?:[.,]\d+)?)\s*(m|min|h|hr|d|w)\s*/;
  while (rest) {
    const m = re.exec(rest);
    if (!m) return null;
    total += parseFloat(m[1].replace(',', '.')) * UNITS[m[2][0]];
    rest = rest.slice(m[0].length);
  }
  return total > 0 ? Math.round(total) : null;
}

/** ms -> "45m", "3h 20m", "2d 4h". */
export function formatDuration(ms: number): string {
  const min = Math.round((ms || 0) / 60e3);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** The estimate written on the card: its text and length, or null. */
export function getEstimate(titleRaw: string): { raw: string; ms: number } | null {
  const m = /\[estimate::\s*([^\]]*)\]/i.exec(titleRaw || '');
  if (!m) return null;
  const ms = parseDuration(m[1]);
  return ms ? { raw: m[1].trim(), ms } : null;
}

/** Set or clear `[estimate:: x]`; always on the first line, before a trailing ^blockId. */
export function setEstimateInTitle(titleRaw: string, value: string | null) {
  const lines = titleRaw.split(/\r?\n/).map((l) => l.replace(ESTIMATE_FIELD_RE, ''));
  if (value) {
    const piece = ` [estimate:: ${value.trim().toLowerCase()}]`;
    const m = /(\s\^[a-z0-9-]+)\s*$/i.exec(lines[0]);
    lines[0] = m ? lines[0].slice(0, m.index) + piece + m[1] : lines[0].replace(/\s+$/, '') + piece;
  }
  return lines.join('\n');
}

/** Real time from the server card fields. */
export function workMs(card: { workMs?: number; workSince?: number | null } | null | undefined, now = Date.now()) {
  if (!card) return 0;
  return (card.workMs || 0) + (card.workSince != null ? Math.max(0, now - card.workSince) : 0);
}

// One shared minute tick for every running clock on screen.
let tick = 0;
const listeners = new Set<(n: number) => void>();
let timer: number | null = null;
export function useMinuteTick(active: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    listeners.add(set);
    if (timer == null) {
      timer = window.setInterval(() => {
        tick++;
        listeners.forEach((l) => l(tick));
      }, 60e3);
    }
    return () => {
      listeners.delete(set);
      if (!listeners.size && timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
  }, [active]);
}
