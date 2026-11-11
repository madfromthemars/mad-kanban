// Password vault per project (end-to-end encrypted). The server stores only public keys,
// encrypted boxes and signatures; it never sees a secret or a key that opens one.
// Design: docs/design/password-vault.md. Crypto lives in the plugin (src/team/vault/crypto.ts).
//
// Who sees what: an item is visible to a person only with an access row for them AND
// membership in the item's project (the owner is NOT special here). People without access
// don't learn the item exists. Anyone with access can add or remove people (the client
// re-keys the item when removing).

import { createHash } from 'node:crypto';

import { hashToken, newId, transaction } from './db.js';

export class VaultError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const TRANSFER_TTL_MS = 15 * 60 * 1000;
const TRASH_DAYS = 30;
const MAX_BOX = 256 * 1024;

const hash = (s) => createHash('sha256').update(String(s)).digest('hex');

function b64(v, what, max = 512) {
  if (typeof v !== 'string' || !v || v.length > max || !B64.test(v)) throw new VaultError(400, `bad ${what}`);
  return v;
}
function sealedBox(v, what = 'box') {
  if (!v || v.v !== 1) throw new VaultError(400, `bad ${what}`);
  b64(v.n, `${what} nonce`, 64);
  b64(v.c, `${what} content`, MAX_BOX);
  return JSON.stringify({ v: 1, n: v.n, c: v.c });
}
function wrapped(v) {
  if (!v || v.v !== 1) throw new VaultError(400, 'bad wrapped key');
  b64(v.n, 'wrapped nonce', 64);
  b64(v.w, 'wrapped key', 256);
  b64(v.from, 'wrapped sender', 64);
  return JSON.stringify({ v: 1, n: v.n, w: v.w, from: v.from });
}

