import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCard } from '../mcp.js';

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
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let rpcId = 1;
async function mcp(token, method, params) {
  const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: rpcId++, method, params }, token);
  return r;
}
async function call(token, name, args = {}) {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const res = r.json.result;
  return { text: res.content.map((c) => c.text).join('\n'), isError: !!res.isError };
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'kanban-mcp-'));
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

test('parseCard', () => {
  const p = parseCard('Fix login @{2026-11-01} [priority:: 1] ^abc\nBlocked by: @api0000002\n#web\n- [ ] one\n- [x] two');
  assert.equal(p.title, 'Fix login');
  assert.equal(p.due, '2026-11-01');
  assert.equal(p.priority, 1);
  assert.equal(p.blockedBy, '@api0000002');
  assert.deepEqual(p.items.map((i) => [i.done, i.text]), [[false, 'one'], [true, 'two']]);
  assert.deepEqual(p.tags, ['web']);
  assert.deepEqual(parseCard('Bug #1, see #vidora-app. and #3).').tags, ['vidora-app']);
});

test('MCP: AI keys, permissions and tools', async () => {
  const A = (await api('POST', '/api/admin/users', { name: 'Ann' }, ADMIN)).json; // owner
  const B = (await api('POST', '/api/admin/users', { name: 'Bob' }, ADMIN)).json;
  const C = (await api('POST', '/api/admin/users', { name: 'Cid' }, ADMIN)).json;

  // Projects: Web (Ann, Bob), Secret (Ann, Cid).
  await api('POST', '/api/team/projects', { name: 'Web' }, A.token);
  await api('POST', '/api/team/projects', { name: 'Secret' }, A.token);
  const team = (await api('GET', '/api/team', null, A.token)).json;
  const web = team.projects.find((p) => p.name === 'Web');
  const secret = team.projects.find((p) => p.name === 'Secret');
  await api('PUT', `/api/team/projects/${web.id}/members/${B.id}`, null, A.token);
  await api('PUT', `/api/team/projects/${secret.id}/members/${C.id}`, null, A.token);

  const board = (await api('POST', '/api/boards', { name: 'Team' }, A.token)).json.board;
  const bid = board.board.id;
  for (const u of [B, C]) await api('POST', `/api/boards/${bid}/join`, null, u.token);
  const todo = board.lanes.find((l) => l.title === 'To Do').id;
  let r = await api('POST', `/api/boards/${bid}/ops`, {
    ops: [
      { type: 'card.create', id: 'web0000001', laneId: todo, content: 'Login page @{2020-01-01} [priority:: 1]\n#web\n- [ ] form\n- [ ] errors', projectId: web.id, assignees: [B.id] },
      { type: 'card.create', id: 'sec0000001', laneId: todo, content: 'Secret plan', projectId: secret.id },
      { type: 'card.create', id: 'pri0000001', laneId: todo, content: 'Ann private', projectId: `me:${A.id}` },
    ],
  }, A.token);
  assert.equal(r.json.ok, true, JSON.stringify(r.json));

  // AI keys: made by the person; work only on /mcp.
  const bk = await api('POST', '/api/me/ai-keys', { name: 'Bob Claude' }, B.token);
  assert.equal(bk.status, 200);
  assert.equal(bk.json.device.kind, 'ai');
  assert.match(bk.json.mcpUrl, /\/mcp$/);
  const BAI = bk.json.token;
  const AAI = (await api('POST', '/api/me/ai-keys', {}, A.token)).json.token;
  assert.equal((await api('GET', `/api/boards/${bid}`, null, BAI)).status, 403, 'AI key on REST');
  assert.equal((await api('GET', '/api/team', null, AAI)).status, 403, "owner's AI key can't manage the team");
  assert.equal((await api('POST', '/api/me/ai-keys', {}, BAI)).status, 403, "AI can't make keys");
  assert.equal((await mcp(B.token, 'tools/list')).status, 403, 'device key on /mcp');
  assert.equal((await mcp(null, 'tools/list')).status, 401);
  const devs = (await api('GET', '/api/me/devices', null, B.token)).json.devices;
  assert.ok(devs.some((d) => d.kind === 'ai' && d.name === 'Bob Claude'));

  // Protocol basics
  const init = await mcp(BAI, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.json.result.protocolVersion, '2025-03-26');
  assert.match(init.json.result.instructions, /You act as Bob/);
  const note = await api('POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, BAI);
  assert.equal(note.status, 202);
  const list = await mcp(BAI, 'tools/list');
  const names = list.json.result.tools.map((t) => t.name);
  for (const n of ['overview', 'my_cards', 'find_cards', 'get_card', 'create_card', 'edit_card', 'tick_items', 'move_card', 'assign', 'comment', 'report']) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(!names.some((n) => /delete|project_|user/.test(n)), 'no admin tools');

  // Bob's AI sees Web only, not Secret and not Ann's private card.
  let t = await call(BAI, 'find_cards', {});
  assert.match(t.text, /\[web0000001\] Login page \| To Do \| Web \| P1 \| due 2020-01-01 OVERDUE \| Bob \| checklist 0\/2/);
  assert.doesNotMatch(t.text, /sec0000001|pri0000001/);
  t = await call(BAI, 'get_card', { id: 'sec0000001' });
  assert.equal(t.isError, true);
  t = await call(BAI, 'overview');
  assert.match(t.text, /You are Bob/);
  assert.doesNotMatch(t.text, /Secret/);
  t = await call(BAI, 'my_cards');
  assert.match(t.text, /web0000001/);

  // ...and can't write outside its projects or pull in people from other projects.
  t = await call(BAI, 'create_card', { title: 'Sneak', project: 'Secret' });
  assert.equal(t.isError, true);
  assert.match(t.text, /No project "Secret"/);
  t = await call(BAI, 'assign', { id: 'web0000001', add: ['Cid'] });
  assert.equal(t.isError, true);
  t = await call(BAI, 'edit_card', { id: 'sec0000001', title: 'hacked' });
  assert.equal(t.isError, true);
  t = await call(BAI, 'comment', { id: 'pri0000001', text: 'hi' });
  assert.equal(t.isError, true);

  // Owner's AI doesn't see other people's private cards either (Bob makes one).
  await api('POST', `/api/boards/${bid}/ops`, { ops: [{ type: 'card.create', id: 'bobpriv001', laneId: todo, content: 'Bob private', projectId: `me:${B.id}` }] }, B.token);
  t = await call(AAI, 'find_cards', {});
  assert.match(t.text, /sec0000001/);
  assert.match(t.text, /pri0000001/);
  assert.doesNotMatch(t.text, /bobpriv001/);

  // Writes: create (team style), tick, edit, move, assign, comment.
  t = await call(BAI, 'create_card', {
    title: 'Signup API',
    project: 'Web',
    list: 'Backlog',
    due: '2030-05-01',
    priority: 2,
    assignees: ['me', 'Ann'],
    tags: ['web'],
    description: 'Needs the login page first.',
    blocked_by: '@web0000001',
    checklist: ['endpoint', 'tests'],
  });
  assert.equal(t.isError, false, t.text);
  const newId = /\[([a-z0-9]{10})\]/.exec(t.text)[1];
  assert.match(t.text, /Signup API \| Backlog \| Web \| P2 \| due 2030-05-01 \| (Bob, Ann|Ann, Bob) \| checklist 0\/2 \| blocked/);
  let snap = (await api('GET', `/api/boards/${bid}`, null, B.token)).json.board;
  const made = snap.cards.find((c) => c.id === newId);
  assert.equal(made.content, 'Signup API @{2030-05-01} [priority:: 2]\nBlocked by: @web0000001\nNeeds the login page first.\n#web\n- [ ] endpoint\n- [ ] tests');

  t = await call(BAI, 'get_card', { id: 'web0000001' });
  assert.match(t.text, /Mentioned in:\n\[[a-z0-9]{10}\] Signup API \(Backlog\)/);
  t = await call(BAI, 'get_card', { id: newId });
  assert.match(t.text, /References:\n@web0000001 = Login page \(To Do\)/);

  t = await call(BAI, 'tick_items', { id: 'web0000001', items: ['1', 'errors'] });
  assert.match(t.text, /Checklist 2\/2/);
  t = await call(BAI, 'tick_items', { id: 'web0000001', items: ['form'], done: false });
  assert.match(t.text, /1\. \[ \] form/);

  t = await call(BAI, 'edit_card', { id: 'web0000001', title: 'Login page v2', due: '', priority: 0, append: 'Use the new design.', add_items: ['a11y'] });
  assert.equal(t.isError, false, t.text);
  snap = (await api('GET', `/api/boards/${bid}`, null, B.token)).json.board;
  assert.equal(
    snap.cards.find((c) => c.id === 'web0000001').content,
    'Login page v2 [priority:: 0]\n#web\nUse the new design.\n- [ ] form\n- [x] errors\n- [ ] a11y'
  );
  t = await call(BAI, 'edit_card', { id: newId, blocked_by: '' });
  assert.doesNotMatch(t.text, /blocked/);
  t = await call(BAI, 'edit_card', { id: newId, replace: { find: 'nope', with: 'x' } });
  assert.equal(t.isError, true);

  t = await call(BAI, 'move_card', { id: 'web0000001', list: 'in progress' });
  assert.match(t.text, /Login page v2 \| In Progress/);
  t = await call(BAI, 'assign', { id: 'web0000001', add: ['Ann'], remove: ['me'] });
  assert.match(t.text, /\| Ann \|/);

  t = await call(BAI, 'comment', { id: 'web0000001', text: '@Ann please review, see @' + newId });
  assert.match(t.text, /Comment added/);
  const comments = (await api('GET', `/api/boards/${bid}/cards/web0000001/comments`, null, A.token)).json.comments;
  assert.equal(comments.at(-1).via, 'ai');
  assert.equal(comments.at(-1).userName, 'Bob');
  t = await call(BAI, 'get_card', { id: 'web0000001' });
  assert.match(t.text, /Bob \(AI\) \[comment [a-z0-9]+\]: @Ann please review/);

  // History marks what the AI did.
  const hist = (await api('GET', `/api/history?boardId=${bid}`, null, A.token)).json;
  const aiEvents = hist.events.filter((e) => e.via === 'ai');
  assert.ok(aiEvents.some((e) => e.type === 'created' && e.cardId === newId));
  assert.ok(aiEvents.some((e) => e.type === 'moved'));
  assert.ok(aiEvents.some((e) => e.type === 'commented'));
  assert.ok(!hist.events.some((e) => e.cardId === 'web0000001' && e.type === 'created' && e.via), 'human events unmarked');

  // Report
  t = await call(BAI, 'report', {});
  assert.match(t.text, /^Report /);
  assert.match(t.text, /Comments by: Bob 1/);
  assert.doesNotMatch(t.text, /Secret plan/);

  // Removing the AI key cuts the AI off.
  const keyId = devs.find((d) => d.kind === 'ai').id;
  await api('DELETE', `/api/me/devices/${keyId}`, null, B.token);
  assert.equal((await mcp(BAI, 'tools/list')).status, 401);
});
