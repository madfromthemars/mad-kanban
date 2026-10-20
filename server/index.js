import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { WebSocketServer } from 'ws';

import {
  addClientLogs,
  editComment,
  commentsReadAt,
  markCommentsRead,
  listClientLogs,
  addComment,
  addFile,
  boardMembers,
  cardAssignees,
  cardExists,
  deleteComment,
  getComment,
  getFile,
  listComments,
  newId,
  createBoard,
  createUser,
  deleteBoard,
  disableUser,
  getBoardMeta,
  getBoardSnapshot,
  isMember,
  joinBoard,
  leaveBoard,
  listBoards,
  listUsers,
  myCards,
  openDb,
  userByToken,
  createDevice,
  createPairingCode,
  getDevice,
  listDevices,
  redeemPairingCode,
  renameDevice,
  revokeDevice,
  addProjectMember,
  canSeeCard,
  canSeeProject,
  createProject,
  deleteProject,
  getProject,
  getUser,
  listProjects,
  projectCardCount,
  removeProjectMember,
  resetToken,
  setUserRole,
  renameUser,
  transaction,
  userProjectIds,
  visibleProjectIds,
  visibleUsers,
  updateProject,
  addToGeneral,
} from './db.js';
import { OpError, applyOps, detectReupload, orderOps } from './ops.js';
import { createNotifier } from './notify.js';

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || './data';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
// Set on the old host after a server move: plugin releases keep being served (so
// stragglers can update), attachment links redirect, everything else answers 410
// with { movedTo } and plugins >= 2.1.35 switch over by themselves.
const MOVED_TO = (process.env.MOVED_TO || '').replace(/\/+$/, '');

const db = openDb(DATA_DIR);
const notifier = createNotifier(db);
const FILES_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(import.meta.dirname, 'public');
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 300) * 1024 * 1024;

export function joinString(token) {
  return `${PUBLIC_URL}/#${token}`;
}

// ---------- helpers ----------

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    // API answers are per-user and change constantly; never let clients cache them.
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new OpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new OpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function requireUser(req) {
  const user = userByToken(db, bearer(req));
  if (!user) throw new OpError(401, 'invalid or missing token');
  return user;
}

function requireAdmin(req) {
  if (!ADMIN_TOKEN) throw new OpError(403, 'ADMIN_TOKEN is not configured on the server');
  if (bearer(req) !== ADMIN_TOKEN) throw new OpError(403, 'admin token required');
}

function requireHost(req) {
  const user = requireUser(req);
  if (user.role !== 'owner' && user.role !== 'host') throw new OpError(403, 'only hosts can manage the team');
  return user;
}

/** 404 for cards the user can't see, so their existence isn't revealed. */
function requireCard(user, boardId, cardId) {
  if (!canSeeCard(db, user, boardId, cardId)) throw new OpError(404, 'card not found');
}

function requireBoard(user, boardId, { member = true } = {}) {
  const board = getBoardMeta(db, boardId);
  if (!board) throw new OpError(404, 'board not found');
  if (member && !isMember(db, user, boardId)) throw new OpError(403, 'join this board first');
  return board;
}

// ---------- audit log (docker compose logs kanban) ----------

const LOGGED = new Set(['card.create', 'card.update', 'card.delete', 'card.archive', 'card.move', 'card.assign', 'lane.create', 'lane.delete', 'lane.update']);

function logOps(user, board, ops, result) {
  if (!Array.isArray(ops)) return;
  ops.forEach((op, i) => {
    if (!op || !LOGGED.has(op.type)) return;
    const r = result.results[i];
    const what = op.content ? ` "${String(op.content).split('\n')[0].slice(0, 60)}"` : '';
    const where = op.laneTitle ? ` -> ${op.laneTitle}` : '';
    const who = op.type === 'card.assign' ? ` ${op.assigned === false ? 'unassign' : 'assign'} ${op.userId}` : '';
    console.log(
      `${new Date().toISOString()} [${board.name}] ${user.name}: ${op.type} ${op.id || ''}${what}${where}${who}${r && !r.ok ? ` FAILED(${r.error})` : ''}`
    );
  });
}

// ---------- websocket fan-out ----------

