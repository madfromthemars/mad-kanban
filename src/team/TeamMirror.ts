import { Notice } from 'obsidian';
import { StateManager } from 'src/StateManager';
import { Board, Item, Lane, LaneTemplate } from 'src/components/types';

import type { TeamManager } from './TeamManager';
import { diffMirror } from './boardDiff';
import { cardToItem } from './convert';
import { isMirrorLane, isTeamItem, mirrorLaneId, normalizeLaneTitle } from './ids';
import { TeamApiError } from './TeamClient';
import { MyCard, TeamServerEvent } from './types';

export const DEFAULT_MIRROR_LANE = 'Team';

/**
 * Mirrors the team cards assigned to the current user into a personal board.
 * Mirrored items live only in memory: boardToMd skips them, so the personal
 * markdown file never contains team cards.
 */
export class TeamMirror {
  manager: TeamManager;
  stateManager: StateManager;
  cards: MyCard[] = [];
  versions = new Map<string, number>();
  lastError: string | null = null;

  private refreshTimer: number | null = null;
  private destroyed = false;
  private refreshing = false;
  private refreshRequested = false;

  constructor(manager: TeamManager, stateManager: StateManager) {
    this.manager = manager;
    this.stateManager = stateManager;
  }

  destroy() {
    this.destroyed = true;
    if (this.refreshTimer != null) activeWindow.clearTimeout(this.refreshTimer);
  }

  get fallbackLaneTitle() {
    return this.manager.plugin.settings['team-mirror-lane'] || DEFAULT_MIRROR_LANE;
  }

  /** Remove every mirrored item (and empty mirror lanes) from a board. */
  strip(board: Board): Board {
    let changed = false;
    const lanes: Lane[] = [];
    for (const lane of board.children) {
      const children = lane.children.filter((i) => !isTeamItem(i));
      if (children.length !== lane.children.length) changed = true;
      if (isMirrorLane(lane) && children.length === 0) {
        changed = true;
        continue;
      }
      lanes.push(children.length === lane.children.length ? lane : { ...lane, children });
    }
    return changed ? { ...board, children: lanes } : board;
  }

  /** Strip then re-add the current set of mirrored cards. Pure: returns a new board. */
  inject(board: Board): Board {
    const stripped = this.strip(board);
    if (!this.cards.length) return stripped;

    const lanes = stripped.children.map((l) => ({ ...l, children: [...l.children] }));
    const byTitle = new Map<string, Lane>();
    for (const lane of lanes) byTitle.set(normalizeLaneTitle(lane.data.title), lane);

    let fallback = byTitle.get(normalizeLaneTitle(this.fallbackLaneTitle)) || null;

    for (const card of this.cards) {
      const item = cardToItem(this.stateManager, card.boardId, card);
      const target = card.laneTitle ? byTitle.get(normalizeLaneTitle(card.laneTitle)) : null;
      if (target) {
        target.children.push(item);
        continue;
      }
      if (!fallback) {
        fallback = {
          ...LaneTemplate,
          id: mirrorLaneId(this.fallbackLaneTitle),
          children: [],
          data: { title: this.fallbackLaneTitle, maxItems: 0, shouldMarkItemsComplete: false },
        };
        lanes.push(fallback);
        byTitle.set(normalizeLaneTitle(this.fallbackLaneTitle), fallback);
      }
      fallback.children.push(item);
    }

    return { ...stripped, children: lanes };
  }

  async refresh() {
    if (this.destroyed) return;
    if (!this.manager.client.isConfigured || !this.manager.user) {
      if (this.cards.length) {
        this.cards = [];
        this.apply();
      }
      return;
    }
    if (this.refreshing) {
      this.refreshRequested = true;
      return;
    }
    this.refreshing = true;
    try {
      const cards = await this.manager.client.myCards();
      if (this.destroyed) return;
      this.cards = cards;
      this.versions.clear();
      for (const c of cards) this.versions.set(c.id, c.version);
      this.manager.indexMyCards(cards);
      this.lastError = null;
      this.apply();
    } catch (e) {
      this.lastError = e instanceof TeamApiError ? e.message : String(e?.message || e);
      console.error('[Kanban team] mirror refresh failed', e);
    } finally {
      this.refreshing = false;
      if (this.refreshRequested) {
        this.refreshRequested = false;
        void this.refresh();
      }
    }
  }

  requestRefresh(delay = 300) {
    if (this.refreshTimer != null) return;
    this.refreshTimer = activeWindow.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, delay);
  }

  private apply() {
    const base = this.stateManager.state;
    if (!base) return;
    this.stateManager.setRemoteState(this.inject(base), false);
  }

  onLocalChange(prev: Board, next: Board) {
    if (!prev || !next || !this.manager.user) return;
    const { byBoard } = diffMirror(prev, next, this.manager.user.id, this.versions);
    if (!byBoard.size) return;
    void (async () => {
      let failed = false;
      for (const [boardId, ops] of byBoard) {
        try {
          const res = await this.manager.client.applyOps(boardId, ops);
          for (const [id, v] of Object.entries(res.versions || {})) this.versions.set(id, v);
          if (!res.ok) {
            failed = true;
            for (const r of res.results) {
              if (!r.ok && r.error !== 'conflict') new Notice(`Kanban: ${r.error}`);
            }
            if (res.conflicts.length) {
              new Notice('Kanban: a team card was changed by someone else, refreshing');
            }
          }
        } catch (e) {
          failed = true;
          new Notice(`Kanban: could not sync team card (${e?.message || e})`);
        }
      }
      // The server broadcasts the change back to us too, but refresh now so a
      // rejected move snaps back without waiting. A team board open in this
      // same Obsidian ignores its own client id, so poke it directly.
      for (const boardId of byBoard.keys()) this.manager.syncFor(boardId)?.requestReload(0);
      if (failed) this.requestRefresh(0);
    })();
  }

  onServerEvent(ev: TeamServerEvent) {
    if (ev.type === 'board.changed') {
      const me = this.manager.user?.id;
      const relevant =
        !ev.users || !me || ev.users.includes(me) || this.cards.some((c) => c.boardId === ev.boardId);
      if (relevant) this.requestRefresh();
    } else if (ev.type === 'boards.changed' && ev.deleted) {
      this.requestRefresh();
    }
  }

  onConnected() {
    this.requestRefresh(0);
  }
}
