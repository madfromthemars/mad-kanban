import { Notice } from 'obsidian';
import { StateManager } from 'src/StateManager';
import { Board, Item, Lane } from 'src/components/types';

import type { TeamManager } from './TeamManager';
import { diffTeamBoard } from './boardDiff';
import { normalizeIds, snapshotToBoard } from './convert';
import {
  isTeamItem,
  isTeamLane,
  newTeamId,
  normalizeLaneTitle,
  parseTeamLaneId,
  teamItemId,
  teamLaneId,
} from './ids';
import { TeamApiError } from './TeamClient';
import { TeamBoardSnapshot, TeamOp, TeamServerEvent } from './types';
import { PERSONAL_SETTING_KEYS } from 'src/tagColors';
import { KanbanSettings } from 'src/Settings';
import update from 'immutability-helper';

export type SyncState = 'loading' | 'synced' | 'syncing' | 'offline' | 'error';

/**
 * Keeps one team board's StateManager in sync with the server.
 *  - Server snapshot -> Board (setRemoteState, cached to the markdown file)
 *  - Local setState -> diff -> ops -> POST (serialized, batched)
 *  - board.changed events from other clients -> reload snapshot
 */
export class TeamSync {
  manager: TeamManager;
  stateManager: StateManager;
  boardId: string;
  snapshot: TeamBoardSnapshot | null = null;
  versions = new Map<string, number>();
  ready = false;
  state: SyncState = 'loading';
  lastError: string | null = null;

  private queue: TeamOp[] = [];
  private flushing = false;
  private reloadTimer: number | null = null;
  private reloadRequested = false;
  private destroyed = false;

  constructor(manager: TeamManager, stateManager: StateManager, boardId: string) {
    this.manager = manager;
    this.stateManager = stateManager;
    this.boardId = boardId;
  }

  destroy() {
    this.destroyed = true;
    if (this.reloadTimer != null) activeWindow.clearTimeout(this.reloadTimer);
  }

  private setSyncState(s: SyncState, err?: string) {
    this.state = s;
    this.lastError = err ?? null;
    this.manager.emitter.emit('sync', this);
  }

  /** Give every lane/item that isn't a team entity yet a fresh server id. */
  assignIds(board: Board): Board {
    let changed = false;
    const lanes = board.children.map((lane) => {
      let next: Lane = lane;
      if (!isTeamLane(lane)) {
        next = { ...lane, id: teamLaneId(this.boardId, newTeamId()) };
        changed = true;
      }
      let itemsChanged = false;
      const children = next.children.map((item) => {
        if (isTeamItem(item)) return item;
        itemsChanged = true;
        const cardId = newTeamId();
        return {
          ...item,
          id: teamItemId(this.boardId, cardId),
          data: { ...item.data, blockId: cardId },
        } as Item;
      });
      if (itemsChanged) {
        changed = true;
        next = { ...next, children };
      }
      return next;
    });
    if (!changed) return board;
    return { ...board, children: lanes };
  }

  normalizeParsed(board: Board): Board {
    return normalizeIds(board, this.boardId, this.snapshot);
  }

