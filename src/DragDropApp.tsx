import classcat from 'classcat';
import update from 'immutability-helper';
import { Notice, TFile } from 'obsidian';
import { JSX, createPortal, memo, useCallback, useMemo } from 'preact/compat';

import { KanbanView } from './KanbanView';
import { DraggableItem } from './components/Item/Item';
import { DraggableLane } from './components/Lane/Lane';
import { KanbanContext } from './components/context';
import { c, maybeCompleteForMove } from './components/helpers';
import { Board, DataTypes, Item, Lane } from './components/types';
import { DndContext } from './dnd/components/DndContext';
import { DragOverlay } from './dnd/components/DragOverlay';
import { Entity, Nestable } from './dnd/types';
import {
  getEntityFromPath,
  insertEntity,
  moveEntity,
  removeEntity,
  updateEntity,
} from './dnd/util/data';
import { getBoardModifiers } from './helpers/boardModifiers';
import {
  addCardLinkToListFile,
  extractCardTitle,
  ensureFolder,
  getListFilePath,
  getListFolderPath,
  findCardFilePathInListFile,
  findCardFilePathInListFolder,
  sanitizeName,
  removeCardLinkFromListFile,
  updateLastMoved,
} from './kanbanFileHelpers';
import KanbanPlugin from './main';
import { StateManager } from './StateManager';
import { isTeamItem } from './team/ids';
import { frontmatterKey } from './parsers/common';
import {
  getTaskStatusDone,
  getTaskStatusPreDone,
  toggleTask,
} from './parsers/helpers/inlineMetadata';

export function createApp(win: Window, plugin: KanbanPlugin) {
  return <DragDropApp win={win} plugin={plugin} />;
}

async function moveCardArtifacts(
  stateManager: StateManager,
  fromListTitle: string,
  toListTitle: string,
  titleRaw: string
) {
  if (fromListTitle === toListTitle) return;

  const cardTitle = extractCardTitle(titleRaw);
  const cardName = sanitizeName(cardTitle);
  if (!cardName) return;

  const app = stateManager.app;
  const kanbanFile = stateManager.file;
  const vault = app.vault;
  const fromListFilePath = getListFilePath(kanbanFile, fromListTitle);
  const fromListFolderPath = getListFolderPath(kanbanFile, fromListTitle);
  const toListFilePath = getListFilePath(kanbanFile, toListTitle);
  const toListFolderPath = getListFolderPath(kanbanFile, toListTitle);

  // Try to find the card file - first in list file, then in folder
  let fromCardPath = await findCardFilePathInListFile(app, fromListFilePath, cardTitle);
  if (!fromCardPath) {
    fromCardPath = await findCardFilePathInListFolder(app, fromListFolderPath, cardTitle);
  }
  if (!fromCardPath) {
    console.debug(`[Kanban] Card file not found for "${cardTitle}" in "${fromListTitle}"`);
    return;
  }

  const basename = fromCardPath.split('/').pop() || '';
  const toCardPath = `${toListFolderPath}/${basename}`;

  // Ensure destination folder exists
  await ensureFolder(vault, toListFolderPath);

  // Move the file
  const fromFile = vault.getAbstractFileByPath(fromCardPath);
  if (fromFile instanceof TFile) {
    if (vault.getAbstractFileByPath(toCardPath)) {
      new Notice(`Card "${cardTitle}" already exists in "${toListTitle}".`);
      return;
    }

    await vault.rename(fromFile, toCardPath);

    // Update lastMoved timestamp in the card file
    const movedFile = vault.getAbstractFileByPath(toCardPath);
    if (movedFile instanceof TFile) {
      const content = await vault.read(movedFile);
      const updatedContent = updateLastMoved(content);
      await vault.modify(movedFile, updatedContent);
    }
  }

  // Update list file links
  await removeCardLinkFromListFile(app, fromListFilePath, fromCardPath);
  await addCardLinkToListFile(app, toListFilePath, toCardPath);
}

const View = memo(function View({ view }: { view: KanbanView }) {
  return createPortal(view.getPortal(), view.contentEl);
});

