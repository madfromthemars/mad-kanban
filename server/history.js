// Team history: the raw material for "how did this week / month / year go?" questions.
//
// Three sources, all kept forever (only the Trash is purged, and history doesn't depend on it):
// - card_events: every create / move / archive / delete / restore, plus edits that matter
//   (assignees, due date, priority, project, title, checklist progress) and comments. Each
//   entry carries the card's title, project and assignees at that moment (see logEvent).
// - daily_stats: once a day (re-taken every hour, so the last one is end-of-day) how many cards
//   each project and person had in To Do / In Progress / Review / Backlog / finished / overdue.
//   Cheap, and lets months and years be compared without replaying the log.
// - comments (existing table).
// GET /api/history returns all of it for a period; the counting happens on the reader's side.

import { transaction, visibleProjectIds } from './db.js';
import { laneKey } from './lanes.js';
import { cardTitle, dueOf, isFinishedLane, logEvent, priorityOf, safeArr } from './progress.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Days are counted in the team's time zone (Tashkent, UTC+5 by default).
const TZ_MIN = Number.isFinite(Number(process.env.REPORT_TZ_OFFSET_MIN)) && process.env.REPORT_TZ_OFFSET_MIN !== ''
  ? Number(process.env.REPORT_TZ_OFFSET_MIN)
  : 300;

export function dayOf(ts) {
  return new Date(ts + TZ_MIN * 60 * 1000).toISOString().slice(0, 10);
}

