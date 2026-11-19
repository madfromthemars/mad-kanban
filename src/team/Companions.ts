import { Notice, requestUrl } from 'obsidian';
import type KanbanPlugin from 'src/main';

/**
 * Other community plugins the team relies on. Everyone on a team should have them, or
 * shared files look different for different people (and an old client can drop the
 * extra fields those plugins keep in a file).
 */
export interface Companion {
  id: string;
  name: string;
  /** GitHub "owner/repo"; files come from its latest release. */
  repo: string;
  why: string;
}

export const COMPANIONS: Companion[] = [
  {
    id: 'advanced-canvas',
    name: 'Advanced Canvas',
    repo: 'Developer-Mike/obsidian-advanced-canvas',
    why: 'shared canvases use its shapes, arrow styles and groups',
  },
];

const REMIND_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 20 * 1000;

type State = 'ok' | 'disabled' | 'missing';

/** Asks (and keeps asking) team members to install the plugins in COMPANIONS, one click each. */
export class Companions {
  private plugin: KanbanPlugin;
  private timers: number[] = [];
  private notices = new Map<string, Notice>();
  private busy = new Set<string>();

  constructor(plugin: KanbanPlugin) {
    this.plugin = plugin;
  }

  private get plugins(): any {
    return (this.plugin.app as any).plugins;
  }

  start() {
    this.timers.push(window.setTimeout(() => this.check(), FIRST_CHECK_DELAY_MS));
    this.timers.push(window.setInterval(() => this.check(), REMIND_EVERY_MS));
  }

  destroy() {
    for (const t of this.timers) window.clearTimeout(t), window.clearInterval(t);
    this.timers = [];
    for (const n of this.notices.values()) n.hide();
    this.notices.clear();
  }

  state(c: Companion): State {
    if (this.plugins?.enabledPlugins?.has(c.id)) return 'ok';
    return this.plugins?.manifests?.[c.id] ? 'disabled' : 'missing';
  }

  /** Only people on a team are asked. */
  private get onTeam() {
    return !!(this.plugin.team?.client?.isConfigured && this.plugin.team?.user);
  }

  /** Show a reminder for every companion that's missing or turned off. */
  check(force = false) {
    if (!force && !this.onTeam) return;
    for (const c of COMPANIONS) if (this.state(c) !== 'ok') this.remind(c);
  }

  private remind(c: Companion) {
    if (this.notices.has(c.id)) return;
    const st = this.state(c);
    const frag = document.createDocumentFragment();
    frag.createDiv({ text: `Mad Kanban: your team needs the ${c.name} plugin (${c.why}).` });
    const btn = frag.createEl('button', {
      text: st === 'disabled' ? `Turn on ${c.name}` : `Install ${c.name}`,
      cls: 'mod-cta',
    });
    btn.style.marginTop = '8px';
    const notice = new Notice(frag, 0);
    this.notices.set(c.id, notice);
    const hide = (notice as any).hide.bind(notice);
    (notice as any).hide = () => {
      this.notices.delete(c.id);
      hide();
    };
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.disabled = true;
      btn.setText('Installing…');
      void this.install(c).then((ok) => {
        notice.hide();
        if (ok) new Notice(`${c.name} is installed and turned on.`);
      });
    });
  }

  /** Download the latest release into .obsidian/plugins/<id> and turn it on. */
  async install(c: Companion): Promise<boolean> {
    if (this.busy.has(c.id)) return false;
    this.busy.add(c.id);
    try {
      if (this.state(c) === 'missing') {
        const base = `https://github.com/${c.repo}/releases/latest/download`;
        const get = (f: string) => requestUrl({ url: `${base}/${f}`, throw: false });
        const [manifest, js, css] = await Promise.all([get('manifest.json'), get('main.js'), get('styles.css')]);
        if (manifest.status !== 200 || js.status !== 200) throw new Error(`download failed (HTTP ${manifest.status}/${js.status})`);
        const m = JSON.parse(manifest.text);
        if (m?.id !== c.id) throw new Error('downloaded manifest is for another plugin');
        const adapter = this.plugin.app.vault.adapter;
        const dir = `${this.plugin.app.vault.configDir}/plugins/${c.id}`;
        if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
        await adapter.write(`${dir}/main.js`, js.text);
        if (css.status === 200) await adapter.write(`${dir}/styles.css`, css.text);
        await adapter.write(`${dir}/manifest.json`, manifest.text);
        await this.plugins.loadManifests?.();
      }
      await this.plugins.enablePluginAndSave(c.id);
      return this.state(c) === 'ok';
    } catch (e: any) {
      console.error(`[Kanban] installing ${c.id} failed`, e);
      new Notice(`Mad Kanban: couldn't install ${c.name} (${e?.message || e}). Install it from Settings → Community plugins.`);
      this.plugin.reportWarning('companion-install', e);
      return false;
    } finally {
      this.busy.delete(c.id);
    }
  }
}
