import Preact from 'preact/compat';
import { Path } from 'src/dnd/types';
import { BoardModifiers } from 'src/helpers/boardModifiers';
import { StateManager } from 'src/StateManager';

import { c } from '../helpers';
import { Item } from '../types';

interface PriorityButtonProps {
  item: Item;
  path: Path;
  boardModifiers: BoardModifiers;
  stateManager: StateManager;
}

const priorityCycle: { value: string | null; label: string }[] = [
  { value: null, label: '' },
  { value: '0', label: '\uD83D\uDD3A' },  // Highest
  { value: '1', label: '\u23EB' },         // High
  { value: '2', label: '\uD83D\uDD3C' },  // Medium
  { value: '4', label: '\uD83D\uDD3D' },  // Low
];

const priorityLabelMap: Record<string, string> = {
  '0': '\uD83D\uDD3A',
  '1': '\u23EB',
  '2': '\uD83D\uDD3C',
  '4': '\uD83D\uDD3D',
};

const priorityRegex = /\[priority::\s*[^\]]*\]/g;

export const PriorityButton = Preact.memo(function PriorityButton({
  item,
  path,
  boardModifiers,
  stateManager,
}: PriorityButtonProps) {
  const currentPriority = item.data.metadata.priority;

  const currentIndex = priorityCycle.findIndex((p) =>
    p.value === null
      ? !currentPriority || currentPriority === '3'
      : p.value === currentPriority
  );

  const label =
    currentPriority && priorityLabelMap[currentPriority]
      ? priorityLabelMap[currentPriority]
      : '';

  const onClick = Preact.useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      const nextIndex = (currentIndex + 1) % priorityCycle.length;
      const next = priorityCycle[nextIndex];

      let newTitleRaw = item.data.titleRaw.replace(priorityRegex, '').trim();
      if (next.value !== null) {
        newTitleRaw = `${newTitleRaw} [priority:: ${next.value}]`;
      }

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
      aria-label="Cycle priority"
    >
      {label}
    </a>
  );
});
