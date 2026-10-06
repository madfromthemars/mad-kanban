import { Board, Item, Lane } from 'src/components/types';

import {
  isMirrorLane,
  isTeamItem,
  isTeamLane,
  normalizeLaneTitle,
  parseTeamItemId,
  parseTeamLaneId,
} from './ids';
import { TeamOp } from './types';

interface CardPos {
  item: Item;
  laneId: string;
  laneTitle: string;
  index: number;
}

function indexCards(board: Board, boardId: string) {
  const cards = new Map<string, CardPos>();
  const laneSeq = new Map<string, string[]>();
  for (const lane of board.children) {
    const parsed = parseTeamLaneId(lane.id);
    if (!parsed || parsed.boardId !== boardId) continue;
    const seq: string[] = [];
    lane.children.forEach((item, index) => {
      const p = parseTeamItemId(item.id);
      if (!p || p.boardId !== boardId) return;
      cards.set(p.cardId, { item, laneId: parsed.laneId, laneTitle: lane.data.title, index });
      seq.push(p.cardId);
    });
    laneSeq.set(parsed.laneId, seq);
  }
  const archive = new Set<string>();
  for (const item of board.data.archive || []) {
    const p = parseTeamItemId(item.id);
    if (p && p.boardId === boardId) archive.add(p.cardId);
  }
  return { cards, laneSeq, archive };
}

function sameContent(a: Item, b: Item) {
  return (
    a.data.titleRaw === b.data.titleRaw &&
    !!a.data.checked === !!b.data.checked &&
    (a.data.checkChar || ' ') === (b.data.checkChar || ' ')
  );
}

function sameSeq(a: string[] | undefined, b: string[] | undefined) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Diff two states of a *team board* into server ops. Both boards must already
 * carry team ids on every lane and item (see TeamSync.assignIds).
 */
export function diffTeamBoard(
  boardId: string,
  prev: Board,
  next: Board,
  versions: Map<string, number>
): TeamOp[] {
  const ops: TeamOp[] = [];

  const prevLanes = new Map<string, { lane: Lane; index: number }>();
  const nextLanes = new Map<string, { lane: Lane; index: number }>();
  prev.children.forEach((lane, index) => {
    const p = parseTeamLaneId(lane.id);
    if (p && p.boardId === boardId) prevLanes.set(p.laneId, { lane, index });
  });
  next.children.forEach((lane, index) => {
    const p = parseTeamLaneId(lane.id);
    if (p && p.boardId === boardId) nextLanes.set(p.laneId, { lane, index });
  });

  const prevIdx = indexCards(prev, boardId);
  const nextIdx = indexCards(next, boardId);

  // Lanes: create / update
  for (const [laneId, { lane, index }] of nextLanes) {
    const before = prevLanes.get(laneId);
    if (!before) {
      ops.push({
        type: 'lane.create',
        id: laneId,
        title: lane.data.title,
        index,
        markComplete: !!lane.data.shouldMarkItemsComplete,
        maxItems: lane.data.maxItems || 0,
      });
      continue;
    }
    const b = before.lane.data;
    const a = lane.data;
    if (
      b.title !== a.title ||
      !!b.shouldMarkItemsComplete !== !!a.shouldMarkItemsComplete ||
      (b.maxItems || 0) !== (a.maxItems || 0)
    ) {
      ops.push({
        type: 'lane.update',
        id: laneId,
        title: a.title,
        markComplete: !!a.shouldMarkItemsComplete,
        maxItems: a.maxItems || 0,
      });
    }
  }

  // Cards: create / move / update. Placement ops are emitted in ascending
  // target index so sequential insertion on the server reproduces the order.
  const placements: TeamOp[] = [];
  for (const [cardId, pos] of nextIdx.cards) {
    const before = prevIdx.cards.get(cardId);
    if (!before) {
      if (prevIdx.archive.has(cardId)) {
        // Restored from the archive: card.move also clears the archived flag.
        placements.push({ type: 'card.move', id: cardId, laneId: pos.laneId, index: pos.index });
        continue;
      }
      placements.push({
        type: 'card.create',
        id: cardId,
        laneId: pos.laneId,
        index: pos.index,
        content: pos.item.data.titleRaw,
        checked: !!pos.item.data.checked,
        checkChar: pos.item.data.checkChar || ' ',
      });
      continue;
    }
    if (before.laneId !== pos.laneId) {
      placements.push({ type: 'card.move', id: cardId, laneId: pos.laneId, index: pos.index });
    }
    if (!sameContent(before.item, pos.item)) {
      ops.push({
        type: 'card.update',
        id: cardId,
        version: versions.get(cardId),
        content: pos.item.data.titleRaw,
        checked: !!pos.item.data.checked,
        checkChar: pos.item.data.checkChar || ' ',
      });
    }
  }

  placements.sort((a, b) => ((a as any).index ?? 0) - ((b as any).index ?? 0));
  ops.unshift(...placements);

  // Cards: archive / delete
  for (const cardId of prevIdx.cards.keys()) {
    if (nextIdx.cards.has(cardId)) continue;
    if (nextIdx.archive.has(cardId)) ops.push({ type: 'card.archive', id: cardId });
    else ops.push({ type: 'card.delete', id: cardId });
  }

  // Reorders inside a lane. Only compares the cards that stayed in the lane, so
  // a plain move between lanes doesn't also rewrite the whole lane order.
  for (const [laneId, seq] of nextIdx.laneSeq) {
    const prevSeq = prevIdx.laneSeq.get(laneId);
    if (!prevSeq) continue; // new lane: creates/moves already carry indexes
    const stayed = seq.filter((id) => prevIdx.cards.get(id)?.laneId === laneId);
    const prevStayed = prevSeq.filter((id) => nextIdx.cards.get(id)?.laneId === laneId);
    if (!sameSeq(stayed, prevStayed)) {
      ops.push({ type: 'lane.setCards', laneId, cardIds: seq });
    }
  }

  // Lanes: delete (after card ops so intent for their cards is explicit)
  for (const laneId of prevLanes.keys()) {
    if (!nextLanes.has(laneId)) ops.push({ type: 'lane.delete', id: laneId });
  }

  // Lane order
  const prevOrder = [...prevLanes.keys()].filter((id) => nextLanes.has(id));
  const nextOrder = [...nextLanes.keys()];
  const nextSurvivors = nextOrder.filter((id) => prevLanes.has(id));
  if (!sameSeq(prevOrder, nextSurvivors)) {
    ops.push({ type: 'lane.setOrder', laneIds: nextOrder });
  }

  return ops;
}

