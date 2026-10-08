import { useContext, useMemo, useState } from 'preact/compat';
import { hueFor, initials } from 'src/team/ui/TeamBadges';

import { Icon } from '../Icon/Icon';
import {
  DateFilterType,
  FilterContext,
  KanbanContext,
  PriorityFilterType,
  StatusFilterType,
} from '../context';
import { c, itemMatchesFilters, useGetTagColorFn } from '../helpers';
import { Item } from '../types';
import { PriorityIcon } from '../Item/PriorityIcon';

const dateFilterOptions: { value: DateFilterType; label: string }[] = [
  { value: 'all', label: 'Any' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'no-date', label: 'No date' },
];

const statusFilterOptions: { value: StatusFilterType; label: string }[] = [
  { value: 'all', label: 'Any' },
  { value: 'incomplete', label: 'Open' },
  { value: 'complete', label: 'Checked off' },
];

// `icon` holds the stored priority value, drawn with PriorityIcon
const priorityFilterOptions: { value: PriorityFilterType; label: string; icon?: string }[] = [
  { value: 'all', label: 'Any' },
  { value: 'highest', label: 'Highest', icon: '0' },
  { value: 'high', label: 'High', icon: '1' },
  { value: 'medium', label: 'Medium', icon: '2' },
  { value: 'low', label: 'Low', icon: '4' },
  { value: 'none', label: 'None' },
];

const TAG_LIMIT = 15;

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; icon?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className={c('segmented')}>
      {options.map((opt) => (
        <button
          key={opt.value}
          className={value === opt.value ? 'is-active' : ''}
          onClick={() => onChange(opt.value)}
          title={opt.label}
        >
          {opt.icon && <PriorityIcon value={opt.icon} />}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Section({ label, children }: { label: string; children: any }) {
  return (
    <div className={c('filter-section')}>
      <div className={c('filter-label')}>{label}</div>
      {children}
    </div>
  );
}

export function QuickFilters() {
  const filterContext = useContext(FilterContext);
  const { stateManager } = useContext(KanbanContext);
  const getTagColor = useGetTagColorFn(stateManager);
  const team = stateManager.plugin?.team;
  const users = team ? team.useUsers() : [];
  const [showAllTags, setShowAllTags] = useState(false);

  const board = stateManager.state;
  const items = useMemo(() => {
    const all: Item[] = [];
    for (const lane of board?.children || []) all.push(...lane.children);
    return all;
  }, [board]);

  // People assigned to cards on this board (team cards only).
  const assigneeIds = useMemo(() => {
    const ids = new Set<string>();
    if (!filterContext?.getAssignees) return ids;
    for (const item of items) for (const id of filterContext.getAssignees(item) || []) ids.add(id);
    return ids;
  }, [items, filterContext?.getAssignees]);
  const hasTeamCards = useMemo(
    () => !!filterContext?.getAssignees && items.some((i) => filterContext.getAssignees(i) !== null),
    [items, filterContext?.getAssignees]
  );

  if (!filterContext) return null;

  const {
    filters,
    availableTags,
    setTagFilter,
    setDateFilter,
    setStatusFilter,
    setPriorityFilter,
    setAssigneeFilter,
    clearFilters,
    hasActiveFilters,
    isGroupingByTag,
    setGroupingByTag,
  } = filterContext;

  const shown = hasActiveFilters
    ? items.filter((item) =>
        itemMatchesFilters(
          item,
          filters,
          filterContext.cardBodyCache,
          filterContext.boardPath,
          filterContext.getAssignees,
          filterContext.meId
        )
      ).length
    : items.length;

  const toggleTag = (tag: string) => {
    setTagFilter(filters.tags.includes(tag) ? filters.tags.filter((t) => t !== tag) : [...filters.tags, tag]);
  };

  const visibleTags = showAllTags ? availableTags : availableTags.slice(0, TAG_LIMIT);
  const people = users.filter((u) => assigneeIds.has(u.id) && u.id !== filterContext.meId);

  return (
    <div className={c('quick-filters')}>
      <div className={c('quick-filters-grid')}>
        {hasTeamCards && (
          <Section label="Assignee">
            <div className={c('segmented')}>
              {[
                { value: 'all', label: 'Anyone' },
                ...(filterContext.meId ? [{ value: 'me', label: 'Me' }] : []),
                { value: 'unassigned', label: 'Unassigned' },
              ].map((opt) => (
                <button
                  key={opt.value}
                  className={filters.assignee === opt.value ? 'is-active' : ''}
                  onClick={() => setAssigneeFilter(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {people.length > 0 && (
              <div className={c('filter-people')}>
                {people.map((u) => (
                  <button
                    key={u.id}
                    className={`${c('filter-person')} ${filters.assignee === u.id ? 'is-active' : ''}`}
                    onClick={() => setAssigneeFilter(filters.assignee === u.id ? 'all' : u.id)}
                    title={u.name}
                  >
                    <span className={c('assignee')} style={{ '--assignee-hue': hueFor(u.id) }}>
                      {initials(u.name)}
                    </span>
                    {u.name}
                  </button>
                ))}
              </div>
            )}
          </Section>
        )}

        <Section label="Priority">
          <Segmented options={priorityFilterOptions} value={filters.priorityFilter} onChange={setPriorityFilter} />
        </Section>

        <Section label="Due date">
          <Segmented options={dateFilterOptions} value={filters.dateFilter} onChange={setDateFilter} />
        </Section>

        <Section label="Checkbox">
          <Segmented options={statusFilterOptions} value={filters.statusFilter} onChange={setStatusFilter} />
        </Section>
      </div>

      <Section label="Tags">
        <div className={c('quick-filters-tags')}>
          {availableTags.length > 0 ? (
            <>
              {visibleTags.map((tag) => {
                const color = getTagColor(`#${tag}`);
                return (
                  <button
                    key={tag}
                    className={`${c('tag-filter')} ${filters.tags.includes(tag) ? c('tag-filter-active') : ''}`}
                    style={
                      color && {
                        '--tag-color': color.color,
                        '--tag-background': color.backgroundColor,
                      }
                    }
                    onClick={() => toggleTag(tag)}
                  >
                    #{tag}
                  </button>
                );
              })}
              {availableTags.length > TAG_LIMIT && (
                <button className={c('tag-filter-more')} onClick={() => setShowAllTags(!showAllTags)}>
                  {showAllTags ? 'Show less' : `+${availableTags.length - TAG_LIMIT} more`}
                </button>
              )}
            </>
          ) : (
            <span className={c('no-tags')}>No tags on this board</span>
          )}
        </div>
      </Section>

      <div className={c('quick-filters-footer')}>
        <span className={c('filter-count')}>
          {hasActiveFilters ? `Showing ${shown} of ${items.length} cards` : `${items.length} cards`}
        </span>
        <button
          className={`${c('group-toggle')} ${isGroupingByTag ? c('group-toggle-active') : ''}`}
          onClick={() => setGroupingByTag(!isGroupingByTag)}
        >
          <Icon name="lucide-layout-grid" />
          <span>Group by tag</span>
        </button>
        {hasActiveFilters && (
          <button className={c('filter-clear')} onClick={clearFilters}>
            <Icon name="lucide-x" />
            <span>Clear filters</span>
          </button>
        )}
      </div>
    </div>
  );
}