const sockets = new Set(); // { ws, user }

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const s of sockets) {
    if (s.ws.readyState === s.ws.OPEN) s.ws.send(data);
  }
}

// Tell connected plugins when a new build is published (scripts/release-plugin.sh copies it
// into public/plugin), so they update without waiting for their next periodic check.
let releasedVersion = null;
function readReleasedVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'plugin', 'manifest.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}
releasedVersion = readReleasedVersion();
// "What's new": scripts/release-plugin.sh copies docs/whats-new/<version>.md here as whats-new.md.
// The Telegram bot sends it once per version to everyone connected.
function announceRelease(v) {
  let notes = '';
  try {
    notes = fs.readFileSync(path.join(PUBLIC_DIR, 'plugin', 'whats-new.md'), 'utf8');
    const m = /^<!--\s*version:\s*([\w.-]+)\s*-->/.exec(notes);
    if (m && m[1] !== v) notes = ''; // notes belong to another version
    notes = notes.replace(/^<!--[\s\S]*?-->\s*/, '');
  } catch {
    /* no notes: nothing to announce */
  }
  void notifier.announce(v, notes).catch((e) => console.warn(`announce ${v}: ${e.message}`));
}
setInterval(() => {
  const v = readReleasedVersion();
  if (v && v !== releasedVersion) {
    releasedVersion = v;
    console.log(`${new Date().toISOString()} plugin ${v} released, notifying clients`);
    broadcast({ type: 'plugin.released', version: v, ts: Date.now() });
    announceRelease(v);
  }
}, Number(process.env.RELEASE_CHECK_MS || 20000));

function notifyBoardChanged(board, extra = {}) {
  broadcast({
    type: 'board.changed',
    boardId: board.id,
    version: board.version,
    ts: Date.now(),
    ...extra,
  });
}

// ---------- routes ----------

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp(
    '^' +
      pattern.replace(/:([a-zA-Z]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '/?$'
  );
  routes.push({ method, re, keys, handler });
}

route('GET', '/api/health', () => ({ ok: true, ts: Date.now() }));

// admin
route('POST', '/api/admin/users', async (req) => {
  requireAdmin(req);
  const body = await readJson(req);
  const name = String(body.name || '').trim();
  if (!name) throw new OpError(400, 'name is required');
  try {
    const u = createUser(db, name);
    addToGeneral(db, u.id);
    return { id: u.id, name: u.name, token: u.token, join: joinString(u.token) };
  } catch (e) {
    if (/UNIQUE/.test(String(e.message))) throw new OpError(409, 'a user with that name exists');
    throw e;
  }
});
route('GET', '/api/admin/users', (req) => {
  requireAdmin(req);
  return { users: listUsers(db) };
});
route('DELETE', '/api/admin/users/:id', (req, params) => {
  requireAdmin(req);
  return { ok: disableUser(db, params.id) };
});

// me / users
route('GET', '/api/me', (req) => {
  const user = requireUser(req);
  return { user, device: user.deviceId ? getDevice(db, user.id, user.deviceId) : null };
});

// ---------- devices: one person, many phones/computers ----------

function closeSockets(match) {
  for (const s of sockets) if (match(s.user)) s.ws.close(4001, 'signed out');
}

/** Devices of userId, with `current` marking the one making the request. */
function deviceList(userId, me) {
  return listDevices(db, userId).map((d) => ({ ...d, current: d.id === me.deviceId }));
}

route('GET', '/api/me/devices', (req) => {
  const me = requireUser(req);
  return { devices: deviceList(me.id, me) };
});

// Trade the current sign-in (join link or a copied device key) for this device's own key.
route('POST', '/api/me/devices', async (req) => {
  const me = requireUser(req);
  const body = await readJson(req);
  const { token, device } = createDevice(db, me.id, body.name, body.platform);
  console.log(`${new Date().toISOString()} devices: ${me.name} added "${device.name}" (${device.platform || '?'})`);
  return { token, device: { ...device, current: true } };
});

route('PATCH', '/api/me/devices/:id', async (req, params) => {
  const me = requireUser(req);
  const body = await readJson(req);
  if (!renameDevice(db, me.id, params.id, body.name)) throw new OpError(404, 'device not found');
  return { devices: deviceList(me.id, me) };
});

route('DELETE', '/api/me/devices/:id', (req, params) => {
  const me = requireUser(req);
  const d = getDevice(db, me.id, params.id);
  if (!d || !revokeDevice(db, me.id, params.id)) throw new OpError(404, 'device not found');
  closeSockets((u) => u.deviceId === params.id);
  console.log(`${new Date().toISOString()} devices: ${me.name} removed "${d.name}"`);
  return { devices: deviceList(me.id, me) };
});

// A short-lived, single-use code shown as a QR code; see POST /api/pair. The link uses the
// server's public address, so a phone gets https even when the computer still uses an old one.
route('POST', '/api/me/pairing', (req) => {
  const me = requireUser(req);
  const out = createPairingCode(db, me);
  return { ...out, link: `${PUBLIC_URL}/pair#${out.code}` };
});

// Failed pairing attempts per address, so codes can't be guessed in bulk.
const pairFailures = new Map();
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
}

