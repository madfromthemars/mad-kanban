import moment from 'moment';
import { App, Modal, Notice, Platform } from 'obsidian';
import { render } from 'preact/compat';
import { useCallback, useEffect, useMemo, useState } from 'preact/compat';
import { Icon } from 'src/components/Icon/Icon';
import { c } from 'src/components/helpers';

import type { BoardProgress, ProgressCard, TrashedCard } from '../TeamClient';
import type { TeamManager } from '../TeamManager';
import { TeamBoardMeta } from '../types';
import { hueFor, initials } from './TeamBadges';

const DAY = 24 * 60 * 60 * 1000;

type Period = 'week' | 'month' | '30d' | 'all';
const PERIODS: Array<[Period, string]> = [
  ['week', 'This week'],
  ['month', 'This month'],
  ['30d', 'Last 30 days'],
  ['all', 'All time'],
];

function periodStart(p: Period, now: number) {
  const m = moment(now);
  if (p === 'week') return m.clone().startOf('isoWeek').valueOf();
  if (p === 'month') return m.clone().startOf('month').valueOf();
  if (p === '30d') return now - 30 * DAY;
  return 0;
}

const isBacklog = (c: ProgressCard) => c.laneKey === 'backlog';
/** Open = agreed work: not finished, not parked in the Backlog. */
const isOpen = (c: ProgressCard) => !c.finished && !isBacklog(c);
const today = () => moment().format('YYYY-MM-DD');
const isOverdue = (c: ProgressCard) => isOpen(c) && !!c.due && c.due < today();

function fmtDays(ms: number) {
  const d = ms / DAY;
  if (d < 1) return `${Math.max(1, Math.round(d * 24))} h`;
  return `${d < 10 ? d.toFixed(1).replace(/\.0$/, '') : Math.round(d)} d`;
}

function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function Avatar({ team, id }: { team: TeamManager; id: string }) {
  const name = team.userName(id);
  return (
    <span className={c('assignee')} style={{ '--assignee-hue': hueFor(id) }} title={name}>
      {initials(name)}
    </span>
  );
}

function ProjectDot({ team, id }: { team: TeamManager; id: string | null }) {
  const p = team.project(id);
  if (!p) return null;
  return (
    <span className={c('pg-project')} title={p.name}>
      <span className={c('project-dot')} style={{ background: p.color }} />
      {p.name}
    </span>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: string }) {
  return (
    <div className={`${c('pg-stat')} ${tone ? `is-${tone}` : ''}`}>
      <div className={c('pg-stat-value')}>{value}</div>
      <div className={c('pg-stat-label')}>{label}</div>
      {sub && <div className={c('pg-stat-sub')}>{sub}</div>}
    </div>
  );
}

/** Finished cards per week, last 8 weeks. */
function WeekBars({ cards, now }: { cards: ProgressCard[]; now: number }) {
  const weeks = useMemo(() => {
    const start = moment(now).startOf('isoWeek');
    return Array.from({ length: 8 }, (_, i) => {
      const from = start.clone().subtract(7 - i, 'weeks');
      const to = from.clone().add(1, 'week');
      const n = cards.filter((c) => c.doneAt != null && c.doneAt >= from.valueOf() && c.doneAt < to.valueOf()).length;
      const short = Platform.isPhone;
      return { label: i === 7 ? (short ? 'Now' : 'This week') : from.format(short ? 'D.MM' : 'D MMM'), n };
    });
  }, [cards, now]);
  const max = Math.max(1, ...weeks.map((w) => w.n));
  return (
    <div className={c('pg-bars')}>
      {weeks.map((w, i) => (
        <div key={i} className={c('pg-bar-col')} title={`${w.n} finished`}>
          <div className={c('pg-bar-n')}>{w.n || ''}</div>
          <div className={c('pg-bar-track')}>
            <div className={`${c('pg-bar')} ${i === 7 ? 'is-current' : ''}`} style={{ height: `${(w.n / max) * 100}%` }} />
          </div>
          <div className={c('pg-bar-label')}>{w.label}</div>
        </div>
      ))}
    </div>
  );
}

