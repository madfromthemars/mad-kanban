import { TagColor } from './components/types';

/** Merge two tag-color lists. Entries in `over` replace same-tag entries in `base`. */
export function mergeTagColors(base: TagColor[] | null | undefined, over: TagColor[] | null | undefined): TagColor[] {
  const out = new Map<string, TagColor>();
  for (const t of base || []) if (t?.tagKey) out.set(t.tagKey, t);
  for (const t of over || []) if (t?.tagKey) out.set(t.tagKey, t);
  return [...out.values()];
}

/** Add only tags that `base` doesn't color yet. */
export function addMissingTagColors(base: TagColor[] | null | undefined, extra: TagColor[] | null | undefined) {
  const have = new Set((base || []).map((t) => t?.tagKey));
  const added: TagColor[] = [];
  for (const t of extra || []) {
    if (!t?.tagKey || have.has(t.tagKey)) continue;
    have.add(t.tagKey);
    added.push(t);
  }
  return { list: [...(base || []), ...added], added };
}

export function sameTagColor(a: TagColor | undefined, b: TagColor | undefined) {
  return !!a && !!b && a.color === b.color && a.backgroundColor === b.backgroundColor;
}

export function byTag(list: TagColor[] | null | undefined) {
  const m = new Map<string, TagColor>();
  for (const t of list || []) if (t?.tagKey) m.set(t.tagKey, t);
  return m;
}

/** Board settings that are personal (view state) and never shared on team boards. */
export const PERSONAL_SETTING_KEYS = new Set([
  'list-collapse',
  'kanban-plugin',
  'table-sizing',
  'lane-width',
  'full-list-lane-width',
]);

/** Extract the settings JSON from a board file's `%% kanban:settings` block. */
export function readSettingsBlock(md: string): Record<string, any> | null {
  const m = /%% kanban:settings\s*\n```\s*\n([\s\S]*?)\n```\s*\n?%%/.exec(md);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}
