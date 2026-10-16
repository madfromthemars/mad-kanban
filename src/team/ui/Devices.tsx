import { App, Modal, Notice, Setting, setIcon } from 'obsidian';
import qrcode from 'qrcode-generator';
import { useEffect, useState } from 'preact/compat';
import { c } from 'src/components/helpers';
import { Icon } from 'src/components/Icon/Icon';

import type { TeamManager } from '../TeamManager';
import { PairingLink, parsePairingLink } from '../TeamClient';
import { PLATFORM_ICON, PLATFORM_LABEL, lastSeenText } from '../devices';
import { TeamDevice } from '../types';
import { promptText } from './modals';

function errorText(e: unknown) {
  return (e as Error)?.message || String(e);
}

function copyText(text: string) {
  void navigator.clipboard.writeText(text).then(
    () => new Notice('Copied'),
    () => new Notice('Could not copy. Select the link and copy it by hand.')
  );
}

/** A QR code as SVG, always dark on white so phone cameras read it in dark themes too. */
export function renderQr(parent: HTMLElement, text: string, size = 220) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 4;
  const total = n + margin * 2;
  const svg = parent.createSvg('svg', {
    attr: {
      viewBox: `0 0 ${total} ${total}`,
      width: size,
      height: size,
      'shape-rendering': 'crispEdges',
      role: 'img',
      'aria-label': 'QR code',
    },
  });
  svg.createSvg('rect', { attr: { width: total, height: total, fill: '#ffffff' } });
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let col = 0; col < n; col++) {
      if (qr.isDark(r, col)) d += `M${col + margin},${r + margin}h1v1h-1z`;
    }
  }
  svg.createSvg('path', { attr: { d, fill: '#000000' } });
  return svg;
}

/**
 * "Add a device": a QR code with a single-use sign-in link. The phone's camera opens the
 * link, the page hands it to Obsidian, and the phone gets its own device key.
 */
export class AddDeviceModal extends Modal {
  team: TeamManager;
  private timer: number | null = null;
  private pollTimer: number | null = null;
  private knownIds = new Set<string>();
  private closed = false;

  constructor(app: App, team: TeamManager) {
    super(app);
    this.team = team;
  }

  onOpen() {
    this.modalEl.addClass(c('add-device-modal'));
    this.titleEl.setText('Add a device');
    void this.team.client
      .devices()
      .then((list) => list.forEach((d) => this.knownIds.add(d.id)))
      .catch(() => {});
    void this.newCode();
  }

  onClose() {
    this.closed = true;
    this.stopTimers();
    this.contentEl.empty();
  }

  private stopTimers() {
    if (this.timer != null) window.clearInterval(this.timer);
    if (this.pollTimer != null) window.clearInterval(this.pollTimer);
    this.timer = this.pollTimer = null;
  }

