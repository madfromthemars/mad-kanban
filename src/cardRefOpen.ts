import { Notice } from 'obsidian';

import type KanbanPlugin from './main';
import { buildCardIndex } from './cardRefs';
import { CardDetailModal } from './components/Item/CardDetailModal';
import { c } from './components/helpers';
import { getBoardModifiers } from './helpers/boardModifiers';

/** Open the card a chip points at (chips carry data-card-ref + data-board). */
export function openCardRef(plugin: KanbanPlugin, el: HTMLElement) {
  const id = el.dataset.cardRef;
  const boardPath = el.dataset.board;
  if (!id) return;
  let stateManager = null;
  for (const [file, sm] of plugin.stateManagers) if (file.path === boardPath) stateManager = sm;
  if (!stateManager?.state) return;

  const info = buildCardIndex(stateManager.state).get(id);
  if (!info) {
    new Notice('That card was deleted, or you can’t see it.');
    return;
  }
  if (info.archived) {
    new Notice(`“${info.title}” is in the archive.`);
    return;
  }

  const lanes = stateManager.state.children;
  for (let l = 0; l < lanes.length; l++) {
    const i = lanes[l].children.findIndex((it) => it.id === info.itemId);
    if (i < 0) continue;
    const view = stateManager.getAView();
    if (!view) return;
    const boardModifiers = getBoardModifiers(view, stateManager);
    const kanbanContext = { view, stateManager, boardModifiers, filePath: stateManager.file.path };
    new CardDetailModal(
      plugin.app,
      lanes[l].children[i],
      stateManager,
      boardModifiers,
      [l, i],
      view,
      kanbanContext
    ).open();
    return;
  }
}

/** One capture-phase listener per window: a chip click opens its card instead of the card it sits in. */
export function bindCardRefClicks(plugin: KanbanPlugin, win: Window) {
  const sel = `.${c('card-ref')}[data-card-ref]`;
  const onClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement | null)?.closest?.(sel) as HTMLElement | null;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    openCardRef(plugin, el);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const el = (e.target as HTMLElement | null)?.closest?.(sel) as HTMLElement | null;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    openCardRef(plugin, el);
  };
  // Also swallow the dblclick, so the card window's "double-click to edit" doesn't fire.
  const onDbl = (e: MouseEvent) => {
    if ((e.target as HTMLElement | null)?.closest?.(sel)) e.stopPropagation();
  };
  plugin.registerDomEvent(win.document, 'click', onClick, { capture: true });
  plugin.registerDomEvent(win.document, 'dblclick', onDbl, { capture: true });
  plugin.registerDomEvent(win.document, 'keydown', onKey, { capture: true });
}
