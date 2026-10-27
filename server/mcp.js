// MCP (Model Context Protocol) endpoint: lets AI assistants (Claude, Cursor, Hermes…) work
// with the team board through a person's *AI key*.
//
// Transport: Streamable HTTP, stateless, JSON responses (POST /mcp with JSON-RPC 2.0).
// Auth: `Authorization: Bearer <AI key>` (POST /api/me/ai-keys, or Obsidian → Mad Kanban →
// Devices → Create AI key). The AI acts as that person and sees exactly what they see
// (their projects, their own private cards). It can read, create, edit, tick, move, assign
// and comment; it can't delete cards or manage people/projects/boards/keys.
//
// Tool output is short plain text on purpose (cheap for the model to read): one line per
// card, details only from get_card.

import {
  canSeeProject,
  getBoardMeta,
  getBoardSnapshot,
  getUser,
  isPrivateProject,
  listBoards,
  listComments,
  listProjects,
  privateProjectId,
  userByToken,
  visibleUsers,
} from './db.js';
import { dayOf, teamHistory } from './history.js';
import { laneKey } from './lanes.js';
import { cardTitle } from './notify.js';
import { OpError } from './ops.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'mad-kanban', title: 'Mad Kanban', version: '1.0.0' };
const MAX_BODY = 2 * 1024 * 1024;

// ---------- card text helpers ----------

