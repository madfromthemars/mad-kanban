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
  dataDir = mkdtempSync(path.join(tmpdir(), 'kanban-creator-'));
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

test('cards carry their creator name, also for people outside your projects', async () => {
  const A = (await api('POST', '/api/admin/users', { name: 'Cara' }, ADMIN)).json;
  const B = (await api('POST', '/api/admin/users', { name: 'Dan' }, ADMIN)).json;
  const board = (await api('POST', '/api/boards', { name: 'Creators' }, A.token)).json.board;
  const bid = board.board.id;
  await api('POST', `/api/boards/${bid}/join`, null, B.token);
  const laneId = board.lanes.find((l) => l.title === 'To Do').id;
  let r = await api('POST', `/api/boards/${bid}/ops`, { ops: [{ type: 'card.create', id: 'cardcreat1', laneId, content: 'By Dan', assignees: [A.id] }] }, B.token);
  assert.equal(r.json.ok, true, JSON.stringify(r.json));

  const snap = (await api('GET', `/api/boards/${bid}`, null, A.token)).json.board;
  const card = snap.cards.find((c) => c.id === 'cardcreat1');
  assert.equal(card.createdBy, B.id);
  assert.equal(card.createdByName, 'Dan');

  // "My cards" (personal-board mirrors) carry it too.
  const mine = (await api('GET', '/api/me/cards', null, A.token)).json.cards;
  assert.equal(mine.find((c) => c.id === 'cardcreat1').createdByName, 'Dan');
});
