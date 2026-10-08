import Preact from 'preact/compat';
import { Path } from 'src/dnd/types';
import { BoardModifiers } from 'src/helpers/boardModifiers';
import { StateManager } from 'src/StateManager';
import { setPriorityInTitle } from 'src/kanbanFileHelpers';
import { PriorityIcon, priorityLevel } from './PriorityIcon';

import { c } from '../helpers';
import { Item } from '../types';

interface PriorityButtonProps {
  item: Item;
  path: Path;
  boardModifiers: BoardModifiers;
  stateManager: StateManager;
}

const priorityCycle: (string | null)[] = [null, '0', '1', '2', '4'];

export const PriorityButton = Preact.memo(function PriorityButton({
  item,
  path,
  boardModifiers,
  stateManager,
}: PriorityButtonProps) {
  const currentPriority = item.data.metadata.priority;

  const current = currentPriority && currentPriority !== '3' ? currentPriority : null;
  const currentIndex = Math.max(0, priorityCycle.indexOf(current));

  const onClick = Preact.useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      const nextIndex = (currentIndex + 1) % priorityCycle.length;
      const next = priorityCycle[nextIndex];

      const newTitleRaw = setPriorityInTitle(item.data.titleRaw, next);

      boardModifiers.updateItem(
        path,
        stateManager.updateItemContent(item, newTitleRaw)
      );
    },
    [item, path, boardModifiers, stateManager, currentIndex]
  );

  return (
    <a
      data-ignore-drag={true}
      onPointerDown={(e: PointerEvent) => e.preventDefault()}
      onClick={(e) => onClick(e as unknown as MouseEvent)}
      className={`${c('priority-button')} clickable-icon`}
      aria-label={`Priority: ${priorityLevel(current).label} (click to change)`}
    >
      {current && <PriorityIcon value={current} />}
    </a>
  );
});
