import { laneKey } from './lanes.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newId(len = 10) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

export function newToken() {
  return randomBytes(24).toString('hex');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'kanban.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** Run fn inside a transaction; rolls back and rethrows on error. */
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS board_members (
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (board_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS lanes (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      position INTEGER NOT NULL,
      mark_complete INTEGER NOT NULL DEFAULT 0,
      max_items INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS lanes_board ON lanes(board_id, position);
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      lane_id TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL DEFAULT '',
      checked INTEGER NOT NULL DEFAULT 0,
      check_char TEXT NOT NULL DEFAULT ' ',
      assignees TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_moved INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cards_board ON cards(board_id, archived, lane_id, position);
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS comments_card ON comments(board_id, card_id, created_at);
    CREATE TABLE IF NOT EXISTS client_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      ts INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      level TEXT NOT NULL,
      context TEXT NOT NULL,
      message TEXT NOT NULL,
      stack TEXT,
      count INTEGER NOT NULL DEFAULT 1,
      meta TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS client_logs_ts ON client_logs(received_at);
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_by TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  // Per-user read marker for card comments. When the table is first created, everything
  // already there counts as read so nobody starts with a wall of "new" badges.
  const hadReads = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='comment_reads'").get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS comment_reads (
      user_id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      last_read_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, board_id, card_id)
    );
  `);
  if (!hadReads) {
    db.prepare(
      `INSERT OR IGNORE INTO comment_reads (user_id, board_id, card_id, last_read_at)
       SELECT u.id, m.board_id, m.card_id, ? FROM users u CROSS JOIN (SELECT DISTINCT board_id, card_id FROM comments) m`
    ).run(Date.now());
  }
  const boardCols = db.prepare('PRAGMA table_info(boards)').all().map((c) => c.name);
  if (!boardCols.includes('settings')) {
    db.exec("ALTER TABLE boards ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
  }
  // Every board has an Archive list after Done (added once to boards created before it existed).
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  if (!db.prepare("SELECT value FROM meta WHERE key = 'archive-lane'").get()) {
    for (const b of db.prepare('SELECT id FROM boards').all()) {
      const lanes = db.prepare('SELECT title, position FROM lanes WHERE board_id = ?').all(b.id);
      if (lanes.some((l) => laneKey(l.title) === 'archive')) continue;
      const pos = lanes.reduce((m, l) => Math.max(m, l.position), -1) + 1;
      db.prepare(
        'INSERT INTO lanes (id, board_id, title, position, mark_complete, max_items) VALUES (?, ?, ?, ?, 0, 0)'
      ).run(newId(10), b.id, 'Archive', pos);
      db.prepare('UPDATE boards SET version = version + 1 WHERE id = ?').run(b.id);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('archive-lane', ?)").run(String(Date.now()));
  }
  const commentCols = db.prepare('PRAGMA table_info(comments)').all().map((c) => c.name);
  if (!commentCols.includes('reply_to')) {
    db.exec('ALTER TABLE comments ADD COLUMN reply_to TEXT');
  }
  if (!commentCols.includes('edited_at')) {
    db.exec('ALTER TABLE comments ADD COLUMN edited_at INTEGER');
  }
}

export function parseSettings(str) {
  try {
    const v = JSON.parse(str || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// ---------- users ----------

export function createUser(db, name) {
  const token = newToken();
  const user = { id: newId(8), name: name.trim(), created_at: Date.now() };
  db.prepare('INSERT INTO users (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').run(
    user.id,
    user.name,
    hashToken(token),
    user.created_at
  );
  return { ...user, token };
}

export function userByToken(db, token) {
  if (!token) return null;
  return (
    db
      .prepare('SELECT id, name FROM users WHERE token_hash = ? AND disabled = 0')
      .get(hashToken(token)) || null
  );
}

export function listUsers(db) {
  return db.prepare('SELECT id, name FROM users WHERE disabled = 0 ORDER BY name').all();
}

export function disableUser(db, id) {
  return db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(id).changes > 0;
}

// ---------- boards ----------

export const DEFAULT_LANES = ['To Do', 'In Progress', 'Done', 'Archive'];

export function createBoard(db, user, name, laneTitles = DEFAULT_LANES) {
  if (!laneTitles.length) laneTitles = DEFAULT_LANES;
  const id = newId(10);
  const now = Date.now();
  transaction(db, () => {
    db.prepare('INSERT INTO boards (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      name.trim(),
      user.id,
      now
    );
    db.prepare('INSERT INTO board_members (board_id, user_id, joined_at) VALUES (?, ?, ?)').run(
      id,
      user.id,
      now
    );
    const insLane = db.prepare(
      'INSERT INTO lanes (id, board_id, title, position) VALUES (?, ?, ?, ?)'
    );
    laneTitles.forEach((title, i) => insLane.run(newId(10), id, String(title).trim(), i));
  });
  return getBoardMeta(db, id);
}

export function getBoardMeta(db, id) {
  const b = db.prepare('SELECT id, name, version, created_by, created_at, settings FROM boards WHERE id = ?').get(id);
  return b ? { ...b, settings: parseSettings(b.settings) } : null;
}

export function listBoards(db, user) {
  return db
    .prepare(
      `SELECT b.id, b.name, b.version, b.created_at,
              EXISTS(SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = ?) AS joined,
              (SELECT COUNT(*) FROM board_members m WHERE m.board_id = b.id) AS member_count
       FROM boards b ORDER BY b.name`
    )
    .all(user.id)
    .map((b) => ({ ...b, joined: !!b.joined }));
}

export function joinBoard(db, user, boardId) {
  db.prepare(
    'INSERT OR IGNORE INTO board_members (board_id, user_id, joined_at) VALUES (?, ?, ?)'
  ).run(boardId, user.id, Date.now());
}

export function leaveBoard(db, user, boardId) {
  db.prepare('DELETE FROM board_members WHERE board_id = ? AND user_id = ?').run(boardId, user.id);
}

export function deleteBoard(db, boardId) {
  return db.prepare('DELETE FROM boards WHERE id = ?').run(boardId).changes > 0;
}

export function isMember(db, user, boardId) {
  return !!db
    .prepare('SELECT 1 FROM board_members WHERE board_id = ? AND user_id = ?')
    .get(boardId, user.id);
}

export function boardMembers(db, boardId) {
  return db
    .prepare(
      `SELECT u.id, u.name FROM board_members m JOIN users u ON u.id = m.user_id
       WHERE m.board_id = ? AND u.disabled = 0 ORDER BY u.name`
    )
    .all(boardId);
}

function rowToLane(r) {
  return {
    id: r.id,
    title: r.title,
    position: r.position,
    markComplete: !!r.mark_complete,
    maxItems: r.max_items || 0,
  };
}

export function rowToCard(r) {
  return {
    id: r.id,
    boardId: r.board_id,
    laneId: r.lane_id,
    position: r.position,
    content: r.content,
    checked: !!r.checked,
    checkChar: r.check_char || ' ',
    assignees: safeJson(r.assignees, []),
    version: r.version,
    archived: !!r.archived,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastMoved: r.last_moved,
    commentCount: r.comment_count || 0,
    ...(r.unread_comments !== undefined ? { unreadComments: r.unread_comments || 0 } : {}),
    ...(r.edited_comments !== undefined ? { editedComments: r.edited_comments || 0 } : {}),
  };
}

const COMMENT_COUNT =
  '(SELECT COUNT(*) FROM comments m WHERE m.board_id = c.board_id AND m.card_id = c.id) AS comment_count';

const READ_AT = `COALESCE((SELECT r.last_read_at FROM comment_reads r
      WHERE r.user_id = ? AND r.board_id = c.board_id AND r.card_id = c.id), 0)`;

// Comments by others the user hasn't seen: new ones, and old ones edited since they read them.
// Binds (userId, userId, userId, userId).
const UNREAD_COMMENTS = `(SELECT COUNT(*) FROM comments m
  WHERE m.board_id = c.board_id AND m.card_id = c.id AND m.user_id != ?
    AND m.created_at > ${READ_AT}) AS unread_comments,
  (SELECT COUNT(*) FROM comments m
  WHERE m.board_id = c.board_id AND m.card_id = c.id AND m.user_id != ?
    AND m.created_at <= ${READ_AT} AND m.edited_at > ${READ_AT}) AS edited_comments`;

function safeJson(str, fallback) {
  try {
    const v = JSON.parse(str);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function getBoardSnapshot(db, boardId, userId = null) {
  const board = getBoardMeta(db, boardId);
  if (!board) return null;
  const lanes = db
    .prepare('SELECT * FROM lanes WHERE board_id = ? ORDER BY position')
    .all(boardId)
    .map(rowToLane);
  const cards = (
    userId
      ? db
          .prepare(
            `SELECT c.*, ${COMMENT_COUNT}, ${UNREAD_COMMENTS} FROM cards c WHERE c.board_id = ? ORDER BY c.archived, c.lane_id, c.position`
          )
          .all(userId, userId, userId, userId, userId, boardId)
      : db
          .prepare(`SELECT c.*, ${COMMENT_COUNT} FROM cards c WHERE c.board_id = ? ORDER BY c.archived, c.lane_id, c.position`)
          .all(boardId)
  ).map(rowToCard);
  return {
    board,
    lanes,
    cards: cards.filter((c) => !c.archived),
    archive: cards.filter((c) => c.archived),
    members: boardMembers(db, boardId),
  };
}

export function myCards(db, user) {
  // JSON array membership check; assignees are short lists so LIKE is fine, then verify in JS.
  const rows = db
    .prepare(
      `SELECT c.*, b.name AS board_name, l.title AS lane_title, ${COMMENT_COUNT}, ${UNREAD_COMMENTS}
       FROM cards c
       JOIN boards b ON b.id = c.board_id
       LEFT JOIN lanes l ON l.id = c.lane_id
       WHERE c.archived = 0 AND c.assignees LIKE ?
       ORDER BY b.name, l.position, c.position`
    )
    .all(user.id, user.id, user.id, user.id, user.id, `%"${user.id}"%`);
  return rows
    .map((r) => ({ ...rowToCard(r), boardName: r.board_name, laneTitle: r.lane_title }))
    .filter((c) => c.assignees.includes(user.id));
}

export function renameUser(db, id, name) {
  return db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), id).changes > 0;
}

// ---------- comments ----------

export function listComments(db, boardId, cardId) {
  return db
    .prepare(
      `SELECT m.id, m.card_id AS cardId, m.user_id AS userId, u.name AS userName, m.body,
              m.created_at AS createdAt, m.updated_at AS updatedAt, m.reply_to AS replyTo,
              m.edited_at AS editedAt
       FROM comments m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.board_id = ? AND m.card_id = ? ORDER BY m.created_at`
    )
    .all(boardId, cardId);
}

export function addComment(db, user, boardId, cardId, body, replyTo = null) {
  const id = newId(12);
  const now = Date.now();
  db.prepare(
    'INSERT INTO comments (id, board_id, card_id, user_id, body, created_at, updated_at, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, boardId, cardId, user.id, body, now, now, replyTo);
  return listComments(db, boardId, cardId).find((c) => c.id === id);
}

/** When the user last read this card's comments (0 = never). */
export function commentsReadAt(db, user, boardId, cardId) {
  const r = db
    .prepare('SELECT last_read_at FROM comment_reads WHERE user_id = ? AND board_id = ? AND card_id = ?')
    .get(user.id, boardId, cardId);
  return r ? r.last_read_at : 0;
}

export function markCommentsRead(db, user, boardId, cardId, at = Date.now()) {
  db.prepare(
    `INSERT INTO comment_reads (user_id, board_id, card_id, last_read_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, board_id, card_id) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`
  ).run(user.id, boardId, cardId, at);
}

export function editComment(db, boardId, id, body) {
  const now = Date.now();
  db.prepare('UPDATE comments SET body = ?, updated_at = ?, edited_at = ? WHERE id = ? AND board_id = ?').run(
    body,
    now,
    now,
    id,
    boardId
  );
}

export function getComment(db, boardId, id) {
  return db.prepare('SELECT * FROM comments WHERE id = ? AND board_id = ?').get(id, boardId) || null;
}

export function deleteComment(db, boardId, id) {
  return db.prepare('DELETE FROM comments WHERE id = ? AND board_id = ?').run(id, boardId).changes > 0;
}

export function cardExists(db, boardId, cardId) {
  return !!db.prepare('SELECT 1 FROM cards WHERE id = ? AND board_id = ?').get(cardId, boardId);
}

export function cardAssignees(db, boardId, cardId) {
  const r = db.prepare('SELECT assignees FROM cards WHERE id = ? AND board_id = ?').get(cardId, boardId);
  return r ? safeJson(r.assignees, []) : [];
}

// ---------- files ----------

export function addFile(db, user, boardId, { id, name, mime, size }) {
  db.prepare(
    'INSERT INTO files (id, board_id, name, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, boardId, name, mime, size, user.id, Date.now());
}

export function getFile(db, id) {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id) || null;
}

// ---------- client error logs ----------

const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function clip(v, n) {
  return v == null ? null : String(v).slice(0, n);
}

/** Store error reports sent by a plugin; returns how many were stored. */
export function addClientLogs(db, user, entries, meta) {
  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO client_logs (user_id, ts, received_at, level, context, message, stack, count, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let n = 0;
  for (const e of entries.slice(0, 100)) {
    if (!e || typeof e !== 'object' || !e.message) continue;
    ins.run(
      user.id,
      Number(e.ts) || now,
      now,
      clip(e.level || 'error', 16),
      clip(e.context || 'unknown', 120),
      clip(e.message, 4000),
      clip(e.stack, 12000),
      Math.max(1, Math.min(Number(e.count) || 1, 100000)),
      JSON.stringify({ ...meta, ...(e.meta && typeof e.meta === 'object' ? e.meta : {}) }).slice(0, 4000)
    );
    n++;
  }
  db.prepare('DELETE FROM client_logs WHERE received_at < ?').run(now - LOG_RETENTION_MS);
  return n;
}

export function listClientLogs(db, { since = 0, userId = null, limit = 200 } = {}) {
  const rows = db
    .prepare(
      `SELECT l.*, u.name AS user_name FROM client_logs l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.received_at >= ? AND (? IS NULL OR l.user_id = ?)
       ORDER BY l.received_at DESC, l.id DESC LIMIT ?`
    )
    .all(since, userId, userId, Math.min(limit, 2000));
  return rows.map((r) => {
    let meta = {};
    try {
      meta = JSON.parse(r.meta) || {};
    } catch {
      /* keep {} */
    }
    return { ...r, meta };
  });
}
