import EventEmitter from 'eventemitter3';
import { Notice, TFile, TFolder, normalizePath } from 'obsidian';
import { useEffect, useState } from 'preact/compat';
import { StateManager } from 'src/StateManager';
import { kanbanViewType } from 'src/KanbanView';
import type KanbanPlugin from 'src/main';
import { frontmatterKey } from 'src/parsers/common';
import { indentNewLines } from 'src/parsers/helpers/parser';

import { ConnectionStatus, TeamApiError, TeamClient, parseJoinString } from './TeamClient';
import { TeamMirror } from './TeamMirror';
import { SyncState, TeamSync } from './TeamSync';
import { newTeamId } from './ids';
import {
  MyCard,
  TeamBoardMeta,
  TeamBoardSnapshot,
  TeamCard,
  TeamServerEvent,
  TeamUser,
  teamBoardIdKey,
  teamBoardNameKey,
} from './types';
import { JoinBoardModal, promptText } from './ui/modals';

export interface CardInfo {
  card: TeamCard;
  boardId: string;
  boardName?: string;
  laneTitle?: string | null;
}

const MIRROR_POLL_MS = 120000;

/**
 * Plugin-wide owner of the team connection: one client, the current user, the
 * user directory, an index of known team cards, and the per-board sync objects.
 */
export class TeamManager {
  plugin: KanbanPlugin;
  client: TeamClient;
  emitter = new EventEmitter();

  user: TeamUser | null = null;
  users: TeamUser[] = [];
  boardNames = new Map<string, string>();
  cards = new Map<string, CardInfo>();

  syncs = new Map<StateManager, TeamSync>();
  mirrors = new Map<StateManager, TeamMirror>();

  private pollTimer: number | null = null;
  private destroyed = false;

  constructor(plugin: KanbanPlugin) {
    this.plugin = plugin;
    if (!plugin.settings['team-client-id']) {
      plugin.settings['team-client-id'] = newTeamId(12);
      void plugin.saveSettings();
    }
    this.client = new TeamClient(plugin.settings['team-client-id']);
    this.client.emitter.on('event', (ev: TeamServerEvent) => this.onServerEvent(ev));
    this.client.emitter.on('status', (s: ConnectionStatus) => {
      this.emitter.emit('status', s);
      if (s === 'connected') {
        this.syncs.forEach((s) => s.onConnected());
        this.mirrors.forEach((m) => m.onConnected());
        void this.refreshDirectory();
      }
    });
  }

  get isConfigured() {
    return this.client.isConfigured;
  }

  get status(): ConnectionStatus {
    return this.client.status;
  }

  async load() {
    this.pollTimer = activeWindow.setInterval(() => {
      if (this.client.isConfigured) this.mirrors.forEach((m) => m.requestRefresh(0));
    }, MIRROR_POLL_MS);
    await this.configureFromSettings();
  }

  destroy() {
    this.destroyed = true;
    if (this.pollTimer != null) activeWindow.clearInterval(this.pollTimer);
    this.syncs.forEach((s) => s.destroy());
    this.mirrors.forEach((m) => m.destroy());
    this.syncs.clear();
    this.mirrors.clear();
    this.client.destroy();
    this.emitter.removeAllListeners();
  }

  /** Re-read the connection settings; called on load and whenever settings change. */
  async configureFromSettings() {
    const url = this.plugin.settings['team-server-url'];
    const token = this.plugin.settings['team-token'];
    const conn = url && token ? { url, token } : null;
    const changed =
      (conn?.url ?? null) !== (this.client.conn?.url ?? null) ||
      (conn?.token ?? null) !== (this.client.conn?.token ?? null);
    this.client.configure(conn);
    if (!changed && this.user) return;
    this.user = null;
    this.users = [];
    if (!conn) {
      this.emitter.emit('user', null);
      this.mirrors.forEach((m) => void m.refresh());
      return;
    }
    await this.refreshDirectory();
    this.syncs.forEach((s) => void s.load());
    this.mirrors.forEach((m) => void m.refresh());
  }

