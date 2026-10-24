import { canSeeProject, defaultProjectId, getUser, isPrivateProject, newId, parseSettings, rowToCard, transaction, visibleProjectIds } from './db.js';
import { laneKey } from './lanes.js';
import { archiveLane, logEvent, syncDone, trashCard } from './progress.js';
import { logCardChanges } from './history.js';

/** Lanes first, so cards created in a new lane in the same batch can find it. */
export function orderOps(ops) {
  if (!Array.isArray(ops)) return ops;
  return [...ops.filter((o) => o?.type === 'lane.create'), ...ops.filter((o) => o?.type !== 'lane.create')];
}

/**
 * A client whose board lost its server ids re-sends the whole board as new
 * lanes/cards. Refuse batches that recreate several existing lanes or cards.
 */
export function detectReupload(db, boardId, ops) {
  if (!Array.isArray(ops)) return null;
  const lanes = db.prepare('SELECT id, title FROM lanes WHERE board_id = ?').all(boardId);
  const laneIds = new Set(lanes.map((l) => l.id));
  const laneKeys = new Set(lanes.map((l) => laneKey(l.title)));
  const contents = new Map();
  for (const c of db.prepare('SELECT id, content FROM cards WHERE board_id = ? AND archived = 0').all(boardId)) {
    contents.set(c.content, (contents.get(c.content) || 0) + 1);
  }
  let dupLanes = 0;
  let dupCards = 0;
  for (const op of ops) {
    if (op?.type === 'lane.create' && !laneIds.has(op.id) && laneKeys.has(laneKey(String(op.title ?? '')))) {
      dupLanes++;
    } else if (op?.type === 'card.create' && contents.get(String(op.content ?? ''))) {
      dupCards++;
    }
  }
  if (dupLanes >= 2 || dupCards >= 3) {
    return `refused: this change would duplicate ${dupLanes} list(s) and ${dupCards} card(s) that already exist; reload the board`;
  }
  return null;
}

export class OpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const ID_RE = /^[a-z0-9-]{4,40}$/;

function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/**
 * Apply a batch of ops to a board inside one transaction.
 * Returns { version, results, conflicts, affectedUsers }.
 *
 * Conflicts (stale card.update) do not abort the batch: the op is skipped and
 * reported so the client can reload the board.
 */