route('POST', '/api/pair', async (req) => {
  const ip = clientIp(req);
  const now = Date.now();
  const f = pairFailures.get(ip);
  if (f && f.until > now && f.count >= 20) throw new OpError(429, 'too many attempts, try again later');
  const body = await readJson(req);
  const out = redeemPairingCode(db, String(body.code || ''), body.name, body.platform);
  if (!out) {
    const cur = f && f.until > now ? f : { count: 0, until: now + 10 * 60 * 1000 };
    cur.count++;
    pairFailures.set(ip, cur);
    throw new OpError(404, 'this code is invalid, used or expired. Make a new one on your other device');
  }
  console.log(`${new Date().toISOString()} devices: ${out.user.name} signed in "${out.device.name}" with a code`);
  return { token: out.token, user: out.user, device: { ...out.device, current: true } };
});
// Error reports from plugins (see src/ErrorReporter.ts).
route('POST', '/api/client-logs', async (req) => {
  const user = requireUser(req);
  const body = await readJson(req);
  if (!Array.isArray(body.entries)) throw new OpError(400, 'entries must be an array');
  const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};
  const stored = addClientLogs(db, user, body.entries, meta);
  for (const e of body.entries.slice(0, 20)) {
    if (!e?.message) continue;
    console.warn(
      `${new Date().toISOString()} [client-${e.level || 'error'}] ${user.name} v${meta.pluginVersion || '?'} ${e.context || ''}: ${String(e.message).split('\n')[0].slice(0, 200)}${e.count > 1 ? ` (x${e.count})` : ''}`
    );
  }
  return { ok: true, stored };
});
route('GET', '/api/admin/client-logs', (req) => {
  requireAdmin(req);
  const url = new URL(req.url, 'http://x');
  const hours = Number(url.searchParams.get('hours') || 72);
  return {
    logs: listClientLogs(db, {
      since: Date.now() - hours * 3600 * 1000,
      userId: url.searchParams.get('user') || null,
      limit: Number(url.searchParams.get('limit') || 200),
    }),
  };
});
route('GET', '/api/users', (req) => {
  const user = requireUser(req);
  return { users: visibleUsers(db, user) };
});
route('GET', '/api/me/cards', (req) => {
  const user = requireUser(req);
  return { cards: myCards(db, user) };
});

// ---------- team: roles, people, projects (hosts and the owner) ----------
//
// owner: sees every project, can do everything. host: creates hosts/users and projects,
// manages membership of projects they're in, sees only those projects. user: sees only
// cards of projects they're in.

function teamChanged() {
  broadcast({ type: 'team.changed', ts: Date.now() });
  // Visibility may have changed: every client reloads its boards.
  for (const b of db.prepare('SELECT id, version FROM boards').all()) notifyBoardChanged(b);
}

function teamView(me) {
  const projects = listProjects(db, me);
  const vis = visibleProjectIds(db, me);
  const tg = notifier.overview();
  const users = listUsers(db).map((u) => ({
    ...u,
    projectIds: userProjectIds(db, u.id).filter((id) => vis === null || vis.has(id)),
    // Hosts see who gets Telegram notifications (null: the server has no bot).
    telegram: tg.available ? { linked: !!tg.linked[u.id], ...(tg.linked[u.id] || {}) } : null,
  }));
  return { me, users, projects, telegramBot: tg.bot };
}

