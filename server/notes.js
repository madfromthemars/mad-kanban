// Shared notes and canvases per project ("Team/<project>/..." in every member's vault).
//
// Every shared file is a doc with a stable id; its path (relative to the project folder)
// is just a field, so renames never lose history. Content is a Yjs document: clients send
// and receive Yjs sync/awareness messages as binary WebSocket frames on the normal /ws
// connection, and the server keeps every update (compacted now and then) in sqlite.
// Tree changes (create / move / delete / restore) go through REST, like card ops.
// Design: docs/design/shared-notes.md.
//
// Binary frame: varString docId, varUint kind, payload
//   kind 0 = y-protocols sync message, 1 = awareness update, 2 = unsubscribe (no payload)

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

import { newId, transaction, visibleProjectIds } from './db.js';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_UNSUB = 2;

const MAX_DOC_BYTES = Number(process.env.NOTES_MAX_DOC_BYTES || 10 * 1024 * 1024);
const COMPACT_AFTER = Number(process.env.NOTES_COMPACT_AFTER || 500);
const TRASH_DAYS = 30;
const IDLE_UNLOAD_MS = 5 * 60 * 1000;

export class NotesError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const KINDS = { '.md': 'md', '.canvas': 'canvas' };
const TOUCH_THROTTLE_MS = Number(process.env.NOTES_TOUCH_MS || 2000);
const VERSION_EVERY_MS = Number(process.env.NOTES_VERSION_EVERY_MS || 10 * 60 * 1000);
const MAX_VERSIONS = 60;

/**
 * "Plans/Q1 plan.md" -> same, or a NotesError. Relative to the project folder; no "..",
 * no empty or dot segments, no characters Windows/Android can't store.
 */
