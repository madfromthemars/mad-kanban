/**
 * Drops of a board card outside the board (e.g. onto an open canvas). A handler looks at
 * where the pointer was released and returns an action to run, or null to ignore it.
 * When an action is returned the card isn't moved on the board.
 */
export type ExternalDropHandler = (win: Window, e: PointerEvent, data: any) => (() => void) | null;

const handlers = new Set<ExternalDropHandler>();

export function addExternalDropHandler(h: ExternalDropHandler) {
  handlers.add(h);
  return () => handlers.delete(h);
}

export function findExternalDrop(win: Window, e: PointerEvent, data: any): (() => void) | null {
  for (const h of handlers) {
    try {
      const act = h(win, e, data);
      if (act) return act;
    } catch (err) {
      console.error('[Kanban] external drop handler failed', err);
    }
  }
  return null;
}
