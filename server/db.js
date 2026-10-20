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
  // Every board gets a Backlog list (ideas and "later"), last, after Archive.
  if (!db.prepare("SELECT value FROM meta WHERE key = 'backlog-lane'").get()) {
    for (const b of db.prepare('SELECT id FROM boards').all()) {
      const lanes = db.prepare('SELECT title, position FROM lanes WHERE board_id = ?').all(b.id);
      if (lanes.some((l) => laneKey(l.title) === 'backlog')) continue;
      const pos = lanes.reduce((m, l) => Math.max(m, l.position), -1) + 1;
      db.prepare(
        'INSERT INTO lanes (id, board_id, title, position, mark_complete, max_items) VALUES (?, ?, ?, ?, 0, 0)'
      ).run(newId(10), b.id, 'Backlog', pos);
      db.prepare('UPDATE boards SET version = version + 1 WHERE id = ?').run(b.id);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('backlog-lane', ?)").run(String(Date.now()));
  }
  const commentCols = db.prepare('PRAGMA table_info(comments)').all().map((c) => c.name);
  if (!commentCols.includes('reply_to')) {
    db.exec('ALTER TABLE comments ADD COLUMN reply_to TEXT');
  }
  if (!commentCols.includes('edited_at')) {
    db.exec('ALTER TABLE comments ADD COLUMN edited_at INTEGER');
  }

  // Roles: one owner (sees everything), hosts (manage people and their own projects), users.
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }
  if (!db.prepare("SELECT 1 FROM users WHERE role = 'owner'").get()) {
    const first = db.prepare('SELECT id FROM users WHERE disabled = 0 ORDER BY created_at, rowid LIMIT 1').get();
    if (first) db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(first.id);
  }

  // Projects: every card belongs to one; people see only cards of projects they're in.
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, user_id)
    );
  `);
  const cardCols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
  if (!cardCols.includes('project_id')) {
    db.exec('ALTER TABLE cards ADD COLUMN project_id TEXT');
  }
  // Cards made before projects existed go to "General", which everyone is in.
  if (!db.prepare("SELECT value FROM meta WHERE key = 'projects'").get()) {
    transaction(db, () => {
      const now = Date.now();
      let general = db.prepare("SELECT id FROM projects WHERE name = 'General'").get();
      if (!general) {
        general = { id: newId(10) };
        db.prepare('INSERT INTO projects (id, name, color, created_by, created_at) VALUES (?, ?, ?, NULL, ?)').run(
          general.id,
          'General',
          PROJECT_COLORS[0],
          now
        );
      }
      db.prepare('UPDATE cards SET project_id = ? WHERE project_id IS NULL').run(general.id);
      db.prepare(
        'INSERT OR IGNORE INTO project_members (project_id, user_id, added_at) SELECT ?, id, ? FROM users WHERE disabled = 0'
      ).run(general.id, now);
      db.prepare("INSERT INTO meta (key, value) VALUES ('projects', ?)").run(String(now));
    });
  }

  // Devices: one key per phone/computer, all signing in as the same person, so a lost
  // phone can be removed without signing out the rest. The user's own token (the join
  // link a host hands out) keeps working; plugins trade it for a device key on first use.
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT '',
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id);
    CREATE TABLE IF NOT EXISTS pairing_codes (
      code_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_by_device TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
  `);
}

export const ROLES = ['owner', 'host', 'user'];
export const PROJECT_COLORS = ['#5c7cfa', '#20c997', '#f76707', '#e64980', '#7950f2', '#fab005', '#15aabf', '#82c91e', '#fa5252', '#868e96'];

