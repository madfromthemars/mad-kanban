import { memo, useContext } from 'preact/compat';

import { FilterContext } from '../context';
import { c } from '../helpers';
import { Icon } from '../Icon/Icon';
import { Item } from '../types';
import { DraggableItem } from '../Item/Item';

interface TagGroupProps {
  tag: string | null;
  items: Item[];
  itemIndices: number[];
  shouldMarkItemsComplete: boolean;
  isStatic?: boolean;
  laneId: string;
}

export const TagGroup = memo(function TagGroup({
  tag,
  items,
  itemIndices,
  shouldMarkItemsComplete,
  isStatic,
  laneId,
}: TagGroupProps) {
  const filterContext = useContext(FilterContext);

  if (!filterContext) return null;

  const { collapsedGroups, toggleGroupCollapse } = filterContext;
  // Use lane-specific key for collapse state
  const collapseKey = tag ? `${laneId}::${tag}` : null;
  const isCollapsed = collapseKey ? collapsedGroups.has(collapseKey) : false;
  const groupLabel = tag ? `#${tag}` : 'Ungrouped';

  return (
    <div className={c('tag-group')}>
      <button
        className={`${c('tag-group-header')} ${isCollapsed ? c('tag-group-collapsed') : ''}`}
        onClick={() => collapseKey && toggleGroupCollapse(collapseKey)}
        disabled={!collapseKey}
      >
        <span className={c('tag-group-toggle')}>
          <Icon name={isCollapsed ? 'lucide-chevron-right' : 'lucide-chevron-down'} />
        </span>
        <span className={c('tag-group-label')}>{groupLabel}</span>
        <span className={c('tag-group-count')}>({items.length})</span>
      </button>
      {!isCollapsed && (
        <div className={c('tag-group-items')}>
          {items.map((item, i) => (
            <DraggableItem
              key={item.id}
              item={item}
              itemIndex={itemIndices[i]}
              shouldMarkItemsComplete={shouldMarkItemsComplete}
              isStatic={isStatic}
            />
          ))}
        </div>
      )}
    </div>
  );
});
