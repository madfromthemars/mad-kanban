import { useContext } from 'preact/compat';

import { buildCardIndex, findCardRefs } from 'src/cardRefs';

import { fillChip } from './cardRefDom';
import { KanbanContext } from './context';

/**
 * Plain text with `@cardId` shown as chips (for places that don't render markdown, like
 * checklist items). Chip contents are filled by DOM, so `refreshCardRefChips` can update
 * them later without fighting Preact.
 */
export function RefText({ text }: { text: string }) {
  const { stateManager } = useContext(KanbanContext);
  if (!text || !text.includes('@') || !stateManager?.state) return <>{text}</>;
  const index = buildCardIndex(stateManager.state);
  const refs = findCardRefs(text, (id) => index.has(id));
  if (!refs.length) return <>{text}</>;
  const parts: any[] = [];
  let last = 0;
  refs.forEach((r, i) => {
    parts.push(text.slice(last, r.start));
    const info = index.get(r.id);
    parts.push(
      <span
        key={`${i}:${r.id}:${info?.title}:${info?.laneTitle}`}
        data-board={stateManager.file.path}
        ref={(el) => {
          if (el && el.dataset.cardRef !== r.id) fillChip(el, r.id, info);
        }}
      />
    );
    last = r.end;
  });
  parts.push(text.slice(last));
  return <>{parts}</>;
}

/** One chip for a known card id. */
export function CardChip({ id }: { id: string }) {
  const { stateManager } = useContext(KanbanContext);
  const info = stateManager?.state ? buildCardIndex(stateManager.state).get(id) : undefined;
  return (
    <span
      key={`${id}:${info?.title}:${info?.laneTitle}`}
      data-board={stateManager?.file?.path}
      ref={(el) => {
        if (el && el.dataset.cardRef !== id) fillChip(el, id, info);
      }}
    />
  );
}
