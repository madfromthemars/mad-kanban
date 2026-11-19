// Progress tracking: when cards get finished, a 30-day Trash for deleted cards, and the data
// behind the Progress view in Obsidian.
//
// "Finished" means the card sits in a Done or Archive list (or a list marked complete).
// cards.done_at / done_by are set the moment a card gets there and cleared if it goes back.
// Archive is just a tidier place for finished cards: they keep counting.
// Deleted cards move to `trash` (whole row as JSON, comments stay) and come back with Restore.

import { canSeeProject, rowToCard, transaction, visibleProjectIds } from './db.js';
import { laneKey } from './lanes.js';

export const TRASH_DAYS = 30;
/** Cards sitting in a Done list longer than this go to the board's hidden archive (0 = off). */
export const DONE_CLEAN_DAYS = Number(process.env.DONE_CLEAN_DAYS ?? 7);
const DAY = 24 * 60 * 60 * 1000;

export function migrateProgress(db) {
  const cols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
  if (!cols.includes('done_at')) db.exec('ALTER TABLE cards ADD COLUMN done_at INTEGER');
  if (!cols.includes('done_by')) db.exec('ALTER TABLE cards ADD COLUMN done_by TEXT');
  // 1 = done_at is a guess (cards finished before tracking started: their last move).
  if (!cols.includes('done_estimated')) db.exec('ALTER TABLE cards ADD COLUMN done_estimated INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE TABLE IF NOT EXISTS card_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      user_id TEXT,
      type TEXT NOT NULL,
      from_lane TEXT,
      to_lane TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS card_events_card ON card_events(board_id, card_id, ts);
    CREATE INDEX IF NOT EXISTS card_events_ts ON card_events(board_id, ts);
    CREATE TABLE IF NOT EXISTS trash (
      card_id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      project_id TEXT,
      lane_title TEXT,
      data TEXT NOT NULL,
      deleted_by TEXT,
      deleted_at INTEGER NOT NULL,
      PRIMARY KEY (board_id, card_id)
    );
  `);
  // History entries carry the card as it was (title, project, assignees) and what changed.
  const evCols = db.prepare('PRAGMA table_info(card_events)').all().map((c) => c.name);
  for (const col of ['title', 'project_id', 'assignees', 'detail']) {
    if (!evCols.includes(col)) db.exec(`ALTER TABLE card_events ADD COLUMN ${col} TEXT`);
  }
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'progress'").get()) {
    transaction(db, () => {
      // Cards already finished: best guess is when they last moved.
      const rows = db
        .prepare('SELECT c.id, c.board_id, c.last_moved, l.title, l.mark_complete FROM cards c JOIN lanes l ON l.id = c.lane_id WHERE c.done_at IS NULL')
        .all();
      const set = db.prepare('UPDATE cards SET done_at = ?, done_estimated = 1 WHERE id = ? AND board_id = ?');
      for (const r of rows) if (isFinishedLane(r)) set.run(r.last_moved, r.id, r.board_id);
      db.prepare("INSERT INTO meta (key, value) VALUES ('progress', ?)").run(String(Date.now()));
    });
  }
}

/** Lists whose time counts as work on the card (the estimate's "real time"). */
export function isWorkLane(lane) {
  if (!lane) return false;
  const key = laneKey(lane.title);
  return key === 'inprogress' || key === 'review';
}

/**
 * Time spent in In Progress / Review: work_ms (closed stretches) plus the open one since
 * work_since. Keep the duration format in sync with src/estimate.ts.
 */
export function migrateWork(db) {
  const cols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
  if (!cols.includes('work_ms')) db.exec('ALTER TABLE cards ADD COLUMN work_ms INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('work_since')) db.exec('ALTER TABLE cards ADD COLUMN work_since INTEGER');
  if (db.prepare("SELECT 1 FROM meta WHERE key = 'work-time'").get()) return;
  transaction(db, () => {
    // Replay the history log: every stretch a card spent in a work list.
    const work = (t) => (t ? isWorkLane({ title: t }) : false);
    const evs = db.prepare("SELECT board_id, card_id, type, to_lane, ts FROM card_events WHERE type IN ('created', 'moved', 'archived', 'restored') ORDER BY id").all();
    const acc = new Map();
    for (const e of evs) {
      const k = e.board_id + '\u0000' + e.card_id;
      const a = acc.get(k) || { ms: 0, since: null };
      const inWork = e.type !== 'archived' && work(e.to_lane);
      if (inWork && a.since == null) a.since = e.ts;
      else if (!inWork && a.since != null) {
        a.ms += e.ts - a.since;
        a.since = null;
      }
      acc.set(k, a);
    }
    const cards = db.prepare('SELECT c.id, c.board_id, c.archived, c.last_moved, l.title FROM cards c LEFT JOIN lanes l ON l.id = c.lane_id').all();
    const set = db.prepare('UPDATE cards SET work_ms = ?, work_since = ? WHERE id = ? AND board_id = ?');
    for (const c of cards) {
      const a = acc.get(c.board_id + '\u0000' + c.id) || { ms: 0, since: null };
      const nowInWork = !c.archived && isWorkLane(c.title != null ? c : null);
      const since = nowInWork ? a.since ?? c.last_moved : null;
      if (a.ms || since != null) set.run(a.ms, since, c.id, c.board_id);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('work-time', ?)").run(String(Date.now()));
  });
}

/** After a card's list changed: start or stop its work clock. */
export function syncWork(db, boardId, cardId, now = Date.now()) {
  const c = db
    .prepare('SELECT c.archived, c.work_since, l.title FROM cards c LEFT JOIN lanes l ON l.id = c.lane_id WHERE c.id = ? AND c.board_id = ?')
    .get(cardId, boardId);
  if (!c) return;
  const inWork = !c.archived && isWorkLane(c.title != null ? c : null);
  if (inWork && c.work_since == null) {
    db.prepare('UPDATE cards SET work_since = ? WHERE id = ? AND board_id = ?').run(now, cardId, boardId);
  } else if (!inWork && c.work_since != null) {
    db.prepare('UPDATE cards SET work_ms = work_ms + ?, work_since = NULL WHERE id = ? AND board_id = ?').run(Math.max(0, now - c.work_since), cardId, boardId);
  }
}

const DURATION_UNITS = { m: 60e3, h: 3600e3, d: 24 * 3600e3, w: 7 * 24 * 3600e3 };
/** "2h", "1d 4h", "90m", "1.5h" -> ms (null if not a duration). Same rules as src/estimate.ts. */
export function parseDuration(s) {
  const str = String(s || '').trim().toLowerCase();
  if (!str) return null;
  let total = 0;
  let rest = str;
  const re = /^(\d+(?:[.,]\d+)?)\s*(m|min|h|hr|d|w)\s*/;
  while (rest) {
    const m = re.exec(rest);
    if (!m) return null;
    total += parseFloat(m[1].replace(',', '.')) * DURATION_UNITS[m[2][0]];
    rest = rest.slice(m[0].length);
  }
  return total > 0 ? Math.round(total) : null;
}
/** `[estimate:: 2h]` on the card -> ms, or null. */
export function estimateOf(content) {
  const m = /\[estimate::\s*([^\]]*)\]/i.exec(String(content || ''));
  return m ? parseDuration(m[1]) : null;
}
/** ms -> "45m", "3h 20m", "2d 4h" (same as src/estimate.ts formatDuration). */
export function fmtDuration(ms) {
  const min = Math.round((ms || 0) / 60e3);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
export function workMsOf(card, now = Date.now()) {
  return (card.work_ms || 0) + (card.work_since != null ? Math.max(0, now - card.work_since) : 0);
}

export function isFinishedLane(lane) {
  if (!lane) return false;
  const key = laneKey(lane.title);
  return key === 'done' || key === 'archive' || !!lane.mark_complete;
}

/** The board's Archive list (where "Archive" on a card sends it), or null. */
export function archiveLane(db, boardId) {
  return db.prepare('SELECT * FROM lanes WHERE board_id = ? ORDER BY position').all(boardId).find((l) => laneKey(l.title) === 'archive') || null;
}

/**
 * Append to the history log. Each entry keeps the card's title, project and assignees as they
 * were at that moment, so the history still reads right after the card is edited, deleted or
 * purged from the Trash. The log is never trimmed (see history.js).
 */
/** 'ai' while an AI key's request runs (see withVia), stored on every event it causes. */
let currentVia = null;
export function withVia(via, fn) {
  const prev = currentVia;
  currentVia = via || null;
  try {
    return fn();
  } finally {
    currentVia = prev;
  }
}

export function migrateVia(db) {
  const cols = db.prepare('PRAGMA table_info(card_events)').all().map((c) => c.name);
  if (cols.length && !cols.includes('via')) db.exec('ALTER TABLE card_events ADD COLUMN via TEXT');
}

export function logEvent(db, { boardId, cardId, userId, type, fromLane = null, toLane = null, ts = Date.now(), card = null, detail = null }) {
  const c =
    card ||
    db.prepare('SELECT content, project_id, assignees FROM cards WHERE id = ? AND board_id = ?').get(cardId, boardId) ||
    trashedRow(db, boardId, cardId);
  db.prepare(
    `INSERT INTO card_events (board_id, card_id, user_id, type, from_lane, to_lane, ts, title, project_id, assignees, detail, via)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    boardId,
    cardId,
    userId || null,
    type,
    fromLane,
    toLane,
    ts,
    c ? cardTitle(c.content) : null,
    c?.project_id ?? null,
    c ? JSON.stringify(safeArr(c.assignees)) : null,
    detail == null ? null : JSON.stringify(detail),
    currentVia
  );
}

