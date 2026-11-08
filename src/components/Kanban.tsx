import classcat from 'classcat';
import update from 'immutability-helper';
import { Notice, Platform } from 'obsidian';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/compat';
import { KanbanView } from 'src/KanbanView';
import { StateManager } from 'src/StateManager';
import { useIsAnythingDragging } from 'src/dnd/components/DragOverlay';
import { ScrollContainer } from 'src/dnd/components/ScrollContainer';
import { SortPlaceholder } from 'src/dnd/components/SortPlaceholder';
import { Sortable } from 'src/dnd/components/Sortable';
import { createHTMLDndHandlers } from 'src/dnd/managers/DragManager';
import { t } from 'src/lang/helpers';

import { DndScope } from '../dnd/components/Scope';
import { getBoardModifiers } from '../helpers/boardModifiers';
import { frontmatterKey } from '../parsers/common';
import { Icon } from './Icon/Icon';
import { cardBodyCache, clearCardCaches } from './Item/ItemContent';
import { findOrphanedBoardFolder, migrateBoardFolder } from '../kanbanFileHelpers';
import { Lanes } from './Lane/Lane';
import { FIXED_LANES, createListArtifacts } from './Lane/LaneForm';
import { TrashZone } from './BoardZones';
import { QuickFilters } from './QuickFilters/QuickFilters';
import { PhoneLaneTabs, readPhoneLane, resolvePhoneLane, savePhoneLane } from './PhoneLaneTabs';
import { TeamSyncStatus } from 'src/team/ui/TeamBadges';
import { TableView } from './Table/Table';
import { FilterContext, KanbanContext, SearchContext } from './context';
import {
  baseClassName,
  c,
  generateInstanceId,
  itemMatchesFilters,
  useFilterValue,
  useSearchValue,
} from './helpers';
import { DataTypes, Item, LaneTemplate } from './types';
import { isMirrorLane, parseTeamItemId } from 'src/team/ids';
import { laneKey } from 'src/team/laneKey';

const boardScrollTiggers = [DataTypes.Item, DataTypes.Lane];
const boardAccepts = [DataTypes.Lane];

interface KanbanProps {
  stateManager: StateManager;
  view: KanbanView;
}

function getCSSClass(frontmatter: Record<string, any>): string[] {
  const classes = [];
  if (Array.isArray(frontmatter.cssclass)) {
    classes.push(...frontmatter.cssclass);
  } else if (typeof frontmatter.cssclass === 'string') {
    classes.push(frontmatter.cssclass);
  }
  if (Array.isArray(frontmatter.cssclasses)) {
    classes.push(...frontmatter.cssclasses);
  } else if (typeof frontmatter.cssclasses === 'string') {
    classes.push(frontmatter.cssclasses);
  }

  return classes;
}

