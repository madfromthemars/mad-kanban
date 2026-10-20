import EventEmitter from 'eventemitter3';
import { requestUrl } from 'obsidian';

import { relocationTarget } from './relocation';

import {
  TeamComment,
  TeamDirectory,
  TeamRole,
  UploadedFile,
  MyCard,
  OpsResponse,
  TeamBoardMeta,
  TeamBoardSnapshot,
  TeamDevice,
  TeamOp,
  TeamServerEvent,
  TeamUser,
} from './types';

export interface TeamConnection {
  url: string;
  token: string;
}

export interface ProgressCard {
  id: string;
  title: string;
  laneId: string | null;
  /** 'todo' | 'inprogress' | 'done' | 'archive' | null (a list with another name) */
  laneKey: string | null;
  finished: boolean;
  assignees: string[];
  projectId: string | null;
  createdAt: number;
  createdBy: string | null;
  doneAt: number | null;
  doneBy: string | null;
  /** doneAt is a guess (finished before tracking started). */
  doneEstimated: boolean;
  due: string | null;
  priority: number | null;
}

export interface BoardProgress {
  now: number;
  trackingSince: number;
  lanes: Array<{ id: string; title: string; key: string | null; finished: boolean }>;
  cards: ProgressCard[];
  trashCount: number;
}

export interface TrashedCard {
  id: string;
  boardId: string;
  title: string;
  content: string;
  assignees: string[];
  projectId: string | null;
  lane: string | null;
  deletedBy: string | null;
  deletedByName: string | null;
  deletedAt: number;
  purgeAt: number;
  commentCount: number;
}

export interface TelegramStatus {
  /** The server has a bot set up. */
  available: boolean;
  bot: string | null;
  linked: boolean;
  telegramName: string | null;
}

/** A "sign in this device" link from a QR code: https://host/pair#CODE */
export interface PairingLink {
  url: string;
  code: string;
}

/** Parse "https://host/pair#CODE" (what an Add-a-device QR code holds). */
export function parsePairingLink(raw: string): PairingLink | null {
  const m = /^\s*(https?:\/\/[^\s#]+?)\/pair\/?#([a-z0-9]{16,64})\s*$/i.exec(raw || '');
  if (!m) return null;
  try {
    new URL(m[1]);
  } catch {
    return null;
  }
  return { url: m[1].replace(/\/+$/, ''), code: m[2] };
}

/** Parse "https://host:port/#TOKEN" (or "host:port#TOKEN") into url + token. */
export function parseJoinString(raw: string): TeamConnection | null {
  const str = (raw || '').trim();
  if (!str) return null;
  if (parsePairingLink(str)) return null;
  const hashIdx = str.lastIndexOf('#');
  if (hashIdx <= 0) return null;
  let url = str.slice(0, hashIdx).trim().replace(/\/+$/, '');
  const token = str.slice(hashIdx + 1).trim();
  if (!token) return null;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  try {
    // validates the URL
    new URL(url);
  } catch {
    return null;
  }
  return { url, token };
}

export class UploadCancelled extends Error {
  constructor() {
    super('Upload cancelled');
  }
}

/**
 * Trade a pairing code (from another device's QR code) for this device's own key.
 * No sign-in needed: the code is the proof.
 */
export async function redeemPairingCode(
  link: PairingLink,
  name: string,
  platform: string
): Promise<{ token: string; user: TeamUser; device: TeamDevice }> {
  let res;
  try {
    res = await requestUrl({
      url: `${link.url}/api/pair`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ code: link.code, name, platform }),
      throw: false,
    });
  } catch (e) {
    throw new TeamApiError(0, `Cannot reach team server: ${(e as Error)?.message || e}`);
  }
  let json: any = {};
  try {
    json = res.json;
  } catch {
    json = {};
  }
  if (res.status >= 400) throw new TeamApiError(res.status, json?.error || `Server error ${res.status}`, json);
  if (!json?.token || !json?.user) throw new TeamApiError(res.status, 'Unexpected answer from the team server');
  return json;
}

export class TeamApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, message: string, body?: any) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * HTTP + WebSocket client for the team server. One instance per plugin.
 * Events: 'event' (TeamServerEvent), 'status' (ConnectionStatus)
 */
export class TeamClient {
  emitter = new EventEmitter();
  conn: TeamConnection | null = null;
  clientId: string;
  status: ConnectionStatus = 'disconnected';

  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1000;
  private pingTimer: number | null = null;
  private closed = false;

  constructor(clientId: string) {
    this.clientId = clientId;
  }

  get isConfigured() {
    return !!this.conn;
  }

