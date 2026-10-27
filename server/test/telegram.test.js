import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { cardTitle, expandCardRefs, findMentions, notesToHtml, preview } from '../notify.js';

// ---------- a fake Telegram Bot API ----------

const sent = []; // { chat_id, text }
const updates = []; // queued for getUpdates
let updateId = 1;
const tg = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const method = req.url.split('/').pop();
    const json = body ? JSON.parse(body) : {};
    const reply = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    };
    if (method === 'getMe') return reply({ id: 1, is_bot: true, username: 'mad_kanban_test_bot' });
    if (method === 'deleteWebhook') return reply(true);
    if (method === 'sendMessage') {
      sent.push({ chat_id: String(json.chat_id), text: json.text });
      return reply({ message_id: sent.length });
    }
    if (method === 'getUpdates') {
      for (let i = 0; i < 20 && !updates.length; i++) await new Promise((r) => setTimeout(r, 25));
      const out = updates.splice(0).filter((u) => u.update_id >= (json.offset || 0));
      return reply(out);
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error_code: 404, description: 'no such method' }));
  });
});

const tgMessage = (chatId, text, firstName = 'Tester') =>
  updates.push({
    update_id: updateId++,
    message: { message_id: updateId, chat: { id: chatId, type: 'private' }, from: { first_name: firstName }, text },
  });

const waitFor = async (pred, what) => {
  for (let i = 0; i < 100; i++) {
    const hit = sent.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`timed out waiting for: ${what}\nsent so far:\n${sent.map((s) => `${s.chat_id}: ${s.text}`).join('\n')}`);
};

// ---------- the kanban server ----------

const PORT = 18990 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'test-admin';
let proc;
let dataDir;
let publicDir;
const publish = (version, notes) => {
  mkdirSync(path.join(publicDir, 'plugin'), { recursive: true });
  if (notes != null) writeFileSync(path.join(publicDir, 'plugin', 'whats-new.md'), `<!-- version: ${version} -->\n${notes}`);
  writeFileSync(path.join(publicDir, 'plugin', 'manifest.json'), JSON.stringify({ id: 'kanban-custom', version }));
};

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  await new Promise((r) => tg.listen(0, '127.0.0.1', r));
  dataDir = mkdtempSync(path.join(tmpdir(), 'kanban-tg-'));
  publicDir = mkdtempSync(path.join(tmpdir(), 'kanban-tg-public-'));
  publish('1.0.0', null);
  proc = spawn(process.execPath, ['index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      ADMIN_TOKEN: ADMIN,
      TELEGRAM_BOT_TOKEN: '123:test',
      TELEGRAM_API: `http://127.0.0.1:${tg.address().port}`,
      TELEGRAM_SEND_DELAY_MS: '60',
      PUBLIC_DIR: publicDir,
      RELEASE_CHECK_MS: '150',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      if (out.includes('listening') && out.includes('notifications on')) resolve();
    });
    proc.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
});

after(() => {
  proc.kill();
  tg.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(publicDir, { recursive: true, force: true });
});

// ---------- tests ----------

test('helpers: mentions, card titles, previews', () => {
  const users = [
    { id: 'a', name: 'Ann' },
    { id: 'b', name: 'Ann Lee' },
    { id: 'c', name: 'Бобур' },
  ];
  assert.deepEqual(findMentions('hi @Ann Lee and @ann!', users).sort(), ['a', 'b']);
  assert.deepEqual(findMentions('mail me at x@Ann.com', users), []);
  assert.deepEqual(findMentions('@Annie', users), []);
  assert.deepEqual(findMentions('@бобур, глянь', users), ['c']);
  assert.equal(cardTitle('Fix login [priority:: 1] @{2026-10-14} #web ^abc12\nbody'), 'Fix login');
  assert.equal(preview('see ![](x.png) and [docs](http://x)'), 'see [picture] and docs');
});