  private async newCode() {
    this.stopTimers();
    const el = this.contentEl;
    el.empty();
    el.createDiv({ cls: c('add-device-wait'), text: 'Making a sign-in code…' });
    let code: { code: string; expiresAt: number; link?: string };
    try {
      code = await this.team.client.createPairingCode();
    } catch (e) {
      if (this.closed) return;
      el.empty();
      el.createDiv({ cls: c('add-device-error'), text: `Could not make a code: ${errorText(e)}` });
      new Setting(el).addButton((b) => b.setButtonText('Try again').onClick(() => void this.newCode()));
      return;
    }
    if (this.closed) return;
    // The server's public (https) address when it gives one; ours otherwise.
    const base = this.team.plugin.settings['team-server-url'];
    const link = code.link && parsePairingLink(code.link) ? code.link : `${base}/pair#${code.code}`;

    el.empty();
    el.createEl('p', {
      cls: c('add-device-hint'),
      text: 'Scan this with the camera of the phone or computer you want to add, then tap the link and "Open in Obsidian". It signs in as you.',
    });
    const qrBox = el.createDiv({ cls: c('add-device-qr') });
    renderQr(qrBox, link);

    const expires = el.createDiv({ cls: c('add-device-expires') });
    const tick = () => {
      const left = Math.max(0, code.expiresAt - Date.now());
      if (left <= 0) {
        expires.setText('This code has expired.');
        qrBox.addClass('is-expired');
        if (this.timer != null) window.clearInterval(this.timer);
        return;
      }
      const m = Math.floor(left / 60000);
      const s = Math.floor((left % 60000) / 1000);
      expires.setText(`Works once. Expires in ${m}:${String(s).padStart(2, '0')}.`);
    };
    tick();
    this.timer = window.setInterval(tick, 1000);

    const linkRow = el.createDiv({ cls: c('add-device-link') });
    linkRow.createEl('code', { text: link });

    const actions = el.createDiv({ cls: c('add-device-actions') });
    const copyBtn = actions.createEl('button', { text: 'Copy link' });
    copyBtn.addEventListener('click', () => copyText(link));
    const again = actions.createEl('button', { text: 'New code' });
    again.addEventListener('click', () => void this.newCode());
    const done = actions.createEl('button', { text: 'Done', cls: 'mod-cta' });
    done.addEventListener('click', () => this.close());

    el.createEl('p', {
      cls: c('add-device-note'),
      text: 'No camera? Send the link to yourself (e.g. Telegram Saved Messages) and open it on the other device, or paste it into Settings → Mad Kanban → Team server join string there. Anyone with this link can sign in as you until it is used, so don\'t share it.',
    });

    // Tell the user when the new device has signed in.
    this.pollTimer = window.setInterval(async () => {
      try {
        const list = await this.team.client.devices();
        const added = list.find((d) => !this.knownIds.has(d.id) && d.createdAt >= code.expiresAt - 11 * 60 * 1000);
        list.forEach((d) => this.knownIds.add(d.id));
        if (added && !this.closed) {
          this.stopTimers();
          el.empty();
          const ok = el.createDiv({ cls: c('add-device-done') });
          setIcon(ok.createSpan(), 'lucide-check-circle-2');
          ok.createSpan({ text: ` ${added.name} is signed in.` });
          el.createEl('p', {
            cls: c('add-device-hint'),
            text: 'You can rename or remove it any time under Settings → Mad Kanban → Your devices.',
          });
          new Setting(el)
            .addButton((b) => b.setButtonText('Add another').onClick(() => void this.newCode()))
            .addButton((b) => b.setButtonText('Done').setCta().onClick(() => this.close()));
          this.team.emitter.emit('devices');
        }
      } catch {
        /* keep waiting */
      }
    }, 3000);
  }
}