  configure(conn: TeamConnection | null) {
    const changed =
      (conn?.url ?? null) !== (this.conn?.url ?? null) ||
      (conn?.token ?? null) !== (this.conn?.token ?? null);
    this.conn = conn;
    if (changed) {
      this.disconnectSocket();
      if (conn) this.connectSocket();
      else this.setStatus('disconnected');
    }
  }

  destroy() {
    this.closed = true;
    this.disconnectSocket();
    this.emitter.removeAllListeners();
  }

  // ---------- HTTP ----------

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.conn) throw new TeamApiError(0, 'Team server is not configured');
    let res;
    try {
      res = await requestUrl({
        url: `${this.conn.url}${path}`,
        method,
        headers: {
          Authorization: `Bearer ${this.conn.token}`,
          'Content-Type': 'application/json',
          // Obsidian's HTTP cache otherwise replays old answers (e.g. a past
          // 410 "moved"), which once bounced plugins between two servers.
          'Cache-Control': 'no-cache',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        throw: false,
      });
    } catch (e) {
      throw new TeamApiError(0, `Cannot reach team server: ${e?.message || e}`);
    }
    let json: any = {};
    try {
      json = res.json;
    } catch {
      try {
        json = JSON.parse(res.text);
      } catch {
        json = {};
      }
    }
    if (res.status === 410) {
      const to = relocationTarget(json);
      if (to) this.emitter.emit('moved', to);
    }
    if (res.status === 401) this.emitter.emit('unauthorized');
    if (res.status >= 400) {
      throw new TeamApiError(res.status, json?.error || `Server error ${res.status}`, json);
    }
    return json as T;
  }

  me() {
    return this.request<{ user: TeamUser }>('GET', '/api/me').then((r) => r.user);
  }

  users() {
    return this.request<{ users: TeamUser[] }>('GET', '/api/users').then((r) => r.users);
  }

  boards() {
    return this.request<{ boards: TeamBoardMeta[] }>('GET', '/api/boards').then((r) => r.boards);
  }

  createBoard(name: string, lanes: string[]) {
    return this.request<{ board: TeamBoardSnapshot }>('POST', '/api/boards', { name, lanes }).then(
      (r) => r.board
    );
  }

  joinBoard(id: string) {
    return this.request<{ board: TeamBoardSnapshot }>(
      'POST',
      `/api/boards/${encodeURIComponent(id)}/join`
    ).then((r) => r.board);
  }

  leaveBoard(id: string) {
    return this.request<{ ok: boolean }>('DELETE', `/api/boards/${encodeURIComponent(id)}/join`);
  }

  board(id: string) {
    return this.request<{ board: TeamBoardSnapshot }>(
      'GET',
      `/api/boards/${encodeURIComponent(id)}`
    ).then((r) => r.board);
  }

  applyOps(boardId: string, ops: TeamOp[]) {
    return this.request<OpsResponse>('POST', `/api/boards/${encodeURIComponent(boardId)}/ops`, {
      ops,
      clientId: this.clientId,
    });
  }

  sendClientLogs(entries: unknown[], meta: Record<string, unknown>) {
    return this.request<{ ok: boolean; stored: number }>('POST', '/api/client-logs', { entries, meta });
  }

  comments(boardId: string, cardId: string) {
    return this.request<{ comments: TeamComment[]; lastReadAt?: number }>(
      'GET',
      `/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/comments`
    ).then((r) => ({ comments: r.comments, lastReadAt: r.lastReadAt ?? 0 }));
  }

  editComment(boardId: string, commentId: string, body: string) {
    return this.request<{ comment: TeamComment }>(
      'PATCH',
      `/api/boards/${encodeURIComponent(boardId)}/comments/${encodeURIComponent(commentId)}`,
      { body }
    ).then((r) => r.comment);
  }

  markCommentsRead(boardId: string, cardId: string) {
    return this.request<{ ok: boolean }>(
      'POST',
      `/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/comments/read`
    );
  }

  addComment(boardId: string, cardId: string, body: string, replyTo?: string | null) {
    return this.request<{ comment: TeamComment }>(
      'POST',
      `/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/comments`,
      { body, ...(replyTo ? { replyTo } : {}) }
    ).then((r) => r.comment);
  }

  deleteComment(boardId: string, commentId: string) {
    return this.request<{ ok: boolean }>(
      'DELETE',
      `/api/boards/${encodeURIComponent(boardId)}/comments/${encodeURIComponent(commentId)}`
    );
  }

  /**
   * Upload with progress (0..1) when the platform allows a direct request;
   * otherwise falls back to requestUrl, which can't report progress.
   */
  async upload(
    boardId: string,
    file: File,
    opts: { onProgress?: (fraction: number | null) => void; signal?: AbortSignal } = {}
  ): Promise<UploadedFile> {
    if (!this.conn) throw new TeamApiError(0, 'Team server is not configured');
    try {
      return await this.uploadXhr(boardId, file, opts);
    } catch (e) {
      if (!(e instanceof TeamApiError && e.body === 'xhr-blocked')) throw e;
    }
    opts.onProgress?.(null);
    return this.uploadRequestUrl(boardId, file);
  }

  private uploadXhr(
    boardId: string,
    file: File,
    { onProgress, signal }: { onProgress?: (fraction: number | null) => void; signal?: AbortSignal }
  ): Promise<UploadedFile> {
    const conn = this.conn!;
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let sent = 0;
      xhr.open('POST', `${conn.url}/api/boards/${encodeURIComponent(boardId)}/files`);
      xhr.setRequestHeader('Authorization', `Bearer ${conn.token}`);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name || 'file'));
      xhr.upload.onprogress = (e) => {
        sent = e.loaded;
        if (e.lengthComputable && e.total) onProgress?.(e.loaded / e.total);
      };
      xhr.onload = () => {
        let json: any = {};
        try {
          json = JSON.parse(xhr.responseText);
        } catch {
          json = {};
        }
        if (xhr.status >= 400 || xhr.status === 0) {
          reject(new TeamApiError(xhr.status, json?.error || `Upload failed (${xhr.status})`));
        } else resolve(json as UploadedFile);
      };
      // Nothing sent at all usually means the request was blocked (CORS, mixed content): retry another way.
      xhr.onerror = () =>
        reject(
          sent > 0
            ? new TeamApiError(0, 'Connection to the team server was lost')
            : new TeamApiError(0, 'Upload request was blocked', 'xhr-blocked')
        );
      xhr.onabort = () => reject(new UploadCancelled());
      if (signal) {
        if (signal.aborted) return reject(new UploadCancelled());
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.send(file);
    });
  }

  private async uploadRequestUrl(boardId: string, file: File): Promise<UploadedFile> {
    if (!this.conn) throw new TeamApiError(0, 'Team server is not configured');
    const data = await file.arrayBuffer();
    let res;
    try {
      res = await requestUrl({
        url: `${this.conn.url}/api/boards/${encodeURIComponent(boardId)}/files`,
        method: 'POST',
        contentType: file.type || 'application/octet-stream',
        headers: {
          Authorization: `Bearer ${this.conn.token}`,
          'X-Filename': encodeURIComponent(file.name || 'file'),
        },
        body: data,
        throw: false,
      });
    } catch (e) {
      throw new TeamApiError(0, `Cannot reach team server: ${e?.message || e}`);
    }
    let json: any = {};
    try {
      json = res.json;
    } catch {
      json = {};
    }
    if (res.status >= 400) throw new TeamApiError(res.status, json?.error || `Upload failed (${res.status})`);
    return json as UploadedFile;
  }

  // ---------- team management (hosts and the owner) ----------

  team() {
    return this.request<TeamDirectory>('GET', '/api/team');
  }

  createUser(name: string, role: TeamRole, projectIds: string[]) {
    return this.request<{ user: TeamUser; join: string }>('POST', '/api/team/users', { name, role, projectIds });
  }

  updateUser(id: string, patch: { name?: string; role?: TeamRole }) {
    return this.request<TeamDirectory>('PATCH', `/api/team/users/${encodeURIComponent(id)}`, patch);
  }

  resetUserToken(id: string) {
    return this.request<{ join: string }>('POST', `/api/team/users/${encodeURIComponent(id)}/token`);
  }

  removeUser(id: string) {
    return this.request<TeamDirectory>('DELETE', `/api/team/users/${encodeURIComponent(id)}`);
  }

  createProject(name: string) {
    return this.request<TeamDirectory>('POST', '/api/team/projects', { name });
  }

  updateProject(id: string, patch: { name?: string; color?: string }) {
    return this.request<TeamDirectory>('PATCH', `/api/team/projects/${encodeURIComponent(id)}`, patch);
  }

  deleteProject(id: string) {
    return this.request<TeamDirectory>('DELETE', `/api/team/projects/${encodeURIComponent(id)}`);
  }

  setProjectMember(projectId: string, userId: string, member: boolean) {
    return this.request<TeamDirectory>(
      member ? 'PUT' : 'DELETE',
      `/api/team/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`
    );
  }

  myCards() {
    return this.request<{ cards: MyCard[] }>('GET', '/api/me/cards').then((r) => r.cards);
  }

  // ---------- progress and trash ----------

  boardProgress(boardId: string) {
    return this.request<BoardProgress>('GET', `/api/boards/${encodeURIComponent(boardId)}/progress`);
  }

  trash(boardId: string) {
    return this.request<{ cards: TrashedCard[]; days: number }>('GET', `/api/boards/${encodeURIComponent(boardId)}/trash`);
  }

  restoreFromTrash(boardId: string, cardId: string) {
    return this.request<{ ok: boolean }>(
      'POST',
      `/api/boards/${encodeURIComponent(boardId)}/trash/${encodeURIComponent(cardId)}/restore`
    );
  }

  // ---------- @mentions and Telegram notifications ----------

  /** Everyone who can see a card, for the @ picker in comments. */
  cardPeople(boardId: string, cardId: string) {
    return this.request<{ users: TeamUser[] }>(
      'GET',
      `/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/people`
    ).then((r) => r.users);
  }

  telegramStatus() {
    return this.request<TelegramStatus>('GET', '/api/me/telegram');
  }

  /** A t.me link that connects this person's Telegram chat (single use, 15 minutes). */
  telegramLink() {
    return this.request<{ url: string }>('POST', '/api/me/telegram/link').then((r) => r.url);
  }

  telegramUnlink() {
    return this.request<TelegramStatus>('DELETE', '/api/me/telegram');
  }

  // ---------- devices: one account on many phones/computers ----------

  /** The signed-in person plus the device key in use (null when signed in with the join link). */
  whoAmI() {
    return this.request<{ user: TeamUser; device: TeamDevice | null }>('GET', '/api/me');
  }

  devices() {
    return this.request<{ devices: TeamDevice[] }>('GET', '/api/me/devices').then((r) => r.devices);
  }

  /** A device key for this install, traded for the current sign-in. */
  addDevice(name: string, platform: string) {
    return this.request<{ token: string; device: TeamDevice }>('POST', '/api/me/devices', { name, platform });
  }

  renameDevice(id: string, name: string) {
    return this.request<{ devices: TeamDevice[] }>('PATCH', `/api/me/devices/${encodeURIComponent(id)}`, {
      name,
    }).then((r) => r.devices);
  }

  removeDevice(id: string) {
    return this.request<{ devices: TeamDevice[] }>('DELETE', `/api/me/devices/${encodeURIComponent(id)}`).then(
      (r) => r.devices
    );
  }

  /** A single-use code (10 minutes) another device trades for its own key. */
  createPairingCode() {
    return this.request<{ code: string; expiresAt: number; link?: string }>('POST', '/api/me/pairing');
  }

  userDevices(userId: string) {
    return this.request<{ devices: TeamDevice[] }>('GET', `/api/team/users/${encodeURIComponent(userId)}/devices`).then(
      (r) => r.devices
    );
  }

  removeUserDevice(userId: string, deviceId: string) {
    return this.request<{ devices: TeamDevice[] }>(
      'DELETE',
      `/api/team/users/${encodeURIComponent(userId)}/devices/${encodeURIComponent(deviceId)}`
    ).then((r) => r.devices);
  }

  // ---------- WebSocket ----------

  private setStatus(s: ConnectionStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emitter.emit('status', s);
  }

  private wsUrl() {
    if (!this.conn) return null;
    const u = new URL(this.conn.url);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = (u.pathname.replace(/\/+$/, '') || '') + '/ws';
    u.search = `?token=${encodeURIComponent(this.conn.token)}`;
    u.hash = '';
    return u.toString();
  }

  connectSocket() {
    if (this.closed || !this.conn || typeof WebSocket === 'undefined') return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const url = this.wsUrl();
    if (!url) return;
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.setStatus('error');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectDelay = 1000;
      this.setStatus('connected');
      this.pingTimer = activeWindow.setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          /* ignore */
        }
      }, 25000);
    };
    ws.onmessage = (m) => {
      if (this.ws !== ws) return;
      try {
        const ev = JSON.parse(String(m.data)) as TeamServerEvent;
        this.emitter.emit('event', ev);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.cleanupSocket();
      this.setStatus('disconnected');
      // 4001: the server signed this device out (removed, or its link was replaced).
      if (ev?.code === 4001) this.emitter.emit('unauthorized');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.setStatus('error');
    };
  }

  private cleanupSocket() {
    if (this.pingTimer != null) {
      activeWindow.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.ws = null;
  }

  private disconnectSocket() {
    if (this.reconnectTimer != null) {
      activeWindow.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.cleanupSocket();
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private scheduleReconnect() {
    if (this.closed || !this.conn || this.reconnectTimer != null) return;
    this.reconnectTimer = activeWindow.setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSocket();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }
}