/** A host may manage users and hosts, but never the owner. */
function requireManageable(me, id) {
  const target = getUser(db, id);
  if (!target || target.disabled) throw new OpError(404, 'user not found');
  if (target.role === 'owner' && me.role !== 'owner') throw new OpError(403, 'only the owner can change the owner');
  return target;
}

function requireProject(me, id) {
  if (!canSeeProject(db, me, id)) throw new OpError(404, 'project not found');
  return getProject(db, id);
}

function cleanName(v, what) {
  const name = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new OpError(400, `${what} name is required`);
  if (name.length > 60) throw new OpError(400, `${what} name is too long`);
  return name;
}

route('GET', '/api/team', (req) => teamView(requireHost(req)));

route('POST', '/api/team/users', async (req) => {
  const me = requireHost(req);
  const body = await readJson(req);
  const name = cleanName(body.name, 'user');
  const role = body.role === 'host' ? 'host' : 'user';
  const projectIds = Array.isArray(body.projectIds) ? body.projectIds.map(String) : [];
  for (const id of projectIds) requireProject(me, id);
  let u;
  try {
    u = transaction(db, () => {
      const created = createUser(db, name, role);
      for (const id of projectIds) addProjectMember(db, id, created.id);
      // New people can open every team board right away; projects decide what they see.
      for (const b of db.prepare('SELECT id FROM boards').all()) joinBoard(db, created, b.id);
      return created;
    });
  } catch (e) {
    if (/UNIQUE/.test(String(e.message))) throw new OpError(409, 'a user with that name exists');
    throw e;
  }
  console.log(`${new Date().toISOString()} team: ${me.name} created ${role} ${u.name}`);
  teamChanged();
  return { user: { id: u.id, name: u.name, role }, join: joinString(u.token) };
});

route('PATCH', '/api/team/users/:id', async (req, params) => {
  const me = requireHost(req);
  const target = requireManageable(me, params.id);
  const body = await readJson(req);
  if (body.name != null) {
    try {
      renameUser(db, target.id, cleanName(body.name, 'user'));
    } catch (e) {
      if (/UNIQUE/.test(String(e.message))) throw new OpError(409, 'a user with that name exists');
      throw e;
    }
  }
  if (body.role != null && body.role !== target.role) {
    if (target.id === me.id) throw new OpError(400, 'you cannot change your own role');
    if (body.role !== 'host' && body.role !== 'user') throw new OpError(400, 'role must be host or user');
    setUserRole(db, target.id, body.role);
  }
  teamChanged();
  return teamView(me);
});

route('POST', '/api/team/users/:id/token', (req, params) => {
  const me = requireHost(req);
  const target = requireManageable(me, params.id);
  if (target.id === me.id) throw new OpError(400, 'reset your own token from another host');
  const token = resetToken(db, target.id);
  // Drop connections signed in with the old link. Devices with their own key stay signed in.
  closeSockets((u) => u.id === target.id && !u.deviceId);
  console.log(`${new Date().toISOString()} team: ${me.name} reset the token of ${target.name}`);
  return { join: joinString(token) };
});

route('GET', '/api/team/users/:id/devices', (req, params) => {
  const me = requireHost(req);
  const target = requireManageable(me, params.id);
  return { devices: deviceList(target.id, me) };
});

route('DELETE', '/api/team/users/:id/devices/:deviceId', (req, params) => {
  const me = requireHost(req);
  const target = requireManageable(me, params.id);
  const d = getDevice(db, target.id, params.deviceId);
  if (!d || !revokeDevice(db, target.id, params.deviceId)) throw new OpError(404, 'device not found');
  closeSockets((u) => u.deviceId === params.deviceId);
  console.log(`${new Date().toISOString()} devices: ${me.name} removed "${d.name}" of ${target.name}`);
  return { devices: deviceList(target.id, me) };
});

route('DELETE', '/api/team/users/:id', (req, params) => {
  const me = requireHost(req);
  const target = requireManageable(me, params.id);
  if (target.id === me.id) throw new OpError(400, 'you cannot remove yourself');
  if (target.role === 'host' && me.role !== 'owner') throw new OpError(403, 'only the owner can remove a host');
  disableUser(db, target.id);
  for (const s of sockets) if (s.user.id === target.id) s.ws.close();
  console.log(`${new Date().toISOString()} team: ${me.name} removed ${target.name}`);
  teamChanged();
  return teamView(me);
});

