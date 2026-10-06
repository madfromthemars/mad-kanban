import update from 'immutability-helper';
import { StateManager } from 'src/StateManager';
import { cardAgeCache, getCardCacheKey } from 'src/components/Item/ItemContent';
import { Board, Item, Lane, LaneTemplate } from 'src/components/types';
import {
  calculateCardAge,
  extractCardTitle,
  getCardAgeClass,
} from 'src/kanbanFileHelpers';

import { isTeamItem, isTeamLane, teamItemId, teamLaneId } from './ids';
import { TeamBoardSnapshot, TeamCard } from './types';

/** Build a kanban Item from a server card, parsed with the board's own markdown parser. */
export function cardToItem(stateManager: StateManager, boardId: string, card: TeamCard): Item {
  const checkChar = card.checked ? card.checkChar || 'x' : ' ';
  const base = stateManager.parser.newItem(card.content || '', checkChar);
  const item = update(base, {
    id: { $set: teamItemId(boardId, card.id) },
    data: {
      blockId: { $set: card.id },
      checked: { $set: !!card.checked },
      checkChar: { $set: checkChar },
      forceEditMode: { $set: false },
    },
  });

  // Card age coloring reuses the same cache the file-backed cards use.
  const title = extractCardTitle(item.data.titleRaw);
  if (title) {
    const key = getCardCacheKey(stateManager.file.path, title);
    const age = calculateCardAge(card.lastMoved ? new Date(card.lastMoved) : null);
    cardAgeCache.set(key, getCardAgeClass(age));
  }

  return item;
}

/**
 * Convert a server snapshot into a Board, keeping the local board's settings,
 * frontmatter and per-lane view state (sort) where the lane still exists.
 */
export function snapshotToBoard(
  stateManager: StateManager,
  snapshot: TeamBoardSnapshot,
  base: Board
): Board {
  const boardId = snapshot.board.id;
  const prevLanes = new Map<string, Lane>();
  for (const lane of base?.children || []) prevLanes.set(lane.id, lane);

  const byLane = new Map<string, TeamCard[]>();
  for (const card of snapshot.cards) {
    if (!card.laneId) continue;
    if (!byLane.has(card.laneId)) byLane.set(card.laneId, []);
    byLane.get(card.laneId).push(card);
  }

  const lanes: Lane[] = [...snapshot.lanes]
    .sort((a, b) => a.position - b.position)
    .map((lane) => {
      const id = teamLaneId(boardId, lane.id);
      const prev = prevLanes.get(id);
      const cards = (byLane.get(lane.id) || []).sort((a, b) => a.position - b.position);
      return {
        ...LaneTemplate,
        id,
        children: cards.map((c) => cardToItem(stateManager, boardId, c)),
        data: {
          title: lane.title,
          maxItems: lane.maxItems || 0,
          shouldMarkItemsComplete: !!lane.markComplete,
          ...(prev?.data?.sorted !== undefined ? { sorted: prev.data.sorted } : {}),
        },
      };
    });

  const archive = [...snapshot.archive]
    .sort((a, b) => a.position - b.position)
    .map((c) => cardToItem(stateManager, boardId, c));

  return update(base, {
    children: { $set: lanes },
    data: {
      archive: { $set: archive },
      errors: { $set: [] },
    },
  });
}

/**
 * After a team board is (re)parsed from its cached markdown, lane and item ids
 * are freshly generated. Restore the server ids: items by block id, lanes by
 * title, using the last known snapshot.
 */
export function normalizeIds(board: Board, boardId: string, snapshot: TeamBoardSnapshot | null): Board {
  const laneByTitle = new Map<string, string>();
  if (snapshot) {
    for (const lane of snapshot.lanes) laneByTitle.set(lane.title.trim().toLocaleLowerCase(), lane.id);
  }
  const knownCards = new Set<string>();
  if (snapshot) {
    for (const c of snapshot.cards) knownCards.add(c.id);
    for (const c of snapshot.archive) knownCards.add(c.id);
  }

  const fixItems = (items: Item[]) =>
    items.map((item) => {
      if (isTeamItem(item)) return item;
      const blockId = item.data.blockId;
      if (blockId && (knownCards.size === 0 || knownCards.has(blockId))) {
        return { ...item, id: teamItemId(boardId, blockId) };
      }
      return item;
    });

  const lanes = board.children.map((lane) => {
    let next = lane;
    if (!isTeamLane(lane)) {
      const serverId = laneByTitle.get((lane.data.title || '').trim().toLocaleLowerCase());
      if (serverId) next = { ...lane, id: teamLaneId(boardId, serverId) };
    }
    const children = fixItems(next.children);
    return children === next.children ? next : { ...next, children };
  });

  return {
    ...board,
    children: lanes,
    data: { ...board.data, archive: fixItems(board.data.archive || []) },
  };
}