  /** Shared (non-personal) part of a board's settings. */
  static shared(settings: KanbanSettings | undefined) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(settings || {})) {
      if (!PERSONAL_SETTING_KEYS.has(k) && v !== undefined) out[k] = v;
    }
    return out;
  }

  private applySnapshot(snapshot: TeamBoardSnapshot) {
    const prevSnapshot = this.snapshot;
    this.snapshot = snapshot;
    this.versions.clear();
    for (const c of snapshot.cards) this.versions.set(c.id, c.version);
    for (const c of snapshot.archive) this.versions.set(c.id, c.version);
    this.manager.indexSnapshot(snapshot);

    const base = this.stateManager.state;
    if (!base) return;
    let board = snapshotToBoard(this.stateManager, snapshot, base);

    // Board settings: the server holds the shared part, the personal part stays local.
    const serverShared = snapshot.board.settings || {};
    const localShared = TeamSync.shared(base.data.settings);
    const push: TeamOp[] = [];
    if (!prevSnapshot && !Object.keys(serverShared).length && Object.keys(localShared).length) {
      // First sync of a board that only had settings locally: publish them.
      push.push({ type: 'board.settings', set: localShared });
    } else {
      const personal: Record<string, any> = {};
      for (const [k, v] of Object.entries(base.data.settings || {})) {
        if (PERSONAL_SETTING_KEYS.has(k)) personal[k] = v;
      }
      board = update(board, { data: { settings: { $set: { ...personal, ...serverShared } } } });
    }

    this.stateManager.setRemoteState(board, true);
    if (push.length) {
      this.queue.push(...push);
      void this.flush();
    }
  }

  async load(): Promise<void> {
    if (this.destroyed) return;
    if (!this.manager.client.isConfigured) {
      this.setSyncState('offline', 'Team server is not configured');
      return;
    }
    this.setSyncState(this.ready ? 'syncing' : 'loading');
    try {
      const snapshot = await this.manager.client.board(this.boardId);
      if (this.destroyed) return;
      if (this.flushing || this.queue.length) {
        // Local edits are on their way to the server; applying this snapshot
        // would revert them on screen. flush() reloads once it is done.
        this.reloadRequested = true;
        return;
      }
      this.applySnapshot(snapshot);
      this.ready = true;
      this.setSyncState('synced');
    } catch (e) {
      const msg = e instanceof TeamApiError ? e.message : String(e?.message || e);
      console.error('[Kanban team] load failed', e);
      if (e instanceof TeamApiError && e.status === 403) {
        try {
          await this.manager.client.joinBoard(this.boardId);
          return this.load();
        } catch (e2) {
          /* fall through */
        }
      }
      if (e instanceof TeamApiError && e.status === 404) {
        this.setSyncState('error', 'This board no longer exists on the server');
        new Notice('Kanban: team board not found on the server');
        return;
      }
      this.setSyncState(e instanceof TeamApiError && e.status === 0 ? 'offline' : 'error', msg);
      if (!this.ready) new Notice(`Kanban: cannot load team board (${msg}). Showing cached copy.`);
    }
  }

  requestReload(delay = 250) {
    this.reloadRequested = true;
    if (this.reloadTimer != null) return;
    this.reloadTimer = activeWindow.setTimeout(() => {
      this.reloadTimer = null;
      if (this.flushing) {
        // A reload while ops are in flight would clobber optimistic state; flush() re-checks.
        return;
      }
      this.reloadRequested = false;
      void this.load();
    }, delay);
  }

  /** True when the board's lanes carry this team board's server ids. */
  private isSynced(board: Board) {
    if (!board.children.length) return !this.snapshot?.lanes.length;
    return board.children.every((l) => parseTeamLaneId(l.id)?.boardId === this.boardId);
  }

  /** Same check as the server's detectReupload: several existing lists or cards created again. */
  private looksLikeReupload(prev: Board, ops: TeamOp[]) {
    const laneKeys = new Set(prev.children.map((l) => normalizeLaneTitle(l.data.title)));
    const contents = new Set<string>();
    for (const lane of prev.children) for (const item of lane.children) contents.add(item.data.titleRaw);
    let dupLanes = 0;
    let dupCards = 0;
    for (const op of ops) {
      if (op.type === 'lane.create' && laneKeys.has(normalizeLaneTitle(op.title))) dupLanes++;
      else if (op.type === 'card.create' && contents.has(op.content)) dupCards++;
    }
    return dupLanes >= 2 || dupCards >= 3;
  }

  onLocalChange(prev: Board, next: Board) {
    if (!this.ready || !prev || !next) return;
    if (!this.isSynced(prev)) {
      // The board on screen isn't the server's board (e.g. a re-parse replaced
      // it). Diffing would re-upload every card as new; reload instead.
      console.warn('[Kanban team] board out of sync with server, reloading instead of uploading');
      this.manager.plugin.reportWarning('sync.guard', 'board out of sync with server; reloaded instead of uploading', {
        board: this.boardId,
      });
      this.requestReload(0);
      return;
    }
    const ops = diffTeamBoard(this.boardId, prev, next, this.versions);
    if (prev.data.settings !== next.data.settings) {
      const a = TeamSync.shared(prev.data.settings);
      const b = TeamSync.shared(next.data.settings);
      const set: Record<string, any> = {};
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) set[k] = k in b ? b[k] : null;
      }
      if (Object.keys(set).length) ops.push({ type: 'board.settings', set });
    }
    if (!ops.length) return;
    if (this.looksLikeReupload(prev, ops)) {
      // Lists/cards that already exist would be created again under new ids.
      console.warn('[Kanban team] refusing to re-upload existing lists/cards, reloading', ops);
      this.manager.plugin.reportWarning('sync.reupload-guard', 'refused to re-upload existing lists/cards', {
        board: this.boardId,
        ops: ops.map((o) => o.type),
      });
      this.requestReload(0);
      return;
    }
    this.queue.push(...ops);
    void this.flush();
  }

  private async flush() {
    if (this.flushing || !this.queue.length || this.destroyed) return;
    this.flushing = true;
    const ops = this.queue.splice(0, this.queue.length);
    this.setSyncState('syncing');
    try {
      const res = await this.manager.client.applyOps(this.boardId, ops);
      for (const [id, v] of Object.entries(res.versions || {})) this.versions.set(id, v);
      if (this.snapshot) this.snapshot.board.version = res.version;
      // Our own broadcasts are ignored, so refresh to learn the server's settings after a settings change.
      if (ops.some((o) => o.type === 'board.settings' || o.type === 'board.addTagColors')) {
        this.reloadRequested = true;
      }
      if (!res.ok) {
        const errors = res.results.filter((r) => !r.ok && r.error !== 'conflict');
        if (res.conflicts.length) {
          new Notice('Kanban: a card was changed by someone else, reloading the board');
          this.manager.plugin.reportWarning('sync.conflict', 'card.update rejected as stale', {
            board: this.boardId,
            cards: res.conflicts.map((c) => c.id),
          });
        }
        for (const err of errors) {
          new Notice(`Kanban: sync failed for ${err.type}: ${err.error}`);
          this.manager.plugin.reportError('sync.op', `${err.type}: ${err.error}`, { board: this.boardId });
        }
        this.reloadRequested = true;
      }
      this.setSyncState('synced');
    } catch (e) {
      const msg = e instanceof TeamApiError ? e.message : String(e?.message || e);
      console.error('[Kanban team] ops failed', e, ops);
      new Notice(`Kanban: could not sync changes (${msg})`);
      this.setSyncState(e instanceof TeamApiError && e.status === 0 ? 'offline' : 'error', msg);
      this.reloadRequested = true;
    } finally {
      this.flushing = false;
    }
    if (this.queue.length) {
      void this.flush();
    } else if (this.reloadRequested) {
      this.reloadRequested = false;
      void this.load();
    }
  }

  onServerEvent(ev: TeamServerEvent) {
    if (ev.type === 'board.changed' && ev.boardId === this.boardId) {
      if (ev.origin && ev.origin === this.manager.client.clientId) return;
      this.requestReload();
    } else if (ev.type === 'boards.changed' && ev.boardId === this.boardId && ev.deleted) {
      this.setSyncState('error', 'This board was deleted on the server');
      new Notice('Kanban: this team board was deleted on the server');
    }
  }

  onConnected() {
    this.requestReload(0);
  }

  /** Toggle an assignee on a card and push it straight to the server. */
  async toggleAssignee(cardId: string, userId: string) {
    const card = this.manager.getCard(cardId);
    const assigned = !!card?.assignees?.includes(userId);
    try {
      const res = await this.manager.client.applyOps(this.boardId, [
        { type: 'card.assign', id: cardId, userId, assigned: !assigned },
      ]);
      for (const [id, v] of Object.entries(res.versions || {})) this.versions.set(id, v);
      if (card) {
        const set = new Set(card.assignees);
        if (assigned) set.delete(userId);
        else set.add(userId);
        this.manager.updateCard(cardId, { assignees: [...set] });
      }
      this.requestReload(0);
    } catch (e) {
      new Notice(`Kanban: could not update assignees (${e?.message || e})`);
    }
  }
}