route('POST', '/api/team/projects', async (req) => {
  const me = requireHost(req);
  const body = await readJson(req);
  const name = cleanName(body.name, 'project');
  try {
    createProject(db, me, name, body.color ? String(body.color) : undefined);
  } catch (e) {
    if (/UNIQUE/.test(String(e.message))) throw new OpError(409, 'a project with that name exists');
    throw e;
  }
  console.log(`${new Date().toISOString()} team: ${me.name} created project ${name}`);
  teamChanged();
  return teamView(me);
});

route('PATCH', '/api/team/projects/:id', async (req, params) => {
  const me = requireHost(req);
  const p = requireProject(me, params.id);
  const body = await readJson(req);
  try {
    updateProject(db, p.id, {
      name: body.name != null ? cleanName(body.name, 'project') : null,
      color: body.color != null ? String(body.color).slice(0, 20) : null,
    });
  } catch (e) {
    if (/UNIQUE/.test(String(e.message))) throw new OpError(409, 'a project with that name exists');
    throw e;
  }
  teamChanged();
  return teamView(me);
});

route('DELETE', '/api/team/projects/:id', (req, params) => {
  const me = requireHost(req);
  const p = requireProject(me, params.id);
  const n = projectCardCount(db, p.id);
  if (n) throw new OpError(409, `move or delete its ${n} card${n === 1 ? '' : 's'} first`);
  deleteProject(db, p.id);
  console.log(`${new Date().toISOString()} team: ${me.name} deleted project ${p.name}`);
  teamChanged();
  return teamView(me);
});

route('PUT', '/api/team/projects/:id/members/:userId', (req, params) => {
  const me = requireHost(req);
  const p = requireProject(me, params.id);
  const target = getUser(db, params.userId);
  if (!target || target.disabled) throw new OpError(404, 'user not found');
  addProjectMember(db, p.id, target.id);
  teamChanged();
  return teamView(me);
});

route('DELETE', '/api/team/projects/:id/members/:userId', (req, params) => {
  const me = requireHost(req);
  const p = requireProject(me, params.id);
  removeProjectMember(db, p.id, params.userId);
  teamChanged();
  return teamView(me);
});

// boards
route('GET', '/api/boards', (req) => {
  const user = requireUser(req);
  return { boards: listBoards(db, user) };
});
route('POST', '/api/boards', async (req) => {
  const user = requireUser(req);
  const body = await readJson(req);
  const name = String(body.name || '').trim();
  if (!name) throw new OpError(400, 'name is required');
  const lanes = Array.isArray(body.lanes) && body.lanes.length ? body.lanes : undefined;
  const board = createBoard(db, user, name, lanes);
  broadcast({ type: 'boards.changed', ts: Date.now() });
  return { board: getBoardSnapshot(db, board.id, user) };
});
route('POST', '/api/boards/:id/join', (req, params) => {
  const user = requireUser(req);
  requireBoard(user, params.id, { member: false });
  joinBoard(db, user, params.id);
  broadcast({ type: 'boards.changed', boardId: params.id, ts: Date.now() });
  return { board: getBoardSnapshot(db, params.id, user) };
});
route('DELETE', '/api/boards/:id/join', (req, params) => {
  const user = requireUser(req);
  requireBoard(user, params.id, { member: false });
  leaveBoard(db, user, params.id);
  return { ok: true };
});
route('GET', '/api/boards/:id', (req, params) => {
  const user = requireUser(req);
  requireBoard(user, params.id);
  return { board: getBoardSnapshot(db, params.id, user) };
});
route('GET', '/api/boards/:id/members', (req, params) => {
  const user = requireUser(req);
  requireBoard(user, params.id);
  return { members: boardMembers(db, params.id) };
});
route('DELETE', '/api/boards/:id', (req, params) => {
  const user = requireUser(req);
  requireBoard(user, params.id);
  deleteBoard(db, params.id);
  broadcast({ type: 'boards.changed', boardId: params.id, deleted: true, ts: Date.now() });
  return { ok: true };
});
route('POST', '/api/boards/:id/ops', async (req, params) => {
  const user = requireUser(req);
  const board = requireBoard(user, params.id);
  const body = await readJson(req);
  body.ops = orderOps(body.ops);
  const reupload = detectReupload(db, board.id, body.ops);
  if (reupload) {
    console.warn(`${new Date().toISOString()} [${board.name}] ${user.name}: ${reupload}`);
    throw new OpError(409, reupload);
  }
  const result = applyOps(db, board, user, body.ops);
  logOps(user, board, body.ops, result);
  notifier.onOps({ actor: user, boardId: board.id, events: result.events });
  const meta = getBoardMeta(db, board.id);
  notifyBoardChanged(meta, {
    origin: body.clientId || null,
    users: result.affectedUsers,
    cards: result.touchedCards,
  });
  return {
    ok: result.conflicts.length === 0 && result.results.every((r) => r.ok),
    version: result.version,
    results: result.results,
    conflicts: result.conflicts,
    versions: result.versions,
  };
});