function trashedRow(db, boardId, cardId) {
  const t = db.prepare('SELECT data FROM trash WHERE board_id = ? AND card_id = ?').get(boardId, cardId);
  if (!t) return null;
  try {
    return JSON.parse(t.data);
  } catch {
    return null;
  }
}

/**
 * After a card's list changed: start or stop its "finished" clock. Hidden-archived cards
 * (cards of a deleted list) keep whatever they had.
 */
export function syncDone(db, boardId, cardId, userId, now = Date.now()) {
  syncWork(db, boardId, cardId, now);
  const c = db
    .prepare('SELECT c.done_at, c.archived, l.title, l.mark_complete FROM cards c LEFT JOIN lanes l ON l.id = c.lane_id WHERE c.id = ? AND c.board_id = ?')
    .get(cardId, boardId);
  if (!c || c.archived) return;
  const finished = isFinishedLane(c.title != null ? c : null);
  if (finished && c.done_at == null) {
    db.prepare('UPDATE cards SET done_at = ?, done_by = ?, done_estimated = 0 WHERE id = ? AND board_id = ?').run(now, userId, cardId, boardId);
  } else if (!finished && c.done_at != null) {
    db.prepare('UPDATE cards SET done_at = NULL, done_by = NULL, done_estimated = 0 WHERE id = ? AND board_id = ?').run(cardId, boardId);
  }
}