  async refreshDirectory() {
    if (!this.client.isConfigured) return;
    try {
      const [user, users] = await Promise.all([this.client.me(), this.client.users()]);
      this.user = user;
      this.users = users;
      this.emitter.emit('user', user);
      this.emitter.emit('users', users);
    } catch (e) {
      console.error('[Kanban team] cannot load user directory', e);
      this.emitter.emit('user', null);
    }
  }

  /** Validate a join string against the server. Returns the user on success. */
  async testConnection(joinString: string): Promise<TeamUser> {
    const conn = parseJoinString(joinString);
    if (!conn) throw new Error('Expected a join string like https://host:8787/#TOKEN');
    const probe = new TeamClient('probe');
    probe.conn = conn;
    try {
      return await probe.me();
    } finally {
      probe.destroy();
    }
  }

  // ---------- per-board attachment ----------

  getTeamBoardId(stateManager: StateManager): string | null {
    const fm = stateManager.state?.data?.frontmatter;
    const id = fm?.[teamBoardIdKey];
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  }

  attach(stateManager: StateManager) {
    this.detach(stateManager);
    const boardId = this.getTeamBoardId(stateManager);
    if (boardId) {
      const sync = new TeamSync(this, stateManager, boardId);
      this.syncs.set(stateManager, sync);
      stateManager.teamSync = sync;
      void sync.load();
    } else {
      const mirror = new TeamMirror(this, stateManager);
      this.mirrors.set(stateManager, mirror);
      stateManager.teamMirror = mirror;
      void mirror.refresh();
    }
  }

  detach(stateManager: StateManager) {
    const sync = this.syncs.get(stateManager);
    if (sync) {
      sync.destroy();
      this.syncs.delete(stateManager);
      stateManager.teamSync = undefined;
    }
    const mirror = this.mirrors.get(stateManager);
    if (mirror) {
      mirror.destroy();
      this.mirrors.delete(stateManager);
      stateManager.teamMirror = undefined;
    }
  }

  private onServerEvent(ev: TeamServerEvent) {
    if (this.destroyed) return;
    this.syncs.forEach((s) => s.onServerEvent(ev));
    this.mirrors.forEach((m) => m.onServerEvent(ev));
    if (ev.type === 'boards.changed') this.emitter.emit('boards');
    if (ev.type === 'comments.changed') this.emitter.emit('comments', ev.boardId, ev.cardId);
  }

  // ---------- card index (for badges / assignee chips) ----------

  indexSnapshot(snapshot: TeamBoardSnapshot) {
    const boardId = snapshot.board.id;
    this.boardNames.set(boardId, snapshot.board.name);
    const laneTitles = new Map(snapshot.lanes.map((l) => [l.id, l.title]));
    for (const [id, info] of this.cards) {
      if (info.boardId === boardId) this.cards.delete(id);
    }
    for (const card of [...snapshot.cards, ...snapshot.archive]) {
      this.cards.set(card.id, {
        card,
        boardId,
        boardName: snapshot.board.name,
        laneTitle: card.laneId ? laneTitles.get(card.laneId) : null,
      });
    }
    this.emitter.emit('cards');
  }

  indexMyCards(cards: MyCard[]) {
    for (const card of cards) {
      this.boardNames.set(card.boardId, card.boardName);
      const existing = this.cards.get(card.id);
      // A live board sync has fresher data than the mirror listing.
      if (existing && this.hasSyncFor(card.boardId)) continue;
      this.cards.set(card.id, {
        card,
        boardId: card.boardId,
        boardName: card.boardName,
        laneTitle: card.laneTitle,
      });
    }
    this.emitter.emit('cards');
  }

  hasSyncFor(boardId: string) {
    for (const s of this.syncs.values()) if (s.boardId === boardId) return true;
    return false;
  }

