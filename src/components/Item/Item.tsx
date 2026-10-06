import classcat from 'classcat';
import {
  JSX,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'preact/compat';
import { Droppable, useNestedEntityPath } from 'src/dnd/components/Droppable';
import { DndManagerContext } from 'src/dnd/components/context';
import { useDragHandle } from 'src/dnd/managers/DragManager';
import { frontmatterKey } from 'src/parsers/common';

import { FilterContext, KanbanContext, SearchContext } from '../context';
import { c, groupItemsByTag, itemMatchesFilters } from '../helpers';
import { Icon } from '../Icon/Icon';
import { TagGroup } from '../Lane/TagGroup';
import { EditState, EditingState, Item, isEditing } from '../types';
import { ItemCheckbox } from './ItemCheckbox';
import { ItemContent, Tags, getCardCacheKey, getCardAgeClassFromCache, cardBodyCache } from './ItemContent';
import { extractCardLinkPath, extractCardTitle, findCardFileInVault } from 'src/kanbanFileHelpers';
import { TFile } from 'obsidian';
import { isTeamItem } from 'src/team/ids';
import { TeamCardExtras } from 'src/team/ui/TeamBadges';
import { useItemMenu } from './ItemMenu';
import { ItemMenuButton } from './ItemMenuButton';
import { ItemMetadata } from './MetadataTable';
import { PriorityButton } from './PriorityButton';
import { CardDetailModal } from './CardDetailModal';
import { getItemClassModifiers } from './helpers';

export interface DraggableItemProps {
  item: Item;
  itemIndex: number;
  isStatic?: boolean;
  shouldMarkItemsComplete?: boolean;
}

export interface ItemInnerProps {
  item: Item;
  isStatic?: boolean;
  shouldMarkItemsComplete?: boolean;
  isMatch?: boolean;
  searchQuery?: string;
}

const checkboxRegex = /^(\s*>)*(\s*[-+*]\s+?\[)([^\]])(\]\s+)/gm;

function countCheckboxes(text: string): { total: number; checked: number } {
  let total = 0;
  let checked = 0;
  let match: RegExpExecArray | null;
  checkboxRegex.lastIndex = 0;
  while ((match = checkboxRegex.exec(text)) !== null) {
    total++;
    if (match[3] !== ' ') checked++;
  }
  return { total, checked };
}

function extractTagsFromContent(content: string): string[] {
  const tags: string[] = [];
  const regex = /(?:^|\s)#([^\s#]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const tag = `#${match[1]}`;
    // Skip pure numbers like #123
    if (!/^#\d+$/.test(tag)) {
      tags.push(tag);
    }
  }
  return [...new Set(tags)];
}

function resolveCardFile(stateManager: StateManager, item: Item): TFile | null {
  if (isTeamItem(item)) return null;
  const cardLinkPath = extractCardLinkPath(item.data.titleRaw);
  const cardTitle = extractCardTitle(item.data.titleRaw);

  if (cardLinkPath) {
    const f = stateManager.app.vault.getAbstractFileByPath(cardLinkPath);
    if (f && f instanceof TFile) return f;
    const alt = cardLinkPath.endsWith('.md') ? cardLinkPath.slice(0, -3) : `${cardLinkPath}.md`;
    const af = stateManager.app.vault.getAbstractFileByPath(alt);
    if (af && af instanceof TFile) return af;
  }
  if (cardTitle) {
    const foundPath = findCardFileInVault(stateManager.app, cardTitle);
    if (foundPath) {
      const ff = stateManager.app.vault.getAbstractFileByPath(foundPath);
      if (ff && ff instanceof TFile) return ff;
    }
  }
  return null;
}

const CardFooter = memo(function CardFooter({ item }: { item: Item }) {
  const { stateManager } = useContext(KanbanContext);
  const [counts, setCounts] = useState<{ total: number; checked: number } | null>(null);
  const [externalTags, setExternalTags] = useState<string[]>([]);
  const [fileRev, setFileRev] = useState(0);
  const cardFileRef = useRef<TFile | null>(null);

  // Resolve the card file once
  useEffect(() => {
    cardFileRef.current = resolveCardFile(stateManager, item);
  }, [item.data.titleRaw, stateManager]);

  // Listen for vault modifications to the card file
  useEffect(() => {
    const onModify = (file: TFile) => {
      if (cardFileRef.current && file.path === cardFileRef.current.path) {
        setFileRev((r) => r + 1);
      }
    };
    stateManager.app.vault.on('modify', onModify);
    return () => { stateManager.app.vault.off('modify', onModify); };
  }, [stateManager.app.vault]);

  useEffect(() => {
    let cancelled = false;
    const inlineCounts = countCheckboxes(item.data.titleRaw);

    const file = cardFileRef.current;
    if (file) {
      void stateManager.app.vault.read(file).then((content) => {
        if (cancelled) return;
        const extCounts = countCheckboxes(content);
        setCounts({
          total: inlineCounts.total + extCounts.total,
          checked: inlineCounts.checked + extCounts.checked,
        });
        const tags = extractTagsFromContent(content);
        setExternalTags(tags);
      });
    } else {
      setCounts(inlineCounts.total > 0 ? inlineCounts : null);
      setExternalTags([]);
    }

    return () => { cancelled = true; };
  }, [item.data.titleRaw, stateManager.file.path, fileRev]);

  // Merge inline tags with external tags
  const inlineTags = item.data.metadata.tags || [];
  const allTags = [...new Set([...inlineTags, ...externalTags])];

  const hasProgress = counts && counts.total > 0;
  const hasTags = allTags.length > 0;

  if (!hasProgress && !hasTags) return null;

  const percent = hasProgress ? Math.round((counts.checked / counts.total) * 100) : 0;

  return (
    <div className={c('item-footer')} data-ignore-drag={true}>
      {hasTags && <Tags tags={allTags} alwaysShow={true} />}
      {hasProgress && (
        <div className={c('item-checkbox-progress')}>
          <div className={c('item-checkbox-progress-bar')}>
            <div
              className={c('item-checkbox-progress-fill')}
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className={c('item-checkbox-progress-text')}>
            {counts.checked}/{counts.total}
          </span>
        </div>
      )}
    </div>
  );
});

