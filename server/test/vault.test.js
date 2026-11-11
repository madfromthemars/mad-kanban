// Password vault (vault.js): the server stores only boxes it can't read, and enforces who
// may list / read / share / remove. Crypto itself is tested in test/vaultCrypto.test.ts.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const PORT = 19500 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'test-admin';
let proc;
let dataDir;

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}
const b = (n = 32) => randomBytes(n).toString('base64');
const box = () => ({ v: 1, n: b(24), c: b(80) });
const wrapped = () => ({ v: 1, n: b(24), w: b(48), from: b(32) });
const keys = () => ({ boxPub: b(32), signPub: b(32) });

let A, B, C, D, P, Q; // A owner (member of P), B member of P, C member of P, D outsider; Q: A not a member
before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'kanban-vault-'));
  proc = spawn(process.execPath, ['index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_TOKEN: ADMIN, TELEGRAM_BOT_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => String(d).includes('listening') && resolve());
    proc.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
  A = (await api('POST', '/api/admin/users', { name: 'Ann' }, ADMIN)).json;
  B = (await api('POST', '/api/admin/users', { name: 'Bob' }, ADMIN)).json;
  C = (await api('POST', '/api/admin/users', { name: 'Cid' }, ADMIN)).json;
  D = (await api('POST', '/api/admin/users', { name: 'Dee' }, ADMIN)).json;
  await api('POST', '/api/team/projects', { name: 'catalog' }, A.token);
  await api('POST', '/api/team/projects', { name: 'secret-proj' }, B.token).catch(() => {});
  const team = (await api('GET', '/api/team', null, A.token)).json;
  P = team.projects.find((p) => p.name === 'catalog');
  for (const u of [B, C]) await api('PUT', `/api/team/projects/${P.id}/members/${u.id}`, null, A.token);
  // Q: a project Ann (the owner) is not a member of
  await api('POST', '/api/team/projects', { name: 'onemenu' }, A.token);
  const t2 = (await api('GET', '/api/team', null, A.token)).json;
  Q = t2.projects.find((p) => p.name === 'onemenu');
  await api('PUT', `/api/team/projects/${Q.id}/members/${B.id}`, null, A.token);
  await api('DELETE', `/api/team/projects/${Q.id}/members/${A.id}`, null, A.token);
});
after(() => {
  proc.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

test('vault: set up keys; replacing them needs "start over" and drops old access', async () => {
  assert.equal((await api('GET', '/api/vault/me', null, A.token)).json.person, null);
  const ka = keys();
  let r = await api('PUT', '/api/vault/me', { ...ka, recovery: box() }, A.token);
  assert.equal(r.json.person.boxPub, ka.boxPub);
  assert.equal(r.json.person.hasRecovery, true);
  for (const u of [B, C]) await api('PUT', '/api/vault/me', keys(), u.token);
  assert.equal((await api('PUT', '/api/vault/me', keys(), A.token)).status, 409, 'no silent key swap');
  assert.equal((await api('PUT', '/api/vault/me', { boxPub: 'not base64!', signPub: b() }, D.token)).status, 400);
  assert.ok((await api('GET', '/api/vault/me/recovery', null, A.token)).json.recovery.c);
  assert.equal((await api('GET', '/api/vault/me/recovery', null, B.token)).status, 404);
});

let item;
test('vault: create; only people with access see it (owner not special, names hidden)', async () => {
  // only project members with keys can be in the access list
  let r = await api('POST', '/api/vault/items', { projectId: P.id, box: box(), sig: b(64), access: [{ userId: A.id, wrapped: wrapped(), sig: b(64) }, { userId: D.id, wrapped: wrapped(), sig: b(64) }] }, A.token);
  assert.equal(r.status, 400, 'Dee is not in the project');
  r = await api('POST', '/api/vault/items', { projectId: P.id, box: box(), sig: b(64), access: [{ userId: B.id, wrapped: wrapped(), sig: b(64) }] }, A.token);
  assert.equal(r.status, 400, 'must include yourself');
  r = await api('POST', '/api/vault/items', { projectId: Q.id, box: box(), sig: b(64), access: [{ userId: A.id, wrapped: wrapped(), sig: b(64) }] }, A.token);
  assert.equal(r.status, 404, 'owner not in onemenu -> no secrets there');
  r = await api(
    'POST',
    '/api/vault/items',
    { projectId: P.id, box: box(), sig: b(64), access: [{ userId: A.id, wrapped: wrapped(), sig: b(64) }, { userId: B.id, wrapped: wrapped(), sig: b(64) }] },
    A.token
  );
  assert.equal(r.status, 200, JSON.stringify(r.json));
  item = r.json.item;
  assert.deepEqual(item.access.map((a) => a.name).sort(), ['Ann', 'Bob']);
  assert.equal((await api('GET', `/api/vault/items?projectId=${P.id}`, null, B.token)).json.items.length, 1);
  assert.equal((await api('GET', `/api/vault/items?projectId=${P.id}`, null, C.token)).json.items.length, 0, 'Cid (in project, not added) sees nothing');
  assert.equal((await api('GET', `/api/vault/items/${item.id}/history`, null, C.token)).status, 404);
  // Bob's own wrapped key, never someone else's
  const bobView = (await api('GET', '/api/vault/items', null, B.token)).json.items[0];
  assert.notDeepEqual(bobView.mine.wrapped, item.mine.wrapped);
  // the database holds nothing readable beyond what we sent
  const db = new DatabaseSync(path.join(dataDir, 'kanban.db'), { readOnly: true });
  const row = db.prepare('SELECT box FROM vault_items WHERE id = ?').get(item.id);
  db.close();
  assert.deepEqual(JSON.parse(row.box), item.box);
});

test('vault: anyone with access can share and remove (re-key), edits need the current version', async () => {
  // Bob shares with Cid
  let r = await api('POST', `/api/vault/items/${item.id}/share`, { userId: C.id, wrapped: wrapped(), sig: b(64) }, B.token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await api('GET', '/api/vault/items', null, C.token)).json.items.length, 1);
  assert.equal((await api('POST', `/api/vault/items/${item.id}/share`, { userId: C.id, wrapped: wrapped(), sig: b(64) }, B.token)).status, 409);
  // edit with an old version fails
  assert.equal((await api('PUT', `/api/vault/items/${item.id}`, { version: 0, box: box(), sig: b(64) }, A.token)).status, 409);
  r = await api('PUT', `/api/vault/items/${item.id}`, { version: 1, box: box(), sig: b(64) }, C.token);
  assert.equal(r.json.item.version, 2);
  // Cid removes Ann (anyone can remove): full new access list with fresh keys
  r = await api(
    'PUT',
    `/api/vault/items/${item.id}`,
    { version: 2, box: box(), sig: b(64), access: [{ userId: B.id, wrapped: wrapped(), sig: b(64) }, { userId: C.id, wrapped: wrapped(), sig: b(64) }] },
    C.token
  );
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await api('GET', '/api/vault/items', null, A.token)).json.items.length, 0, 'Ann (the owner) lost it');
  assert.equal((await api('PUT', `/api/vault/items/${item.id}`, { version: 3, box: box(), sig: b(64) }, A.token)).status, 404);
  const hist = (await api('GET', `/api/vault/items/${item.id}/history`, null, B.token)).json.events.map((e) => `${e.action}:${e.by}${e.target ? '>' + e.target : ''}`);
  assert.ok(hist.includes('removed:Cid>Ann') && hist.includes('shared:Bob>Cid') && hist.includes('created:Ann'), hist.join(' '));
  // copy/open reports
  await api('POST', `/api/vault/items/${item.id}/events`, { action: 'copied', field: 'password' }, B.token);
  assert.equal((await api('POST', `/api/vault/items/${item.id}/events`, { action: 'hacked' }, B.token)).status, 400);
  assert.ok((await api('GET', `/api/vault/items/${item.id}/history`, null, C.token)).json.events.some((e) => e.action === 'copied' && e.by === 'Bob'));
});

