import EventEmitter from 'eventemitter3';
import { requestUrl } from 'obsidian';

import {
  TeamComment,
  UploadedFile,
  MyCard,
  OpsResponse,
  TeamBoardMeta,
  TeamBoardSnapshot,
  TeamOp,
  TeamServerEvent,
  TeamUser,
} from './types';

export interface TeamConnection {
  url: string;
  token: string;
}

/** Parse "https://host:port/#TOKEN" (or "host:port#TOKEN") into url + token. */
export function parseJoinString(raw: string): TeamConnection | null {
  const str = (raw || '').trim();
  if (!str) return null;
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

  comments(boardId: string, cardId: string) {
    return this.request<{ comments: TeamComment[] }>(
      'GET',
      `/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/comments`
    ).then((r) => r.comments);
  }

  addComment(boardId: string, cardId: string, body: string) {
    return this.request<{ comment: TeamComment }>(
      'POST',
      `/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/comments`,
      { body }
    ).then((r) => r.comment);
  }

  deleteComment(boardId: string, commentId: string) {
    return this.request<{ ok: boolean }>(
      'DELETE',
      `/api/boards/${encodeURIComponent(boardId)}/comments/${encodeURIComponent(commentId)}`
    );
  }

  async upload(boardId: string, file: File): Promise<UploadedFile> {
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

  myCards() {
    return this.request<{ cards: MyCard[] }>('GET', '/api/me/cards').then((r) => r.cards);
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
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.cleanupSocket();
      this.setStatus('disconnected');
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