const ItemInner = memo(function ItemInner({
  item,
  shouldMarkItemsComplete,
  isMatch,
  searchQuery,
  isStatic,
}: ItemInnerProps) {
  const kanbanContext = useContext(KanbanContext);
  const { stateManager, boardModifiers } = kanbanContext;
  const [editState, setEditState] = useState<EditState>(EditingState.cancel);
  const titleLabel = useMemo(() => extractCardTitle(item.data.titleRaw), [item.data.titleRaw]);

  const dndManager = useContext(DndManagerContext);

  useEffect(() => {
    const handler = () => {
      if (isEditing(editState)) setEditState(EditingState.cancel);
    };

    dndManager.dragManager.emitter.on('dragStart', handler);
    return () => {
      dndManager.dragManager.emitter.off('dragStart', handler);
    };
  }, [dndManager, editState]);

  useEffect(() => {
    if (item.data.forceEditMode) {
      setEditState({ x: 0, y: 0 });
    }
  }, [item.data.forceEditMode]);

  const path = useNestedEntityPath();

  const showItemMenu = useItemMenu({
    boardModifiers,
    item,
    setEditState: setEditState,
    stateManager,
    path,
  });

  const onContextMenu: JSX.MouseEventHandler<HTMLDivElement> = useCallback(
    (e) => {
      if (isEditing(editState)) return;
      if (
        e.targetNode.instanceOf(HTMLAnchorElement) &&
        (e.targetNode.hasClass('internal-link') || e.targetNode.hasClass('external-link'))
      ) {
        return;
      }
      showItemMenu(e);
    },
    [showItemMenu, editState]
  );

  const onCardClick: JSX.MouseEventHandler<HTMLDivElement> = useCallback(
    (e) => {
      if (isEditing(editState)) return;
      const target = e.target as HTMLElement;
      // Don't open modal for links, checkboxes, buttons, or priority
      if (
        target.closest('a') ||
        target.hasClass('task-list-item-checkbox') ||
        target.closest('button') ||
        target.closest(`.${c('item-menu-button')}`) ||
        target.closest(`.${c('item-priority-button')}`) ||
        target.closest(`.${c('item-checkbox-wrapper')}`) ||
        target.closest(`.${c('item-collapse-btn')}`) ||
        target.closest('video')
      ) {
        return;
      }

      const modal = new CardDetailModal(
        stateManager.app,
        item,
        stateManager,
        boardModifiers,
        path,
        kanbanContext.view,
        kanbanContext,
      );
      modal.open();
    },
    [item, stateManager, boardModifiers, path, kanbanContext, editState]
  );

  const ignoreAttr = useMemo(() => {
    if (isEditing(editState)) {
      return {
        'data-ignore-drag': true,
      };
    }

    return {};
  }, [editState]);

  return (
    <div
      onContextMenu={onContextMenu}
      onClick={onCardClick}
      className={c('item-content-wrapper')}
      {...ignoreAttr}
    >
      {titleLabel && !isEditing(editState) ? (
        // Board cards show only the title; the description lives in the card window.
        <>
          <div className={c('item-title-line-wrapper')}>
            <ItemCheckbox
              boardModifiers={boardModifiers}
              item={item}
              path={path}
              shouldMarkItemsComplete={shouldMarkItemsComplete}
              stateManager={stateManager}
            />
            <div className={c('item-title-line-text')}>{titleLabel}</div>
            <ItemMenuButton editState={editState} setEditState={setEditState} showMenu={showItemMenu} />
          </div>
          <ItemMetadata searchQuery={isMatch ? searchQuery : undefined} item={item} />
        </>
      ) : (
        <>
          {/* eslint-disable-next-line react/no-unknown-property */}
          <div className={c('item-title-wrapper')} {...ignoreAttr}>
            <ItemCheckbox
              boardModifiers={boardModifiers}
              item={item}
              path={path}
              shouldMarkItemsComplete={shouldMarkItemsComplete}
              stateManager={stateManager}
            />
            <ItemContent
              item={item}
              searchQuery={isMatch ? searchQuery : undefined}
              setEditState={setEditState}
              editState={editState}
              isStatic={isStatic}
              compact={true}
            />
            <ItemMenuButton editState={editState} setEditState={setEditState} showMenu={showItemMenu} />
          </div>
          <ItemMetadata searchQuery={isMatch ? searchQuery : undefined} item={item} />
        </>
      )}
      <div className={c('item-bottom')}>
        <CardFooter item={item} />
        <TeamCardExtras item={item} />
      </div>
      <PriorityButton
        item={item}
        path={path}
        boardModifiers={boardModifiers}
        stateManager={stateManager}
      />
    </div>
  );
});

