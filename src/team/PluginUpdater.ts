import { Notice, requestUrl } from 'obsidian';
import type KanbanPlugin from 'src/main';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15 * 1000;

/** "2.10.0" > "2.9.3" */
export function isNewerVersion(remote: string, local: string) {
  const a = String(remote || '').split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(local || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Pulls new plugin builds from the team server (`/plugin/manifest.json`,
 * `/plugin/main.js`, `/plugin/styles.css`) and installs them into this
 * plugin's folder. The new code runs after the plugin is reloaded.
 */
export class PluginUpdater {
  plugin: KanbanPlugin;
  private timer: number | null = null;
  private firstTimer: number | null = null;
  private busy = false;
  private installedVersion: string | null = null;

  constructor(plugin: KanbanPlugin) {
    this.plugin = plugin;
  }

  start() {
    this.firstTimer = window.setTimeout(() => { void this.check(false); }, FIRST_CHECK_DELAY_MS);
    this.timer = window.setInterval(() => { void this.check(false); }, CHECK_EVERY_MS);
  }

  destroy() {
    if (this.firstTimer != null) window.clearTimeout(this.firstTimer);
    if (this.timer != null) window.clearInterval(this.timer);
  }

  private get serverUrl() {
    return this.plugin.settings['team-server-url'] || null;
  }

  async check(manual: boolean) {
    if (this.busy) return;
    if (!manual && this.plugin.settings['team-auto-update'] === false) return;
    const base = this.serverUrl;
    if (!base) {
      if (manual) new Notice('Kanban: connect to a team server first (Settings → Kanban Custom → Team)');
      return;
    }
    this.busy = true;
    try {
      const res = await requestUrl({ url: `${base}/plugin/manifest.json?t=${Date.now()}`, throw: false });
      if (res.status !== 200) {
        if (manual) new Notice(`Kanban: no plugin release on the server (HTTP ${res.status})`);
        return;
      }
      const remote = res.json;
      const local = this.installedVersion || (await this.diskVersion()) || this.plugin.manifest.version;
      if (!remote?.version || remote.id !== this.plugin.manifest.id || !isNewerVersion(remote.version, local)) {
        if (manual) new Notice(`Kanban: you have the latest version (${local})`);
        return;
      }

      const [js, css] = await Promise.all([
        requestUrl({ url: `${base}/plugin/main.js?v=${encodeURIComponent(remote.version)}`, throw: false }),
        requestUrl({ url: `${base}/plugin/styles.css?v=${encodeURIComponent(remote.version)}`, throw: false }),
      ]);
      if (js.status !== 200 || css.status !== 200) throw new Error('download failed');
      const code = js.text;
      if (code.length < 50000 || !code.includes('kanban')) throw new Error('downloaded main.js looks wrong');

      const dir = this.plugin.manifest.dir;
      const adapter = this.plugin.app.vault.adapter;
      await adapter.write(`${dir}/styles.css`, css.text);
      await adapter.write(`${dir}/main.js`, code);
      await adapter.write(`${dir}/manifest.json`, JSON.stringify(remote, null, '\t'));
      this.installedVersion = remote.version;

      this.announce(remote.version);
    } catch (e) {
      console.error('[Kanban] plugin update failed', e);
      if (manual) new Notice(`Kanban: update failed (${e?.message || e})`);
    } finally {
      this.busy = false;
    }
  }

  /** Version in manifest.json on disk; Obsidian keeps the old manifest in memory until restart. */
  private async diskVersion(): Promise<string | null> {
    try {
      const raw = await this.plugin.app.vault.adapter.read(`${this.plugin.manifest.dir}/manifest.json`);
      return JSON.parse(raw).version || null;
    } catch {
      return null;
    }
  }

  private announce(version: string) {
    const frag = document.createDocumentFragment();
    frag.createDiv({ text: `Kanban Custom was updated to ${version}.` });
    const link = frag.createEl('a', { text: 'Click here to reload it now', href: '#' });
    const notice = new Notice(frag, 0);
    link.addEventListener('click', (e) => {
      e.preventDefault();
      notice.hide();
      void this.reload();
    });
  }

  private async reload() {
    const plugins = (this.plugin.app as any).plugins;
    const id = this.plugin.manifest.id;
    await plugins.disablePlugin(id);
    try {
      await plugins.loadManifests?.();
    } catch {
      /* older Obsidian: version shows after restart */
    }
    await plugins.enablePlugin(id);
  }
}
