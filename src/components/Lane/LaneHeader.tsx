import update from 'immutability-helper';
import { Menu } from 'obsidian';
import { memo } from 'preact/compat';
import { Dispatch, StateUpdater, useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { useNestedEntityPath } from 'src/dnd/components/Droppable';
import { t } from 'src/lang/helpers';
import { parseLaneTitle } from 'src/parsers/helpers/parser';

import { getDropAction } from '../Editor/helpers';
import { Icon } from '../Icon/Icon';
import { FilterContext, KanbanContext } from '../context';
import { c, itemMatchesFilters } from '../helpers';
import { EditState, EditingState, Lane, isEditing } from '../types';
import { ConfirmAction, useSettingsMenu } from './LaneMenu';
import { LaneSettings } from './LaneSettings';
import { LaneLimitCounter, LaneTitle } from './LaneTitle';

interface LaneHeaderProps {
  lane: Lane;
  laneIndex: number;
  bindHandle: (el: HTMLElement) => void;
  setIsItemInputVisible?: Dispatch<StateUpdater<EditState>>;
  isCollapsed: boolean;
  toggleIsCollapsed: () => void;
}

interface LaneButtonProps {
  settingsMenu: Menu;
  editState: EditState;
  setEditState: Dispatch<StateUpdater<EditState>>;
  setIsItemInputVisible?: Dispatch<StateUpdater<EditState>>;
}

function LaneButtons({
  settingsMenu,
  editState,
  setEditState,
  setIsItemInputVisible,
}: LaneButtonProps) {
  const { stateManager } = useContext(KanbanContext);
  return (
    <div className={c('lane-settings-button-wrapper')}>
      {isEditing(editState) ? (
        <a
          onClick={() => setEditState(null)}
          aria-label={t('Close')}
          className={`${c('lane-settings-button')} is-enabled clickable-icon`}
        >
          <Icon name="lucide-x" />
        </a>
      ) : (
        <>
          {setIsItemInputVisible && (
            <a
              aria-label={t('Add a card')}
              className={`${c('lane-settings-button')} clickable-icon`}
              onClick={() => setIsItemInputVisible({ x: 0, y: 0 })}
              onDragOver={(e) => {
                if (getDropAction(stateManager, e.dataTransfer)) {
                  setIsItemInputVisible({ x: 0, y: 0 });
                }
              }}
            >
              <Icon name="lucide-plus-circle" />
            </a>
          )}
          <a
            aria-label={t('More options')}
            className={`${c('lane-settings-button')} clickable-icon`}
            onClick={(e) => {
              settingsMenu.showAtMouseEvent(e);
            }}
          >
            <Icon name="lucide-more-vertical" />
          </a>
        </>
      )}
    </div>
  );
}

export const LaneHeader = memo(function LaneHeader({
  lane,
  laneIndex,
  bindHandle,
  setIsItemInputVisible,
  isCollapsed,
  toggleIsCollapsed,
}: LaneHeaderProps) {
  const [editState, setEditState] = useState<EditState>(EditingState.cancel);
  const lanePath = useNestedEntityPath(laneIndex);

  const { boardModifiers } = useContext(KanbanContext);
  const { settingsMenu, confirmAction, setConfirmAction } = useSettingsMenu({
    setEditState,
    path: lanePath,
    lane,
  });

  useEffect(() => {
    if (lane.data.forceEditMode) {
      setEditState(null);
    }
  }, [lane.data.forceEditMode]);

  const onLaneTitleChange = useCallback(
    (str: string) => {
      const { title, maxItems } = parseLaneTitle(str);
      boardModifiers.updateLane(
        lanePath,
        update(lane, {
          data: {
            title: { $set: title },
            maxItems: { $set: maxItems },
          },
        })
      );
    },
    [boardModifiers, lane, lanePath]
  );

  // With filters on, the count shows how many of the list's cards are visible.
  const filterContext = useContext(FilterContext);
  const visibleCount = filterContext?.hasActiveFilters
    ? lane.children.filter((it) =>
        itemMatchesFilters(
          it,
          filterContext.filters,
          filterContext.cardBodyCache,
          filterContext.boardPath,
          filterContext.getAssignees,
          filterContext.meId
        )
      ).length
    : null;

  // Single click on the name collapses/expands the list; double click renames it.
  const clickTimer = useRef<number | null>(null);

  const onTitleClick = useCallback(
    (e: MouseEvent) => {
      if (isEditing(editState)) return;
      e.stopPropagation();
      if (clickTimer.current != null) window.clearTimeout(clickTimer.current);
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = null;
        toggleIsCollapsed();
      }, 220);
    },
    [editState, toggleIsCollapsed]
  );

  const onDoubleClick = useCallback(
    (e: MouseEvent) => {
      if (clickTimer.current != null) {
        window.clearTimeout(clickTimer.current);
        clickTimer.current = null;
      }
      // List names are fixed; a double click is just two clicks on the name.
    },
    [isCollapsed, setEditState]
  );

  return (
    <>
      <div
        // eslint-disable-next-line react/no-unknown-property
        onDblClick={onDoubleClick}
        className={c('lane-header-wrapper')}
      >
        <div
          className={c('lane-title-toggle')}
          onClick={onTitleClick}
          title={isEditing(editState) ? undefined : isCollapsed ? 'Expand list' : 'Collapse list'}
        >
          <LaneTitle
            id={lane.id}
            editState={editState}
            maxItems={lane.data.maxItems}
            onChange={onLaneTitleChange}
            setEditState={setEditState}
            title={lane.data.title}
          />
        </div>

        <LaneLimitCounter
          editState={editState}
          itemCount={lane.children.length}
          visibleCount={visibleCount}
          maxItems={lane.data.maxItems}
        />

        <LaneButtons
          editState={editState}
          setEditState={setEditState}
          setIsItemInputVisible={setIsItemInputVisible}
          settingsMenu={settingsMenu}
        />
      </div>

      <LaneSettings editState={editState} lane={lane} lanePath={lanePath} />

      {confirmAction && (
        <ConfirmAction
          lane={lane}
          action={confirmAction}
          onAction={() => {
            switch (confirmAction) {
              case 'archive':
                boardModifiers.archiveLane(lanePath);
                break;
              case 'archive-items':
                boardModifiers.archiveLaneItems(lanePath);
                break;
              case 'delete':
                boardModifiers.deleteEntity(lanePath);
                break;
            }

            setConfirmAction(null);
          }}
          cancel={() => setConfirmAction(null)}
        />
      )}
    </>
  );
});
