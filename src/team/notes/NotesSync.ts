// Shared notes and canvases per project: `<root>/<project>/...` in the vault is kept in
// sync with the team server (server/notes.js). Notes and canvases are Yjs documents (live
// editing with cursors); other files are attachments synced whole.
// Design and rules: docs/design/shared-notes.md.

import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { around } from 'monkey-around';
import {
  EventRef,
  MarkdownView,
  Modal,
  Notice,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  editorInfoField,
  normalizePath,
} from 'obsidian';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import { yCollab, ySyncAnnotation } from 'y-codemirror.next';
import * as Y from 'yjs';

import type KanbanPlugin from '../../main';
import { DocOp, TeamApiError, TeamDoc } from '../TeamClient';
import type { TeamManager } from '../TeamManager';
import { hueFor } from '../ui/TeamBadges';
import {
  CanvasData,
  applyCanvas,
  canvasFromY,
  folderName,
  ignoredPath,
  kindOf,
  merge3,
  parseCanvas,
  renderCanvas,
  replaceCanvas,
  setText,
  splitTeamPath,
} from './merge';
import { DocMeta, NotesStore } from './store';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_UNSUB = 2;
/** Marks Yjs changes that came from the server. */
const SERVER = { server: true };
const FROM_FILE = 'file';
const FROM_CANVAS = 'canvas';
const FROM_STORE = 'store';
const IDLE_MS = 30000;
const OFFLINE_READY_MS = 1500;
const MAX_ATTACHMENT = 100 * 1024 * 1024;

/** One compartment for every editor; a NotesSync puts the live binding into it. */
export const NOTES_COMPARTMENT = new Compartment();

/** Registered once by the plugin: works with whichever NotesSync is running. */
/** Editors the person has typed in since they opened their file (see bind()). */
const typedIn = new WeakMap<EditorView, boolean>();
const isTyping = (tr: Transaction) =>
  tr.docChanged &&
  !tr.annotation(ySyncAnnotation) &&
  ['input', 'delete', 'move', 'undo', 'redo'].some((e) => tr.isUserEvent(e));

/** Registered once by the plugin: works with whichever NotesSync is running. */
export function notesEditorExtension(current: () => NotesSync | null) {
  return [
    NOTES_COMPARTMENT.of([]),
    // Remote edits stay out of the local undo history (undo only undoes your own typing).
    EditorState.transactionExtender.of((tr) =>
      tr.annotation(ySyncAnnotation) ? { annotations: Transaction.addToHistory.of(false) } : null
    ),
    // While a note is live, nothing may swap its whole text in one go (Obsidian reloading
    // the file from disk): the disk can be behind, and that would undo other people's edits.
    EditorState.transactionFilter.of((tr) => {
      if (!tr.docChanged || tr.annotation(ySyncAnnotation) || tr.annotation(Transaction.userEvent)) return tr;
      const c = NOTES_COMPARTMENT.get(tr.startState) as unknown;
      if (!Array.isArray(c) || !c.length || !tr.startState.doc.length) return tr;
      let whole = false;
      tr.changes.iterChangedRanges((fromA, toA) => {
        if (fromA === 0 && toA === tr.startState.doc.length) whole = true;
      });
      return whole ? [] : tr;
    }),
    ViewPlugin.fromClass(
      class {
        path: string | undefined;
        constructor(view: EditorView) {
          this.path = view.state.field(editorInfoField, false)?.file?.path;
          current()?.scheduleBind(0);
        }
        update(u: ViewUpdate) {
          const p = u.state.field(editorInfoField, false)?.file?.path;
          if (p !== this.path) {
            this.path = p;
            typedIn.delete(u.view);
            current()?.scheduleBind(0);
          } else if (u.transactions.some(isTyping)) typedIn.set(u.view, true);
        }
        destroy() {
          current()?.scheduleBind(0);
        }
      }
    ),
  ];
}

/** Small fast string hash (FNV-1a). */
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

const newDocId = () => {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
};
const b64 = (u8: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};

/** One open Yjs document. */
class LiveDoc {
  ydoc = new Y.Doc();
  awareness = new awarenessProtocol.Awareness(this.ydoc);
  synced = false;
  /** Has real content to work with: loaded from this device's store, or synced with the server. */
  known = false;
  failed: string | null = null;
  holds = new Map<string, number>();
  /** Hashes of recent texts of this doc: a file save that repeats one of them is an echo. */
  recent: number[] = [];
  idleTimer: number | null = null;
  saveTimer: number | null = null;
  writeTimer: number | null = null;
  private readyResolve!: () => void;
  ready = new Promise<void>((r) => (this.readyResolve = r));
  constructor(
    public id: string,
    public kind: 'md' | 'canvas'
  ) {
    this.awareness.setLocalState(null);
  }
  markReady() {
    this.readyResolve();
  }
  get held() {
    let n = 0;
    for (const v of this.holds.values()) n += v;
    return n;
  }
}

interface CanvasHook {
  canvas: any;
  id: string;
  unhook: () => void;
  shown: CanvasData;
  timer: number | null;
}

export class NotesSync {
  plugin: KanbanPlugin;
  manager: TeamManager;
  store: NotesStore;
  root: string;
  metas = new Map<string, DocMeta>();
  serverDocs = new Map<string, TeamDoc>();
  projects = new Map<string, { id: string; name: string }>();
  /** projectId -> folder name under root */
  folders = new Map<string, string>();
  live = new Map<string, LiveDoc>();
  status: 'off' | 'offline' | 'syncing' | 'synced' | 'error' = 'offline';
  statusText = '';
  pending = 0;
  readonly compartment = NOTES_COMPARTMENT;

  private destroyed = false;
  private started = false;
  private events: { from: { offref(r: EventRef): void }; ref: EventRef }[] = [];
  private offs: (() => void)[] = [];
  private expected = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private opQueue: { op: DocOp; done: (doc: TeamDoc | null, err?: unknown) => void }[] = [];
  private opTimer: number | null = null;
  private bound = new WeakMap<EditorView, string>();
  private boundViews = new Set<EditorView>();
  private bindTimer: number | null = null;
  private hooks = new Map<any, CanvasHook>();
  private noticed = new Set<string>();
  private uploadTimers = new Map<string, number>();
  private listeners = new Set<() => void>();

  constructor(plugin: KanbanPlugin, manager: TeamManager) {
    this.plugin = plugin;
    this.manager = manager;
    this.root = plugin.settings['team-notes-folder'] || 'Team';
    const host = (() => {
      try {
        return new URL(manager.client.conn!.url).host;
      } catch {
        return 'server';
      }
    })();
    this.store = new NotesStore(`mk-notes-${(plugin.app as any).appId || plugin.app.vault.getName()}-${host}-${manager.user?.id}`);
  }

