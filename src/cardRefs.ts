/**
 * Card references: `@<cardId>` inside a card's text (title, description, checklist) or a
 * comment points at another card. Ids are the server card id on team boards and the
 * Obsidian block id (`^abc123`) on personal boards; both are lowercase [a-z0-9].
 *
 * People mentions use the same `@`, but only match a teammate's *name*; a card ref only
 * matches an existing card id (or, to show "card not found", an id-shaped token with a digit).
 *
 * Pure module (no Obsidian imports) so it can be unit-tested.
 */
import { Board, Item } from './components/types';
import { laneKey } from './team/laneKey';

export type CardRefStatus = 'todo' | 'inprogress' | 'review' | 'done' | 'backlog' | 'archive' | 'other';

export interface CardRefInfo {
  /** The id written after `@`. */
  id: string;
  title: string;
  laneTitle: string;
  status: CardRefStatus;
  archived: boolean;
  /** Local entity id of the item (to find it on the board). */
  itemId: string;
}

const STATUS_KEYS = new Set(['todo', 'inprogress', 'review', 'done', 'backlog', 'archive']);
const TEAM_ITEM_PREFIX = 'team:';

/** The id other cards use to reference this one (`@<id>`), or null. */
export function cardRefId(item: Item): string | null {
  if (item?.id?.startsWith(TEAM_ITEM_PREFIX)) {
    const rest = item.id.slice(TEAM_ITEM_PREFIX.length);
    const i = rest.indexOf(':');
    if (i > 0) return rest.slice(i + 1);
  }
  return item?.data?.blockId || null;
}

/** First line of a card, without the inline metadata the board shows elsewhere. */
export function cardRefTitle(titleRaw: string): string {
  const first = String(titleRaw || '').split(/\r?\n/)[0] || '';
  const t = first
    .replace(/\s\^[a-z0-9-]+\s*$/i, '') // block id
    .replace(/\[[\w-]+::[^\]]*\]/g, '') // [priority:: 1]
    .replace(/@\{[^}]*\}|@@\{[^}]*\}|@\[\[[^\]]*\]\]/g, '') // dates / times
    .replace(/(^|\s)#[^\s#]+/g, '$1') // tags
    .replace(/\s+/g, ' ')
    .trim();
  return t || 'Untitled card';
}

function statusOf(laneTitle: string, archived: boolean): CardRefStatus {
  if (archived) return 'archive';
  const key = laneKey(laneTitle || '');
  return (STATUS_KEYS.has(key) ? key : 'other') as CardRefStatus;
}

const indexCache = new WeakMap<Board, Map<string, CardRefInfo>>();

/** Every card of the board (and its archive) by reference id. Cached per board state. */
export function buildCardIndex(board: Board | null | undefined): Map<string, CardRefInfo> {
  if (!board?.children) return new Map();
  const cached = indexCache.get(board);
  if (cached) return cached;
  const map = new Map<string, CardRefInfo>();
  const add = (item: Item, laneTitle: string, archived: boolean) => {
    const id = cardRefId(item);
    if (!id || map.has(id)) return;
    map.set(id, {
      id,
      title: cardRefTitle(item.data?.titleRaw),
      laneTitle: archived ? 'Archive' : laneTitle,
      status: statusOf(laneTitle, archived),
      archived,
      itemId: item.id,
    });
  };
  for (const lane of board.children) for (const item of lane.children) add(item, lane.data?.title || '', false);
  for (const item of board.data?.archive || []) add(item, 'Archive', true);
  indexCache.set(board, map);
  return map;
}