// comments
route('GET', '/api/boards/:id/cards/:cardId/comments', (req, params) => {
  const user = requireUser(req);
  requireBoard(user, params.id);
  requireCard(user, params.id, params.cardId);
  return {
    comments: listComments(db, params.id, params.cardId),
    lastReadAt: commentsReadAt(db, user, params.id, params.cardId),
  };
});
route('POST', '/api/boards/:id/cards/:cardId/comments/read', (req, params) => {
  const user = requireUser(req);
  const board = requireBoard(user, params.id);
  requireCard(user, board.id, params.cardId);
  markCommentsRead(db, user, board.id, params.cardId);
  return { ok: true };
});
// People who can be @mentioned on a card: everyone who can see it.
route('GET', '/api/boards/:id/cards/:cardId/people', (req, params) => {
  const user = requireUser(req);
  const board = requireBoard(user, params.id);
  requireCard(user, board.id, params.cardId);
  return { users: notifier.peopleForCard(board.id, params.cardId).map(({ id, name }) => ({ id, name })) };
});

// ---------- Telegram notifications (notify.js) ----------

route('GET', '/api/me/telegram', (req) => notifier.status(requireUser(req).id));
route('POST', '/api/me/telegram/link', (req) => {
  const user = requireUser(req);
  const url = notifier.linkUrl(user.id);
  if (!url) throw new OpError(503, 'Telegram notifications are not set up on this server');
  return { url };
});
route('DELETE', '/api/me/telegram', (req) => {
  const user = requireUser(req);
  notifier.unlink(user.id);
  return notifier.status(user.id);
});

