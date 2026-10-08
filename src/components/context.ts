import { createContext } from 'preact/compat';
import { KanbanView } from 'src/KanbanView';
import { StateManager } from 'src/StateManager';
import { IntersectionObserverHandler } from 'src/dnd/managers/ScrollManager';

import { BoardModifiers } from '../helpers/boardModifiers';
import { Item, Lane, LaneSort } from './types';

export interface KanbanContextProps {
  filePath?: string;
  stateManager: StateManager;
  boardModifiers: BoardModifiers;
  view: KanbanView;
}

export const KanbanContext = createContext<KanbanContextProps>(null);

export type DateFilterType = 'overdue' | 'today' | 'week' | 'no-date';
export type PriorityFilterType = 'highest' | 'high' | 'medium' | 'low' | 'none';

/** Each list is OR-ed inside itself; the lists are AND-ed together. Empty = no filter. */
export interface FilterState {
  tags: string[];
  dates: DateFilterType[];
  priorities: PriorityFilterType[];
  /** 'me' | 'unassigned' | team user ids */
  assignees: string[];
  hideChecked: boolean;
}

export const EMPTY_FILTERS: FilterState = {
  tags: [],
  dates: [],
  priorities: [],
  assignees: [],
  hideChecked: false,
};

export interface FilterContextProps {
  filters: FilterState;
  availableTags: string[];
  updateFilters: (patch: Partial<FilterState>) => void;
  /** Assignees of a team card, or null for a card that isn't a team card. */
  getAssignees?: (item: Item) => string[] | null;
  meId?: string | null;
  clearFilters: () => void;
  hasActiveFilters: boolean;
  cardBodyCache?: Map<string, string>;
  boardPath?: string;
  // Tag grouping
  isGroupingByTag: boolean;
  setGroupingByTag: (enabled: boolean) => void;
  collapsedGroups: Set<string>;
  toggleGroupCollapse: (tag: string) => void;
}

export interface SearchContextProps {
  query: string;
  items: Set<Item>;
  lanes: Set<Lane>;
  search: (query: string, immediate?: boolean) => void;
}

export const SearchContext = createContext<SearchContextProps | null>(null);
export const FilterContext = createContext<FilterContextProps | null>(null);
export const SortContext = createContext<LaneSort | string | null>(null);
export const IntersectionObserverContext = createContext<{
  registerHandler: (el: HTMLElement, handler: IntersectionObserverHandler) => void;
  unregisterHandler: (el: HTMLElement) => void;
} | null>(null);
