import { createPortal, useContext, useMemo, useState } from 'preact/compat';
import { Platform } from 'obsidian';
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
  onDoubleClick,
  doubleClickTitle,
}: {
  onDoubleClick?: () => void;
  doubleClickTitle?: string;
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
        onDblClick={
          onDoubleClick
            ? (e: MouseEvent) => {
                e.preventDefault();
                setOpen(false);
                onDoubleClick();
              }
            : undefined
        }
        title={doubleClickTitle}
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
  const projects = team ? team.useProjects() : [];
  const board = stateManager.useState();
  // Phones: the filters fold behind one button instead of filling a quarter of the screen.
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [allTags, setAllTags] = useState(false);

  const items = useMemo(() => {
    const all: Item[] = [];
    for (const lane of board?.children || []) all.push(...lane.children);
    return all;
  }, [board]);

  if (!filterContext) return null;
  const { filters, updateFilters, clearFilters, hasActiveFilters, getAssignees, getProject, meId } = filterContext;
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

  // Only worth a filter when the user can see more than one project.
  const projectOptions: Option<string>[] =
    hasTeamCards && projects.length > 1
      ? projects.map((p) => ({
          value: p.id,
          label: p.name,
          icon: <span className={c('filter-tag-dot')} style={{ background: p.color || 'var(--text-faint)' }} />,
          count: items.filter((i) => getProject?.(i) === p.id).length,
        }))
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

  // Team boards group by project; personal boards (no projects) keep grouping by tag.
  const groupByProject = !!stateManager.teamSync && !!getProject;

  const shown = hasActiveFilters
    ? items.filter((i) =>
        itemMatchesFilters(i, filters, filterContext.cardBodyCache, filterContext.boardPath, getAssignees, meId, getProject)
      ).length
    : items.length;

  const chips = (
    <>
      {(projectOptions.length > 0 || filters.projects.length > 0) && (
        <FilterMenu
          label="Project"
          icon="lucide-folder"
          options={projectOptions}
          selected={filters.projects}
          onChange={(projects) => set({ projects })}
        />
      )}
      {hasTeamCards && (
        <FilterMenu
          label="Assignee"
          icon="lucide-user"
          options={assigneeOptions}
          selected={filters.assignees}
          onChange={(assignees) => set({ assignees })}
          onDoubleClick={meId ? () => set({ assignees: ['me'] }) : undefined}
          doubleClickTitle={meId ? 'Double-click: only my cards' : undefined}
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
        <span className={c('filter-chip-label')}>{groupByProject ? 'Group by project' : 'Group by tag'}</span>
      </button>
    </>
  );

  const activeCount =
    filters.projects.length +
    filters.assignees.length +
    filters.priorities.length +
    filters.dates.length +
    filters.tags.length +
    (filters.hideChecked ? 1 : 0) +
    (filterContext.isGroupingByTag ? 1 : 0);

  if (Platform.isPhone) {
    // Phones: one Filters button; the options open in a sheet from the bottom with every
    // choice visible as a tappable chip (no nested pop-ups).
    const section = <T extends string>(
      label: string,
      options: Option<T>[],
      selected: T[],
      onChange: (next: T[]) => void,
      limit?: number
    ) => {
      // Long lists (tags) show the most used ones first, plus whatever is selected.
      const cut = limit && !allTags && options.length > limit;
      const shownOptions = cut
        ? [...options]
            .sort((a, b) => b.count - a.count)
            .filter((o, i) => i < limit || selected.includes(o.value))
        : options;
      return options.length > 0 && (
        <section className={c('fs-section')}>
          <div className={c('fs-section-head')}>
            <span>{label}</span>
            {selected.length > 0 && <a onClick={() => onChange([])}>Clear</a>}
          </div>
          <div className={c('fs-options')}>
            {shownOptions.map((o) => {
              const on = selected.includes(o.value);
              return (
                <button
                  key={o.value}
                  className={`${c('fs-option')} ${on ? 'is-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => onChange(toggle(selected, o.value))}
                >
                  {o.icon}
                  <span className={c('fs-option-label')}>{o.label}</span>
                  <span className={c('fs-option-count')}>{o.count}</span>
                </button>
              );
            })}
            {cut && (
              <button className={`${c('fs-option')} ${c('fs-more')}`} onClick={() => setAllTags(true)}>
                Show all {options.length}
              </button>
            )}
          </div>
        </section>
      );
    };
    const onlyMine = !!meId && filters.assignees.length === 1 && filters.assignees[0] === 'me';
    const toggleChip = (on: boolean, icon: string, label: string, onClick: () => void) => (
      <button className={`${c('fs-toggle')} ${on ? 'is-on' : ''}`} aria-pressed={on} onClick={onClick}>
        <Icon name={icon} />
        {label}
      </button>
    );

    return (
      <div className={`${c('filter-bar')} ${c('filter-bar-phone')}`}>
        <button
          className={`${c('filter-chip')} ${activeCount ? 'is-active' : ''}`}
          onClick={() => setPhoneOpen(true)}
          aria-expanded={phoneOpen}
        >
          <Icon name="lucide-sliders-horizontal" />
          <span className={c('filter-chip-label')}>Filters</span>
          {activeCount > 0 && <span className={c('filter-chip-value')}>{activeCount}</span>}
        </button>
        {hasActiveFilters && (
          <div className={c('filter-bar-end')}>
            <span className={c('filter-count')}>
              {shown}/{items.length}
            </span>
            <a className={c('filter-clear-all')} onClick={clearFilters}>
              Clear
            </a>
          </div>
        )}
        {phoneOpen &&
          // On <body>, so the sheet sits above Obsidian's bottom bar like a dialog does.
          createPortal(
          <div className={c('fs-backdrop')} onClick={() => setPhoneOpen(false)}>
            <div className={c('fs-sheet')} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Filters">
              <div className={c('fs-grabber')} />
              <div className={c('fs-head')}>
                <span className={c('fs-title')}>Filters</span>
                {(hasActiveFilters || filterContext.isGroupingByTag) && (
                  <a
                    className={c('fs-clear')}
                    onClick={() => {
                      clearFilters();
                      filterContext.setGroupingByTag(false);
                    }}
                  >
                    Clear all
                  </a>
                )}
              </div>
              <div className={c('fs-body')}>
                <div className={c('fs-toggles')}>
                  {hasTeamCards &&
                    meId &&
                    toggleChip(onlyMine, 'lucide-user-check', 'Only my cards', () =>
                      set({ assignees: onlyMine ? [] : ['me'] })
                    )}
                  {toggleChip(filters.hideChecked, 'lucide-eye-off', 'Hide checked', () =>
                    set({ hideChecked: !filters.hideChecked })
                  )}
                  {toggleChip(
                    !!filterContext.isGroupingByTag,
                    'lucide-layout-list',
                    groupByProject ? 'Group by project' : 'Group by tag',
                    () => filterContext.setGroupingByTag(!filterContext.isGroupingByTag)
                  )}
                </div>
                {section('Project', projectOptions, filters.projects, (projects) => set({ projects }))}
                {hasTeamCards && section('Assignee', assigneeOptions, filters.assignees, (assignees) => set({ assignees }))}
                {section('Priority', priorityOptions, filters.priorities, (priorities) => set({ priorities }))}
                {section('Due', dateOptions, filters.dates, (dates) => set({ dates }))}
                {section('Tags', tagOptions, filters.tags, (tags) => set({ tags }), 12)}
              </div>
              <div className={c('fs-foot')}>
                <button className={`mod-cta ${c('fs-done')}`} onClick={() => setPhoneOpen(false)}>
                  {hasActiveFilters ? `Show ${shown} of ${items.length} cards` : 'Done'}
                </button>
              </div>
            </div>
          </div>,
          stateManager.getAView()?.getWindow?.()?.document.body || document.body
        )}
      </div>
    );
  }

  return (
    <div className={c('filter-bar')}>
      {chips}

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