  get app() {
    return this.plugin.app;
  }
  get client() {
    return this.manager.client;
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private setStatus(s: NotesSync['status'], text = '') {
    this.status = s;
    this.statusText = text;
    this.listeners.forEach((f) => f());
  }

  // ---------- lifecycle ----------

  async start() {
    try {
      await this.startInner();
    } catch (e) {
      // Turned off (or the account changed) while starting: nothing to report.
      if (!this.destroyed) throw e;
    }
  }

  private async startInner() {
    if (this.started) return;
    this.started = true;
    // First run on this vault: never take over a "Team" folder the person already uses.
    if (!this.plugin.settings['team-notes-folder']) {
      const existing = this.app.vault.getAbstractFileByPath(this.root);
      if (existing instanceof TFolder && this.descendants(existing).some((c) => c instanceof TFile)) {
        this.root = 'Team (shared)';
        new Notice(`Mad Kanban: you already have a "Team" folder, so shared project notes go into "${this.root}".`, 12000);
      }
      this.plugin.settings['team-notes-folder'] = this.root;
      await this.plugin.saveSettings();
    }
    for (const m of await this.store.allMeta()) this.metas.set(m.id, m);
    const folders = await this.store.get<[string, string][]>('folders');
    if (folders) this.folders = new Map(folders);
    if (this.destroyed) return;

    const vault = this.app.vault;
    const ws = this.app.workspace;
    const on = (from: any, ref: EventRef) => this.events.push({ from, ref });
    on(vault, vault.on('create', (f) => void this.serial(() => this.onCreate(f))));
    on(vault, vault.on('modify', (f) => void this.serial(() => this.onModify(f))));
    on(vault, vault.on('rename', (f, old) => void this.serial(() => this.onRename(f, old))));
    on(vault, vault.on('delete', (f) => void this.serial(() => this.onDelete(f))));
    on(ws, ws.on('layout-change', () => {
      this.scheduleBind();
      this.hookCanvases();
    }));
    on(ws, ws.on('file-open', () => this.scheduleBind()));
    const onBinary = (u8: Uint8Array) => this.onBinary(u8);
    const onEvent = (ev: any) => this.onServerEvent(ev);
    const onStatus = (s: string) => {
      if (s === 'connected') void this.serial(() => this.fullSync());
      else if (s !== 'connecting') {
        for (const d of this.live.values()) d.synced = false;
        this.setStatus('offline', 'offline: changes are kept and sync later');
      }
    };
    this.client.emitter.on('binary', onBinary);
    this.client.emitter.on('event', onEvent);
    this.client.emitter.on('status', onStatus);
    this.offs.push(
      () => this.client.emitter.off('binary', onBinary),
      () => this.client.emitter.off('event', onEvent),
      () => this.client.emitter.off('status', onStatus)
    );
    this.scheduleBind();
    this.hookCanvases();
    if (this.client.status === 'connected') void this.serial(() => this.fullSync());
    else this.setStatus('offline', 'offline');
  }

  async destroy() {
    this.destroyed = true;
    this.events.forEach((e) => e.from.offref(e.ref));
    this.offs.forEach((f) => f());
    for (const v of [...this.boundViews]) this.unbind(v);
    for (const h of [...this.hooks.values()]) this.unhookCanvas(h);
    for (const d of [...this.live.values()]) await this.dropLive(d, true);
    if (this.opTimer != null) window.clearTimeout(this.opTimer);
    this.uploadTimers.forEach((t) => window.clearTimeout(t));
    await this.store.close().catch(() => {});
  }

  /** Tree work runs one at a time, so a full sync and file events never interleave. */
  private serial<T>(fn: () => Promise<T> | T): Promise<T | undefined> {
    const next = this.chain.then(
      () => (this.destroyed ? undefined : fn()),
      () => (this.destroyed ? undefined : fn())
    );
    this.chain = next.catch((e) => {
      console.error('[Mad Kanban notes]', e);
      this.plugin.reportWarning?.('notes', e);
    });
    return next as Promise<T | undefined>;
  }

  // ---------- own writes (so our file events don't echo back) ----------

  /** We're about to cause this exact event (create / rename-to / delete of a path): skip it once. */
  private expect(kind: 'create' | 'rename' | 'delete', path: string) {
    this.expected.set(`${kind}:${path}`, Date.now() + 10000);
  }
  /** Content we're about to write: its modify event is ours (compared by content, not time). */
  private expectedText = new Map<string, number>();
  private wasExpected(kind: 'create' | 'rename' | 'delete', path: string) {
    const key = `${kind}:${path}`;
    const until = this.expected.get(key);
    if (until == null) return false;
    this.expected.delete(key);
    return until >= Date.now();
  }

  private async ensureFolder(path: string) {
    const parts = path.split('/');
    let cur = '';
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      const f = this.app.vault.getAbstractFileByPath(cur);
      if (f instanceof TFolder) continue;
      if (f) throw new Error(`"${cur}" is a file, expected a folder`);
      this.expect('create', cur);
      await this.app.vault.createFolder(cur).catch((e) => {
        if (!(this.app.vault.getAbstractFileByPath(cur) instanceof TFolder)) throw e;
      });
    }
  }

  private parentOf(path: string) {
    const i = path.lastIndexOf('/');
    return i < 0 ? '' : path.slice(0, i);
  }