  syncFor(boardId: string): TeamSync | null {
    for (const s of this.syncs.values()) if (s.boardId === boardId) return s;
    return null;
  }

  getCard(cardId: string): TeamCard | null {
    return this.cards.get(cardId)?.card ?? null;
  }

  getCardInfo(cardId: string): CardInfo | null {
    return this.cards.get(cardId) ?? null;
  }

  updateCard(cardId: string, patch: Partial<TeamCard>) {
    const info = this.cards.get(cardId);
    if (!info) return;
    this.cards.set(cardId, { ...info, card: { ...info.card, ...patch } });
    this.emitter.emit('cards');
  }

  userName(userId: string) {
    return this.users.find((u) => u.id === userId)?.name || userId;
  }

  /** Toggle an assignee on any known team card (from a team board or a mirror). */
  async toggleAssignee(boardId: string, cardId: string, userId: string) {
    const sync = this.syncFor(boardId);
    if (sync) return sync.toggleAssignee(cardId, userId);
    const card = this.getCard(cardId);
    const assigned = !!card?.assignees?.includes(userId);
    try {
      await this.client.applyOps(boardId, [
        { type: 'card.assign', id: cardId, userId, assigned: !assigned },
      ]);
      if (card) {
        const set = new Set(card.assignees);
        if (assigned) set.delete(userId);
        else set.add(userId);
        this.updateCard(cardId, { assignees: [...set] });
      }
      this.mirrors.forEach((m) => m.requestRefresh(0));
      this.syncFor(boardId)?.requestReload(0);
    } catch (e) {
      new Notice(`Kanban: could not update assignees (${e?.message || e})`);
    }
  }

  // ---------- hooks ----------

  useUsers(): TeamUser[] {
    const [users, setUsers] = useState(this.users);
    useEffect(() => {
      const fn = (u: TeamUser[]) => setUsers(u);
      this.emitter.on('users', fn);
      setUsers(this.users);
      return () => {
        this.emitter.off('users', fn);
      };
    }, []);
    return users;
  }

  useCardInfo(cardId: string | null): CardInfo | null {
    const [info, setInfo] = useState(cardId ? this.getCardInfo(cardId) : null);
    useEffect(() => {
      if (!cardId) return;
      const fn = () => setInfo(this.getCardInfo(cardId));
      this.emitter.on('cards', fn);
      fn();
      return () => {
        this.emitter.off('cards', fn);
      };
    }, [cardId]);
    return info;
  }

  useSyncState(sync: TeamSync | undefined): { state: SyncState; error: string | null } | null {
    const read = () => (sync ? { state: sync.state, error: sync.lastError } : null);
    const [st, setSt] = useState(read());
    useEffect(() => {
      const fn = (s: TeamSync) => {
        if (s === sync) setSt(read());
      };
      const onStatus = () => setSt(read());
      this.emitter.on('sync', fn);
      this.emitter.on('status', onStatus);
      setSt(read());
      return () => {
        this.emitter.off('sync', fn);
        this.emitter.off('status', onStatus);
      };
    }, [sync]);
    return st;
  }

  // ---------- board files ----------

