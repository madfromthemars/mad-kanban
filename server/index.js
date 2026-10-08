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
} from './db.js';
import { OpError, applyOps, detectReupload, orderOps } from './ops.js';

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || './data';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

const db = openDb(DATA_DIR);
const FILES_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
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
  return { user };
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
  requireUser(req);
  return { users: listUsers(db) };
});
route('GET', '/api/me/cards', (req) => {
  const user = requireUser(req);
  return { cards: myCards(db, user) };
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
  return { board: getBoardSnapshot(db, board.id, user.id) };
});
route('POST', '/api/boards/:id/join', (req, params) => {
  const user = requireUser(req);
  requireBoard(user, params.id, { member: false });
  joinBoard(db, user, params.id);
  broadcast({ type: 'boards.changed', boardId: params.id, ts: Date.now() });
  return { board: getBoardSnapshot(db, params.id, user.id) };
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
  return { board: getBoardSnapshot(db, params.id, user.id) };
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
  return {
    comments: listComments(db, params.id, params.cardId),
    lastReadAt: commentsReadAt(db, user, params.id, params.cardId),
  };
});
route('POST', '/api/boards/:id/cards/:cardId/comments/read', (req, params) => {
  const user = requireUser(req);
  const board = requireBoard(user, params.id);
  markCommentsRead(db, user, board.id, params.cardId);
  return { ok: true };
});
route('POST', '/api/boards/:id/cards/:cardId/comments', async (req, params) => {
  const user = requireUser(req);
  const board = requireBoard(user, params.id);
  if (!cardExists(db, board.id, params.cardId)) throw new OpError(404, 'card not found');
  const body = await readJson(req);
  const text = String(body.body || '').trim();
  if (!text) throw new OpError(400, 'comment is empty');
  if (text.length > 20000) throw new OpError(400, 'comment is too long');
  // A reply must point at a comment on the same card.
  let replyTo = null;
  if (body.replyTo) {
    const parent = getComment(db, board.id, String(body.replyTo));
    if (!parent || parent.card_id !== params.cardId) throw new OpError(400, 'the comment you replied to is gone');
    replyTo = parent.id;
  }
  const comment = addComment(db, user, board.id, params.cardId, text, replyTo);
  markCommentsRead(db, user, board.id, params.cardId);
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
  if (!c) throw new OpError(404, 'comment not found');
  if (c.user_id !== user.id) throw new OpError(403, 'you can only edit your own comments');
  const body = await readJson(req);
  const text = String(body.body || '').trim();
  if (!text) throw new OpError(400, 'comment is empty');
  if (text.length > 20000) throw new OpError(400, 'comment is too long');
  if (text !== c.body) {
    editComment(db, board.id, c.id, text);
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
  if (!c) throw new OpError(404, 'comment not found');
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
  if (!/^(image|video)\//.test(mime)) throw new OpError(415, 'only images and videos can be uploaded');
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
    out.on('finish', () => resolve(total));
    out.on('error', reject);
    req.on('error', reject);
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

function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let m = /^\/files\/([a-z0-9]{24})(?:\/[^/]*)?$/.exec(pathname);
  if (m) {
    const f = getFile(db, m[1]);
    if (!f) {
      send(res, 404, { error: 'not found' });
      return true;
    }
    serveFile(req, res, path.join(FILES_DIR, f.id), f.mime);
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

server.listen(PORT, () => {
  console.log(`kanban team server listening on :${PORT} (data: ${DATA_DIR})`);
  if (!ADMIN_TOKEN) console.log('warning: ADMIN_TOKEN not set; use "node cli.js add-user <name>" to create users');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
