import { useContext, useState } from 'preact/compat';

import { Icon } from '../Icon/Icon';
import { DateFilterType, FilterContext, StatusFilterType } from '../context';
import { c } from '../helpers';

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
    clearFilters,
    hasActiveFilters,
  } = filterContext;

  const toggleTag = (tag: string) => {
    if (filters.tags.includes(tag)) {
      setTagFilter(filters.tags.filter((t) => t !== tag));
    } else {
      setTagFilter([...filters.tags, tag]);
    }
  };

  const dateOptions: { value: DateFilterType; label: string }[] = [
    { value: 'all', label: 'All dates' },
    { value: 'today', label: 'Today' },
    { value: 'week', label: 'This week' },
    { value: 'overdue', label: 'Overdue' },
    { value: 'no-date', label: 'No date' },
  ];

  const statusOptions: { value: StatusFilterType; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'incomplete', label: 'To do' },
    { value: 'complete', label: 'Done' },
  ];

  const visibleTags = showAllTags ? availableTags : availableTags.slice(0, 15);
  const hasMoreTags = availableTags.length > 15;

  return (
    <div className={c('quick-filters')}>
      {/* Tags - primary filter */}
      {availableTags.length > 0 && (
        <div className={c('quick-filters-tags')}>
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
        </div>
      )}

      {/* Secondary filters row */}
      <div className={c('quick-filters-row')}>
        {/* Status filter */}
        <div className={c('filter-group')}>
          <div className={c('filter-buttons')}>
            {statusOptions.map((opt) => (
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

        {/* Date filter */}
        <div className={c('filter-group')}>
          <select
            className={c('filter-select')}
            value={filters.dateFilter}
            onChange={(e) => setDateFilter((e.target as HTMLSelectElement).value as DateFilterType)}
          >
            {dateOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Clear all filters */}
        {hasActiveFilters && (
          <button className={c('filter-clear')} onClick={clearFilters} title="Clear filters">
            <Icon name="lucide-x" />
          </button>
        )}
      </div>
    </div>
  );
}
