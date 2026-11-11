// Pure helpers for shared notes: turning file contents into Yjs edits without losing
// anybody's work. No Obsidian imports here (unit-tested in test/notesMerge.test.ts).

import DiffMatchPatch from 'diff-match-patch';
import * as Y from 'yjs';

const dmp = new DiffMatchPatch();
dmp.Diff_Timeout = 1;

/** Change `ytext` into `next` with small edits (keeps other people's cursors in place). */
export function setText(ytext: Y.Text, next: string) {
  const cur = ytext.toString();
  if (cur === next) return;
  const diffs = dmp.diff_main(cur, next);
  dmp.diff_cleanupEfficiency(diffs);
  let pos = 0;
  for (const [op, text] of diffs) {
    if (op === 0) pos += text.length;
    else if (op === -1) ytext.delete(pos, text.length);
    else {
      ytext.insert(pos, text);
      pos += text.length;
    }
  }
}

/**
 * Three-way merge: `base` is what this device last had in sync, `mine` is the file now,
 * `theirs` is the shared text now. Returns the text with my changes applied on top of theirs.
 */
export function merge3(base: string, mine: string, theirs: string): string {
  if (mine === base) return theirs;
  if (theirs === base || theirs === mine) return mine;
  const patches = dmp.patch_make(base, mine);
  const [merged] = dmp.patch_apply(patches, theirs);
  return merged as string;
}

// ---------- canvases ----------
// A canvas is JSON {nodes: [...], edges: [...]}. In Yjs each node/edge is one entry of the
// `nodes` / `edges` map: id -> JSON string {i: position in the list, v: the node}. So two
// people changing different boxes never clash; the same box: last change wins.

export interface CanvasData {
  nodes: any[];
  edges: any[];
  [k: string]: any;
}

export function parseCanvas(text: string): CanvasData | null {
  if (!text.trim()) return { nodes: [], edges: [] };
  try {
    const d = JSON.parse(text);
    if (!d || typeof d !== 'object') return null;
    return { ...d, nodes: Array.isArray(d.nodes) ? d.nodes : [], edges: Array.isArray(d.edges) ? d.edges : [] };
  } catch {
    return null;
  }
}

const entries = (m: Y.Map<string>) =>
  [...m.values()]
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.v);

export function canvasFromY(doc: Y.Doc): CanvasData {
  return { nodes: entries(doc.getMap('nodes')), edges: entries(doc.getMap('edges')) };
}

export function renderCanvas(data: CanvasData) {
  return JSON.stringify({ nodes: data.nodes, edges: data.edges }, null, '\t');
}

const byId = (list: any[]) => new Map(list.filter((x) => x && typeof x.id === 'string').map((x, i) => [x.id, { i, v: x }]));
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Apply the boxes/arrows this device changed (`mine` compared with `base`) to the shared
 * canvas. Boxes this device didn't touch are left as they are in Yjs, so an old copy
 * can't undo other people's work. `base` null = no history: everything in `mine` counts
 * as changed, but nothing is deleted.
 */
export function applyCanvas(doc: Y.Doc, base: CanvasData | null, mine: CanvasData) {
  for (const key of ['nodes', 'edges'] as const) {
    const m = doc.getMap<string>(key);
    const before = byId(base?.[key] ?? []);
    const now = byId(mine[key]);
    for (const [id, { i, v }] of now) {
      const old = before.get(id);
      // Untouched here (a box only shifting in the list because another one was removed
      // doesn't count, or we'd overwrite someone else's newer change to it).
      if (old && same(old.v, v)) continue;
      const s = JSON.stringify({ i, v });
      if (m.get(id) !== s) m.set(id, s);
    }
    if (base) for (const id of before.keys()) if (!now.has(id) && m.has(id)) m.delete(id);
  }
}

/** Rewrite the whole canvas in Yjs to `data` (restoring an old version). */
export function replaceCanvas(doc: Y.Doc, data: CanvasData) {
  for (const key of ['nodes', 'edges'] as const) {
    const m = doc.getMap<string>(key);
    const now = byId(data[key]);
    for (const id of [...m.keys()]) if (!now.has(id)) m.delete(id);
    for (const [id, { i, v }] of now) {
      const s = JSON.stringify({ i, v });
      if (m.get(id) !== s) m.set(id, s);
    }
  }
}

// ---------- paths ----------

/** A project name as a folder name every OS accepts. */
export function folderName(name: string) {
  const s = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  return s || 'Project';
}

export function kindOf(path: string): 'md' | 'canvas' | 'file' {
  const p = path.toLowerCase();
  if (p.endsWith('.md')) return 'md';
  if (p.endsWith('.canvas')) return 'canvas';
  return 'file';
}

/** "Team/catalog/Plans/a.md" -> { folder: "catalog", rel: "Plans/a.md" }, or null outside. */
export function splitTeamPath(root: string, path: string): { folder: string; rel: string } | null {
  if (!path.startsWith(root + '/')) return null;
  const rest = path.slice(root.length + 1);
  const i = rest.indexOf('/');
  if (i <= 0 || i === rest.length - 1) return null;
  return { folder: rest.slice(0, i), rel: rest.slice(i + 1) };
}

/** Files people shouldn't share: hidden ones and OS junk. */
export function ignoredPath(rel: string) {
  // *.mkpass: the per-project Passwords file (team/vault/files.ts), local only, never shared.
  return rel.split('/').some((s) => s.startsWith('.') || s === 'Thumbs.db' || s === 'desktop.ini') || rel.endsWith('.mkpass');
}
