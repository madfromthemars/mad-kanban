// Password vault screens. Secrets only ever live in these windows' memory.

import { App, Modal, Notice, Platform, setIcon } from 'obsidian';

import type { TeamManager } from '../TeamManager';
import type { SecretContent, SecretField } from './crypto';
import type { AllowRequest, VaultItem, VaultPerson, VaultSync } from './VaultSync';

const CLIPBOARD_CLEAR_MS = 30_000;
const REVEAL_MS = 20_000;

const when = (t: number) => {
  const d = new Date(t);
  const same = d.toDateString() === new Date().toDateString();
  const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  return same ? `Today, ${d.toLocaleTimeString([], time)}` : d.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', ...time });
};

const errText = (e: unknown) => String((e as any)?.message || e);

let clipTimer: number | null = null;
/** Copy a secret; clear the clipboard after 30 s if it still holds it. */
export async function copySecret(value: string, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    new Notice('Could not copy.');
    return false;
  }
  new Notice(`${what}. The clipboard clears in 30 seconds.`, 3000);
  if (clipTimer != null) window.clearTimeout(clipTimer);
  clipTimer = window.setTimeout(async () => {
    clipTimer = null;
    try {
      if ((await navigator.clipboard.readText()) !== value) return;
    } catch {
      /* can't read: clear anyway */
    }
    await navigator.clipboard.writeText('').catch(() => {});
  }, CLIPBOARD_CLEAR_MS);
  return true;
}

export function generatePassword(len = 20) {
  const sets = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '-_.!@#%+='];
  const all = sets.join('');
  const pick = (s: string) => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  for (;;) {
    const out = Array.from({ length: len }, () => pick(all)).join('');
    if (sets.every((s) => [...out].some((ch) => s.includes(ch)))) return out;
  }
}

function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void, cls = '') {
  const b = parent.createEl('button', { cls: `mk-vault-icon-btn clickable-icon ${cls}`, attr: { 'aria-label': label } });
  setIcon(b, icon);
  b.onclick = (e) => {
    e.stopPropagation();
    onClick();
  };
  return b;
}

/** A styled on/off switch (not a native checkbox). */
function toggle(parent: HTMLElement, label: string, on: boolean, onChange: (v: boolean) => void) {
  const row = parent.createDiv({ cls: 'mk-vault-toggle-row' });
  row.createSpan({ text: label, cls: 'mk-vault-toggle-label' });
  const sw = row.createDiv({ cls: `checkbox-container${on ? ' is-enabled' : ''}` });
  sw.onclick = () => {
    on = !on;
    sw.toggleClass('is-enabled', on);
    onChange(on);
  };
  return row;
}

function projectsOf(team: TeamManager) {
  return team.projects.filter((p) => !p.isPrivate && p.memberIds.includes(team.user?.id || ''));
}

// ---------- the main window ----------

export class VaultModal extends Modal {
  private projectId: string | null;
  private query = '';
  private off: (() => void) | null = null;

  constructor(
    app: App,
    private team: TeamManager,
    private vault: VaultSync,
    projectId?: string | null
  ) {
    super(app);
    this.projectId = projectId ?? null;
  }

  onOpen() {
    this.modalEl.addClass('mk-vault-modal');
    this.titleEl.setText('Passwords');
    this.off = this.vault.onChange(() => this.render());
    if (this.vault.state === 'ready') void this.vault.refresh().catch(() => {});
    this.render();
  }

  onClose() {
    this.off?.();
    this.contentEl.empty();
  }