/** Move a card row into the Trash (call inside the ops transaction, before deleting it). */
export function trashCard(db, card, user, laneTitle, now = Date.now()) {
  db.prepare(
    `INSERT OR REPLACE INTO trash (card_id, board_id, project_id, lane_title, data, deleted_by, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(card.id, card.board_id, card.project_id || null, laneTitle || null, JSON.stringify(card), user.id, now);
}

export function listTrash(db, user, boardId) {
  const vis = visibleProjectIds(db, user);
  return db
    .prepare(
      `SELECT t.*, u.name AS deleted_by_name FROM trash t LEFT JOIN users u ON u.id = t.deleted_by
       WHERE t.board_id = ? ORDER BY t.deleted_at DESC`
    )
    .all(boardId)
    .filter((t) => vis === null || vis.has(t.project_id))
    .map((t) => {
      const card = JSON.parse(t.data);
      return {
        id: t.card_id,
        boardId: t.board_id,
        title: cardTitle(card.content),
        content: card.content,
        assignees: safeArr(card.assignees),
        projectId: t.project_id,
        lane: t.lane_title,
        deletedBy: t.deleted_by,
        deletedByName: t.deleted_by_name || null,
        deletedAt: t.deleted_at,
        purgeAt: t.deleted_at + TRASH_DAYS * DAY,
        commentCount: db.prepare('SELECT COUNT(*) AS n FROM comments WHERE board_id = ? AND card_id = ?').get(t.board_id, t.card_id).n,
      };
    });
}

/**
 * Put a trashed card back: its old list if it still exists (else the first one), at the top.
 * Returns the restored card, or throws { status, message }.
 */
export function restoreCard(db, user, boardId, cardId) {
  const t = db.prepare('SELECT * FROM trash WHERE board_id = ? AND card_id = ?').get(boardId, cardId);
  if (!t || !canSeeProject(db, user, t.project_id)) throw Object.assign(new Error('not in the Trash'), { status: 404 });
  if (db.prepare('SELECT 1 FROM cards WHERE id = ? AND board_id = ?').get(cardId, boardId)) {
    throw Object.assign(new Error('a card with this id already exists'), { status: 409 });
  }
  const row = JSON.parse(t.data);
  const lanes = db.prepare('SELECT * FROM lanes WHERE board_id = ? ORDER BY position').all(boardId);
  const lane = lanes.find((l) => l.id === row.lane_id) || lanes.find((l) => l.title === t.lane_title) || lanes[0];
  if (!lane) throw Object.assign(new Error('the board has no lists'), { status: 409 });
  const now = Date.now();
  transaction(db, () => {
    const cols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
    const vals = { ...row, lane_id: lane.id, position: -1, archived: 0, version: (row.version || 1) + 1, updated_at: now };
    const use = cols.filter((c) => c in vals);
    db.prepare(`INSERT INTO cards (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`).run(...use.map((c) => vals[c]));
    // Top of the list.
    const inLane = db.prepare('SELECT id FROM cards WHERE board_id = ? AND lane_id = ? AND archived = 0 ORDER BY position').all(boardId, lane.id);
    const pos = db.prepare('UPDATE cards SET position = ? WHERE id = ? AND board_id = ?');
    inLane.forEach((c, i) => pos.run(i, c.id, boardId));
    db.prepare('DELETE FROM trash WHERE board_id = ? AND card_id = ?').run(boardId, cardId);
    syncDone(db, boardId, cardId, user.id, now);
    logEvent(db, { boardId, cardId, userId: user.id, type: 'restored', toLane: lane.title, ts: now });
    db.prepare('UPDATE boards SET version = version + 1 WHERE id = ?').run(boardId);
  });
  return rowToCard(db.prepare('SELECT * FROM cards WHERE id = ? AND board_id = ?').get(cardId, boardId));
}

/**
 * Done-list cleaner: cards that have been in a "Done" list for DONE_CLEAN_DAYS move to the
 * board's hidden archive (archived = 1; lane_id and done_at are kept, so they still count as
 * finished in Progress, history and the digest, and "Open board archive" can bring them back).
 * Only lanes whose key is 'done': the Archive list is where people keep cards on purpose.
 * Returns [{ boardId, cardIds, users }] for the boards that changed.
 */
export function cleanDone(db, now = Date.now(), days = DONE_CLEAN_DAYS) {
  if (!(days > 0)) return [];
  const cutoff = now - days * DAY;
  const doneLanes = db
    .prepare('SELECT id, board_id, title FROM lanes')
    .all()
    .filter((l) => laneKey(l.title) === 'done');
  const changed = [];
  transaction(db, () => {
    for (const lane of doneLanes) {
      const old = db
        .prepare('SELECT * FROM cards WHERE board_id = ? AND lane_id = ? AND archived = 0 AND COALESCE(done_at, 0) < ? AND COALESCE(last_moved, 0) < ?')
        .all(lane.board_id, lane.id, cutoff, cutoff);
      if (!old.length) continue;
      let pos = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM cards WHERE board_id = ? AND archived = 1').get(lane.board_id).p;
      const arch = db.prepare('UPDATE cards SET archived = 1, position = ?, version = version + 1, updated_at = ? WHERE id = ? AND board_id = ?');
      const users = new Set();
      for (const c of old) {
        arch.run(++pos, now, c.id, lane.board_id);
        for (const u of safeArr(c.assignees)) users.add(u);
        logEvent(db, { boardId: lane.board_id, cardId: c.id, userId: null, type: 'archived', fromLane: lane.title, toLane: null, ts: now, detail: { auto: true } });
      }
      const left = db.prepare('SELECT id FROM cards WHERE board_id = ? AND lane_id = ? AND archived = 0 ORDER BY position').all(lane.board_id, lane.id);
      const setPos = db.prepare('UPDATE cards SET position = ? WHERE id = ? AND board_id = ?');
      left.forEach((c, i) => setPos.run(i, c.id, lane.board_id));
      db.prepare('UPDATE boards SET version = version + 1 WHERE id = ?').run(lane.board_id);
      const prev = changed.find((x) => x.boardId === lane.board_id);
      if (prev) {
        prev.cardIds.push(...old.map((c) => c.id));
        for (const u of users) prev.users.push(u);
      } else changed.push({ boardId: lane.board_id, cardIds: old.map((c) => c.id), users: [...users] });
    }
  });
  return changed;
}

/** Forget trashed cards older than TRASH_DAYS, with their comments. */
export function purgeTrash(db, now = Date.now()) {
  const old = db.prepare('SELECT board_id, card_id FROM trash WHERE deleted_at < ?').all(now - TRASH_DAYS * DAY);
  if (!old.length) return 0;
  transaction(db, () => {
    for (const t of old) {
      db.prepare('DELETE FROM comments WHERE board_id = ? AND card_id = ?').run(t.board_id, t.card_id);
      db.prepare('DELETE FROM comment_reads WHERE board_id = ? AND card_id = ?').run(t.board_id, t.card_id);
      db.prepare('DELETE FROM trash WHERE board_id = ? AND card_id = ?').run(t.board_id, t.card_id);
    }
  });
  return old.length;
}

/**
 * Everything the Progress view needs for one board, limited to what this person may see.
 * The plugin does the counting (periods, people, projects), so the view stays flexible.
 */
export function boardProgress(db, user, boardId) {
  const vis = visibleProjectIds(db, user);
  const lanes = db.prepare('SELECT id, title, position, mark_complete FROM lanes WHERE board_id = ? ORDER BY position').all(boardId);
  const laneById = new Map(lanes.map((l) => [l.id, l]));
  const cards = db
    // Hidden-archived cards that were finished still count (the Done cleaner puts them there).
    .prepare('SELECT * FROM cards WHERE board_id = ? AND (archived = 0 OR done_at IS NOT NULL)')
    .all(boardId)
    .filter((c) => vis === null || vis.has(c.project_id))
    .map((c) => {
      const lane = laneById.get(c.lane_id);
      return {
        id: c.id,
        title: cardTitle(c.content),
        laneId: c.lane_id,
        laneKey: lane ? laneKey(lane.title) || null : null,
        finished: !!c.archived || isFinishedLane(lane),
        assignees: safeArr(c.assignees),
        projectId: c.project_id || null,
        createdAt: c.created_at,
        createdBy: c.created_by,
        doneAt: c.done_at,
        doneBy: c.done_by,
        doneEstimated: !!c.done_estimated,
        due: dueOf(c.content),
        priority: priorityOf(c.content),
      };
    });
  const trashCount = listTrash(db, user, boardId).length;
  // Cards pulled out of the Backlog ("planned"), for the last half year.
  const visible = new Set(cards.map((c) => c.id));
  const pulled = db
    .prepare("SELECT card_id, from_lane, to_lane, ts FROM card_events WHERE board_id = ? AND type = 'moved' AND ts > ? ORDER BY ts")
    .all(boardId, Date.now() - 183 * DAY)
    .filter((e) => visible.has(e.card_id) && laneKey(e.from_lane || '') === 'backlog' && laneKey(e.to_lane || '') !== 'backlog')
    .map((e) => ({ cardId: e.card_id, ts: e.ts }));
  const trackingSince = Number(db.prepare("SELECT value FROM meta WHERE key = 'progress'").get()?.value || 0);
  return {
    now: Date.now(),
    trackingSince,
    lanes: lanes.map((l) => ({ id: l.id, title: l.title, key: laneKey(l.title) || null, finished: isFinishedLane(l) })),
    cards,
    trashCount,
    pulled,
  };
}

// ---------- small helpers ----------

export function safeArr(v) {
  if (Array.isArray(v)) return v;
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export function cardTitle(content) {
  const first = String(content || '').split('\n')[0];
  return (
    first
      .replace(/\[[^\]]*::[^\]]*\]/g, '')
      .replace(/@\{[^}]*\}/g, '')
      .replace(/(^|\s)#[^\s#]+/g, ' ')
      .replace(/\s\^[\w-]+$/, '')
      .replace(/\s+/g, ' ')
      .trim() || 'Untitled card'
  );
}

export function dueOf(content) {
  const m = /@\{(\d{4}-\d{2}-\d{2})/.exec(String(content || '').split('\n')[0]);
  return m ? m[1] : null;
}

export function priorityOf(content) {
  const m = /\[priority::\s*(\d)\s*\]/i.exec(String(content || ''));
  return m ? Number(m[1]) : null;
}
