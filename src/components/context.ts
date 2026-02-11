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

export type DateFilterType = 'all' | 'today' | 'week' | 'overdue' | 'no-date';
export type StatusFilterType = 'all' | 'complete' | 'incomplete';

export interface FilterState {
  tags: string[];
  dateFilter: DateFilterType;
  statusFilter: StatusFilterType;
}

export interface FilterContextProps {
  filters: FilterState;
  availableTags: string[];
  setTagFilter: (tags: string[]) => void;
  setDateFilter: (filter: DateFilterType) => void;
  setStatusFilter: (filter: StatusFilterType) => void;
  clearFilters: () => void;
  hasActiveFilters: boolean;
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