export function parseSettings(str) {
  try {
    const v = JSON.parse(str || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// ---------- users ----------

/**
 * Names are unique, but removed people only get disabled (their comments and cards keep
 * pointing at them). Give a removed person's name back by renaming them to
 * "Name (removed)", so a new person, or the same one again, can use it.
 */
export function freeNameOfRemoved(db, name) {
  const clean = String(name || '').trim();
  const old = db.prepare('SELECT id FROM users WHERE name = ? AND disabled = 1').get(clean);
  if (!old) return;
  let next = `${clean} (removed)`;
  for (let i = 2; db.prepare('SELECT 1 FROM users WHERE name = ?').get(next); i++) next = `${clean} (removed ${i})`;
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(next, old.id);
}

export function createUser(db, name, role = 'user') {
  freeNameOfRemoved(db, name);
  const token = newToken();
  if (!ROLES.includes(role)) role = 'user';
  // The first person on a fresh server owns it.
  if (!db.prepare("SELECT 1 FROM users WHERE role = 'owner' AND disabled = 0").get()) role = 'owner';
  const user = { id: newId(8), name: name.trim(), role, created_at: Date.now() };
  db.prepare('INSERT INTO users (id, name, token_hash, created_at, role) VALUES (?, ?, ?, ?, ?)').run(
    user.id,
    user.name,
    hashToken(token),
    user.created_at,
    role
  );
  return { ...user, token };
}

/** Users made with the admin token or the CLI start in "General", like everyone did before projects. */
export function addToGeneral(db, userId) {
  const g = db.prepare("SELECT id FROM projects WHERE name = 'General'").get();
  if (g) addProjectMember(db, g.id, userId);
}

/** Issue a new token for a user; the old one stops working. */
export function resetToken(db, id) {
  const token = newToken();
  const ok = db.prepare('UPDATE users SET token_hash = ? WHERE id = ? AND disabled = 0').run(hashToken(token), id).changes > 0;
  return ok ? token : null;
}

export function getUser(db, id) {
  return db.prepare('SELECT id, name, role, disabled FROM users WHERE id = ?').get(id) || null;
}

export function setUserRole(db, id, role) {
  return db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id).changes > 0;
}

/**
 * The person a token signs in as. Accepts the user's own token (the join link) and
 * device keys. `deviceId` is null for the user's own token.
 */
export function userByToken(db, token) {
  if (!token) return null;
  const hash = hashToken(token);
  const u = db.prepare('SELECT id, name, role FROM users WHERE token_hash = ? AND disabled = 0').get(hash);
  if (u) return { ...u, deviceId: null };
  const d = db
    .prepare(
      `SELECT u.id, u.name, u.role, d.id AS deviceId, d.last_seen AS lastSeen FROM devices d
       JOIN users u ON u.id = d.user_id
       WHERE d.token_hash = ? AND d.revoked_at IS NULL AND u.disabled = 0`
    )
    .get(hash);
  if (!d) return null;
  const now = Date.now();
  if (now - d.lastSeen > 60_000) db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now, d.deviceId);
  return { id: d.id, name: d.name, role: d.role, deviceId: d.deviceId };
}

// ---------- devices ----------

export const PAIRING_TTL_MS = 10 * 60 * 1000;
const PLATFORMS = ['ios', 'android', 'mac', 'windows', 'linux', ''];

export function cleanDeviceName(v) {
  const name = String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  return name || 'Device';
}

function cleanPlatform(v) {
  const p = String(v ?? '').toLowerCase();
  return PLATFORMS.includes(p) ? p : '';
}

function rowToDevice(r) {
  return { id: r.id, name: r.name, platform: r.platform, createdAt: r.created_at, lastSeen: r.last_seen };
}

/** A new device key for userId. The key is returned once and only its hash is stored. */
export function createDevice(db, userId, name, platform) {
  const token = newToken();
  const now = Date.now();
  const id = newId(10);
  db.prepare(
    'INSERT INTO devices (id, user_id, name, platform, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, userId, cleanDeviceName(name), cleanPlatform(platform), hashToken(token), now, now);
  return { token, device: rowToDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(id)) };
}

export function listDevices(db, userId) {
  return db
    .prepare('SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen DESC')
    .all(userId)
    .map(rowToDevice);
}

export function getDevice(db, userId, id) {
  const r = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL').get(id, userId);
  return r ? rowToDevice(r) : null;
}

export function renameDevice(db, userId, id, name) {
  return (
    db
      .prepare('UPDATE devices SET name = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .run(cleanDeviceName(name), id, userId).changes > 0
  );
}

export function revokeDevice(db, userId, id) {
  return (
    db
      .prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .run(Date.now(), id, userId).changes > 0
  );
}

/** A single-use code that signs a new device in as `user`. Shown as a QR code / link. */
export function createPairingCode(db, user) {
  const now = Date.now();
  db.prepare('DELETE FROM pairing_codes WHERE expires_at < ? OR used_at IS NOT NULL').run(now - PAIRING_TTL_MS);
  // Only the newest few codes per person stay valid.
  db.prepare(
    `DELETE FROM pairing_codes WHERE user_id = ? AND used_at IS NULL AND code_hash NOT IN (
       SELECT code_hash FROM pairing_codes WHERE user_id = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 4)`
  ).run(user.id, user.id);
  const code = newId(24);
  const expiresAt = now + PAIRING_TTL_MS;
  db.prepare(
    'INSERT INTO pairing_codes (code_hash, user_id, created_by_device, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(hashToken(code), user.id, user.deviceId || null, now, expiresAt);
  return { code, expiresAt };
}

/** Trade a pairing code for a device key. Null when the code is unknown, used or expired. */
export function redeemPairingCode(db, code, name, platform) {
  if (!code || typeof code !== 'string') return null;
  return transaction(db, () => {
    const now = Date.now();
    const row = db
      .prepare(
        `SELECT p.code_hash, p.user_id FROM pairing_codes p JOIN users u ON u.id = p.user_id
         WHERE p.code_hash = ? AND p.used_at IS NULL AND p.expires_at > ? AND u.disabled = 0`
      )
      .get(hashToken(code.trim()), now);
    if (!row) return null;
    db.prepare('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?').run(now, row.code_hash);
    const { token, device } = createDevice(db, row.user_id, name, platform);
    const user = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(row.user_id);
    return { token, device, user };
  });
}

export function listUsers(db) {
  return db.prepare('SELECT id, name, role FROM users WHERE disabled = 0 ORDER BY name').all();
}

/** Users the given user may see: everyone for the owner, otherwise people who share a project. */
export function visibleUsers(db, user) {
  if (user.role === 'owner') return listUsers(db);
  return db
    .prepare(
      `SELECT DISTINCT u.id, u.name, u.role FROM users u
       WHERE u.disabled = 0 AND (u.id = ? OR u.id IN (
         SELECT b.user_id FROM project_members a JOIN project_members b ON b.project_id = a.project_id
         WHERE a.user_id = ?))
       ORDER BY u.name`
    )
    .all(user.id, user.id);
}

// ---------- projects ----------

/** Project ids the user can see, or null when they can see every project (the owner). */
export function visibleProjectIds(db, user) {
  if (user.role === 'owner') return null;
  return new Set(
    db.prepare('SELECT project_id FROM project_members WHERE user_id = ?').all(user.id).map((r) => r.project_id)
  );
}

export function canSeeProject(db, user, projectId) {
  const vis = visibleProjectIds(db, user);
  return vis === null ? !!getProject(db, projectId) : vis.has(projectId);
}

export function getProject(db, id) {
  return db.prepare('SELECT id, name, color, created_by, created_at FROM projects WHERE id = ?').get(id) || null;
}

/** Projects visible to the user, with member ids and card counts. */
export function listProjects(db, user) {
  const vis = visibleProjectIds(db, user);
  const members = new Map();
  for (const r of db
    .prepare('SELECT m.project_id, m.user_id FROM project_members m JOIN users u ON u.id = m.user_id WHERE u.disabled = 0')
    .all()) {
    if (!members.has(r.project_id)) members.set(r.project_id, []);
    members.get(r.project_id).push(r.user_id);
  }
  return db
    .prepare(
      `SELECT p.id, p.name, p.color, p.created_at AS createdAt,
              (SELECT COUNT(*) FROM cards c WHERE c.project_id = p.id) AS cardCount
       FROM projects p ORDER BY p.name COLLATE NOCASE`
    )
    .all()
    .filter((p) => vis === null || vis.has(p.id))
    .map((p) => ({ ...p, memberIds: members.get(p.id) || [] }));
}

export function createProject(db, user, name, color) {
  const id = newId(10);
  const count = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  transaction(db, () => {
    db.prepare('INSERT INTO projects (id, name, color, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      name.trim(),
      color || PROJECT_COLORS[count % PROJECT_COLORS.length],
      user.id,
      Date.now()
    );
    db.prepare('INSERT INTO project_members (project_id, user_id, added_at) VALUES (?, ?, ?)').run(id, user.id, Date.now());
  });
  return getProject(db, id);
}

export function updateProject(db, id, { name, color }) {
  const p = getProject(db, id);
  if (!p) return false;
  db.prepare('UPDATE projects SET name = ?, color = ? WHERE id = ?').run(
    name != null ? String(name).trim() : p.name,
    color != null ? String(color) : p.color,
    id
  );
  return true;
}

export function deleteProject(db, id) {
  return db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
}

export function projectCardCount(db, id) {
  return db.prepare('SELECT COUNT(*) AS n FROM cards WHERE project_id = ?').get(id).n;
}

export function addProjectMember(db, projectId, userId) {
  db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, added_at) VALUES (?, ?, ?)').run(
    projectId,
    userId,
    Date.now()
  );
}

export function removeProjectMember(db, projectId, userId) {
  return db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, userId).changes > 0;
}

