import update from 'immutability-helper';
import { App, MarkdownView, Notice, TFile, moment } from 'obsidian';
import Preact, { Dispatch, RefObject, useCallback, useEffect, useRef, useState } from 'preact/compat';
import { StateUpdater, useMemo } from 'preact/hooks';
import { StateManager } from 'src/StateManager';
import { Path } from 'src/dnd/types';
import { getEntityFromPath } from 'src/dnd/util/data';
import {
  InlineField,
  Priority,
  getTaskStatusDone,
  getTaskStatusPreDone,
  toggleTask,
} from 'src/parsers/helpers/inlineMetadata';

import { extractCardTitle } from 'src/kanbanFileHelpers';
import { DateFilterType, FilterContextProps, FilterState, PriorityFilterType, SearchContextProps, StatusFilterType } from './context';
import { Board, DataKey, Item, Lane, PageData, TagColor } from './types';

export const baseClassName = 'kanban-plugin';

export function noop() {}

/** Shared regex for extracting #tags from text. Always reset lastIndex before use. */
const TAG_REGEX = /#([a-zA-Z][a-zA-Z0-9_-]*)/g;

/** Extract all tag names from a text string into the given set. */
function extractTagsFromText(text: string, tagSet: Set<string>) {
  if (!text) return;
  TAG_REGEX.lastIndex = 0;
  let match;
  while ((match = TAG_REGEX.exec(text)) !== null) {
    tagSet.add(match[1]);
  }
}