export const Kanban = ({ view, stateManager }: KanbanProps) => {
  const boardData = stateManager.useState();
  const isAnythingDragging = useIsAnythingDragging();

  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);

  const filePath = stateManager.file.path;
  const maxArchiveLength = stateManager.useSetting('max-archive-size');
  const tagColors = stateManager.useSetting('tag-colors');
  const boardView = view.useViewState(frontmatterKey);
  // Phones show one list at a time, picked from tabs above the board (remembered per board).
  const phoneTabs = Platform.isPhone && boardView !== 'list' && boardView !== 'table';
  const [phoneLaneStored, setPhoneLaneStored] = useState<string | null>(() => readPhoneLane(filePath));

  // Lists are fixed (To Do / In Progress / Done / Archive). A personal board missing any of them
  // gets them added; team boards get theirs from the server.
  const creatingLanes = useRef(false);
  // The "Team" list that mirrored cards fall back to isn't one of the board's own lists.
  const ownKeys = (boardData?.children || []).filter((l) => !isMirrorLane(l)).map((l) => laneKey(l.data.title));
  const missingLanes = stateManager.teamSync
    ? []
    : FIXED_LANES.filter((title) => !ownKeys.includes(laneKey(title)));
  const missingKey = missingLanes.join('|');
  useEffect(() => {
    if (!boardData || !missingLanes.length || stateManager.hasError() || creatingLanes.current) return;
    creatingLanes.current = true;
    void (async () => {
      for (const title of missingLanes) await createListArtifacts(stateManager, title);
      stateManager.setState((board) => {
        const own = board.children.filter((l) => !isMirrorLane(l));
        const mirror = board.children.filter((l) => isMirrorLane(l));
        const keys = own.map((l) => laneKey(l.data.title));
        const add = FIXED_LANES.filter((t) => !keys.includes(laneKey(t))).map((title) => ({
          ...LaneTemplate,
          id: generateInstanceId(),
          children: [] as Item[],
          data: { title, shouldMarkItemsComplete: false },
        }));
        return add.length ? { ...board, children: [...own, ...add, ...mirror] } : board;
      });
      creatingLanes.current = false;
    })();
  }, [!!boardData, missingKey, stateManager]);

  useEffect(() => {
    const onSearchHotkey = (data: { commandId: string; data: string }) => {
      if (data.commandId === 'editor:open-search') {
        if (typeof data.data === 'string') {
          setIsSearching(true);
          setSearchQuery(data.data);
          setDebouncedSearchQuery(data.data);
        } else {
          setIsSearching((val) => !val);
        }
      }
    };

    view.emitter.on('hotkey', onSearchHotkey);

    return () => {
      view.emitter.off('hotkey', onSearchHotkey);
    };
  }, [view]);

  useEffect(() => {
    if (isSearching) {
      searchRef.current?.focus();
    }
  }, [isSearching]);

  useEffect(() => {
    const win = view.getWindow();
    const trimmed = searchQuery.trim();
    let id: number;

    if (trimmed) {
      id = win.setTimeout(() => {
        setDebouncedSearchQuery(trimmed);
      }, 250);
    } else {
      setDebouncedSearchQuery('');
    }

    return () => {
      win.clearTimeout(id);
    };
  }, [searchQuery, view]);

  // On load: detect and migrate orphaned _folder from a previous board move
  useEffect(() => {
    const oldBoardPath = findOrphanedBoardFolder(stateManager.app, stateManager.file);
    if (oldBoardPath) {
      migrateBoardFolder(stateManager.app, stateManager.file, oldBoardPath).then(() => {
        clearCardCaches();
        stateManager.forceRefresh();
      }).catch((e) => {
        console.error('[Kanban] Load-time folder migration failed:', e);
        new Notice('Kanban: Failed to migrate board folder' + (e instanceof Error ? ': ' + e.message : ''));
      });
    }
  }, []);

  useEffect(() => {
    if (maxArchiveLength === undefined || maxArchiveLength === -1) {
      return;
    }

    if (typeof maxArchiveLength === 'number' && boardData?.data.archive.length > maxArchiveLength) {
      stateManager.setState((board) =>
        update(board, {
          data: {
            archive: {
              $set: board.data.archive.slice(maxArchiveLength * -1),
            },
          },
        })
      );
    }
  }, [boardData?.data.archive.length, maxArchiveLength]);

  const boardModifiers = useMemo(() => {
    return getBoardModifiers(view, stateManager);
  }, [stateManager, view]);

  const kanbanContext = useMemo(() => {
    return {
      view,
      stateManager,
      boardModifiers,
      filePath,
    };
  }, [view, stateManager, boardModifiers, filePath, tagColors]);

  const html5DragHandlers = createHTMLDndHandlers(stateManager);

  if (boardData === null || boardData === undefined)
    return (
      <div className={c('loading')}>
        <div className="sk-pulse"></div>
      </div>
    );

  if (boardData.data.errors.length > 0) {
    return (
      <div className={c('error-container')}>
        <div className={c('error-header')}>
          <span>{t('Error')}</span>
          <button
            className={c('error-dismiss-button')}
            onClick={() => {
              stateManager.setState((board) =>
                update(board, {
                  data: { errors: { $set: [] } },
                })
              );
            }}
          >
            {t('Dismiss')}
          </button>
        </div>
        {boardData.data.errors.map((e, i) => (
          <div key={i} className={c('error-item')}>
            <div className={c('error-description')}>{e.description}</div>
            <pre className={c('error-stack')}>{e.stack}</pre>
          </div>
        ))}
      </div>
    );
  }

  const axis = boardView === 'list' ? 'vertical' : 'horizontal';
  const searchValue = useSearchValue(
    boardData,
    debouncedSearchQuery,
    setSearchQuery,
    setDebouncedSearchQuery,
    setIsSearching
  );
  const team = stateManager.plugin?.team;
  const isHost = team ? team.useIsHost() : false;
  const getAssignees = useCallback(
    (item: Item) => {
      const ids = parseTeamItemId(item.id);
      if (!ids || !team) return null;
      const card = team.getCard(ids.cardId);
      // A card created a moment ago isn't indexed until the server answers; use what it was created with.
      return card ? card.assignees || [] : item.data.teamAssignees || [];
    },
    [team]
  );
  const getProject = useCallback(
    (item: Item) => {
      const ids = parseTeamItemId(item.id);
      if (!ids || !team) return null;
      const card = team.getCard(ids.cardId);
      return card ? card.projectId || null : item.data.teamProject || null;
    },
    [team]
  );
  // Filters read assignees/projects from the card index, so redraw when it changes.
  if (team) team.useCardsVersion();
  const filterValue = useFilterValue(boardData, cardBodyCache, filePath, getAssignees, team?.user?.id, getProject);
  // Priority changes don't move cards right away; changing a filter re-sorts the lists.
  const filtersKey = JSON.stringify(filterValue.filters);
  const lastFiltersKey = useRef(filtersKey);
  useEffect(() => {
    if (lastFiltersKey.current === filtersKey) return;
    lastFiltersKey.current = filtersKey;
    stateManager.resortByPriority();
  }, [filtersKey]);

  const phoneLane = phoneTabs ? resolvePhoneLane(boardData.children, phoneLaneStored) : null;
  const phoneCounts = phoneTabs
    ? boardData.children.map(
        (lane) =>
          lane.children.filter(
            (it) =>
              (!searchValue.query || searchValue.items.has(it)) &&
              (!filterValue.hasActiveFilters ||
                itemMatchesFilters(
                  it,
                  filterValue.filters,
                  filterValue.cardBodyCache,
                  filterValue.boardPath,
                  filterValue.getAssignees,
                  filterValue.meId,
                  filterValue.getProject
                ))
          ).length
      )
    : [];

  return (
    <DndScope id={view.id}>
      <KanbanContext.Provider value={kanbanContext}>
        <SearchContext.Provider value={searchValue}>
          <FilterContext.Provider value={filterValue}>
            <div
              ref={rootRef}
              className={classcat([
                baseClassName,
                {
                  'something-is-dragging': isAnythingDragging,
                  [c('phone-tabs-mode')]: phoneTabs,
                  [c('is-grouped')]: !!filterValue.isGroupingByTag,
                },
                ...getCSSClass(boardData.data.frontmatter),
              ])}
              {...html5DragHandlers}
            >
              {boardView !== 'table' && <TrashZone />}
              <div className={c('toolbar')}>
                <button
                  className={`${c('toolbar-button')} ${isSearching ? c('toolbar-button-active') : ''}`}
                  onClick={() => setIsSearching(!isSearching)}
                  title="Search"
                >
                  <Icon name="lucide-search" />
                </button>
                <TeamSyncStatus />
                {stateManager.teamSync && team && (
                  <button
                    className={c('toolbar-button')}
                    onClick={() => team.openProgress(stateManager.teamSync?.boardId ?? null)}
                    title="Progress: finished cards, who's on what, and the Trash"
                  >
                    <Icon name="lucide-bar-chart-3" />
                  </button>
                )}
                {isHost && (
                  <button
                    className={c('toolbar-button')}
                    onClick={() => team?.openManageTeam()}
                    title="Manage team: people and projects"
                  >
                    <Icon name="lucide-users" />
                  </button>
                )}
                <QuickFilters />
              </div>
              {isSearching && (
                <div className={c('search-wrapper')}>
                <input
                  ref={searchRef}
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery((e.target as HTMLInputElement).value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setSearchQuery('');
                      setDebouncedSearchQuery('');
                      (e.target as HTMLInputElement).blur();
                      setIsSearching(false);
                    }
                  }}
                  type="text"
                  className={c('filter-input')}
                  placeholder={t('Search...')}
                />
                <a
                  className={`${c('search-cancel-button')} clickable-icon`}
                  onClick={() => {
                    setSearchQuery('');
                    setDebouncedSearchQuery('');
                    setIsSearching(false);
                  }}
                  aria-label={t('Cancel')}
                >
                  <Icon name="lucide-x" />
                </a>
              </div>
            )}
            {phoneTabs && boardData.children.length > 0 && (
              <PhoneLaneTabs
                lanes={boardData.children}
                active={phoneLane}
                counts={phoneCounts}
                filePath={filePath}
                onSelect={(i) => {
                  const lane = boardData.children[i];
                  if (!lane) return;
                  savePhoneLane(filePath, lane);
                  setPhoneLaneStored(readPhoneLane(filePath));
                  rootRef.current
                    ?.querySelector<HTMLElement>(`.${c('lane-items')}`)
                    ?.scrollTo({ top: 0 });
                }}
                onMenu={() => {
                  // The list's own menu (archive cards, sort) lives in its hidden header.
                  rootRef.current
                    ?.querySelector<HTMLElement>(
                      `.${c('lane-header-wrapper')} .${c('lane-settings-button')}[aria-label="${t('More options')}"]`
                    )
                    ?.click();
                }}
              />
            )}
            {boardView === 'table' ? (
              <TableView boardData={boardData} stateManager={stateManager} />
            ) : (
              <ScrollContainer
                id={view.id}
                className={classcat([
                  c('board'),
                  {
                    [c('horizontal')]: boardView !== 'list',
                    [c('vertical')]: boardView === 'list',
                  },
                ])}
                triggerTypes={boardScrollTiggers}
              >
                <div>
                  <Sortable axis={axis}>
                    <Lanes lanes={boardData.children} collapseDir={axis} phoneLane={phoneLane} />
                    <SortPlaceholder
                      accepts={boardAccepts}
                      className={c('lane-placeholder')}
                      index={boardData.children.length}
                    />
                  </Sortable>
                </div>
              </ScrollContainer>
              )}
            </div>
          </FilterContext.Provider>
        </SearchContext.Provider>
      </KanbanContext.Provider>
    </DndScope>
  );
};
