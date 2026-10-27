import { c } from './helpers';
import { CardRefInfo, buildCardIndex, findCardRefs } from 'src/cardRefs';
import type { StateManager } from 'src/StateManager';

/**
 * `@cardId` → chip in rendered markdown (board cards, card window description, comments).
 * Chips carry `data-card-ref` + `data-board` (board file path); a click anywhere opens the
 * referenced card (see `openCardRef` in main.ts). `refreshCardRefChips` re-labels chips
 * already on screen after the board changes (rendered previews are cached).
 */
const CHIP = c('card-ref');

export function fillChip(el: HTMLElement, id: string, info: CardRefInfo | undefined) {
  el.className = `${CHIP} ${info ? `is-${info.status}` : 'is-missing'}`;
  el.dataset.cardRef = id;
  el.setAttribute('role', 'link');
  el.setAttribute('tabindex', '0');
  el.title = info ? `${info.title} · ${info.laneTitle} (@${id})` : `Card @${id} not found (deleted or not visible to you)`;
  el.textContent = '';
  const doc = el.ownerDocument;
  const dot = doc.createElement('span');
  dot.className = c('card-ref-dot');
  const title = doc.createElement('span');
  title.className = c('card-ref-title');
  title.textContent = info ? info.title : 'card not found';
  el.append(dot, title);
  if (info) {
    const lane = doc.createElement('span');
    lane.className = c('card-ref-lane');
    lane.textContent = info.laneTitle;
    el.append(lane);
  }
}

/** Replace `@id` text with chips inside `root` (text nodes only; code and links are left alone). */
export function decorateCardRefs(root: HTMLElement, stateManager: StateManager | null | undefined) {
  if (!root || !stateManager?.state || !root.textContent?.includes('@')) return;
  const index = buildCardIndex(stateManager.state);
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeValue?.includes('@') && !n.parentElement?.closest(`code, pre, a, .${CHIP}, .${c('mention')}`)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.nodeValue || '';
    const refs = findCardRefs(text, (id) => index.has(id));
    if (!refs.length) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const r of refs) {
      frag.append(text.slice(last, r.start));
      const chip = doc.createElement('span');
      chip.dataset.board = stateManager.file.path;
      fillChip(chip, r.id, index.get(r.id));
      frag.append(chip);
      last = r.end;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

/** Update every chip of this board that is on screen (titles/lanes change while cached). */
export function refreshCardRefChips(stateManager: StateManager) {
  if (!stateManager?.state || !stateManager.file) return;
  const index = buildCardIndex(stateManager.state);
  const docs = new Set<Document>([document]);
  stateManager.viewSet?.forEach((v: any) => v?.containerEl?.ownerDocument && docs.add(v.containerEl.ownerDocument));
  const path = stateManager.file.path;
  for (const doc of docs) {
    doc.querySelectorAll<HTMLElement>(`.${CHIP}[data-card-ref]`).forEach((el) => {
      if (el.dataset.board !== path) return;
      const id = el.dataset.cardRef!;
      const info = index.get(id);
      const want = info ? `${info.status}|${info.title}|${info.laneTitle}` : 'missing';
      if (el.dataset.sig === want) return;
      el.dataset.sig = want;
      fillChip(el, id, info);
    });
  }
}
