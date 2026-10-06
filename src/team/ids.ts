import { Item, Lane } from 'src/components/types';

import { laneKey } from './laneKey';

/**
 * Team entities carry stable, server-issued ids inside the local entity id:
 *   item.id = "team:<boardId>:<cardId>"
 *   lane.id = "teamlane:<boardId>:<laneId>"
 * This survives immutable updates, content re-parses and drag/drop, and lets a
 * personal board tell mirrored team cards apart from its own cards.
 */
const ITEM_PREFIX = 'team:';
const LANE_PREFIX = 'teamlane:';
const MIRROR_LANE_PREFIX = 'teammirrorlane:';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newTeamId(len = 10) {
  let out = '';
  const bytes = new Uint8Array(len);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function teamItemId(boardId: string, cardId: string) {
  return `${ITEM_PREFIX}${boardId}:${cardId}`;
}

export function teamLaneId(boardId: string, laneId: string) {
  return `${LANE_PREFIX}${boardId}:${laneId}`;
}

export function mirrorLaneId(title: string) {
  return `${MIRROR_LANE_PREFIX}${title}`;
}

export function isTeamItem(item: Pick<Item, 'id'> | null | undefined): boolean {
  return !!item && typeof item.id === 'string' && item.id.startsWith(ITEM_PREFIX);
}

export function isTeamLane(lane: Pick<Lane, 'id'> | null | undefined): boolean {
  return !!lane && typeof lane.id === 'string' && lane.id.startsWith(LANE_PREFIX);
}

export function isMirrorLane(lane: Pick<Lane, 'id'> | null | undefined): boolean {
  return !!lane && typeof lane.id === 'string' && lane.id.startsWith(MIRROR_LANE_PREFIX);
}

export function parseTeamItemId(id: string): { boardId: string; cardId: string } | null {
  if (!id || !id.startsWith(ITEM_PREFIX)) return null;
  const rest = id.slice(ITEM_PREFIX.length);
  const idx = rest.indexOf(':');
  if (idx <= 0) return null;
  return { boardId: rest.slice(0, idx), cardId: rest.slice(idx + 1) };
}

export function parseTeamLaneId(id: string): { boardId: string; laneId: string } | null {
  if (!id || !id.startsWith(LANE_PREFIX)) return null;
  const rest = id.slice(LANE_PREFIX.length);
  const idx = rest.indexOf(':');
  if (idx <= 0) return null;
  return { boardId: rest.slice(0, idx), laneId: rest.slice(idx + 1) };
}

/** Canonical list key used to match team lists to personal lists (see laneKey.ts). */
export function normalizeLaneTitle(title: string) {
  return laneKey(title || '');
}

/** Drop mirrored team items (and mirror lanes) from a board. Used before a personal board is saved. */
export function stripMirrorEntities<B extends { children: Lane[] }>(board: B): B {
  let changed = false;
  const lanes: Lane[] = [];
  for (const lane of board.children) {
    const children = lane.children.filter((i) => !isTeamItem(i));
    if (children.length !== lane.children.length) changed = true;
    if (isMirrorLane(lane) && children.length === 0) {
      changed = true;
      continue;
    }
    lanes.push(children.length === lane.children.length ? lane : { ...lane, children });
  }
  return changed ? { ...board, children: lanes } : board;
}
