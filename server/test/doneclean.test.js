import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { cleanDone } from '../progress.js';
import { takeDailyStats } from '../history.js';

const PORT = 19300 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'test-admin';
const DAY = 24 * 60 * 60 * 1000;
const dataDir = mkdtempSync(path.join(tmpdir(), 'kanban-doneclean-'));
let proc;

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

async function start() {
  proc = spawn(process.execPath, ['index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    // Cleaner off in the server: the test calls cleanDone itself.
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_TOKEN: ADMIN, TELEGRAM_BOT_TOKEN: '', DONE_CLEAN_DAYS: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => String(d).includes('listening') && resolve());
    proc.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
}
async function stop() {
  const p = proc;
  proc = null;
  await new Promise((r) => {
    p.on('exit', r);
    p.kill();
  });
}
after(async () => {
  if (proc) await stop();
  rmSync(dataDir, { recursive: true, force: true });
});

test('done cleaner: old Done cards go to the hidden archive, Archive list untouched, still counted', async () => {
  await start();
  const A = (await api('POST', '/api/admin/users', { name: 'Ann' }, ADMIN)).json;
  const board = (await api('POST', '/api/boards', { name: 'Team' }, A.token)).json.board;
  const bid = board.board.id;
  const lane = (t) => board.lanes.find((l) => l.title === t).id;
  const r = await api('POST', `/api/boards/${bid}/ops`, {
    ops: [
      { type: 'card.create', id: 'oldddone01', laneId: lane('Done'), content: 'Old done', assignees: [A.id] },
      { type: 'card.create', id: 'newwdone01', laneId: lane('Done'), content: 'Fresh done' },
      { type: 'card.create', id: 'oldarchiv1', laneId: lane('Archive'), content: 'Kept in Archive list' },
      { type: 'card.create', id: 'oldtodoo01', laneId: lane('To Do'), content: 'Old to do' },
    ],
  }, A.token);
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  await stop();

  const db = openDb(dataDir);
  const old = Date.now() - 8 * DAY;
  for (const id of ['oldddone01', 'oldarchiv1', 'oldtodoo01']) {
    db.prepare('UPDATE cards SET done_at = CASE WHEN done_at IS NULL THEN NULL ELSE ? END, last_moved = ?, updated_at = ? WHERE id = ?').run(old, old, old, id);
  }
  const changed = cleanDone(db);
  assert.deepEqual(changed.map((c) => [c.boardId, c.cardIds]), [[bid, ['oldddone01']]]);
  assert.deepEqual(changed[0].users, [A.id]);
  assert.deepEqual(cleanDone(db), [], 'second run does nothing');
  const row = (id) => db.prepare('SELECT archived, lane_id, done_at FROM cards WHERE id = ?').get(id);
  assert.equal(row('oldddone01').archived, 1);
  assert.equal(row('oldddone01').lane_id, lane('Done'));
  assert.equal(row('oldddone01').done_at, old);
  assert.equal(row('newwdone01').archived, 0);
  assert.equal(row('oldarchiv1').archived, 0);
  assert.equal(row('oldtodoo01').archived, 0);
  const ev = db.prepare("SELECT * FROM card_events WHERE card_id = 'oldddone01' AND type = 'archived'").get();
  assert.equal(ev.from_lane, 'Done');
  takeDailyStats(db);
  const stats = db.prepare("SELECT finished FROM daily_stats WHERE board_id = ? AND project_id = '' AND user_id = ''").get(bid);
  assert.equal(stats.finished, 3, 'old done + fresh done + archive list');
  db.close();

  await start();
  const snap = (await api('GET', `/api/boards/${bid}`, null, A.token)).json.board;
  assert.equal(snap.cards.some((c) => c.id === 'oldddone01'), false);
  assert.deepEqual(snap.archive.map((c) => c.id), ['oldddone01']);
  assert.ok(snap.cards.some((c) => c.id === 'oldarchiv1'));
  const prog = (await api('GET', `/api/boards/${bid}/progress`, null, A.token)).json;
  const p = prog.cards.find((c) => c.id === 'oldddone01');
  assert.equal(p.finished, true);
  assert.equal(p.doneAt, old);
  // Not on the personal board any more.
  const mine = (await api('GET', '/api/me/cards', null, A.token)).json.cards;
  assert.equal(mine.some((c) => c.id === 'oldddone01'), false);
  // Restoring it (card.move) brings it back to the board.
  const back = await api('POST', `/api/boards/${bid}/ops`, { ops: [{ type: 'card.move', id: 'oldddone01', laneId: lane('Done'), index: 0 }] }, A.token);
  assert.equal(back.json.ok, true);
  const snap2 = (await api('GET', `/api/boards/${bid}`, null, A.token)).json.board;
  assert.ok(snap2.cards.some((c) => c.id === 'oldddone01'));
  await stop();
  // ...and the cleaner leaves a restored card alone for another week.
  const db2 = openDb(dataDir);
  assert.deepEqual(cleanDone(db2), []);
  db2.close();
});
