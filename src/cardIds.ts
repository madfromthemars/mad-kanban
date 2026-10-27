import { Board, Item } from './components/types';
import { isTeamItem } from './team/ids';

/**
 * Personal boards: give every card an Obsidian block id (`^abc123`) if it has none,
 * so each card has a stable id (shown in the card window, linkable as `[[board#^id]]`).
 * Team cards already carry their server id and are left alone.
 * Returns the same board object when nothing had to change.
 */
export function ensureCardIds(board: Board): Board {
  if (!board?.children) return board;

  const used = new Set<string>();
  const collect = (it: Item) => it.data?.blockId && used.add(it.data.blockId);
  board.children.forEach((l) => l.children.forEach(collect));
  board.data?.archive?.forEach(collect);

  const gen = () => Math.random().toString(36).slice(2, 8);
  const fresh = () => {
    let id = gen();
    while (id.length < 6 || used.has(id)) id = gen();
    used.add(id);
    return id;
  };

  const fix = (it: Item): Item =>
    it.data?.blockId || isTeamItem(it) ? it : { ...it, data: { ...it.data, blockId: fresh() } };

  let changed = false;
  const children = board.children.map((lane) => {
    const items = lane.children.map(fix);
    if (items.some((it, i) => it !== lane.children[i])) {
      changed = true;
      return { ...lane, children: items };
    }
    return lane;
  });

  const archive = board.data?.archive?.map(fix);
  const archiveChanged = !!archive && archive.some((it, i) => it !== board.data.archive[i]);

  if (!changed && !archiveChanged) return board;
  return {
    ...board,
    children,
    data: archiveChanged ? { ...board.data, archive } : board.data,
  };
}
