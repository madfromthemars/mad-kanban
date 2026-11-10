// Shared notes (notes.js): tree ops over REST, live Yjs sync over /ws, access rules.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const PORT = 19300 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'test-admin';
let proc;
let dataDir;

async function startServer() {
  proc = spawn(process.execPath, ['index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      ADMIN_TOKEN: ADMIN,
      TELEGRAM_BOT_TOKEN: '',
      NOTES_MAX_DOC_BYTES: '20000',
      NOTES_COMPACT_AFTER: '50',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => String(d).includes('listening') && resolve());
    proc.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
}
async function stopServer() {
  const p = proc;
  await new Promise((r) => {
    p.once('exit', r);
    p.kill();
  });
}

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}
const ops = (token, list) => api('POST', '/api/docs/ops', { ops: list }, token);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 3000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return;
    await sleep(15);
  }
  throw new Error(`timed out: ${what}`);
};
const b64 = (u8) => Buffer.from(u8).toString('base64');
const mdUpdate = (text) => {
  const d = new Y.Doc();
  d.getText('content').insert(0, text);
  return b64(Y.encodeStateAsUpdate(d));
};

/** A minimal notes client: one socket, Y.Docs by id, JSON messages collected. */
async function client(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
  ws.binaryType = 'arraybuffer';
  const c = { ws, docs: new Map(), json: [] };
  const send = (id, kind, write) => {
    const enc = encoding.createEncoder();
    encoding.writeVarString(enc, id);
    encoding.writeVarUint(enc, kind);
    write?.(enc);
    ws.send(encoding.toUint8Array(enc));
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') return c.json.push(JSON.parse(e.data));
    const dec = decoding.createDecoder(new Uint8Array(e.data));
    const id = decoding.readVarString(dec);
    const kind = decoding.readVarUint(dec);
    const entry = c.docs.get(id);
    if (!entry) return;
    if (kind === 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarString(enc, id);
      encoding.writeVarUint(enc, 0);
      const before = encoding.length(enc);
      syncProtocol.readSyncMessage(dec, enc, entry.doc, c);
      if (encoding.length(enc) > before) ws.send(encoding.toUint8Array(enc));
    } else if (kind === 1) {
      awarenessProtocol.applyAwarenessUpdate(entry.awareness, decoding.readVarUint8Array(dec), c);
    }
  };
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  c.open = (id, doc = new Y.Doc()) => {
    const awareness = new awarenessProtocol.Awareness(doc);
    c.docs.set(id, { doc, awareness });
    doc.on('update', (u, origin) => origin !== c && send(id, 0, (enc) => syncProtocol.writeUpdate(enc, u)));
    awareness.on('update', ({ added, updated, removed }, origin) => {
      if (origin === c) return;
      send(id, 1, (enc) => encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, added.concat(updated, removed))));
    });
    send(id, 0, (enc) => syncProtocol.writeSyncStep1(enc, doc));
    return { doc, text: doc.getText('content'), awareness };
  };
  c.unsub = (id) => send(id, 2);
  c.raw = send;
  c.close = () => {
    ws.close();
    for (const d of c.docs.values()) d.awareness.destroy(); // its timer would keep the test process alive
  };
  return c;
}

let A, B, C, P, Q; // owner, member of P, outsider; projects P and Q

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'kanban-notes-'));
  await startServer();
  A = (await api('POST', '/api/admin/users', { name: 'Ann' }, ADMIN)).json;
  B = (await api('POST', '/api/admin/users', { name: 'Bob' }, ADMIN)).json;
  C = (await api('POST', '/api/admin/users', { name: 'Cid' }, ADMIN)).json;
  await api('POST', '/api/team/projects', { name: 'catalog' }, A.token);
  await api('POST', '/api/team/projects', { name: 'onemenu' }, A.token);
  const team = (await api('GET', '/api/team', null, A.token)).json;
  P = team.projects.find((p) => p.name === 'catalog');
  Q = team.projects.find((p) => p.name === 'onemenu');
  await api('PUT', `/api/team/projects/${P.id}/members/${B.id}`, null, A.token);
});
after(async () => {
  await stopServer();
  rmSync(dataDir, { recursive: true, force: true });
});