export function applyOps(db, board, user, ops) {
  if (!Array.isArray(ops)) throw new OpError(400, 'ops must be an array');
  if (ops.length > 500) throw new OpError(400, 'too many ops in one batch');
  ops = orderOps(ops);

  const now = Date.now();
  const results = [];
  const conflicts = [];
  const affectedUsers = new Set();
  const touchedCards = new Set();
  // What people may want to hear about (see notify.js): new assignees, list changes.
  const events = [];
  const assignedEvents = (cardId, before, after) => {
    for (const id of after) if (!before.includes(id)) events.push({ type: 'assigned', cardId, userId: id });
  };
  // Cards in projects the user isn't in are invisible to them: ops treat them as missing,
  // and reorders/inserts keep them where they are.
  const vis = visibleProjectIds(db, user);
  const sees = (row) => !!row && (vis === null || vis.has(row.project_id));
  const projectOk = (id) => typeof id === 'string' && (vis === null ? !!q.project.get(id) : vis.has(id));

  const q = {
    lane: db.prepare('SELECT * FROM lanes WHERE id = ? AND board_id = ?'),
    laneByTitle: {
      get(boardId, title) {
        const lanes = db.prepare('SELECT * FROM lanes WHERE board_id = ? ORDER BY position').all(boardId);
        const t = String(title).trim().toLowerCase();
        const exact = lanes.find((l) => l.title.trim().toLowerCase() === t);
        if (exact) return exact;
        const key = laneKey(title);
        return lanes.find((l) => laneKey(l.title) === key);
      },
    },
    lanes: db.prepare('SELECT * FROM lanes WHERE board_id = ? ORDER BY position'),
    laneCards: db.prepare(
      'SELECT * FROM cards WHERE board_id = ? AND lane_id = ? AND archived = 0 ORDER BY position'
    ),
    card: db.prepare('SELECT * FROM cards WHERE id = ? AND board_id = ?'),
    project: db.prepare('SELECT id FROM projects WHERE id = ?'),
    setCardProject: db.prepare(
      'UPDATE cards SET project_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND board_id = ?'
    ),
    insLane: db.prepare(
      'INSERT INTO lanes (id, board_id, title, position, mark_complete, max_items) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    updLane: db.prepare(
      'UPDATE lanes SET title = ?, mark_complete = ?, max_items = ? WHERE id = ? AND board_id = ?'
    ),
    setLanePos: db.prepare('UPDATE lanes SET position = ? WHERE id = ? AND board_id = ?'),
    delLane: db.prepare('DELETE FROM lanes WHERE id = ? AND board_id = ?'),
    insCard: db.prepare(
      `INSERT INTO cards (id, board_id, lane_id, position, content, checked, check_char, assignees,
        version, archived, created_by, created_at, updated_at, last_moved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)`
    ),
    setCardPos: db.prepare(
      'UPDATE cards SET lane_id = ?, position = ?, last_moved = CASE WHEN lane_id IS ? THEN last_moved ELSE ? END, archived = 0 WHERE id = ? AND board_id = ?'
    ),
    updCard: db.prepare(
      `UPDATE cards SET content = ?, checked = ?, check_char = ?, assignees = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND board_id = ?`
    ),
    archiveCard: db.prepare(
      'UPDATE cards SET archived = 1, position = ?, version = version + 1, updated_at = ? WHERE id = ? AND board_id = ?'
    ),
    archiveLaneCards: db.prepare(
      'UPDATE cards SET archived = 1, updated_at = ? WHERE board_id = ? AND lane_id = ? AND archived = 0'
    ),
    delCard: db.prepare('DELETE FROM cards WHERE id = ? AND board_id = ?'),
    bumpBoard: db.prepare('UPDATE boards SET version = version + 1 WHERE id = ?'),
    boardSettings: db.prepare('SELECT settings FROM boards WHERE id = ?'),
    setBoardSettings: db.prepare('UPDATE boards SET settings = ? WHERE id = ?'),
    boardVersion: db.prepare('SELECT version FROM boards WHERE id = ?'),
    maxArchivePos: db.prepare(
      'SELECT COALESCE(MAX(position), -1) AS p FROM cards WHERE board_id = ? AND archived = 1'
    ),
  };

  const touch = (cardRow) => {
    if (!cardRow) return;
    touchedCards.add(cardRow.id);
    for (const a of rowToCard(cardRow).assignees) affectedUsers.add(a);
  };

  const renumberLane = (laneId) => {
    const cards = q.laneCards.all(board.id, laneId);
    cards.forEach((c, i) => {
      if (c.position !== i) q.setCardPos.run(laneId, i, laneId, now, c.id, board.id);
    });
  };

  const placeCard = (cardRow, laneId, index) => {
    // Insert card into lane at index (index < 0 or too large = end), shifting others.
    // The index counts only the cards the user can see.
    const others = q.laneCards.all(board.id, laneId).filter((c) => c.id !== cardRow.id);
    const shown = others.filter(sees);
    let idx = others.length;
    if (index != null && index >= 0 && index < shown.length) idx = others.indexOf(shown[index]);
    others.splice(idx, 0, cardRow);
    others.forEach((c, i) => {
      q.setCardPos.run(laneId, i, laneId, now, c.id, board.id);
    });
  };

  transaction(db, () => {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] || {};
      const r = { i, type: op.type, ok: true };
      results.push(r);
      switch (op.type) {
        case 'lane.create': {
          const id = validId(op.id) ? op.id : newId(10);
          if (q.lane.get(id, board.id)) {
            r.ok = false;
            r.error = 'lane exists';
            break;
          }
          const lanes = q.lanes.all(board.id);
          const idx = op.index == null || op.index < 0 || op.index > lanes.length ? lanes.length : op.index;
          lanes.splice(idx, 0, { id });
          q.insLane.run(id, board.id, String(op.title ?? 'Untitled'), idx, op.markComplete ? 1 : 0, op.maxItems | 0);
          lanes.forEach((l, p) => q.setLanePos.run(p, l.id, board.id));
          r.id = id;
          break;
        }
        case 'lane.update': {
          const lane = q.lane.get(op.id, board.id);
          if (!lane) {
            r.ok = false;
            r.error = 'lane not found';
            break;
          }
          q.updLane.run(
            op.title != null ? String(op.title) : lane.title,
            op.markComplete != null ? (op.markComplete ? 1 : 0) : lane.mark_complete,
            op.maxItems != null ? op.maxItems | 0 : lane.max_items,
            lane.id,
            board.id
          );
          break;
        }
        case 'lane.delete': {
          const lane = q.lane.get(op.id, board.id);
          if (!lane) {
            r.ok = false;
            r.error = 'lane not found';
            break;
          }
          // It would archive cards of projects the user can't see.
          if (user.role !== 'owner') {
            r.ok = false;
            r.error = 'only the owner can delete lists';
            break;
          }
          for (const c of q.laneCards.all(board.id, lane.id)) touch(c);
          q.archiveLaneCards.run(now, board.id, lane.id);
          q.delLane.run(lane.id, board.id);
          q.lanes.all(board.id).forEach((l, p) => q.setLanePos.run(p, l.id, board.id));
          break;
        }
        case 'lane.setOrder': {
          const lanes = q.lanes.all(board.id);
          const wanted = Array.isArray(op.laneIds) ? op.laneIds : [];
          const known = new Map(lanes.map((l) => [l.id, l]));
          const ordered = wanted.filter((id) => known.has(id)).map((id) => known.get(id));
          for (const l of lanes) if (!wanted.includes(l.id)) ordered.push(l);
          ordered.forEach((l, p) => q.setLanePos.run(p, l.id, board.id));
          break;
        }
        case 'lane.setCards': {
          const lane = q.lane.get(op.laneId, board.id);
          if (!lane) {
            r.ok = false;
            r.error = 'lane not found';
            break;
          }
          // Reorder only. Ids that are not in this lane are ignored (a stale
          // client must not pull a card back that someone else moved away);
          // cards the client doesn't know about keep their relative place at the end.
          const wanted = Array.isArray(op.cardIds) ? op.cardIds : [];
          const existing = q.laneCards.all(board.id, lane.id);
          const inLane = new Map(existing.filter(sees).map((c) => [c.id, c]));
          const seen = new Set();
          const mine = [];
          for (const id of wanted) {
            if (seen.has(id) || !inLane.has(id)) continue;
            seen.add(id);
            mine.push(inLane.get(id));
          }
          for (const c of existing) if (sees(c) && !seen.has(c.id)) mine.push(c);
          // Cards the user can't see keep their slots; visible slots take the new order.
          const ordered = existing.map((c) => (sees(c) ? mine.shift() : c));
          ordered.forEach((c, p) => {
            if (c.position !== p) q.setCardPos.run(lane.id, p, lane.id, now, c.id, board.id);
          });
          break;
        }
        case 'card.create': {
          const id = validId(op.id) ? op.id : newId(10);
          if (q.card.get(id, board.id)) {
            r.ok = false;
            r.error = 'card exists';
            break;
          }
          let lane = op.laneId ? q.lane.get(String(op.laneId), board.id) : null;
          if (!lane && op.laneTitle) lane = q.laneByTitle.get(board.id, String(op.laneTitle));
          if (!lane) {
            r.ok = false;
            r.error = 'lane not found';
            break;
          }
          let projectId = op.projectId != null ? String(op.projectId) : defaultProjectId(db, user);
          if (!projectOk(projectId)) {
            r.ok = false;
            r.error = projectId ? 'you are not in that project' : 'you are not in any project';
            break;
          }
          // Only people who can see the card's project can be assigned to it.
          // A private card always belongs to its creator alone.
          const assignees = isPrivateProject(projectId)
            ? [user.id]
            : (Array.isArray(op.assignees) ? [...new Set(op.assignees.map(String))] : []).filter((a) => {
                const u = getUser(db, a);
                return !!u && !u.disabled && canSeeProject(db, u, projectId);
              });
          q.insCard.run(
            id,
            board.id,
            lane.id,
            0,
            String(op.content ?? ''),
            op.checked ? 1 : 0,
            String(op.checkChar || ' ').slice(0, 1) || ' ',
            JSON.stringify(assignees),
            user.id,
            now,
            now,
            now
          );
          q.setCardProject.run(projectId, now, id, board.id);
          assignedEvents(id, [], assignees);
          const row = q.card.get(id, board.id);
          placeCard(row, lane.id, op.index);
          syncDone(db, board.id, id, user.id, now);
          logEvent(db, { boardId: board.id, cardId: id, userId: user.id, type: 'created', toLane: lane.title, ts: now });
          touch(q.card.get(id, board.id));
          r.id = id;
          break;
        }
        case 'card.update': {
          const card = q.card.get(op.id, board.id);
          if (!sees(card)) {
            r.ok = false;
            r.error = 'card not found';
            break;
          }
          if (op.version != null && op.version < card.version) {
            r.ok = false;
            r.error = 'conflict';
            conflicts.push({ id: card.id, version: card.version, card: rowToCard(card) });
            break;
          }
          touch(card);
          const toProject = op.projectId != null ? String(op.projectId) : card.project_id;
          // Only the person who made a card can make it private (it then disappears for everyone else).
          if (toProject !== card.project_id && isPrivateProject(toProject) && card.created_by !== user.id) {
            r.ok = false;
            r.error = 'only the person who made this card can make it private';
            break;
          }
          const assignees = isPrivateProject(toProject) && projectOk(toProject)
            ? JSON.stringify([card.created_by])
            : op.assignees != null && Array.isArray(op.assignees)
              ? JSON.stringify([...new Set(op.assignees.map(String))])
              : card.assignees;
          if (assignees !== card.assignees) {
            assignedEvents(card.id, rowToCard(card).assignees, JSON.parse(assignees));
          }
          q.updCard.run(
            op.content != null ? String(op.content) : card.content,
            op.checked != null ? (op.checked ? 1 : 0) : card.checked,
            op.checkChar != null ? String(op.checkChar).slice(0, 1) || ' ' : card.check_char,
            assignees,
            now,
            card.id,
            board.id
          );
          if (op.projectId != null && String(op.projectId) !== card.project_id) {
            if (!projectOk(String(op.projectId))) {
              r.ok = false;
              r.error = 'you are not in that project';
            } else {
              q.setCardProject.run(String(op.projectId), now, card.id, board.id);
            }
          }
          const updated = q.card.get(card.id, board.id);
          logCardChanges(db, { boardId: board.id, userId: user.id, before: card, after: updated, ts: now });
          touch(updated);
          break;
        }
        case 'card.assign': {
          const card = q.card.get(op.id, board.id);
          if (!sees(card)) {
            r.ok = false;
            r.error = 'card not found';
            break;
          }
          const userId = String(op.userId || user.id);
          const before = rowToCard(card).assignees;
          // Private cards stay assigned to their creator only.
          if (isPrivateProject(card.project_id)) {
            if (userId !== card.created_by || op.assigned === false) {
              r.ok = false;
              r.error = 'private cards belong to their creator only';
            }
            break;
          }
          const set = new Set(before);
          if (op.assigned === false) set.delete(userId);
          else set.add(userId);
          assignedEvents(card.id, before, [...set]);
          touch(card);
          q.updCard.run(card.content, card.checked, card.check_char, JSON.stringify([...set]), now, card.id, board.id);
          const updated = q.card.get(card.id, board.id);
          logCardChanges(db, { boardId: board.id, userId: user.id, before: card, after: updated, ts: now });
          touch(updated);
          break;
        }
        case 'card.move': {
          const card = q.card.get(op.id, board.id);
          if (!sees(card)) {
            r.ok = false;
            r.error = 'card not found';
            break;
          }
          let lane = null;
          if (op.laneId) lane = q.lane.get(op.laneId, board.id);
          if (!lane && op.laneTitle) lane = q.laneByTitle.get(board.id, String(op.laneTitle));
          if (!lane) {
            r.ok = false;
            r.error = op.laneTitle ? `no list named "${op.laneTitle}" on this board` : 'lane not found';
            break;
          }
          const fromLane = card.lane_id;
          touch(card);
          placeCard(card, lane.id, op.index);
          if (fromLane !== lane.id || card.archived) {
            if (fromLane !== lane.id) events.push({ type: 'moved', cardId: card.id, fromLaneId: fromLane, toLaneId: lane.id });
            const from = fromLane ? q.lane.get(fromLane, board.id) : null;
            logEvent(db, { boardId: board.id, cardId: card.id, userId: user.id, type: 'moved', fromLane: from?.title ?? null, toLane: lane.title, ts: now });
            syncDone(db, board.id, card.id, user.id, now);
          }
          if (fromLane && fromLane !== lane.id) renumberLane(fromLane);
          if (op.checked != null || op.checkChar != null) {
            const c2 = q.card.get(card.id, board.id);
            q.updCard.run(
              c2.content,
              op.checked != null ? (op.checked ? 1 : 0) : c2.checked,
              op.checkChar != null ? String(op.checkChar).slice(0, 1) || ' ' : c2.check_char,
              c2.assignees,
              now,
              c2.id,
              board.id
            );
          }
          r.laneId = lane.id;
          break;
        }
        case 'card.archive': {
          const card = q.card.get(op.id, board.id);
          if (!sees(card)) {
            r.ok = false;
            r.error = 'card not found';
            break;
          }
          touch(card);
          // "Archive" puts the card in the board's Archive list, where it still counts as
          // finished and stays easy to find. Boards without one keep the old hidden archive.
          const arch = archiveLane(db, board.id);
          const from = card.lane_id ? q.lane.get(card.lane_id, board.id) : null;
          if (arch) {
            if (card.lane_id !== arch.id || card.archived) {
              placeCard(card, arch.id, 0);
              if (card.lane_id && card.lane_id !== arch.id) renumberLane(card.lane_id);
            }
          } else {
            const pos = q.maxArchivePos.get(board.id).p + 1;
            q.archiveCard.run(pos, now, card.id, board.id);
            if (card.lane_id) renumberLane(card.lane_id);
          }
          logEvent(db, { boardId: board.id, cardId: card.id, userId: user.id, type: 'archived', fromLane: from?.title ?? null, toLane: arch?.title ?? null, ts: now });
          syncDone(db, board.id, card.id, user.id, now);
          r.laneId = arch?.id ?? null;
          break;
        }
        case 'card.delete': {
          const card = q.card.get(op.id, board.id);
          if (!sees(card)) {
            r.ok = false;
            r.error = 'card not found';
            break;
          }
          touch(card);
          // To the Trash (30 days), not gone: see progress.js.
          const from = card.lane_id ? q.lane.get(card.lane_id, board.id) : null;
          trashCard(db, card, user, from?.title, now);
          logEvent(db, { boardId: board.id, cardId: card.id, userId: user.id, type: 'deleted', fromLane: from?.title ?? null, ts: now });
          q.delCard.run(card.id, board.id);
          if (card.lane_id) renumberLane(card.lane_id);
          break;
        }
        case 'board.settings': {
          // Partial update: listed keys are replaced, null removes a key.
          if (!op.set || typeof op.set !== 'object' || Array.isArray(op.set)) {
            r.ok = false;
            r.error = 'set must be an object';
            break;
          }
          const cur = parseSettings(q.boardSettings.get(board.id)?.settings);
          for (const [k, v] of Object.entries(op.set)) {
            if (v === null) delete cur[k];
            else cur[k] = v;
          }
          const json = JSON.stringify(cur);
          if (json.length > 200000) {
            r.ok = false;
            r.error = 'settings too large';
            break;
          }
          q.setBoardSettings.run(json, board.id);
          r.settingsChanged = true;
          break;
        }
        case 'board.addTagColors': {
          // Union: only adds colors for tags that have none yet.
          const cur = parseSettings(q.boardSettings.get(board.id)?.settings);
          const list = Array.isArray(cur['tag-colors']) ? cur['tag-colors'] : [];
          const have = new Set(list.map((t) => t && t.tagKey));
          let added = 0;
          for (const t of Array.isArray(op.colors) ? op.colors : []) {
            if (!t || typeof t.tagKey !== 'string' || have.has(t.tagKey)) continue;
            list.push({ tagKey: t.tagKey, color: String(t.color || ''), backgroundColor: String(t.backgroundColor || '') });
            have.add(t.tagKey);
            added++;
          }
          if (added) {
            cur['tag-colors'] = list;
            q.setBoardSettings.run(JSON.stringify(cur), board.id);
            r.settingsChanged = true;
          }
          r.added = added;
          break;
        }
        default:
          r.ok = false;
          r.error = `unknown op type: ${op.type}`;
      }
    }
    q.bumpBoard.run(board.id);
  });

  const { version } = q.boardVersion.get(board.id);
  const versions = {};
  for (const id of touchedCards) {
    const c = q.card.get(id, board.id);
    if (c) versions[id] = c.version;
  }
  return {
    version,
    results,
    conflicts,
    versions,
    affectedUsers: [...affectedUsers],
    touchedCards: [...touchedCards],
    events,
  };
}