/** Collect all tag names from an item's metadata, title fields, and optional card body cache. */
export function collectItemTags(
  item: Item,
  tagSet: Set<string>,
  cardBodyCache?: Map<string, string>,
  boardPath?: string
) {
  const metaTags = item.data.metadata?.tags;
  if (metaTags && Array.isArray(metaTags)) {
    metaTags.forEach((tag) => tagSet.add(tag.replace(/^#/, '')));
  }

  extractTagsFromText(item.data.titleSearch, tagSet);
  extractTagsFromText(item.data.titleRaw, tagSet);

  if (cardBodyCache && boardPath) {
    const cardTitle = extractCardTitle(item.data.titleRaw);
    if (cardTitle) {
      const cacheKey = `${boardPath}::${cardTitle}`;
      const cardBody = cardBodyCache.get(cacheKey);
      if (cardBody) {
        extractTagsFromText(cardBody, tagSet);
      }
    }
  }
}

const classCache = new Map<string, string>();
export function c(className: string) {
  if (classCache.has(className)) return classCache.get(className);
  const cls = `${baseClassName}__${className}`;
  classCache.set(className, cls);
  return cls;
}

export function generateInstanceId(len: number = 9): string {
  return Math.random()
    .toString(36)
    .slice(2, 2 + len);
}

export function maybeCompleteForMove(
  sourceStateManager: StateManager,
  sourceBoard: Board,
  sourcePath: Path,
  destinationStateManager: StateManager,
  destinationBoard: Board,
  destinationPath: Path,
  item: Item
): { next: Item; replacement?: Item } {
  const sourceParent = getEntityFromPath(sourceBoard, sourcePath.slice(0, -1));
  const destinationParent = getEntityFromPath(destinationBoard, destinationPath.slice(0, -1));

  const oldShouldComplete = sourceParent?.data?.shouldMarkItemsComplete;
  const newShouldComplete = destinationParent?.data?.shouldMarkItemsComplete;

  // If neither the old or new lane set it complete, leave it alone
  if (!oldShouldComplete && !newShouldComplete) return { next: item };

  const isComplete = item.data.checked && item.data.checkChar === getTaskStatusDone();

  // If it already matches the new lane, leave it alone
  if (newShouldComplete === isComplete) return { next: item };

  if (newShouldComplete) {
    item = update(item, { data: { checkChar: { $set: getTaskStatusPreDone() } } });
  }

  const updates = toggleTask(item, destinationStateManager.file);

  if (updates) {
    const [itemStrings, checkChars, thisIndex] = updates;
    let next: Item;
    let replacement: Item;

    itemStrings.forEach((str, i) => {
      if (i === thisIndex) {
        next = destinationStateManager.getNewItem(str, checkChars[i]);
      } else {
        replacement = destinationStateManager.getNewItem(str, checkChars[i]);
      }
    });

    return { next, replacement };
  }

  // It's different, update it
  return {
    next: update(item, {
      data: {
        checked: {
          $set: newShouldComplete,
        },
        checkChar: {
          $set: newShouldComplete ? getTaskStatusDone() : ' ',
        },
      },
    }),
  };
}

export function useIMEInputProps() {
  const isComposingRef = Preact.useRef<boolean>(false);

  return {
    // Note: these are lowercased because we use preact
    // See: https://github.com/preactjs/preact/issues/3003
    oncompositionstart: () => {
      isComposingRef.current = true;
    },
    oncompositionend: () => {
      isComposingRef.current = false;
    },
    getShouldIMEBlockAction: () => {
      return isComposingRef.current;
    },
  };
}

export const templaterDetectRegex = /<%/;

export async function applyTemplate(stateManager: StateManager, templatePath?: string) {
  const templateFile = templatePath
    ? stateManager.app.vault.getAbstractFileByPath(templatePath)
    : null;

  if (templateFile && templateFile instanceof TFile) {
    const activeView = stateManager.app.workspace.getActiveViewOfType(MarkdownView);

    try {
      // Force the view to source mode, if needed
      if (activeView?.getMode() !== 'source') {
        await activeView.setState(
          {
            ...activeView.getState(),
            mode: 'source',
          },
          { history: false }
        );
      }

      const { templatesEnabled, templaterEnabled, templatesPlugin, templaterPlugin } =
        getTemplatePlugins(stateManager.app);

      const templateContent = await stateManager.app.vault.read(templateFile);

      // If both plugins are enabled, attempt to detect templater first
      if (templatesEnabled && templaterEnabled) {
        if (templaterDetectRegex.test(templateContent)) {
          return await templaterPlugin.append_template_to_active_file(templateFile);
        }

        return await templatesPlugin.instance.insertTemplate(templateFile);
      }

      if (templatesEnabled) {
        return await templatesPlugin.instance.insertTemplate(templateFile);
      }

      if (templaterEnabled) {
        return await templaterPlugin.append_template_to_active_file(templateFile);
      }

      // No template plugins enabled so we can just append the template to the doc
      await stateManager.app.vault.modify(
        stateManager.app.workspace.getActiveFile(),
        templateContent
      );
    } catch (e) {
      console.error(e);
      new Notice('Kanban: Failed to apply template' + (e instanceof Error ? ': ' + e.message : ''));
      stateManager.setError(e);
    }
  }
}

const reRegExChar = /[\\^$.*+?()[\]{}|]/g;
const reHasRegExChar = RegExp(reRegExChar.source);

export function escapeRegExpStr(str: string) {
  return str && reHasRegExChar.test(str) ? str.replace(reRegExChar, '\\$&') : str || '';
}

export function getTemplatePlugins(app: App) {
  const templatesPlugin = app.internalPlugins.plugins.templates;
  const templatesEnabled = templatesPlugin.enabled;
  const templaterPlugin = app.plugins.plugins['templater-obsidian'];
  const templaterEnabled = app.plugins.enabledPlugins.has('templater-obsidian');
  const templaterEmptyFileTemplate =
    templaterPlugin &&
    app.plugins.plugins['templater-obsidian']?.settings?.empty_file_template;

  const templateFolder = templatesEnabled
    ? templatesPlugin.instance.options.folder
    : templaterPlugin
      ? templaterPlugin.settings.template_folder
      : undefined;

  return {
    templatesPlugin,
    templatesEnabled,
    templaterPlugin: templaterPlugin?.templater,
    templaterEnabled,
    templaterEmptyFileTemplate,
    templateFolder,
  };
}

export function getTagColorFn(tagColors: TagColor[]) {
  const tagMap = (tagColors || []).reduce<Record<string, TagColor>>((total, current) => {
    if (!current.tagKey) return total;
    total[current.tagKey] = current;
    return total;
  }, {});

  return (tag: string) => {
    if (tagMap[tag]) return tagMap[tag];
    return null;
  };
}

export function useGetTagColorFn(stateManager: StateManager): (tag: string) => TagColor {
  const tagColors = stateManager.useSetting('tag-colors');
  return useMemo(() => getTagColorFn(tagColors), [tagColors]);
}

export function parseMetadataWithOptions(data: InlineField, metadataKeys: DataKey[]): PageData {
  const options = metadataKeys.find((opts) => opts.metadataKey === data.key);

  return options
    ? {
        ...options,
        value: data.value,
      }
    : {
        containsMarkdown: false,
        label: data.key,
        metadataKey: data.key,
        shouldHideLabel: false,
        value: data.value,
      };
}

export function useOnMount(refs: RefObject<HTMLElement>[], cb: () => void, onUnmount?: () => void) {
  useEffect(() => {
    let complete = 0;
    let unmounted = false;
    const onDone = () => {
      if (unmounted) return;
      if (++complete === refs.length) {
        cb();
      }
    };
    for (const ref of refs) ref.current?.onNodeInserted(onDone, true);
    return () => {
      unmounted = true;
      onUnmount();
    };
  }, []);
}

export function useSearchValue(
  board: Board,
  query: string,
  setSearchQuery: Dispatch<StateUpdater<string>>,
  setDebouncedSearchQuery: Dispatch<StateUpdater<string>>,
  setIsSearching: Dispatch<StateUpdater<boolean>>
) {
  return useMemo<SearchContextProps>(() => {
    query = query.trim().toLocaleLowerCase();

    const lanes = new Set<Lane>();
    const items = new Set<Item>();

    if (query) {
      board.children.forEach((lane) => {
        let laneMatched = false;
        lane.children.forEach((item) => {
          if (item.data.titleSearch.includes(query)) {
            laneMatched = true;
            items.add(item);
          }
        });
        if (laneMatched) lanes.add(lane);
      });
    }

    return {
      lanes,
      items,
      query,
      search: (query, immediate) => {
        if (!query) {
          setIsSearching(false);
          setSearchQuery('');
          setDebouncedSearchQuery('');
        }
        setIsSearching(true);
        if (immediate) {
          setSearchQuery(query);
          setDebouncedSearchQuery(query);
        } else {
          setSearchQuery(query);
        }
      },
    };
  }, [board, query, setSearchQuery, setDebouncedSearchQuery]);
}

// Extract all unique tags from the board
export function extractAllTags(
  board: Board,
  cardBodyCache?: Map<string, string>,
  boardPath?: string
): string[] {
  const tagSet = new Set<string>();

  board.children.forEach((lane) => {
    lane.children.forEach((item) => {
      collectItemTags(item, tagSet, cardBodyCache, boardPath);
    });
  });

  return Array.from(tagSet).sort();
}

// Get primary tag (first tag) from an item
export function getPrimaryTag(
  item: Item,
  cardBodyCache?: Map<string, string>,
  boardPath?: string
): string | null {
  const tagSet = new Set<string>();
  collectItemTags(item, tagSet, cardBodyCache, boardPath);
  if (tagSet.size > 0) {
    return tagSet.values().next().value;
  }
  return null;
}

// Group items by their primary tag
export function groupItemsByTag(
  items: Item[],
  cardBodyCache?: Map<string, string>,
  boardPath?: string
): { tag: string | null; items: Item[] }[] {
  const groups = new Map<string | null, Item[]>();

  items.forEach((item) => {
    const tag = getPrimaryTag(item, cardBodyCache, boardPath);
    if (!groups.has(tag)) {
      groups.set(tag, []);
    }
    groups.get(tag)!.push(item);
  });

  // Convert to array and sort: tagged groups first (alphabetically), then ungrouped
  const result: { tag: string | null; items: Item[] }[] = [];
  const sortedTags = Array.from(groups.keys())
    .filter((t) => t !== null)
    .sort() as string[];

  sortedTags.forEach((tag) => {
    result.push({ tag, items: groups.get(tag)! });
  });

  // Add ungrouped items at the end
  if (groups.has(null)) {
    result.push({ tag: null, items: groups.get(null)! });
  }

  return result;
}

// Check if an item matches the current filters
export function itemMatchesFilters(
  item: Item,
  filters: FilterState,
  cardBodyCache?: Map<string, string>,
  boardPath?: string
): boolean {
  // Status filter
  if (filters.statusFilter === 'complete' && !item.data.checked) {
    return false;
  }
  if (filters.statusFilter === 'incomplete' && item.data.checked) {
    return false;
  }

  // Priority filter
  if (filters.priorityFilter !== 'all') {
    const itemPriority = item.data.metadata.priority;
    const priorityFilterMap: Record<string, string> = {
      highest: Priority.Highest,
      high: Priority.High,
      medium: Priority.Medium,
      low: Priority.Low,
    };

    if (filters.priorityFilter === 'none') {
      if (itemPriority && itemPriority !== Priority.None) {
        return false;
      }
    } else {
      const expectedValue = priorityFilterMap[filters.priorityFilter];
      if (itemPriority !== expectedValue) {
        return false;
      }
    }
  }

  // Tag filter
  if (filters.tags.length > 0) {
    const allItemTags = new Set<string>();
    collectItemTags(item, allItemTags, cardBodyCache, boardPath);

    const hasMatchingTag = filters.tags.some((tag) => allItemTags.has(tag));
    if (!hasMatchingTag) {
      return false;
    }
  }

  // Date filter
  if (filters.dateFilter !== 'all') {
    const itemDate = item.data.metadata?.date;
    const today = moment().startOf('day');

    switch (filters.dateFilter) {
      case 'today':
        if (!itemDate || !itemDate.isSame(today, 'day')) {
          return false;
        }
        break;
      case 'week':
        if (!itemDate || !itemDate.isBetween(today, moment().add(7, 'days'), 'day', '[]')) {
          return false;
        }
        break;
      case 'overdue':
        if (!itemDate || !itemDate.isBefore(today, 'day')) {
          return false;
        }
        break;
      case 'no-date':
        if (itemDate) {
          return false;
        }
        break;
    }
  }

  return true;
}

// Hook to manage filter state
export function useFilterValue(
  board: Board,
  cardBodyCache?: Map<string, string>,
  boardPath?: string
): FilterContextProps {
  const [filters, setFilters] = useState<FilterState>({
    tags: [],
    dateFilter: 'all',
    statusFilter: 'all',
    priorityFilter: 'all',
  });

  // Track cache size to trigger re-extraction when items load their content
  const [cacheSize, setCacheSize] = useState(cardBodyCache?.size || 0);

  // Check for cache updates periodically until stable
  useEffect(() => {
    if (!cardBodyCache) return;

    let timeoutId: number;
    let attempts = 0;
    const maxAttempts = 10;

    const checkCache = () => {
      const newSize = cardBodyCache.size;
      if (newSize !== cacheSize) {
        setCacheSize(newSize);
      }
      attempts++;
      if (attempts < maxAttempts) {
        timeoutId = window.setTimeout(checkCache, 500);
      }
    };

    // Start checking after a short delay to allow items to load
    timeoutId = window.setTimeout(checkCache, 300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [cardBodyCache, board]);

  const prevLanesRef = useRef<Lane[]>([]);
  const prevTagsRef = useRef<string[]>([]);
  const prevCacheSizeRef = useRef<number>(0);

  const availableTags = useMemo(() => {
    // Skip expensive re-extraction if lane children haven't changed by reference
    const lanesChanged =
      board.children.length !== prevLanesRef.current.length ||
      board.children.some(
        (lane, i) => lane.children !== prevLanesRef.current[i]?.children
      );
    const cacheSizeChanged = cacheSize !== prevCacheSizeRef.current;

    if (!lanesChanged && !cacheSizeChanged && prevTagsRef.current.length > 0) {
      return prevTagsRef.current;
    }

    prevLanesRef.current = board.children;
    prevCacheSizeRef.current = cacheSize;
    prevTagsRef.current = extractAllTags(board, cardBodyCache, boardPath);
    return prevTagsRef.current;
  }, [board, cardBodyCache, boardPath, cacheSize]);

  const setTagFilter = useCallback((tags: string[]) => {
    setFilters((prev) => ({ ...prev, tags }));
  }, []);

  const setDateFilter = useCallback((dateFilter: DateFilterType) => {
    setFilters((prev) => ({ ...prev, dateFilter }));
  }, []);

  const setStatusFilter = useCallback((statusFilter: StatusFilterType) => {
    setFilters((prev) => ({ ...prev, statusFilter }));
  }, []);

  const setPriorityFilter = useCallback((priorityFilter: PriorityFilterType) => {
    setFilters((prev) => ({ ...prev, priorityFilter }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({
      tags: [],
      dateFilter: 'all',
      statusFilter: 'all',
      priorityFilter: 'all',
    });
  }, []);

  const hasActiveFilters =
    filters.tags.length > 0 || filters.dateFilter !== 'all' || filters.statusFilter !== 'all' || filters.priorityFilter !== 'all';

  // Tag grouping state
  const [isGroupingByTag, setGroupingByTag] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const toggleGroupCollapse = useCallback((tag: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  }, []);

  return {
    filters,
    availableTags,
    setTagFilter,
    setDateFilter,
    setStatusFilter,
    setPriorityFilter,
    clearFilters,
    hasActiveFilters,
    cardBodyCache,
    boardPath,
    isGroupingByTag,
    setGroupingByTag,
    collapsedGroups,
    toggleGroupCollapse,
  };
}