export function createVault(db, { eachSocket, isMember, log = console } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_people (
      user_id TEXT PRIMARY KEY,
      box_pub TEXT NOT NULL,
      sign_pub TEXT NOT NULL,
      recovery TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vault_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      box TEXT NOT NULL,
      sig TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      deleted_by TEXT
    );
    CREATE INDEX IF NOT EXISTS vault_items_project ON vault_items(project_id);
    CREATE TABLE IF NOT EXISTS vault_access (
      item_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      wrapped TEXT NOT NULL,
      by_user TEXT NOT NULL,
      sig TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (item_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS vault_access_user ON vault_access(user_id);
    CREATE TABLE IF NOT EXISTS vault_transfers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      code_hash TEXT,
      request_pub TEXT,
      device_name TEXT,
      box TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vault_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS vault_events_item ON vault_events(item_id, at);
  `);

  const q = {
    person: db.prepare('SELECT * FROM vault_people WHERE user_id = ?'),
    item: db.prepare('SELECT * FROM vault_items WHERE id = ?'),
    access: db.prepare('SELECT * FROM vault_access WHERE item_id = ? AND user_id = ?'),
    accessOf: db.prepare('SELECT user_id FROM vault_access WHERE item_id = ?'),
    event: db.prepare('INSERT INTO vault_events (item_id, user_id, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)'),
  };
  const event = (itemId, userId, action, target = null, detail = null) => q.event.run(itemId, userId, action, target, detail, Date.now());

  const projectExists = (pid) => !!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(pid);
  const member = (userId, pid) => projectExists(pid) && isMember(userId, pid);

  function personOut(r) {
    return r ? { boxPub: r.box_pub, signPub: r.sign_pub, hasRecovery: !!r.recovery, createdAt: r.created_at } : null;
  }

  /** An item this user may open (access row + project membership), else 404. */
  function requireItem(user, id, { deleted = false } = {}) {
    const it = q.item.get(String(id || ''));
    if (!it || !q.access.get(it.id, user.id) || !member(user.id, it.project_id)) throw new VaultError(404, 'secret not found');
    if (it.deleted_at && !deleted) throw new VaultError(410, 'secret was deleted');
    return it;
  }

  function itemOut(it, userId) {
    const mine = q.access.get(it.id, userId);
    const access = db
      .prepare('SELECT a.user_id, a.by_user, a.created_at, u.name FROM vault_access a LEFT JOIN users u ON u.id = a.user_id WHERE a.item_id = ?')
      .all(it.id)
      .map((a) => ({ userId: a.user_id, name: a.name, byUser: a.by_user, at: a.created_at }));
    return {
      id: it.id,
      projectId: it.project_id,
      version: it.version,
      box: JSON.parse(it.box),
      sig: it.sig,
      createdBy: it.created_by,
      createdAt: it.created_at,
      updatedBy: it.updated_by,
      updatedAt: it.updated_at,
      deletedAt: it.deleted_at,
      mine: { wrapped: JSON.parse(mine.wrapped), byUser: mine.by_user, sig: mine.sig },
      access,
    };
  }

  /** Tell the affected people's apps to reload (no content in the message). */
  function changed(itemId, projectId, userIds) {
    const ids = new Set(userIds);
    const msg = JSON.stringify({ type: 'vault.changed', itemId, projectId, ts: Date.now() });
    for (const s of eachSocket()) if (ids.has(s.user.id) && s.ws.readyState === s.ws.OPEN) s.ws.send(msg);
  }

  /** Access rows from a request: recipients must be project members with a key. */
  function accessRows(user, pid, list, itemId) {
    if (!Array.isArray(list) || !list.length || list.length > 200) throw new VaultError(400, 'access list required');
    const seen = new Set();
    return list.map((a) => {
      const uid = String(a?.userId || '');
      if (seen.has(uid)) throw new VaultError(400, 'duplicate person in access list');
      seen.add(uid);
      if (!member(uid, pid)) throw new VaultError(400, 'you can only share with people in this project');
      if (!q.person.get(uid)) throw new VaultError(400, 'that person has not set up passwords yet');
      return { uid, wrapped: wrapped(a.wrapped), sig: b64(a.sig, 'access signature', 128), itemId };
    });
  }

  // ---------- people ----------

  function me(user) {
    // Projects where this person can keep secrets: real membership only (owner not special).
    const projects = db
      .prepare('SELECT p.id, p.name, p.color FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ? ORDER BY p.name COLLATE NOCASE')
      .all(user.id);
    return { person: personOut(q.person.get(user.id)), projects };
  }

  /**
   * Set this person's public keys. Replacing existing keys (lost every device, starting over)
   * needs `replace: true`; their old access rows are useless then and are removed.
   */
  function setKeys(user, body) {
    const boxPub = b64(body?.boxPub, 'box key', 64);
    const signPub = b64(body?.signPub, 'sign key', 64);
    const recovery = body?.recovery != null ? sealedBox(body.recovery, 'recovery') : null;
    const cur = q.person.get(user.id);
    if (cur && (cur.box_pub !== boxPub || cur.sign_pub !== signPub)) {
      if (!body.replace) throw new VaultError(409, 'you already have keys; use your other device, your recovery code, or start over');
      transaction(db, () => {
        const items = db.prepare('SELECT item_id FROM vault_access WHERE user_id = ?').all(user.id);
        db.prepare('DELETE FROM vault_access WHERE user_id = ?').run(user.id);
        for (const { item_id } of items) event(item_id, user.id, 'keys-reset');
        db.prepare('UPDATE vault_people SET box_pub = ?, sign_pub = ?, recovery = ?, created_at = ? WHERE user_id = ?').run(boxPub, signPub, recovery, Date.now(), user.id);
      });
      log.log(`${new Date().toISOString()} vault: ${user.name} replaced their keys`);
    } else if (!cur) {
      db.prepare('INSERT INTO vault_people (user_id, box_pub, sign_pub, recovery, created_at) VALUES (?, ?, ?, ?, ?)').run(user.id, boxPub, signPub, recovery, Date.now());
      log.log(`${new Date().toISOString()} vault: ${user.name} set up passwords`);
    } else if (recovery) {
      db.prepare('UPDATE vault_people SET recovery = ? WHERE user_id = ?').run(recovery, user.id);
    }
    return me(user);
  }

  function setRecovery(user, body) {
    if (!q.person.get(user.id)) throw new VaultError(409, 'set up passwords first');
    db.prepare('UPDATE vault_people SET recovery = ? WHERE user_id = ?').run(body?.recovery == null ? null : sealedBox(body.recovery, 'recovery'), user.id);
    return me(user);
  }

  function getRecovery(user) {
    const p = q.person.get(user.id);
    if (!p?.recovery) throw new VaultError(404, 'no recovery code was saved');
    return { recovery: JSON.parse(p.recovery) };
  }

  /** People of a project (for sharing): public keys of those who set up passwords. */
  function people(user, projectId) {
    if (!member(user.id, projectId)) throw new VaultError(404, 'project not found');
    return db
      .prepare(
        `SELECT u.id, u.name, p.box_pub, p.sign_pub FROM users u JOIN project_members m ON m.user_id = u.id
         LEFT JOIN vault_people p ON p.user_id = u.id WHERE m.project_id = ? AND u.disabled = 0 ORDER BY u.name COLLATE NOCASE`
      )
      .all(projectId)
      .map((r) => ({ userId: r.id, name: r.name, boxPub: r.box_pub, signPub: r.sign_pub, ready: !!r.box_pub }));
  }

  /** Public keys of specific people (to check signatures of whoever shared or edited). */
  function keysOf(user, ids) {
    const out = {};
    for (const id of [...new Set(ids)].slice(0, 200)) {
      const p = q.person.get(String(id));
      if (p) out[id] = { boxPub: p.box_pub, signPub: p.sign_pub };
    }
    return { keys: out };
  }

  // ---------- items ----------

  function list(user, projectId) {
    const rows = db
      .prepare(
        `SELECT i.* FROM vault_items i JOIN vault_access a ON a.item_id = i.id AND a.user_id = ?
         WHERE i.deleted_at IS NULL ${projectId ? 'AND i.project_id = ?' : ''} ORDER BY i.updated_at DESC`
      )
      .all(...(projectId ? [user.id, projectId] : [user.id]));
    return { items: rows.filter((it) => member(user.id, it.project_id)).map((it) => itemOut(it, user.id)) };
  }

  function trash(user) {
    const rows = db
      .prepare('SELECT i.* FROM vault_items i JOIN vault_access a ON a.item_id = i.id AND a.user_id = ? WHERE i.deleted_at IS NOT NULL ORDER BY i.deleted_at DESC')
      .all(user.id);
    return { items: rows.filter((it) => member(user.id, it.project_id)).map((it) => itemOut(it, user.id)) };
  }

  function create(user, body) {
    const pid = String(body?.projectId || '');
    if (!member(user.id, pid)) throw new VaultError(404, 'project not found');
    if (!q.person.get(user.id)) throw new VaultError(409, 'set up passwords first');
    const id = body.id != null ? String(body.id) : newId(14);
    if (!/^[a-z0-9]{10,24}$/.test(id)) throw new VaultError(400, 'bad id');
    if (q.item.get(id)) throw new VaultError(409, 'id already used');
    const box = sealedBox(body.box);
    const sig = b64(body.sig, 'signature', 128);
    const rows = accessRows(user, pid, body.access, id);
    if (!rows.some((r) => r.uid === user.id)) throw new VaultError(400, 'include yourself in the access list');
    const now = Date.now();
    transaction(db, () => {
      db.prepare(
        'INSERT INTO vault_items (id, project_id, version, box, sig, created_by, created_at, updated_by, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)'
      ).run(id, pid, box, sig, user.id, now, user.id, now);
      for (const r of rows)
        db.prepare('INSERT INTO vault_access (item_id, user_id, wrapped, by_user, sig, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, r.uid, r.wrapped, user.id, r.sig, now);
      event(id, user.id, 'created');
      for (const r of rows) if (r.uid !== user.id) event(id, user.id, 'shared', r.uid);
    });
    changed(id, pid, rows.map((r) => r.uid));
    return { item: itemOut(q.item.get(id), user.id) };
  }

  /**
   * Edit content (`box`, `sig`, `version` = the version you edited). With `access` (the full
   * new list, each with a freshly wrapped key) it's a re-key: used when removing people.
   */
  function update(user, id, body) {
    const it = requireItem(user, id);
    if (Number(body?.version) !== it.version) throw new VaultError(409, 'someone else changed this secret; reload and try again');
    const box = sealedBox(body.box);
    const sig = b64(body.sig, 'signature', 128);
    const before = q.accessOf.all(it.id).map((r) => r.user_id);
    const rows = body.access != null ? accessRows(user, it.project_id, body.access, it.id) : null;
    if (rows && !rows.some((r) => r.uid === user.id) && rows.length) {
      // removing yourself is fine (you just lose it) — but someone must keep it
    }
    const now = Date.now();
    transaction(db, () => {
      db.prepare('UPDATE vault_items SET version = version + 1, box = ?, sig = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(box, sig, user.id, now, it.id);
      event(it.id, user.id, rows ? 'rekeyed' : 'edited');
      if (rows) {
        const keep = new Set(rows.map((r) => r.uid));
        for (const uid of before) if (!keep.has(uid)) event(it.id, user.id, 'removed', uid);
        db.prepare('DELETE FROM vault_access WHERE item_id = ?').run(it.id);
        for (const r of rows) {
          const old = before.includes(r.uid);
          db.prepare('INSERT INTO vault_access (item_id, user_id, wrapped, by_user, sig, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(it.id, r.uid, r.wrapped, user.id, r.sig, now);
          if (!old) event(it.id, user.id, 'shared', r.uid);
        }
      }
    });
    changed(it.id, it.project_id, [...before, ...(rows || []).map((r) => r.uid)]);
    const after = q.access.get(it.id, user.id);
    return { item: after ? itemOut(q.item.get(it.id), user.id) : null };
  }

  /** Add one person (the item key wrapped for them by someone who has it). */
  function share(user, id, body) {
    const it = requireItem(user, id);
    const [r] = accessRows(user, it.project_id, [body], it.id);
    if (q.access.get(it.id, r.uid)) throw new VaultError(409, 'they already have it');
    db.prepare('INSERT INTO vault_access (item_id, user_id, wrapped, by_user, sig, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(it.id, r.uid, r.wrapped, user.id, r.sig, Date.now());
    event(it.id, user.id, 'shared', r.uid);
    changed(it.id, it.project_id, q.accessOf.all(it.id).map((a) => a.user_id));
    return { item: itemOut(q.item.get(it.id), user.id) };
  }

  function remove(user, id) {
    const it = requireItem(user, id);
    db.prepare('UPDATE vault_items SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(Date.now(), user.id, it.id);
    event(it.id, user.id, 'deleted');
    changed(it.id, it.project_id, q.accessOf.all(it.id).map((a) => a.user_id));
    return { ok: true };
  }

  function restore(user, id) {
    const it = requireItem(user, id, { deleted: true });
    db.prepare('UPDATE vault_items SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(it.id);
    event(it.id, user.id, 'restored');
    changed(it.id, it.project_id, q.accessOf.all(it.id).map((a) => a.user_id));
    return { item: itemOut(q.item.get(it.id), user.id) };
  }

  const LOGGED = new Set(['opened', 'copied', 'revealed']);
  function report(user, id, body) {
    const it = requireItem(user, id);
    const action = String(body?.action || '');
    if (!LOGGED.has(action)) throw new VaultError(400, 'unknown action');
    event(it.id, user.id, action, null, body?.field ? String(body.field).slice(0, 60) : null);
    return { ok: true };
  }

  function history(user, id) {
    const it = requireItem(user, id, { deleted: true });
    const names = new Map(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
    return {
      events: db
        .prepare('SELECT * FROM vault_events WHERE item_id = ? ORDER BY at DESC LIMIT 300')
        .all(it.id)
        .map((e) => ({ action: e.action, by: names.get(e.user_id) || e.user_id, target: e.target ? names.get(e.target) || e.target : null, detail: e.detail, at: e.at })),
    };
  }

  // ---------- moving keys to another device ----------

  /** QR: the old device leaves the person key, locked with the link's one-time key, on a pairing code. */
  function putQrTransfer(user, body) {
    const code = String(body?.pairCode || '');
    const row = db.prepare('SELECT user_id, used_at, expires_at FROM pairing_codes WHERE code_hash = ?').get(hashToken(code));
    if (!row || row.user_id !== user.id || row.used_at || row.expires_at < Date.now()) throw new VaultError(404, 'pairing code not found');
    db.prepare('DELETE FROM vault_transfers WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO vault_transfers (id, user_id, kind, code_hash, box, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      newId(16),
      user.id,
      'qr',
      hash(code),
      sealedBox(body.box, 'transfer'),
      Date.now(),
      row.expires_at + 5 * 60 * 1000
    );
    return { ok: true };
  }

  /** The new device (signed in with that code) picks it up once. */
  function takeQrTransfer(user, code) {
    const t = db.prepare("SELECT * FROM vault_transfers WHERE kind = 'qr' AND code_hash = ? AND user_id = ? AND expires_at > ?").get(hash(code), user.id, Date.now());
    if (!t) throw new VaultError(404, 'nothing waiting for this device');
    db.prepare('DELETE FROM vault_transfers WHERE id = ?').run(t.id);
    return { box: JSON.parse(t.box) };
  }

  /** "Allow this device": a device without the key asks; the person's other devices answer. */
  function request(user, body) {
    const pub = b64(body?.requestPub, 'request key', 64);
    db.prepare('DELETE FROM vault_transfers WHERE expires_at < ? OR (user_id = ? AND kind = ? AND request_pub = ?)').run(Date.now(), user.id, 'allow', pub);
    const id = newId(16);
    db.prepare('INSERT INTO vault_transfers (id, user_id, kind, request_pub, device_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      user.id,
      'allow',
      pub,
      String(body?.deviceName || 'a device').slice(0, 80),
      Date.now(),
      Date.now() + TRANSFER_TTL_MS
    );
    const msg = JSON.stringify({ type: 'vault.request', id, ts: Date.now() });
    for (const s of eachSocket()) if (s.user.id === user.id && s.ws.readyState === s.ws.OPEN) s.ws.send(msg);
    return { id, expiresAt: Date.now() + TRANSFER_TTL_MS };
  }

  function pending(user) {
    return {
      requests: db
        .prepare("SELECT id, request_pub, device_name, created_at, expires_at FROM vault_transfers WHERE user_id = ? AND kind = 'allow' AND box IS NULL AND expires_at > ?")
        .all(user.id, Date.now())
        .map((r) => ({ id: r.id, requestPub: r.request_pub, deviceName: r.device_name, createdAt: r.created_at, expiresAt: r.expires_at })),
    };
  }

  function answer(user, id, body) {
    const t = db.prepare("SELECT * FROM vault_transfers WHERE id = ? AND user_id = ? AND kind = 'allow' AND expires_at > ?").get(String(id), user.id, Date.now());
    if (!t) throw new VaultError(404, 'request not found or expired');
    if (body?.deny) {
      db.prepare('DELETE FROM vault_transfers WHERE id = ?').run(t.id);
      return { ok: true };
    }
    const b = body?.box;
    if (!b || b.v !== 1) throw new VaultError(400, 'bad box');
    b64(b.n, 'nonce', 64);
    b64(b.c, 'content', 8192);
    b64(b.from, 'sender', 64);
    db.prepare('UPDATE vault_transfers SET box = ? WHERE id = ?').run(JSON.stringify({ v: 1, n: b.n, c: b.c, from: b.from }), t.id);
    const msg = JSON.stringify({ type: 'vault.answered', id: t.id, ts: Date.now() });
    for (const s of eachSocket()) if (s.user.id === user.id && s.ws.readyState === s.ws.OPEN) s.ws.send(msg);
    return { ok: true };
  }

  function takeAnswer(user, id) {
    const t = db.prepare("SELECT * FROM vault_transfers WHERE id = ? AND user_id = ? AND kind = 'allow'").get(String(id), user.id);
    if (!t) throw new VaultError(404, 'request not found or expired');
    if (!t.box) return { box: null };
    db.prepare('DELETE FROM vault_transfers WHERE id = ?').run(t.id);
    return { box: JSON.parse(t.box) };
  }

  // ---------- housekeeping ----------

  /** Someone left a project / was disabled: drop their keys to its secrets. */
  function recheckAll() {
    const rows = db.prepare('SELECT a.item_id, a.user_id, i.project_id FROM vault_access a JOIN vault_items i ON i.id = a.item_id').all();
    const notify = new Map();
    for (const r of rows) {
      const u = db.prepare('SELECT disabled FROM users WHERE id = ?').get(r.user_id);
      if (u && !u.disabled && member(r.user_id, r.project_id)) continue;
      db.prepare('DELETE FROM vault_access WHERE item_id = ? AND user_id = ?').run(r.item_id, r.user_id);
      event(r.item_id, r.user_id, 'lost-access');
      notify.set(r.item_id, r.project_id);
    }
    for (const [itemId, pid] of notify) changed(itemId, pid, q.accessOf.all(itemId).map((a) => a.user_id));
  }

  function purge(now = Date.now()) {
    const old = db.prepare('SELECT id FROM vault_items WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(now - TRASH_DAYS * 864e5);
    for (const { id } of old) {
      transaction(db, () => {
        db.prepare('DELETE FROM vault_access WHERE item_id = ?').run(id);
        db.prepare('DELETE FROM vault_events WHERE item_id = ?').run(id);
        db.prepare('DELETE FROM vault_items WHERE id = ?').run(id);
      });
    }
    db.prepare('DELETE FROM vault_transfers WHERE expires_at < ?').run(now);
    return old.length;
  }
  const timer = setInterval(() => purge(), 6 * 3600e3);
  timer.unref?.();

  return { me, setKeys, setRecovery, getRecovery, people, keysOf, list, trash, create, update, share, remove, restore, report, history, putQrTransfer, takeQrTransfer, request, pending, answer, takeAnswer, recheckAll, purge };
}

