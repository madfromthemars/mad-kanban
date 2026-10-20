// Telegram notifications for Mad Kanban.
//
// The bot lives inside this server: it long-polls Telegram for /start and /stop, and sends
// people a message when they're @mentioned, someone comments on their card, they're
// assigned, or a card of theirs changes list. Obsidian can't push notifications to phones
// (plugins only run while the app is open), so Telegram does that part.
//
// Off unless TELEGRAM_BOT_TOKEN is set. TELEGRAM_API overrides the API base (tests).

import { createHash, randomBytes } from 'node:crypto';
import dns from 'node:dns';

// The Docker network has no working IPv6; trying Telegram's IPv6 address first makes
// some requests time out. IPv4 first.
dns.setDefaultResultOrder('ipv4first');

const API = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '');
const LINK_TTL_MS = 15 * 60 * 1000;
const SEND_DELAY_MS = Number(process.env.TELEGRAM_SEND_DELAY_MS || 4000);

const hash = (s) => createHash('sha256').update(s).digest('hex');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "Fix login [priority:: 1] @{2026-10-14} ^abc #web" -> "Fix login" */
export function cardTitle(content) {
  const first = String(content || '').split(/\r?\n/)[0];
  const t = first
    .replace(/\[[^\]]*::[^\]]*\]/g, '')
    .replace(/@\{[^}]*\}/g, '')
    .replace(/@@\{[^}]*\}/g, '')
    .replace(/\s\^[a-z0-9-]+\s*$/i, '')
    .replace(/(^|\s)#[^\s#]+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return t || 'Untitled card';
}

/** Shorten a comment for a preview: markdown links/images to their text, one paragraph. */
export function preview(body, max = 280) {
  let t = String(body || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[picture]')
    .replace(/!\[\[[^\]]*\]\]/g, '[picture]')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) t = `${t.slice(0, max - 1).trimEnd()}…`;
  return t;
}

/**
 * People @mentioned in a comment. Names may contain spaces, so match known names
 * (longest first), case-insensitively, at a word start and followed by a non-letter.
 */
export function findMentions(text, users) {
  const found = new Set();
  const src = String(text || '');
  const lower = src.toLowerCase();
  const sorted = [...users].filter((u) => u?.name).sort((a, b) => b.name.length - a.name.length);
  for (let i = lower.indexOf('@'); i !== -1; i = lower.indexOf('@', i + 1)) {
    if (i > 0 && /[\p{L}\p{N}_.]/u.test(src[i - 1])) continue; // e.g. an email address
    for (const u of sorted) {
      const name = u.name.toLowerCase();
      if (lower.startsWith(name, i + 1)) {
        const after = src[i + 1 + name.length];
        if (after === undefined || !/[\p{L}\p{N}_]/u.test(after)) {
          found.add(u.id);
          break;
        }
      }
    }
  }
  return [...found];
}

/** Release notes markdown (short bullets) -> Telegram HTML. */
export function notesToHtml(md) {
  return String(md || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/^#+\s*(.*)$/, '**$1**').replace(/^\s*[-*]\s+/, '• '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .map((part) =>
      part.startsWith('**') && part.endsWith('**') && part.length > 4
        ? `<b>${esc(part.slice(2, -2))}</b>`
        : part.startsWith('`') && part.endsWith('`') && part.length > 2
          ? `<code>${esc(part.slice(1, -1))}</code>`
          : esc(part)
    )
    .join('');
}