export function DragDropApp({ win, plugin }: { win: Window; plugin: KanbanPlugin }) {
  const views = plugin.useKanbanViews(win);
  const portals: JSX.Element[] = views.map((view) => <View key={view.id} view={view} />);

  const handleDrop = useCallback(
    (dragEntity: Entity, dropEntity: Entity) => {
      if (!dragEntity || !dropEntity) {
        return;
      }

      if (dragEntity.scopeId === 'htmldnd') {
        const data = dragEntity.getData();
        const stateManager = plugin.getStateManagerFromViewID(data.viewId, data.win);
        const dropPath = dropEntity.getPath();
        const destinationParent = getEntityFromPath(stateManager.state, dropPath.slice(0, -1));

        try {
          const items: Item[] = data.content.map((title: string) => {
            let item = stateManager.getNewItem(title, ' ');
            const isComplete = !!destinationParent?.data?.shouldMarkItemsComplete;

            if (isComplete) {
              item = update(item, { data: { checkChar: { $set: getTaskStatusPreDone() } } });
              const updates = toggleTask(item, stateManager.file);
              if (updates) {
                const [itemStrings, checkChars, thisIndex] = updates;
                const nextItem = itemStrings[thisIndex];
                const checkChar = checkChars[thisIndex];
                return stateManager.getNewItem(nextItem, checkChar);
              }
            }

            return update(item, {
              data: {
                checked: {
                  $set: !!destinationParent?.data?.shouldMarkItemsComplete,
                },
                checkChar: {
                  $set: destinationParent?.data?.shouldMarkItemsComplete
                    ? getTaskStatusDone()
                    : ' ',
                },
              },
            });
          });

          return stateManager.setState((board) => insertEntity(board, dropPath, items));
        } catch (e) {
          stateManager.setError(e);
          console.error(e);
          new Notice('Kanban: Error during card drop' + (e instanceof Error ? ': ' + e.message : ''));
        }

        return;
      }

      const dragPath = dragEntity.getPath();
      const dropPath = dropEntity.getPath();
      const dragEntityData = dragEntity.getData();
      const dropEntityData = dropEntity.getData();
      const [, sourceFile] = dragEntity.scopeId.split(':::');
      const [, destinationFile] = dropEntity.scopeId.split(':::');

      const inDropArea =
        dropEntityData.acceptsSort && !dropEntityData.acceptsSort.includes(dragEntityData.type);

      // Same board
      if (sourceFile === destinationFile) {
        const view = plugin.getKanbanView(dragEntity.scopeId, dragEntityData.win);
        const stateManager = plugin.stateManagers.get(view.file);

        if (inDropArea) {
          dropPath.push(0);
        }

        const boardSnapshot = stateManager.state;
        const entityToMove = getEntityFromPath(boardSnapshot, dragPath);
        const fromLaneTitle = boardSnapshot?.children?.[dragPath[0]]?.data?.title;
        const toLaneTitle = boardSnapshot?.children?.[dropPath[0]]?.data?.title;
        const needsMoveArtifacts =
          entityToMove?.type === DataTypes.Item &&
          !isTeamItem(entityToMove) &&
          fromLaneTitle &&
          toLaneTitle &&
          dragPath[0] !== dropPath[0];

        // Move file artifacts first, then update state
        if (needsMoveArtifacts) {
          void moveCardArtifacts(
            stateManager,
            fromLaneTitle,
            toLaneTitle,
            entityToMove.data.titleRaw
          ).then(() => {
            updateBoardState();
          });
          return;
        }

        updateBoardState();
        return;

        function updateBoardState() {
          stateManager.setState((board) => {
            const entity = getEntityFromPath(board, dragPath);
            const newBoard: Board = moveEntity(
              board,
              dragPath,
              dropPath,
              (entity) => {
                if (entity.type === DataTypes.Item) {
                  const { next } = maybeCompleteForMove(
                    stateManager,
                    board,
                    dragPath,
                    stateManager,
                    board,
                    dropPath,
                    entity
                  );
                  if (fromLaneTitle && toLaneTitle && dragPath[0] !== dropPath[0]) {
                    const cardTitle = extractCardTitle(next.data.titleRaw);
                    if (!cardTitle) return next;
                  }
                  return next;
                }
                return entity;
              },
              (entity) => {
                if (entity.type === DataTypes.Item) {
                  const { replacement } = maybeCompleteForMove(
                    stateManager,
                    board,
                    dragPath,
                    stateManager,
                    board,
                    dropPath,
                    entity
                  );
                  return replacement;
                }
              }
            );

            if (entity.type === DataTypes.Lane) {
              const from = dragPath.last();
              let to = dropPath.last();

              if (from < to) to -= 1;

              const collapsedState = view.getViewState('list-collapse');
              const op = (collapsedState: boolean[]) => {
                const newState = [...collapsedState];
                newState.splice(to, 0, newState.splice(from, 1)[0]);
                return newState;
              };

              view.setViewState('list-collapse', undefined, op);

              return update<Board>(newBoard, {
                data: { settings: { 'list-collapse': { $set: op(collapsedState) } } },
              });
            }

            // Remove sorting in the destination lane
            const destinationParentPath = dropPath.slice(0, -1);
            const destinationParent = getEntityFromPath(board, destinationParentPath);

            if (destinationParent?.data?.sorted !== undefined) {
              return updateEntity(newBoard, destinationParentPath, {
                data: {
                  $unset: ['sorted'],
                },
              });
            }

            return newBoard;
          });
        }
      }

      const sourceView = plugin.getKanbanView(dragEntity.scopeId, dragEntityData.win);
      const sourceStateManager = plugin.stateManagers.get(sourceView.file);
      const destinationView = plugin.getKanbanView(dropEntity.scopeId, dropEntityData.win);
      const destinationStateManager = plugin.stateManagers.get(destinationView.file);

      const dragged = getEntityFromPath(sourceStateManager.state, dragPath);
      if (
        isTeamItem(dragged) ||
        sourceStateManager.teamSync ||
        destinationStateManager.teamSync
      ) {
        new Notice('Kanban: team cards and lists can only be moved inside their own board');
        return;
      }

      sourceStateManager.setState((sourceBoard) => {
        const entity = getEntityFromPath(sourceBoard, dragPath);
        let replacementEntity: Nestable;

        destinationStateManager.setState((destinationBoard) => {
          if (inDropArea) {
            const parent = getEntityFromPath(destinationStateManager.state, dropPath);
            const shouldAppend =
              (destinationStateManager.getSetting('new-card-insertion-method') || 'append') ===
              'append';

            if (shouldAppend) dropPath.push(parent.children.length);
            else dropPath.push(0);
          }

          const toInsert: Nestable[] = [];

          if (entity.type === DataTypes.Item) {
            const { next, replacement } = maybeCompleteForMove(
              sourceStateManager,
              sourceBoard,
              dragPath,
              destinationStateManager,
              destinationBoard,
              dropPath,
              entity
            );
            replacementEntity = replacement;
            toInsert.push(next);
          } else {
            toInsert.push(entity);
          }

          if (entity.type === DataTypes.Lane) {
            const collapsedState = destinationView.getViewState('list-collapse');
            const val = sourceView.getViewState('list-collapse')[dragPath.last()];
            const op = (collapsedState: boolean[]) => {
              const newState = [...collapsedState];
              newState.splice(dropPath.last(), 0, val);
              return newState;
            };

            destinationView.setViewState('list-collapse', undefined, op);

            return update<Board>(insertEntity(destinationBoard, dropPath, toInsert), {
              data: { settings: { 'list-collapse': { $set: op(collapsedState) } } },
            });
          } else {
            return insertEntity(destinationBoard, dropPath, toInsert);
          }
        });

        if (entity.type === DataTypes.Lane) {
          const collapsedState = sourceView.getViewState('list-collapse');
          const op = (collapsedState: boolean[]) => {
            const newState = [...collapsedState];
            newState.splice(dragPath.last(), 1);
            return newState;
          };
          sourceView.setViewState('list-collapse', undefined, op);

          return update<Board>(removeEntity(sourceBoard, dragPath), {
            data: { settings: { 'list-collapse': { $set: op(collapsedState) } } },
          });
        } else {
          return removeEntity(sourceBoard, dragPath, replacementEntity);
        }
      });
    },
    [views]
  );

  if (portals.length)
    return (
      <DndContext win={win} onDrop={handleDrop}>
        {...portals}
        <DragOverlay>
          {(entity, styles) => {
            const [data, context] = useMemo(() => {
              if (entity.scopeId === 'htmldnd') {
                return [null, null];
              }

              const overlayData = entity.getData();

              const view = plugin.getKanbanView(entity.scopeId, overlayData.win);
              const stateManager = plugin.stateManagers.get(view.file);
              const data = getEntityFromPath(stateManager.state, entity.getPath());
              const boardModifiers = getBoardModifiers(view, stateManager);
              const filePath = view.file.path;

              return [
                data,
                {
                  view,
                  stateManager,
                  boardModifiers,
                  filePath,
                },
              ];
            }, [entity]);

            if (data?.type === DataTypes.Lane) {
              const boardView =
                context?.view.viewSettings[frontmatterKey] ||
                context?.stateManager.getSetting(frontmatterKey);
              const collapseState =
                context?.view.viewSettings['list-collapse'] ||
                context?.stateManager.getSetting('list-collapse');
              const laneIndex = entity.getPath().last();

              return (
                <KanbanContext.Provider value={context}>
                  <div
                    className={classcat([
                      c('drag-container'),
                      {
                        [c('horizontal')]: boardView !== 'list',
                        [c('vertical')]: boardView === 'list',
                      },
                    ])}
                    style={styles}
                  >
                    <DraggableLane
                      lane={data as Lane}
                      laneIndex={laneIndex}
                      isStatic={true}
                      isCollapsed={!!collapseState[laneIndex]}
                      collapseDir={boardView === 'list' ? 'vertical' : 'horizontal'}
                    />
                  </div>
                </KanbanContext.Provider>
              );
            }

            if (data?.type === DataTypes.Item) {
              return (
                <KanbanContext.Provider value={context}>
                  <div className={c('drag-container')} style={styles}>
                    <DraggableItem item={data as Item} itemIndex={0} isStatic={true} />
                  </div>
                </KanbanContext.Provider>
              );
            }

            return <div />;
          }}
        </DragOverlay>
      </DndContext>
    );
}