export function migrateHistory(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_stats (
      day TEXT NOT NULL,
      board_id TEXT NOT NULL,
      project_id TEXT NOT NULL,   -- '' = all projects
      user_id TEXT NOT NULL,      -- '' = everyone, '-' = unassigned
      todo INTEGER NOT NULL,
      in_progress INTEGER NOT NULL,
      review INTEGER NOT NULL,
      backlog INTEGER NOT NULL,
      finished INTEGER NOT NULL,
      overdue INTEGER NOT NULL,
      taken_at INTEGER NOT NULL,
      PRIMARY KEY (day, board_id, project_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS card_events_all_ts ON card_events(ts);
  `);
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'history'").get()) {
    transaction(db, () => {
      // Older entries had only the card id: fill in what the card looks like now.
      const rows = db.prepare('SELECT id, board_id, card_id FROM card_events WHERE title IS NULL').all();
      const card = db.prepare('SELECT content, project_id, assignees FROM cards WHERE id = ? AND board_id = ?');
      const trash = db.prepare('SELECT data FROM trash WHERE card_id = ? AND board_id = ?');
      const set = db.prepare('UPDATE card_events SET title = ?, project_id = ?, assignees = ? WHERE id = ?');
      for (const r of rows) {
        let c = card.get(r.card_id, r.board_id);
        if (!c) {
          const t = trash.get(r.card_id, r.board_id);
          try {
            c = t ? JSON.parse(t.data) : null;
          } catch {
            c = null;
          }
        }
        if (c) set.run(cardTitle(c.content), c.project_id ?? null, JSON.stringify(safeArr(c.assignees)), r.id);
      }
      db.prepare("INSERT INTO meta (key, value) VALUES ('history', ?)").run(String(Date.now()));
    });
  }
}

// ---------- what changed in an edit ----------

function checklist(content) {
  const lines = String(content || '').split('\n').slice(1);
  let total = 0;
  let done = 0;
  for (const l of lines) {
    const m = /^\s*[-*+]\s+\[(.)\]\s/.exec(l);
    if (!m) continue;
    total++;
    if (m[1] !== ' ') done++;
  }
  return { done, total };
}

/** History entries for one card edit (before/after are card rows). */
export function cardChanges(before, after) {
  const out = [];
  const a0 = safeArr(before.assignees);
  const a1 = safeArr(after.assignees);
  const added = a1.filter((x) => !a0.includes(x));
  const removed = a0.filter((x) => !a1.includes(x));
  if (added.length || removed.length) out.push({ type: 'assigned', detail: { added, removed } });
  const d0 = dueOf(before.content);
  const d1 = dueOf(after.content);
  if (d0 !== d1) out.push({ type: 'due', detail: { from: d0, to: d1 } });
  const p0 = priorityOf(before.content);
  const p1 = priorityOf(after.content);
  if (p0 !== p1) out.push({ type: 'priority', detail: { from: p0, to: p1 } });
  if ((before.project_id || null) !== (after.project_id || null)) {
    out.push({ type: 'project', detail: { from: before.project_id || null, to: after.project_id || null } });
  }
  const t0 = cardTitle(before.content);
  const t1 = cardTitle(after.content);
  if (t0 !== t1) out.push({ type: 'renamed', detail: { from: t0 } });
  const c0 = checklist(before.content);
  const c1 = checklist(after.content);
  if (c0.done !== c1.done || c0.total !== c1.total) {
    out.push({ type: 'checklist', detail: { from: c0.done, done: c1.done, total: c1.total } });
  }
  return out;
}

export function logCardChanges(db, { boardId, userId, before, after, ts = Date.now() }) {
  if (!before || !after) return;
  for (const ch of cardChanges(before, after)) {
    logEvent(db, { boardId, cardId: after.id, userId, type: ch.type, ts, card: after, detail: ch.detail });
  }
}

// ---------- daily numbers ----------

function bucketOf(lane) {
  if (!lane) return null;
  if (isFinishedLane(lane)) return 'finished';
  const k = laneKey(lane.title);
  if (k === 'backlog') return 'backlog';
  if (k === 'inprogress') return 'in_progress';
  if (k === 'review') return 'review';
  return 'todo'; // To Do and any other open list
}

/** Today's counts for every board (replaces today's earlier ones). */
export function takeDailyStats(db, now = Date.now()) {
  const day = dayOf(now);
  const ins = db.prepare(
    `INSERT OR REPLACE INTO daily_stats (day, board_id, project_id, user_id, todo, in_progress, review, backlog, finished, overdue, taken_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let rows = 0;
  transaction(db, () => {
    for (const { id: boardId } of db.prepare('SELECT id FROM boards').all()) {
      const lanes = new Map(db.prepare('SELECT * FROM lanes WHERE board_id = ?').all(boardId).map((l) => [l.id, l]));
      const cards = db.prepare('SELECT * FROM cards WHERE board_id = ? AND archived = 0').all(boardId);
      if (!cards.length) continue;
      db.prepare('DELETE FROM daily_stats WHERE day = ? AND board_id = ?').run(day, boardId);
      const acc = new Map();
      const add = (p, u, bucket, overdue) => {
        const k = p + '\u0000' + u;
        if (!acc.has(k)) acc.set(k, { p, u, todo: 0, in_progress: 0, review: 0, backlog: 0, finished: 0, overdue: 0 });
        const r = acc.get(k);
        r[bucket]++;
        if (overdue) r.overdue++;
      };
      for (const c of cards) {
        const bucket = bucketOf(lanes.get(c.lane_id));
        if (!bucket) continue;
        const due = dueOf(c.content);
        const overdue = due != null && due < day && bucket !== 'finished' && bucket !== 'backlog';
        const people = safeArr(c.assignees);
        const project = c.project_id || '';
        const users = people.length ? people : ['-'];
        add('', '', bucket, overdue);
        if (project) add(project, '', bucket, overdue);
        for (const u of users) {
          add('', u, bucket, overdue);
          if (project) add(project, u, bucket, overdue);
        }
      }
      for (const r of acc.values()) {
        ins.run(day, boardId, r.p, r.u, r.todo, r.in_progress, r.review, r.backlog, r.finished, r.overdue, now);
        rows++;
      }
    }
  });
  return rows;
}

export function startDailyStats(db) {
  const run = () => {
    try {
      takeDailyStats(db);
    } catch (e) {
      console.error('daily stats failed:', e);
    }
  };
  run();
  return setInterval(run, HOUR).unref();
}

// ---------- reading it back ----------

/**
 * Everything that happened between `from` and `to` (ms), limited to what this person may see.
 * `from`/`to` also accept YYYY-MM-DD (team time zone, `to` inclusive).
 */
export function teamHistory(db, user, { from, to, boardId } = {}) {
  const parse = (v, end) => {
    if (v == null || v === '') return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
      const t = Date.parse(v + 'T00:00:00Z') - TZ_MIN * 60 * 1000;
      return end ? t + DAY - 1 : t;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const now = Date.now();
  const toTs = parse(to, true) ?? now;
  const fromTs = parse(from, false) ?? toTs - 7 * DAY;
  if (toTs - fromTs > 3 * 366 * DAY) throw Object.assign(new Error('period is longer than 3 years'), { status: 400 });

  const vis = visibleProjectIds(db, user);
  const okProject = (p) => vis === null || vis.has(p);
  const boardIds = new Set(
    db
      .prepare('SELECT board_id FROM board_members WHERE user_id = ?')
      .all(user.id)
      .map((r) => r.board_id)
  );
  if (user.role === 'owner') for (const b of db.prepare('SELECT id FROM boards').all()) boardIds.add(b.id);
  if (boardId) {
    if (!boardIds.has(boardId)) throw Object.assign(new Error('board not found'), { status: 404 });
    boardIds.clear();
    boardIds.add(boardId);
  }
  const inBoards = (b) => boardIds.has(b);

  const users = db.prepare('SELECT id, name, role, disabled FROM users').all();
  const projects = db.prepare('SELECT id, name FROM projects').all().filter((p) => okProject(p.id));
  const boards = db
    .prepare('SELECT id, name FROM boards')
    .all()
    .filter((b) => inBoards(b.id));

  const events = db
    .prepare('SELECT * FROM card_events WHERE ts >= ? AND ts <= ? ORDER BY ts, id')
    .all(fromTs, toTs)
    .filter((e) => inBoards(e.board_id) && (vis === null || okProject(e.project_id)))
    .map((e) => ({
      ts: e.ts,
      day: dayOf(e.ts),
      boardId: e.board_id,
      cardId: e.card_id,
      type: e.type,
      by: e.user_id,
      title: e.title,
      projectId: e.project_id,
      assignees: e.assignees ? safeArr(e.assignees) : null,
      fromLane: e.from_lane,
      toLane: e.to_lane,
      detail: e.detail ? JSON.parse(e.detail) : null,
    }));

  const daily = db
    .prepare('SELECT * FROM daily_stats WHERE day >= ? AND day <= ? ORDER BY day')
    .all(dayOf(fromTs), dayOf(toTs))
    .filter((r) => inBoards(r.board_id) && (vis === null ? true : r.project_id !== '' && okProject(r.project_id)))
    .map((r) => ({
      day: r.day,
      boardId: r.board_id,
      projectId: r.project_id || null,
      userId: r.user_id === '' ? null : r.user_id,
      todo: r.todo,
      inProgress: r.in_progress,
      review: r.review,
      backlog: r.backlog,
      finished: r.finished,
      overdue: r.overdue,
    }));

  // Current state of every card, so the period can be read against "now".
  const lanes = new Map(db.prepare('SELECT * FROM lanes').all().map((l) => [l.id, l]));
  const cards = db
    .prepare('SELECT * FROM cards')
    .all()
    .filter((c) => inBoards(c.board_id) && okProject(c.project_id))
    .map((c) => {
      const lane = lanes.get(c.lane_id);
      return {
        id: c.id,
        boardId: c.board_id,
        title: cardTitle(c.content),
        lane: c.archived ? '(hidden archive)' : lane?.title ?? null,
        status: c.archived ? 'finished' : bucketOf(lane),
        projectId: c.project_id || null,
        assignees: safeArr(c.assignees),
        createdAt: c.created_at,
        createdBy: c.created_by,
        doneAt: c.done_at,
        doneBy: c.done_by,
        doneEstimated: !!c.done_estimated,
        due: dueOf(c.content),
        priority: priorityOf(c.content),
        checklist: checklist(c.content),
      };
    });
  const cardProject = new Map(cards.map((c) => [c.id, c.projectId]));
  const trashProject = new Map(db.prepare('SELECT card_id, project_id FROM trash').all().map((t) => [t.card_id, t.project_id]));

  const comments = db
    .prepare('SELECT id, board_id, card_id, user_id, body, created_at, reply_to FROM comments WHERE created_at >= ? AND created_at <= ? ORDER BY created_at')
    .all(fromTs, toTs)
    .filter((c) => inBoards(c.board_id))
    .filter((c) => {
      if (vis === null) return true;
      const p = cardProject.has(c.card_id) ? cardProject.get(c.card_id) : trashProject.get(c.card_id);
      return okProject(p);
    })
    .map((c) => ({
      id: c.id,
      day: dayOf(c.created_at),
      ts: c.created_at,
      boardId: c.board_id,
      cardId: c.card_id,
      by: c.user_id,
      replyTo: c.reply_to,
      body: c.body.length > 1000 ? c.body.slice(0, 1000) + '…' : c.body,
    }));

  const meta = (k) => Number(db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value || 0) || null;
  return {
    now,
    from: fromTs,
    to: toTs,
    timezoneOffsetMin: TZ_MIN,
    // Finish dates are exact from progressSince (older ones are guesses); edits from historySince.
    progressSince: meta('progress'),
    historySince: meta('history'),
    boards,
    users,
    projects,
    events,
    daily,
    comments,
    cards,
  };
}