export function createNotifier(db, { log = console } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_links (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,
      tg_name TEXT NOT NULL DEFAULT '',
      linked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telegram_link_codes (
      code_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
  `);

  // Release announcements ("What's new in 2.1.44") can be turned off per person: /updates off
  if (!db.prepare('PRAGMA table_info(telegram_links)').all().some((c) => c.name === 'updates')) {
    db.exec('ALTER TABLE telegram_links ADD COLUMN updates INTEGER NOT NULL DEFAULT 1');
  }

  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  let botUsername = null;
  let stopped = false;
  let offset = 0;
  /** userId -> { timer, items: Map<key, text> } */
  const pending = new Map();

  async function call(method, body) {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 40000 : 15000),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      const err = new Error(`telegram ${method}: ${json.description || res.status}`);
      err.code = json.error_code || res.status;
      throw err;
    }
    return json.result;
  }

  // Network hiccups get two more tries; Telegram's own refusals (blocked bot etc.) don't.
  async function send(chatId, text) {
    for (let i = 0; ; i++) {
      try {
        return await call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
      } catch (e) {
        if (e.code || i >= 2) throw e;
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      }
    }
  }

  // ---------- linking ----------

  function linkUrl(userId) {
    if (!botUsername) return null;
    const now = Date.now();
    db.prepare('DELETE FROM telegram_link_codes WHERE expires_at < ? OR user_id = ?').run(now, userId);
    const code = randomBytes(12).toString('hex');
    db.prepare('INSERT INTO telegram_link_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
      hash(code),
      userId,
      now + LINK_TTL_MS
    );
    return `https://t.me/${botUsername}?start=${code}`;
  }

  function status(userId) {
    const link = db.prepare('SELECT tg_name, linked_at FROM telegram_links WHERE user_id = ?').get(userId);
    return {
      available: !!botUsername,
      bot: botUsername,
      linked: !!link,
      telegramName: link?.tg_name || null,
      linkedAt: link?.linked_at || null,
    };
  }

  function unlink(userId) {
    const row = db.prepare('SELECT chat_id FROM telegram_links WHERE user_id = ?').get(userId);
    db.prepare('DELETE FROM telegram_links WHERE user_id = ?').run(userId);
    if (row && botUsername) {
      send(row.chat_id, 'Mad Kanban notifications are off for this chat.').catch(() => {});
    }
    return !!row;
  }

  async function onMessage(msg) {
    const chatId = String(msg.chat?.id ?? '');
    const text = String(msg.text || '').trim();
    if (!chatId || msg.chat?.type !== 'private') return;
    const tgName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || '';
    const m = /^\/start(?:@\w+)?(?:\s+([a-f0-9]{8,64}))?$/i.exec(text);
    if (m && m[1]) {
      const row = db
        .prepare(
          `SELECT c.user_id, u.name FROM telegram_link_codes c JOIN users u ON u.id = c.user_id
           WHERE c.code_hash = ? AND c.expires_at > ? AND u.disabled = 0`
        )
        .get(hash(m[1].toLowerCase()), Date.now());
      if (!row) {
        await send(chatId, 'This link has expired. In Obsidian open <b>Settings → Mad Kanban → Telegram</b> and tap <b>Connect</b> again.');
        return;
      }
      db.prepare('DELETE FROM telegram_link_codes WHERE user_id = ?').run(row.user_id);
      // One chat per person; a chat belongs to one person.
      db.prepare('DELETE FROM telegram_links WHERE chat_id = ? AND user_id != ?').run(chatId, row.user_id);
      db.prepare(
        `INSERT INTO telegram_links (user_id, chat_id, tg_name, linked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, tg_name = excluded.tg_name, linked_at = excluded.linked_at`
      ).run(row.user_id, chatId, tgName, Date.now());
      log.log(`${new Date().toISOString()} telegram: ${row.name} connected`);
      await send(
        chatId,
        `✅ Connected as <b>${esc(row.name)}</b>.\n\nYou'll get a message when someone @mentions you, comments on your cards, assigns you, or moves one of your cards, and a short note when Mad Kanban gets something new.\n\n/updates off: no release notes\n/stop: turn everything off`
      );
      return;
    }
    const upd = /^\/updates(?:@\w+)?(?:\s+(on|off))?$/i.exec(text);
    if (upd) {
      const row = db.prepare('SELECT user_id, updates FROM telegram_links WHERE chat_id = ?').get(chatId);
      if (!row) {
        await send(chatId, 'This chat isn\'t connected. Connect it from Obsidian first.');
        return;
      }
      const on = upd[1] ? upd[1].toLowerCase() === 'on' : !row.updates;
      db.prepare('UPDATE telegram_links SET updates = ? WHERE chat_id = ?').run(on ? 1 : 0, chatId);
      await send(
        chatId,
        on
          ? '📣 You\'ll get a short note when Mad Kanban gets something new. /updates off to stop.'
          : 'No more release notes. Task notifications stay on. /updates on to get them back.'
      );
      return;
    }
    if (/^\/stop\b/i.test(text)) {
      const row = db.prepare('SELECT user_id FROM telegram_links WHERE chat_id = ?').get(chatId);
      db.prepare('DELETE FROM telegram_links WHERE chat_id = ?').run(chatId);
      await send(chatId, row ? 'Notifications are off. Connect again from Obsidian any time.' : 'This chat isn\'t connected.');
      return;
    }
    const linked = db.prepare('SELECT 1 FROM telegram_links WHERE chat_id = ?').get(chatId);
    await send(
      chatId,
      linked
        ? 'This chat gets your Mad Kanban notifications. Send /stop to turn them off.'
        : 'To get Mad Kanban notifications here, open Obsidian → <b>Settings → Mad Kanban → Telegram</b> and tap <b>Connect</b>.'
    );
  }

  async function poll() {
    while (!stopped) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          if (u.message) await onMessage(u.message).catch((e) => log.warn(`telegram: ${e.message}`));
        }
      } catch (e) {
        if (stopped) return;
        if (e.code === 401 || e.code === 404) {
          log.warn('telegram: the bot token was rejected; notifications are off');
          botUsername = null;
          return;
        }
        if (e.code === 409) log.warn('telegram: another process is reading this bot\'s updates');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async function start() {
    if (!token) {
      log.log('telegram: TELEGRAM_BOT_TOKEN not set; notifications are off');
      return;
    }
    // Keep trying: a network hiccup at startup must not leave notifications off for good.
    for (let attempt = 0, wait = 10000; !stopped; attempt++, wait = Math.min(wait * 2, 5 * 60 * 1000)) {
      try {
        const me = await call('getMe');
        botUsername = me.username;
        await call('deleteWebhook', {}).catch(() => {});
        log.log(`telegram: notifications on via @${botUsername}`);
        void poll();
        return;
      } catch (e) {
        if (e.code === 401 || e.code === 404) {
          log.warn(`telegram: the bot token was refused (${e.message}); notifications are off`);
          return;
        }
        log.warn(`telegram: cannot reach Telegram (${e.message}); retrying in ${Math.round(wait / 1000)} s`);
        await new Promise((r) => setTimeout(r, wait).unref?.());
      }
    }
  }

  function stop() {
    stopped = true;
    for (const p of pending.values()) clearTimeout(p.timer);
  }

  // ---------- sending ----------

  /**
   * Queue a message for a person. Messages wait a few seconds so a burst (a card dragged
   * through two lists, several quick comments) goes out once, latest version per key.
   */
  function queue(userId, key, text) {
    if (!botUsername) return;
    const link = db.prepare('SELECT chat_id FROM telegram_links WHERE user_id = ?').get(userId);
    if (!link) return;
    let p = pending.get(userId);
    if (!p) {
      p = { items: new Map(), timer: null };
      pending.set(userId, p);
    }
    p.items.set(key, text);
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      pending.delete(userId);
      const chat = db.prepare('SELECT chat_id FROM telegram_links WHERE user_id = ?').get(userId);
      if (!chat) return;
      for (const t of p.items.values()) {
        send(chat.chat_id, t).catch((e) => {
          log.warn(`telegram: send failed (${e.message})`);
          // The person blocked the bot: forget the chat.
          if (e.code === 403) db.prepare('DELETE FROM telegram_links WHERE user_id = ?').run(userId);
        });
      }
    }, SEND_DELAY_MS);
    p.timer.unref?.();
  }

  function cardInfo(boardId, cardId) {
    return db
      .prepare(
        `SELECT c.id, c.content, c.assignees, c.project_id, c.archived, l.title AS lane, b.name AS board
         FROM cards c JOIN boards b ON b.id = c.board_id LEFT JOIN lanes l ON l.id = c.lane_id
         WHERE c.id = ? AND c.board_id = ?`
      )
      .get(cardId, boardId);
  }

  function canSee(userId, card) {
    const u = db.prepare('SELECT id, role, disabled FROM users WHERE id = ?').get(userId);
    if (!u || u.disabled) return false;
    if (u.role === 'owner') return true;
    return !!db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(card.project_id, userId);
  }

  const where = (card) => `<i>${esc(card.board)}${card.lane ? ` · ${esc(card.lane)}` : ''}</i>`;
  const assigneesOf = (card) => {
    try {
      return JSON.parse(card.assignees || '[]');
    } catch {
      return [];
    }
  };

  /** Mentionable people for a card: everyone who can see it. */
  function peopleForCard(boardId, cardId) {
    const card = cardInfo(boardId, cardId);
    if (!card) return [];
    return db
      .prepare('SELECT id, name, role FROM users WHERE disabled = 0')
      .all()
      .filter((u) => canSee(u.id, card));
  }

  /** A new comment, or new @mentions added by an edit (`previousBody`). */
  /** Who has Telegram connected, for the host's People list: userId -> info. */
  function overview() {
    const out = {};
    for (const r of db.prepare('SELECT user_id, tg_name, linked_at, updates FROM telegram_links').all()) {
      out[r.user_id] = { telegramName: r.tg_name || null, linkedAt: r.linked_at, updates: !!r.updates };
    }
    return { available: !!botUsername, bot: botUsername, linked: out };
  }

  function onComment({ actor, boardId, cardId, body, previousBody = null, replyToUserId = null }) {
    const card = cardInfo(boardId, cardId);
    if (!card) return;
    const people = peopleForCard(boardId, cardId);
    const mentioned = findMentions(body, people);
    const before = previousBody != null ? new Set(findMentions(previousBody, people)) : new Set();
    const title = esc(cardTitle(card.content));
    const quote = `\n\n<blockquote>${esc(preview(body))}</blockquote>`;
    for (const id of mentioned) {
      if (id === actor.id || before.has(id) || !canSee(id, card)) continue;
      queue(id, `mention:${cardId}:${body.length}:${Date.now()}`, `💬 <b>${esc(actor.name)}</b> mentioned you on <b>${title}</b>\n${where(card)}${quote}`);
    }
    if (previousBody != null) return; // edits only notify new mentions
    // A reply tells the author of the comment it answers (once, even if also assigned).
    const replied =
      replyToUserId && replyToUserId !== actor.id && !mentioned.includes(replyToUserId) && canSee(replyToUserId, card)
        ? replyToUserId
        : null;
    if (replied) {
      queue(replied, `reply:${cardId}:${Date.now()}`, `↩️ <b>${esc(actor.name)}</b> replied to your comment on <b>${title}</b>\n${where(card)}${quote}`);
    }
    for (const id of assigneesOf(card)) {
      if (id === replied) continue;
      if (id === actor.id || mentioned.includes(id) || !canSee(id, card)) continue;
      queue(id, `comment:${cardId}:${Date.now()}`, `💬 <b>${esc(actor.name)}</b> commented on <b>${title}</b>\n${where(card)}${quote}`);
    }
  }

  /** Events from applyOps (ops.js): assigned / moved. */
  function onOps({ actor, boardId, events }) {
    for (const ev of events || []) {
      const card = cardInfo(boardId, ev.cardId);
      if (!card) continue;
      const title = esc(cardTitle(card.content));
      if (ev.type === 'assigned') {
        if (ev.userId === actor.id || !canSee(ev.userId, card)) continue;
        queue(ev.userId, `assigned:${ev.cardId}`, `👤 <b>${esc(actor.name)}</b> assigned you to <b>${title}</b>\n${where(card)}`);
      } else if (ev.type === 'moved') {
        if (card.archived) continue;
        for (const id of assigneesOf(card)) {
          if (id === actor.id || !canSee(id, card)) continue;
          // Keyed by card: dragging through several lists sends only where it ended up.
          queue(id, `moved:${ev.cardId}`, `➡️ <b>${esc(actor.name)}</b> moved <b>${title}</b> to <b>${esc(card.lane || '?')}</b>\n<i>${esc(card.board)}</i>`);
        }
      }
    }
  }

  /**
   * "What's new" for a released plugin version, to everyone connected who hasn't turned
   * release notes off. Sent once per version (remembered in the meta table).
   */
  async function announce(version, notesMd) {
    if (!botUsername) return 0; // no bot (yet): try again on the next start
    const key = `announced:${version}`;
    if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(key)) return 0;
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, String(Date.now()));
    if (!String(notesMd || '').trim()) return 0;
    const text = `📣 <b>What's new in Mad Kanban ${esc(version)}</b>\n\n${notesToHtml(notesMd)}\n\n<i>Obsidian updates itself. To get it now: Settings → Mad Kanban → Check now.</i>`;
    const chats = db
      .prepare(
        `SELECT t.chat_id FROM telegram_links t JOIN users u ON u.id = t.user_id
         WHERE t.updates = 1 AND u.disabled = 0`
      )
      .all();
    let n = 0;
    for (const { chat_id } of chats) {
      try {
        await send(chat_id, text);
        n++;
      } catch (e) {
        log.warn(`telegram: release note not sent (${e.message})`);
      }
      await new Promise((r) => setTimeout(r, 60)); // stay far below Telegram's rate limit
    }
    log.log(`${new Date().toISOString()} telegram: announced ${version} to ${n} people`);
    return n;
  }

  return { start, stop, status, overview, linkUrl, unlink, onComment, onOps, peopleForCard, announce };
}