function Overview({ team, data, period }: { team: TeamManager; data: BoardProgress; period: Period }) {
  const start = periodStart(period, data.now);
  const finished = data.cards.filter((c) => c.doneAt != null && c.doneAt >= start);
  const open = data.cards.filter(isOpen);
  const doing = open.filter((c) => c.laneKey === 'inprogress');
  const overdue = open.filter(isOverdue);
  const backlog = data.cards.filter(isBacklog);
  const planned = new Set((data.pulled || []).filter((e) => e.ts >= start).map((e) => e.cardId)).size;
  const took = median(finished.filter((c) => !c.doneEstimated && c.doneAt).map((c) => c.doneAt! - c.createdAt));

  // People: everyone with a card, plus everyone on the team.
  const people = useMemo(() => {
    const ids = new Set<string>(team.users.map((u) => u.id));
    for (const c of data.cards) c.assignees.forEach((a) => ids.add(a));
    const rows = [...ids].map((id) => {
      const mine = data.cards.filter((c) => c.assignees.includes(id));
      return {
        id,
        name: team.userName(id),
        finished: mine.filter((c) => c.doneAt != null && c.doneAt >= start).length,
        doing: mine.filter((c) => isOpen(c) && c.laneKey === 'inprogress').length,
        todo: mine.filter((c) => isOpen(c) && c.laneKey !== 'inprogress').length,
        overdue: mine.filter(isOverdue).length,
      };
    });
    const none = data.cards.filter((c) => !c.assignees.length);
    rows.push({
      id: '',
      name: 'Nobody assigned',
      finished: none.filter((c) => c.doneAt != null && c.doneAt >= start).length,
      doing: none.filter((c) => isOpen(c) && c.laneKey === 'inprogress').length,
      todo: none.filter((c) => isOpen(c) && c.laneKey !== 'inprogress').length,
      overdue: none.filter(isOverdue).length,
    });
    return rows
      .filter((r) => r.finished + r.doing + r.todo > 0)
      .sort((a, b) => b.finished - a.finished || b.doing - a.doing || a.name.localeCompare(b.name));
  }, [data, start, team]);

  const projects = useMemo(() => {
    const ids = [...new Set(data.cards.map((c) => c.projectId))];
    return ids
      .map((id) => {
        const mine = data.cards.filter((c) => c.projectId === id);
        return {
          id,
          name: team.project(id)?.name || 'No project',
          finished: mine.filter((c) => c.doneAt != null && c.doneAt >= start).length,
          open: mine.filter(isOpen).length,
          overdue: mine.filter(isOverdue).length,
        };
      })
      .filter((p) => p.finished + p.open > 0)
      .sort((a, b) => b.finished - a.finished || b.open - a.open);
  }, [data, start, team]);

  const recent = [...finished].sort((a, b) => b.doneAt! - a.doneAt!).slice(0, 20);
  const anyEstimated = finished.some((c) => c.doneEstimated);

  return (
    <div className={c('pg-overview')}>
      <div className={c('pg-stats')}>
        <Stat label="Finished" value={finished.length} tone="good" sub={PERIODS.find((p) => p[0] === period)?.[1]} />
        <Stat label="In progress" value={doing.length} />
        <Stat label="Still open" value={open.length} sub="To Do + In Progress" />
        <Stat label="Overdue" value={overdue.length} tone={overdue.length ? 'bad' : undefined} />
        <Stat label="Backlog" value={backlog.length} sub={data.pulled ? `${planned} planned from it` : 'ideas and later'} />
        <Stat label="Typical time to finish" value={took != null ? fmtDays(took) : '—'} sub="created → done" />
      </div>

      <h4 className={c('pg-h')}>Finished per week</h4>
      <WeekBars cards={data.cards} now={data.now} />

      <h4 className={c('pg-h')}>People</h4>
      <table className={c('pg-table')}>
        <thead>
          <tr>
            <th />
            <th>Finished</th>
            <th>In progress</th>
            <th>To do</th>
            <th>Overdue</th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.id || 'none'}>
              <td className={c('pg-who')}>
                {p.id ? <Avatar team={team} id={p.id} /> : <span className={c('pg-none')}>–</span>}
                <span>{p.name}</span>
              </td>
              <td className={c('pg-num')}>{p.finished || ''}</td>
              <td className={c('pg-num')}>{p.doing || ''}</td>
              <td className={c('pg-num')}>{p.todo || ''}</td>
              <td className={`${c('pg-num')} ${p.overdue ? 'is-bad' : ''}`}>{p.overdue || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {projects.length > 1 && (
        <>
          <h4 className={c('pg-h')}>Projects</h4>
          <table className={c('pg-table')}>
            <thead>
              <tr>
                <th />
                <th>Finished</th>
                <th>Open</th>
                <th>Overdue</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id || 'none'}>
                  <td className={c('pg-who')}>
                    {p.id ? <ProjectDot team={team} id={p.id} /> : <span>{p.name}</span>}
                  </td>
                  <td className={c('pg-num')}>{p.finished || ''}</td>
                  <td className={c('pg-num')}>{p.open || ''}</td>
                  <td className={`${c('pg-num')} ${p.overdue ? 'is-bad' : ''}`}>{p.overdue || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h4 className={c('pg-h')}>Finished {PERIODS.find((p) => p[0] === period)?.[1].toLowerCase()}</h4>
      {recent.length ? (
        <div className={c('pg-list')}>
          {recent.map((card) => (
            <div key={card.id} className={c('pg-row')}>
              <Icon name="lucide-check-circle-2" className={c('pg-done-icon')} />
              <span className={c('pg-title')}>{card.title}</span>
              <span className={c('pg-avatars')}>
                {card.assignees.map((a) => (
                  <Avatar key={a} team={team} id={a} />
                ))}
              </span>
              <span className={c('pg-date')} title={card.doneEstimated ? 'Finished before tracking started: date is a guess' : moment(card.doneAt!).format('LLL')}>
                {card.doneEstimated ? '~' : ''}
                {moment(card.doneAt!).format('D MMM')}
              </span>
            </div>
          ))}
          {finished.length > recent.length && (
            <div className={c('pg-muted')}>and {finished.length - recent.length} more</div>
          )}
        </div>
      ) : (
        <div className={c('pg-muted')}>Nothing finished in this period yet.</div>
      )}

      {(anyEstimated || data.trackingSince > 0) && (
        <div className={c('pg-foot')}>
          Exact finish dates are recorded since {moment(data.trackingSince).format('D MMM YYYY')}. Dates marked ~ are
          guesses for cards finished before that.
        </div>
      )}
    </div>
  );
}

function Trash({ team, boardId, onChanged }: { team: TeamManager; boardId: string; onChanged: () => void }) {
  const [items, setItems] = useState<TrashedCard[] | null>(null);
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    team.client
      .trash(boardId)
      .then((r) => {
        setItems(r.cards);
        setDays(r.days);
      })
      .catch((e: any) => new Notice(`Kanban: could not load the Trash (${e?.message || e})`));
  }, [team, boardId]);
  useEffect(load, [load]);

  if (!items) return <div className={c('pg-muted')}>Loading…</div>;
  return (
    <div className={c('pg-trash')}>
      <div className={c('pg-foot')}>
        Deleted cards stay here for {days} days, with their comments, then they're gone for good. Restore puts a card
        back in its list.
      </div>
      {items.length === 0 ? (
        <div className={c('pg-empty')}>
          <Icon name="lucide-trash-2" />
          The Trash is empty.
        </div>
      ) : (
        <div className={c('pg-list')}>
          {items.map((t) => (
            <div key={t.id} className={c('pg-row')}>
              <span className={c('pg-title')}>
                {t.title}
                <span className={c('pg-sub')}>
                  {t.lane ? `from ${t.lane} · ` : ''}deleted by {t.deletedByName || 'someone'} {moment(t.deletedAt).fromNow()}
                  {t.commentCount ? ` · ${t.commentCount} comment${t.commentCount === 1 ? '' : 's'}` : ''} · gone in{' '}
                  {Math.max(1, Math.ceil((t.purgeAt - Date.now()) / DAY))} days
                </span>
              </span>
              <button
                disabled={busy === t.id}
                onClick={async () => {
                  setBusy(t.id);
                  try {
                    await team.client.restoreFromTrash(boardId, t.id);
                    new Notice(`Kanban: restored "${t.title}"`);
                    team.mirrors.forEach((m) => m.requestRefresh(0));
                    load();
                    onChanged();
                  } catch (e: any) {
                    new Notice(`Kanban: could not restore (${e?.message || e})`);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                <Icon name="lucide-undo-2" /> Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Progress({ team, initialBoardId, initialTab }: { team: TeamManager; initialBoardId: string | null; initialTab: 'overview' | 'trash' }) {
  const [boards, setBoards] = useState<TeamBoardMeta[] | null>(null);
  const [boardId, setBoardId] = useState<string | null>(initialBoardId);
  const [tab, setTab] = useState(initialTab);
  const [period, setPeriod] = useState<Period>('week');
  const [data, setData] = useState<BoardProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    team.client
      .boards()
      .then((bs) => {
        setBoards(bs);
        if (!boardId && bs.length) setBoardId(bs[0].id);
      })
      .catch((e: any) => setError(e?.message || String(e)));
  }, [team]);

  const load = useCallback(() => {
    if (!boardId) return;
    team.client
      .boardProgress(boardId)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: any) => setError(e?.message || String(e)));
  }, [team, boardId]);
  useEffect(load, [load]);

  if (error) return <div className={c('mt-error')}>Could not load progress: {error}</div>;
  if (!boardId || !data) return <div className={c('pg-muted')}>Loading…</div>;

  return (
    <div className={c('progress')}>
      <div className={c('pg-top')}>
        <div className={c('mt-tabs')}>
          <button className={tab === 'overview' ? 'is-active' : ''} onClick={() => setTab('overview')}>
            <Icon name="lucide-bar-chart-3" /> Progress
          </button>
          <button className={tab === 'trash' ? 'is-active' : ''} onClick={() => setTab('trash')}>
            <Icon name="lucide-trash-2" /> Trash {data.trashCount > 0 && <span className={c('mt-count')}>{data.trashCount}</span>}
          </button>
        </div>
        <div className={c('pg-controls')}>
          {boards && boards.length > 1 && (
            <select className="dropdown" value={boardId} onChange={(e) => setBoardId((e.target as HTMLSelectElement).value)}>
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          {tab === 'overview' && (
            <select className="dropdown" value={period} onChange={(e) => setPeriod((e.target as HTMLSelectElement).value as Period)}>
              {PERIODS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      {tab === 'overview' ? (
        <Overview team={team} data={data} period={period} />
      ) : (
        <Trash team={team} boardId={boardId} onChanged={load} />
      )}
    </div>
  );
}

export class ProgressModal extends Modal {
  constructor(
    app: App,
    private team: TeamManager,
    private boardId: string | null,
    private tab: 'overview' | 'trash' = 'overview'
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass('kanban-plugin__progress-modal');
    this.titleEl.setText('Team progress');
    render(<Progress team={this.team} initialBoardId={this.boardId} initialTab={this.tab} />, this.contentEl);
  }

  onClose() {
    render(null, this.contentEl);
  }
}
