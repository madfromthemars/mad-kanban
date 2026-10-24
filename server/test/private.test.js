import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const PORT = 19100 + Math.floor(Math.random() * 100);
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

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'kanban-private-'));
  proc = spawn(process.execPath, ['index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_TOKEN: ADMIN, TELEGRAM_BOT_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => String(d).includes('listening') && resolve());
    proc.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
});
after(() => {
  proc.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

test('private (Only me) cards: only the creator sees them, owner included', async () => {
  const A = (await api('POST', '/api/admin/users', { name: 'Ann' }, ADMIN)).json; // first user = owner
  const B = (await api('POST', '/api/admin/users', { name: 'Bob' }, ADMIN)).json;
  const board = (await api('POST', '/api/boards', { name: 'Team' }, A.token)).json.board;
  const bid = board.board.id;
  await api('POST', `/api/boards/${bid}/join`, null, B.token);
  const laneId = board.lanes.find((l) => l.title === 'To Do').id;
  const done = board.lanes.find((l) => l.title === 'Done').id;
  const ops = (o, tok) => api('POST', `/api/boards/${bid}/ops`, { ops: o }, tok);
  const snap = async (tok) => (await api('GET', `/api/boards/${bid}`, null, tok)).json.board;
  const ids = (s) => [...s.cards, ...s.archive].map((c) => c.id);
  const bobPrivate = `me:${B.id}`;

  // Bob makes a private card and tries to assign Ann: it stays his alone.
  let r = await ops([{ type: 'card.create', id: 'privbob001', laneId, content: 'Bob secret', projectId: bobPrivate, assignees: [A.id] }], B.token);
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  r = await ops([{ type: 'card.create', id: 'teamcard01', laneId, content: 'Team work' }], B.token);
  assert.equal(r.json.results[0].ok, true, JSON.stringify(r.json));

  let mine = await snap(B.token);
  const card = mine.cards.find((c) => c.id === 'privbob001');
  assert.equal(card.projectId, bobPrivate);
  assert.deepEqual(card.assignees, [B.id]);

  // The owner can't see it, touch it, comment on it, or make a private card for Bob.
  const owner = await snap(A.token);
  assert.ok(!ids(owner).includes('privbob001'));
  assert.ok(ids(owner).includes('teamcard01'));
  r = await ops([{ type: 'card.update', id: 'privbob001', content: 'hacked' }], A.token);
  assert.equal(r.json.results[0].ok, false);
  r = await api('GET', `/api/boards/${bid}/cards/privbob001/comments`, null, A.token);
  assert.equal(r.status, 404);
  r = await ops([{ type: 'card.create', id: 'privann001', laneId, content: 'x', projectId: bobPrivate }], A.token);
  assert.equal(r.json.results[0].ok, false);

  // Nobody can be added to a private card.
  r = await ops([{ type: 'card.assign', id: 'privbob001', userId: A.id }], B.token);
  assert.equal(r.json.results[0].ok, false);
  r = await ops([{ type: 'card.update', id: 'privbob001', assignees: [A.id, B.id] }], B.token);
  mine = await snap(B.token);
  assert.deepEqual(mine.cards.find((c) => c.id === 'privbob001').assignees, [B.id]);

  // Only the creator can make a team card private.
  r = await ops([{ type: 'card.update', id: 'teamcard01', projectId: `me:${A.id}` }], A.token);
  assert.equal(r.json.results[0].ok, false);

  // Progress, Trash and reports: Bob's own only.
  await ops([{ type: 'card.move', id: 'privbob001', laneId: done }], B.token);
  const progA = (await api('GET', `/api/boards/${bid}/progress`, null, A.token)).json;
  const progB = (await api('GET', `/api/boards/${bid}/progress`, null, B.token)).json;
  assert.ok(!progA.cards.some((c) => c.id === 'privbob001'));
  assert.ok(progB.cards.some((c) => c.id === 'privbob001'));
  const histA = (await api('GET', '/api/history', null, A.token)).json;
  assert.ok(!histA.cards.some((c) => c.id === 'privbob001'));
  assert.ok(!histA.events.some((e) => e.cardId === 'privbob001'));
  await ops([{ type: 'card.delete', id: 'privbob001' }], B.token);
  const trashA = (await api('GET', `/api/boards/${bid}/trash`, null, A.token)).json;
  const trashB = (await api('GET', `/api/boards/${bid}/trash`, null, B.token)).json;
  const tl = (t) => t.cards || t.trash || t;
  assert.ok(!JSON.stringify(trashA).includes('privbob001'));
  assert.ok(JSON.stringify(trashB).includes('privbob001'));

  // Making it a team card again shows it to the team.
  r = await ops([{ type: 'card.create', id: 'privbob002', laneId, content: 'Later shared', projectId: bobPrivate }], B.token);
  const general = (await snap(B.token)).cards.find((c) => c.id === 'teamcard01').projectId;
  r = await ops([{ type: 'card.update', id: 'privbob002', projectId: general }], B.token);
  assert.equal(r.json.results[0].ok, true, JSON.stringify(r.json));
  assert.ok(ids(await snap(A.token)).includes('privbob002'));
});