  private render() {
    const el = this.contentEl;
    const keepFocus = document.activeElement?.classList.contains('mk-vault-search');
    el.empty();
    const v = this.vault;
    if (v.state === 'loading') return void el.createDiv({ cls: 'mk-vault-empty', text: 'Loading…' });
    if (v.state === 'offline' || v.state === 'error') return void el.createDiv({ cls: 'mk-vault-empty', text: v.stateText || 'Passwords are not available right now.' });
    if (v.state === 'new') return this.renderSetup(el);
    if (v.state === 'needs-key') return this.renderNeedsKey(el);

    const projects = projectsOf(this.team);
    if (!projects.length) return void el.createDiv({ cls: 'mk-vault-empty', text: 'You are not in any team project yet.' });
    if (this.projectId && !projects.some((p) => p.id === this.projectId)) this.projectId = null;

    const chips = el.createDiv({ cls: 'mk-vault-chips' });
    const chip = (id: string | null, name: string, color?: string) => {
      const n = v.list(id ?? undefined).length;
      const b = chips.createEl('button', { cls: `mk-vault-chip${this.projectId === id ? ' is-on' : ''}` });
      if (color) b.createSpan({ cls: 'mk-vault-dot' }).style.background = color;
      b.createSpan({ text: name });
      b.createSpan({ cls: 'mk-vault-chip-count', text: String(n) });
      b.onclick = () => {
        this.projectId = id;
        this.render();
      };
    };
    chip(null, 'All');
    for (const p of projects) chip(p.id, p.name, p.color);

    const bar = el.createDiv({ cls: 'mk-vault-bar' });
    const search = bar.createEl('input', { cls: 'mk-vault-search', attr: { type: 'search', placeholder: 'Search your passwords' } });
    search.value = this.query;
    search.oninput = () => {
      this.query = search.value;
      this.renderList(list);
    };
    if (keepFocus) window.setTimeout(() => search.focus(), 0);
    const add = bar.createEl('button', { cls: 'mod-cta', text: 'New' });
    add.onclick = () => {
      const pid = this.projectId ?? (projects.length === 1 ? projects[0].id : null);
      if (!pid) return pickProject(this.app, projects, (id) => new EditSecretModal(this.app, this.team, v, id, null).open());
      new EditSecretModal(this.app, this.team, v, pid, null).open();
    };

    const list = el.createDiv({ cls: 'mk-vault-list' });
    this.renderList(list);

    const foot = el.createDiv({ cls: 'mk-vault-foot' });
    const trashN = v.trash().length;
    const t = foot.createEl('button', { cls: 'mk-vault-link', text: trashN ? `Deleted (${trashN})` : 'Deleted' });
    t.onclick = () => new VaultTrashModal(this.app, this.team, v).open();
    const k = foot.createEl('button', { cls: 'mk-vault-link', text: 'My key' });
    k.onclick = () => new MyKeyModal(this.app, v).open();
  }

  private renderList(list: HTMLElement) {
    list.empty();
    const q = this.query.trim().toLowerCase();
    const items = this.vault.list(this.projectId ?? undefined).filter((i) => {
      if (!q) return true;
      const c = i.content;
      return !!c && [c.title, c.url, ...c.fields.filter((f) => !f.hidden).map((f) => f.value)].some((s) => s?.toLowerCase().includes(q));
    });
    if (!items.length) {
      list.createDiv({
        cls: 'mk-vault-empty',
        text: q ? 'Nothing matches.' : 'No passwords here yet. Only secrets someone added you to show up — nobody else can see them, the owner included.',
      });
      return;
    }
    for (const it of items) {
      const row = list.createDiv({ cls: `mk-vault-row${it.problem ? ' has-problem' : ''}` });
      const ic = row.createDiv({ cls: 'mk-vault-row-icon' });
      setIcon(ic, it.problem ? 'shield-alert' : it.content?.kind === 'login' ? 'key-round' : 'lock');
      const text = row.createDiv({ cls: 'mk-vault-row-text' });
      text.createDiv({ cls: 'mk-vault-row-title', text: it.content?.title || 'Can not open this secret' });
      const user = it.content?.fields.find((f) => !f.hidden && f.value)?.value;
      const proj = this.team.projects.find((p) => p.id === it.projectId)?.name;
      text.createDiv({ cls: 'mk-vault-row-sub', text: it.problem || [user, !this.projectId ? proj : null, `${it.access.length} ${it.access.length === 1 ? 'person' : 'people'}`].filter(Boolean).join(' · ') });
      const pw = it.content?.fields.find((f) => f.hidden && f.value);
      if (pw) iconButton(row, 'copy', `Copy ${pw.label}`, () => void copySecret(pw.value, `${pw.label} copied`).then((ok) => ok && this.vault.report(it, 'copied', pw.label)));
      row.onclick = () => new SecretModal(this.app, this.team, this.vault, it.id).open();
    }
  }

  private renderSetup(el: HTMLElement) {
    const box = el.createDiv({ cls: 'mk-vault-setup' });
    box.createEl('h3', { text: 'Keep team passwords in Mad Kanban' });
    const ul = box.createEl('ul');
    ul.createEl('li', { text: 'Passwords are locked on your device before they are sent. The server can not read them.' });
    ul.createEl('li', { text: 'Each password is shared only with the people you pick. Nobody else sees it — not even the owner.' });
    ul.createEl('li', { text: 'Your key stays on your devices. "Add a device" brings it to your phone or another computer.' });
    let rec = true;
    toggle(box, 'Make a recovery code (recommended — the only way back if you lose every device)', rec, (x) => (rec = x));
    const go = box.createEl('button', { cls: 'mod-cta', text: 'Set up passwords' });
    go.onclick = async () => {
      go.disabled = true;
      try {
        const code = await this.vault.setUp(rec);
        if (code) new RecoveryCodeModal(this.app, code).open();
      } catch (e) {
        new Notice(`Mad Kanban: could not set up passwords. ${errText(e)}`, 8000);
        go.disabled = false;
      }
    };
  }

