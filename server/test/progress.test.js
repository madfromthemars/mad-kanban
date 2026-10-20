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
  dataDir = mkdtempSync(path.join(tmpdir(), 'kanban-progress-'));
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

test('finish dates, archive keeps counting, trash and restore', async () => {
  const A = (await api('POST', '/api/admin/users', { name: 'Ann' }, ADMIN)).json;
  const B = (await api('POST', '/api/admin/users', { name: 'Bob' }, ADMIN)).json;
  const board = (await api('POST', '/api/boards', { name: 'Team' }, A.token)).json.board;
  await api('POST', `/api/boards/${board.board.id}/join`, null, B.token);
  const bid = board.board.id;
  const lane = (t) => board.lanes.find((l) => l.title === t).id;
  const ops = (o, tok = A.token) => api('POST', `/api/boards/${bid}/ops`, { ops: o }, tok);
  const prog = async (tok = A.token) => (await api('GET', `/api/boards/${bid}/progress`, null, tok)).json;
  const card = (p, id) => p.cards.find((c) => c.id === id);

  let r = await ops([
    { type: 'card.create', id: 'cardaaaaa1', laneId: lane('To Do'), content: 'One @{2020-01-01}', assignees: [B.id] },
    { type: 'card.create', id: 'cardaaaaa2', laneId: lane('To Do'), content: 'Two' },
    { type: 'card.create', id: 'cardaaaaa3', laneId: lane('Done'), content: 'Three' },
  ]);
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  let p = await prog();
  assert.equal(card(p, 'cardaaaaa1').finished, false);
  assert.equal(card(p, 'cardaaaaa1').due, '2020-01-01');
  assert.equal(card(p, 'cardaaaaa3').finished, true);
  assert.ok(card(p, 'cardaaaaa3').doneAt > 0);
  assert.ok(p.trackingSince > 0);

  // Bob finishes card 1: done_at and done_by are his.
  await ops([{ type: 'card.move', id: 'cardaaaaa1', laneId: lane('Done') }], B.token);
  p = await prog();
  const done1 = card(p, 'cardaaaaa1');
  assert.equal(done1.finished, true);
  assert.equal(done1.doneBy, B.id);
  assert.equal(done1.doneEstimated, false);

  // Archive moves it to the Archive list, still finished, same finish time.
  r = await ops([{ type: 'card.archive', id: 'cardaaaaa1' }]);
  assert.equal(r.json.ok, true);
  const snap = (await api('GET', `/api/boards/${bid}`, null, A.token)).json.board;
  const c1 = snap.cards.find((c) => c.id === 'cardaaaaa1');
  assert.equal(c1.laneId, snap.lanes.find((l) => l.title === 'Archive').id);
  assert.equal(snap.archive.length, 0);
  p = await prog();
  assert.equal(card(p, 'cardaaaaa1').finished, true);
  assert.equal(card(p, 'cardaaaaa1').doneAt, done1.doneAt);

  // Back to In Progress: no longer finished.
  await ops([{ type: 'card.move', id: 'cardaaaaa1', laneId: lane('In Progress') }]);
  p = await prog();
  assert.equal(card(p, 'cardaaaaa1').finished, false);
  assert.equal(card(p, 'cardaaaaa1').doneAt, null);

  // Delete -> Trash (comments kept) -> restore into its old list.
  await api('POST', `/api/boards/${bid}/cards/cardaaaaa2/comments`, { body: 'keep me' }, A.token);
  await ops([{ type: 'card.move', id: 'cardaaaaa2', laneId: lane('In Progress') }]);
  r = await ops([{ type: 'card.delete', id: 'cardaaaaa2' }], B.token);
  assert.equal(r.json.ok, true);
  p = await prog();
  assert.equal(card(p, 'cardaaaaa2'), undefined);
  assert.equal(p.trashCount, 1);
  const trash = (await api('GET', `/api/boards/${bid}/trash`, null, A.token)).json;
  assert.equal(trash.days, 30);
  assert.equal(trash.cards[0].title, 'Two');
  assert.equal(trash.cards[0].lane, 'In Progress');
  assert.equal(trash.cards[0].deletedByName, 'Bob');
  assert.equal(trash.cards[0].commentCount, 1);
  r = await api('POST', `/api/boards/${bid}/trash/cardaaaaa2/restore`, null, A.token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const snap2 = (await api('GET', `/api/boards/${bid}`, null, A.token)).json.board;
  const back = snap2.cards.find((c) => c.id === 'cardaaaaa2');
  assert.equal(back.laneId, lane('In Progress'));
  assert.equal(back.position, 0);
  const cm = (await api('GET', `/api/boards/${bid}/cards/cardaaaaa2/comments`, null, A.token)).json.comments;
  assert.equal(cm.length, 1);
  assert.equal((await api('GET', `/api/boards/${bid}/trash`, null, A.token)).json.cards.length, 0);
  r = await api('POST', `/api/boards/${bid}/trash/cardaaaaa2/restore`, null, A.token);
  assert.equal(r.status, 404);
});
