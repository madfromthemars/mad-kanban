import { useEffect, useRef } from 'preact/compat';
import { laneKey } from 'src/team/laneKey';

import { Icon } from './Icon/Icon';
import { c } from './helpers';
import { Lane } from './types';

/** Phones show one list at a time; this is the remembered choice per board. */
const storeKey = (filePath: string) => `mad-kanban-phone-lane:${filePath}`;
const laneId = (lane: Lane) => laneKey(lane.data.title || '') || lane.data.title || '';

export function readPhoneLane(filePath: string): string | null {
  try {
    return window.localStorage.getItem(storeKey(filePath));
  } catch {
    return null;
  }
}

export function savePhoneLane(filePath: string, lane: Lane) {
  try {
    window.localStorage.setItem(storeKey(filePath), laneId(lane));
  } catch {
    /* private mode etc. */
  }
}

export function resolvePhoneLane(lanes: Lane[], stored: string | null): number {
  if (!lanes.length) return 0;
  if (stored) {
    const i = lanes.findIndex((l) => laneId(l) === stored);
    if (i >= 0) return i;
  }
  return 0;
}

const STATUS_KEYS = new Set(['backlog', 'todo', 'inprogress', 'review', 'done', 'archive']);
const laneStatus = (title: string) => {
  const key = laneKey(title || '');
  return STATUS_KEYS.has(key) ? key : 'other';
};

interface PhoneLaneTabsProps {
  lanes: Lane[];
  active: number;
  counts: number[];
  filePath: string;
  onSelect: (index: number) => void;
  onMenu: () => void;
  onAdd: () => void;
}

/**
 * Phone board: one list on screen, picked from these tabs. While a card is dragged,
 * the other tabs are drop targets (data-kanban-zone="lane:<index>"): drop a card on a
 * tab to move it to the top of that list.
 */
export function PhoneLaneTabs({ lanes, active, counts, filePath, onSelect, onMenu, onAdd }: PhoneLaneTabsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the chosen tab in view when the row is wider than the screen.
  useEffect(() => {
    const el = scrollRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, lanes.length]);

  return (
    <div className={c('phone-tabs')}>
      <div className={c('phone-tabs-scroll')} ref={scrollRef} role="tablist">
        {lanes.map((lane, i) => (
          <button
            key={lane.id}
            role="tab"
            aria-selected={i === active}
            className={`${c('phone-tab')} ${i === active ? 'is-active' : ''}`}
            data-status={laneStatus(lane.data.title)}
            data-kanban-zone={i === active ? undefined : `lane:${i}`}
            data-kanban-zone-file={i === active ? undefined : filePath}
            onClick={() => onSelect(i)}
          >
            <span className={c('phone-tab-title')}>{lane.data.title}</span>
            <span className={c('phone-tab-count')}>{counts[i] ?? lane.children.length}</span>
          </button>
        ))}
      </div>
      <button className={`${c('phone-tabs-menu')} ${c('phone-tabs-add')}`} aria-label="Add a card" onClick={onAdd}>
        <Icon name="lucide-plus" />
      </button>
      <button className={c('phone-tabs-menu')} aria-label="List options" onClick={onMenu}>
        <Icon name="lucide-more-vertical" />
      </button>
    </div>
  );
}
