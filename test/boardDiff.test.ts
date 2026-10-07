// Run: npm run test:team
import { diffMirror, diffTeamBoard } from 'src/team/boardDiff';
import { mirrorLaneId, teamItemId, teamLaneId } from 'src/team/ids';

const B = 'board1';
const item = (id: string, titleRaw: string, checked = false): any => ({
  id: id.startsWith('p') ? id : teamItemId(B, id),
  type: 'item', accepts: ['item'], children: [],
  data: { titleRaw, checked, checkChar: checked ? 'x' : ' ', blockId: id, title: titleRaw, titleSearch: '', titleSearchRaw: '', metadata: {} },
});
const lane = (id: string, title: string, items: any[], extra: any = {}): any => ({
  id: id.startsWith('mirror') ? mirrorLaneId(title) : id.startsWith('p') ? id : teamLaneId(B, id),
  type: 'lane', accepts: ['item'], children: items,
  data: { title, maxItems: 0, shouldMarkItemsComplete: false, ...extra },
});
const board = (lanes: any[], archive: any[] = []): any => ({
  id: 'x', type: 'board', accepts: [], children: lanes,
  data: { archive, settings: {}, frontmatter: {}, isSearching: false, errors: [] },
});
const versions = new Map<string, number>([['c1', 3], ['c2', 1]]);
let failures = 0;
function check(name: string, got: any, expected: any) {
  const g = JSON.stringify(got), e = JSON.stringify(expected);
  if (g === e) console.log('ok  ', name);
  else { failures++; console.log('FAIL', name, '\n  got     ', g, '\n  expected', e); }
}

const c1 = item('c1', 'One'), c2 = item('c2', 'Two'), c3 = item('c3', 'Three');
const base = board([lane('l1', 'To Do', [c1, c2]), lane('l2', 'Done', [c3])]);

check('no change', diffTeamBoard(B, base, base, versions), []);
check('edit content', diffTeamBoard(B, base, board([lane('l1', 'To Do', [item('c1', 'One!'), c2]), lane('l2', 'Done', [c3])]), versions),
  [{ type: 'card.update', id: 'c1', version: 3, content: 'One!', checked: false, checkChar: ' ' }]);
check('move between lanes', diffTeamBoard(B, base, board([lane('l1', 'To Do', [c2]), lane('l2', 'Done', [c3, c1])]), versions),
  [{ type: 'card.move', id: 'c1', laneId: 'l2', index: 1 }]);
check('reorder within lane', diffTeamBoard(B, base, board([lane('l1', 'To Do', [c2, c1]), lane('l2', 'Done', [c3])]), versions),
  [{ type: 'lane.setCards', laneId: 'l1', cardIds: ['c2', 'c1'] }]);
check('create card', diffTeamBoard(B, base, board([lane('l1', 'To Do', [c1, item('c9', 'New'), c2]), lane('l2', 'Done', [c3])]), versions),
  [{ type: 'card.create', id: 'c9', laneId: 'l1', index: 1, content: 'New', checked: false, checkChar: ' ' }]);
check('archive card', diffTeamBoard(B, base, board([lane('l1', 'To Do', [c2]), lane('l2', 'Done', [c3])], [c1]), versions),
  [{ type: 'card.archive', id: 'c1' }]);
check('delete card', diffTeamBoard(B, base, board([lane('l1', 'To Do', [c2]), lane('l2', 'Done', [c3])]), versions),
  [{ type: 'card.delete', id: 'c1' }]);
check('restore from archive', diffTeamBoard(B, board([lane('l1', 'To Do', [c1])], [c2]), board([lane('l1', 'To Do', [c2, c1])]), versions),
  [{ type: 'card.move', id: 'c2', laneId: 'l1', index: 0 }]);
check('new lane with a card: lane created first', diffTeamBoard(B, base, board([lane('l1', 'To Do', [c1, c2]), lane('l2', 'Done', [c3]), lane('l9', 'Later', [item('c9', 'X')])]), versions).map((o) => o.type),
  ['lane.create', 'card.create']);
check('lane update before a new lane still puts creates first', diffTeamBoard(B, base, board([lane('l1', 'Todo', [c1, c2]), lane('l2', 'Done', [c3]), lane('l9', 'Later', [item('c9', 'X')])]), versions).map((o) => o.type),
  ['lane.update', 'lane.create', 'card.create']);

const me = 'u1';
const p1 = item('p1', 'Mine');
const m1 = item('c1', 'Team card');
const pbase = board([lane('pl1', 'To Do', [p1, m1]), lane('pl2', 'Doing', [])]);
check('mirror: move to Doing', [...diffMirror(pbase, board([lane('pl1', 'To Do', [p1]), lane('pl2', 'Doing', [m1])]), me, versions).byBoard],
  [[B, [{ type: 'card.move', id: 'c1', laneTitle: 'Doing', index: -1 }]]]);
check('mirror: removed = unassign me', [...diffMirror(pbase, board([lane('pl1', 'To Do', [p1]), lane('pl2', 'Doing', [])]), me, versions).byBoard],
  [[B, [{ type: 'card.assign', id: 'c1', userId: 'u1', assigned: false }]]]);
check('mirror: drop into fallback lane is a no-op', [...diffMirror(pbase, board([lane('pl1', 'To Do', [p1]), lane('mirror', 'Team', [m1])]), me, versions).byBoard], []);

console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
process.exit(failures ? 1 : 0);