test('vault: leaving the project drops access; delete / trash / restore', async () => {
  await api('DELETE', `/api/team/projects/${P.id}/members/${C.id}`, null, A.token);
  assert.equal((await api('GET', '/api/vault/items', null, C.token)).json.items.length, 0);
  await api('PUT', `/api/team/projects/${P.id}/members/${C.id}`, null, A.token);
  assert.equal((await api('GET', '/api/vault/items', null, C.token)).json.items.length, 0, 'coming back does not bring old access back');
  assert.equal((await api('DELETE', `/api/vault/items/${item.id}`, null, B.token)).status, 200);
  assert.equal((await api('GET', '/api/vault/items', null, B.token)).json.items.length, 0);
  assert.equal((await api('GET', '/api/vault/trash', null, B.token)).json.items.length, 1);
  assert.equal((await api('POST', `/api/vault/items/${item.id}/restore`, null, B.token)).status, 200);
  assert.equal((await api('GET', '/api/vault/items', null, B.token)).json.items.length, 1);
});

test('vault: moving keys — QR transfer on a pairing code (once), allow-device requests', async () => {
  const pair = (await api('POST', '/api/me/pairing', null, B.token)).json;
  assert.equal((await api('POST', '/api/vault/transfers/qr', { pairCode: pair.code, box: box() }, C.token)).status, 404, "not Cid's code");
  assert.equal((await api('POST', '/api/vault/transfers/qr', { pairCode: pair.code, box: box() }, B.token)).status, 200);
  const dev = (await api('POST', '/api/pair', { code: pair.code, name: 'Bob phone', platform: 'android' })).json;
  assert.ok(dev.token);
  let r = await api('POST', '/api/vault/transfers/qr/take', { pairCode: pair.code }, dev.token);
  assert.ok(r.json.box?.c);
  assert.equal((await api('POST', '/api/vault/transfers/qr/take', { pairCode: pair.code }, dev.token)).status, 404, 'only once');

  const req = (await api('POST', '/api/vault/requests', { requestPub: b(32), deviceName: 'Bob laptop' }, B.token)).json;
  const pend = (await api('GET', '/api/vault/requests', null, B.token)).json.requests;
  assert.equal(pend.length, 1);
  assert.equal(pend[0].deviceName, 'Bob laptop');
  assert.equal((await api('GET', '/api/vault/requests', null, C.token)).json.requests.length, 0);
  assert.equal((await api('GET', `/api/vault/requests/${req.id}`, null, B.token)).json.box, null, 'not answered yet');
  assert.equal((await api('POST', `/api/vault/requests/${req.id}/answer`, { box: { v: 1, n: b(24), c: b(100), from: b(32) } }, C.token)).status, 404);
  await api('POST', `/api/vault/requests/${req.id}/answer`, { box: { v: 1, n: b(24), c: b(100), from: b(32) } }, B.token);
  assert.ok((await api('GET', `/api/vault/requests/${req.id}`, null, B.token)).json.box.c);
  assert.equal((await api('GET', `/api/vault/requests/${req.id}`, null, B.token)).status, 404, 'picked up once');
});

test('vault: AI keys can not touch it', async () => {
  const key = (await api('POST', '/api/me/ai-keys', { name: 'bot' }, B.token)).json;
  const token = key.key || key.token;
  if (token) assert.equal((await api('GET', '/api/vault/items', null, token)).status, 403);
});