  private renderNeedsKey(el: HTMLElement) {
    const box = el.createDiv({ cls: 'mk-vault-setup' });
    box.createEl('h3', { text: 'Bring your key to this device' });
    box.createEl('p', { text: 'You set up passwords on another device. Your key never goes through the server unlocked, so this device needs it from you:' });

    const a = box.createDiv({ cls: 'mk-vault-option' });
    a.createDiv({ cls: 'mk-vault-option-title', text: 'From your other device' });
    const aText = a.createDiv({ cls: 'mk-vault-option-sub', text: 'Open Obsidian on a device that already has your passwords. It will ask you to allow this one.' });
    const ask = a.createEl('button', { cls: 'mod-cta', text: 'Ask my other device' });
    const signal = { cancelled: false };
    this.scope.register([], 'Escape', () => {
      signal.cancelled = true;
      this.close();
    });
    ask.onclick = async () => {
      ask.disabled = true;
      try {
        const ok = await this.vault.askOtherDevice(
          deviceName(),
          (code) => {
            aText.empty();
            aText.createSpan({ text: 'On your other device, check that it shows this code, then tap Allow: ' });
            aText.createEl('b', { cls: 'mk-vault-code', text: code });
          },
          signal
        );
        if (!ok && !signal.cancelled) {
          aText.setText('No answer in 15 minutes. Try again.');
          ask.disabled = false;
        }
      } catch (e) {
        aText.setText(errText(e));
        ask.disabled = false;
      }
    };
    const oldClose = this.onClose.bind(this);
    this.onClose = () => {
      signal.cancelled = true;
      oldClose();
    };

    if (this.vault.hasRecovery) {
      const b = box.createDiv({ cls: 'mk-vault-option' });
      b.createDiv({ cls: 'mk-vault-option-title', text: 'With your recovery code' });
      const row = b.createDiv({ cls: 'mk-vault-inline' });
      const inp = row.createEl('input', { attr: { type: 'text', placeholder: 'XXXX-XXXX-…', autocomplete: 'off', spellcheck: 'false' } });
      const use = row.createEl('button', { text: 'Use code' });
      use.onclick = async () => {
        use.disabled = true;
        try {
          await this.vault.useRecoveryCode(inp.value);
          new Notice('Mad Kanban: your passwords are on this device now.');
        } catch (e) {
          new Notice(`Mad Kanban: ${errText(e)}`, 8000);
          use.disabled = false;
        }
      };
    }

    const c = box.createDiv({ cls: 'mk-vault-option' });
    c.createDiv({ cls: 'mk-vault-option-title', text: 'Lost every device?' });
    c.createDiv({
      cls: 'mk-vault-option-sub',
      text: 'Start over with a new key. Passwords others also have can be shared with you again; ones only you had are gone (change them at the service).',
    });
    const so = c.createEl('button', { cls: 'mod-warning', text: 'Start over' });
    so.onclick = () =>
      confirmModal(this.app, 'Start over with a new key?', 'You will lose access to every password until someone shares it with you again. This can not be undone.', 'Start over', async () => {
        const code = await this.vault.startOver(true);
        if (code) new RecoveryCodeModal(this.app, code).open();
      });
  }
}

function deviceName() {
  return Platform.isMobile ? (Platform.isIosApp ? 'iPhone / iPad' : 'Android phone') : Platform.isMacOS ? 'Mac' : Platform.isWin ? 'Windows PC' : 'Computer';
}

function pickProject(app: App, projects: { id: string; name: string; color: string }[], then: (id: string) => void) {
  const m = new Modal(app);
  m.modalEl.addClass('mk-vault-modal', 'mk-vault-small');
  m.titleEl.setText('Which project?');
  const list = m.contentEl.createDiv({ cls: 'mk-vault-list' });
  for (const p of projects) {
    const row = list.createDiv({ cls: 'mk-vault-row' });
    row.createSpan({ cls: 'mk-vault-dot' }).style.background = p.color;
    row.createDiv({ cls: 'mk-vault-row-title', text: p.name });
    row.onclick = () => {
      m.close();
      then(p.id);
    };
  }
  m.open();
}

