import { newId, rowToCard, transaction } from './db.js';
import { laneKey } from './lanes.js';

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

  const now = Date.now();
  const results = [];
  const conflicts = [];
  const affectedUsers = new Set();
  const touchedCards = new Set();

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
    const others = q.laneCards.all(board.id, laneId).filter((c) => c.id !== cardRow.id);
    const idx = index == null || index < 0 || index > others.length ? others.length : index;
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
          const inLane = new Map(existing.map((c) => [c.id, c]));
          const seen = new Set();
          const ordered = [];
          for (const id of wanted) {
            if (seen.has(id) || !inLane.has(id)) continue;
            seen.add(id);
            ordered.push(inLane.get(id));
          }
          for (const c of existing) if (!seen.has(c.id)) ordered.push(c);
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
          const lane = q.lane.get(op.laneId, board.id);
          if (!lane) {
            r.ok = false;
            r.error = 'lane not found';
            break;
          }
          const assignees = Array.isArray(op.assignees) ? op.assignees.map(String) : [];
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
          const row = q.card.get(id, board.id);
          placeCard(row, lane.id, op.index);
          touch(q.card.get(id, board.id));
          r.id = id;
          break;
        }
        case 'card.update': {
          const card = q.card.get(op.id, board.id);
          if (!card) {
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
          const assignees =
            op.assignees != null && Array.isArray(op.assignees)
              ? JSON.stringify([...new Set(op.assignees.map(String))])
              : card.assignees;
          q.updCard.run(
            op.content != null ? String(op.content) : card.content,
            op.checked != null ? (op.checked ? 1 : 0) : card.checked,
            op.checkChar != null ? String(op.checkChar).slice(0, 1) || ' ' : card.check_char,
            assignees,
            now,
            card.id,
            board.id
          );
          touch(q.card.get(card.id, board.id));
          break;
        }
        case 'card.assign': {
          const card = q.card.get(op.id, board.id);
          if (!card) {
            r.ok = false;
            r.error = 'card not found';
            break;
          }
          const userId = String(op.userId || user.id);
          const set = new Set(rowToCard(card).assignees);
          if (op.assigned === false) set.delete(userId);
          else set.add(userId);
          touch(card);
          q.updCard.run(card.content, card.checked, card.check_char, JSON.stringify([...set]), now, card.id, board.id);
          touch(q.card.get(card.id, board.id));
          break;
        }
        case 'card.move': {
          const card = q.card.get(op.id, board.id);
          if (!card) {
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
          if (!card) {
            r.ok = false;
            r.error = 'card not found';
            break;
          }
          touch(card);
          const pos = q.maxArchivePos.get(board.id).p + 1;
          q.archiveCard.run(pos, now, card.id, board.id);
          if (card.lane_id) renumberLane(card.lane_id);
          break;
        }
        case 'card.delete': {
          const card = q.card.get(op.id, board.id);
          if (!card) {
            r.ok = false;
            r.error = 'card not found';
            break;
          }
          touch(card);
          q.delCard.run(card.id, board.id);
          if (card.lane_id) renumberLane(card.lane_id);
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
  };
}
