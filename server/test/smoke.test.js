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

  // shared board settings + tag color union
  const st = await api(
    'POST',
    `/api/boards/${boardId}/ops`,
    {
      ops: [
        { type: 'board.settings', set: { 'tag-colors': [{ tagKey: '#docs', color: '#fff', backgroundColor: '#000' }], 'date-format': 'DD.MM' } },
        { type: 'board.addTagColors', colors: [{ tagKey: '#docs', color: 'red', backgroundColor: 'red' }, { tagKey: '#ops', color: '#111', backgroundColor: '#eee' }] },
      ],
    },
    B
  );
  assert.equal(st.json.ok, true, JSON.stringify(st.json));
  snap = (await api('GET', `/api/boards/${boardId}`, null, A)).json.board;
  assert.deepEqual(snap.board.settings['tag-colors'].map((t) => [t.tagKey, t.color]), [['#docs', '#fff'], ['#ops', '#111']]);
  assert.equal(snap.board.settings['date-format'], 'DD.MM');
  await api('POST', `/api/boards/${boardId}/ops`, { ops: [{ type: 'board.settings', set: { 'date-format': null } }] }, A);
  snap = (await api('GET', `/api/boards/${boardId}`, null, A)).json.board;
  assert.equal(snap.board.settings['date-format'], undefined);

  // a new lane and a card in it, sent card-first, still works
  const lc = await api(
    'POST',
    `/api/boards/${boardId}/ops`,
    {
      ops: [
        { type: 'card.create', id: 'cardinnew1', laneId: 'lanenew002', index: 0, content: 'In new lane' },
        { type: 'lane.create', id: 'lanenew002', title: 'Fresh', index: 0 },
      ],
    },
    A
  );
  assert.equal(lc.json.ok, true, JSON.stringify(lc.json));

  // a whole-board re-upload (existing lists + cards under new ids) is refused
  const d = await api('POST', '/api/boards', { name: 'Defaults' }, A);
  const dId = d.json.board.board.id;
  const seed = await api('POST', `/api/boards/${dId}/ops`, {
    ops: ['one', 'two', 'three'].map((c, i) => ({ type: 'card.create', id: `seedcard0${i}`, laneTitle: 'To Do', index: i, content: c })),
  }, A);
  assert.equal(seed.json.ok, true, JSON.stringify(seed.json));
  const dup = await api('POST', `/api/boards/${dId}/ops`, {
    ops: [
      { type: 'lane.create', id: 'dupelane01', title: 'To Do', index: 3 },
      { type: 'lane.create', id: 'dupelane02', title: 'Done', index: 4 },
      ...['one', 'two', 'three'].map((c, i) => ({ type: 'card.create', id: `dupecard0${i}`, laneId: 'dupelane01', index: i, content: c })),
    ],
  }, A);
  assert.equal(dup.status, 409, JSON.stringify(dup.json));
  const after = (await api('GET', `/api/boards/${dId}`, null, A)).json.board;
  assert.equal(after.lanes.length, 3);
  assert.equal(after.cards.length, 3);
  // duplicating a single card is still fine
  const one = await api('POST', `/api/boards/${dId}/ops`, {
    ops: [{ type: 'card.create', id: 'dupecard09', laneTitle: 'To Do', index: 0, content: 'one' }],
  }, A);
  assert.equal(one.json.ok, true, JSON.stringify(one.json));

  // unread comments: B comments on a card, A sees it as unread until A reads it
  const ub = (await api('POST', '/api/boards', { name: 'Unread' }, A)).json.board;
  await api('POST', `/api/boards/${ub.board.id}/join`, null, B);
  const uc = await api('POST', `/api/boards/${ub.board.id}/ops`, { ops: [{ type: 'card.create', id: 'unreadcard1', laneTitle: 'To Do', index: 0, content: 'Talk' }] }, A);
  assert.equal(uc.json.ok, true, JSON.stringify(uc.json));
  await api('POST', `/api/boards/${ub.board.id}/cards/unreadcard1/comments`, { body: 'hi from B' }, B);
  await api('POST', `/api/boards/${ub.board.id}/cards/unreadcard1/comments`, { body: 'and again' }, B);
  const unreadOf = async (tok) => (await api('GET', `/api/boards/${ub.board.id}`, null, tok)).json.board.cards.find((c) => c.id === 'unreadcard1');
  assert.equal((await unreadOf(A)).unreadComments, 2);
  assert.equal((await unreadOf(B)).unreadComments, 0, 'own comments are never unread');
  const ucl = await api("GET", `/api/boards/${ub.board.id}/cards/unreadcard1/comments`, null, A);
  assert.equal(ucl.json.lastReadAt, 0);
  await api('POST', `/api/boards/${ub.board.id}/cards/unreadcard1/comments/read`, null, A);
  assert.equal((await unreadOf(A)).unreadComments, 0);
  assert.ok((await api('GET', `/api/boards/${ub.board.id}/cards/unreadcard1/comments`, null, A)).json.lastReadAt > 0);
  await api('POST', `/api/boards/${ub.board.id}/cards/unreadcard1/comments`, { body: 'third' }, B);
  assert.equal((await unreadOf(A)).unreadComments, 1);

  // plugin error reports
  const rep = await api('POST', '/api/client-logs', {
    meta: { pluginVersion: '9.9.9', platform: 'test' },
    entries: [{ ts: Date.now(), level: 'error', context: 'sync.flush', message: 'boom', stack: 'Error: boom\n at x', count: 3 }, { nope: 1 }],
  }, A);
  assert.equal(rep.json.stored, 1, JSON.stringify(rep.json));
  const logs = await api('GET', '/api/admin/client-logs?hours=1', null, ADMIN);
  assert.equal(logs.json.logs[0].message, 'boom');
  assert.equal(logs.json.logs[0].count, 3);
  assert.equal(logs.json.logs[0].meta.pluginVersion, '9.9.9');
  assert.equal((await api('GET', '/api/admin/client-logs', null, A)).status, 403);

  // default lanes
  assert.deepEqual(d.json.board.lanes.map((l) => l.title), ['To Do', 'In Progress', 'Done']);

  ws.close();
});
