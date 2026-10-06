import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const PORT = 18790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'test-admin';
let proc;
let dataDir;

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'kanban-test-'));
  proc = spawn(process.execPath, ['index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_TOKEN: ADMIN },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => {
      if (String(d).includes('listening')) resolve();
    });
    proc.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
});

after(() => {
  proc.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

test('full flow: users, boards, ops, mirror, websocket', async () => {
  const health = await api('GET', '/api/health');
  assert.equal(health.json.ok, true);

  // admin creates two users
  const a = await api('POST', '/api/admin/users', { name: 'Alice' }, ADMIN);
  const b = await api('POST', '/api/admin/users', { name: 'Bob' }, ADMIN);
  assert.equal(a.status, 200);
  assert.match(a.json.join, /\/#[0-9a-f]{48}$/);
  const A = a.json.token;
  const B = b.json.token;

  assert.equal((await api('GET', '/api/me')).status, 401);
  assert.equal((await api('GET', '/api/me', null, A)).json.user.name, 'Alice');

  // websocket for Bob
  const WebSocket = globalThis.WebSocket;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${B}`);
  const events = [];
  await new Promise((res) => (ws.onopen = res));
  ws.onmessage = (m) => events.push(JSON.parse(m.data));

  // Alice creates a board
  const created = await api('POST', '/api/boards', { name: 'Sprint', lanes: ['To Do', 'Doing', 'Done'] }, A);
  assert.equal(created.status, 200);
  const boardId = created.json.board.board.id;
  const lanes = created.json.board.lanes;
  assert.equal(lanes.length, 3);

  // Bob can't read before joining
  assert.equal((await api('GET', `/api/boards/${boardId}`, null, B)).status, 403);
  assert.equal((await api('POST', `/api/boards/${boardId}/join`, null, B)).status, 200);
  const list = await api('GET', '/api/boards', null, B);
  assert.equal(list.json.boards[0].joined, true);

  // Alice creates cards and assigns one to Bob
  const bobId = b.json.id;
  const ops1 = await api(
    'POST',
    `/api/boards/${boardId}/ops`,
    {
      clientId: 'alice-1',
      ops: [
        { type: 'card.create', id: 'card000001', laneId: lanes[0].id, index: 0, content: 'Write spec #docs' },
        { type: 'card.create', id: 'card000002', laneId: lanes[0].id, index: 1, content: 'Build it', assignees: [bobId] },
        { type: 'card.create', id: 'card000003', laneId: lanes[0].id, index: 0, content: 'First!' },
      ],
    },
    A
  );
  assert.equal(ops1.json.ok, true, JSON.stringify(ops1.json));
  let snap = (await api('GET', `/api/boards/${boardId}`, null, A)).json.board;
  assert.deepEqual(
    snap.cards.map((c) => c.id),
    ['card000003', 'card000001', 'card000002']
  );

  // Bob sees his card in "my cards" with board + lane names
  const mine = (await api('GET', '/api/me/cards', null, B)).json.cards;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].boardName, 'Sprint');
  assert.equal(mine[0].laneTitle, 'To Do');

  // Bob moves it by lane title (from his personal board) and marks checked
  const mv = await api(
    'POST',
    `/api/boards/${boardId}/ops`,
    { ops: [{ type: 'card.move', id: 'card000002', laneTitle: 'doing', index: -1 }] },
    B
  );
  assert.equal(mv.json.ok, true);
  // canonical list matching: emoji + Russian name -> "Doing"
  const canon = await api(
    'POST',
    `/api/boards/${boardId}/ops`,
    { ops: [{ type: 'card.move', id: 'card000002', laneTitle: '🔨 В работе', index: -1 }] },
    B
  );
  assert.equal(canon.json.ok, true, JSON.stringify(canon.json));
  const bad = await api(
    'POST',
    `/api/boards/${boardId}/ops`,
    { ops: [{ type: 'card.move', id: 'card000002', laneTitle: 'Nope' }] },
    B
  );
  assert.equal(bad.json.ok, false);
  assert.match(bad.json.results[0].error, /no list named/);

  // explicit move into Done, then reorder To Do; setCards must not pull cards from other lanes
  const re = await api(
    'POST',
    `/api/boards/${boardId}/ops`,
    {
      ops: [
        { type: 'card.move', id: 'card000003', laneId: lanes[2].id, index: 0 },
        { type: 'lane.setCards', laneId: lanes[0].id, cardIds: ['card000001', 'card000003', 'card000002'] },
      ],
    },
    A
  );
  assert.equal(re.json.ok, true);
  snap = (await api('GET', `/api/boards/${boardId}`, null, A)).json.board;
  const byId = Object.fromEntries(snap.cards.map((c) => [c.id, c]));
  assert.equal(byId.card000003.laneId, lanes[2].id);
  assert.equal(byId.card000002.laneId, lanes[1].id);
  assert.equal(byId.card000001.laneId, lanes[0].id);

  // reorder within a lane
  await api(
    'POST',
    `/api/boards/${boardId}/ops`,
    { ops: [{ type: 'card.create', id: 'card000004', laneId: lanes[0].id, index: -1, content: 'Last' }] },
    A
  );
  const ro = await api(
    'POST',
    `/api/boards/${boardId}/ops`,
    { ops: [{ type: 'lane.setCards', laneId: lanes[0].id, cardIds: ['card000004', 'card000001'] }] },
    A
  );
  assert.equal(ro.json.ok, true);
  snap = (await api('GET', `/api/boards/${boardId}`, null, A)).json.board;
  assert.deepEqual(
    snap.cards.filter((c) => c.laneId === lanes[0].id).map((c) => c.id),
    ['card000004', 'card000001']
  );

  // version conflict
  const v = byId.card000001.version;
  const ok = await api(
    'POST',
    `/api/boards/${boardId}/ops`,
    { ops: [{ type: 'card.update', id: 'card000001', version: v, content: 'Write spec v2' }] },
    A
  );
  assert.equal(ok.json.ok, true);
  const stale = await api(
    'POST',
    `/api/boards/${boardId}/ops`,
    { ops: [{ type: 'card.update', id: 'card000001', version: v, content: 'stale' }] },
    B
  );
  assert.equal(stale.json.ok, false);
  assert.equal(stale.json.conflicts.length, 1);
  assert.equal(stale.json.conflicts[0].card.content, 'Write spec v2');

  // archive + lane rename + lane delete
  const misc = await api(
    'POST',
    `/api/boards/${boardId}/ops`,
    {
      ops: [
        { type: 'card.archive', id: 'card000003' },
        { type: 'lane.update', id: lanes[1].id, title: 'In Progress' },
        { type: 'lane.create', id: 'lanenew001', title: 'Later', index: 1 },
        { type: 'lane.setOrder', laneIds: [lanes[2].id, lanes[0].id] },
      ],
    },
    A
  );
  assert.equal(misc.json.ok, true);
  snap = (await api('GET', `/api/boards/${boardId}`, null, A)).json.board;
  assert.equal(snap.archive.length, 1);
  assert.deepEqual(
    snap.lanes.map((l) => l.title),
    ['Done', 'To Do', 'Later', 'In Progress']
  );

  // websocket events reached Bob, with affected users
  await new Promise((r) => setTimeout(r, 100));
  const changed = events.filter((e) => e.type === 'board.changed');
  assert.ok(changed.length >= 4);
  assert.ok(changed.some((e) => e.users.includes(bobId)));
  assert.equal(changed[0].origin, 'alice-1');
  // comments
  const cm = await api('POST', `/api/boards/${boardId}/cards/card000001/comments`, { body: 'Looks good' }, B);
  assert.equal(cm.status, 200);
  assert.equal(cm.json.comment.userName, 'Bob');
  const cl = await api('GET', `/api/boards/${boardId}/cards/card000001/comments`, null, A);
  assert.equal(cl.json.comments.length, 1);
  assert.equal((await api('DELETE', `/api/boards/${boardId}/comments/${cm.json.comment.id}`, null, A)).status, 403);
  snap = (await api('GET', `/api/boards/${boardId}`, null, A)).json.board;
  assert.equal(snap.cards.find((c) => c.id === 'card000001').commentCount, 1);
  assert.equal((await api('DELETE', `/api/boards/${boardId}/comments/${cm.json.comment.id}`, null, B)).status, 200);

  // uploads + range
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const up = await fetch(`${BASE}/api/boards/${boardId}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${A}`, 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('my shot.png') },
    body: png,
  });
  const upj = await up.json();
  assert.equal(up.status, 200, JSON.stringify(upj));
  const fileUrl = upj.url.replace(/^https?:\/\/[^/]+/, BASE);
  const got = await fetch(fileUrl);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);
  const part = await fetch(fileUrl, { headers: { Range: 'bytes=2-5' } });
  assert.equal(part.status, 206);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), png.subarray(2, 6));
  const badUp = await fetch(`${BASE}/api/boards/${boardId}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${A}`, 'Content-Type': 'text/html' },
    body: '<b>x</b>',
  });
  assert.equal(badUp.status, 415);

  // default lanes
  const d = await api('POST', '/api/boards', { name: 'Defaults' }, A);
  assert.deepEqual(d.json.board.lanes.map((l) => l.title), ['To Do', 'In Progress', 'Done']);

  ws.close();
});
