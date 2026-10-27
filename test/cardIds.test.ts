import { ensureCardIds } from '../src/cardIds';

let fails = 0;
const ok = (c: any, m: string) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const item = (id: string, blockId?: string) => ({ id, type: 'item', children: [], data: { blockId, titleRaw: id } }) as any;
const board = (lanes: any[][], archive: any[] = []) =>
  ({ id: 'b', children: lanes.map((c, i) => ({ id: 'l' + i, children: c, data: {} })), data: { archive } }) as any;

const b1 = board([[item('a', 'keep01'), item('b')], [item('team:B1:c1')]], [item('z')]);
const r1 = ensureCardIds(b1);
const all = [...r1.children.flatMap((l: any) => l.children), ...r1.data.archive];
ok(all[0].data.blockId === 'keep01', 'existing id kept');
ok(/^[a-z0-9]{6}$/.test(all[1].data.blockId), 'missing id generated: ' + all[1].data.blockId);
ok(all[2].data.blockId === undefined, 'team item untouched');
ok(/^[a-z0-9]{6}$/.test(all[3].data.blockId), 'archive item gets id');
ok(r1.children[0].children[0] === b1.children[0].children[0], 'unchanged item keeps identity');
ok(r1.children[1] === b1.children[1], 'unchanged lane keeps identity');
ok(ensureCardIds(r1) === r1, 'second pass is a no-op (same object)');
const many = ensureCardIds(board([Array.from({ length: 500 }, (_, i) => item('x' + i))]));
ok(new Set(many.children[0].children.map((i: any) => i.data.blockId)).size === 500, '500 unique ids');
if (fails) process.exit(1); console.log('\nALL OK');