const DUE_RE = /@\{(\d{4}-\d{2}-\d{2})\}/;
const PRIO_RE = /\[priority::\s*(\d+)\s*\]/;
const TASK_RE = /^(\s*)[-*+] \[(.)\] (.*)$/;
const REF_RE = /(^|[\s([{"'«>*_~])@([a-z0-9]{6,12})(?![\p{L}\p{N}_])/gu;

export function parseCard(content) {
  const lines = String(content || '').split(/\r?\n/);
  const first = lines[0] || '';
  const items = [];
  lines.forEach((l, i) => {
    const m = TASK_RE.exec(l);
    if (m && i > 0) items.push({ line: i, done: m[2] !== ' ', text: m[3].trim() });
  });
  // Tags start with a letter ("issue #1" isn't a tag); trailing punctuation dropped.
  const tags = [...String(content || '').matchAll(/(?:^|\s)#(\p{L}[\p{L}\p{N}_/-]*)/gu)].map((m) => m[1]);
  const blocked = lines.find((l) => /^\s*blocked by:/i.test(l));
  return {
    title: cardTitle(content),
    due: DUE_RE.exec(first)?.[1] || null,
    priority: PRIO_RE.exec(first) ? Number(PRIO_RE.exec(first)[1]) : null,
    items,
    tags: [...new Set(tags)],
    blockedBy: blocked ? blocked.replace(/^\s*blocked by:\s*/i, '').trim() : null,
    lines,
  };
}

function refsIn(content) {
  return [...new Set([...String(content || '').matchAll(REF_RE)].map((m) => m[2]))];
}

const isDoneLane = (title) => ['done', 'archive'].includes(laneKey(title || ''));

// ---------- the endpoint ----------

/**
 * `deps.runOps(user, board, ops)` and `deps.postComment(user, board, cardId, text, replyTo)`
 * are the same functions the REST API uses (permissions, history, Telegram, live updates).
 */
export function createMcp(deps) {
  const { db, runOps, postComment } = deps;

  // ----- context for one call -----

  function boardsOf(user) {
    return listBoards(db, user).filter((b) => b.joined);
  }

  function pickBoard(user, arg) {
    const boards = boardsOf(user);
    if (!boards.length) throw new ToolError('You have not joined any board yet. Join one in Obsidian first.');
    if (arg) {
      const a = String(arg).trim().toLowerCase();
      const b = boards.find((x) => x.id === arg || x.name.toLowerCase() === a);
      if (!b) throw new ToolError(`No joined board "${arg}". Boards: ${boards.map((x) => x.name).join(', ')}`);
      return getBoardMeta(db, b.id);
    }
    return getBoardMeta(db, boards[0].id);
  }

  function snapshot(user, board) {
    const snap = getBoardSnapshot(db, board.id, user);
    const lanes = new Map(snap.lanes.map((l) => [l.id, l]));
    const people = new Map(visibleUsers(db, user).map((u) => [u.id, u]));
    const projects = new Map(listProjects(db, user).map((p) => [p.id, p]));
    projects.set(privateProjectId(user.id), { id: privateProjectId(user.id), name: 'Only me (private)', memberIds: [user.id] });
    const cards = [...snap.cards, ...snap.archive];
    return { snap, lanes, people, projects, cards, byId: new Map(cards.map((c) => [c.id, c])) };
  }

  const laneTitle = (ctx, c) => (c.archived ? 'Archive' : ctx.lanes.get(c.laneId)?.title || '?');
  const projectName = (ctx, c) => ctx.projects.get(c.projectId)?.name || '—';
  const personName = (ctx, id) => ctx.people.get(id)?.name || getUser(db, id)?.name || 'someone';

  function findLane(ctx, title) {
    const t = String(title || '').trim().toLowerCase();
    const lanes = ctx.snap.lanes;
    const l = lanes.find((x) => x.title.trim().toLowerCase() === t) || lanes.find((x) => laneKey(x.title) === laneKey(title));
    if (!l) throw new ToolError(`No list "${title}". Lists: ${lanes.map((x) => x.title).join(', ')}`);
    return l;
  }

  function findPerson(ctx, user, name) {
    const n = String(name || '').trim().replace(/^@/, '').toLowerCase();
    if (!n) throw new ToolError('empty person name');
    if (n === 'me' || n === 'myself') return getUser(db, user.id);
    const all = [...ctx.people.values()];
    const exact = all.filter((u) => u.name.toLowerCase() === n);
    if (exact.length === 1) return exact[0];
    const starts = all.filter((u) => u.name.toLowerCase().startsWith(n));
    if (starts.length === 1) return starts[0];
    if (starts.length > 1) throw new ToolError(`"${name}" matches ${starts.map((u) => u.name).join(', ')}; be more specific`);
    throw new ToolError(`No teammate "${name}" you can work with. People: ${all.map((u) => u.name).join(', ')}`);
  }

  function findProject(ctx, user, name) {
    const n = String(name || '').trim().replace(/^#/, '').toLowerCase();
    if (['private', 'only me', 'me', 'personal'].includes(n)) return privateProjectId(user.id);
    for (const p of ctx.projects.values()) if (p.id === name || p.name.toLowerCase() === n) return p.id;
    const starts = [...ctx.projects.values()].filter((p) => p.name.toLowerCase().startsWith(n));
    if (starts.length === 1) return starts[0].id;
    throw new ToolError(`No project "${name}" you are in. Projects: ${[...ctx.projects.values()].map((p) => p.name).join(', ')}`);
  }

  function getCardOr404(ctx, id) {
    const c = ctx.byId.get(String(id || '').trim().replace(/^@/, ''));
    if (!c) throw new ToolError(`Card ${id} not found (deleted, or not in a project you're in).`);
    return c;
  }

  // ----- formatting -----

  function cardLine(ctx, c) {
    const p = parseCard(c.content);
    const today = dayOf(Date.now());
    const lane = laneTitle(ctx, c);
    const parts = [`[${c.id}] ${p.title}`, lane, projectName(ctx, c)];
    if (p.priority != null) parts.push(`P${p.priority}`);
    if (p.due) parts.push(`due ${p.due}${p.due < today && !isDoneLane(lane) ? ' OVERDUE' : ''}`);
    if (c.assignees.length) parts.push(c.assignees.map((a) => personName(ctx, a)).join(', '));
    if (p.items.length) parts.push(`checklist ${p.items.filter((i) => i.done).length}/${p.items.length}`);
    if (c.commentCount) parts.push(`${c.commentCount} comment${c.commentCount === 1 ? '' : 's'}`);
    if (p.blockedBy) parts.push('blocked');
    return parts.join(' | ');
  }

  function cardDetail(ctx, c, { comments = 'last' } = {}) {
    const p = parseCard(c.content);
    const lane = laneTitle(ctx, c);
    const out = [`[${c.id}] ${p.title}`];
    const meta = [`List: ${lane}`, `Project: ${projectName(ctx, c)}`];
    if (p.priority != null) meta.push(`Priority: P${p.priority} (0 = most urgent)`);
    if (p.due) meta.push(`Due: ${p.due}`);
    meta.push(`Assigned: ${c.assignees.length ? c.assignees.map((a) => personName(ctx, a)).join(', ') : 'nobody'}`);
    meta.push(`Created by ${c.createdByName || personName(ctx, c.createdBy)} on ${dayOf(c.createdAt)}`);
    meta.push(`version ${c.version}`);
    out.push(meta.join(' | '));
    out.push('', 'Content:', c.content);
    if (p.items.length) {
      out.push('', `Checklist ${p.items.filter((i) => i.done).length}/${p.items.length}:`);
      p.items.forEach((it, i) => out.push(`${i + 1}. [${it.done ? 'x' : ' '}] ${it.text}`));
    }
    const refs = refsIn(c.content).filter((id) => id !== c.id);
    if (refs.length) {
      out.push('', 'References:');
      for (const id of refs) {
        const r = ctx.byId.get(id);
        out.push(r ? `@${id} = ${parseCard(r.content).title} (${laneTitle(ctx, r)})` : `@${id} = (not found or not visible)`);
      }
    }
    const back = ctx.cards.filter((x) => x.id !== c.id && refsIn(x.content).includes(c.id));
    if (back.length) {
      out.push('', 'Mentioned in:');
      for (const b of back) out.push(`[${b.id}] ${parseCard(b.content).title} (${laneTitle(ctx, b)})`);
    }
    const list = listComments(db, c.boardId, c.id);
    if (list.length) {
      const shown = comments === 'all' ? list : list.slice(-10);
      out.push('', `Comments (${list.length}${shown.length < list.length ? `, last ${shown.length}` : ''}):`);
      for (const m of shown) {
        const body = m.body.length > 1500 ? m.body.slice(0, 1500) + '…' : m.body;
        out.push(
          `- ${dayOf(m.createdAt)} ${m.userName || 'someone'}${m.via === 'ai' ? ' (AI)' : ''} [comment ${m.id}]${m.replyTo ? ` reply to ${m.replyTo}` : ''}: ${body.replace(/\n/g, '\n  ')}`
        );
      }
    }
    return out.join('\n');
  }

  // ----- writes -----

  function apply(user, board, ops) {
    const r = runOps(user, board, ops);
    const bad = r.results.find((x) => !x.ok);
    if (r.conflicts?.length) throw new ToolError('Someone changed this card at the same moment. Read it again (get_card) and retry.');
    if (bad) throw new ToolError(`Not done: ${bad.error}`);
    return r;
  }

  /** Re-read, change the content with fn(lines, parsed) -> lines, write with a version check (one retry). */
  function editContent(user, board, cardId, fn) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctx = snapshot(user, board);
      const c = getCardOr404(ctx, cardId);
      const p = parseCard(c.content);
      const next = fn([...p.lines], p, c);
      const content = next.join('\n').replace(/\n{3,}/g, '\n\n');
      if (content === c.content) return { ctx, card: c, changed: false };
      const r = runOps(user, board, [{ type: 'card.update', id: c.id, version: c.version, content }]);
      if (r.conflicts?.length && attempt === 0) continue;
      const bad = r.results.find((x) => !x.ok);
      if (bad) throw new ToolError(`Not done: ${bad.error}`);
      const ctx2 = snapshot(user, board);
      return { ctx: ctx2, card: ctx2.byId.get(c.id), changed: true };
    }
    throw new ToolError('The card keeps changing; try again in a moment.');
  }

  function setFirstLineMeta(first, { due, priority }) {
    let l = first;
    if (due !== undefined) {
      l = l.replace(/\s*@\{\d{4}-\d{2}-\d{2}\}/, '');
      if (due) l = insertBeforeTail(l, ` @{${due}}`);
    }
    if (priority !== undefined) {
      l = l.replace(/\s*\[priority::\s*\d+\s*\]/, '');
      if (priority !== null && priority !== '' && priority >= 0) l = insertBeforeTail(l, ` [priority:: ${priority}]`);
    }
    return l;
  }
  // Keep a trailing block id (^abc) last.
  function insertBeforeTail(line, piece) {
    const m = /(\s\^[a-z0-9-]+)\s*$/i.exec(line);
    return m ? line.slice(0, m.index) + piece + m[1] : line.replace(/\s+$/, '') + piece;
  }

  function checkDue(due) {
    if (due == null || due === '') return due;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(due))) throw new ToolError('due must be YYYY-MM-DD (or "" to remove)');
    return String(due);
  }
  function checkPriority(p) {
    if (p == null || p === '') return p;
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 4) throw new ToolError('priority is 0 (most urgent) to 4, or null to remove');
    return n;
  }

  // ----- tools -----

  const str = (description) => ({ type: 'string', description });
  const strs = (description) => ({ type: 'array', items: { type: 'string' }, description });
  const boardArg = str('Board name or id. Default: your (first) board.');

  const tools = [
    {
      name: 'overview',
      description:
        'Start here: who you are, the board lists with card counts, your projects and teammates, common tags, your open cards and what is overdue.',
      readOnly: true,
      inputSchema: { type: 'object', properties: { board: boardArg } },
      run(user, a) {
        const board = pickBoard(user, a.board);
        const ctx = snapshot(user, board);
        const today = dayOf(Date.now());
        const live = ctx.cards.filter((c) => !c.archived);
        const out = [`You are ${user.name} (${user.role}). Board: ${board.name} [${board.id}]. Today: ${today}.`];
        const others = boardsOf(user).filter((b) => b.id !== board.id);
        if (others.length) out.push(`Other boards: ${others.map((b) => b.name).join(', ')}`);
        out.push('', 'Lists: ' + ctx.snap.lanes.map((l) => `${l.title} (${live.filter((c) => c.laneId === l.id).length})`).join(', '));
        out.push('', 'Projects (open cards):');
        for (const p of ctx.projects.values()) {
          const n = live.filter((c) => c.projectId === p.id && !isDoneLane(ctx.lanes.get(c.laneId)?.title)).length;
          if (!n && isPrivateProject(p.id)) continue;
          const who = (p.memberIds || []).map((id) => personName(ctx, id)).join(', ');
          out.push(`- ${p.name} (${n})${who && !isPrivateProject(p.id) ? `: ${who}` : ''}`);
        }
        const tagCount = new Map();
        for (const c of live) for (const t of parseCard(c.content).tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
        const tags = [...tagCount.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12);
        if (tags.length) out.push('', 'Common tags: ' + tags.map(([t, n]) => `#${t} (${n})`).join(', '));
        const open = (c) => !isDoneLane(ctx.lanes.get(c.laneId)?.title);
        const mine = live.filter((c) => open(c) && c.assignees.includes(user.id));
        const overdue = live.filter((c) => open(c) && (parseCard(c.content).due || '9') < today);
        out.push('', `Your open cards: ${mine.length}. Overdue on the board: ${overdue.length}.`);
        for (const c of overdue.slice(0, 10)) out.push(cardLine(ctx, c));
        return out.join('\n');
      },
    },
    {
      name: 'my_cards',
      description: "Cards assigned to you that aren't done (one line each). Use get_card for details.",
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { board: boardArg, include_done: { type: 'boolean', description: 'Also Done/Archive.' } },
      },
      run(user, a) {
        return tools.find((t) => t.name === 'find_cards').run(user, { ...a, assignee: 'me' });
      },
    },
    {
      name: 'find_cards',
      description:
        'Search cards (one line each: [id] title | list | project | priority | due | assignees | checklist | comments | blocked). Done/Archive are left out unless you ask for that list or include_done.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          board: boardArg,
          assignee: str('"me", a teammate name, or "nobody".'),
          list: str('List title, e.g. "To Do", "In Progress", "Backlog", "Done".'),
          project: str('Project name.'),
          text: str('Words in the title or text.'),
          tag: str('Tag, with or without #.'),
          blocked: { type: 'boolean', description: 'Only cards with a "Blocked by:" line.' },
          overdue: { type: 'boolean', description: 'Only cards past their due date.' },
          include_done: { type: 'boolean' },
          limit: { type: 'integer', description: 'Max cards (default 25).' },
        },
      },
      run(user, a) {
        const board = pickBoard(user, a.board);
        const ctx = snapshot(user, board);
        const today = dayOf(Date.now());
        let list = ctx.cards;
        if (a.list) {
          const lane = findLane(ctx, a.list);
          list = laneKey(lane.title) === 'archive'
            ? list.filter((c) => c.archived || c.laneId === lane.id)
            : list.filter((c) => !c.archived && c.laneId === lane.id);
        } else if (!a.include_done) {
          list = list.filter((c) => !c.archived && !isDoneLane(ctx.lanes.get(c.laneId)?.title));
        }
        if (a.assignee) {
          const n = String(a.assignee).trim().toLowerCase();
          if (['nobody', 'none', 'unassigned'].includes(n)) list = list.filter((c) => !c.assignees.length);
          else {
            const u = findPerson(ctx, user, a.assignee);
            list = list.filter((c) => c.assignees.includes(u.id));
          }
        }
        if (a.project) {
          const pid = findProject(ctx, user, a.project);
          list = list.filter((c) => c.projectId === pid);
        }
        if (a.tag) {
          const t = String(a.tag).replace(/^#/, '').toLowerCase();
          list = list.filter((c) => parseCard(c.content).tags.some((x) => x.toLowerCase() === t));
        }
        if (a.text) {
          const words = String(a.text).toLowerCase().split(/\s+/).filter(Boolean);
          list = list.filter((c) => words.every((w) => c.content.toLowerCase().includes(w)));
        }
        if (a.blocked) list = list.filter((c) => parseCard(c.content).blockedBy);
        if (a.overdue) list = list.filter((c) => (parseCard(c.content).due || '9') < today);
        const order = new Map(ctx.snap.lanes.map((l, i) => [l.id, i]));
        list = [...list].sort((x, y) => (order.get(x.laneId) ?? 99) - (order.get(y.laneId) ?? 99) || x.position - y.position);
        const limit = Math.min(Math.max(Number(a.limit) || 25, 1), 200);
        if (!list.length) return 'No cards match.';
        const head = `${list.length} card${list.length === 1 ? '' : 's'}${list.length > limit ? ` (showing ${limit}; narrow the search or raise limit)` : ''}:`;
        return [head, ...list.slice(0, limit).map((c) => cardLine(ctx, c))].join('\n');
      },
    },
    {
      name: 'get_card',
      description: 'One card in full: text, checklist (numbered), referenced cards, "mentioned in", and comments (last 10, or all).',
      readOnly: true,
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: str('Card id (the [id] from lists).'), board: boardArg, comments: { type: 'string', enum: ['last', 'all'] } },
      },
      run(user, a) {
        const board = pickBoard(user, a.board);
        const ctx = snapshot(user, board);
        return cardDetail(ctx, getCardOr404(ctx, a.id), { comments: a.comments });
      },
    },
    {
      name: 'create_card',
      description:
        'Create a card in the team style (title line with due/priority, then text, tags, checklist). Default list: To Do. Blocked work: list "Backlog" + blocked_by.',
      inputSchema: {
        type: 'object',
        required: ['title'],
        properties: {
          board: boardArg,
          title: str('Short title (first line).'),
          description: str('Text under the title (plain words; may contain @cardId references).'),
          checklist: strs('Checklist items.'),
          list: str('List title (default "To Do").'),
          project: str('Project name, or "private" for an Only-me card. Default: your General/first project.'),
          assignees: strs('Teammate names or "me". They must be in the card\'s project.'),
          due: str('YYYY-MM-DD'),
          priority: { type: 'integer', minimum: 0, maximum: 4, description: '0 = most urgent.' },
          tags: strs('Tags like "vidora" (no #).'),
          blocked_by: str('What it waits on; use @cardId when it is another card.'),
        },
      },
      run(user, a) {
        const board = pickBoard(user, a.board);
        const ctx = snapshot(user, board);
        const title = String(a.title || '').trim().replace(/\s*\n\s*/g, ' ');
        if (!title) throw new ToolError('title is required');
        const lane = findLane(ctx, a.list || 'To Do');
        const projectId = a.project ? findProject(ctx, user, a.project) : undefined;
        const people = (a.assignees || []).map((n) => findPerson(ctx, user, n));
        const pid = projectId ?? null;
        if (pid) {
          const out = people.filter((u) => !(isPrivateProject(pid) ? u.id === user.id : canSeeProject(db, u, pid)));
          if (out.length) throw new ToolError(`${out.map((u) => u.name).join(', ')} can't see that project, so they can't be assigned.`);
        }
        let first = title;
        first = setFirstLineMeta(first, { due: checkDue(a.due) || undefined, priority: checkPriority(a.priority) ?? undefined });
        const lines = [first];
        if (a.blocked_by) lines.push(`Blocked by: ${String(a.blocked_by).trim()}`);
        if (a.description) lines.push(String(a.description).trim());
        const tags = (a.tags || []).map((t) => '#' + String(t).trim().replace(/^#/, '')).filter((t) => t.length > 1);
        if (tags.length) lines.push(tags.join(' '));
        for (const it of a.checklist || []) if (String(it).trim()) lines.push(`- [ ] ${String(it).trim()}`);
        const op = { type: 'card.create', laneId: lane.id, index: 0, content: lines.join('\n'), assignees: people.map((u) => u.id) };
        if (projectId) op.projectId = projectId;
        const r = apply(user, board, [op]);
        const ctx2 = snapshot(user, board);
        const card = ctx2.byId.get(r.results[0].id);
        if (card && people.length && card.assignees.length < people.length) {
          return `Created, but some people weren't assigned (not in that project):\n${cardLine(ctx2, card)}`;
        }
        return `Created:\n${card ? cardLine(ctx2, card) : r.results[0].id}`;
      },
    },
    {
      name: 'edit_card',
      description:
        'Change a card. Only the fields you pass change. For text: replace (exact find -> with), append (adds lines before the checklist), or content (whole text, last resort).',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: str('Card id.'),
          board: boardArg,
          title: str('New title (keeps due/priority).'),
          due: str('YYYY-MM-DD, or "" to remove.'),
          priority: { type: ['integer', 'null'], description: '0-4, or null to remove.' },
          blocked_by: str('Set the "Blocked by:" line; "" removes it.'),
          append: str('Text to add (before the checklist).'),
          replace: {
            type: 'object',
            properties: { find: { type: 'string' }, with: { type: 'string' } },
            required: ['find', 'with'],
            description: 'Replace one exact piece of text.',
          },
          add_items: strs('New checklist items.'),
          remove_items: strs('Checklist items to delete (number or words from the item).'),
          project: str('Move to another project you are in.'),
          content: str('Whole new card text (replaces everything).'),
        },
      },
      run(user, a) {
        const board = pickBoard(user, a.board);
        const due = a.due !== undefined ? checkDue(a.due) : undefined;
        const priority = a.priority !== undefined ? checkPriority(a.priority) : undefined;
        let res = editContent(user, board, a.id, (lines, p) => {
          if (a.content != null) return String(a.content).split(/\r?\n/);
          if (a.title != null) {
            const t = String(a.title).trim().replace(/\s*\n\s*/g, ' ');
            if (!t) throw new ToolError('title cannot be empty');
            const keep = (lines[0].match(/\s@\{[^}]*\}|\s\[[\w-]+::[^\]]*\]|\s#[^\s#]+|\s\^[a-z0-9-]+\s*$/gi) || []).join('');
            lines[0] = t + keep;
          }
          if (due !== undefined || priority !== undefined) lines[0] = setFirstLineMeta(lines[0], { due, priority });
          if (a.replace) {
            const text = lines.join('\n');
            if (!text.includes(a.replace.find)) throw new ToolError('replace: text not found (it must match exactly)');
            lines = text.replace(a.replace.find, a.replace.with).split('\n');
          }
          if (a.blocked_by !== undefined) {
            const i = lines.findIndex((l, n) => n > 0 && /^\s*blocked by:/i.test(l));
            const v = String(a.blocked_by).trim();
            if (i >= 0 && !v) lines.splice(i, 1);
            else if (i >= 0) lines[i] = lines[i].replace(/^(\s*)blocked by:.*$/i, `$1Blocked by: ${v}`);
            else if (v) lines.splice(1, 0, `Blocked by: ${v}`);
          }
          if (a.append) {
            const firstTask = lines.findIndex((l, n) => n > 0 && TASK_RE.test(l));
            const at = firstTask > 0 ? firstTask : lines.length;
            lines.splice(at, 0, ...String(a.append).trim().split(/\r?\n/));
          }
          if (a.remove_items?.length) {
            const items = parseCard(lines.join('\n')).items;
            const drop = new Set(a.remove_items.map((q) => matchItem(items, q).line));
            lines = lines.filter((_, n) => !drop.has(n));
          }
          for (const it of a.add_items || []) if (String(it).trim()) lines.push(`- [ ] ${String(it).trim()}`);
          return lines;
        });
        if (a.project) {
          const ctx = res.ctx;
          const pid = findProject(ctx, user, a.project);
          if (pid !== res.card.projectId) {
            apply(user, board, [{ type: 'card.update', id: res.card.id, version: res.card.version, projectId: pid }]);
            const ctx2 = snapshot(user, board);
            res = { ctx: ctx2, card: ctx2.byId.get(res.card.id), changed: true };
          }
        }
        return `${res.changed ? 'Saved' : 'Nothing to change'}:\n${cardLine(res.ctx, res.card)}`;
      },
    },
    {
      name: 'tick_items',
      description: 'Tick (or untick) checklist items. Items by number (from get_card) or by words from the item text.',
      inputSchema: {
        type: 'object',
        required: ['id', 'items'],
        properties: {
          id: str('Card id.'),
          board: boardArg,
          items: strs('Item numbers ("1") or words from the item.'),
          done: { type: 'boolean', description: 'false = untick. Default true.' },
        },
      },
      run(user, a) {
        const board = pickBoard(user, a.board);
        const done = a.done !== false;
        const res = editContent(user, board, a.id, (lines, p) => {
          if (!p.items.length) throw new ToolError('This card has no checklist.');
          for (const q of a.items || []) {
            const it = matchItem(p.items, q);
            lines[it.line] = lines[it.line].replace(/\[(.)\]/, done ? '[x]' : '[ ]');
          }
          return lines;
        });
        const p = parseCard(res.card.content);
        return [`Checklist ${p.items.filter((i) => i.done).length}/${p.items.length}:`, ...p.items.map((it, i) => `${i + 1}. [${it.done ? 'x' : ' '}] ${it.text}`)].join('\n');
      },
    },
    {
      name: 'move_card',
      description: 'Move a card to another list (e.g. "In Progress", "Done", "Backlog", "Archive").',
      inputSchema: {
        type: 'object',
        required: ['id', 'list'],
        properties: {
          id: str('Card id.'),
          board: boardArg,
          list: str('List title.'),
          position: { type: 'string', enum: ['top', 'bottom'], description: 'Default top.' },
        },
      },
      run(user, a) {
        const board = pickBoard(user, a.board);
        const ctx = snapshot(user, board);
        const c = getCardOr404(ctx, a.id);
        const lane = findLane(ctx, a.list);
        apply(user, board, [{ type: 'card.move', id: c.id, laneId: lane.id, index: a.position === 'bottom' ? -1 : 0 }]);
        const ctx2 = snapshot(user, board);
        return `Moved:\n${cardLine(ctx2, ctx2.byId.get(c.id))}`;
      },
    },
    {
      name: 'assign',
      description: "Add or remove people on a card. Only people in the card's project can be added.",
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: str('Card id.'), board: boardArg, add: strs('Names or "me".'), remove: strs('Names or "me".') },
      },
      run(user, a) {
        const board = pickBoard(user, a.board);
        const ctx = snapshot(user, board);
        const c = getCardOr404(ctx, a.id);
        const ops = [];
        for (const n of a.add || []) {
          const u = findPerson(ctx, user, n);
          const ok = isPrivateProject(c.projectId) ? u.id === c.createdBy : canSeeProject(db, u, c.projectId);
          if (!ok) throw new ToolError(`${u.name} isn't in this card's project (${projectName(ctx, c)}), so they can't be assigned.`);
          ops.push({ type: 'card.assign', id: c.id, userId: u.id, assigned: true });
        }
        for (const n of a.remove || []) ops.push({ type: 'card.assign', id: c.id, userId: findPerson(ctx, user, n).id, assigned: false });
        if (!ops.length) throw new ToolError('Pass add and/or remove.');
        apply(user, board, ops);
        const ctx2 = snapshot(user, board);
        return `Saved:\n${cardLine(ctx2, ctx2.byId.get(c.id))}`;
      },
    },
    {
      name: 'comment',
      description:
        'Comment on a card. "@Name" in the text notifies that person on Telegram; "@cardId" links a card. reply_to answers a comment (id from get_card).',
      inputSchema: {
        type: 'object',
        required: ['id', 'text'],
        properties: { id: str('Card id.'), board: boardArg, text: str('Comment (markdown).'), reply_to: str('Comment id to reply to.') },
      },
      run(user, a) {
        const board = pickBoard(user, a.board);
        const ctx = snapshot(user, board);
        const c = getCardOr404(ctx, a.id);
        let m;
        try {
          m = postComment(user, board, c.id, a.text, a.reply_to || null);
        } catch (e) {
          if (e instanceof OpError) throw new ToolError(e.message);
          throw e;
        }
        return `Comment added [comment ${m.id}] on [${c.id}] ${parseCard(c.content).title}.`;
      },
    },
    {
      name: 'report',
      description:
        'What happened in a period (default: last 7 days): finished cards, new cards, comments per person, and what is overdue or in progress now. For weekly/monthly reviews.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          board: boardArg,
          from: str('YYYY-MM-DD (default 7 days ago).'),
          to: str('YYYY-MM-DD (default today).'),
          project: str('Only this project.'),
          person: str('Only this person ("me" or a name).'),
        },
      },
      run(user, a) {
        const board = pickBoard(user, a.board);
        const ctx = snapshot(user, board);
        let h;
        try {
          h = teamHistory(db, user, { from: a.from || undefined, to: a.to || undefined, boardId: board.id });
        } catch (e) {
          throw new ToolError(e.message);
        }
        const pid = a.project ? findProject(ctx, user, a.project) : null;
        const who = a.person ? findPerson(ctx, user, a.person) : null;
        const name = (id) => h.users.find((u) => u.id === id)?.name || personName(ctx, id);
        let cards = h.cards.filter((c) => !pid || c.projectId === pid);
        if (who) cards = cards.filter((c) => c.assignees.includes(who.id) || c.doneBy === who.id);
        const inRange = (ts) => ts != null && ts >= h.from && ts <= h.to;
        const finished = cards.filter((c) => inRange(c.doneAt));
        const created = cards.filter((c) => inRange(c.createdAt));
        const ids = new Set(cards.map((c) => c.id));
        const comments = h.comments.filter((m) => ids.has(m.cardId) && (!who || m.by === who.id));
        const perPerson = new Map();
        for (const m of comments) perPerson.set(name(m.by), (perPerson.get(name(m.by)) || 0) + 1);
        const today = dayOf(Date.now());
        const open = cards.filter((c) => c.status !== 'finished');
        const overdue = open.filter((c) => c.due && c.due < today);
        const doing = open.filter((c) => c.status === 'in_progress' || c.status === 'review');
        const line = (c, extra = '') => `[${c.id}] ${c.title} | ${c.lane}${c.assignees.length ? ' | ' + c.assignees.map(name).join(', ') : ''}${extra}`;
        const out = [`Report ${dayOf(h.from)} to ${dayOf(h.to)}${pid ? `, project ${ctx.projects.get(pid)?.name}` : ''}${who ? `, ${who.name}` : ''}:`];
        out.push(`Finished: ${finished.length} | New: ${created.length} | Comments: ${comments.length} | Overdue now: ${overdue.length} | In progress now: ${doing.length}`);
        if (finished.length) {
          out.push('', 'Finished:');
          for (const c of finished.slice(0, 40)) out.push(line(c, ` | done ${dayOf(c.doneAt)}${c.doneBy ? ' by ' + name(c.doneBy) : ''}`));
        }
        if (perPerson.size) out.push('', 'Comments by: ' + [...perPerson.entries()].map(([n, k]) => `${n} ${k}`).join(', '));
        if (overdue.length) {
          out.push('', 'Overdue now:');
          for (const c of overdue.slice(0, 30)) out.push(line(c, ` | due ${c.due}`));
        }
        if (doing.length) {
          out.push('', 'In progress now:');
          for (const c of doing.slice(0, 30)) out.push(line(c));
        }
        if (created.length) {
          out.push('', 'New cards:');
          for (const c of created.slice(0, 30)) out.push(line(c));
        }
        return out.join('\n');
      },
    },
  ];

  function matchItem(items, q) {
    const s = String(q ?? '').trim();
    if (/^\d+$/.test(s)) {
      const it = items[Number(s) - 1];
      if (!it) throw new ToolError(`No checklist item ${s} (there are ${items.length}).`);
      return it;
    }
    const low = s.toLowerCase();
    const hits = items.filter((i) => i.text.toLowerCase().includes(low));
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new ToolError(`No checklist item matching "${s}".`);
    const exact = hits.filter((i) => i.text.toLowerCase() === low);
    if (exact.length === 1) return exact[0];
    throw new ToolError(`"${s}" matches ${hits.length} items; use the item number.`);
  }

  function instructions(user) {
    return [
      `Mad Kanban team board. You act as ${user.name}; you see only their projects.`,
      'Read with overview / my_cards / find_cards (one line per card); open one card with get_card only when you need its text or comments.',
      'Card style: first line = short title, optional due "@{YYYY-MM-DD}" and "[priority:: 0-4]" (0 = most urgent). Then plain-language text, a "#project" tag line, then "- [ ]" checklist items.',
      'Write in the language the people on that card use. Never put passwords, keys or tokens on cards or comments.',
      'Link another card with @cardId (the id in [brackets]). In comments, @Name sends that person a Telegram message: use it when someone has to act.',
      'Work that waits on something goes to the Backlog list with a "Blocked by: …" line (use @cardId if the blocker is a card).',
      'Only tick checklist items you have actually verified; move a card to Done when all its items are done.',
      'You cannot delete cards or manage people, projects or boards; ask the person to do that in Obsidian.',
    ].join('\n');
  }

  // ----- JSON-RPC -----

  function rpc(user, msg) {
    const { id, method, params = {} } = msg || {};
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600, 'invalid request');
    if (id === undefined) return null; // notification (e.g. notifications/initialized)
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: instructions(user),
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { readOnlyHint: !!t.readOnly, destructiveHint: false, openWorldHint: false },
          })),
        });
      case 'tools/call': {
        const tool = tools.find((t) => t.name === params.name);
        if (!tool) return fail(-32602, `unknown tool: ${params.name}`);
        try {
          const text = tool.run(user, params.arguments || {});
          return reply({ content: [{ type: 'text', text }] });
        } catch (e) {
          if (e instanceof ToolError) return reply({ content: [{ type: 'text', text: e.message }], isError: true });
          if (e instanceof OpError) return reply({ content: [{ type: 'text', text: e.message }], isError: true });
          console.error(e);
          return reply({ content: [{ type: 'text', text: 'Server error; try again.' }], isError: true });
        }
      }
      case 'resources/list':
        return reply({ resources: [] });
      case 'prompts/list':
        return reply({ prompts: [] });
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  }

  function sendJson(res, status, body, headers = {}) {
    const data = body == null ? '' : JSON.stringify(body);
    res.writeHead(status, {
      ...(body == null ? {} : { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) }),
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version',
      'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
      ...headers,
    });
    res.end(data);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    if (req.method === 'OPTIONS') return sendJson(res, 204, null);
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    const user = m ? userByToken(db, m[1].trim()) : null;
    if (!user) {
      return sendJson(res, 401, { error: 'Missing or invalid AI key (Authorization: Bearer <key>)' }, { 'WWW-Authenticate': 'Bearer' });
    }
    if (!user.isAi) {
      return sendJson(res, 403, {
        error: 'Use an AI key, not a device key: Obsidian → Settings → Mad Kanban → Devices → Create AI key.',
      });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST JSON-RPC to /mcp (no SSE stream)' }, { Allow: 'POST' });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    const batch = Array.isArray(body);
    const answers = (batch ? body : [body]).map((msg) => rpc(user, msg)).filter(Boolean);
    if (!answers.length) return sendJson(res, 202, null);
    return sendJson(res, 200, batch ? answers : answers[0]);
  }

  return { handle, tools };
}

class ToolError extends Error {}
