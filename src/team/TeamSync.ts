import { Notice } from 'obsidian';
import { StateManager } from 'src/StateManager';
import { Board, Item, Lane } from 'src/components/types';

import type { TeamManager } from './TeamManager';
import { diffTeamBoard } from './boardDiff';
import { normalizeIds, snapshotToBoard } from './convert';
import { isTeamItem, isTeamLane, newTeamId, teamItemId, teamLaneId } from './ids';
import { TeamApiError } from './TeamClient';
import { TeamBoardSnapshot, TeamOp, TeamServerEvent } from './types';

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

  private applySnapshot(snapshot: TeamBoardSnapshot) {
    this.snapshot = snapshot;
    this.versions.clear();
    for (const c of snapshot.cards) this.versions.set(c.id, c.version);
    for (const c of snapshot.archive) this.versions.set(c.id, c.version);
    this.manager.indexSnapshot(snapshot);

    const base = this.stateManager.state;
    if (!base) return;
    const board = snapshotToBoard(this.stateManager, snapshot, base);
    this.stateManager.setRemoteState(board, true);
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

  onLocalChange(prev: Board, next: Board) {
    if (!this.ready || !prev || !next) return;
    const ops = diffTeamBoard(this.boardId, prev, next, this.versions);
    if (!ops.length) return;
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
      if (!res.ok) {
        const errors = res.results.filter((r) => !r.ok && r.error !== 'conflict');
        if (res.conflicts.length) {
          new Notice('Kanban: a card was changed by someone else, reloading the board');
        }
        for (const err of errors) {
          new Notice(`Kanban: sync failed for ${err.type}: ${err.error}`);
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
