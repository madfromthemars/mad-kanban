import {
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  FuzzySuggestModal,
  Notice,
  TFile,
  setIcon,
} from 'obsidian';

import type KanbanPlugin from 'src/main';
import { kanbanViewType } from 'src/KanbanView';
import { CardRefInfo, CardRefStatus, cardRefTitle, rankCards } from 'src/cardRefs';
import { renderCardOption } from 'src/components/Editor/CardRefSuggest';
import { addExternalDropHandler } from 'src/dnd/externalDrop';
import { parseTeamItemId } from './ids';
import { openCardRef } from 'src/cardRefOpen';
import { laneKey } from './laneKey';
import type { CardInfo } from './TeamManager';
import { hueFor, initials } from './ui/TeamBadges';

/**
 * Team cards on canvases (docs/design/canvas-cards.md). A canvas text box whose whole text
 * is `@<cardId>` is drawn as that card (title, list, people). It's still a plain text box,
 * so shared-canvas sync, colors, groups and arrows work as usual. Clicking the title opens
 * the card window; double-clicking the box edits its text like any other box.
 */
const REF_ONLY = /^\s*@([a-z0-9]{6,12})\s*$/i;
const SCAN_MS = 1000;
const RELOAD_MS = 2 * 60 * 1000;
const BOX = { width: 260, height: 100 };

const STATUSES = new Set(['todo', 'inprogress', 'review', 'done', 'backlog']);

export class CanvasCards {
  private plugin: KanbanPlugin;
  private timer: number | null = null;
  private sigs = new WeakMap<any, string>();
  private lastLoad = 0;
  private loading: Promise<void> | null = null;

  constructor(plugin: KanbanPlugin) {
    this.plugin = plugin;
  }

  private get team() {
    return this.plugin.team;
  }

  start() {
    this.timer = window.setInterval(() => this.scan(), SCAN_MS);
    const onCards = () => this.scan(true);
    this.team.emitter.on('cards', onCards);
    this.plugin.register(() => this.team.emitter.off('cards', onCards));
    // Boards that aren't open here have no live sync: refetch them when the server says they changed.
    const onBoard = (boardId: string) => this.boardChanged(boardId);
    this.team.emitter.on('board.changed', onBoard);
    this.plugin.register(() => this.team.emitter.off('board.changed', onBoard));
    const ws = this.plugin.app.workspace;
    this.plugin.registerEvent(ws.on('layout-change', () => this.scan()));
    this.plugin.registerEvent(ws.on('active-leaf-change', () => this.scan()));
    this.plugin.registerEvent(
      this.plugin.app.vault.on('modify', (f) => f.path.endsWith('.canvas') && window.setTimeout(() => this.scan(), 50))
    );
    // Drag a card from a board and drop it on an open canvas.
    this.plugin.register(addExternalDropHandler((win, e, data) => this.dropTarget(win, e, data)));
    this.plugin.registerEditorSuggest(new CanvasCardSuggest(this));
    this.plugin.addCommand({
      id: 'canvas-add-team-card',
      name: 'Add a team card to this canvas',
      checkCallback: (checking) => {
        const canvas = this.activeCanvas();
        if (!canvas || !this.team.user) return false;
        if (!checking) void this.pickAndAdd(canvas);
        return true;
      },
    });
  }

