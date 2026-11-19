import { useContext, useEffect, useState } from 'preact/compat';
import { formatDuration, getEstimate, parseDuration, useMinuteTick, workMs } from 'src/estimate';
import { parseTeamItemId } from 'src/team/ids';

import { KanbanContext } from '../context';
import { c } from '../helpers';
import { Item } from '../types';

/** Estimate + real time of a card (real time only on team cards). */
export function useEstimate(item: Item) {
  const { stateManager } = useContext(KanbanContext);
  const team = stateManager.plugin?.team;
  const parsed = parseTeamItemId(item.id);
  const info = team ? team.useCardInfo(parsed?.cardId ?? null) : null;
  const est = getEstimate(item.data.titleRaw);
  const card = info?.card;
  useMinuteTick(card?.workSince != null);
  const spent = workMs(card);
  return { est, spent, running: card?.workSince != null, isTeam: !!parsed };
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/** Board card chip: "⏱ 3h / 2h" (spent / estimate), "⏱ 2h" (estimate only) or spent only. */
export function EstimateChip({ est, spent, running }: { est: { ms: number } | null; spent: number; running: boolean }) {
  if (!est && spent < 60e3) return null;
  const over = !!est && spent > est.ms;
  const text = est ? (spent >= 60e3 ? `${formatDuration(spent)} / ${formatDuration(est.ms)}` : formatDuration(est.ms)) : formatDuration(spent);
  const title = [
    est ? `Estimate: ${formatDuration(est.ms)}` : 'No estimate',
    spent >= 60e3 ? `Real time in progress: ${formatDuration(spent)}${running ? ' (running)' : ''}` : null,
    over ? `Over by ${formatDuration(spent - est.ms)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span className={`${c('estimate-chip')} ${over ? 'is-over' : ''} ${running ? 'is-running' : ''}`} title={title}>
      <ClockIcon />
      {text}
    </span>
  );
}

const QUICK = ['1h', '2h', '4h', '1d', '2d', '1w'];

/** Card window: type or pick an estimate; shows the real time under it. */
export function EstimateField({ item, onChange }: { item: Item; onChange: (value: string | null) => void }) {
  const { est, spent, running, isTeam } = useEstimate(item);
  const [text, setText] = useState(est?.raw || '');
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setText(est?.raw || '');
    setBad(false);
  }, [est?.raw]);
  const commit = (v: string) => {
    const s = v.trim().toLowerCase();
    if (!s) {
      if (est) onChange(null);
      setBad(false);
      return;
    }
    if (!parseDuration(s)) {
      setBad(true);
      return;
    }
    setBad(false);
    if (s !== est?.raw) onChange(s);
  };
  const over = !!est && spent > est.ms;
  return (
    <div className={c('estimate-field')}>
      <input
        className={`${c('estimate-input')} ${bad ? 'is-invalid' : ''}`}
        type="text"
        value={text}
        placeholder="e.g. 2h, 1d 4h"
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        onBlur={(e) => commit((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <div className={c('estimate-quick')}>
        {QUICK.map((q) => (
          <button key={q} className={est?.raw === q ? 'is-active' : ''} onClick={() => onChange(q)}>
            {q}
          </button>
        ))}
        {est && (
          <button className={c('estimate-clear')} onClick={() => onChange(null)} aria-label="Remove estimate">
            Clear
          </button>
        )}
      </div>
      {bad && <div className={c('estimate-hint')}>Use m, h, d or w, like 30m, 2h or 1d 4h.</div>}
      {isTeam && (
        <div className={`${c('estimate-spent')} ${over ? 'is-over' : ''}`}>
          {spent >= 60e3 ? (
            <>
              Real time: <b>{formatDuration(spent)}</b>
              {running ? ' (in progress now)' : ''}
              {over ? ` · ${formatDuration(spent - est.ms)} over` : ''}
            </>
          ) : (
            'Real time starts when the card moves to In Progress.'
          )}
        </div>
      )}
    </div>
  );
}