/** Asked before a pairing link signs this install in. */
export class PairConfirmModal extends Modal {
  constructor(
    app: App,
    private link: PairingLink,
    private currentName: string | null,
    private onConfirm: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText('Sign in to Mad Kanban?');
    const el = this.contentEl;
    el.createEl('p', { text: 'This signs this device in with the account that made the QR code.' });
    const p = el.createEl('p');
    p.appendText('Team server: ');
    p.createEl('b', { text: this.link.url });
    if (this.currentName) {
      el.createEl('p', {
        cls: 'mod-warning',
        text: `This device is signed in as ${this.currentName} now. Signing in replaces that.`,
      });
    }
    el.createEl('p', {
      cls: c('add-device-note'),
      text: 'Only continue if you made this code yourself, on one of your own devices.',
    });
    new Setting(el)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText('Sign in')
          .setCta()
          .onClick(async () => {
            b.setDisabled(true);
            b.setButtonText('Signing in…');
            await this.onConfirm();
            this.close();
          })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Settings → Mad Kanban → "Your devices" (plain DOM, like the rest of the settings tab). */
export function renderDevicesSection(containerEl: HTMLElement, team: TeamManager): () => void {
  const el = containerEl.createDiv({ cls: c('devices-section') });
  let disposed = false;

  const render = async (): Promise<void> => {
    if (disposed) return;
    el.empty();
    if (!team.user || !team.isConfigured) return;

    new Setting(el)
      .setName('Your devices')
      .setDesc('Phones and computers signed in as you. All of them see the same boards. Remove one you lost or no longer use.')
      .addButton((b) =>
        b
          .setButtonText('Add a device')
          .setCta()
          .onClick(() => team.openAddDevice())
      );

    const list = el.createDiv({ cls: c('devices-list') });
    let devices: TeamDevice[];
    try {
      devices = await team.client.devices();
    } catch (e) {
      list.createDiv({ cls: c('devices-empty'), text: `Could not load devices: ${errorText(e)}` });
      return;
    }
    if (disposed) return;
    if (!devices.length) {
      list.createDiv({ cls: c('devices-empty'), text: 'No devices yet.' });
      return;
    }
    for (const d of devices) {
      const row = new Setting(list)
        .setName(d.current ? `${d.name} (this device)` : d.name)
        .setDesc(`${PLATFORM_LABEL[d.platform] || 'Device'} · ${lastSeenText(d.lastSeen, d.current)}`);
      const icon = createSpan({ cls: c('device-icon') });
      setIcon(icon, PLATFORM_ICON[d.platform] || PLATFORM_ICON['']);
      row.nameEl.prepend(icon);
      row.addExtraButton((b) =>
        b
          .setIcon('lucide-pencil')
          .setTooltip('Rename')
          .onClick(async () => {
            const name = await promptText(team.plugin.app, 'Rename device', 'e.g. Work laptop', d.name);
            if (!name?.trim() || name.trim() === d.name) return;
            try {
              await team.client.renameDevice(d.id, name.trim());
              void render();
            } catch (e) {
              new Notice(`Could not rename: ${errorText(e)}`);
            }
          })
      );
      row.addButton((b) => {
        b.setButtonText(d.current ? 'Sign out' : 'Remove').setWarning();
        let armed = false;
        b.onClick(async () => {
          if (!armed) {
            armed = true;
            b.setButtonText(d.current ? 'Sign out this device?' : `Remove ${d.name}?`);
            window.setTimeout(() => {
              if (!disposed && armed) {
                armed = false;
                b.setButtonText(d.current ? 'Sign out' : 'Remove');
              }
            }, 4000);
            return;
          }
          b.setDisabled(true);
          try {
            await team.client.removeDevice(d.id);
            if (d.current) {
              await team.signOut();
              new Notice('Mad Kanban: this device is signed out.');
            } else {
              new Notice(`Mad Kanban: ${d.name} is signed out.`);
            }
          } catch (e) {
            new Notice(`Could not remove: ${errorText(e)}`);
          }
          void render();
        });
      });
    }
  };

  const rerender = (): void => void render();
  team.emitter.on('user', rerender);
  team.emitter.on('devices', rerender);
  void render();
  return () => {
    disposed = true;
    team.emitter.off('user', rerender);
    team.emitter.off('devices', rerender);
  };
}

/** Manage team → a person's devices, for hosts and the owner. */
export function PersonDevices({ team, userId, name }: { team: TeamManager; userId: string; name: string }) {
  const [devices, setDevices] = useState<TeamDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => {
    team.client
      .userDevices(userId)
      .then((d) => setDevices(d))
      .catch((e: unknown) => {
        setError(errorText(e));
      });
  }, [userId]);

  const remove = async (d: TeamDevice) => {
    try {
      setDevices(await team.client.removeUserDevice(userId, d.id));
      setConfirm(null);
      new Notice(`${name}'s ${d.name} is signed out.`);
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (error) return <div className={c('mt-muted')}>{error}</div>;
  if (!devices) return <div className={c('mt-muted')}>Loading devices…</div>;
  if (!devices.length) {
    return <div className={c('mt-muted')}>No devices with their own key yet (only the join link).</div>;
  }
  return (
    <div className={c('mt-devices')}>
      {devices.map((d) => (
        <div key={d.id} className={c('mt-device')}>
          <Icon name={PLATFORM_ICON[d.platform] || PLATFORM_ICON['']} />
          <span className={c('mt-device-name')}>{d.name}</span>
          <span className={c('mt-muted')}>{lastSeenText(d.lastSeen)}</span>
          {confirm === d.id ? (
            <span className={c('mt-confirm')}>
              Sign out?
              <a className={`${c('mt-link')} mod-warning`} onClick={() => void remove(d)}>
                Remove
              </a>
              <a className={c('mt-link')} onClick={() => setConfirm(null)}>
                Cancel
              </a>
            </span>
          ) : (
            <a className={`${c('mt-link')} is-danger`} onClick={() => setConfirm(d.id)}>
              Remove
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