test('notes: paths are checked', async () => {
  for (const bad of ['', '/abs.md', '../x.md', 'a//b.md', 'a/./b.md', '.hidden/x.md', 'x?.md', 'pic.png', 'noext', 'a /b.md', 'a./b.md'])
    assert.equal((await ops(A.token, [{ type: 'doc.create', projectId: P.id, path: bad }])).status, 400, `rejects "${bad}"`);
  const r = await ops(A.token, [{ type: 'doc.create', projectId: P.id, path: 'Plans/Ok name (1).md' }]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('notes: create, list per project, outsiders see nothing', async () => {
  const r = await ops(A.token, [
    { type: 'doc.create', id: 'plan00000001', projectId: P.id, path: 'Plan.md', update: mdUpdate('# Plan\n') },
    { type: 'doc.create', id: 'menu00000001', projectId: Q.id, path: 'Menu.canvas' },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.results[0].doc.kind, 'md');
  assert.equal(r.json.results[1].doc.kind, 'canvas');

  const paths = async (u) => (await api('GET', '/api/docs', null, u.token)).json.docs.map((d) => d.path).sort();
  assert.deepEqual(await paths(A), ['Menu.canvas', 'Plan.md', 'Plans/Ok name (1).md']); // owner: every project
  assert.deepEqual(await paths(B), ['Plan.md', 'Plans/Ok name (1).md']);
  assert.deepEqual(await paths(C), []);
  assert.equal((await api('GET', '/api/docs/plan00000001/content', null, B.token)).json.content, '# Plan\n');
  assert.equal((await api('GET', '/api/docs/plan00000001/content', null, C.token)).status, 404);
  // Outsiders can't create in someone else's project either, nor in private ones.
  assert.equal((await ops(C.token, [{ type: 'doc.create', projectId: P.id, path: 'x.md' }])).status, 404);
  assert.equal((await ops(B.token, [{ type: 'doc.create', projectId: `me:${B.id}`, path: 'x.md' }])).status, 404);
});

test('notes: same path (any letter case) is refused, or renamed on request; batches are all-or-nothing', async () => {
  let r = await ops(B.token, [{ type: 'doc.create', projectId: P.id, path: 'plan.MD' }]);
  assert.equal(r.status, 409);
  r = await ops(B.token, [{ type: 'doc.create', projectId: P.id, path: 'Plan.md', rename: true }]);
  assert.equal(r.json.results[0].doc.path, 'Plan (2).md');
  // second op fails -> first one is rolled back
  r = await ops(B.token, [
    { type: 'doc.create', projectId: P.id, path: 'Rolled back.md' },
    { type: 'doc.create', projectId: P.id, path: 'Plan.md' },
  ]);
  assert.equal(r.status, 409);
  const docs = (await api('GET', '/api/docs', null, B.token)).json.docs;
  assert.ok(!docs.some((d) => d.path === 'Rolled back.md'));
});

test('notes: live editing between two people, cursors, offline edits merge', async () => {
  const a = await client(A.token);
  const b = await client(B.token);
  const da = a.open('plan00000001');
  const db = b.open('plan00000001');
  await until(() => db.text.toString() === '# Plan\n', 'B gets stored content');

  const t0 = performance.now();
  da.text.insert(da.text.length, 'Ann typing');
  await until(() => db.text.toString().endsWith('Ann typing'), 'B sees typing');
  assert.ok(performance.now() - t0 < 500);

  // both type in the same line at once
  da.text.insert(2, 'A');
  db.text.insert(3, 'B');
  await until(() => da.text.toString() === db.text.toString() && da.text.toString().includes('A') && db.text.toString().includes('B'), 'converge');

  // cursors (awareness)
  da.awareness.setLocalStateField('user', { name: 'Ann', color: '#c33' });
  await until(() => [...db.awareness.getStates().values()].some((s) => s.user?.name === 'Ann'), 'B sees Ann');
  // Ann goes away -> her cursor disappears for Bob
  a.close();
  await until(() => ![...db.awareness.getStates().values()].some((s) => s.user?.name === 'Ann'), 'Ann cursor removed');

  // Ann edits "offline" (a doc she kept), Bob edits online; then Ann reconnects.
  da.text.insert(0, 'Offline line\n');
  db.text.insert(db.text.length, '\nOnline line');
  await sleep(100);
  const a2 = await client(A.token);
  const da2 = a2.open('plan00000001', da.text.doc);
  await until(() => db.text.toString().startsWith('Offline line') && da2.text.toString() === db.text.toString(), 'offline merge');
  a2.close();
  b.close();
});

test('notes: outsiders and non-members get an error, not the content', async () => {
  const c = await client(C.token);
  const dc = c.open('plan00000001');
  await until(() => c.json.some((m) => m.type === 'doc.error' && m.id === 'plan00000001'), 'error for outsider');
  assert.equal(dc.text.toString(), '');
  c.close();
});

test('notes: tree changes are announced to the right people', async () => {
  const a = await client(A.token);
  const b = await client(B.token);
  const c = await client(C.token);
  await sleep(100);
  // rename inside the project
  let r = await ops(A.token, [{ type: 'doc.move', id: 'plan00000001', path: 'Plans/Plan.md' }]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const v = r.json.results[0].doc.version;
  await until(() => b.json.some((m) => m.type === 'docs.changed' && m.doc.path === 'Plans/Plan.md'), 'B told about rename');
  // stale version -> conflict
  r = await ops(B.token, [{ type: 'doc.move', id: 'plan00000001', path: 'Old.md', version: v - 1 }]);
  assert.equal(r.status, 409);
  // moving into a project Bob isn't in: Bob is told it's gone, Cid hears nothing
  r = await ops(A.token, [{ type: 'doc.move', id: 'plan00000001', projectId: Q.id }]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await until(() => b.json.some((m) => m.type === 'docs.removed' && m.id === 'plan00000001'), 'B told removed');
  assert.ok(!c.json.some((m) => m.type?.startsWith('docs.')));
  // Bob can't move it back (can't see Q)
  assert.equal((await ops(B.token, [{ type: 'doc.move', id: 'plan00000001', projectId: P.id }])).status, 404);
  r = await ops(A.token, [{ type: 'doc.move', id: 'plan00000001', projectId: P.id, path: 'Plans/Plan.md' }]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  a.close();
  b.close();
  c.close();
});

test('notes: delete closes live sessions, trash, restore', async () => {
  const b = await client(B.token);
  const db = b.open('plan00000001');
  await until(() => db.text.length > 0, 'loaded');
  let r = await ops(A.token, [{ type: 'doc.delete', id: 'plan00000001' }]);
  assert.equal(r.status, 200);
  await until(() => b.json.some((m) => m.type === 'doc.closed' && m.reason === 'deleted'), 'B session closed');
  assert.ok(!(await api('GET', '/api/docs', null, B.token)).json.docs.some((d) => d.id === 'plan00000001'));
  assert.ok((await api('GET', '/api/docs/trash', null, B.token)).json.docs.some((d) => d.id === 'plan00000001'));
  assert.equal((await api('GET', '/api/docs/plan00000001/content', null, B.token)).status, 410);
  // someone takes the path meanwhile -> restore picks a free name
  await ops(B.token, [{ type: 'doc.create', projectId: P.id, path: 'Plans/Plan.md' }]);
  r = await ops(B.token, [{ type: 'doc.restore', id: 'plan00000001' }]);
  assert.equal(r.json.results[0].doc.path, 'Plans/Plan (2).md');
  assert.match((await api('GET', '/api/docs/plan00000001/content', null, B.token)).json.content, /Online line/);
  b.close();
});

test('notes: removing someone from the project ends their live session', async () => {
  const b = await client(B.token);
  const a = await client(A.token);
  const db = b.open('plan00000001');
  const da = a.open('plan00000001');
  await until(() => db.text.length > 0 && da.text.length > 0, 'both loaded');
  await api('DELETE', `/api/team/projects/${P.id}/members/${B.id}`, null, A.token);
  await until(() => b.json.some((m) => m.type === 'doc.closed' && m.reason === 'no access'), 'B closed');
  const before = db.text.toString();
  da.text.insert(0, 'secret after removal ');
  await sleep(300);
  assert.equal(db.text.toString(), before, 'no more updates for B');
  // B's own writes are refused too
  db.text.insert(0, 'sneaky ');
  await sleep(300);
  assert.ok(!da.text.toString().includes('sneaky'));
  assert.equal((await api('GET', '/api/docs', null, B.token)).json.docs.length, 0);
  await api('PUT', `/api/team/projects/${P.id}/members/${B.id}`, null, A.token);
  a.close();
  b.close();
});

test('notes: size cap, compaction, survives a restart', async () => {
  const a = await client(A.token);
  const d = a.open('plan00000001');
  await until(() => d.text.length > 0, 'loaded');
  for (let i = 0; i < 120; i++) d.text.insert(d.text.length, 'x');
  await sleep(500);
  const sqlite = new DatabaseSync(path.join(dataDir, 'kanban.db'));
  const rows = sqlite.prepare('SELECT COUNT(*) AS n FROM doc_updates WHERE doc_id = ?').get('plan00000001').n;
  assert.ok(rows <= 51, `compacted (${rows} rows)`);
  sqlite.close();

  // A huge paste is refused once the doc would pass the cap (20 kB in this test).
  d.text.insert(d.text.length, 'y'.repeat(30000));
  await until(() => a.json.some((m) => m.type === 'doc.error' && m.error === 'too large'), 'too large');
  a.close();

  const expected = (await api('GET', '/api/docs/plan00000001/content', null, A.token)).json.content;
  assert.ok(expected.endsWith('x'.repeat(120)));
  await stopServer();
  await startServer();
  assert.equal((await api('GET', '/api/docs/plan00000001/content', null, A.token)).json.content, expected);
  const a2 = await client(A.token);
  const d2 = a2.open('plan00000001');
  await until(() => d2.text.toString() === expected, 'fresh client after restart');
  a2.close();
});
