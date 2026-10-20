import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const PORT = 19300 + Math.floor(Math.random() * 100);
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
  dataDir = mkdtempSync(path.join(tmpdir(), 'kanban-history-'));
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

test('history keeps edits, comments and deleted cards; hosts only', async () => {
  const A = (await api('POST', '/api/admin/users', { name: 'Ann' }, ADMIN)).json; // first user = owner
  const B = (await api('POST', '/api/admin/users', { name: 'Bob' }, ADMIN)).json;
  const board = (await api('POST', '/api/boards', { name: 'Team' }, A.token)).json.board;
  const bid = board.board.id;
  await api('POST', `/api/boards/${bid}/join`, null, B.token);
  const lane = (t) => board.lanes.find((l) => l.title === t).id;
  const ops = async (o, tok = A.token) => {
    const r = await api('POST', `/api/boards/${bid}/ops`, { ops: o }, tok);
    assert.equal(r.json.ok, true, JSON.stringify(r.json));
    return r.json;
  };
  const getCard = async (id) => (await api('GET', `/api/boards/${bid}`, null, A.token)).json.board.cards.find((c) => c.id === id);

  await ops([{ type: 'card.create', id: 'hist000001', laneId: lane('To Do'), content: 'Login page @{2020-01-01}\n- [ ] form\n- [ ] api' }]);
  let c = await getCard('hist000001');
  await ops([
    {
      type: 'card.update',
      id: c.id,
      version: c.version,
      content: 'Login screen @{2020-01-05} [priority:: 1]\n- [x] form\n- [ ] api',
      assignees: [B.id],
    },
  ]);
  await ops([{ type: 'card.move', id: c.id, laneId: lane('In Progress'), index: 0 }], B.token);
  await api('POST', `/api/boards/${bid}/cards/${c.id}/comments`, { body: 'form done, api tomorrow' }, B.token);
  await ops([{ type: 'card.move', id: c.id, laneId: lane('Done'), index: 0 }], B.token);
  await ops([{ type: 'card.create', id: 'hist000002', laneId: lane('To Do'), content: 'Throwaway' }]);
  await ops([{ type: 'card.delete', id: 'hist000002' }]);

  // Hosts only.
  assert.equal((await api('GET', '/api/history', null, B.token)).status, 403);

  const h = (await api('GET', '/api/history', null, A.token)).json;
  const types = h.events.filter((e) => e.cardId === 'hist000001').map((e) => e.type);
  for (const t of ['created', 'assigned', 'due', 'priority', 'renamed', 'checklist', 'moved', 'commented']) {
    assert.ok(types.includes(t), `missing ${t} in ${types}`);
  }
  const due = h.events.find((e) => e.type === 'due');
  assert.deepEqual(due.detail, { from: '2020-01-01', to: '2020-01-05' });
  const assigned = h.events.find((e) => e.type === 'assigned');
  assert.deepEqual(assigned.detail.added, [B.id]);
  const check = h.events.find((e) => e.type === 'checklist');
  assert.deepEqual(check.detail, { from: 0, done: 1, total: 2 });
  const done = h.events.filter((e) => e.type === 'moved' && e.toLane === 'Done');
  assert.equal(done.length, 1);
  assert.equal(done[0].by, B.id);
  assert.equal(done[0].title, 'Login screen');
  assert.deepEqual(done[0].assignees, [B.id]);

  // A deleted card still reads right in the history.
  const del = h.events.find((e) => e.type === 'deleted');
  assert.equal(del.title, 'Throwaway');
  assert.ok(del.projectId);

  assert.equal(h.comments.length, 1);
  assert.equal(h.comments[0].by, B.id);
  const card = h.cards.find((x) => x.id === 'hist000001');
  assert.equal(card.status, 'finished');
  assert.ok(card.doneAt);
  assert.deepEqual(card.checklist, { done: 1, total: 2 });

  // Daily numbers were taken at startup (empty board then); filter by a date range works.
  const today = h.events[0].day;
  const h2 = (await api('GET', `/api/history?from=${today}&to=${today}`, null, A.token)).json;
  assert.equal(h2.events.length, h.events.length);
  const old = (await api('GET', '/api/history?from=2001-01-01&to=2001-01-31', null, A.token)).json;
  assert.equal(old.events.length, 0);
  assert.equal((await api('GET', '/api/history?from=2001-01-01&to=2026-12-31', null, A.token)).status, 400);
});
