import { buildCardIndex, cardRefTitle, findCardRefs, rankCards, referencedBy } from '../src/cardRefs';

let fails = 0;
const ok = (c: any, m: string) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const item = (id: string, titleRaw: string, blockId?: string) => ({ id, type: 'item', children: [], data: { blockId, titleRaw } }) as any;
const lane = (title: string, children: any[]) => ({ id: 'l-' + title, children, data: { title } }) as any;

const board = {
  id: 'b',
  children: [
    lane('To Do', [
      item('team:B:fix0000001', 'Fix login @{2026-11-01} [priority:: 0]\nwaits on @api0000002 and @Bekhzod'),
      item('local1', 'Personal thing', 'ab12cd'),
    ]),
    lane('In Progress', [item('team:B:api0000002', 'Login API #vidora')]),
    lane('Done', [item('team:B:old0000003', 'Old task, see @api0000002')]),
  ],
  data: { archive: [item('team:B:arc0000004', 'Archived one')] },
} as any;

const idx = buildCardIndex(board);
ok(idx.size === 5, 'index has 5 cards: ' + idx.size);
ok(idx.get('fix0000001')?.title === 'Fix login', 'title strips date + priority: ' + idx.get('fix0000001')?.title);
ok(idx.get('api0000002')?.status === 'inprogress' && idx.get('api0000002')?.title === 'Login API', 'status from lane, tag stripped');
ok(idx.get('ab12cd')?.laneTitle === 'To Do', 'personal block id indexed');
ok(idx.get('arc0000004')?.archived === true && idx.get('arc0000004')?.status === 'archive', 'archive');
ok(buildCardIndex(board) === idx, 'index cached per board state');

const known = (id: string) => idx.has(id);
const refs = (t: string) => findCardRefs(t, known).map((r) => r.id);
ok(JSON.stringify(refs('see @api0000002, and (@ab12cd)')) === '["api0000002","ab12cd"]', 'finds refs with punctuation');
ok(refs('@Bekhzod @everyone hi').length === 0, 'people/words are not refs');
ok(refs('mail me@ab12cd.com').length === 0, 'email not a ref');
ok(refs('@ab12cdx').length === 0, 'longer token is not a ref');
ok(JSON.stringify(refs('gone @zz99zz99zz')) === '["zz99zz99zz"]', 'unknown id-shaped token -> missing chip');
ok(refs('@abcdefghij').length === 0, 'unknown all-letter token stays text');
ok(refs('date @{2026-10-01}').length === 0, 'dates untouched');

const back = referencedBy(board, 'api0000002').map((r) => r.id).sort();
ok(JSON.stringify(back) === '["fix0000001","old0000003"]', 'mentioned in: ' + back);
ok(referencedBy(board, 'fix0000001').length === 0, 'no backrefs');

const r1 = rankCards(idx, 'log', 'fix0000001');
ok(r1[0]?.id === 'api0000002' && !r1.some((r) => r.id === 'fix0000001'), 'rank: title match, self excluded');
ok(rankCards(idx, 'ab1')[0]?.id === 'ab12cd', 'rank: id prefix');
ok(rankCards(idx, '').slice(-1)[0]?.id === 'arc0000004', 'archived last');
ok(cardRefTitle('') === 'Untitled card', 'empty title');

if (fails) process.exit(1); console.log('\nALL OK');
