import { formatDuration, getEstimate, parseDuration, setEstimateInTitle, workMs } from '../src/estimate';

let fails = 0;
const ok = (c: any, m: string) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const H = 3600e3;

ok(parseDuration('2h') === 2 * H, '2h');
ok(parseDuration('1d 4h') === 28 * H, '1d 4h');
ok(parseDuration('90m') === 1.5 * H, '90m');
ok(parseDuration('nope') === null, 'not a duration');
ok(formatDuration(3 * H + 20 * 60e3) === '3h 20m', 'format 3h 20m');
ok(formatDuration(52 * H) === '2d 4h', 'format 2d 4h');
ok(getEstimate('Fix [estimate:: 3h] [priority:: 1]')?.ms === 3 * H, 'read from first line');
ok(setEstimateInTitle('Fix login ^abc123\nbody', '2h') === 'Fix login [estimate:: 2h] ^abc123\nbody', 'set keeps block id last');
ok(setEstimateInTitle('Fix [estimate:: 2h] [priority:: 1]', '1d') === 'Fix [priority:: 1] [estimate:: 1d]', 'replace');
ok(setEstimateInTitle('Fix [estimate:: 2h]', null) === 'Fix', 'clear');
ok(workMs({ workMs: H, workSince: 1000 }, 1000 + H) === 2 * H, 'running clock adds up');
ok(workMs(null) === 0, 'no card');

if (fails) { console.error(`${fails} estimate tests failed`); process.exit(1); }
console.log('estimate tests passed');
