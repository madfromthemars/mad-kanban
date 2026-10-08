import { useContext, useMemo, useState } from 'preact/compat';
import useOnclickOutside from 'react-cool-onclickoutside';
import { hueFor, initials } from 'src/team/ui/TeamBadges';

import { Icon } from '../Icon/Icon';
import { PriorityIcon } from '../Item/PriorityIcon';
import { DateFilterType, FilterContext, FilterState, KanbanContext, PriorityFilterType } from '../context';
import {
  c,
  collectItemTagsForFilter,
  dueKeyOf,
  isDueThisWeek,
  itemMatchesFilters,
  priorityKey,
  useGetTagColorFn,
} from '../helpers';
import { Item } from '../types';

interface Option<T extends string> {
  value: T;
  label: string;
  icon?: any;
  count: number;
}

const PRIORITY_OPTIONS: { value: PriorityFilterType; label: string; stored: string | null }[] = [
  { value: 'highest', label: 'Highest', stored: '0' },
  { value: 'high', label: 'High', stored: '1' },
  { value: 'medium', label: 'Medium', stored: '2' },
  { value: 'low', label: 'Low', stored: '4' },
  { value: 'none', label: 'No priority', stored: null },
];

const DATE_OPTIONS: { value: DateFilterType; label: string }[] = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'week', label: 'Due in the next 7 days' },
  { value: 'no-date', label: 'No due date' },
];