  destroy() {
    if (this.timer != null) window.clearInterval(this.timer);
    this.timer = null;
    for (const t of this.boardTimers.values()) window.clearTimeout(t);
    this.boardTimers.clear();
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('canvas')) {
      const view = leaf.view as any;
      view?.containerEl?.querySelectorAll('.mk-canvas-add-card').forEach((el: HTMLElement) => el.remove());
      for (const node of view?.canvas?.nodes?.values?.() || []) this.clear(node);
    }
  }

  private activeCanvas(): any {
    const v = this.plugin.app.workspace.getMostRecentLeaf()?.view as any;
    return v?.getViewType?.() === 'canvas' ? v.canvas : null;
  }

  /** Draw/refresh every `@id` box in open canvases; `force` redraws even unchanged ones. */
  scan(force = false) {
    const missing = new Set<string>();
    const shown = new Set<string>();
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('canvas')) {
      const view = leaf.view as any;
      const canvas = view?.canvas;
      if (!canvas?.nodes) continue;
      this.addToolbarButton(view);
      for (const node of canvas.nodes.values()) {
        const data = node.getData?.();
        const m = data?.type === 'text' ? REF_ONLY.exec(data.text || '') : null;
        if (!m) {
          if (this.sigs.has(node)) this.clear(node);
          continue;
        }
        const id = m[1];
        const info = this.team.getCardInfo(id);
        if (!info) missing.add(id);
        else shown.add(info.boardId);
        const sig = this.signature(id, info);
        if (!force && this.sigs.get(node) === sig && node.contentEl?.querySelector('.mk-canvas-card')) continue;
        this.sigs.set(node, sig);
        this.render(node, id, info);
      }
    }
    this.shownBoards = shown;
    if (missing.size && this.team.user) void this.loadBoards(false);
  }

  private signature(id: string, info: CardInfo | null) {
    if (!info) return `missing|${id}|${this.loading ? 'loading' : ''}`;
    const c = info.card;
    const names = (c.assignees || []).map((a) => this.team.userName(a)).join(',');
    return [id, c.content.split('\n')[0], info.laneTitle, c.archived, names, c.projectId].join('|');
  }

  private clear(node: any) {
    this.sigs.delete(node);
    node.nodeEl?.classList.remove('mk-canvas-card-node');
    node.contentEl?.querySelectorAll(':scope > .mk-canvas-card').forEach((el: HTMLElement) => el.remove());
  }

  private render(node: any, id: string, info: CardInfo | null) {
    const host: HTMLElement | undefined = node.contentEl;
    if (!host) return;
    host.querySelectorAll(':scope > .mk-canvas-card').forEach((el) => el.remove());
    node.nodeEl?.classList.add('mk-canvas-card-node');
    const el = host.createDiv({ cls: 'mk-canvas-card' });
    if (!info) {
      el.addClass('is-missing');
      el.createDiv({ cls: 'mk-canvas-card-title', text: this.loading ? 'Loading card…' : 'Hidden card' });
      el.createDiv({ cls: 'mk-canvas-card-meta', text: `@${id} · deleted, or you can’t see it` });
      return;
    }
    const c = info.card;
    const key = c.archived ? 'archive' : laneKey(info.laneTitle || '');
    const status = c.archived ? 'archive' : STATUSES.has(key) ? key : 'other';
    el.addClass(`is-${status}`);
    const title = el.createDiv({ cls: 'mk-canvas-card-title', text: cardRefTitle(c.content) });
    title.setAttribute('role', 'link');
    title.title = 'Open the card';
    // Keep the canvas from starting a select/drag on the title, so a click opens the card.
    title.addEventListener('pointerdown', (e) => e.stopPropagation());
    title.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.open(id);
    });
    title.addEventListener('dblclick', (e) => e.stopPropagation());

    const meta = el.createDiv({ cls: 'mk-canvas-card-meta' });
    const lane = meta.createSpan({ cls: 'mk-canvas-card-lane' });
    lane.createSpan({ cls: `kanban-plugin__card-ref-dot is-${status}` });
    lane.createSpan({ text: c.archived ? 'Archive' : info.laneTitle || '—' });
    const people = meta.createSpan({ cls: 'mk-canvas-card-people' });
    const me = this.team.user?.id;
    const ids = [...(c.assignees || [])].sort((a, b) => (a === me ? -1 : b === me ? 1 : 0));
    for (const uid of ids.slice(0, 4)) {
      const name = this.team.userName(uid);
      const av = people.createSpan({ cls: 'kanban-plugin__assignee', text: initials(name) });
      if (uid === me) av.addClass('is-me');
      av.style.setProperty('--assignee-hue', String(hueFor(uid)));
      av.title = name;
    }
    if (ids.length > 4) people.createSpan({ cls: 'mk-canvas-card-more', text: `+${ids.length - 4}` });
  }

  private shownBoards = new Set<string>();
  private boardTimers = new Map<string, number>();

  private boardChanged(boardId: string) {
    if (!this.shownBoards.has(boardId) || this.team.hasSyncFor(boardId) || this.boardTimers.has(boardId)) return;
    this.boardTimers.set(
      boardId,
      window.setTimeout(async () => {
        this.boardTimers.delete(boardId);
        try {
          this.team.indexSnapshot(await this.team.client.board(boardId));
        } catch (e) {
          console.warn('[Kanban] canvas cards: could not reload board', e);
        }
      }, 400)
    );
  }

  /** The index only has cards of open boards and your own cards; fetch the rest. */
  loadBoards(force: boolean): Promise<void> {
    if (this.loading) return this.loading;
    if (!force && Date.now() - this.lastLoad < RELOAD_MS) return Promise.resolve();
    this.lastLoad = Date.now();
    this.loading = (async () => {
      try {
        const boards = await this.team.client.boards();
        for (const b of boards) {
          if (b.joined === false || this.team.hasSyncFor(b.id)) continue;
          this.team.indexSnapshot(await this.team.client.board(b.id));
        }
      } catch (e) {
        console.warn('[Kanban] canvas cards: could not load boards', e);
      } finally {
        this.loading = null;
        this.scan(true);
      }
    })();
    return this.loading;
  }

  /** Open the card window; the board opens beside the canvas if it isn't open yet. */
  async open(cardId: string) {
    const info = this.team.getCardInfo(cardId);
    if (!info) return new Notice('That card was deleted, or you can’t see it.');
    let file = this.team.findBoardFile(info.boardId);
    if (!file) {
      try {
        // Vault root: next to the canvas could be a shared Team/ folder.
        const snap = await this.team.client.joinBoard(info.boardId);
        file = await this.team.writeBoardFile(snap, this.plugin.app.vault.getRoot());
      } catch (e: any) {
        return new Notice(`Kanban: could not open the “${info.boardName || 'team'}” board (${e?.message || e})`);
      }
    }
    const ws = this.plugin.app.workspace;
    if (!this.plugin.stateManagers.get(file)?.state) {
      const leaf = ws.getLeaf('split');
      await leaf.setViewState({ type: kanbanViewType, state: { file: file.path } });
      for (let i = 0; i < 50 && !this.plugin.stateManagers.get(file)?.state; i++) await sleep(100);
    }
    const el = document.createElement('span');
    el.dataset.cardRef = cardId;
    el.dataset.board = file.path;
    openCardRef(this.plugin, el);
  }

  private addToolbarButton(view: any) {
    const menu: HTMLElement | null = view?.containerEl?.querySelector('.canvas-card-menu');
    if (!menu || menu.querySelector('.mk-canvas-add-card') || !this.team.user) return;
    const btn = menu.createDiv({ cls: 'canvas-card-menu-button mk-canvas-add-card' });
    // Icon names differ between Obsidian's lucide versions; take the first that exists.
    for (const icon of ['square-kanban', 'kanban-square', 'trello', 'layout-dashboard']) {
      setIcon(btn, icon);
      if (btn.querySelector('svg')) break;
    }
    btn.setAttribute('aria-label', 'Add a team card');
    btn.setAttribute('data-tooltip-position', 'top');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.pickAndAdd(view.canvas);
    });
  }

  async pickAndAdd(canvas: any) {
    const notice = this.team.cards.size ? null : new Notice('Loading cards…');
    await this.loadBoards(true);
    notice?.hide();
    const onCanvas = new Set<string>();
    for (const n of canvas.nodes.values()) {
      const m = REF_ONLY.exec(n.getData?.().text || '');
      if (m) onCanvas.add(m[1]);
    }
    const items = [...this.team.cards.entries()]
      .filter(([id, info]) => !info.card.archived && !onCanvas.has(id))
      .map(([id, info]) => ({ id, info }));
    new CardPicker(this.plugin, items, (id) => this.addBox(canvas, id)).open();
  }

  /** The canvas under the pointer (same window), with an action that adds the dragged card. */
  private dropTarget(win: Window, e: PointerEvent, data: any): (() => void) | null {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('canvas')) {
      const view = leaf.view as any;
      const canvas = view?.canvas;
      const el: HTMLElement | undefined = canvas?.wrapperEl || view?.contentEl;
      if (!canvas || !el || el.ownerDocument !== win.document) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue;
      const pos = this.canvasPos(canvas, e);
      return () => {
        const ref = parseTeamItemId(data?.id || '');
        if (!ref) return void new Notice('Only team board cards can go on a canvas.');
        this.addBox(canvas, ref.cardId, pos);
      };
    }
    return null;
  }

  private canvasPos(canvas: any, e: PointerEvent) {
    if (typeof canvas.posFromEvt === 'function') return canvas.posFromEvt(e);
    if (typeof canvas.posFromClient === 'function') return canvas.posFromClient({ x: e.clientX, y: e.clientY });
    return null;
  }

  /** Cards known to this device in the shape the `@` pickers use. */
  cardIndex(): Map<string, CardRefInfo> {
    const out = new Map<string, CardRefInfo>();
    for (const [id, info] of this.team.cards) {
      const key = info.card.archived ? 'archive' : laneKey(info.laneTitle || '');
      const status = (info.card.archived ? 'archive' : STATUSES.has(key) ? key : 'other') as CardRefStatus;
      out.set(id, {
        id,
        title: cardRefTitle(info.card.content),
        laneTitle: info.card.archived ? 'Archive' : info.laneTitle || '',
        status,
        archived: info.card.archived,
        itemId: id,
      });
    }
    return out;
  }

  addBox(canvas: any, cardId: string, at?: { x: number; y: number } | null) {
    const c = at || (typeof canvas.posCenter === 'function' ? canvas.posCenter() : { x: canvas.x || 0, y: canvas.y || 0 });
    const pos = { x: c.x - BOX.width / 2, y: c.y - BOX.height / 2 };
    canvas.createTextNode({ pos, size: { ...BOX }, text: `@${cardId}`, focus: false, save: true });
    canvas.requestSave?.();
    this.scan(true);
  }
}

