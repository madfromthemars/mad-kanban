import assert from 'node:assert/strict';
import * as Y from 'yjs';

import {
  applyCanvas,
  canvasFromY,
  folderName,
  kindOf,
  merge3,
  parseCanvas,
  replaceCanvas,
  setText,
  splitTeamPath,
} from '../src/team/notes/merge';

let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log('ok -', name);
};

t('setText makes small edits and keeps text equal', () => {
  const d = new Y.Doc();
  const yt = d.getText('content');
  yt.insert(0, 'Hello world\nsecond line');
  const seen: any[] = [];
  yt.observe((e) => seen.push(e.delta));
  setText(yt, 'Hello brave world\nsecond line!');
  assert.equal(yt.toString(), 'Hello brave world\nsecond line!');
  assert.ok(!seen[0].some((d: any) => d.delete > 5), 'no big delete');
});

t('merge3: only my side changed / only theirs / both', () => {
  assert.equal(merge3('a\nb\n', 'a\nb\nmine\n', 'a\nb\n'), 'a\nb\nmine\n');
  assert.equal(merge3('a\nb\n', 'a\nb\n', 'theirs\na\nb\n'), 'theirs\na\nb\n');
  assert.equal(merge3('one\ntwo\nthree\n', 'one\ntwo\nthree\nmine\n', 'theirs\none\ntwo\nthree\n'), 'theirs\none\ntwo\nthree\nmine\n');
});

t('merge3: an old copy (no local change) never removes newer text', () => {
  const base = 'v1\n';
  const theirs = 'v1\nadded later by Bob\n';
  assert.equal(merge3(base, base, theirs), theirs);
});

t('canvas: my changed box goes in, untouched boxes keep their newer shared state', () => {
  const d = new Y.Doc();
  const base = parseCanvas(JSON.stringify({ nodes: [{ id: 'a', x: 0 }, { id: 'b', x: 0 }], edges: [] }))!;
  replaceCanvas(d, base);
  // Bob moved b (shared), I moved a (local file)
  replaceCanvas(d, { nodes: [{ id: 'a', x: 0 }, { id: 'b', x: 99 }], edges: [] });
  applyCanvas(d, base, { nodes: [{ id: 'a', x: 5 }, { id: 'b', x: 0 }], edges: [] });
  assert.deepEqual(canvasFromY(d).nodes, [{ id: 'a', x: 5 }, { id: 'b', x: 99 }]);
});

t('canvas: deleting a box here deletes it; no base = never deletes', () => {
  const d = new Y.Doc();
  const base = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }] };
  replaceCanvas(d, base);
  applyCanvas(d, base, { nodes: [{ id: 'a' }], edges: [] });
  assert.deepEqual(canvasFromY(d), { nodes: [{ id: 'a' }], edges: [] });
  applyCanvas(d, null, { nodes: [{ id: 'z' }], edges: [] });
  assert.deepEqual(canvasFromY(d).nodes.map((x) => x.id).sort(), ['a', 'z']);
});

t('canvas: deleting one box does not overwrite newer changes to the boxes after it', () => {
  const d = new Y.Doc();
  const base = { nodes: [{ id: 'a' }, { id: 'b', x: 0 }, { id: 'c', x: 0 }], edges: [] };
  replaceCanvas(d, base);
  replaceCanvas(d, { nodes: [{ id: 'a' }, { id: 'b', x: 7 }, { id: 'c', x: 8 }], edges: [] }); // Bob moved b, c
  applyCanvas(d, base, { nodes: [{ id: 'b', x: 0 }, { id: 'c', x: 0 }], edges: [] }); // I deleted a
  assert.deepEqual(canvasFromY(d).nodes, [{ id: 'b', x: 7 }, { id: 'c', x: 8 }]);
});

t('paths and names', () => {
  assert.equal(folderName('Cat: alog?'), 'Cat- alog-');
  assert.equal(folderName('...'), 'Project');
  assert.equal(kindOf('A/b.MD'), 'md');
  assert.equal(kindOf('x.canvas'), 'canvas');
  assert.equal(kindOf('p.png'), 'file');
  assert.deepEqual(splitTeamPath('Team', 'Team/catalog/Plans/a.md'), { folder: 'catalog', rel: 'Plans/a.md' });
  assert.equal(splitTeamPath('Team', 'Team/a.md'), null);
  assert.equal(splitTeamPath('Team', 'Other/catalog/a.md'), null);
  assert.equal(parseCanvas('not json'), null);
});

console.log(`${n} notes merge tests passed`);
