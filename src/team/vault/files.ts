// A "Passwords" file in every project folder of the shared notes (Team/<project>/Passwords.mkpass).
// Opening it shows that project's passwords in a normal tab. The file holds NO secrets — only
// which project it belongs to — and shared-notes sync ignores it (ignoredPath in notes/merge.ts).
// It can't be deleted or renamed away: we put it back.

import { FileView, Notice, TFile, TFolder, WorkspaceLeaf } from 'obsidian';

import type { TeamManager } from '../TeamManager';
import { VaultPanel } from './ui';

export const PASSWORDS_EXT = 'mkpass';
export const PASSWORDS_FILE = `Passwords.${PASSWORDS_EXT}`;
export const PASSWORDS_VIEW = 'mad-kanban-passwords';

const fileText = (projectId: string, name: string) =>
  JSON.stringify(
    {
      'mad-kanban': 'passwords',
      project: projectId,
      note: `Opens the ${name} passwords in Mad Kanban. No passwords are stored in this file.`,
    },
    null,
    2
  ) + '\n';

export class PasswordFiles {
  /** path -> projectId of files we keep. */
  private managed = new Map<string, string>();
  private busy = false;
  private again = false;
  private cleanups: (() => void)[] = [];
  /** Events we cause ourselves, "delete:<path>" / "rename:<new path>", each ignored once. */
  private own = new Set<string>();

  constructor(private team: TeamManager) {}

  start() {
    const vault = this.team.plugin.app.vault;
    const onDelete = vault.on('delete', (f) => this.onDelete(f.path));
    const onRename = vault.on('rename', (f, old) => this.onRename(f.path, old));
    this.cleanups.push(() => vault.offref(onDelete), () => vault.offref(onRename));
    const kick = (): void => void this.sync();
    this.team.emitter.on('notes', kick);
    this.team.emitter.on('vault', kick);
    this.cleanups.push(() => this.team.emitter.off('notes', kick), () => this.team.emitter.off('vault', kick));
    let offNotes: (() => void) | null = null;
    let offVault: (() => void) | null = null;
    const rehook = () => {
      offNotes?.();
      offVault?.();
      offNotes = this.team.notes ? toOff(this.team.notes.onChange(kick)) : null;
      offVault = this.team.vault ? toOff(this.team.vault.onChange(kick)) : null;
    };
    this.team.emitter.on('notes', rehook);
    this.team.emitter.on('vault', rehook);
    this.cleanups.push(
      () => this.team.emitter.off('notes', rehook),
      () => this.team.emitter.off('vault', rehook),
      () => offNotes?.(),
      () => offVault?.()
    );
    rehook();
    kick();
  }

  destroy() {
    for (const c of this.cleanups.splice(0)) c();
  }

  projectOf(path: string) {
    return this.managed.get(path) ?? null;
  }

  /** Wanted files: one per project folder I'm a member of. */
  private wanted() {
    const notes = this.team.notes;
    const vault = this.team.vault;
    const out = new Map<string, { id: string; name: string }>();
    if (!notes || !vault || vault.state === 'loading' || vault.state === 'offline') return null;
    const member = new Map(vault.projects.map((p) => [p.id, p.name]));
    for (const [pid, folder] of notes.folders) {
      if (!member.has(pid)) continue;
      out.set(`${notes.root}/${folder}/${PASSWORDS_FILE}`, { id: pid, name: member.get(pid)! });
    }
    return out;
  }