/** `@` while typing in a canvas text box: team cards; picking one makes the box a card. */
class CanvasCardSuggest extends EditorSuggest<CardRefInfo> {
  constructor(private cards: CanvasCards) {
    super((cards as any).plugin.app);
    this.limit = 8;
  }

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    // Only canvas text boxes. Obsidian edits them inside an iframe, so look past it too.
    const dom: HTMLElement | undefined = (editor as any).cm?.dom;
    const frame = dom?.ownerDocument?.defaultView?.frameElement as HTMLElement | null | undefined;
    if (!dom?.closest?.('.canvas-node') && !frame?.closest?.('.canvas-node')) return null;
    const line = editor.getLine(cursor.line).slice(0, cursor.ch);
    const m = /(?:^|[\s([{"'«])@([^\s@{}[\]]{0,30})$/.exec(line);
    if (!m) return null;
    void this.cards.loadBoards(false);
    return { start: { line: cursor.line, ch: cursor.ch - m[1].length - 1 }, end: cursor, query: m[1] };
  }

  getSuggestions(ctx: EditorSuggestContext): CardRefInfo[] {
    return rankCards(this.cards.cardIndex(), ctx.query, null, 8);
  }

  renderSuggestion(card: CardRefInfo, el: HTMLElement) {
    renderCardOption(el, card);
  }

  selectSuggestion(card: CardRefInfo) {
    const ctx = this.context;
    if (!ctx) return;
    const text = `@${card.id}`;
    ctx.editor.replaceRange(text, ctx.start, ctx.end);
    ctx.editor.setCursor({ line: ctx.start.line, ch: ctx.start.ch + text.length });
    this.close();
  }
}

interface PickItem {
  id: string;
  info: CardInfo;
}

class CardPicker extends FuzzySuggestModal<PickItem> {
  constructor(
    private plugin: KanbanPlugin,
    private items: PickItem[],
    private onPick: (id: string) => void
  ) {
    super(plugin.app);
    this.setPlaceholder('Find a card to put on the canvas…');
  }

  getItems() {
    return this.items;
  }

  getItemText(it: PickItem) {
    const project = this.plugin.team.projects.find((p) => p.id === it.info.card.projectId)?.name || '';
    return `${cardRefTitle(it.info.card.content)} · ${it.info.laneTitle || ''} · ${project}`;
  }

  onChooseItem(it: PickItem) {
    this.onPick(it.id);
  }
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
