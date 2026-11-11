// Owner digest: one Telegram message a day for the owner (Mon–Sat, 09:00 Tashkent by default):
// what got done yesterday, who has how much, overdue / stuck / unassigned cards. Mondays add
// last week's totals. Counts and names only (no card titles), like the other summaries.

import { laneKey } from './lanes.js';
import { parseCard } from './mcp.js';

const DAY = 24 * 60 * 60 * 1000;
export const STUCK_DAYS = 5;
/** "A lot": this many in progress, or this many open cards in total. */
export const BUSY_DOING = 4;
export const BUSY_OPEN = 15;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Local calendar helpers for a fixed UTC offset (Uzbekistan has no DST). */
export function localDay(ts, offsetH) {
  const d = new Date(ts + offsetH * 3600e3);
  return { ymd: d.toISOString().slice(0, 10), weekday: d.getUTCDay(), hour: d.getUTCHours(), start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - offsetH * 3600e3 };
}

function count(map, key, n = 1) {
  map.set(key, (map.get(key) || 0) + n);
}

function sorted(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

/**
 * The digest text (Telegram HTML), or null when there's nothing on any board.
 * `now` and `offsetH` decide "today" / "yesterday".
 */
export function buildDigest(db, { now = Date.now(), offsetH = 5, weekly = null } = {}) {
  const today = localDay(now, offsetH);
  const yStart = today.start - DAY;
  const isMonday = weekly ?? today.weekday === 1;

  const users = new Map(db.prepare('SELECT id, name, disabled FROM users').all().map((u) => [u.id, u]));
  const active = (id) => users.has(id) && !users.get(id).disabled;
  const name = (id) => users.get(id)?.name || 'someone';
  const projects = new Map(db.prepare('SELECT id, name FROM projects').all().map((p) => [p.id, p.name]));
  const projectName = (id) => (id && projects.get(id)) || 'No project';

  const cards = db
    .prepare(
      `SELECT c.id, c.content, c.assignees, c.archived, c.project_id, c.last_moved, c.created_at, c.done_at, c.done_by, c.done_estimated,
              l.title AS lane, l.mark_complete
       FROM cards c LEFT JOIN lanes l ON l.id = c.lane_id`
    )
    .all()
    // Private "Only me" cards are nobody else's business.
    .filter((c) => !String(c.project_id || '').startsWith('me:'));
  if (!cards.length) return null;

  const doneY = new Map();
  let doneYTotal = 0;
  const doing = new Map();
  const todo = new Map();
  const overdue = new Map();
  const overdueWhere = new Map();
  const stuck = new Map();
  const stuckWhere = new Map();
  const unassigned = new Map();
  const weekDone = new Map();
  let weekDoneTotal = 0;
  let weekNew = 0;

  for (const c of cards) {
    const key = laneKey(c.lane || '');
    const finished = c.mark_complete || key === 'done' || key === 'archive';
    const assignees = (() => {
      try {
        return JSON.parse(c.assignees || '[]').filter(active);
      } catch {
        return [];
      }
    })();
    if (c.done_at && !c.done_estimated) {
      const who = assignees.length ? assignees : c.done_by && active(c.done_by) ? [c.done_by] : [];
      if (c.done_at >= yStart && c.done_at < today.start) {
        doneYTotal++;
        for (const u of who) count(doneY, name(u));
      }
      if (isMonday && c.done_at >= today.start - 7 * DAY && c.done_at < today.start) {
        weekDoneTotal++;
        count(weekDone, projectName(c.project_id));
      }
    }
    if (isMonday && c.created_at >= today.start - 7 * DAY && c.created_at < today.start) weekNew++;
    if (finished || c.archived || key === 'backlog') continue;

    // Open card (To Do, In Progress, Review, or any other working list).
    const inProgress = key === 'inprogress' || key === 'review';
    for (const u of assignees) count(inProgress ? doing : todo, u);
    if (!assignees.length) count(unassigned, projectName(c.project_id));
    const due = parseCard(c.content).due;
    if (due && due < today.ymd) {
      for (const who of assignees.length ? assignees.map(name) : ['No one']) {
        count(overdue, who);
        if (!overdueWhere.has(who)) overdueWhere.set(who, new Map());
        count(overdueWhere.get(who), projectName(c.project_id));
      }
    }
    if (inProgress && c.last_moved < now - STUCK_DAYS * DAY) {
      for (const who of assignees.length ? assignees.map(name) : ['No one']) {
        count(stuck, who);
        if (!stuckWhere.has(who)) stuckWhere.set(who, new Map());
        count(stuckWhere.get(who), projectName(c.project_id));
      }
    }
  }

  const date = new Date(now + offsetH * 3600e3).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const out = [`📊 <b>Mad Kanban</b> · ${esc(date)}`];
  const where = (m) => (m ? ` <i>${sorted(m).map(([p, n]) => `${esc(p)} ${n}`).join(', ')}</i>` : '');

  out.push('', `✅ <b>Done yesterday (${doneYTotal})</b>`);
  out.push(doneYTotal ? `• ${sorted(doneY).map(([n, k]) => `${esc(n)} ${k}`).join(' · ')}` : '• Nothing finished');

  // Everyone with open cards, busiest first; teammates with nothing open listed after.
  const people = new Set([...doing.keys(), ...todo.keys()]);
  const rows = [...people]
    .map((u) => ({ u, doing: doing.get(u) || 0, todo: todo.get(u) || 0 }))
    .sort((a, b) => b.doing + b.todo - (a.doing + a.todo) || name(a.u).localeCompare(name(b.u)));
  out.push('', '👥 <b>Who has what</b> <i>(in progress / to do)</i>');
  for (const r of rows) {
    const busy = r.doing >= BUSY_DOING || r.doing + r.todo >= BUSY_OPEN;
    out.push(`• ${esc(name(r.u))} — ${r.doing} / ${r.todo}${busy ? ' ⚠️ a lot' : ''}`);
  }
  const members = new Set(db.prepare('SELECT DISTINCT user_id FROM project_members').all().map((r) => r.user_id));
  const idle = [...users.values()]
    .filter((u) => !u.disabled && members.has(u.id) && !people.has(u.id) && !/madsistant/i.test(u.name))
    .map((u) => u.name)
    .sort();
  if (idle.length) out.push(`• 💤 Nothing open: ${idle.map(esc).join(', ')}`);
  if (!rows.length && !idle.length) out.push('• No open cards');

  const total = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  if (overdue.size) {
    out.push('', `⏰ <b>Overdue</b>`);
    for (const [who, n] of sorted(overdue)) out.push(`• ${esc(who)} ${n}${where(overdueWhere.get(who))}`);
  }
  if (stuck.size) {
    out.push('', `🧊 <b>In progress, not moved for ${STUCK_DAYS}+ days</b>`);
    for (const [who, n] of sorted(stuck)) out.push(`• ${esc(who)} ${n}${where(stuckWhere.get(who))}`);
  }
  if (unassigned.size) {
    out.push('', `📭 <b>Nobody assigned (${total(unassigned)})</b>`);
    out.push(`• ${sorted(unassigned).map(([p, n]) => `${esc(p)} ${n}`).join(' · ')}`);
  }
  if (isMonday) {
    out.push('', `📅 <b>Last week</b>: ${weekDoneTotal} done · ${weekNew} new`);
    if (weekDone.size) out.push(`• ${sorted(weekDone).map(([p, n]) => `${esc(p)} ${n}`).join(' · ')}`);
  }
  return out.join('\n');
}
