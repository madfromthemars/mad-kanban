import { Platform, apiVersion } from 'obsidian';

import type KanbanPlugin from './main';

export interface ErrorEntry {
  ts: number;
  level: 'error' | 'warn';
  context: string;
  message: string;
  stack?: string;
  count: number;
  meta?: Record<string, unknown>;
}

const LOG_FILE = 'errors.log';
const OLD_LOG_FILE = 'errors.old.log';
const PENDING_FILE = 'errors-pending.json';
const MAX_LOG_BYTES = 512 * 1024;
const MAX_PENDING = 200;
const FLUSH_DELAY = 5000;
const RETRY_DELAY = 60 * 1000;

/**
 * Collects this plugin's errors: uncaught errors and rejections whose stack is in
 * the plugin, console.error calls made by plugin code, and explicit report() calls.
 * Each one is appended to errors.log in the plugin folder and queued for the team
 * server (POST /api/client-logs); the queue survives restarts until it is delivered.
 */
export class ErrorReporter {
  plugin: KanbanPlugin;
  private pending: ErrorEntry[] = [];
  private flushTimer: number | null = null;
  private flushing = false;
  private reporting = false;
  private origConsoleError: typeof console.error | null = null;
  private stopped = false;

  constructor(plugin: KanbanPlugin) {
    this.plugin = plugin;
  }

  get pendingCount() {
    return this.pending.length;
  }

  private get dir() {
    return this.plugin.manifest.dir || `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
  }

  private get marker() {
    return `plugin:${this.plugin.manifest.id}`;
  }

  async start() {
    await this.loadPending();

    const onError = (e: ErrorEvent) => {
      const err = e.error;
      const stack = err?.stack || '';
      if (stack.includes(this.marker) || (e.filename || '').includes(this.marker)) {
        this.report('uncaught', err || e.message);
      }
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const stack = e.reason?.stack || '';
      if (stack.includes(this.marker)) this.report('unhandled-rejection', e.reason);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    this.plugin.register(() => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    });

    // console.error calls made from this plugin's code.
    const orig = console.error;
    this.origConsoleError = orig;
    const marker = this.marker;
    console.error = (...args: unknown[]) => {
      orig.apply(console, args);
      try {
        const caller = new Error().stack || '';
        // Frame 0 is this wrapper, frame 1 is the caller.
        const callerFrame = caller.split('\n').slice(2, 4).join('\n');
        const err = args.find((a) => a instanceof Error) as Error | undefined;
        if (callerFrame.includes(marker) || err?.stack?.includes(marker)) {
          this.report('console', err || args.map(describe).join(' '), {
            note: args.filter((a) => !(a instanceof Error)).map(describe).join(' ').slice(0, 500),
          });
        }
      } catch {
        /* never let reporting break logging */
      }
    };

    if (this.pending.length) this.scheduleFlush(FLUSH_DELAY);
  }

  stop() {
    this.stopped = true;
    if (this.origConsoleError) console.error = this.origConsoleError;
    if (this.flushTimer != null) window.clearTimeout(this.flushTimer);
    void this.flush();
  }

  /** Record an error. `context` says where it happened, e.g. "sync.flush". */
  report(context: string, error: unknown, meta?: Record<string, unknown>, level: 'error' | 'warn' = 'error') {
    if (this.reporting) return;
    this.reporting = true;
    try {
      const message =
        error instanceof Error ? `${error.name}: ${error.message}` : String(describe(error)).slice(0, 4000);
      const stack = error instanceof Error ? error.stack : undefined;
      const entry: ErrorEntry = { ts: Date.now(), level, context, message, stack, count: 1, meta };

      // Collapse repeats of the same error that haven't been sent yet.
      const same = this.pending.find((p) => p.context === context && p.message === message);
      if (same) {
        same.count++;
        same.ts = entry.ts;
      } else {
        this.pending.push(entry);
        if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
      }

      void this.appendToLog(entry);
      void this.savePending();
      this.scheduleFlush(FLUSH_DELAY);
    } finally {
      this.reporting = false;
    }
  }

  warn(context: string, error: unknown, meta?: Record<string, unknown>) {
    this.report(context, error, meta, 'warn');
  }

  private scheduleFlush(delay: number) {
    if (this.stopped || this.flushTimer != null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delay);
  }

  /** Send queued entries to the team server. */
  async flush() {
    const client = this.plugin.team?.client;
    if (this.flushing || !this.pending.length || !client?.isConfigured) return;
    this.flushing = true;
    const batch = this.pending.slice(0, 50);
    try {
      await client.sendClientLogs(batch, {
        pluginVersion: this.plugin.manifest.version,
        obsidianVersion: apiVersion,
        platform: Platform.isMobile ? 'mobile' : Platform.isMacOS ? 'mac' : Platform.isWin ? 'windows' : 'linux',
        clientId: client.clientId,
      });
      this.pending = this.pending.filter((p) => !batch.includes(p));
      await this.savePending();
      if (this.pending.length) this.scheduleFlush(1000);
    } catch {
      // Server unreachable: keep the entries and try again later.
      this.scheduleFlush(RETRY_DELAY);
    } finally {
      this.flushing = false;
    }
  }

  private async appendToLog(e: ErrorEntry) {
    try {
      const adapter = this.plugin.app.vault.adapter;
      const path = `${this.dir}/${LOG_FILE}`;
      const stat = await adapter.stat(path);
      if (stat && stat.size > MAX_LOG_BYTES) {
        const old = `${this.dir}/${OLD_LOG_FILE}`;
        if (await adapter.exists(old)) await adapter.remove(old);
        await adapter.rename(path, old);
      }
      const line =
        `[${new Date(e.ts).toISOString()}] ${e.level.toUpperCase()} v${this.plugin.manifest.version} ${e.context}: ${e.message}` +
        (e.meta ? ` ${JSON.stringify(e.meta)}` : '') +
        (e.stack ? `\n${e.stack.split('\n').slice(1, 8).join('\n')}` : '') +
        '\n';
      await adapter.append(path, line);
    } catch {
      /* ignore */
    }
  }

  private async loadPending() {
    try {
      const path = `${this.dir}/${PENDING_FILE}`;
      if (await this.plugin.app.vault.adapter.exists(path)) {
        const data = JSON.parse(await this.plugin.app.vault.adapter.read(path));
        if (Array.isArray(data)) this.pending = data.slice(-MAX_PENDING);
      }
    } catch {
      this.pending = [];
    }
  }

  private async savePending() {
    try {
      const path = `${this.dir}/${PENDING_FILE}`;
      if (!this.pending.length) {
        if (await this.plugin.app.vault.adapter.exists(path)) await this.plugin.app.vault.adapter.remove(path);
        return;
      }
      await this.plugin.app.vault.adapter.write(path, JSON.stringify(this.pending));
    } catch {
      /* ignore */
    }
  }
}

/** Short, content-light description of a console argument. */
function describe(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  if (v == null || typeof v !== 'object') return String(v);
  if (Array.isArray(v)) {
    // e.g. a batch of sync ops: keep the op types, not the card text
    const types = v.map((x) => (x && typeof x === 'object' && 'type' in x ? (x as any).type : typeof x));
    return `[${types.slice(0, 20).join(', ')}${v.length > 20 ? ', …' : ''}]`;
  }
  try {
    return JSON.stringify(v).slice(0, 300);
  } catch {
    return Object.prototype.toString.call(v);
  }
}