export interface MirrorOps {
  byBoard: Map<string, TeamOp[]>;
}

function indexMirror(board: Board) {
  const cards = new Map<string, { item: Item; lane: Lane; boardId: string }>();
  for (const lane of board.children) {
    for (const item of lane.children) {
      const p = parseTeamItemId(item.id);
      if (!p) continue;
      cards.set(item.id, { item, lane, boardId: p.boardId });
    }
  }
  return cards;
}

/**
 * Diff two states of a *personal board* and produce ops for the team cards
 * mirrored into it: lane moves (by lane title), content edits, and
 * self-unassignment when a mirrored card is removed.
 */
export function diffMirror(
  prev: Board,
  next: Board,
  meId: string,
  versions: Map<string, number>
): MirrorOps {
  const byBoard = new Map<string, TeamOp[]>();
  const push = (boardId: string, op: TeamOp) => {
    if (!byBoard.has(boardId)) byBoard.set(boardId, []);
    byBoard.get(boardId).push(op);
  };

  const before = indexMirror(prev);
  const after = indexMirror(next);

  for (const [id, cur] of after) {
    const p = parseTeamItemId(id);
    const old = before.get(id);
    if (!old) continue; // mirrored cards are only ever injected by the mirror itself

    const laneChanged =
      normalizeLaneTitle(old.lane.data.title) !== normalizeLaneTitle(cur.lane.data.title);
    const targetIsMirrorLane = isMirrorLane(cur.lane);

    if (laneChanged && !targetIsMirrorLane) {
      const op: TeamOp = {
        type: 'card.move',
        id: p.cardId,
        laneTitle: cur.lane.data.title,
        index: -1,
      };
      if (!!old.item.data.checked !== !!cur.item.data.checked) {
        op.checked = !!cur.item.data.checked;
        op.checkChar = cur.item.data.checkChar || ' ';
      }
      push(p.boardId, op);
      if (old.item.data.titleRaw !== cur.item.data.titleRaw) {
        push(p.boardId, {
          type: 'card.update',
          id: p.cardId,
          version: versions.get(p.cardId),
          content: cur.item.data.titleRaw,
        });
      }
    } else if (!sameContent(old.item, cur.item)) {
      push(p.boardId, {
        type: 'card.update',
        id: p.cardId,
        version: versions.get(p.cardId),
        content: cur.item.data.titleRaw,
        checked: !!cur.item.data.checked,
        checkChar: cur.item.data.checkChar || ' ',
      });
    }
  }

  for (const [id, old] of before) {
    if (after.has(id)) continue;
    const p = parseTeamItemId(id);
    if (!p) continue;
    // Deleted or archived locally: leave the team card alone, just stop showing it to me.
    push(p.boardId, { type: 'card.assign', id: p.cardId, userId: meId, assigned: false });
    void old;
  }

  return { byBoard };
}

export function hasTeamEntities(board: Board) {
  return board.children.some((l) => isTeamLane(l) || l.children.some((i) => isTeamItem(i)));
}
