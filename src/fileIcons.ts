// Mad Kanban icons in Obsidian's file list:
// - kanban boards (anywhere): a board icon
// - files shared with the team (Team/<project>/…, once synced): note / canvas / attachment icon
// - the per-project Passwords file: a key (styles only, see .mkpass in styles.less)
// The file list has no API for this, so we mark its rows with data-mk-icon and style that.

import { TFile, debounce } from 'obsidian';

import type KanbanPlugin from './main';
import { hasFrontmatterKey } from './helpers';

type Kind = 'board' | 'note' | 'canvas' | 'file';

export class FileIcons {
  private observers: MutationObserver[] = [];
  private shared = new Set<string>();
  private offNotes: (() => void) | null = null;

  constructor(private plugin: KanbanPlugin) {}

  start() {
    const { app } = this.plugin;
    const refresh = debounce(
      () => {
        this.loadShared();
        this.refresh();
      },
      150,
      true
    );
    this.plugin.registerEvent(app.metadataCache.on('changed', refresh));
    this.plugin.registerEvent(app.vault.on('rename', refresh));
    // A new file in a project folder is shared a moment later.
    this.plugin.registerEvent(app.vault.on('create', () => (refresh(), window.setTimeout(refresh, 3000))));
    this.plugin.registerEvent(app.workspace.on('layout-change', () => {
      this.watch();
      refresh();
    }));
    const onNotes = () => {
      this.offNotes?.();
      const n = this.plugin.team?.notes;
      const r = n?.onChange(() => {
        this.loadShared();
        refresh();
      });
      this.offNotes = typeof r === 'function' ? (r as () => void) : null;
      this.loadShared();
      refresh();
    };
    this.plugin.team?.emitter.on('notes', onNotes);
    this.plugin.register(() => this.plugin.team?.emitter.off('notes', onNotes));
    app.workspace.onLayoutReady(() => {
      onNotes();
      this.watch();
      this.refresh();
    });
    this.plugin.register(() => this.destroy());
  }

  private destroy() {
    for (const o of this.observers.splice(0)) o.disconnect();
    this.offNotes?.();
    document.querySelectorAll('[data-mk-icon]').forEach((el) => el.removeAttribute('data-mk-icon'));
  }

  private loadShared() {
    const n = this.plugin.team?.notes;
    this.shared = new Set(n ? [...n.metas.values()].map((m) => m.localPath) : []);
  }

  /** Watch every file list for rows being added (folders opening, scrolling). */
  private watch() {
    for (const o of this.observers.splice(0)) o.disconnect();
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('file-explorer')) {
      const o = new MutationObserver((muts) => {
        for (const m of muts)
          for (const node of Array.from(m.addedNodes)) {
            if (!(node instanceof HTMLElement)) continue;
            if (node.matches('.nav-file-title[data-path]')) this.mark(node);
            node.querySelectorAll<HTMLElement>('.nav-file-title[data-path]').forEach((el) => this.mark(el));
          }
      });
      o.observe(leaf.view.containerEl, { childList: true, subtree: true });
      this.observers.push(o);
    }
  }

  refresh() {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('file-explorer'))
      leaf.view.containerEl.querySelectorAll<HTMLElement>('.nav-file-title[data-path]').forEach((el) => this.mark(el));
  }

  private kindOf(path: string): Kind | null {
    if (path.endsWith('.mkpass')) return null;
    const f = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return null;
    if (f.extension === 'md' && hasFrontmatterKey(this.plugin.app, f)) return 'board';
    if (!this.shared.has(path)) return null;
    return f.extension === 'md' ? 'note' : f.extension === 'canvas' ? 'canvas' : 'file';
  }

  private mark(el: HTMLElement) {
    const kind = this.kindOf(el.dataset.path || '');
    if (kind) {
      if (el.dataset.mkIcon !== kind) el.dataset.mkIcon = kind;
    } else if (el.dataset.mkIcon) delete el.dataset.mkIcon;
  }
}
