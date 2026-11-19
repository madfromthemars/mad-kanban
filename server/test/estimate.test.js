// Time estimate vs real time: work clock (In Progress / Review), digest, MCP shapes.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { estimateOf, fmtDuration, migrateWork, parseDuration } from '../progress.js';
import { buildDigest } from '../digest.js';

const PORT = 19400 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'test-admin';
const H = 3600e3;
const dataDir = mkdtempSync(path.join(tmpdir(), 'kanban-estimate-'));
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

test('duration format', () => {
  assert.equal(parseDuration('2h'), 2 * H);
  assert.equal(parseDuration('1d 4h'), 28 * H);
  assert.equal(parseDuration('90m'), 1.5 * H);
  assert.equal(parseDuration('1,5h'), 1.5 * H);
  assert.equal(parseDuration('1w'), 7 * 24 * H);
  assert.equal(parseDuration('soon'), null);
  assert.equal(parseDuration('0h'), null);
  assert.equal(estimateOf('Fix [estimate:: 3h] @{2026-01-01}'), 3 * H);
  assert.equal(estimateOf('Fix'), null);
  assert.equal(fmtDuration(45 * 60e3), '45m');
  assert.equal(fmtDuration(3 * H + 20 * 60e3), '3h 20m');
  assert.equal(fmtDuration(52 * H), '2d 4h');
});

test('work clock runs only in In Progress / Review; digest counts cards over estimate', async () => {
  await start();
  const A = (await api('POST', '/api/admin/users', { name: 'Ann' }, ADMIN)).json;
  const board = (await api('POST', '/api/boards', { name: 'Team' }, A.token)).json.board;
  const bid = board.board.id;
  const lane = (t) => board.lanes.find((l) => l.title === t).id;
  const ops = (o) => api('POST', `/api/boards/${bid}/ops`, { ops: o }, A.token);
  const get = async (id) => (await api('GET', `/api/boards/${bid}`, null, A.token)).json.board.cards.find((c) => c.id === id);
  let r = await ops([
    { type: 'card.create', id: 'estcard001', laneId: lane('To Do'), content: 'Build it [estimate:: 1h]', assignees: [A.id] },
    { type: 'card.create', id: 'estcard002', laneId: lane('In Progress'), content: 'Started right away [estimate:: 5h]', assignees: [A.id] },
  ]);
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  let c = await get('estcard001');
  assert.equal(c.workMs, 0);
  assert.equal(c.workSince, null);
  assert.ok((await get('estcard002')).workSince > 0, 'created in In Progress starts the clock');
  await ops([{ type: 'card.move', id: 'estcard001', laneId: lane('In Progress'), index: 0 }]);
  c = await get('estcard001');
  assert.ok(c.workSince > 0);
  await stop();

  // Pretend it started 2 hours ago: over its 1h estimate.
  let db = openDb(dataDir);
  db.prepare("UPDATE cards SET work_since = ? WHERE id = 'estcard001'").run(Date.now() - 2 * H);
  const text = buildDigest(db, { now: Date.now() });
  assert.match(text, /Over estimate/);
  assert.match(text, /• Ann 1/);
  db.close();

  await start();
  // Back to To Do pauses the clock (about 2h banked), Review runs it again, Done stops it.
  await ops([{ type: 'card.move', id: 'estcard001', laneId: lane('To Do'), index: 0 }]);
  c = await get('estcard001');
  assert.equal(c.workSince, null);
  assert.ok(c.workMs >= 2 * H - 5000 && c.workMs < 2 * H + 60000, String(c.workMs));
  await ops([{ type: 'lane.create', id: 'reviewlane', title: 'Review', index: 2 }]);
  await ops([{ type: 'card.move', id: 'estcard001', laneId: 'reviewlane', index: 0 }]);
  assert.ok((await get('estcard001')).workSince > 0, 'Review counts as work');
  await ops([{ type: 'card.move', id: 'estcard001', laneId: lane('Done'), index: 0 }]);
  c = await get('estcard001');
  assert.equal(c.workSince, null);
  const banked = c.workMs;
  await stop();

  // Backfill from the history log gives the same answer.
  db = openDb(dataDir);
  db.prepare("UPDATE cards SET work_ms = 0, work_since = NULL").run();
  db.prepare("DELETE FROM meta WHERE key = 'work-time'").run();
  // The 2h stretch was faked in the db, not in the log: shift the log the same way.
  const mv = db.prepare("SELECT id FROM card_events WHERE card_id = 'estcard001' AND type = 'moved' ORDER BY id").all();
  db.prepare('UPDATE card_events SET ts = ts - ? WHERE id = ?').run(2 * H, mv[0].id);
  migrateWork(db);
  const row = db.prepare("SELECT work_ms, work_since FROM cards WHERE id = 'estcard001'").get();
  assert.equal(row.work_since, null);
  assert.ok(Math.abs(row.work_ms - banked) < 60000, `${row.work_ms} vs ${banked}`);
  assert.ok(db.prepare("SELECT work_since FROM cards WHERE id = 'estcard002'").get().work_since > 0);
  db.close();
});