route('POST', '/api/boards/:id/cards/:cardId/comments', async (req, params) => {
  const user = requireUser(req);
  const board = requireBoard(user, params.id);
  requireCard(user, board.id, params.cardId);
  const body = await readJson(req);
  const text = String(body.body || '').trim();
  if (!text) throw new OpError(400, 'comment is empty');
  if (text.length > 20000) throw new OpError(400, 'comment is too long');
  // A reply must point at a comment on the same card.
  let replyTo = null;
  let replyToUserId = null;
  if (body.replyTo) {
    const parent = getComment(db, board.id, String(body.replyTo));
    if (!parent || parent.card_id !== params.cardId) throw new OpError(400, 'the comment you replied to is gone');
    replyTo = parent.id;
    replyToUserId = parent.user_id;
  }
  const comment = addComment(db, user, board.id, params.cardId, text, replyTo);
  markCommentsRead(db, user, board.id, params.cardId);
  notifier.onComment({ actor: user, boardId: board.id, cardId: params.cardId, body: text, replyToUserId });
  broadcast({ type: 'comments.changed', boardId: board.id, cardId: params.cardId, ts: Date.now() });
  notifyBoardChanged(getBoardMeta(db, board.id), {
    users: cardAssignees(db, board.id, params.cardId),
    cards: [params.cardId],
  });
  return { comment };
});
route('PATCH', '/api/boards/:id/comments/:commentId', async (req, params) => {
  const user = requireUser(req);
  const board = requireBoard(user, params.id);
  const c = getComment(db, board.id, params.commentId);
  if (!c || !canSeeCard(db, user, board.id, c.card_id)) throw new OpError(404, 'comment not found');
  if (c.user_id !== user.id) throw new OpError(403, 'you can only edit your own comments');
  const body = await readJson(req);
  const text = String(body.body || '').trim();
  if (!text) throw new OpError(400, 'comment is empty');
  if (text.length > 20000) throw new OpError(400, 'comment is too long');
  if (text !== c.body) {
    editComment(db, board.id, c.id, text);
    notifier.onComment({ actor: user, boardId: board.id, cardId: c.card_id, body: text, previousBody: c.body });
    markCommentsRead(db, user, board.id, c.card_id);
    broadcast({ type: 'comments.changed', boardId: board.id, cardId: c.card_id, ts: Date.now() });
    notifyBoardChanged(getBoardMeta(db, board.id), {
      users: cardAssignees(db, board.id, c.card_id),
      cards: [c.card_id],
    });
  }
  return { comment: listComments(db, board.id, c.card_id).find((x) => x.id === c.id) };
});
route('DELETE', '/api/boards/:id/comments/:commentId', (req, params) => {
  const user = requireUser(req);
  const board = requireBoard(user, params.id);
  const c = getComment(db, board.id, params.commentId);
  if (!c || !canSeeCard(db, user, board.id, c.card_id)) throw new OpError(404, 'comment not found');
  if (c.user_id !== user.id) throw new OpError(403, 'you can only delete your own comments');
  deleteComment(db, board.id, c.id);
  broadcast({ type: 'comments.changed', boardId: board.id, cardId: c.card_id, ts: Date.now() });
  notifyBoardChanged(getBoardMeta(db, board.id), {
    users: cardAssignees(db, board.id, c.card_id),
    cards: [c.card_id],
  });
  return { ok: true };
});

// uploads: raw body, filename in X-Filename, type in Content-Type
route('POST', '/api/boards/:id/files', async (req, params) => {
  const user = requireUser(req);
  const board = requireBoard(user, params.id);
  const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  let name = 'file';
  try {
    name = decodeURIComponent(String(req.headers['x-filename'] || 'file'));
  } catch {
    /* keep default */
  }
  name = name.replace(/[\\/:"*?<>|\r\n]+/g, '_').slice(0, 120) || 'file';
  const id = newId(24);
  const dest = path.join(FILES_DIR, id);
  const size = await new Promise((resolve, reject) => {
    let total = 0;
    const out = fs.createWriteStream(dest);
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_UPLOAD) {
        req.destroy();
        out.destroy();
        fs.rm(dest, { force: true }, () => {});
        reject(new OpError(413, `file is larger than ${MAX_UPLOAD / 1024 / 1024} MB`));
      }
    });
    req.pipe(out);
    out.on('finish', () => (req.complete ? resolve(total) : reject(new OpError(400, 'upload interrupted'))));
    out.on('error', reject);
    req.on('error', reject);
  }).catch((e) => {
    // A cancelled or broken upload leaves no partial file behind.
    fs.rm(dest, { force: true }, () => {});
    throw e;
  });
  if (!size) {
    fs.rm(dest, { force: true }, () => {});
    throw new OpError(400, 'empty file');
  }
  addFile(db, user, board.id, { id, name, mime, size });
  return {
    id,
    name,
    mime,
    size,
    url: `${PUBLIC_URL}/files/${id}/${encodeURIComponent(name)}`,
  };
});

// ---------- static: uploaded files (public by unguessable id) and downloads ----------

function serveFile(req, res, filePath, mime, extraHeaders = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    send(res, 404, { error: 'not found' });
    return;
  }
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    let start = range[1] === '' ? null : Number(range[1]);
    let end = range[2] === '' ? null : Number(range[2]);
    if (start === null) {
      start = Math.max(0, stat.size - (end ?? 0));
      end = stat.size - 1;
    }
    if (end === null || end >= stat.size) end = stat.size - 1;
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

/** Uploads shown in place (embedded images and videos); everything else is served as a download. */
const INLINE_MIME = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime|x-m4v))$/;