function confirmModal(app: App, title: string, text: string, cta: string, run: () => Promise<void>) {
  const m = new Modal(app);
  m.modalEl.addClass('mk-vault-modal', 'mk-vault-small');
  m.titleEl.setText(title);
  m.contentEl.createEl('p', { text });
  const acts = m.contentEl.createDiv({ cls: 'mk-vault-actions' });
  acts.createEl('button', { text: 'Cancel' }).onclick = () => m.close();
  const b = acts.createEl('button', { cls: 'mod-warning', text: cta });
  b.onclick = async () => {
    b.disabled = true;
    try {
      await run();
      m.close();
    } catch (e) {
      new Notice(`Mad Kanban: ${errText(e)}`, 8000);
      b.disabled = false;
    }
  };
  m.open();
}

// ---------- one secret ----------

export class SecretModal extends Modal {
  private off: (() => void) | null = null;
  private timers: number[] = [];
  private shown = new Set<number>();

  constructor(
    app: App,
    private team: TeamManager,
    private vault: VaultSync,
    private id: string
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass('mk-vault-modal');
    const it = this.vault.items.get(this.id);
    if (it?.content) this.vault.report(it, 'opened');
    this.off = this.vault.onChange(() => this.render());
    this.render();
  }

  onClose() {
    this.off?.();
    for (const t of this.timers) window.clearTimeout(t);
    this.contentEl.empty();
  }

