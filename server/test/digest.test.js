// Owner digest (digest.js + the daily tick in notify.js).
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDigest, localDay } from '../digest.js';

const DAY = 864e5;
// Wed 2026-11-11 10:00 in Tashkent (UTC+5)
const NOW = Date.UTC(2026, 10, 11, 5, 0, 0);

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT DEFAULT 'user', disabled INTEGER DEFAULT 0);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, color TEXT);
    CREATE TABLE project_members (project_id TEXT, user_id TEXT);
    CREATE TABLE lanes (id TEXT PRIMARY KEY, board_id TEXT, title TEXT, mark_complete INTEGER DEFAULT 0);
    CREATE TABLE cards (id TEXT PRIMARY KEY, board_id TEXT, lane_id TEXT, content TEXT, assignees TEXT DEFAULT '[]', archived INTEGER DEFAULT 0,
      project_id TEXT, last_moved INTEGER, created_at INTEGER, done_at INTEGER, done_by TEXT, done_estimated INTEGER DEFAULT 0);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE telegram_links (user_id TEXT PRIMARY KEY, chat_id TEXT, tg_name TEXT DEFAULT '', linked_at INTEGER, updates INTEGER DEFAULT 1);
  `);
  const u = db.prepare('INSERT INTO users (id, name, role, disabled) VALUES (?, ?, ?, ?)');
  u.run('own', 'Abdulaziz', 'owner', 0);
  u.run('bek', 'Bekhzod', 'user', 0);
  u.run('mak', 'Makhmudjon', 'user', 0);
  u.run('bob', 'Bobur', 'user', 0);
  u.run('old', 'Gone', 'user', 1);
  u.run('ai', 'madsistant', 'user', 0);
  db.prepare("INSERT INTO projects VALUES ('cat', 'catalog', '#f00'), ('om', 'onemenu', '#0f0')").run();
  for (const [p, us] of [['cat', ['own', 'bek', 'mak', 'bob', 'ai']], ['om', ['own', 'bek']]]) for (const x of us) db.prepare('INSERT INTO project_members VALUES (?, ?)').run(p, x);
  db.prepare("INSERT INTO lanes VALUES ('b','x','Backlog',0),('t','x','To Do',0),('p','x','In Progress',0),('d','x','Done',0),('a','x','Archive',0)").run();
  let n = 0;
  const card = (lane, { who = [], project = 'cat', content = 'Card', moved = NOW, created = NOW - 30 * DAY, doneAt = null, doneBy = null, est = 0, archived = 0 } = {}) =>
    db
      .prepare('INSERT INTO cards (id, board_id, lane_id, content, assignees, archived, project_id, last_moved, created_at, done_at, done_by, done_estimated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(`c${++n}`, 'x', lane, content, JSON.stringify(who), archived, project, moved, created, doneAt, doneBy, est);
  // Bekhzod: 4 in progress (a lot), one of them stuck 6 days; one overdue to do in onemenu
  for (let i = 0; i < 3; i++) card('p', { who: ['bek'] });
  card('p', { who: ['bek'], moved: NOW - 6 * DAY });
  card('t', { who: ['bek'], project: 'om', content: 'Pay hosting @{2026-11-05}' });
  // Makhmudjon: 1 to do; finished 2 yesterday, 1 today (not "yesterday"), 1 estimated (ignored)
  card('t', { who: ['mak'] });
  card('d', { who: ['mak'], doneAt: NOW - 20 * 3600e3 });
  card('a', { who: ['mak'], doneAt: NOW - 15 * 3600e3 });
  card('d', { who: ['mak'], doneAt: NOW - 3600e3 });
  card('d', { who: ['mak'], doneAt: NOW - 20 * 3600e3, est: 1 });
  // Unassigned overdue in catalog; due in the future (not overdue); backlog overdue (ignored)
  card('t', { content: 'Fix menu @{2026-11-01}' });
  card('t', { who: ['own'], content: 'Later @{2026-12-01}' });
  card('b', { who: ['bob'], content: 'Idea @{2026-10-01}' });
  // Disabled person's card counts as unassigned; private "only me" cards are invisible
  card('t', { who: ['old'] });
  card('p', { who: ['own'], project: 'me:own', moved: NOW - 30 * DAY, content: 'Secret plan @{2026-10-01}' });
  return db;
}

test('digest: done yesterday, workload, overdue, stuck, unassigned — counts only', () => {
  const db = makeDb();
  const text = buildDigest(db, { now: NOW, offsetH: 5 });
  console.log(text);
  assert.match(text, /📊 <b>Mad Kanban<\/b> · Wed 11 Nov/);
  assert.match(text, /Done yesterday \(2\)<\/b>\n• Makhmudjon 2/);
  assert.match(text, /• Bekhzod — 4 \/ 1 ⚠️ a lot/);
  assert.match(text, /• Makhmudjon — 0 \/ 1\n/);
  assert.match(text, /• Abdulaziz — 0 \/ 1/);
  assert.match(text, /💤 Nothing open: Bobur/, 'Bobur only has backlog');
  assert.doesNotMatch(text, /madsistant|Gone/);
  assert.match(text, /⏰ <b>Overdue<\/b>\n• Bekhzod 1 <i>onemenu 1<\/i>\n• No one 1 <i>catalog 1<\/i>/);
  assert.match(text, /not moved for 5\+ days<\/b>\n• Bekhzod 1 <i>catalog 1<\/i>/);
  assert.match(text, /Nobody assigned \(2\)<\/b>\n• catalog 2/);
  assert.doesNotMatch(text, /Pay hosting|Fix menu|Secret|Idea|Last week/, 'no card titles, no private cards, not Monday');
});

test('digest: Mondays add last week; empty boards send nothing', () => {
  const db = makeDb();
  const monday = NOW + 5 * DAY;
  const text = buildDigest(db, { now: monday, offsetH: 5 });
  assert.match(text, /📅 <b>Last week<\/b>: 3 done · 0 new\n• catalog 3/);
  assert.equal(buildDigest(new DatabaseSync(':memory:').exec('') ?? makeEmpty(), { now: NOW }), null);
});

function makeEmpty() {
  const db = makeDb();
  db.exec('DELETE FROM cards');
  return db;
}

test('localDay: Tashkent calendar', () => {
  const d = localDay(Date.UTC(2026, 10, 15, 19, 30), 5); // Sun 15 Nov 19:30 UTC = Mon 00:30 local
  assert.equal(d.ymd, '2026-11-16');
  assert.equal(d.weekday, 1);
  assert.equal(d.hour, 0);
});

test('digest tick: owner only, once a day, Mon–Sat 9–12 local', async () => {
  const sent = [];
  const api = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const m = req.url.split('/').pop();
      const b = body ? JSON.parse(body) : {};
      if (m === 'sendMessage') sent.push(b);
      res.setHeader('Content-Type', 'application/json');
      if (m === 'getMe') return res.end(JSON.stringify({ ok: true, result: { username: 'test_bot' } }));
      if (m === 'getUpdates') return setTimeout(() => res.end(JSON.stringify({ ok: true, result: [] })), 200);
      res.end(JSON.stringify({ ok: true, result: true }));
    });
  });
  await new Promise((r) => api.listen(0, r));
  process.env.TELEGRAM_API = `http://127.0.0.1:${api.address().port}`;
  process.env.TELEGRAM_BOT_TOKEN = '1:fake';
  process.env.DIGEST_CHECK_MS = '3600000';
  const { createNotifier } = await import('../notify.js');
  const db = makeDb();
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_link_codes (code_hash TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER)`);
  db.prepare("INSERT INTO telegram_links (user_id, chat_id, linked_at) VALUES ('own', '111', 0), ('bek', '222', 0)").run();
  const n = createNotifier(db, { log: { log() {}, warn() {} } });
  await n.start();
  for (let i = 0; i < 50 && !n.status('own')?.bot; i++) await new Promise((r) => setTimeout(r, 20));
  const at = (h, dayOffset = 0) => Date.UTC(2026, 10, 11 + dayOffset, h - 5, 5); // local hour h
  assert.equal(await n.digestTick(at(8)), 0, 'before 9');
  assert.equal(await n.digestTick(at(9)), 1, 'at 9');
  assert.equal(await n.digestTick(at(10)), 0, 'not twice a day');
  assert.equal(await n.digestTick(at(13, 1)), 0, 'not after 12');
  assert.equal(await n.digestTick(at(9, 4)), 0, 'Sunday 15 Nov: off');
  assert.equal(await n.digestTick(at(9, 5)), 1, 'Monday');
  assert.equal(sent.length, 2);
  assert.ok(sent.every((m) => m.chat_id === '111'), 'only the owner');
  assert.match(sent[1].text, /Last week/);
  n.stop();
  api.close();
});