export function userProjectIds(db, userId) {
  return db.prepare('SELECT project_id FROM project_members WHERE user_id = ?').all(userId).map((r) => r.project_id);
}

/** Project a card made without one goes to: General if the user is in it, else their first project. */
export function defaultProjectId(db, user) {
  const vis = visibleProjectIds(db, user);
  const all = db.prepare('SELECT id, name FROM projects ORDER BY name COLLATE NOCASE').all();
  const mine = vis === null ? all : all.filter((p) => vis.has(p.id));
  return (mine.find((p) => p.name === 'General') || mine[0])?.id ?? null;
}

export function disableUser(db, id) {
  return db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(id).changes > 0;
}

// ---------- boards ----------

export const DEFAULT_LANES = ['To Do', 'In Progress', 'Done', 'Archive', 'Backlog'];

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
    projectId: r.project_id || null,
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

export function getBoardSnapshot(db, boardId, user = null) {
  const board = getBoardMeta(db, boardId);
  if (!board) return null;
  const lanes = db
    .prepare('SELECT * FROM lanes WHERE board_id = ? ORDER BY position')
    .all(boardId)
    .map(rowToLane);
  const userId = user?.id ?? null;
  const vis = user ? visibleProjectIds(db, user) : null;
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
  )
    .filter((r) => vis === null || vis.has(r.project_id))
    .map(rowToCard);
  let members = boardMembers(db, boardId);
  if (user && user.role !== 'owner') {
    const seen = new Set(visibleUsers(db, user).map((u) => u.id));
    members = members.filter((m) => seen.has(m.id));
  }
  return {
    board,
    lanes,
    cards: cards.filter((c) => !c.archived),
    archive: cards.filter((c) => c.archived),
    members,
    ...(user ? { projects: listProjects(db, user).map(({ cardCount, ...p }) => p), role: user.role } : {}),
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
  const vis = visibleProjectIds(db, user);
  return rows
    .filter((r) => vis === null || vis.has(r.project_id))
    .map((r) => ({ ...rowToCard(r), boardName: r.board_name, laneTitle: r.lane_title }))
    .filter((c) => c.assignees.includes(user.id));
}

export function renameUser(db, id, name) {
  freeNameOfRemoved(db, name);
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

/** True when the card exists and the user may see it. */
export function canSeeCard(db, user, boardId, cardId) {
  const r = db.prepare('SELECT project_id FROM cards WHERE id = ? AND board_id = ?').get(cardId, boardId);
  if (!r) return false;
  const vis = visibleProjectIds(db, user);
  return vis === null || vis.has(r.project_id);
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