export const DraggableItem = memo(function DraggableItem(props: DraggableItemProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const search = useContext(SearchContext);
  const filterContext = useContext(FilterContext);
  const { stateManager } = useContext(KanbanContext);

  const { itemIndex, ...innerProps } = props;

  const bindHandle = useDragHandle(measureRef, measureRef);

  const isMatch = search?.query ? innerProps.item.data.titleSearch.includes(search.query) : false;
  const classModifiers: string[] = getItemClassModifiers(innerProps.item);

  // Get card age class
  const cardTitle = useMemo(
    () => extractCardTitle(innerProps.item.data.titleRaw),
    [innerProps.item.data.titleRaw]
  );
  const cardLinkPath = useMemo(
    () => extractCardLinkPath(innerProps.item.data.titleRaw),
    [innerProps.item.data.titleRaw]
  );
  const cacheKey = useMemo(
    () => {
      const key = cardLinkPath || cardTitle;
      return key ? getCardCacheKey(stateManager.file.path, key) : '';
    },
    [stateManager.file.path, cardLinkPath, cardTitle]
  );
  const ageClass = cacheKey ? getCardAgeClassFromCache(cacheKey) : '';
  if (ageClass) {
    classModifiers.push(ageClass);
  }

  // Check if item matches filters
  const matchesFilter = filterContext?.hasActiveFilters
    ? itemMatchesFilters(
        innerProps.item,
        filterContext.filters,
        filterContext.cardBodyCache,
        filterContext.boardPath
      )
    : true;

  // Hide item if it doesn't match filters
  if (!matchesFilter) {
    return null;
  }

  return (
    <div
      ref={(el) => {
        measureRef.current = el;
        bindHandle(el);
      }}
      className={c('item-wrapper')}
    >
      <div ref={elementRef} className={classcat([c('item'), ...classModifiers])}>
        {props.isStatic ? (
          <ItemInner
            {...innerProps}
            isMatch={isMatch}
            searchQuery={search?.query}
            isStatic={true}
          />
        ) : (
          <Droppable
            elementRef={elementRef}
            measureRef={measureRef}
            id={props.item.id}
            index={itemIndex}
            data={props.item}
          >
            <ItemInner {...innerProps} isMatch={isMatch} searchQuery={search?.query} />
          </Droppable>
        )}
      </div>
    </div>
  );
});

interface ItemsProps {
  isStatic?: boolean;
  items: Item[];
  shouldMarkItemsComplete: boolean;
  laneId?: string;
  isGroupingByTag?: boolean;
}

export const Items = memo(function Items({ isStatic, items, shouldMarkItemsComplete, laneId, isGroupingByTag }: ItemsProps) {
  const search = useContext(SearchContext);
  const filterContext = useContext(FilterContext);
  const { view, stateManager } = useContext(KanbanContext);
  const boardView = view.useViewState(frontmatterKey);

  // Filter items by search query
  const filteredItems = search?.query
    ? items.filter((item) => search.items.has(item))
    : items;

  // Check if grouping is enabled
  const isGrouping = isGroupingByTag && filteredItems.length > 0 && laneId;

  if (isGrouping) {
    let groups = groupItemsByTag(
      filteredItems,
      filterContext?.cardBodyCache,
      filterContext?.boardPath
    );

    // Filter groups if tag filter is active
    const activeTagFilters = filterContext?.filters?.tags || [];
    if (activeTagFilters.length > 0) {
      groups = groups.filter(
        (group) => group.tag !== null && activeTagFilters.includes(group.tag)
      );
    }

    return (
      <>
        {groups.map((group) => {
          // Map each grouped item to its real index in the lane's children array
          const itemIndices = group.items.map((item) => items.indexOf(item));
          return (
            <TagGroup
              key={group.tag ?? '__ungrouped__'}
              tag={group.tag}
              items={group.items}
              itemIndices={itemIndices}
              shouldMarkItemsComplete={shouldMarkItemsComplete}
              isStatic={isStatic}
              laneId={laneId}
            />
          );
        })}
      </>
    );
  }

  return (
    <>
      {filteredItems.map((item, i) => (
        <DraggableItem
          key={boardView + item.id}
          item={item}
          itemIndex={i}
          shouldMarkItemsComplete={shouldMarkItemsComplete}
          isStatic={isStatic}
        />
      ))}
    </>
  );
});
