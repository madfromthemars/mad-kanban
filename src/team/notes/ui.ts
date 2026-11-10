// Shared notes UI: status bar, Trash, version history.

import { App, Modal, Notice, TFile, setIcon } from 'obsidian';

import type { TeamManager } from '../TeamManager';
import type { TeamDoc } from '../TeamClient';
import type { NotesSync } from './NotesSync';

const when = (t: number, seconds = false) => {
  const d = new Date(t);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) };
  return same ? `Today, ${d.toLocaleTimeString([], time)}` : d.toLocaleString([], { month: 'short', day: 'numeric', ...time });
};

export function statusBar(el: HTMLElement, sync: NotesSync) {
  el.addClass('mk-notes-status');
  const render = () => {
    el.empty();
    const icon = el.createSpan({ cls: 'mk-notes-status-icon' });
    setIcon(icon, sync.status === 'synced' ? 'cloud' : sync.status === 'syncing' ? 'refresh-cw' : 'cloud-off');
    el.createSpan({ text: ` Team notes: ${sync.statusText || sync.status}` });
    el.setAttr('aria-label', 'Shared project notes');
  };
  render();
  return sync.onChange(render);
}

export class NotesTrashModal extends Modal {
  constructor(
    app: App,
    private manager: TeamManager,
    private sync: NotesSync
  ) {
    super(app);
  }

  async onOpen() {
    this.modalEl.addClass('mk-notes-modal');
    this.titleEl.setText('Team notes: Trash');
    const body = this.contentEl.createDiv({ cls: 'mk-notes-list' });
    body.createDiv({ cls: 'mk-notes-empty', text: 'Loading…' });
    let docs: TeamDoc[] = [];
    try {
      docs = await this.manager.client.docsTrash();
    } catch (e) {
      body.empty();
      body.createDiv({ cls: 'mk-notes-empty', text: `Couldn't load the Trash: ${(e as Error).message}` });
      return;
    }
    body.empty();
    if (!docs.length) {
      body.createDiv({ cls: 'mk-notes-empty', text: 'Nothing here. Deleted shared notes stay for 30 days.' });
      return;
    }
    body.createDiv({ cls: 'mk-notes-hint', text: 'Deleted shared notes stay here for 30 days.' });
    for (const d of docs) {
      const row = body.createDiv({ cls: 'mk-notes-row' });
      const text = row.createDiv({ cls: 'mk-notes-row-text' });
      text.createDiv({ cls: 'mk-notes-row-title', text: d.path.split('/').pop() || d.path });
      const project = this.sync.projects.get(d.projectId)?.name ?? '';
      const who = this.manager.users.find((u) => u.id === d.deletedBy)?.name ?? 'someone';
      text.createDiv({ cls: 'mk-notes-row-sub', text: `${project} / ${d.path} · deleted by ${who}, ${when(d.deletedAt!)}` });
      const btn = row.createEl('button', { text: 'Restore', cls: 'mod-cta' });
      btn.onclick = async () => {
        btn.disabled = true;
        const doc = await this.sync.restore(d.id);
        if (doc) {
          row.remove();
          new Notice(`Restored "${doc.path}"`);
        } else btn.disabled = false;
      };
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class NotesVersionsModal extends Modal {
  private selected: number | null = null;

  constructor(
    app: App,
    private manager: TeamManager,
    private sync: NotesSync,
    private file: TFile
  ) {
    super(app);
  }

  async onOpen() {
    this.modalEl.addClass('mk-notes-modal', 'mk-notes-versions');
    this.titleEl.setText(`Version history: ${this.file.basename}`);
    const id = this.sync.docIdForPath(this.file.path);
    if (!id) {
      this.contentEl.createDiv({ cls: 'mk-notes-empty', text: 'This file is not a shared team note.' });
      return;
    }
    const wrap = this.contentEl.createDiv({ cls: 'mk-notes-versions-wrap' });
    const list = wrap.createDiv({ cls: 'mk-notes-list' });
    const preview = wrap.createDiv({ cls: 'mk-notes-preview' });
    list.createDiv({ cls: 'mk-notes-empty', text: 'Loading…' });
    let versions: { id: number; at: number; by: string[] }[] = [];
    try {
      versions = await this.manager.client.docVersions(id);
    } catch (e) {
      list.empty();
      list.createDiv({ cls: 'mk-notes-empty', text: `Couldn't load versions: ${(e as Error).message}` });
      return;
    }
    list.empty();
    if (!versions.length) {
      list.createDiv({ cls: 'mk-notes-empty', text: 'No earlier versions yet. A copy is kept before each editing session (at most every 10 minutes).' });
      return;
    }
    const pre = preview.createEl('pre', { cls: 'mk-notes-preview-text' });
    const actions = preview.createDiv({ cls: 'mk-notes-preview-actions' });
    const restore = actions.createEl('button', { text: 'Restore this version', cls: 'mod-cta' });
    restore.disabled = true;
    pre.setText('Pick a version to see it.');
    let content = '';
    const rows: HTMLElement[] = [];
    versions.forEach((v, i) => {
      const row = list.createDiv({ cls: 'mk-notes-row is-clickable' });
      rows.push(row);
      const text = row.createDiv({ cls: 'mk-notes-row-text' });
      text.createDiv({ cls: 'mk-notes-row-title', text: when(v.at, true) });
      text.createDiv({ cls: 'mk-notes-row-sub', text: v.by.length ? `then edited by ${v.by.join(', ')}` : 'first saved copy' });
      row.onclick = async () => {
        rows.forEach((r) => r.removeClass('is-selected'));
        row.addClass('is-selected');
        this.selected = v.id;
        pre.setText('Loading…');
        restore.disabled = true;
        try {
          content = await this.manager.client.docVersion(id, v.id);
          if (this.selected !== v.id) return;
          if (this.file.extension === 'canvas') {
            try {
              const d = JSON.parse(content);
              const texts = (d.nodes || []).map((n: any) => n.text || n.file || n.url || n.label || '').filter(Boolean);
              pre.setText(`${(d.nodes || []).length} boxes, ${(d.edges || []).length} arrows\n\n${texts.join('\n\n')}`);
            } catch {
              pre.setText(content);
            }
          } else pre.setText(content || '(empty)');
          restore.disabled = false;
        } catch (e) {
          pre.setText(`Couldn't load: ${(e as Error).message}`);
        }
      };
      if (i === 0) row.click();
    });
    restore.onclick = async () => {
      restore.disabled = true;
      await this.sync.restoreVersion(id, content);
      new Notice('Version restored. Everyone sees it now; the previous text is kept in the history.');
      this.close();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}
