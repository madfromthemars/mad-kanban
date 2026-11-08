import { moment } from 'obsidian';
import { useState } from 'preact/compat';

import { Icon } from './Icon/Icon';
import { c } from './helpers';

/**
 * Phone due date picker: quick picks and a month calendar (no native date input).
 * Calls onPick with YYYY-MM-DD, or null to remove the date.
 */
export function PhoneCalendar({ value, onPick }: { value: moment.Moment | null; onPick: (iso: string | null) => void }) {
  const today = moment().startOf('day');
  const [month, setMonth] = useState(() => (value?.isValid?.() ? value.clone() : today.clone()).startOf('month'));
  const selected = value?.isValid?.() ? value.format('YYYY-MM-DD') : null;

  const quick = [
    { label: 'Today', date: today.clone() },
    { label: 'Tomorrow', date: today.clone().add(1, 'day') },
    { label: 'In a week', date: today.clone().add(1, 'week') },
  ];

  // Weeks start on Monday.
  const first = month.clone().startOf('isoWeek');
  const days: moment.Moment[] = [];
  for (let d = first.clone(); days.length < 42; d.add(1, 'day')) days.push(d.clone());
  const rows = days[35].month() !== month.month() && days[28].month() !== month.month() ? 4 : days[35].month() !== month.month() ? 5 : 6;

  return (
    <div className={c('cal')}>
      <div className={c('cal-quick')}>
        {quick.map((q) => (
          <button
            key={q.label}
            className={`${c('cal-quick-btn')} ${selected === q.date.format('YYYY-MM-DD') ? 'is-on' : ''}`}
            onClick={() => onPick(q.date.format('YYYY-MM-DD'))}
          >
            {q.label}
            <span>{q.date.format('ddd D')}</span>
          </button>
        ))}
      </div>
      <div className={c('cal-head')}>
        <button className={c('cal-nav')} aria-label="Previous month" onClick={() => setMonth(month.clone().subtract(1, 'month'))}>
          <Icon name="lucide-chevron-left" />
        </button>
        <span className={c('cal-month')}>{month.format('MMMM YYYY')}</span>
        <button className={c('cal-nav')} aria-label="Next month" onClick={() => setMonth(month.clone().add(1, 'month'))}>
          <Icon name="lucide-chevron-right" />
        </button>
      </div>
      <div className={c('cal-grid')}>
        {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => (
          <span key={d} className={c('cal-dow')}>
            {d}
          </span>
        ))}
        {days.slice(0, rows * 7).map((d) => {
          const iso = d.format('YYYY-MM-DD');
          return (
            <button
              key={iso}
              className={[
                c('cal-day'),
                d.month() !== month.month() ? 'is-other' : '',
                d.isSame(today, 'day') ? 'is-today' : '',
                iso === selected ? 'is-on' : '',
              ].join(' ')}
              onClick={() => onPick(iso)}
            >
              {d.date()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
