import { Icon } from '../Icon/Icon';
import { c } from '../helpers';

/** Priority values as stored in `[priority:: x]`, with their icon (lucide) and label. */
export const PRIORITY_LEVELS: { value: string | null; key: string; label: string; icon: string }[] = [
  { value: null, key: 'none', label: 'None', icon: 'lucide-minus' },
  { value: '4', key: 'low', label: 'Low', icon: 'lucide-chevron-down' },
  { value: '2', key: 'medium', label: 'Medium', icon: 'lucide-equal' },
  { value: '1', key: 'high', label: 'High', icon: 'lucide-chevron-up' },
  { value: '0', key: 'highest', label: 'Highest', icon: 'lucide-chevrons-up' },
];

export function priorityLevel(value: string | null | undefined) {
  return PRIORITY_LEVELS.find((p) => p.value === value) || PRIORITY_LEVELS[0];
}

/** Colored priority icon (red highest … blue low, grey none). */
export function PriorityIcon({ value }: { value: string | null | undefined }) {
  const p = priorityLevel(value);
  return <Icon name={p.icon} className={`${c('priority-icon')} is-${p.key}`} />;
}
