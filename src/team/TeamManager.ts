import EventEmitter from 'eventemitter3';
import { Notice, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';
import { useEffect, useState } from 'preact/compat';
import { StateManager } from 'src/StateManager';
import { kanbanViewType } from 'src/KanbanView';
import type KanbanPlugin from 'src/main';
import { frontmatterKey } from 'src/parsers/common';
import { indentNewLines } from 'src/parsers/helpers/parser';

import {
  ConnectionStatus,
  PairingLink,
  TeamApiError,
  TeamClient,
  TeamConnection,
  parseJoinString,
  parsePairingLink,
  redeemPairingCode,
} from './TeamClient';
import { DeviceMarker, defaultDeviceName, devicePlatform, loadDeviceMarker, saveDeviceMarker } from './devices';
import { relocationTarget } from './relocation';
import { TeamMirror } from './TeamMirror';
import { SyncState, TeamSync } from './TeamSync';
import { newTeamId } from './ids';
import {
  MyCard,
  TeamBoardMeta,
  TeamBoardSnapshot,
  TeamCard,
  TeamDevice,
  TeamProject,
  TeamServerEvent,
  TeamUser,
  teamBoardIdKey,
  teamBoardNameKey,
} from './types';
import { JoinBoardModal, promptText } from './ui/modals';
import { AddDeviceModal, PairConfirmModal } from './ui/Devices';
import { ManageTeamModal } from './ui/ManageTeam';
import { ProgressModal } from './ui/Progress';

export interface CardInfo {
  card: TeamCard;
  boardId: string;
  boardName?: string;
  laneTitle?: string | null;
}

const MIRROR_POLL_MS = 120000;
const RELOCATION_COOLDOWN_MS = 6 * 60 * 60 * 1000;

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
  /** Projects the current user is in (all of them for the owner), from the latest board snapshot. */
  projects: TeamProject[] = [];
  boardNames = new Map<string, string>();
  cards = new Map<string, CardInfo>();

  syncs = new Map<StateManager, TeamSync>();
  mirrors = new Map<StateManager, TeamMirror>();

  private pollTimer: number | null = null;
  private destroyed = false;

  constructor(plugin: KanbanPlugin) {
    this.plugin = plugin;
    // Each install needs its own client id: a vault folder copied from another device
    // carries that device's id, and two devices sharing one skip each other's changes
    // as their own echoes. The marker lives outside the vault, so a copy has none.
    const marker = loadDeviceMarker(plugin.app);
    const clientId = plugin.settings['team-client-id'];
    if (!clientId || !marker || marker.clientId !== clientId) {
      plugin.settings['team-client-id'] = newTeamId(12);
      this.marker = { clientId: plugin.settings['team-client-id'], deviceId: null };
      saveDeviceMarker(plugin.app, this.marker);
      void plugin.saveSettings();
    } else {
      this.marker = marker;
    }
    this.client = new TeamClient(plugin.settings['team-client-id']);
    this.client.emitter.on('event', (ev: TeamServerEvent) => this.onServerEvent(ev));
    this.client.emitter.on('moved', (to: string) => void this.relocate(to));
    this.client.emitter.on('unauthorized', () => void this.checkSignedOut());
    this.client.emitter.on('status', (s: ConnectionStatus) => {
      this.emitter.emit('status', s);
      if (s === 'connected') {
        this.syncs.forEach((s) => s.onConnected());
        this.mirrors.forEach((m) => m.onConnected());
        void this.refreshDirectory();
        // Catch releases published while we were offline.
        this.plugin.updater?.checkSoon(3000);
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
      const [who, users] = await Promise.all([this.client.whoAmI(), this.client.users()]);
      const user = who.user;
      this.user = user;
      this.users = users;
      this.device = who.device ?? null;
      this.emitter.emit('user', user);
      this.emitter.emit('users', users);
      // Servers from before device keys don't answer with `device` at all.
      if ('device' in who) void this.ensureOwnDeviceKey(who.device);
    } catch (e) {
      console.error('[Kanban team] cannot load user directory', e);
      this.emitter.emit('user', null);
    }
  }

  // ---------- devices ----------

  /** The device key this install signs in with; null when it uses the join link. */
  device: TeamDevice | null = null;
  private marker: DeviceMarker;
  private upgrading = false;
  private upgradeFailedAt = 0;

  /**
   * Make sure this install signs in with its own device key, so it shows up in
   * "Your devices" and can be removed on its own. Trades the join link (or a device
   * key copied over with the vault folder) for a fresh key.
   */
  private async ensureOwnDeviceKey(device: TeamDevice | null) {
    if (this.destroyed || this.upgrading) return;
    if (device && this.marker.deviceId === device.id) return;
    if (Date.now() - this.upgradeFailedAt < 60 * 60 * 1000) return;
    const url = this.plugin.settings['team-server-url'];
    if (!url) return;
    this.upgrading = true;
    try {
      const res = await this.client.addDevice(defaultDeviceName(this.plugin.app), devicePlatform());
      // Settings may have changed while we waited (signed out, other server).
      if (this.plugin.settings['team-server-url'] !== url) return;
      this.marker = { clientId: this.client.clientId, deviceId: res.device.id };
      saveDeviceMarker(this.plugin.app, this.marker);
      console.log(`[Kanban team] this device is now "${res.device.name}"`);
      await this.setConnection({ url, token: res.token });
    } catch (e) {
      this.upgradeFailedAt = Date.now();
      console.warn('[Kanban team] could not get a device key; still using the current sign-in', e);
    } finally {
      this.upgrading = false;
    }
  }

  /**
   * Store the server address and key this install signs in with (null signs out).
   * The only writer of these settings besides relocation, so the settings tab's own
   * copy can never put back an old key.
   */
  async setConnection(conn: TeamConnection | null) {
    if (conn) {
      this.plugin.settings['team-server-url'] = conn.url;
      this.plugin.settings['team-token'] = conn.token;
    } else {
      delete this.plugin.settings['team-server-url'];
      delete this.plugin.settings['team-token'];
    }
    await this.plugin.saveSettings();
    this.emitter.emit('connection');
    await this.configureFromSettings();
  }

  /** Sign this install in with a code from another device's "Add a device" QR code. */
  async signInWithPairingLink(link: PairingLink): Promise<TeamUser> {
    const out = await redeemPairingCode(link, defaultDeviceName(this.plugin.app), devicePlatform());
    this.marker = { clientId: this.client.clientId, deviceId: out.device.id };
    saveDeviceMarker(this.plugin.app, this.marker);
    await this.setConnection({ url: link.url, token: out.token });
    new Notice(`Mad Kanban: signed in as ${out.user.name}`);
    return out.user;
  }

  /** obsidian://mad-kanban?server=…&pair=… (the "Open in Obsidian" button of a pairing page). */
  handleProtocol(params: Record<string, string>) {
    const link = parsePairingLink(`${params.server || ''}/pair#${params.pair || ''}`);
    if (!link) {
      new Notice('Mad Kanban: this sign-in link is incomplete. Scan the QR code again.');
      return;
    }
    new PairConfirmModal(this.plugin.app, link, this.user?.name ?? null, async () => {
      try {
        await this.signInWithPairingLink(link);
      } catch (e) {
        new Notice(`Mad Kanban: could not sign in. ${(e as Error)?.message || e}`, 10000);
      }
    }).open();
  }

  openAddDevice() {
    new AddDeviceModal(this.plugin.app, this).open();
  }

  /** Called after this device's own key was removed (here or elsewhere). */
  async signOut() {
    this.marker = { clientId: this.client.clientId, deviceId: null };
    saveDeviceMarker(this.plugin.app, this.marker);
    await this.setConnection(null);
  }

  private checkingSignOut = false;

  /**
   * The server refused our key. Confirm with one more request (a single 401 could be a
   * race with a key swap), then sign out and say why, instead of retrying forever.
   */
  private async checkSignedOut() {
    if (this.checkingSignOut || this.destroyed || !this.client.isConfigured) return;
    this.checkingSignOut = true;
    const token = this.plugin.settings['team-token'];
    try {
      await new Promise((r) => activeWindow.setTimeout(r, 1500));
      if (this.plugin.settings['team-token'] !== token) return;
      try {
        await this.client.whoAmI();
        return;
      } catch (e) {
        if (!(e instanceof TeamApiError) || e.status !== 401) return;
      }
      if (this.plugin.settings['team-token'] !== token) return;
      await this.signOut();
      new Notice(
        'Mad Kanban: this device was signed out (it was removed from your devices, or its link was replaced). ' +
          'To sign in again, open Add a device on another device and scan the code.',
        0
      );
    } finally {
      this.checkingSignOut = false;
    }
  }

  /**
   * Ask the server whether it moved (its /api/health carries { movedTo }) and
   * follow it. Used by the updater, since a socket to a moved server just fails.
   */
  async checkRelocation(): Promise<boolean> {
    const base = this.plugin.settings['team-server-url'];
    if (!base || !this.plugin.settings['team-token']) return false;
    try {
      const res = await requestUrl({
        url: `${base}/api/health?t=${Date.now()}`,
        headers: { 'Cache-Control': 'no-cache' },
        throw: false,
      });
      const to = res.status === 200 ? relocationTarget(res.json) : null;
      return to ? await this.relocate(to) : false;
    } catch {
      return false;
    }
  }

  /** Point this plugin at the team server's new address, keeping the token. */
  async relocate(to: string): Promise<boolean> {
    if (this.destroyed || this.relocating || this.plugin.settings['team-server-url'] === to) return false;
    // Never bounce straight back: two servers pointing at each other must not
    // make us rewrite settings in a loop (concurrent saves once emptied data.json).
    const last = this.lastRelocation;
    if (last && last.from === to && Date.now() - last.at < RELOCATION_COOLDOWN_MS) {
      console.warn(`[Kanban team] ignoring move back to ${to} right after leaving it`);
      return false;
    }
    this.relocating = true;
    try {
      const from = this.plugin.settings['team-server-url'];
      this.plugin.settings['team-server-url'] = to;
      await this.plugin.saveSettings();
      this.lastRelocation = { from, at: Date.now() };
      console.log(`[Kanban team] server moved: ${from} -> ${to}`);
      new Notice(`Mad Kanban: team server moved to ${to}`);
      await this.configureFromSettings();
      return true;
    } finally {
      this.relocating = false;
    }
  }

  private relocating = false;
  private lastRelocation: { from: string; at: number } | null = null;

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
    // Roles, people or project membership changed; boards reload through their own board.changed.
    if (ev.type === 'team.changed') {
      void this.refreshDirectory();
      this.emitter.emit('team');
    }
    // A new plugin build was published: fetch it now (spread out a little so clients don't all hit at once).
    if (ev.type === 'plugin.released') this.plugin.updater?.checkSoon(Math.random() * 5000);
  }

  // ---------- card index (for badges / assignee chips) ----------

  indexSnapshot(snapshot: TeamBoardSnapshot) {
    const boardId = snapshot.board.id;
    this.boardNames.set(boardId, snapshot.board.name);
    if (snapshot.projects) {
      this.projects = this.withPrivateProject(snapshot.projects);
      this.emitter.emit('projects', this.projects);
    }
    if (snapshot.role && this.user && this.user.role !== snapshot.role) {
      this.user = { ...this.user, role: snapshot.role };
      this.emitter.emit('user', this.user);
    }
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

  indexNewCard(card: TeamCard, laneTitle: string | null) {
    if (this.cards.has(card.id)) return;
    this.cards.set(card.id, {
      card,
      boardId: card.boardId,
      boardName: this.boardNames.get(card.boardId),
      laneTitle,
    });
    this.emitter.emit('cards');
  }

  updateCard(cardId: string, patch: Partial<TeamCard>) {
    const info = this.cards.get(cardId);
    if (!info) return;
    this.cards.set(cardId, { ...info, card: { ...info.card, ...patch } });
    this.emitter.emit('cards');
  }

  get isHost() {
    return this.user?.role === 'owner' || this.user?.role === 'host';
  }

  /**
   * Adds the virtual "Only me" project after the real ones. Its cards are private: the
   * server shows them to their creator alone (owner included) and keeps them assigned to them.
   */
  withPrivateProject(projects: TeamProject[]): TeamProject[] {
    const me = this.user?.id;
    const real = projects.filter((p) => !p.isPrivate && !p.id.startsWith('me:'));
    if (!me) return real;
    return [...real, { id: `me:${me}`, name: '🔒 Only me', color: '', memberIds: [me], isPrivate: true }];
  }

  project(projectId: string | null | undefined): TeamProject | null {
    return (projectId && this.projects.find((p) => p.id === projectId)) || null;
  }

  openManageTeam() {
    new ManageTeamModal(this.plugin.app, this).open();
  }

  /** Progress (finished cards, people, projects) and the Trash of a team board. */
  openProgress(boardId: string | null = null, tab: 'overview' | 'trash' = 'overview') {
    if (!boardId) {
      // The board in the active view, if it's a team board.
      const file = this.plugin.app.workspace.getActiveFile();
      boardId = (file && this.plugin.stateManagers.get(file)?.teamSync?.boardId) || null;
    }
    new ProgressModal(this.plugin.app, this, boardId, tab).open();
  }

  /** Move a card to another project, straight to the server. */
  async setCardProject(boardId: string, cardId: string, projectId: string) {
    try {
      const res = await this.client.applyOps(boardId, [{ type: 'card.update', id: cardId, projectId }]);
      const err = res.results.find((r) => !r.ok);
      if (err) throw new Error(err.error);
      this.updateCard(cardId, { projectId });
      const sync = this.syncFor(boardId);
      for (const [id, v] of Object.entries(res.versions || {})) sync?.versions.set(id, v);
      sync?.requestReload(0);
    } catch (e) {
      new Notice(`Kanban: could not change the project (${e?.message || e})`);
    }
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

  useProjects(): TeamProject[] {
    const [projects, setProjects] = useState(this.projects);
    useEffect(() => {
      const fn = (p: TeamProject[]) => setProjects(p);
      this.emitter.on('projects', fn);
      setProjects(this.projects);
      return () => {
        this.emitter.off('projects', fn);
      };
    }, []);
    return projects;
  }

  useIsHost(): boolean {
    const [host, setHost] = useState(this.isHost);
    useEffect(() => {
      const fn = () => setHost(this.isHost);
      this.emitter.on('user', fn);
      fn();
      return () => {
        this.emitter.off('user', fn);
      };
    }, []);
    return host;
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