function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  // Where a "sign in this device" QR code points; the code itself stays in the #fragment.
  if (pathname === '/pair' || pathname === '/pair/') {
    serveFile(req, res, path.join(import.meta.dirname, 'pair.html'), 'text/html; charset=utf-8', {
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    return true;
  }
  let m = /^\/files\/([a-z0-9]{24})(?:\/[^/]*)?$/.exec(pathname);
  if (m) {
    const f = getFile(db, m[1]);
    if (!f) {
      send(res, 404, { error: 'not found' });
      return true;
    }
    if (INLINE_MIME.test(f.mime)) {
      serveFile(req, res, path.join(FILES_DIR, f.id), f.mime, { 'X-Content-Type-Options': 'nosniff' });
    } else {
      // Anything else downloads; HTML, SVG and the like never run on this origin.
      serveFile(req, res, path.join(FILES_DIR, f.id), 'application/octet-stream', {
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name || 'file')}`,
      });
    }
    return true;
  }
  m = /^\/plugin\/(manifest\.json|main\.js|styles\.css)$/.exec(pathname);
  if (m) {
    const mime = m[1].endsWith('.json')
      ? 'application/json'
      : m[1].endsWith('.js')
        ? 'application/javascript'
        : 'text/css';
    serveFile(req, res, path.join(PUBLIC_DIR, 'plugin', m[1]), `${mime}; charset=utf-8`, {
      'Cache-Control': 'no-cache',
    });
    return true;
  }
  m = /^\/download\/([A-Za-z0-9._-]+)$/.exec(pathname);
  if (m) {
    const p = path.join(PUBLIC_DIR, m[1]);
    const mime = p.endsWith('.zip') ? 'application/zip' : p.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
    serveFile(req, res, p, mime, {
      'Cache-Control': 'no-cache',
      'Content-Disposition': `attachment; filename="${m[1]}"`,
    });
    return true;
  }
  return false;
}

/** Old-host behaviour once MOVED_TO is set. Returns false for requests still served here. */
function handleMoved(req, res, url) {
  if (/^\/(plugin|download)\//.test(url.pathname)) return false;
  if (url.pathname.startsWith('/files/')) {
    res.writeHead(301, { Location: `${MOVED_TO}${url.pathname}` });
    res.end();
    return true;
  }
  if (url.pathname === '/api/health') {
    send(res, 200, { ok: true, ts: Date.now(), movedTo: MOVED_TO });
    return true;
  }
  send(res, 410, { error: `the team server moved to ${MOVED_TO}`, movedTo: MOVED_TO });
  return true;
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Filename',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    });
    res.end();
    return;
  }
  if (MOVED_TO && handleMoved(req, res, url)) return;
  try {
    if (handleStatic(req, res, url.pathname)) return;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const out = await r.handler(req, params, url);
      send(res, 200, out ?? {});
      return;
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof OpError) {
      send(res, e.status, { error: e.message, ...e.extra });
    } else {
      console.error(e);
      send(res, 500, { error: 'internal error' });
    }
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  if (MOVED_TO) {
    socket.write('HTTP/1.1 410 Gone\r\n\r\n');
    socket.destroy();
    return;
  }
  const user = userByToken(db, url.searchParams.get('token'));
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const entry = { ws, user, alive: true };
    sockets.add(entry);
    ws.on('pong', () => (entry.alive = true));
    ws.on('close', () => sockets.delete(entry));
    ws.on('error', () => sockets.delete(entry));
    ws.on('message', (raw) => {
      // Clients may send {type:'ping'}; anything else is ignored.
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      } catch {
        /* ignore */
      }
    });
    ws.send(JSON.stringify({ type: 'hello', user, ts: Date.now() }));
  });
});

const heartbeat = setInterval(() => {
  for (const s of sockets) {
    if (!s.alive) {
      s.ws.terminate();
      sockets.delete(s);
      continue;
    }
    s.alive = false;
    try {
      s.ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 30000);
heartbeat.unref();

// Once the bot is up, announce the published version if it hasn't been yet.
void notifier.start().then(() => releasedVersion && announceRelease(releasedVersion));

server.listen(PORT, () => {
  console.log(`kanban team server listening on :${PORT} (data: ${DATA_DIR})`);
  if (!ADMIN_TOKEN) console.log('warning: ADMIN_TOKEN not set; use "node cli.js add-user <name>" to create users');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    notifier.stop();
    server.close();
    db.close();
    process.exit(0);
  });
}