  async sync() {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.again = false;
        await this.syncOnce();
      } while (this.again);
    } finally {
      this.busy = false;
    }
  }

  private async syncOnce() {
    const want = this.wanted();
    if (!want) return; // not known yet (offline / loading): leave files alone
    const app = this.team.plugin.app;
    // Remove ours that aren't wanted any more (left the project).
    for (const [path] of this.managed) {
      if (want.has(path)) continue;
      this.managed.delete(path);
      const f = app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) await this.quiet(`delete:${path}`, () => app.vault.delete(f));
    }
    for (const [path, p] of want) {
      this.managed.set(path, p.id);
      const f = app.vault.getAbstractFileByPath(path);
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (!(app.vault.getAbstractFileByPath(parent) instanceof TFolder)) continue;
      const text = fileText(p.id, p.name);
      if (!f) await app.vault.create(path, text).catch(() => {});
      else if (f instanceof TFile && (await app.vault.read(f)) !== text) await app.vault.modify(f, text);
    }
  }

  private async quiet<T>(key: string, fn: () => Promise<T>) {
    this.own.add(key);
    try {
      return await fn();
    } finally {
      window.setTimeout(() => this.own.delete(key), 2000);
    }
  }

  private onDelete(path: string) {
    if (this.own.delete(`delete:${path}`) || !this.managed.has(path)) return;
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (!(this.team.plugin.app.vault.getAbstractFileByPath(parent) instanceof TFolder)) return; // whole folder went
    new Notice("Mad Kanban: the Passwords file opens this project's passwords, so it can't be deleted.", 6000);
    window.setTimeout((): void => void this.sync(), 300);
  }

  private onRename(path: string, old: string) {
    if (this.own.delete(`rename:${path}`) || !this.managed.has(old)) return;
    const app = this.team.plugin.app;
    // Its folder was renamed (project renamed): fine, the next sync picks up the new path.
    if (path.endsWith(`/${PASSWORDS_FILE}`) && path.slice(0, path.lastIndexOf('/')) !== old.slice(0, old.lastIndexOf('/'))) {
      const oldParent = old.slice(0, old.lastIndexOf('/'));
      if (!(app.vault.getAbstractFileByPath(oldParent) instanceof TFolder)) {
        this.managed.delete(old);
        window.setTimeout((): void => void this.sync(), 300);
        return;
      }
    }
    new Notice("Mad Kanban: the Passwords file stays in its project folder with its name.", 6000);
    window.setTimeout(async (): Promise<void> => {
      const f = app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) return void this.sync();
      if (app.vault.getAbstractFileByPath(old)) await this.quiet(`delete:${path}`, () => app.vault.delete(f));
      else await this.quiet(`rename:${old}`, () => app.fileManager.renameFile(f, old));
      void this.sync();
    }, 300);
  }
}

const toOff = (r: unknown) => (typeof r === 'function' ? (r as () => void) : () => {});

/** The tab a Passwords file opens in. */
export class PasswordsView extends FileView {
  private panel: VaultPanel | null = null;
  allowNoFile = false;

  constructor(
    leaf: WorkspaceLeaf,
    private team: TeamManager
  ) {
    super(leaf);
  }

  getViewType() {
    return PASSWORDS_VIEW;
  }

  getIcon() {
    return 'key-round';
  }

  getDisplayText() {
    const folder = this.file?.parent?.name;
    return folder ? `Passwords · ${folder}` : 'Passwords';
  }

  canAcceptExtension(ext: string) {
    return ext === PASSWORDS_EXT;
  }

  async onLoadFile(file: TFile) {
    this.render(file);
    const again = () => this.file === file && this.render(file);
    this.team.emitter.on('vault', again);
    this.register(() => this.team.emitter.off('vault', again));
  }

  async onUnloadFile() {
    this.panel?.destroy();
    this.panel = null;
  }

  private async render(file: TFile) {
    this.panel?.destroy();
    this.panel = null;
    const el = this.contentEl;
    el.empty();
    el.addClass('mk-vault-modal', 'mk-vault-page');
    let projectId = this.team.passwordFiles?.projectOf(file.path) ?? null;
    if (!projectId) {
      try {
        projectId = JSON.parse(await this.app.vault.read(file))?.project ?? null;
      } catch {
        projectId = null;
      }
    }
    const vault = this.team.vault;
    if (!vault) {
      el.createDiv({ cls: 'mk-vault-empty', text: 'Connect to your team (Settings → Mad Kanban) to see passwords.' });
      return;
    }
    const head = el.createDiv({ cls: 'mk-vault-page-head' });
    head.createEl('h2', { text: `${file.parent?.name ?? ''} passwords` });
    const body = el.createDiv();
    this.panel = new VaultPanel(this.app, this.team, vault, body, projectId, true);
  }
}