test('telegram: connect, the four notifications, /stop', async () => {
  const A = (await api('POST', '/api/admin/users', { name: 'Ann' }, ADMIN)).json; // owner
  const B = (await api('POST', '/api/admin/users', { name: 'Bob Stone' }, ADMIN)).json;
  const C = (await api('POST', '/api/admin/users', { name: 'Cid' }, ADMIN)).json;

  // Status and a link to the bot.
  let st = await api('GET', '/api/me/telegram', null, B.token);
  assert.deepEqual([st.json.available, st.json.bot, st.json.linked], [true, 'mad_kanban_test_bot', false]);
  const linkB = (await api('POST', '/api/me/telegram/link', null, B.token)).json.url;
  const linkC = (await api('POST', '/api/me/telegram/link', null, C.token)).json.url;
  assert.match(linkB, /^https:\/\/t\.me\/mad_kanban_test_bot\?start=[a-f0-9]{24}$/);

  // An unknown code is refused; the real ones connect.
  tgMessage(999, '/start deadbeefdeadbeefdeadbeef');
  await waitFor((m) => m.chat_id === '999' && /expired/.test(m.text), 'expired-code reply');
  tgMessage(201, `/start ${linkB.split('start=')[1]}`, 'Bob');
  tgMessage(301, `/start ${linkC.split('start=')[1]}`, 'Cid');
  await waitFor((m) => m.chat_id === '201' && /Connected as <b>Bob Stone<\/b>/.test(m.text), 'B connected');
  await waitFor((m) => m.chat_id === '301' && /Connected as <b>Cid<\/b>/.test(m.text), 'C connected');
  st = await api('GET', '/api/me/telegram', null, B.token);
  assert.equal(st.json.linked, true);
  assert.equal(st.json.telegramName, 'Bob');

  // A board with one card, assigned to Cid by Ann.
  const board = (await api('POST', '/api/boards', { name: 'Team' }, A.token)).json.board;
  for (const u of [B, C]) await api('POST', `/api/boards/${board.board.id}/join`, null, u.token);
  const todo = board.lanes.find((l) => l.title === 'To Do');
  const done = board.lanes.find((l) => l.title === 'Done');
  const bid = board.board.id;
  let r = await api('POST', `/api/boards/${bid}/ops`, {
    ops: [{ type: 'card.create', id: 'card000001', laneId: todo.id, content: 'Ship it [priority:: 1] #web' }],
  }, A.token);
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  sent.length = 0;

  // assigned
  await api('POST', `/api/boards/${bid}/ops`, { ops: [{ type: 'card.assign', id: 'card000001', userId: C.id }] }, A.token);
  const assigned = await waitFor((m) => m.chat_id === '301' && /assigned you/.test(m.text), 'C assigned');
  assert.match(assigned.text, /<b>Ann<\/b> assigned you to <b>Ship it<\/b>/);
  assert.match(assigned.text, /Team · To Do/);

  // mention (Bob) + comment on Cid's card
  sent.length = 0;
  r = await api('POST', `/api/boards/${bid}/cards/card000001/comments`, { body: 'hey @Bob Stone, look <here>' }, A.token);
  assert.equal(r.status, 200);
  const mention = await waitFor((m) => m.chat_id === '201', 'B mentioned');
  assert.match(mention.text, /mentioned you on <b>Ship it<\/b>/);
  assert.match(mention.text, /<blockquote>hey @Bob Stone, look &lt;here&gt;<\/blockquote>/);
  const comment = await waitFor((m) => m.chat_id === '301', 'C comment');
  assert.match(comment.text, /<b>Ann<\/b> commented on <b>Ship it<\/b>/);

  // Your own comment never notifies you; an edit that adds a mention does.
  sent.length = 0;
  const own = await api('POST', `/api/boards/${bid}/cards/card000001/comments`, { body: 'note to self' }, C.token);
  await new Promise((r2) => setTimeout(r2, 300));
  assert.equal(sent.filter((m) => m.chat_id === '301').length, 0);
  await api('PATCH', `/api/boards/${bid}/comments/${own.json.comment.id}`, { body: 'note to self, cc @bob stone' }, C.token);
  await waitFor((m) => m.chat_id === '201' && /<b>Cid<\/b> mentioned you/.test(m.text), 'B mentioned by edit');

  // moved: dragged through two lists quickly -> one message with where it ended up
  sent.length = 0;
  const inprog = board.lanes.find((l) => l.title === 'In Progress');
  await api('POST', `/api/boards/${bid}/ops`, { ops: [{ type: 'card.move', id: 'card000001', laneId: inprog.id }] }, A.token);
  await api('POST', `/api/boards/${bid}/ops`, { ops: [{ type: 'card.move', id: 'card000001', laneId: done.id }] }, A.token);
  await waitFor((m) => m.chat_id === '301' && /moved/.test(m.text), 'C moved');
  await new Promise((r2) => setTimeout(r2, 300));
  const moves = sent.filter((m) => m.chat_id === '301' && /moved/.test(m.text));
  assert.equal(moves.length, 1);
  assert.match(moves[0].text, /moved <b>Ship it<\/b> to <b>Done<\/b>/);

  // Parking a card in the Backlog sends nothing.
  sent.length = 0;
  const backlog = board.lanes.find((l) => l.title === 'Backlog');
  await api('POST', `/api/boards/${bid}/ops`, { ops: [{ type: 'card.move', id: 'card000001', laneId: backlog.id }] }, A.token);
  await new Promise((r2) => setTimeout(r2, 400));
  assert.equal(sent.filter((m) => m.chat_id === '301').length, 0);
  await api('POST', `/api/boards/${bid}/ops`, { ops: [{ type: 'card.move', id: 'card000001', laneId: done.id }] }, A.token);
  await waitFor((m) => m.chat_id === '301' && /to <b>Done<\/b>/.test(m.text), 'C moved out of Backlog');

  // People for the @ picker
  const people = await api('GET', `/api/boards/${bid}/cards/card000001/people`, null, B.token);
  assert.deepEqual(people.json.users.map((u) => u.name).sort(), ['Ann', 'Bob Stone', 'Cid']);

  // Replies tell the author of the comment being answered, once.
  const q = (await api('POST', `/api/boards/${bid}/cards/card000001/comments`, { body: 'is this done?' }, B.token)).json.comment;
  await new Promise((r2) => setTimeout(r2, 400));
  sent.length = 0;
  r = await api('POST', `/api/boards/${bid}/cards/card000001/comments`, { body: 'yes, shipped', replyTo: q.id }, A.token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const reply = await waitFor((m) => m.chat_id === '201', 'B reply');
  assert.match(reply.text, /↩️ <b>Ann<\/b> replied to your comment on <b>Ship it<\/b>/);
  assert.match(reply.text, /yes, shipped/);
  await waitFor((m) => m.chat_id === '301' && /commented on/.test(m.text), 'C (assignee) comment');
  sent.length = 0;
  await api('POST', `/api/boards/${bid}/cards/card000001/comments`, { body: '@Bob Stone see above', replyTo: q.id }, A.token);
  await waitFor((m) => m.chat_id === '201', 'B mention-reply');
  await new Promise((r2) => setTimeout(r2, 300));
  const toB = sent.filter((m) => m.chat_id === '201');
  assert.equal(toB.length, 1);
  assert.match(toB[0].text, /mentioned you/);
  // Replying to your own comment doesn't message you.
  sent.length = 0;
  await api('POST', `/api/boards/${bid}/cards/card000001/comments`, { body: 'also this', replyTo: q.id }, B.token);
  await new Promise((r2) => setTimeout(r2, 400));
  assert.equal(sent.filter((m) => m.chat_id === '201').length, 0);

  // @cardId in a comment reads as the card's title; private cards stay hidden from others.
  r = await api('POST', `/api/boards/${bid}/ops`, {
    ops: [
      { type: 'card.create', id: 'ref0000002', laneId: todo.id, content: 'Login API [priority:: 0]' },
      { type: 'card.create', id: 'sec0000003', laneId: todo.id, content: 'Secret plan', projectId: `me:${A.id}` },
    ],
  }, A.token);
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  await new Promise((r2) => setTimeout(r2, 300));
  sent.length = 0;
  await api('POST', `/api/boards/${bid}/cards/card000001/comments`, { body: '@Bob Stone waits on @ref0000002 and @sec0000003, not @zz99zz99zz' }, A.token);
  const refMsg = await waitFor((m) => m.chat_id === '201', 'B mention with card refs');
  assert.match(refMsg.text, /waits on «Login API» and @sec0000003, not @zz99zz99zz/);

  // The host sees who has Telegram connected.
  const dir = (await api('GET', '/api/team', null, A.token)).json;
  const tgOf = (name) => dir.users.find((u) => u.name === name).telegram;
  assert.equal(dir.telegramBot, 'mad_kanban_test_bot');
  assert.equal(tgOf('Ann').linked, false);
  assert.equal(tgOf('Bob Stone').linked, true);
  assert.equal(tgOf('Bob Stone').telegramName, 'Bob');
  assert.equal(tgOf('Cid').linked, true);

  // /stop turns it off
  tgMessage(301, '/stop');
  await waitFor((m) => m.chat_id === '301' && /off/.test(m.text), 'C stopped');
  st = await api('GET', '/api/me/telegram', null, C.token);
  assert.equal(st.json.linked, false);
  sent.length = 0;
  await api('POST', `/api/boards/${bid}/cards/card000001/comments`, { body: 'anyone?' }, A.token);
  await new Promise((r2) => setTimeout(r2, 300));
  assert.equal(sent.filter((m) => m.chat_id === '301').length, 0);

  // Disconnect from Obsidian
  r = await api('DELETE', '/api/me/telegram', null, B.token);
  assert.equal(r.json.linked, false);
});

test('telegram: "what\'s new" goes out once per release, /updates off opts out', async () => {
  assert.equal(
    notesToHtml('# Comments\n- **@mentions** with a picker\n- fixed `a<b`'),
    '<b>Comments</b>\n• <b>@mentions</b> with a picker\n• fixed <code>a&lt;b</code>'
  );
  const D = (await api('POST', '/api/admin/users', { name: 'Dee' }, ADMIN)).json;
  const E = (await api('POST', '/api/admin/users', { name: 'Eve' }, ADMIN)).json;
  for (const [u, chat] of [[D, 401], [E, 501]]) {
    const url = (await api('POST', '/api/me/telegram/link', null, u.token)).json.url;
    tgMessage(chat, `/start ${url.split('start=')[1]}`);
    await waitFor((m) => m.chat_id === String(chat) && /Connected/.test(m.text), `${u.name} connected`);
  }
  tgMessage(501, '/updates off');
  await waitFor((m) => m.chat_id === '501' && /No more release notes/.test(m.text), 'Eve opted out');

  sent.length = 0;
  publish('1.0.1', '- **@mentions** in comments\n- Telegram notifications');
  const note = await waitFor((m) => m.chat_id === '401' && /What's new/.test(m.text), 'release note');
  assert.match(note.text, /What's new in Mad Kanban 1\.0\.1/);
  assert.match(note.text, /• <b>@mentions<\/b> in comments\n• Telegram notifications/);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(sent.filter((m) => /What's new/.test(m.text)).length, 1); // once, and not to Eve

  // A release without notes says nothing; notes left over from another version aren't reused.
  sent.length = 0;
  publish('1.0.2', null);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sent.filter((m) => /What's new/.test(m.text)).length, 0);
});

test('expandCardRefs: @id -> «title», leaves people, emails and unknown ids', () => {
  const titles = { ab12cd: 'Fix login', ref0000002: 'Login API' };
  const t = (id) => titles[id] || null;
  assert.equal(expandCardRefs('see @ab12cd, then (@ref0000002)', t), 'see «Fix login», then («Login API»)');
  assert.equal(expandCardRefs('@Bekhzod and me@ab12cd.com', t), '@Bekhzod and me@ab12cd.com');
  assert.equal(expandCardRefs('@ab12cdx and @nope12', t), '@ab12cdx and @nope12');
});