function toggle<T>(list: T[], v: T) {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

/** A filter button that opens a checklist of options (multi-select). */
function FilterMenu<T extends string>({
  label,
  icon,
  options,
  selected,
  onChange,
  emptyText,
}: {
  label: string;
  icon: string;
  options: Option<T>[];
  selected: T[];
  onChange: (next: T[]) => void;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOnclickOutside(() => setOpen(false));
  const active = selected.length > 0;
  const names = options.filter((o) => selected.includes(o.value)).map((o) => o.label);
  const summary = names.length ? (names.length <= 2 ? names.join(', ') : `${names[0]} +${names.length - 1}`) : '';

  return (
    <div className={c('filter-menu')} ref={ref}>
      <button
        className={`${c('filter-chip')} ${active ? 'is-active' : ''} ${open ? 'is-open' : ''}`}
        onClick={() => setOpen(!open)}
      >
        <Icon name={icon} />
        <span className={c('filter-chip-label')}>{label}</span>
        {active && <span className={c('filter-chip-value')}>{summary}</span>}
        {active ? (
          <span
            className={c('filter-chip-clear')}
            title={`Clear ${label.toLowerCase()} filter`}
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
          >
            <Icon name="lucide-x" />
          </span>
        ) : (
          <Icon name="lucide-chevron-down" className={c('filter-chip-caret')} />
        )}
      </button>
      {open && (
        <div className={c('filter-popover')}>
          {options.length === 0 && <div className={c('filter-popover-empty')}>{emptyText || 'Nothing to filter'}</div>}
          {options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <div
                key={o.value}
                className={`${c('filter-option')} ${on ? 'is-checked' : ''}`}
                onClick={() => onChange(toggle(selected, o.value))}
              >
                <span className={c('filter-check')}>{on && <Icon name="lucide-check" />}</span>
                {o.icon}
                <span className={c('filter-option-label')}>{o.label}</span>
                <span className={c('filter-option-count')}>{o.count}</span>
              </div>
            );
          })}
          {selected.length > 0 && (
            <div className={c('filter-popover-footer')}>
              <a onClick={() => onChange([])}>Clear</a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One-line filter bar shown in the board toolbar. */
export function QuickFilters() {
  const filterContext = useContext(FilterContext);
  const { stateManager } = useContext(KanbanContext);
  const getTagColor = useGetTagColorFn(stateManager);
  const team = stateManager.plugin?.team;
  const users = team ? team.useUsers() : [];
  const board = stateManager.useState();

  const items = useMemo(() => {
    const all: Item[] = [];
    for (const lane of board?.children || []) all.push(...lane.children);
    return all;
  }, [board]);

  if (!filterContext) return null;
  const { filters, updateFilters, clearFilters, hasActiveFilters, getAssignees, meId } = filterContext;
  const set = (patch: Partial<FilterState>) => updateFilters(patch);

  // Options, each with how many cards on the board it matches.
  const assigneesOf = (i: Item) => getAssignees?.(i) || [];
  const hasTeamCards = !!getAssignees && items.some((i) => getAssignees(i) !== null);
  const people = new Set<string>();
  for (const i of items) for (const id of assigneesOf(i)) people.add(id);

  const assigneeOptions: Option<string>[] = hasTeamCards
    ? [
        ...(meId ? [{ value: 'me', label: 'Me', count: items.filter((i) => assigneesOf(i).includes(meId)).length }] : []),
        ...users
          .filter((u) => people.has(u.id) && u.id !== meId)
          .map((u) => ({
            value: u.id,
            label: u.name,
            icon: (
              <span className={c('assignee')} style={{ '--assignee-hue': hueFor(u.id) }}>
                {initials(u.name)}
              </span>
            ),
            count: items.filter((i) => assigneesOf(i).includes(u.id)).length,
          })),
        { value: 'unassigned', label: 'Unassigned', count: items.filter((i) => assigneesOf(i).length === 0).length },
      ]
    : [];

  const priorityOptions: Option<PriorityFilterType>[] = PRIORITY_OPTIONS.map((p) => ({
    value: p.value,
    label: p.label,
    icon: <PriorityIcon value={p.stored} />,
    count: items.filter((i) => priorityKey(i.data.metadata.priority) === p.value).length,
  }));

  const dateOptions: Option<DateFilterType>[] = DATE_OPTIONS.map((d) => ({
    value: d.value,
    label: d.label,
    count: items.filter((i) => (d.value === 'week' ? isDueThisWeek(i) : dueKeyOf(i) === d.value)).length,
  }));

  const tagCounts = new Map<string, number>();
  for (const i of items) {
    for (const t of collectItemTagsForFilter(i, filterContext.cardBodyCache, filterContext.boardPath)) {
      tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }
  }
  const tagOptions: Option<string>[] = filterContext.availableTags.map((t) => {
    const color = getTagColor(`#${t}`);
    return {
      value: t,
      label: `#${t}`,
      icon: (
        <span className={c('filter-tag-dot')} style={{ background: color?.backgroundColor || 'var(--text-faint)' }} />
      ),
      count: tagCounts.get(t) || 0,
    };
  });

  const shown = hasActiveFilters
    ? items.filter((i) =>
        itemMatchesFilters(i, filters, filterContext.cardBodyCache, filterContext.boardPath, getAssignees, meId)
      ).length
    : items.length;

  return (
    <div className={c('filter-bar')}>
      {hasTeamCards && (
        <FilterMenu
          label="Assignee"
          icon="lucide-user"
          options={assigneeOptions}
          selected={filters.assignees}
          onChange={(assignees) => set({ assignees })}
        />
      )}
      <FilterMenu
        label="Priority"
        icon="lucide-signal"
        options={priorityOptions}
        selected={filters.priorities}
        onChange={(priorities) => set({ priorities })}
      />
      <FilterMenu
        label="Due"
        icon="lucide-calendar"
        options={dateOptions}
        selected={filters.dates}
        onChange={(dates) => set({ dates })}
      />
      <FilterMenu
        label="Tags"
        icon="lucide-tag"
        options={tagOptions}
        selected={filters.tags}
        onChange={(tags) => set({ tags })}
        emptyText="No tags on this board"
      />
      <button
        className={`${c('filter-chip')} ${filters.hideChecked ? 'is-active' : ''}`}
        onClick={() => set({ hideChecked: !filters.hideChecked })}
        title="Hide cards whose checkbox is ticked"
      >
        <Icon name={filters.hideChecked ? 'lucide-eye-off' : 'lucide-check-square'} />
        <span className={c('filter-chip-label')}>{filters.hideChecked ? 'Checked hidden' : 'Hide checked'}</span>
      </button>
      <button
        className={`${c('filter-chip')} ${filterContext.isGroupingByTag ? 'is-active' : ''}`}
        onClick={() => filterContext.setGroupingByTag(!filterContext.isGroupingByTag)}
      >
        <Icon name="lucide-layout-grid" />
        <span className={c('filter-chip-label')}>Group by tag</span>
      </button>

      {hasActiveFilters && (
        <div className={c('filter-bar-end')}>
          <span className={c('filter-count')}>
            {shown} of {items.length} cards
          </span>
          <a className={c('filter-clear-all')} onClick={clearFilters}>
            Clear all
          </a>
        </div>
      )}
    </div>
  );
}
