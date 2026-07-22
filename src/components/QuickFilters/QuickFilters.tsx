import { useContext, useState } from 'preact/compat';

import { Icon } from '../Icon/Icon';
import { DateFilterType, FilterContext, PriorityFilterType, StatusFilterType } from '../context';
import { c } from '../helpers';

const dateFilterOptions: { value: DateFilterType; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'no-date', label: 'No date' },
];

const statusFilterOptions: { value: StatusFilterType; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'complete', label: 'Done' },
  { value: 'incomplete', label: 'Active' },
];

const priorityFilterOptions: { value: PriorityFilterType; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'highest', label: '🔺' },
  { value: 'high', label: '⏫' },
  { value: 'medium', label: '🔼' },
  { value: 'low', label: '🔽' },
  { value: 'none', label: 'No priority' },
];

export function QuickFilters() {
  const filterContext = useContext(FilterContext);
  const [showAllTags, setShowAllTags] = useState(false);

  if (!filterContext) return null;

  const {
    filters,
    availableTags,
    setTagFilter,
    setDateFilter,
    setStatusFilter,
    setPriorityFilter,
    clearFilters,
    hasActiveFilters,
    isGroupingByTag,
    setGroupingByTag,
  } = filterContext;

  const toggleTag = (tag: string) => {
    if (filters.tags.includes(tag)) {
      setTagFilter(filters.tags.filter((t) => t !== tag));
    } else {
      setTagFilter([...filters.tags, tag]);
    }
  };

  const visibleTags = showAllTags ? availableTags : availableTags.slice(0, 15);
  const hasMoreTags = availableTags.length > 15;

  return (
    <div className={c('quick-filters')}>
      {/* Filter row: Date, Status, Group toggle, Clear */}
      <div className={c('quick-filters-row')}>
        <div className={c('filter-group')}>
          <div className={c('filter-buttons')}>
            {dateFilterOptions.map((opt) => (
              <button
                key={opt.value}
                className={`${c('filter-button')} ${filters.dateFilter === opt.value ? c('filter-active') : ''}`}
                onClick={() => setDateFilter(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className={c('filter-group')}>
          <div className={c('filter-buttons')}>
            {statusFilterOptions.map((opt) => (
              <button
                key={opt.value}
                className={`${c('filter-button')} ${filters.statusFilter === opt.value ? c('filter-active') : ''}`}
                onClick={() => setStatusFilter(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className={c('filter-group')}>
          <div className={c('filter-buttons')}>
            {priorityFilterOptions.map((opt) => (
              <button
                key={opt.value}
                className={`${c('filter-button')} ${filters.priorityFilter === opt.value ? c('filter-active') : ''}`}
                onClick={() => setPriorityFilter(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <button
          className={`${c('group-toggle')} ${isGroupingByTag ? c('group-toggle-active') : ''}`}
          onClick={() => setGroupingByTag(!isGroupingByTag)}
          title={isGroupingByTag ? 'Disable grouping' : 'Group by tag'}
        >
          <Icon name="lucide-layout-grid" />
          <span>Group by tag</span>
        </button>

        {hasActiveFilters && (
          <button className={c('filter-clear')} onClick={clearFilters} title="Clear filters">
            <Icon name="lucide-x" />
          </button>
        )}
      </div>

      {/* Tags filter */}
      <div className={c('quick-filters-tags')}>
        {availableTags.length > 0 ? (
          <>
            {visibleTags.map((tag) => (
              <button
                key={tag}
                className={`${c('tag-filter')} ${filters.tags.includes(tag) ? c('tag-filter-active') : ''}`}
                onClick={() => toggleTag(tag)}
              >
                #{tag}
              </button>
            ))}
            {hasMoreTags && !showAllTags && (
              <button className={c('tag-filter-more')} onClick={() => setShowAllTags(true)}>
                +{availableTags.length - 15} more
              </button>
            )}
            {showAllTags && hasMoreTags && (
              <button className={c('tag-filter-more')} onClick={() => setShowAllTags(false)}>
                Show less
              </button>
            )}
          </>
        ) : (
          <span className={c('no-tags')}>No tags found</span>
        )}
      </div>
    </div>
  );
}