  private render() {
    const el = this.contentEl;
    el.empty();
    const it = this.vault.items.get(this.id);
    if (!it || it.deletedAt) {
      this.titleEl.setText('Password');
      el.createDiv({ cls: 'mk-vault-empty', text: it?.deletedAt ? 'This secret was deleted.' : 'You no longer have this secret.' });
      return;
    }
    const c = it.content;
    this.titleEl.setText(c?.title || 'Can not open this secret');
    const project = this.team.projects.find((p) => p.id === it.projectId);
    const meta = el.createDiv({ cls: 'mk-vault-meta' });
    if (project) {
      meta.createSpan({ cls: 'mk-vault-dot' }).style.background = project.color;
      meta.createSpan({ text: project.name });
    }
    meta.createSpan({ text: ` · changed ${when(it.updatedAt)} by ${this.team.userName(it.updatedBy)}` });
    if (it.problem || !c) {
      el.createDiv({ cls: 'mk-vault-problem', text: it.problem || 'This secret could not be opened.' });
      return;
    }

    const fields = el.createDiv({ cls: 'mk-vault-fields' });
    c.fields.forEach((f, i) => this.fieldRow(fields, it, f, i));
    if (c.url) {
      const row = fields.createDiv({ cls: 'mk-vault-field' });
      row.createDiv({ cls: 'mk-vault-field-label', text: 'Website' });
      const val = row.createDiv({ cls: 'mk-vault-field-value' });
      const a = val.createEl('a', { text: c.url, href: /^https?:\/\//i.test(c.url) ? c.url : `https://${c.url}` });
      a.target = '_blank';
      iconButton(row, 'copy', 'Copy website', () => void copySecret(c.url!, 'Website copied'));
    }
    if (c.note) {
      const row = fields.createDiv({ cls: 'mk-vault-field is-note' });
      row.createDiv({ cls: 'mk-vault-field-label', text: 'Note' });
      row.createDiv({ cls: 'mk-vault-field-value is-note', text: c.note });
    }

    // People
    const ps = el.createDiv({ cls: 'mk-vault-section' });
    const head = ps.createDiv({ cls: 'mk-vault-section-head' });
    head.createSpan({ cls: 'mk-vault-section-title', text: `Who has it (${it.access.length})` });
    const addBtn = head.createEl('button', { cls: 'mk-vault-link', text: '+ Add person' });
    addBtn.onclick = () => void this.addPerson(it);
    const chips = ps.createDiv({ cls: 'mk-vault-people' });
    for (const a of it.access) {
      const ch = chips.createDiv({ cls: 'mk-vault-person' });
      ch.createSpan({ text: a.userId === this.team.user?.id ? `${a.name} (you)` : a.name });
      iconButton(ch, 'x', `Remove ${a.name}`, () => this.removePerson(it, a.userId, a.name), 'is-small');
    }

    const acts = el.createDiv({ cls: 'mk-vault-actions' });
    acts.createEl('button', { text: 'History' }).onclick = () => new VaultHistoryModal(this.app, this.vault, it).open();
    const del = acts.createEl('button', { text: 'Delete', cls: 'mod-warning' });
    del.onclick = () =>
      confirmModal(this.app, `Delete “${c.title}”?`, 'It goes to Deleted for 30 days, for everyone who has it.', 'Delete', async () => {
        await this.vault.remove(it);
        this.close();
      });
    const edit = acts.createEl('button', { text: 'Edit', cls: 'mod-cta' });
    edit.onclick = () => new EditSecretModal(this.app, this.team, this.vault, it.projectId, it).open();
  }

  private fieldRow(parent: HTMLElement, it: VaultItem, f: SecretField, i: number) {
    const row = parent.createDiv({ cls: 'mk-vault-field' });
    row.createDiv({ cls: 'mk-vault-field-label', text: f.label });
    const hidden = f.hidden && !this.shown.has(i);
    row.createDiv({ cls: `mk-vault-field-value${hidden ? ' is-hidden' : ' is-mono'}`, text: hidden ? '•'.repeat(Math.min(16, Math.max(8, f.value.length))) : f.value });
    if (f.hidden)
      iconButton(row, this.shown.has(i) ? 'eye-off' : 'eye', this.shown.has(i) ? 'Hide' : 'Show for 20 seconds', () => {
        if (this.shown.has(i)) this.shown.delete(i);
        else {
          this.shown.add(i);
          this.vault.report(it, 'revealed', f.label);
          this.timers.push(
            window.setTimeout(() => {
              this.shown.delete(i);
              this.render();
            }, REVEAL_MS)
          );
        }
        this.render();
      });
    iconButton(row, 'copy', `Copy ${f.label}`, () => void copySecret(f.value, `${f.label} copied`).then((ok) => ok && f.hidden && this.vault.report(it, 'copied', f.label)));
  }

  private async addPerson(it: VaultItem) {
    let people: VaultPerson[];
    try {
      people = await this.vault.people(it.projectId);
    } catch (e) {
      return new Notice(`Mad Kanban: ${errText(e)}`);
    }
    const has = new Set(it.access.map((a) => a.userId));
    const m = new Modal(this.app);
    m.modalEl.addClass('mk-vault-modal', 'mk-vault-small');
    m.titleEl.setText('Share with');
    const list = m.contentEl.createDiv({ cls: 'mk-vault-list' });
    const cands = people.filter((p) => !has.has(p.userId));
    if (!cands.length) list.createDiv({ cls: 'mk-vault-empty', text: 'Everyone in this project already has it.' });
    for (const p of cands) {
      const row = list.createDiv({ cls: `mk-vault-row${!p.ready || p.changed ? ' is-disabled' : ''}` });
      const t = row.createDiv({ cls: 'mk-vault-row-text' });
      t.createDiv({ cls: 'mk-vault-row-title', text: p.name });
      t.createDiv({ cls: 'mk-vault-row-sub', text: !p.ready ? 'Has not set up passwords yet' : p.changed ? 'Key changed — compare safety codes first' : 'Can open it right away' });
      if (p.changed && p.pub) {
        const b = row.createEl('button', { text: 'Check key' });
        b.onclick = (e) => {
          e.stopPropagation();
          m.close();
          new KeyChangedModal(this.app, this.vault, p).open();
        };
      }
      if (!p.ready || p.changed) continue;
      row.onclick = async () => {
        m.close();
        try {
          await this.vault.share(it, p);
          new Notice(`Shared with ${p.name}.`);
        } catch (e) {
          new Notice(`Mad Kanban: ${errText(e)}`, 8000);
        }
      };
    }
    m.open();
  }

  private removePerson(it: VaultItem, userId: string, name: string) {
    const self = userId === this.team.user?.id;
    confirmModal(
      this.app,
      self ? 'Remove yourself?' : `Remove ${name}?`,
      self
        ? 'You will no longer be able to open this secret.'
        : `${name} loses access now. They may have copied it before, so change this password at the service afterwards.`,
      'Remove',
      async () => {
        await this.vault.removePeople(it, [userId]);
        if (!self) new Notice(`Mad Kanban: ${name} removed. Remember to change “${it.content?.title}” at the service — they may have a copy.`, 12000);
        else this.close();
      }
    );
  }
}

// ---------- add / edit ----------

export class EditSecretModal extends Modal {
  private c: SecretContent;
  private picked = new Set<string>();
  private people: VaultPerson[] = [];

  constructor(
    app: App,
    private team: TeamManager,
    private vault: VaultSync,
    private projectId: string,
    private item: VaultItem | null
  ) {
    super(app);
    this.c = item?.content
      ? JSON.parse(JSON.stringify(item.content))
      : { title: '', kind: 'login', fields: [{ label: 'Username', value: '' }, { label: 'Password', value: '', hidden: true }], url: '', note: '' };
  }

  async onOpen() {
    this.modalEl.addClass('mk-vault-modal');
    this.titleEl.setText(this.item ? 'Edit password' : `New password in ${this.team.projects.find((p) => p.id === this.projectId)?.name ?? 'project'}`);
    if (!this.item) this.people = await this.vault.people(this.projectId).catch((): VaultPerson[] => []);
    this.render();
  }

  private render() {
    const el = this.contentEl;
    el.empty();
    const c = this.c;
    const form = el.createDiv({ cls: 'mk-vault-form' });

    const seg = form.createDiv({ cls: 'mk-vault-seg' });
    for (const [k, label] of [['login', 'Login'], ['note', 'Other secret']] as const) {
      const b = seg.createEl('button', { cls: c.kind === k ? 'is-on' : '', text: label });
      b.onclick = () => {
        if (c.kind === k) return;
        c.kind = k;
        if (k === 'note' && !c.fields.some((f) => f.value)) c.fields = [{ label: 'Secret', value: '', hidden: true }];
        if (k === 'login' && !c.fields.some((f) => f.value)) c.fields = [{ label: 'Username', value: '' }, { label: 'Password', value: '', hidden: true }];
        this.render();
      };
    }

    const input = (label: string, value: string, set: (v: string) => void, opts: { placeholder?: string; mono?: boolean; secret?: boolean } = {}) => {
      const row = form.createDiv({ cls: 'mk-vault-input-row' });
      row.createEl('label', { text: label });
      const inp = row.createEl('input', { attr: { type: 'text', placeholder: opts.placeholder || '', autocomplete: 'off', spellcheck: 'false' } });
      if (opts.mono) inp.addClass('is-mono');
      inp.value = value;
      inp.oninput = () => set(inp.value);
      return { row, inp };
    };
    const title = input('Name', c.title, (v) => (c.title = v), { placeholder: c.kind === 'login' ? 'e.g. Hosting panel' : 'e.g. Payme API key' });
    window.setTimeout(() => !this.item && title.inp.focus(), 0);

    c.fields.forEach((f, i) => {
      const row = form.createDiv({ cls: 'mk-vault-input-row is-field' });
      const lab = row.createEl('input', { cls: 'mk-vault-field-name', attr: { type: 'text', 'aria-label': 'Field name' } });
      lab.value = f.label;
      lab.oninput = () => (f.label = lab.value);
      const wrap = row.createDiv({ cls: 'mk-vault-input-wrap' });
      const inp = wrap.createEl('input', { cls: 'is-mono', attr: { type: f.hidden ? 'password' : 'text', autocomplete: 'new-password', spellcheck: 'false' } });
      inp.value = f.value;
      inp.oninput = () => (f.value = inp.value);
      iconButton(wrap, f.hidden ? 'eye-off' : 'eye', f.hidden ? 'Hidden field (click to make visible)' : 'Visible field (click to hide)', () => {
        f.hidden = !f.hidden;
        this.render();
      });
      if (f.hidden)
        iconButton(wrap, 'dices', 'Make a strong password', () => {
          f.value = generatePassword();
          inp.type = 'text';
          inp.value = f.value;
        });
      iconButton(wrap, 'trash-2', 'Remove field', () => {
        c.fields.splice(i, 1);
        this.render();
      });
    });
    const addField = form.createEl('button', { cls: 'mk-vault-link', text: '+ Add field' });
    addField.onclick = () => {
      c.fields.push({ label: 'Field', value: '' });
      this.render();
    };
    if (c.kind === 'login') input('Website', c.url || '', (v) => (c.url = v), { placeholder: 'https://…' });
    const nrow = form.createDiv({ cls: 'mk-vault-input-row' });
    nrow.createEl('label', { text: 'Note' });
    const ta = nrow.createEl('textarea', { attr: { rows: '3', placeholder: 'Optional. Also encrypted.' } });
    ta.value = c.note || '';
    ta.oninput = () => (c.note = ta.value);

    if (!this.item) {
      const ps = el.createDiv({ cls: 'mk-vault-section' });
      ps.createDiv({ cls: 'mk-vault-section-title', text: 'Who can open it' });
      ps.createDiv({ cls: 'mk-vault-hint', text: 'Only the people you pick (and you). Nobody else in the project sees that it exists.' });
      const chips = ps.createDiv({ cls: 'mk-vault-people' });
      const me = chips.createDiv({ cls: 'mk-vault-person is-on is-fixed', text: `${this.team.user?.name} (you)` });
      me.setAttr('aria-disabled', 'true');
      for (const p of this.people.filter((x) => x.userId !== this.team.user?.id)) {
        const ok = p.ready && !p.changed;
        const ch = chips.createEl('button', { cls: `mk-vault-person${this.picked.has(p.userId) ? ' is-on' : ''}${ok ? '' : ' is-disabled'}`, text: p.name });
        ch.setAttr('aria-label', !p.ready ? `${p.name} has not set up passwords yet` : p.changed ? `${p.name}'s key changed — compare safety codes first` : `Share with ${p.name}`);
        if (!ok) {
          ch.disabled = true;
          continue;
        }
        ch.onclick = () => {
          if (this.picked.has(p.userId)) this.picked.delete(p.userId);
          else this.picked.add(p.userId);
          ch.toggleClass('is-on', this.picked.has(p.userId));
        };
      }
      const notReady = this.people.filter((p) => !p.ready);
      if (notReady.length) ps.createDiv({ cls: 'mk-vault-hint', text: `Not set up yet: ${notReady.map((p) => p.name).join(', ')}. You can add them later.` });
    }

    const acts = el.createDiv({ cls: 'mk-vault-actions' });
    acts.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
    const save = acts.createEl('button', { cls: 'mod-cta', text: this.item ? 'Save' : 'Save password' });
    save.onclick = async () => {
      c.title = c.title.trim();
      if (!c.title) return new Notice('Give it a name.');
      c.fields = c.fields.filter((f) => f.label.trim() || f.value);
      save.disabled = true;
      try {
        if (this.item) await this.vault.edit(this.item, c);
        else {
          const out = await this.vault.create(
            this.projectId,
            c,
            this.people.filter((p) => this.picked.has(p.userId))
          );
          if (out) new SecretModal(this.app, this.team, this.vault, out.id).open();
        }
        this.close();
      } catch (e) {
        new Notice(`Mad Kanban: could not save. ${errText(e)}`, 8000);
        save.disabled = false;
      }
    };
  }
}

// ---------- history, trash, key ----------

const ACTIONS: Record<string, string> = {
  created: 'created it',
  edited: 'changed it',
  rekeyed: 'changed who has it',
  shared: 'shared it with',
  removed: 'removed',
  deleted: 'deleted it',
  restored: 'restored it',
  opened: 'opened it',
  copied: 'copied',
  revealed: 'showed',
  'lost-access': 'lost access (left the project)',
  'keys-reset': 'started over with a new key',
};

export class VaultHistoryModal extends Modal {
  constructor(
    app: App,
    private vault: VaultSync,
    private item: VaultItem
  ) {
    super(app);
  }

  async onOpen() {
    this.modalEl.addClass('mk-vault-modal');
    this.titleEl.setText(`History · ${this.item.content?.title ?? ''}`);
    const el = this.contentEl;
    el.createDiv({ cls: 'mk-vault-hint', text: '“Opened” and “copied” are what each person’s app reports.' });
    const list = el.createDiv({ cls: 'mk-vault-history' });
    try {
      for (const e of await this.vault.history(this.item)) {
        const row = list.createDiv({ cls: 'mk-vault-history-row' });
        row.createSpan({ cls: 'mk-vault-history-when', text: when(e.at) });
        row.createSpan({ text: `${e.by} ${ACTIONS[e.action] ?? e.action}${e.target ? ` ${e.target}` : ''}${e.detail ? ` the ${e.detail.toLowerCase()}` : ''}` });
      }
    } catch (err) {
      list.setText(errText(err));
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class VaultTrashModal extends Modal {
  private off: (() => void) | null = null;
  constructor(
    app: App,
    private team: TeamManager,
    private vault: VaultSync
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass('mk-vault-modal');
    this.titleEl.setText('Deleted passwords');
    this.off = this.vault.onChange(() => this.render());
    this.render();
  }

  onClose() {
    this.off?.();
    this.contentEl.empty();
  }

  private render() {
    const el = this.contentEl;
    el.empty();
    el.createDiv({ cls: 'mk-vault-hint', text: 'Kept for 30 days, then removed for good.' });
    const list = el.createDiv({ cls: 'mk-vault-list' });
    const items = this.vault.trash();
    if (!items.length) list.createDiv({ cls: 'mk-vault-empty', text: 'Nothing deleted.' });
    for (const it of items) {
      const row = list.createDiv({ cls: 'mk-vault-row' });
      const t = row.createDiv({ cls: 'mk-vault-row-text' });
      t.createDiv({ cls: 'mk-vault-row-title', text: it.content?.title ?? 'Can not open this secret' });
      t.createDiv({ cls: 'mk-vault-row-sub', text: `${this.team.projects.find((p) => p.id === it.projectId)?.name ?? ''} · deleted ${when(it.deletedAt!)}` });
      const b = row.createEl('button', { text: 'Restore' });
      b.onclick = async (e) => {
        e.stopPropagation();
        b.disabled = true;
        await this.vault.restore(it).catch((err) => new Notice(`Mad Kanban: ${errText(err)}`));
      };
    }
  }
}

export class RecoveryCodeModal extends Modal {
  constructor(
    app: App,
    private code: string
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass('mk-vault-modal', 'mk-vault-small');
    this.titleEl.setText('Your recovery code');
    const el = this.contentEl;
    el.createEl('p', { text: 'If you ever lose every device, this code gets your passwords back. Save it somewhere safe outside this computer — a paper note, or a password manager. It is shown only now.' });
    el.createDiv({ cls: 'mk-vault-recovery', text: this.code });
    const acts = el.createDiv({ cls: 'mk-vault-actions' });
    acts.createEl('button', { text: 'Copy' }).onclick = () => void copySecret(this.code, 'Recovery code copied');
    const done = acts.createEl('button', { cls: 'mod-cta', text: 'I saved it' });
    done.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class MyKeyModal extends Modal {
  constructor(
    app: App,
    private vault: VaultSync
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass('mk-vault-modal', 'mk-vault-small');
    this.titleEl.setText('My key');
    const el = this.contentEl;
    el.createEl('p', { text: 'Your safety code. If a teammate gets a “key changed” warning about you, compare this code with them in person.' });
    el.createDiv({ cls: 'mk-vault-recovery', text: this.vault.mySafetyCode() });
    el.createEl('p', {
      cls: 'mk-vault-hint',
      text: 'To use passwords on another device, sign it in with “Add a device” (Settings → Mad Kanban). The QR code brings your key along.',
    });
    el.createEl('p', { cls: 'mk-vault-hint', text: this.vault.hasRecovery ? 'You have a recovery code. Making a new one replaces it.' : 'You have no recovery code. Without one, losing every device means losing your passwords.' });
    const acts = el.createDiv({ cls: 'mk-vault-actions' });
    const b = acts.createEl('button', { cls: this.vault.hasRecovery ? '' : 'mod-cta', text: this.vault.hasRecovery ? 'New recovery code' : 'Make a recovery code' });
    b.onclick = async () => {
      try {
        const code = await this.vault.newRecovery();
        this.close();
        new RecoveryCodeModal(this.app, code).open();
      } catch (e) {
        new Notice(`Mad Kanban: ${errText(e)}`);
      }
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class KeyChangedModal extends Modal {
  constructor(
    app: App,
    private vault: VaultSync,
    private person: VaultPerson
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass('mk-vault-modal', 'mk-vault-small');
    this.titleEl.setText(`${this.person.name}'s key changed`);
    const el = this.contentEl;
    el.createEl('p', {
      text: `This is normal if ${this.person.name} started over on a new device. It could also mean someone is trying to read what you share. Ask ${this.person.name} to open Passwords → My key and read you their code. It must be:`,
    });
    el.createDiv({ cls: 'mk-vault-recovery', text: this.vault.safetyCodeOf(this.person.pub!) });
    const acts = el.createDiv({ cls: 'mk-vault-actions' });
    acts.createEl('button', { text: 'Not now' }).onclick = () => this.close();
    const ok = acts.createEl('button', { cls: 'mod-cta', text: 'It matches' });
    ok.onclick = async () => {
      await this.vault.trustNewKey(this.person.userId, this.person.pub!);
      new Notice(`Mad Kanban: ${this.person.name}'s new key is trusted.`);
      this.close();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class AllowDeviceModal extends Modal {
  constructor(
    app: App,
    private vault: VaultSync,
    private req: AllowRequest
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass('mk-vault-modal', 'mk-vault-small');
    this.titleEl.setText('Allow a device to open your passwords?');
    const el = this.contentEl;
    el.createEl('p', { text: `Your “${this.req.deviceName}” is asking for your passwords key. Allow it only if it is yours and it shows this code:` });
    el.createDiv({ cls: 'mk-vault-recovery', text: this.req.code });
    const acts = el.createDiv({ cls: 'mk-vault-actions' });
    const no = acts.createEl('button', { text: 'Not mine' });
    no.onclick = async () => {
      await this.vault.answerRequest(this.req, false).catch(() => {});
      this.close();
    };
    const yes = acts.createEl('button', { cls: 'mod-cta', text: 'Allow' });
    yes.onclick = async () => {
      yes.disabled = true;
      try {
        await this.vault.answerRequest(this.req, true);
        new Notice('Mad Kanban: allowed. Your other device can open your passwords now.');
        this.close();
      } catch (e) {
        new Notice(`Mad Kanban: ${errText(e)}`, 8000);
        yes.disabled = false;
      }
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}