  private async writeText(path: string, text: string) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      if ((await this.app.vault.read(f)) === text) return;
      this.expectedText.set(path, hash(text));
      await this.app.vault.modify(f, text);
    } else {
      await this.ensureFolder(this.parentOf(path));
      this.expect('create', path);
      await this.app.vault.create(path, text);
    }
  }

  private async writeBinary(path: string, data: ArrayBuffer) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      this.expectedText.set(path, -data.byteLength - 1);
      await this.app.vault.modifyBinary(f, data);
    } else {
      await this.ensureFolder(this.parentOf(path));
      this.expect('create', path);
      await this.app.vault.createBinary(path, data);
    }
  }

  private async moveLocal(from: string, to: string) {
    const f = this.app.vault.getAbstractFileByPath(from);
    if (!f || from === to) return;
    if (this.app.vault.getAbstractFileByPath(to)) return; // something already there
    await this.ensureFolder(this.parentOf(to));
    this.expect('rename', to);
    if (f instanceof TFolder) for (const c of this.descendants(f)) this.expect('rename', to + c.path.slice(from.length));
    await this.app.fileManager.renameFile(f, to);
  }

  private async removeLocal(path: string) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f) return;
    this.expect('delete', path);
    if (f instanceof TFolder) for (const c of this.descendants(f)) this.expect('delete', c.path);
    await this.app.vault.delete(f, true);
  }

  private descendants(folder: TFolder): TAbstractFile[] {
    const out: TAbstractFile[] = [];
    const walk = (f: TFolder) => {
      for (const c of f.children) {
        out.push(c);
        if (c instanceof TFolder) walk(c);
      }
    };
    walk(folder);
    return out;
  }

  // ---------- paths ----------

  localPathFor(doc: { projectId: string; path: string }) {
    const folder = this.folders.get(doc.projectId);
    return folder ? normalizePath(`${this.root}/${folder}/${doc.path}`) : null;
  }

  /** Vault path -> project + path inside it, if it's in a known project folder. */
  private place(path: string): { projectId: string; rel: string } | null {
    const s = splitTeamPath(this.root, path);
    if (!s || ignoredPath(s.rel)) return null;
    for (const [pid, folder] of this.folders) if (folder === s.folder && this.projects.has(pid)) return { projectId: pid, rel: s.rel };
    return null;
  }

  metaByPath(path: string) {
    for (const m of this.metas.values()) if (m.localPath === path) return m;
    return null;
  }

  private async saveMeta(m: DocMeta) {
    this.metas.set(m.id, m);
    await this.store.putMeta(m);
  }

  private async dropMeta(id: string) {
    this.metas.delete(id);
    await this.store.deleteDoc(id);
  }

  // ---------- full sync (on connect, team changes, "Sync now") ----------

  async fullSync() {
    if (this.destroyed || !this.client.socketOpen) return;
    this.setStatus('syncing', 'syncing…');
    let res;
    try {
      res = await this.client.docs();
    } catch (e) {
      if (e instanceof TeamApiError && e.status === 404) {
        this.setStatus('off', 'the team server is too old for shared notes');
        return;
      }
      this.setStatus('error', `can't reach the server`);
      return;
    }
    // Live docs subscribe again (offline edits go up through the Yjs handshake).
    for (const d of this.live.values()) this.subscribe(d);

    await this.syncProjects(res.projects);
    this.serverDocs = new Map(res.docs.map((d) => [d.id, d]));

    // 1) Docs gone from the server (deleted, moved to a project we can't see): remove here.
    //    Docs created here while offline go up now.
    for (const m of [...this.metas.values()]) {
      if (this.serverDocs.has(m.id)) continue;
      if (m.syncedAt === 0) {
        await this.uploadOfflineCreated(m);
        continue;
      }
      await this.removeLocal(m.localPath);
      await this.dropMeta(m.id);
    }

    // 2) Every server doc: right place, fresh content.
    const fetches: TeamDoc[] = [];
    for (const doc of this.serverDocs.values()) {
      const want = this.localPathFor(doc);
      if (!want) continue;
      const m = this.metas.get(doc.id);
      if (m && m.localPath !== want) {
        if (this.app.vault.getAbstractFileByPath(m.localPath) && !this.app.vault.getAbstractFileByPath(want)) {
          await this.moveLocal(m.localPath, want);
        }
        await this.saveMeta({ ...m, localPath: want, projectId: doc.projectId });
      }
      const file = this.app.vault.getAbstractFileByPath(want);
      const meta = this.metas.get(doc.id);
      if (doc.kind === 'file' && meta?.dirty && file instanceof TFile) this.scheduleUpload(meta, file);
      else if (!(file instanceof TFile)) fetches.push(doc);
      else if (!meta) fetches.push(doc); // a file already there: adopt or keep a copy
      else if (doc.updatedAt > meta.syncedAt || meta.dirty) fetches.push(doc);
      else if (file.stat.mtime > (meta as any).mtime + 2000) await this.onModify(file); // changed while we weren't looking
    }

    // 3) Local files in project folders that the server doesn't know: new, share them.
    for (const [pid, folder] of this.folders) {
      if (!this.projects.has(pid)) continue;
      const dir = this.app.vault.getAbstractFileByPath(`${this.root}/${folder}`);
      if (!(dir instanceof TFolder)) continue;
      for (const f of this.descendants(dir)) {
        if (!(f instanceof TFile) || this.metaByPath(f.path)) continue;
        const known = [...this.serverDocs.values()].some((d) => this.localPathFor(d) === f.path);
        if (!known) await this.shareNewFile(f);
      }
    }

    this.pending = fetches.length;
    this.setStatus('syncing', `syncing ${this.pending}…`);
    await this.runPool(fetches, 4, async (doc) => {
      await this.fetchDoc(doc).catch((e) => console.warn('[Mad Kanban notes] fetch', doc.path, e));
      this.pending--;
      if (this.pending) this.setStatus('syncing', `syncing ${this.pending}…`);
    });
    this.setStatus(this.client.socketOpen ? 'synced' : 'offline', this.client.socketOpen ? 'synced' : 'offline');
  }

  private async runPool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) await fn(items[i++]);
      })
    );
  }

  /** Project folders: create, follow renames, remove ones we lost (if nothing unshared is inside). */
  private async syncProjects(projects: { id: string; name: string }[]) {
    this.projects = new Map(projects.map((p) => [p.id, p]));
    await this.ensureFolder(this.root);
    const taken = new Set<string>();
    const next = new Map<string, string>();
    for (const p of projects) {
      let name = folderName(p.name);
      for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${folderName(p.name)} (${i})`;
      taken.add(name.toLowerCase());
      next.set(p.id, name);
    }
    for (const [pid, name] of next) {
      const old = this.folders.get(pid);
      const want = `${this.root}/${name}`;
      if (old && old !== name && this.app.vault.getAbstractFileByPath(`${this.root}/${old}`) && !this.app.vault.getAbstractFileByPath(want)) {
        await this.moveLocal(`${this.root}/${old}`, want);
        for (const m of this.metas.values()) {
          if (m.projectId === pid && m.localPath.startsWith(`${this.root}/${old}/`)) {
            await this.saveMeta({ ...m, localPath: want + m.localPath.slice(`${this.root}/${old}`.length) });
          }
        }
      } else if (!this.app.vault.getAbstractFileByPath(want)) {
        await this.ensureFolder(want);
      }
    }
    // Projects we can't see anymore: their docs are removed in fullSync step 1; the folder
    // goes once it's empty.
    for (const [pid, old] of this.folders) {
      if (next.has(pid)) continue;
      this.folders.delete(pid);
      window.setTimeout((): void => {
        void this.serial(() => this.removeIfEmpty(`${this.root}/${old}`));
      }, 1000);
    }
    this.folders = next;
    await this.store.set('folders', [...next]);
  }

  private async removeIfEmpty(path: string) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFolder)) return;
    if (this.descendants(f).some((c) => c instanceof TFile)) {
      this.noticeOnce(`left:${path}`, `Mad Kanban: you're no longer in this project. "${path}" still has files that were never shared, so it was left in place.`);
      return;
    }
    await this.removeLocal(path);
  }

  private noticeOnce(key: string, text: string) {
    if (this.noticed.has(key)) return;
    this.noticed.add(key);
    new Notice(text, 10000);
  }

  // ---------- docs <-> disk ----------

  /** Bring one server doc to disk (content and place). */
  private async fetchDoc(doc: TeamDoc) {
    const path = this.localPathFor(doc);
    if (!path) return;
    const meta = this.metas.get(doc.id);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (doc.kind === 'file') {
      if (meta && meta.fileId === doc.fileId && file instanceof TFile) {
        await this.saveMeta({ ...meta, syncedAt: doc.updatedAt, dirty: false });
        return;
      }
      if (!meta && file instanceof TFile) await this.keepCopy(file);
      const data = await this.client.downloadFile(doc.fileId!);
      await this.writeBinary(path, data);
      await this.saveMeta({
        id: doc.id,
        projectId: doc.projectId,
        localPath: path,
        kind: 'file',
        syncedAt: doc.updatedAt,
        fileId: doc.fileId,
        version: doc.version,
        mtime: Date.now(),
      } as DocMeta);
      return;
    }
    const d = this.hold(doc.id, doc.kind, 'fetch');
    try {
      await d.ready;
      if (d.failed || !d.known) return;
      // Edits to the file that never reached the shared doc (made offline): merge them in.
      if (meta?.base != null && file instanceof TFile && !this.isBound(doc.id) && !this.isHooked(doc.id)) {
        const local = await this.app.vault.read(file);
        if (local !== meta.base) {
          if (doc.kind === 'md') {
            const yt = d.ydoc.getText('content');
            const merged = merge3(meta.base, local, yt.toString());
            d.ydoc.transact(() => setText(yt, merged), FROM_FILE);
          } else {
            const mine = local.trim() ? parseCanvas(local) : null;
            if (mine) d.ydoc.transact(() => applyCanvas(d.ydoc, parseCanvas(meta.base!), mine), FROM_FILE);
          }
        }
      }
      const text = this.render(d);
      if (!meta && file instanceof TFile) {
        const local = await this.app.vault.read(file);
        if (local !== text && local.trim()) await this.keepCopy(file);
      }
      if (!this.isBound(doc.id) && !this.isHooked(doc.id)) await this.writeText(path, text);
      await this.saveMeta({
        ...(meta || {}),
        id: doc.id,
        projectId: doc.projectId,
        localPath: path,
        kind: doc.kind,
        syncedAt: doc.updatedAt,
        base: text,
        dirty: false,
        version: doc.version,
        mtime: Date.now(),
      } as DocMeta);
    } finally {
      this.release(d, 'fetch');
    }
  }

  /** A local file in the way of a shared one: keep it outside the shared folder. */
  private async keepCopy(file: TFile) {
    const dir = `${this.root} conflicts`;
    await this.ensureFolder(dir);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const to = `${dir}/${file.basename} (${stamp}).${file.extension}`;
    const data = await this.app.vault.readBinary(file);
    this.expect('create', to);
    await this.app.vault.createBinary(to, data).catch(() => {});
    this.noticeOnce(`copy:${file.path}`, `Mad Kanban: "${file.path}" was replaced by the shared version. Your copy is in "${dir}".`);
  }

  private render(d: LiveDoc) {
    return d.kind === 'md' ? d.ydoc.getText('content').toString() : renderCanvas(canvasFromY(d.ydoc));
  }

  /** Write a live doc to disk after a remote change (unless an editor/canvas shows it live). */
  private scheduleWrite(d: LiveDoc) {
    if (d.writeTimer != null) window.clearTimeout(d.writeTimer);
    d.writeTimer = window.setTimeout(() => {
      d.writeTimer = null;
      void this.serial(async () => {
        const m = this.metas.get(d.id);
        if (!m || this.isBound(d.id)) return;
        if (this.isHooked(d.id)) {
          this.applyToCanvases(d);
          return;
        }
        const text = this.render(d);
        await this.writeText(m.localPath, text);
        const sd = this.serverDocs.get(d.id);
        await this.saveMeta({ ...m, base: text, syncedAt: Math.max(m.syncedAt, sd?.updatedAt ?? 0), mtime: Date.now() } as DocMeta);
      });
    }, 300);
  }

  // ---------- local file events ----------

  private async onCreate(f: TAbstractFile) {
    if (this.wasExpected('create', f.path) || !(f instanceof TFile)) return;
    if (!f.path.startsWith(this.root + '/')) return;
    if (this.metaByPath(f.path)) return;
    if (!this.place(f.path)) {
      if (!ignoredPath(f.path)) {
        this.noticeOnce(
          `place:${f.path}`,
          `Mad Kanban: "${f.name}" isn't shared. Put files inside a project folder (${this.root}/<project>/…).`
        );
      }
      return;
    }
    await this.shareNewFile(f);
  }

  /** A new local file inside a project folder: create the doc on the server. */
  private async shareNewFile(f: TFile) {
    const where = this.place(f.path);
    if (!where) return;
    const kind = kindOf(f.path);
    const id = newDocId();
    if (kind === 'file') {
      if (f.stat.size > MAX_ATTACHMENT) {
        this.noticeOnce(`big:${f.path}`, `Mad Kanban: "${f.name}" is over 100 MB and isn't shared.`);
        return;
      }
      if (!this.client.socketOpen) return; // shared on the next full sync
      const data = await this.app.vault.readBinary(f);
      const up = await this.client.uploadDocFile(f.name, mimeOf(f.extension), data);
      const doc = await this.op({ type: 'doc.create', id, projectId: where.projectId, path: where.rel, fileId: up.id, rename: true });
      if (doc) await this.adoptCreated(f, doc, { fileId: up.id });
      return;
    }
    const text = await this.app.vault.read(f);
    const ydoc = new Y.Doc();
    if (kind === 'md') ydoc.getText('content').insert(0, text);
    else replaceCanvas(ydoc, parseCanvas(text) ?? { nodes: [], edges: [] });
    const state = Y.encodeStateAsUpdate(ydoc);
    await this.store.putState(id, state);
    const meta: DocMeta = {
      id,
      projectId: where.projectId,
      localPath: f.path,
      kind,
      syncedAt: 0,
      base: kind === 'md' ? text : renderCanvas(canvasFromY(ydoc)),
      dirty: true,
    };
    await this.saveMeta(meta);
    if (!this.client.socketOpen) return; // goes up on reconnect (fullSync keeps dirty metas)
    const doc = await this.op({ type: 'doc.create', id, projectId: where.projectId, path: where.rel, update: b64(state), rename: true });
    if (doc) await this.adoptCreated(f, doc, {});
    else await this.dropMeta(id);
  }

  /** A note created while offline: create it on the server now with what we have. */
  private async uploadOfflineCreated(m: DocMeta) {
    const f = this.app.vault.getAbstractFileByPath(m.localPath);
    const where = this.place(m.localPath);
    if (!(f instanceof TFile) || !where) {
      await this.dropMeta(m.id);
      return;
    }
    if (m.kind === 'file') {
      await this.dropMeta(m.id);
      await this.shareNewFile(f);
      return;
    }
    const state = (await this.store.getState(m.id)) ?? new Uint8Array();
    const doc = await this.op({ type: 'doc.create', id: m.id, projectId: where.projectId, path: where.rel, update: b64(state), rename: true });
    if (doc) {
      await this.adoptCreated(f, doc, {});
      // Edits made after creating it offline are in the file: merge them on top.
      if ((await this.app.vault.read(f)) !== m.base) await this.onModify(f);
    }
  }

  private async adoptCreated(f: TFile, doc: TeamDoc, extra: Partial<DocMeta>) {
    this.serverDocs.set(doc.id, doc);
    const want = this.localPathFor(doc)!;
    if (want !== f.path) await this.moveLocal(f.path, want); // "name (2).md" on a clash
    const m = this.metas.get(doc.id);
    await this.saveMeta({
      ...(m || {}),
      id: doc.id,
      projectId: doc.projectId,
      localPath: want,
      kind: doc.kind,
      syncedAt: doc.updatedAt,
      dirty: false,
      version: doc.version,
      mtime: Date.now(),
      ...extra,
    } as DocMeta);
    this.scheduleBind();
    this.hookCanvases();
  }

  private async onModify(f: TAbstractFile): Promise<void> {
    if (!(f instanceof TFile)) return;
    const m = this.metaByPath(f.path);
    if (!m) return;
    const exp = this.expectedText.get(f.path);
    if (m.kind === 'file') {
      if (exp === -f.stat.size - 1) {
        this.expectedText.delete(f.path);
        return;
      }
      this.scheduleUpload(m, f);
      return;
    }
    const text = await this.app.vault.read(f);
    if (exp === hash(text)) {
      this.expectedText.delete(f.path);
      return;
    }
    if (text === m.base) return;
    // Canvases are compared by content, not by how the JSON happens to be formatted.
    const sig = hash(m.kind === 'canvas' ? renderCanvas(parseCanvas(text) ?? { nodes: [], edges: [] }) : text);
    const d0 = this.live.get(m.id);
    // An open canvas syncs through the canvas itself (see hookCanvas); its file saves are
    // just Obsidian writing what it shows. Never merge those back.
    if (m.kind === 'canvas' && this.isHooked(m.id) && d0?.known) {
      await this.saveMeta({ ...m, base: text, mtime: f.stat.mtime } as DocMeta);
      return;
    }
    // A save that repeats text the shared doc already had (Obsidian saving a live editor
    // or canvas, a bit late): nothing new in it.
    if (d0?.known && d0.recent.includes(sig)) {
      await this.saveMeta({ ...m, base: text, mtime: f.stat.mtime } as DocMeta);
      return;
    }
    const d = this.hold(m.id, m.kind, 'local');
    try {
      await d.ready;
      if (!d.known || d.failed) {
        // Offline and never loaded on this device: the merge happens when we're back online.
        await this.saveMeta({ ...m, dirty: true });
        return;
      }
      if (d.recent.includes(sig)) {
        await this.saveMeta({ ...m, base: text, mtime: f.stat.mtime } as DocMeta);
        return;
      }
      // Someone (another app, a plugin, a sync tool) changed the file: merge it in.
      if (m.kind === 'md') {
        const yt = d.ydoc.getText('content');
        const merged = merge3(m.base ?? '', text, yt.toString());
        d.ydoc.transact(() => setText(yt, merged), FROM_FILE);
      } else {
        const mine = parseCanvas(text);
        if (!mine) return; // half-written / broken JSON: wait for the next save
        // An empty file is a half-written save or a mistake, never "delete every box".
        if (!text.trim() && parseCanvas(m.base ?? '')?.nodes.length) return;
        d.ydoc.transact(() => applyCanvas(d.ydoc, m.base ? parseCanvas(m.base) : null, mine), FROM_FILE);
      }
      const now = this.render(d);
      const live = this.isBound(m.id) || this.isHooked(m.id);
      if (live && m.kind === 'canvas') this.applyToCanvases(d);
      // A live editor shows the merge itself (and Obsidian saves it); otherwise write it.
      if (!live && now !== text) await this.writeText(m.localPath, now);
      await this.saveMeta({ ...this.metas.get(m.id)!, base: live ? text : now, dirty: !this.client.socketOpen, mtime: Date.now() } as DocMeta);
    } finally {
      this.release(d, 'local');
    }
  }

  private scheduleUpload(m: DocMeta, f: TFile) {
    const old = this.uploadTimers.get(m.id);
    if (old != null) window.clearTimeout(old);
    this.uploadTimers.set(
      m.id,
      window.setTimeout(() => {
        this.uploadTimers.delete(m.id);
        void this.serial(async () => {
          const cur = this.metas.get(m.id);
          if (!cur) return;
          if (!this.client.socketOpen) {
            if (!cur.dirty) await this.saveMeta({ ...cur, dirty: true });
            return;
          }
          const data = await this.app.vault.readBinary(f);
          const up = await this.client.uploadDocFile(f.name, mimeOf(f.extension), data);
          const doc = await this.op({ type: 'doc.setFile', id: m.id, fileId: up.id });
          if (doc) await this.saveMeta({ ...cur, fileId: up.id, syncedAt: doc.updatedAt, version: doc.version, dirty: false, mtime: Date.now() } as DocMeta);
        });
      }, 1500)
    );
  }

  private async onRename(f: TAbstractFile, oldPath: string) {
    if (this.wasExpected('rename', f.path)) return;
    if (f instanceof TFolder) {
      // Renaming a project's own folder would unshare everything in it: rename the project instead.
      const s = splitTeamPath(this.root, `${oldPath}/x`);
      if (s && `${this.root}/${s.folder}` === oldPath && [...this.folders.values()].includes(s.folder)) {
        new Notice('Mad Kanban: project folders follow the project name. Rename the project in Manage team instead.', 8000);
        await this.moveLocal(f.path, oldPath);
      }
      return; // files inside get their own rename events
    }
    if (!(f instanceof TFile)) return;
    const m = this.metaByPath(oldPath);
    if (!m) {
      if (this.place(f.path)) await this.shareNewFile(f);
      return;
    }
    const to = this.place(f.path);
    if (!to) {
      // Its whole project folder was renamed: that rename is being undone (see the folder
      // case above), so this file comes back on its own. Never unshare because of it.
      const was = splitTeamPath(this.root, oldPath);
      if (was && !(this.app.vault.getAbstractFileByPath(`${this.root}/${was.folder}`) instanceof TFolder)) return;
      // Moved out of the shared folders: stop sharing it (it goes to the team's Trash).
      await this.op({ type: 'doc.delete', id: m.id });
      await this.dropMeta(m.id);
      new Notice(`Mad Kanban: "${f.name}" is no longer shared (it's in the team Trash).`, 6000);
      return;
    }
    if (to.projectId !== m.projectId) {
      const from = this.projects.get(m.projectId)?.name ?? 'its project';
      const target = this.projects.get(to.projectId)?.name ?? 'the other project';
      const ok = await confirm(this.app, `Share "${f.name}" with ${target} instead of ${from}?`, 'People who are only in ' + from + ' will lose it.');
      if (!ok) {
        await this.moveLocal(f.path, oldPath);
        return;
      }
    }
    await this.saveMeta({ ...m, localPath: f.path, projectId: to.projectId });
    const doc = await this.op({ type: 'doc.move', id: m.id, projectId: to.projectId, path: to.rel });
    if (!doc) {
      await this.saveMeta({ ...m });
      await this.moveLocal(f.path, oldPath);
    } else {
      this.serverDocs.set(doc.id, doc);
      const want = this.localPathFor(doc)!;
      if (want !== f.path) await this.moveLocal(f.path, want);
      await this.saveMeta({ ...this.metas.get(m.id)!, localPath: want, version: doc.version });
    }
  }

  private async onDelete(f: TAbstractFile) {
    if (this.wasExpected('delete', f.path)) return;
    const m = this.metaByPath(f.path);
    if (!m) return;
    await this.dropMeta(m.id);
    await this.op({ type: 'doc.delete', id: m.id });
  }

  /** Tree ops are batched for a moment (a folder move = many ops in one request). */
  private op(op: DocOp): Promise<TeamDoc | null> {
    return new Promise((resolve) => {
      this.opQueue.push({ op, done: (doc) => resolve(doc) });
      if (this.opTimer != null) return;
      this.opTimer = window.setTimeout((): void => {
        void this.flushOps();
      }, 80);
    });
  }

  private async flushOps() {
    this.opTimer = null;
    const batch = this.opQueue.splice(0);
    if (!batch.length) return;
    try {
      const r = await this.client.docOps(batch.map((b) => b.op));
      batch.forEach((b, i) => b.done(r.results[i]?.doc ?? null));
    } catch (e) {
      if (batch.length > 1) {
        // One bad op fails the whole batch on the server: retry one by one.
        for (const b of batch) {
          try {
            const r = await this.client.docOps([b.op]);
            b.done(r.results[0]?.doc ?? null);
          } catch (e2) {
            this.reportOpError(b.op, e2);
            b.done(null, e2);
          }
        }
      } else {
        this.reportOpError(batch[0].op, e);
        batch[0].done(null, e);
      }
    }
  }

  private reportOpError(op: DocOp, e: unknown) {
    const msg = e instanceof TeamApiError ? e.message : String((e as any)?.message || e);
    if (e instanceof TeamApiError && e.status === 0) return; // offline: next full sync redoes it
    new Notice(`Mad Kanban: couldn't ${op.type.replace('doc.', '')} a shared file: ${msg}`, 8000);
  }

  // ---------- server events ----------

  private onServerEvent(ev: any) {
    if (this.destroyed) return;
    if (ev.type === 'docs.changed') void this.serial(() => this.onDocChanged(ev.doc));
    else if (ev.type === 'docs.removed') void this.serial(() => this.onDocGone(ev.id));
    else if (ev.type === 'docs.touched') {
      const m = this.metas.get(ev.id);
      const sd = this.serverDocs.get(ev.id);
      if (sd) this.serverDocs.set(ev.id, { ...sd, updatedAt: ev.updatedAt });
      if (!this.live.has(ev.id) && sd && (!m || m.syncedAt < ev.updatedAt)) void this.serial(() => this.fetchDoc(this.serverDocs.get(ev.id)!));
    } else if (ev.type === 'team.changed') void this.serial(() => this.fullSync());
    else if (ev.type === 'doc.closed' || ev.type === 'doc.error') {
      const d = this.live.get(ev.id);
      if (d) {
        d.failed = ev.reason || ev.error || 'closed';
        d.markReady();
        if (ev.error === 'too large') new Notice('Mad Kanban: this shared note is too large to save more changes (10 MB).', 8000);
        void this.dropLive(d, false);
      }
    }
  }

  private async onDocChanged(doc: TeamDoc) {
    if (doc.deletedAt) return this.onDocGone(doc.id);
    this.serverDocs.set(doc.id, doc);
    const want = this.localPathFor(doc);
    if (!want) return;
    const m = this.metas.get(doc.id);
    if (m && m.localPath !== want) {
      await this.moveLocal(m.localPath, want);
      await this.saveMeta({ ...m, localPath: want, projectId: doc.projectId, version: doc.version });
      this.scheduleBind();
    }
    const cur = this.metas.get(doc.id);
    if (!cur || !(this.app.vault.getAbstractFileByPath(want) instanceof TFile) || (doc.kind === 'file' && cur.fileId !== doc.fileId)) {
      await this.fetchDoc(doc);
    }
  }

  private async onDocGone(id: string) {
    this.serverDocs.delete(id);
    const m = this.metas.get(id);
    const d = this.live.get(id);
    if (d) await this.dropLive(d, false);
    if (!m) return;
    for (const v of [...this.boundViews]) if (this.bound.get(v) === id) this.unbind(v);
    await this.removeLocal(m.localPath);
    await this.dropMeta(id);
  }

  // ---------- live docs ----------

  hold(id: string, kind: 'md' | 'canvas', reason: string): LiveDoc {
    let d = this.live.get(id);
    if (!d) {
      d = new LiveDoc(id, kind);
      this.live.set(id, d);
      void this.openLive(d);
    }
    if (d.idleTimer != null) {
      window.clearTimeout(d.idleTimer);
      d.idleTimer = null;
    }
    d.holds.set(reason, (d.holds.get(reason) || 0) + 1);
    return d;
  }

  release(d: LiveDoc, reason: string) {
    const n = (d.holds.get(reason) || 0) - 1;
    if (n > 0) d.holds.set(reason, n);
    else d.holds.delete(reason);
    if (d.held || d.idleTimer != null) return;
    d.idleTimer = window.setTimeout(() => {
      d.idleTimer = null;
      if (!d.held) void this.dropLive(d, true);
    }, IDLE_MS);
  }

  private async openLive(d: LiveDoc) {
    const state = await this.store.getState(d.id).catch((): null => null);
    if (state) {
      Y.applyUpdate(d.ydoc, state, FROM_STORE);
      d.known = true;
    }
    d.recent.push(hash(this.render(d)));
    d.ydoc.on('update', (update: Uint8Array, origin: any) => {
      // Save locally (offline edits survive a restart).
      if (d.saveTimer != null) window.clearTimeout(d.saveTimer);
      d.saveTimer = window.setTimeout(() => {
        d.saveTimer = null;
        void this.store.putState(d.id, Y.encodeStateAsUpdate(d.ydoc));
      }, 400);
      d.recent.push(hash(this.render(d)));
      if (d.recent.length > 300) d.recent.splice(0, d.recent.length - 300);
      if (origin === FROM_STORE) return;
      if (origin !== SERVER) {
        if (!this.send(d.id, MSG_SYNC, (enc) => syncProtocol.writeUpdate(enc, update))) {
          const m = this.metas.get(d.id);
          if (m && !m.dirty) void this.saveMeta({ ...m, dirty: true });
        }
      }
      // Remote edits reach the disk (local file edits are already there).
      if (origin !== FROM_FILE) {
        if (d.kind === 'canvas' && origin !== FROM_CANVAS && this.isHooked(d.id)) this.applyToCanvases(d);
        else if (origin === SERVER) this.scheduleWrite(d);
      }
    });
    d.awareness.on('update', ({ added, updated, removed }: any, origin: any) => {
      if (origin === SERVER) return;
      const changed = added.concat(updated, removed);
      this.send(d.id, MSG_AWARENESS, (enc) =>
        encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(d.awareness, changed))
      );
    });
    this.subscribe(d);
    if (!this.client.socketOpen) window.setTimeout(() => d.markReady(), state ? 0 : OFFLINE_READY_MS);
  }

  private subscribe(d: LiveDoc) {
    d.synced = false;
    this.send(d.id, MSG_SYNC, (enc) => syncProtocol.writeSyncStep1(enc, d.ydoc));
    if (d.awareness.getLocalState())
      this.send(d.id, MSG_AWARENESS, (enc) =>
        encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(d.awareness, [d.ydoc.clientID]))
      );
  }

  private async dropLive(d: LiveDoc, unsubscribe: boolean) {
    if (this.live.get(d.id) !== d) return;
    this.live.delete(d.id);
    if (d.idleTimer != null) window.clearTimeout(d.idleTimer);
    if (d.writeTimer != null) window.clearTimeout(d.writeTimer);
    if (d.saveTimer != null) window.clearTimeout(d.saveTimer);
    if (!d.failed) await this.store.putState(d.id, Y.encodeStateAsUpdate(d.ydoc)).catch(() => {});
    if (unsubscribe) this.send(d.id, MSG_UNSUB);
    d.awareness.destroy();
    d.ydoc.destroy();
  }

  private send(id: string, kind: number, write?: (enc: encoding.Encoder) => void) {
    const enc = encoding.createEncoder();
    encoding.writeVarString(enc, id);
    encoding.writeVarUint(enc, kind);
    write?.(enc);
    return this.client.sendBinary(encoding.toUint8Array(enc));
  }

  private onBinary(u8: Uint8Array) {
    try {
      const dec = decoding.createDecoder(u8);
      const id = decoding.readVarString(dec);
      const kind = decoding.readVarUint(dec);
      const d = this.live.get(id);
      if (!d) return;
      if (kind === MSG_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarString(enc, id);
        encoding.writeVarUint(enc, MSG_SYNC);
        const before = encoding.length(enc);
        const type = syncProtocol.readSyncMessage(dec, enc, d.ydoc, SERVER);
        if (encoding.length(enc) > before) this.client.sendBinary(encoding.toUint8Array(enc));
        if (type === syncProtocol.messageYjsSyncStep2 && !d.synced) {
          d.synced = true;
          d.known = true;
          d.markReady();
          this.scheduleBind();
          const m = this.metas.get(id);
          if (m?.dirty) void this.saveMeta({ ...m, dirty: false });
        }
      } else if (kind === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(d.awareness, decoding.readVarUint8Array(dec), SERVER);
      }
    } catch (e) {
      console.warn('[Mad Kanban notes] bad frame', e);
    }
  }

  // ---------- live editor (markdown) ----------

  scheduleBind(ms = 0) {
    if (this.destroyed || this.bindTimer != null) return;
    this.bindTimer = window.setTimeout(() => {
      this.bindTimer = null;
      void this.bindAll();
    }, ms);
  }

  isBound(id: string) {
    for (const v of this.boundViews) if (this.bound.get(v) === id) return true;
    return false;
  }

  /** Exactly one editor per shared note is live-bound (Obsidian keeps other panes of the same file in step). */
  private async bindAll() {
    if (this.destroyed) return;
    const views: { cm: EditorView; path: string }[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const v = leaf.view as MarkdownView;
      const cm = (v.editor as any)?.cm as EditorView | undefined;
      if (cm && v.file) views.push({ cm, path: v.file.path });
    }
    const seen = new Set<EditorView>();
    const taken = new Set<string>();
    for (const { cm, path } of views) {
      seen.add(cm);
      const id = this.metaByPath(path)?.id;
      const cur = this.bound.get(cm);
      // Obsidian resets the editor state when a pane switches files; our extension is gone then.
      const live = cur && this.compartment.get(cm.state) && (this.compartment.get(cm.state) as any[]).length !== 0;
      if (cur && (!live || cur !== id || taken.has(cur))) this.unbind(cm);
      if (!id || taken.has(id)) continue;
      taken.add(id);
      if (this.bound.get(cm) !== id) await this.bind(cm, id, path);
    }
    for (const v of [...this.boundViews]) if (!seen.has(v)) this.unbind(v);
  }

  private async bind(cm: EditorView, id: string, path: string) {
    const m = this.metas.get(id);
    if (!m || m.kind !== 'md') return;
    this.bound.set(cm, id);
    this.boundViews.add(cm);
    if (this.compartment.get(cm.state) === undefined) {
      // An editor opened before our extension was registered: refresh and try again.
      this.bound.delete(cm);
      this.boundViews.delete(cm);
      this.app.workspace.updateOptions();
      this.scheduleBind(200);
      return;
    }
    const d = this.hold(id, 'md', 'editor');
    await d.ready;
    // Still showing the same file? (Not loaded yet while offline: stay a plain editor; binds after sync.)
    if (this.bound.get(cm) !== id || (cm.state.field(editorInfoField, false) as any)?.file?.path !== path || d.failed || !d.known) {
      if (this.bound.get(cm) === id) this.unbind(cm);
      return;
    }
    // Wait until Obsidian has loaded the file into the editor (an editor that is still
    // empty must never count as "everything deleted").
    const file = this.app.vault.getAbstractFileByPath(path);
    for (let i = 0; i < 30 && file instanceof TFile && !typedIn.get(cm); i++) {
      if (cm.state.doc.toString() === (await this.app.vault.cachedRead(file))) break;
      await new Promise((r) => window.setTimeout(r, 100));
    }
    if (this.bound.get(cm) !== id || (cm.state.field(editorInfoField, false) as any)?.file?.path !== path) {
      if (this.bound.get(cm) === id) this.unbind(cm);
      return;
    }
    const yt = d.ydoc.getText('content');
    const shown = cm.state.doc.toString();
    // Only what the person really typed before the binding was ready is merged in.
    if (typedIn.get(cm) && shown !== yt.toString() && m.base != null) {
      const merged = merge3(m.base, shown, yt.toString());
      d.ydoc.transact(() => setText(yt, merged), FROM_FILE);
    }
    const hue = hueFor(this.manager.user?.id || 'me');
    // (setLocalStateField does nothing while the state is null, so set the whole state.)
    d.awareness.setLocalState({
      ...(d.awareness.getLocalState() || {}),
      user: {
        name: this.manager.user?.name || 'Me',
        color: `hsl(${hue} 65% 45%)`,
        colorLight: `hsla(${hue}, 65%, 45%, 0.18)`,
      },
    });
    const want = yt.toString();
    const cur = cm.state.doc.toString();
    cm.dispatch({
      changes: cur === want ? undefined : { from: 0, to: cur.length, insert: want },
      effects: this.compartment.reconfigure(yCollab(yt, d.awareness, { undoManager: false })),
      annotations: [Transaction.addToHistory.of(false)],
    });
  }

  private unbind(cm: EditorView) {
    const id = this.bound.get(cm);
    this.bound.delete(cm);
    this.boundViews.delete(cm);
    if (!id) return;
    try {
      if (this.compartment.get(cm.state)) cm.dispatch({ effects: this.compartment.reconfigure([]) });
    } catch {
      /* editor already gone */
    }
    const d = this.live.get(id);
    if (!d) return;
    if (!this.isBound(id)) d.awareness.setLocalState(null);
    this.release(d, 'editor');
    // The file on disk may be behind remote edits Obsidian didn't save after closing.
    this.scheduleWrite(d);
  }

  // ---------- live canvas ----------

  isHooked(id: string) {
    for (const h of this.hooks.values()) if (h.id === id) return true;
    return false;
  }

  hookCanvases() {
    if (this.destroyed) return;
    const open = new Set<any>();
    for (const leaf of this.app.workspace.getLeavesOfType('canvas')) {
      const view = leaf.view as any;
      const canvas = view?.canvas;
      const m = view?.file ? this.metaByPath(view.file.path) : null;
      if (!canvas || !m || m.kind !== 'canvas') continue;
      open.add(canvas);
      const h = this.hooks.get(canvas);
      if (h && h.id === m.id) continue;
      if (h) this.unhookCanvas(h);
      this.hookCanvas(canvas, m.id);
    }
    for (const h of [...this.hooks.values()]) if (!open.has(h.canvas)) this.unhookCanvas(h);
  }

  private hookCanvas(canvas: any, id: string) {
    const sync = this;
    const d = this.hold(id, 'canvas', 'canvas');
    const h: CanvasHook = { canvas, id, unhook: () => {}, shown: canvas.getData(), timer: null };
    const unhook = around(canvas, {
      requestSave(orig: any) {
        return function (this: any, ...args: any[]) {
          if (h.timer != null) window.clearTimeout(h.timer);
          // Local change -> Yjs right away; Obsidian's own file save comes later.
          h.timer = window.setTimeout(() => {
            h.timer = null;
            if (!sync.live.has(id) || !d.known) return;
            const now = canvas.getData();
            d.ydoc.transact(() => applyCanvas(d.ydoc, h.shown, now), FROM_CANVAS);
            h.shown = now;
          }, 60);
          return orig.apply(this, args);
        };
      },
    });
    h.unhook = unhook;
    this.hooks.set(canvas, h);
    void d.ready.then(() => {
      if (this.hooks.get(canvas) !== h || d.failed || !d.known) return;
      // Boxes changed in the file while it wasn't live, then the shared state.
      const m = this.metas.get(id);
      const now = canvas.getData();
      if (m?.base && renderCanvas(now) !== m.base) d.ydoc.transact(() => applyCanvas(d.ydoc, parseCanvas(m.base!), now), FROM_CANVAS);
      this.applyToCanvases(d);
    });
  }

  private unhookCanvas(h: CanvasHook) {
    this.hooks.delete(h.canvas);
    if (h.timer != null) window.clearTimeout(h.timer);
    h.unhook();
    const d = this.live.get(h.id);
    if (d) {
      this.release(d, 'canvas');
      this.scheduleWrite(d);
    }
  }

  /** Remote canvas changes, box by box; boxes being dragged or edited here are left alone. */
  private applyToCanvases(d: LiveDoc) {
    const want = canvasFromY(d.ydoc);
    for (const h of this.hooks.values()) {
      if (h.id !== d.id) continue;
      const c = h.canvas;
      const busy = new Set<string>();
      if (c.isDragging) for (const n of c.selection || []) busy.add(n.id);
      for (const n of c.nodes.values()) if (n.isEditing) busy.add(n.id);
      const nodes = new Map(want.nodes.map((v: any) => [v.id, v]));
      const add: any[] = [];
      for (const [nid, node] of [...c.nodes]) if (!nodes.has(nid) && !busy.has(nid)) c.removeNode(node);
      for (const [nid, v] of nodes) {
        if (busy.has(nid)) continue;
        const n = c.nodes.get(nid);
        if (!n) {
          add.push(v);
          continue;
        }
        const cur = n.getData();
        if (JSON.stringify(cur) === JSON.stringify(v)) continue;
        if (cur.type !== v.type || cur.file !== v.file || cur.url !== v.url) {
          c.removeNode(n);
          add.push(v);
          continue;
        }
        if (cur.x !== v.x || cur.y !== v.y || cur.width !== v.width || cur.height !== v.height)
          n.moveAndResize({ x: v.x, y: v.y, width: v.width, height: v.height });
        if (v.text !== undefined && v.text !== cur.text) n.setText(v.text);
        if (v.label !== cur.label) n.setLabel?.(v.label);
        if (v.color !== cur.color) n.setColor?.(v.color);
      }
      const edges = new Map(want.edges.map((v: any) => [v.id, v]));
      for (const [eid, edge] of [...c.edges]) {
        const v = edges.get(eid);
        if (!v || JSON.stringify(edge.getData()) !== JSON.stringify(v)) c.removeEdge(edge);
      }
      const addE = [...edges.values()].filter((v: any) => !c.edges.has(v.id));
      if (add.length || addE.length) c.importData({ nodes: add, edges: addE }, false);
      c.requestFrame?.();
      h.shown = c.getData();
      // Let Obsidian write the file itself.
      c.requestSave();
    }
  }

  // ---------- trash / versions (UI in ui.ts) ----------

  async restore(id: string) {
    const doc = await this.op({ type: 'doc.restore', id });
    if (doc) await this.serial(() => this.onDocChanged(doc));
    return doc;
  }

  /** Make an old version the current one (as a normal edit everyone sees). */
  async restoreVersion(id: string, content: string) {
    const m = this.metas.get(id);
    if (!m || m.kind === 'file') return;
    const d = this.hold(id, m.kind, 'restore');
    try {
      await d.ready;
      if (m.kind === 'md') d.ydoc.transact(() => setText(d.ydoc.getText('content'), content), FROM_STORE + '-restore');
      else {
        const data = parseCanvas(content);
        if (data) d.ydoc.transact(() => replaceCanvas(d.ydoc, data), FROM_STORE + '-restore');
      }
      if (this.isHooked(id)) this.applyToCanvases(d);
      else this.scheduleWrite(d);
    } finally {
      this.release(d, 'restore');
    }
  }

  fullSyncNow() {
    return this.serial(() => this.fullSync());
  }

  docIdForPath(path: string) {
    return this.metaByPath(path)?.id ?? null;
  }
}

function confirm(app: any, title: string, desc: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new (class extends Modal {
      result = false;
      onOpen() {
        this.titleEl.setText(title);
        this.contentEl.createEl('p', { text: desc });
        new Setting(this.contentEl)
          .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
          .addButton((b) =>
            b
              .setButtonText('Move')
              .setCta()
              .onClick(() => {
                this.result = true;
                this.close();
              })
          );
      }
      onClose() {
        resolve(this.result);
      }
    })(app);
    modal.open();
  });
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  txt: 'text/plain',
};
function mimeOf(ext: string) {
  return MIME[ext.toLowerCase()] || 'application/octet-stream';
}