const BEFORE_OK = /[\s([{"'«>*_~]/;
const ID_CHARS = /[a-z0-9]/;
const AFTER_STOP = /[\p{L}\p{N}_]/u;

export interface CardRefMatch {
  start: number; // index of '@'
  end: number; // index after the id
  id: string;
}

/** Looks like an id we issue: 6 (personal) or 10 (team) chars with at least one digit. */
export function looksLikeCardId(id: string) {
  return (id.length === 6 || id.length === 10) && /\d/.test(id) && /^[a-z0-9]+$/.test(id);
}

/**
 * `@id` references in plain text. `isKnown(id)` says whether a card with that id exists;
 * unknown tokens are only returned when they look like an id (so `@everyone` stays text).
 */
export function findCardRefs(text: string, isKnown: (id: string) => boolean): CardRefMatch[] {
  const out: CardRefMatch[] = [];
  const src = String(text || '');
  for (let i = src.indexOf('@'); i !== -1; i = src.indexOf('@', i + 1)) {
    if (i > 0 && !BEFORE_OK.test(src[i - 1])) continue; // e.g. an email address
    let j = i + 1;
    while (j < src.length && ID_CHARS.test(src[j])) j++;
    if (j === i + 1 || j - i - 1 > 12) continue;
    if (j < src.length && AFTER_STOP.test(src[j])) continue; // "@Bekhzod", "@abc_x"
    const id = src.slice(i + 1, j);
    if (isKnown(id) || looksLikeCardId(id)) out.push({ start: i, end: j, id });
  }
  return out;
}

/** Ids referenced by a piece of text (existing cards only). */
export function refIdsIn(text: string, index: Map<string, CardRefInfo>): Set<string> {
  return new Set(findCardRefs(text, (id) => index.has(id)).filter((m) => index.has(m.id)).map((m) => m.id));
}

/** Cards on the board whose text references `id` ("Mentioned in"). */
export function referencedBy(board: Board | null | undefined, id: string): CardRefInfo[] {
  if (!board?.children || !id) return [];
  const index = buildCardIndex(board);
  const out: CardRefInfo[] = [];
  const check = (item: Item) => {
    const raw = item.data?.titleRaw || '';
    if (!raw.includes('@' + id)) return;
    const own = cardRefId(item);
    if (own === id) return;
    if (!refIdsIn(raw, index).has(id)) return;
    const info = own && index.get(own);
    if (info) out.push(info);
  };
  for (const lane of board.children) lane.children.forEach(check);
  (board.data?.archive || []).forEach(check);
  return out;
}

/** Cards for the `@` picker: title words or id prefix match, current card excluded. */
export function rankCards(index: Map<string, CardRefInfo>, query: string, excludeId?: string | null, limit = 6) {
  const q = query.trim().toLowerCase();
  const scored: { info: CardRefInfo; score: number }[] = [];
  for (const info of index.values()) {
    if (info.id === excludeId) continue;
    const title = info.title.toLowerCase();
    let score = -1;
    if (!q) score = 3;
    else if (info.id === q) score = 0;
    else if (title.startsWith(q)) score = 1;
    else if (title.split(/[\s:—-]+/).some((w) => w.startsWith(q))) score = 2;
    else if (info.id.startsWith(q)) score = 2;
    else if (title.includes(q)) score = 3;
    if (score < 0) continue;
    if (info.archived) score += 2; // live cards first
    scored.push({ info, score });
  }
  scored.sort((a, b) => a.score - b.score || a.info.title.localeCompare(b.info.title));
  return scored.slice(0, limit).map((s) => s.info);
}

/** People for the `@` picker (comments). */
export function rankPeople<T extends { id: string; name: string }>(users: T[], query: string, meId?: string, limit = 4) {
  const q = query.toLowerCase();
  return users
    .map((u) => {
      const name = u.name.toLowerCase();
      const score = !q ? 1 : name.startsWith(q) ? 0 : name.split(/\s+/).some((w) => w.startsWith(q)) ? 1 : name.includes(q) ? 2 : -1;
      return { u, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || Number(a.u.id === meId) - Number(b.u.id === meId) || a.u.name.localeCompare(b.u.name))
    .slice(0, limit)
    .map((x) => x.u);
}