export function cleanPath(p) {
  if (typeof p !== 'string') throw new NotesError(400, 'path required');
  const path = p.normalize('NFC').replace(/\\/g, '/').trim();
  if (!path || path.length > 300) throw new NotesError(400, 'path is empty or too long');
  if (path.startsWith('/')) throw new NotesError(400, 'path must be relative');
  const parts = path.split('/');
  for (const s of parts) {
    if (!s || s === '.' || s === '..' || s !== s.trim()) throw new NotesError(400, `bad path segment "${s}"`);
    if (/[\u0000-\u001f<>:"|?*]/.test(s)) throw new NotesError(400, `"${s}" contains a character that can't be in a file name`);
    if (s.startsWith('.')) throw new NotesError(400, 'hidden files and folders are not shared');
    if (s.endsWith('.')) throw new NotesError(400, `"${s}" can't end with a dot (Windows can't store it)`);
  }
  return parts.join('/');
}

/** .md -> live note, .canvas -> live canvas, anything else -> attachment (whole file). */
export function kindOfPath(path) {
  const m = /\.[^./]+$/.exec(path);
  return (m && KINDS[m[0].toLowerCase()]) || 'file';
}

function rowToDoc(r) {
  return {
    id: r.id,
    projectId: r.project_id,
    path: r.path,
    kind: r.kind,
    fileId: r.file_id || null,
    version: r.version,
    size: r.size,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    deletedBy: r.deleted_by,
  };
}

/**
 * @param send(entry, jsonMessage) send JSON to one socket entry
 * @param eachSocket() iterable of socket entries { ws, user }
 */
export function createNotes(db, { eachSocket, log = console } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      size INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_by TEXT,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      deleted_by TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS docs_live_path ON docs(project_id, path COLLATE NOCASE) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS docs_project ON docs(project_id);
    CREATE TABLE IF NOT EXISTS doc_updates (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL,
      data BLOB NOT NULL,
      user_id TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS doc_updates_doc ON doc_updates(doc_id, seq);
    CREATE TABLE IF NOT EXISTS doc_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      user_ids TEXT NOT NULL DEFAULT '[]',
      data BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS doc_versions_doc ON doc_versions(doc_id, at);
  `);
  if (!db.prepare('PRAGMA table_info(docs)').all().some((c) => c.name === 'file_id')) {
    db.exec('ALTER TABLE docs ADD COLUMN file_id TEXT');
  }

  const q = {
    get: db.prepare('SELECT * FROM docs WHERE id = ?'),
    byPath: db.prepare('SELECT * FROM docs WHERE project_id = ? AND path = ? COLLATE NOCASE AND deleted_at IS NULL'),
    updates: db.prepare('SELECT data FROM doc_updates WHERE doc_id = ? ORDER BY seq'),
    addUpdate: db.prepare('INSERT INTO doc_updates (doc_id, data, user_id, at) VALUES (?, ?, ?, ?)'),
    countUpdates: db.prepare('SELECT COUNT(*) AS n FROM doc_updates WHERE doc_id = ?'),
    touch: db.prepare('UPDATE docs SET updated_by = ?, updated_at = ?, size = ? WHERE id = ?'),
  };

  // ---------- access ----------

  const isPrivate = (projectId) => String(projectId).startsWith('me:');
  function canUse(user, projectId) {
    if (!user || user.disabled || isPrivate(projectId)) return false;
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return false;
    return visibleProjectIds(db, user).has(projectId);
  }

  function requireDoc(user, id, { deleted = false } = {}) {
    const r = q.get.get(String(id || ''));
    // 404 for docs the user can't see, so their existence isn't revealed.
    if (!r || !canUse(user, r.project_id)) throw new NotesError(404, 'doc not found');
    if (!deleted && r.deleted_at) throw new NotesError(410, 'doc was deleted');
    return r;
  }

  // ---------- tree ----------

  function list(user) {
    const vis = visibleProjectIds(db, user);
    return db
      .prepare('SELECT * FROM docs WHERE deleted_at IS NULL ORDER BY project_id, path COLLATE NOCASE')
      .all()
      .filter((r) => vis.has(r.project_id) && !isPrivate(r.project_id))
      .map(rowToDoc);
  }

  /** Projects whose folder the user gets (every visible real project, even empty ones). */
  function projectsFor(user) {
    const vis = visibleProjectIds(db, user);
    return db
      .prepare('SELECT id, name, color FROM projects ORDER BY name COLLATE NOCASE')
      .all()
      .filter((p) => vis.has(p.id));
  }

  function trash(user) {
    const vis = visibleProjectIds(db, user);
    return db
      .prepare('SELECT * FROM docs WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')
      .all()
      .filter((r) => vis.has(r.project_id) && !isPrivate(r.project_id))
      .map(rowToDoc);
  }

  /** "a.md" taken -> "a (2).md", "a (3).md"… */
  function freePath(projectId, path, exceptId = null) {
    const taken = (p) => {
      const r = q.byPath.get(projectId, p);
      return r && r.id !== exceptId;
    };
    if (!taken(path)) return path;
    const m = /^(.*?)(\.[^./]+)?$/.exec(path);
    for (let i = 2; ; i++) {
      const p = `${m[1]} (${i})${m[2] || ''}`;
      if (!taken(p)) return p;
    }
  }

  function requireFile(fileId) {
    const f = db.prepare('SELECT id FROM files WHERE id = ?').get(String(fileId || ''));
    if (!f) throw new NotesError(400, 'upload the file first (fileId not found)');
    return f.id;
  }

  function validUpdate(b64) {
    if (b64 == null) return null;
    const buf = Buffer.from(String(b64), 'base64');
    if (buf.length > MAX_DOC_BYTES) throw new NotesError(413, 'content too large');
    try {
      Y.applyUpdate(new Y.Doc(), new Uint8Array(buf));
    } catch {
      throw new NotesError(400, 'update is not a valid Yjs update');
    }
    return new Uint8Array(buf);
  }

  /**
   * Ops (all or nothing, in order):
   *  {type:'doc.create', id?, projectId, path, update?(base64 Yjs), rename?:true}
   *  {type:'doc.move', id, path?, projectId?, version?}
   *  {type:'doc.delete', id}
   *  {type:'doc.restore', id}
   *  {type:'doc.setFile', id, fileId, version?}   (attachments: new content)
   * Attachments (any path that isn't .md / .canvas) need `fileId` from POST /api/docs/files.
   * `rename: true` on create picks "name (2).md" instead of failing when the path is taken.
   */
  function applyOps(user, ops) {
    if (!Array.isArray(ops) || !ops.length || ops.length > 500) throw new NotesError(400, 'ops must be a non-empty array (max 500)');
    const changed = []; // [{doc, oldProjectId}]
    const results = transaction(db, () =>
      ops.map((op) => {
        const now = Date.now();
        if (op?.type === 'doc.create') {
          if (!canUse(user, op.projectId)) throw new NotesError(404, 'project not found');
          let path = cleanPath(op.path);
          const kind = kindOfPath(path);
          if (q.byPath.get(op.projectId, path)) {
            if (!op.rename) throw new NotesError(409, `"${path}" already exists`);
            path = freePath(op.projectId, path);
          }
          const id = op.id != null ? String(op.id) : newId(12);
          if (!/^[a-z0-9]{8,24}$/.test(id)) throw new NotesError(400, 'bad doc id');
          if (q.get.get(id)) throw new NotesError(409, 'doc id already used');
          const update = kind === 'file' ? null : validUpdate(op.update);
          const fileId = kind === 'file' ? requireFile(op.fileId) : null;
          db.prepare(
            `INSERT INTO docs (id, project_id, path, kind, file_id, created_by, created_at, updated_by, updated_at, size)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(id, op.projectId, path, kind, fileId, user.id, now, user.id, now, update?.length || 0);
          if (update) q.addUpdate.run(id, update, user.id, now);
          const doc = rowToDoc(q.get.get(id));
          changed.push({ doc });
          return { ok: true, doc };
        }
        if (op?.type === 'doc.move') {
          const r = requireDoc(user, op.id);
          if (op.version != null && Number(op.version) !== r.version)
            throw new NotesError(409, `"${r.path}" was changed by someone else; reload and try again`);
          const projectId = op.projectId ?? r.project_id;
          if (projectId !== r.project_id && !canUse(user, projectId)) throw new NotesError(404, 'project not found');
          const path = op.path != null ? cleanPath(op.path) : r.path;
          if (kindOfPath(path) !== r.kind) throw new NotesError(400, 'a move cannot change the file type');
          const clash = q.byPath.get(projectId, path);
          if (clash && clash.id !== r.id) throw new NotesError(409, `"${path}" already exists`);
          db.prepare('UPDATE docs SET project_id = ?, path = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?').run(
            projectId,
            path,
            user.id,
            now,
            r.id
          );
          const doc = rowToDoc(q.get.get(r.id));
          changed.push({ doc, oldProjectId: r.project_id });
          return { ok: true, doc };
        }
        if (op?.type === 'doc.setFile') {
          const r = requireDoc(user, op.id);
          if (r.kind !== 'file') throw new NotesError(400, 'only attachments have a file');
          if (op.version != null && Number(op.version) !== r.version)
            throw new NotesError(409, `"${r.path}" was changed by someone else; reload and try again`);
          const fileId = requireFile(op.fileId);
          db.prepare('UPDATE docs SET file_id = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?').run(fileId, user.id, now, r.id);
          const doc = rowToDoc(q.get.get(r.id));
          changed.push({ doc });
          return { ok: true, doc };
        }
        if (op?.type === 'doc.delete') {
          const r = requireDoc(user, op.id);
          db.prepare('UPDATE docs SET deleted_at = ?, deleted_by = ?, version = version + 1 WHERE id = ?').run(now, user.id, r.id);
          const doc = rowToDoc(q.get.get(r.id));
          changed.push({ doc });
          return { ok: true, doc };
        }
        if (op?.type === 'doc.restore') {
          const r = requireDoc(user, op.id, { deleted: true });
          if (!r.deleted_at) return { ok: true, doc: rowToDoc(r) };
          const path = freePath(r.project_id, r.path, r.id);
          db.prepare('UPDATE docs SET deleted_at = NULL, deleted_by = NULL, path = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?').run(
            path,
            user.id,
            now,
            r.id
          );
          const doc = rowToDoc(q.get.get(r.id));
          changed.push({ doc });
          return { ok: true, doc };
        }
        throw new NotesError(400, `unknown op type "${op?.type}"`);
      })
    );
    for (const c of changed) {
      if (c.doc.deletedAt) closeRoom(c.doc.id, 'deleted');
      else if (c.oldProjectId && c.oldProjectId !== c.doc.projectId) recheckRoom(c.doc.id);
      announce(c.doc, c.oldProjectId, user);
    }
    for (const c of changed) log.log(`${new Date().toISOString()} notes: ${user.name} ${c.doc.deletedAt ? 'deleted' : 'changed'} ${c.doc.projectId}/${c.doc.path}`);
    return { ok: true, results };
  }

  /** Tell everyone who can see the doc (or could, before a move) that the tree changed. */
  function announce(doc, oldProjectId, actor) {
    const msg = JSON.stringify({ type: 'docs.changed', doc, by: actor.id, ts: Date.now() });
    const gone = oldProjectId && oldProjectId !== doc.projectId
      ? JSON.stringify({ type: 'docs.removed', id: doc.id, ts: Date.now() })
      : null;
    for (const s of eachSocket()) {
      if (s.ws.readyState !== s.ws.OPEN) continue;
      if (canUse(s.user, doc.projectId)) s.ws.send(msg);
      else if (gone && canUse(s.user, oldProjectId)) s.ws.send(gone);
    }
  }

  // ---------- live rooms ----------

  /** docId -> { ydoc, awareness, conns: Map<entry, Set<awareness client ids>>, idle } */
  const rooms = new Map();

  function frame(id, kind, write) {
    const enc = encoding.createEncoder();
    encoding.writeVarString(enc, id);
    encoding.writeVarUint(enc, kind);
    write?.(enc);
    return encoding.toUint8Array(enc);
  }

  function sendTo(entry, data) {
    if (entry.ws.readyState === entry.ws.OPEN) entry.ws.send(data, { binary: true });
  }

  function sendJson(entry, msg) {
    if (entry.ws.readyState === entry.ws.OPEN) entry.ws.send(JSON.stringify(msg));
  }

  function loadRoom(id) {
    let room = rooms.get(id);
    if (room) return room;
    const ydoc = new Y.Doc({ gc: true });
    for (const r of q.updates.all(id)) Y.applyUpdate(ydoc, r.data);
    const awareness = new awarenessProtocol.Awareness(ydoc);
    awareness.setLocalState(null);
    room = {
      id,
      ydoc,
      awareness,
      conns: new Map(),
      idle: null,
      size: Y.encodeStateAsUpdate(ydoc).length,
      rows: q.countUpdates.get(id).n,
      editors: new Set(),
      touchTimer: null,
      touchAt: 0,
      lastVersion: db.prepare('SELECT MAX(at) AS at FROM doc_versions WHERE doc_id = ?').get(id).at || 0,
    };
    // Before the first change after a quiet spell, keep a copy of how the doc looked.
    ydoc.on('beforeTransaction', () => maybeVersion(room, Date.now()));
    ydoc.on('update', (update, origin) => {
      // origin = the socket entry that sent it
      const at = Date.now();
      const uid = origin?.user?.id ?? null;
      q.addUpdate.run(id, update, uid, at);
      room.size += update.length;
      q.touch.run(uid, at, room.size, id);
      const data = frame(id, MSG_SYNC, (enc) => syncProtocol.writeUpdate(enc, update));
      for (const c of room.conns.keys()) if (c !== origin) sendTo(c, data);
      if (++room.rows > COMPACT_AFTER) compact(room);
      if (uid) room.editors.add(uid);
      touched(room, at);
    });
    awareness.on('update', ({ added, updated, removed }, origin) => {
      const changedIds = added.concat(updated, removed);
      const data = frame(id, MSG_AWARENESS, (enc) =>
        encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changedIds))
      );
      for (const c of room.conns.keys()) if (c !== origin) sendTo(c, data);
    });
    rooms.set(id, room);
    return room;
  }

  /**
   * "This doc changed" for everyone who can see it but isn't subscribed, at most every
   * couple of seconds per doc, so their device fetches it in the background.
   */
  function touched(room, at) {
    room.touchAt = at;
    if (room.touchTimer) return;
    room.touchTimer = setTimeout(() => {
      room.touchTimer = null;
      const r = q.get.get(room.id);
      if (!r || r.deleted_at) return;
      const msg = JSON.stringify({ type: 'docs.touched', id: room.id, updatedAt: room.touchAt, ts: Date.now() });
      for (const s of eachSocket()) {
        if (room.conns.has(s) || s.ws.readyState !== s.ws.OPEN) continue;
        if (canUse(s.user, r.project_id)) s.ws.send(msg);
      }
    }, TOUCH_THROTTLE_MS);
    room.touchTimer.unref?.();
  }

  /**
   * Version history: before a change, if the last saved copy is older than ~10 minutes,
   * save the doc as it is now (so every version is a state someone actually saw).
   */
  function maybeVersion(room, at) {
    if (!room || at - room.lastVersion < VERSION_EVERY_MS) return;
    if (!room.ydoc.share.size && !q.countUpdates.get(room.id).n) return; // nothing yet
    room.lastVersion = at;
    db.prepare('INSERT INTO doc_versions (doc_id, at, user_ids, data) VALUES (?, ?, ?, ?)').run(
      room.id,
      at,
      JSON.stringify([...room.editors]),
      Y.encodeStateAsUpdate(room.ydoc)
    );
    room.editors = new Set();
    // Thin out: keep the newest MAX_VERSIONS.
    db.prepare(
      `DELETE FROM doc_versions WHERE doc_id = ? AND id NOT IN
         (SELECT id FROM doc_versions WHERE doc_id = ? ORDER BY at DESC LIMIT ?)`
    ).run(room.id, room.id, MAX_VERSIONS);
  }

  function versions(user, id) {
    requireDoc(user, id, { deleted: true });
    const names = new Map(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
    return db
      .prepare('SELECT id, at, user_ids FROM doc_versions WHERE doc_id = ? ORDER BY at DESC')
      .all(id)
      .map((v) => ({ id: v.id, at: v.at, by: JSON.parse(v.user_ids).map((u) => names.get(u) || u) }));
  }

  function versionContent(user, id, versionId) {
    const r = requireDoc(user, id, { deleted: true });
    const v = db.prepare('SELECT data FROM doc_versions WHERE doc_id = ? AND id = ?').get(id, Number(versionId));
    if (!v) throw new NotesError(404, 'version not found');
    const d = new Y.Doc();
    Y.applyUpdate(d, v.data);
    return render(r.kind, d);
  }

  function render(kind, ydoc) {
    if (kind === 'md') return ydoc.getText('content').toString();
    const parts = (m) => [...m.values()].map((s) => JSON.parse(s)).sort((a, b) => a.i - b.i).map((x) => x.v);
    return JSON.stringify({ nodes: parts(ydoc.getMap('nodes')), edges: parts(ydoc.getMap('edges')) });
  }

  /** Many small updates -> one snapshot row (same content, faster loads). */
  function compact(room) {
    const snap = Y.encodeStateAsUpdate(room.ydoc);
    transaction(db, () => {
      const last = db.prepare('SELECT MAX(seq) AS s FROM doc_updates WHERE doc_id = ?').get(room.id).s;
      db.prepare('DELETE FROM doc_updates WHERE doc_id = ? AND seq <= ?').run(room.id, last);
      q.addUpdate.run(room.id, snap, null, Date.now());
    });
    room.size = snap.length;
    room.rows = 1;
    q.touch.run(null, Date.now(), room.size, room.id);
  }

  function leave(room, entry) {
    const ids = room.conns.get(entry);
    if (!ids) return;
    room.conns.delete(entry);
    if (ids.size) awarenessProtocol.removeAwarenessStates(room.awareness, [...ids], null);
    if (!room.conns.size) {
      clearTimeout(room.idle);
      room.idle = setTimeout(() => {
        if (!room.conns.size && rooms.get(room.id) === room) {
          room.awareness.destroy();
          room.ydoc.destroy();
          rooms.delete(room.id);
        }
      }, IDLE_UNLOAD_MS);
      room.idle.unref?.();
    }
  }

  function closeRoom(id, reason) {
    const room = rooms.get(id);
    if (!room) return;
    for (const entry of [...room.conns.keys()]) {
      leave(room, entry);
      sendJson(entry, { type: 'doc.closed', id, reason });
    }
  }

  function recheckRoom(id) {
    const room = rooms.get(id);
    const r = q.get.get(id);
    if (!room || !r) return;
    for (const entry of [...room.conns.keys()]) {
      if (!canUse(entry.user, r.project_id)) {
        leave(room, entry);
        sendJson(entry, { type: 'doc.closed', id, reason: 'no access' });
      }
    }
  }

  /** Team membership changed: drop subscriptions people lost access to. */
  function recheckAll() {
    for (const id of rooms.keys()) recheckRoom(id);
  }

  /** A binary frame from a client socket entry { ws, user }. */
  function onFrame(entry, raw) {
    let id;
    try {
      const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const dec = decoding.createDecoder(buf);
      id = decoding.readVarString(dec);
      const kind = decoding.readVarUint(dec);
      if (kind === MSG_UNSUB) {
        const room = rooms.get(id);
        if (room) leave(room, entry);
        return;
      }
      // Access is checked when a socket joins a doc; losing it later (team change, move,
      // delete) removes the socket from the room via recheckRoom/closeRoom.
      let room = rooms.get(id);
      if (!room?.conns.has(entry)) {
        const r = q.get.get(id);
        if (!r || r.deleted_at || !canUse(entry.user, r.project_id)) {
          sendJson(entry, { type: 'doc.error', id, error: r?.deleted_at ? 'deleted' : 'not found' });
          return;
        }
        if (r.kind === 'file') {
          sendJson(entry, { type: 'doc.error', id, error: 'attachments are not live documents' });
          return;
        }
        room = loadRoom(id);
      }
      clearTimeout(room.idle);
      if (!room.conns.has(entry)) room.conns.set(entry, new Set());
      if (kind === MSG_SYNC) {
        // Size cap: refuse updates once the stored doc is too big.
        const peekType = buf[dec.pos];
        if (peekType !== syncProtocol.messageYjsSyncStep1 && room.size + buf.length > MAX_DOC_BYTES) {
          sendJson(entry, { type: 'doc.error', id, error: 'too large' });
          return;
        }
        const enc = encoding.createEncoder();
        encoding.writeVarString(enc, id);
        encoding.writeVarUint(enc, MSG_SYNC);
        const before = encoding.length(enc);
        const type = syncProtocol.readSyncMessage(dec, enc, room.ydoc, entry);
        if (encoding.length(enc) > before) sendTo(entry, encoding.toUint8Array(enc));
        if (type === syncProtocol.messageYjsSyncStep1) {
          // Ask the client for what it has that we don't (offline edits), and share cursors.
          sendTo(entry, frame(id, MSG_SYNC, (e) => syncProtocol.writeSyncStep1(e, room.ydoc)));
          const states = [...room.awareness.getStates().keys()];
          if (states.length)
            sendTo(entry, frame(id, MSG_AWARENESS, (e) => encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(room.awareness, states))));
        }
      } else if (kind === MSG_AWARENESS) {
        const upd = decoding.readVarUint8Array(dec);
        // Remember which awareness client ids this socket owns, to clear them when it leaves.
        const d2 = decoding.createDecoder(upd);
        const n = decoding.readVarUint(d2);
        const mine = room.conns.get(entry);
        for (let i = 0; i < n; i++) {
          const clientId = decoding.readVarUint(d2);
          decoding.readVarUint(d2);
          const state = JSON.parse(decoding.readVarString(d2));
          if (state === null) mine.delete(clientId);
          else mine.add(clientId);
        }
        awarenessProtocol.applyAwarenessUpdate(room.awareness, upd, entry);
      }
    } catch (e) {
      log.warn(`notes: bad frame from ${entry.user?.name} (${e.message})`);
      if (id) sendJson(entry, { type: 'doc.error', id, error: 'bad message' });
    }
  }

  function onClose(entry) {
    for (const room of rooms.values()) leave(room, entry);
  }

  /** Text of a markdown doc / JSON of a canvas, as stored now (tests, MCP later). */
  function contentOf(user, id) {
    const r = requireDoc(user, id);
    if (r.kind === 'file') throw new NotesError(400, 'attachments have no text content');
    const ydoc = rooms.get(id)?.ydoc ?? (() => {
      const d = new Y.Doc();
      for (const u of q.updates.all(id)) Y.applyUpdate(d, u.data);
      return d;
    })();
    return render(r.kind, ydoc);
  }

  /** Deleted more than 30 days ago: gone for good. */
  function purge(now = Date.now()) {
    const old = db.prepare('SELECT id FROM docs WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(now - TRASH_DAYS * 864e5);
    for (const { id } of old) {
      transaction(db, () => {
        db.prepare('DELETE FROM doc_updates WHERE doc_id = ?').run(id);
        db.prepare('DELETE FROM doc_versions WHERE doc_id = ?').run(id);
        db.prepare('DELETE FROM docs WHERE id = ?').run(id);
      });
    }
    return old.length;
  }
  const purgeTimer = setInterval(() => purge(), 6 * 3600e3);
  purgeTimer.unref?.();

  return { list, projectsFor, trash, applyOps, onFrame, onClose, recheckAll, contentOf, versions, versionContent, purge, rooms };
}