  findBoardFile(boardId: string): TFile | null {
    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      const fm = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
      if (fm && fm[teamBoardIdKey] === boardId) return file;
    }
    return null;
  }

  private snapshotToMarkdown(snapshot: TeamBoardSnapshot) {
    const lines: string[] = [
      '---',
      '',
      `${frontmatterKey}: board`,
      `${teamBoardIdKey}: ${snapshot.board.id}`,
      `${teamBoardNameKey}: ${JSON.stringify(snapshot.board.name)}`,
      '',
      '---',
      '',
    ];
    const byLane = new Map<string, TeamCard[]>();
    for (const c of snapshot.cards) {
      if (!c.laneId) continue;
      if (!byLane.has(c.laneId)) byLane.set(c.laneId, []);
      byLane.get(c.laneId).push(c);
    }
    for (const lane of [...snapshot.lanes].sort((a, b) => a.position - b.position)) {
      lines.push(`## ${lane.title}${lane.maxItems ? ` (${lane.maxItems})` : ''}`, '');
      if (lane.markComplete) lines.push('**Complete**');
      for (const c of (byLane.get(lane.id) || []).sort((a, b) => a.position - b.position)) {
        const check = c.checked ? c.checkChar || 'x' : ' ';
        const content = indentNewLines(c.content || '');
        const contentLines = content.split('\n');
        contentLines[0] += ` ^${c.id}`;
        lines.push(`- [${check}] ${contentLines.join('\n')}`);
      }
      lines.push('', '', '');
    }
    lines.push('', '%% kanban:settings', '```', JSON.stringify({ [frontmatterKey]: 'board' }), '```', '%%');
    return lines.join('\n');
  }

  private async writeBoardFile(snapshot: TeamBoardSnapshot, folder?: TFolder): Promise<TFile> {
    const app = this.plugin.app;
    const targetFolder =
      folder || app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path || '');
    const safeName = snapshot.board.name.replace(/[\\/:"*?<>|]+/g, ' ').trim() || 'Team board';
    let path = normalizePath(`${targetFolder.path ? targetFolder.path + '/' : ''}${safeName}.md`);
    let n = 2;
    while (app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${targetFolder.path ? targetFolder.path + '/' : ''}${safeName} ${n++}.md`);
    }
    return app.vault.create(path, this.snapshotToMarkdown(snapshot));
  }

  async openBoard(boardId: string, folder?: TFolder) {
    let file = this.findBoardFile(boardId);
    if (!file) {
      if (!this.client.isConfigured) {
        new Notice('Kanban: set up the team server in the plugin settings first');
        return;
      }
      try {
        const snapshot = await this.client.joinBoard(boardId);
        file = await this.writeBoardFile(snapshot, folder);
      } catch (e) {
        new Notice(`Kanban: could not open team board (${e?.message || e})`);
        return;
      }
    }
    await this.plugin.app.workspace.getLeaf().setViewState({
      type: kanbanViewType,
      state: { file: file.path },
    });
  }

  async createTeamBoard(folder?: TFolder) {
    if (!this.client.isConfigured) {
      new Notice('Kanban: set up the team server in the plugin settings first');
      return;
    }
    const name = await promptText(this.plugin.app, 'New team board', 'Board name', 'Team board');
    if (name === null) return;
    const trimmed = name.trim() || 'Team board';
    try {
      const snapshot = await this.client.createBoard(trimmed, ['To Do', 'In Progress', 'Done']);
      const file = await this.writeBoardFile(snapshot, folder);
      await this.plugin.app.workspace.getLeaf().setViewState({
        type: kanbanViewType,
        state: { file: file.path },
      });
    } catch (e) {
      console.error(e);
      new Notice(`Kanban: could not create team board (${e?.message || e})`);
    }
  }

  async joinTeamBoard(folder?: TFolder) {
    if (!this.client.isConfigured) {
      new Notice('Kanban: set up the team server in the plugin settings first');
      return;
    }
    let boards: TeamBoardMeta[];
    try {
      boards = await this.client.boards();
    } catch (e) {
      new Notice(`Kanban: could not list team boards (${e?.message || e})`);
      return;
    }
    if (!boards.length) {
      new Notice('Kanban: there are no team boards on the server yet');
      return;
    }
    const localIds = new Set<string>();
    for (const b of boards) if (this.findBoardFile(b.id)) localIds.add(b.id);
    new JoinBoardModal(this.plugin.app, boards, localIds, (board) => {
      void this.openBoard(board.id, folder);
    }).open();
  }

  isTeamApiError(e: unknown): e is TeamApiError {
    return e instanceof TeamApiError;
  }
}
