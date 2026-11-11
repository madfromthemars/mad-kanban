// Password vault per project: talks to server/vault.js, which only sees public keys and
// encrypted boxes. Design: docs/design/password-vault.md.
//
// Safety rules (keep them):
// - Secrets and keys exist only in memory and in this device's app storage; never in vault files.
// - Every item and every share is signed; we check the signer's key before trusting either.
// - Teammates' keys are pinned the first time we see them. A changed key is NOT used for
//   sharing until the person confirms (compares safety codes).

import { Notice } from 'obsidian';

import type { TeamManager } from '../TeamManager';
import {
  PersonKeys,
  PublicPerson,
  SealedBox,
  SecretContent,
  WrappedKey,
  accessSigMessage,
  b64,
  exportKeys,
  importKeys,
  itemSigMessage,
  newItemKey,
  newPersonKeys,
  newRecoveryCode,
  newRequestKeys,
  newTransferKey,
  open,
  openRecovery,
  openRequest,
  openTransfer,
  publicOf,
  requestCode,
  safetyCode,
  seal,
  sealForRecovery,
  sealForRequest,
  sealForTransfer,
  signText,
  unwrap,
  verifyText,
  wrapFor,
} from './crypto';
import { Pin, VaultKeystore } from './keystore';
import { AllowDeviceModal } from './ui';

export type VaultState =
  | 'loading'
  /** Nobody set up passwords for this account yet. */
  | 'new'
  /** The account has keys, but not this device: get them from another device or the recovery code. */
  | 'needs-key'
  | 'ready'
  | 'offline'
  | 'error';

interface ServerItem {
  id: string;
  projectId: string;
  version: number;
  box: SealedBox;
  sig: string;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
  deletedAt: number | null;
  mine: { wrapped: WrappedKey; byUser: string; sig: string };
  access: { userId: string; name: string; byUser: string; at: number }[];
}

export interface VaultItem {
  id: string;
  projectId: string;
  version: number;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
  deletedAt: number | null;
  access: ServerItem['access'];
  /** null when it could not be opened or verified; see `problem`. */
  content: SecretContent | null;
  problem?: string;
}

export interface VaultPerson {
  userId: string;
  name: string;
  ready: boolean;
  /** Their key differs from the one we pinned; don't share until confirmed. */
  changed?: boolean;
  pub?: PublicPerson;
}

export interface AllowRequest {
  id: string;
  requestPub: string;
  deviceName: string;
  code: string;
  expiresAt: number;
}

type Listener = () => void;

export class VaultSync {
  state: VaultState = 'loading';
  stateText = '';
  items = new Map<string, VaultItem>();
  /** Item keys of items we can open (memory only). */
  private itemKeys = new Map<string, Uint8Array>();
  private keys: PersonKeys | null = null;
  private store: VaultKeystore;
  private pins: Record<string, Pin> = {};
  private listeners = new Set<Listener>();
  private cleanups: (() => void)[] = [];
  private destroyed = false;
  private loadedAt = 0;
  /** A pairing link with a vault key was used to sign in: pick the key up once we start. */
  static pendingTransfer: { url: string; code: string; key: string } | null = null;

  constructor(private team: TeamManager) {
    const conn = team.client.conn!;
    let h = 0;
    for (const ch of conn.url) h = (h * 31 + ch.charCodeAt(0)) | 0;
    this.store = new VaultKeystore(`mk-vault-${(h >>> 0).toString(36)}-${team.user!.id}`);
  }

  get me() {
    return this.team.user!;
  }

  get hasRecovery() {
    return this.recoverySaved;
  }
  private recoverySaved = false;

  onChange(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private setState(s: VaultState, text = '') {
    this.state = s;
    this.stateText = text;
    this.emit();
  }

  private api<T = any>(method: string, path: string, body?: unknown) {
    return this.team.client.vaultApi<T>(method, path, body);
  }

  // ---------- start / keys ----------

  async start() {
    const onEvent = (ev: any) => {
      if (this.destroyed) return;
      if (ev.type === 'vault.changed' && this.state === 'ready') void this.refresh();
      else if (ev.type === 'vault.request' && this.state === 'ready') void this.checkRequests();
    };
    this.team.client.emitter.on('event', onEvent);
    this.cleanups.push(() => this.team.client.emitter.off('event', onEvent));
    this.pins = await this.store.pins();
    await this.loadKeys();
  }

  async destroy() {
    this.destroyed = true;
    for (const c of this.cleanups.splice(0)) c();
    this.itemKeys.clear();
    this.items.clear();
    this.keys = null;
    this.listeners.clear();
    await this.store.close().catch(() => {});
  }

  private async loadKeys() {
    let server: { person: { boxPub: string; signPub: string; hasRecovery: boolean } | null };
    try {
      server = await this.api('GET', '/me');
    } catch (e) {
      this.setState('offline', 'Can not reach the team server.');
      return;
    }
    this.recoverySaved = !!server.person?.hasRecovery;
    let local: PersonKeys | null = null;
    try {
      const raw = await this.store.loadKeys();
      local = raw ? importKeys(raw) : null;
    } catch (e) {
      this.setState('error', String((e as Error)?.message || e));
      return;
    }
    // A pairing QR brought a key along.
    const pend = VaultSync.pendingTransfer;
    if (pend && pend.url === this.team.client.conn?.url) {
      VaultSync.pendingTransfer = null;
      try {
        const { box } = await this.api('POST', '/transfers/qr/take', { pairCode: pend.code });
        local = openTransfer(box, pend.key);
        await this.store.saveKeys(exportKeys(local));
        new Notice('Mad Kanban: your passwords are now on this device too.');
      } catch {
        /* nothing waiting: the old device was not set up for passwords */
      }
    }
    const p = server.person;
    if (local && p) {
      const mine = publicOf(local);
      if (mine.boxPub === p.boxPub && mine.signPub === p.signPub) {
        this.keys = local;
        this.setState('ready');
        await this.refresh();
        void this.checkRequests();
        return;
      }
      // Account keys were replaced elsewhere ("start over"): this device's copy is stale.
      await this.store.clearKeys();
      local = null;
    }
    if (local && !p) {
      // Server lost/never got our public half (e.g. setup interrupted): upload it.
      await this.api('PUT', '/me', publicOf(local));
      this.keys = local;
      this.setState('ready');
      await this.refresh();
      return;
    }
    this.setState(p ? 'needs-key' : 'new');
  }

  /** First setup for this account. Returns the recovery code to show once (if wanted). */
  async setUp(withRecovery: boolean): Promise<string | null> {
    const keys = newPersonKeys();
    const code = withRecovery ? newRecoveryCode() : null;
    await this.api('PUT', '/me', { ...publicOf(keys), ...(code ? { recovery: sealForRecovery(keys, code) } : {}) });
    await this.store.saveKeys(exportKeys(keys));
    this.keys = keys;
    this.recoverySaved = !!code;
    this.setState('ready');
    await this.refresh();
    return code;
  }

  /** Lost every device and no recovery code: new keys; secrets must be re-shared by others. */
  async startOver(withRecovery: boolean): Promise<string | null> {
    const keys = newPersonKeys();
    const code = withRecovery ? newRecoveryCode() : null;
    await this.api('PUT', '/me', { ...publicOf(keys), replace: true, ...(code ? { recovery: sealForRecovery(keys, code) } : {}) });
    await this.store.saveKeys(exportKeys(keys));
    this.keys = keys;
    this.recoverySaved = !!code;
    this.setState('ready');
    await this.refresh();
    return code;
  }

  async useRecoveryCode(code: string) {
    const { recovery } = await this.api('GET', '/me/recovery');
    const keys = openRecovery(recovery, code);
    const server = await this.api('GET', '/me');
    const pub = publicOf(keys);
    if (server.person?.boxPub !== pub.boxPub) throw new Error('that code belongs to an older key');
    await this.store.saveKeys(exportKeys(keys));
    this.keys = keys;
    this.setState('ready');
    await this.refresh();
  }

  /** New recovery code (replaces the old one). */
  async newRecovery(): Promise<string> {
    if (!this.keys) throw new Error('passwords are not set up on this device');
    const code = newRecoveryCode();
    await this.api('PUT', '/me/recovery', { recovery: sealForRecovery(this.keys, code) });
    this.recoverySaved = true;
    this.emit();
    return code;
  }

  myPublic() {
    return this.keys ? publicOf(this.keys) : null;
  }

  mySafetyCode() {
    return this.keys ? safetyCode(publicOf(this.keys)) : '';
  }

  // ---------- moving keys between devices ----------

  /** Called by "Add a device": attach our key to the pairing code; returns the extra link part. */
  async attachToPairing(pairCode: string): Promise<string | null> {
    if (!this.keys) return null;
    const k = newTransferKey();
    await this.api('POST', '/transfers/qr', { pairCode, box: sealForTransfer(this.keys, k) });
    return k;
  }

  /** On a device without the key: ask the person's other devices. Resolves when allowed. */
  async askOtherDevice(deviceName: string, onCode: (code: string) => void, signal: { cancelled: boolean }) {
    const req = newRequestKeys();
    const pub = b64.enc(req.publicKey);
    const { id, expiresAt } = await this.api('POST', '/requests', { requestPub: pub, deviceName });
    onCode(requestCode(pub));
    while (!signal.cancelled && !this.destroyed && Date.now() < expiresAt) {
      await new Promise((r) => setTimeout(r, 2000));
      let out: { box: any };
      try {
        out = await this.api('GET', `/requests/${id}`);
      } catch (e: any) {
        if (e?.status === 404) throw new Error('the request was turned down or expired');
        continue;
      }
      if (!out.box) continue;
      const keys = openRequest(out.box, req.secretKey);
      const server = await this.api('GET', '/me');
      if (server.person?.boxPub !== publicOf(keys).boxPub) throw new Error('the key from your other device does not match your account');
      await this.store.saveKeys(exportKeys(keys));
      this.keys = keys;
      this.setState('ready');
      await this.refresh();
      return true;
    }
    return false;
  }

  /** Requests from this person's other devices, waiting for Allow. */
  async pendingRequests(): Promise<AllowRequest[]> {
    if (!this.keys) return [];
    const { requests } = await this.api('GET', '/requests');
    return requests.map((r: any) => ({ ...r, code: requestCode(r.requestPub) }));
  }

  async answerRequest(r: AllowRequest, allow: boolean) {
    if (!allow) return this.api('POST', `/requests/${r.id}/answer`, { deny: true });
    if (!this.keys) throw new Error('passwords are not set up on this device');
    return this.api('POST', `/requests/${r.id}/answer`, { box: sealForRequest(this.keys, r.requestPub) });
  }

  private asked = new Set<string>();
  private async checkRequests() {
    const list = await this.pendingRequests().catch((): AllowRequest[] => []);
    for (const r of list) {
      if (this.asked.has(r.id)) continue;
      this.asked.add(r.id);
      new AllowDeviceModal(this.team.plugin.app, this, r).open();
    }
  }

  // ---------- people & pins ----------

  /** Check a person's key against our pin; pin it if new. */
  private async checkPin(userId: string, pub: PublicPerson): Promise<'ok' | 'changed'> {
    if (userId === this.me.id && this.keys) {
      const mine = publicOf(this.keys);
      return mine.boxPub === pub.boxPub && mine.signPub === pub.signPub ? 'ok' : 'changed';
    }
    const pin = this.pins[userId];
    if (!pin) {
      this.pins[userId] = { boxPub: pub.boxPub, signPub: pub.signPub };
      await this.store.savePins(this.pins);
      return 'ok';
    }
    return pin.boxPub === pub.boxPub && pin.signPub === pub.signPub ? 'ok' : 'changed';
  }

  /** The person compared safety codes and trusts their new key. */
  async trustNewKey(userId: string, pub: PublicPerson) {
    this.pins[userId] = { boxPub: pub.boxPub, signPub: pub.signPub, confirmedAt: Date.now() };
    await this.store.savePins(this.pins);
    await this.refresh();
  }

  async people(projectId: string): Promise<VaultPerson[]> {
    const { people } = await this.api('GET', `/projects/${projectId}/people`);
    const out: VaultPerson[] = [];
    for (const p of people) {
      if (!p.ready) {
        out.push({ userId: p.userId, name: p.name, ready: false });
        continue;
      }
      const pub = { boxPub: p.boxPub, signPub: p.signPub };
      out.push({ userId: p.userId, name: p.name, ready: true, pub, changed: (await this.checkPin(p.userId, pub)) === 'changed' });
    }
    return out;
  }

  safetyCodeOf(pub: PublicPerson) {
    return safetyCode(pub);
  }

  // ---------- items ----------

  private refreshing: Promise<void> | null = null;
  async refresh() {
    if (!this.keys) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const [{ items }, { items: trashed }] = await Promise.all([this.api('GET', '/items'), this.api('GET', '/trash')]);
        const all: ServerItem[] = [...items, ...trashed];
        const signers = [...new Set(all.reduce<string[]>((acc, i) => acc.concat([i.updatedBy, i.mine.byUser]), []))];
        const { keys } = await this.api('POST', '/keys', { userIds: signers });
        const next = new Map<string, VaultItem>();
        this.itemKeys.clear();
        for (const it of all) next.set(it.id, await this.openItem(it, keys));
        this.items = next;
        this.loadedAt = Date.now();
        if (this.state !== 'ready') this.setState('ready');
        else this.emit();
      } catch (e) {
        if ((e as any)?.status === 0) this.setState('offline', 'Can not reach the team server.');
        else throw e;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async openItem(it: ServerItem, keys: Record<string, PublicPerson>): Promise<VaultItem> {
    const base: VaultItem = {
      id: it.id,
      projectId: it.projectId,
      version: it.version,
      createdBy: it.createdBy,
      createdAt: it.createdAt,
      updatedBy: it.updatedBy,
      updatedAt: it.updatedAt,
      deletedAt: it.deletedAt,
      access: it.access,
      content: null,
    };
    const name = (id: string) => this.team.userName(id);
    const sharer = keys[it.mine.byUser];
    const editor = keys[it.updatedBy];
    if (!sharer || !editor) return { ...base, problem: 'The person who shared or changed this has no key on the server any more.' };
    if ((await this.checkPin(it.mine.byUser, sharer)) === 'changed')
      return { ...base, problem: `${name(it.mine.byUser)}'s key changed. Compare safety codes with them before trusting this.` };
    if ((await this.checkPin(it.updatedBy, editor)) === 'changed')
      return { ...base, problem: `${name(it.updatedBy)}'s key changed. Compare safety codes with them before trusting this.` };
    // The key was wrapped and signed by who the server says, for us, with their pinned key.
    if (it.mine.wrapped.from !== sharer.boxPub || !verifyText(accessSigMessage(it.id, this.me.id, it.mine.wrapped), it.mine.sig, sharer.signPub))
      return { ...base, problem: 'The share of this secret is not signed correctly. It was not opened.' };
    if (!verifyText(itemSigMessage(it.id, it.projectId, it.version, it.box), it.sig, editor.signPub))
      return { ...base, problem: 'This secret is not signed correctly. It was not opened.' };
    try {
      const key = unwrap(it.mine.wrapped, this.keys!);
      const content = open(it.box, key);
      this.itemKeys.set(it.id, key);
      return { ...base, content };
    } catch (e) {
      return { ...base, problem: String((e as Error)?.message || e) };
    }
  }

  list(projectId?: string) {
    return [...this.items.values()]
      .filter((i) => !i.deletedAt && (!projectId || i.projectId === projectId))
      .sort((a, b) => (a.content?.title || '').localeCompare(b.content?.title || '', undefined, { sensitivity: 'base' }));
  }

  trash() {
    return [...this.items.values()].filter((i) => i.deletedAt).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  }

  private shareRow(itemId: string, key: Uint8Array, person: VaultPerson) {
    if (!person.pub) throw new Error(`${person.name} has not set up passwords yet`);
    if (person.changed) throw new Error(`${person.name}'s key changed; compare safety codes first`);
    const wrapped = wrapFor(key, person.pub.boxPub, this.keys!);
    return { userId: person.userId, wrapped, sig: signText(accessSigMessage(itemId, person.userId, wrapped), this.keys!) };
  }

  private newId() {
    const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const r = crypto.getRandomValues(new Uint8Array(14));
    return [...r].map((x) => a[x % a.length]).join('');
  }

  async create(projectId: string, content: SecretContent, people: VaultPerson[]) {
    if (!this.keys) throw new Error('passwords are not set up on this device');
    const id = this.newId();
    const key = newItemKey();
    const box = seal(content, key);
    const me: VaultPerson = { userId: this.me.id, name: this.me.name, ready: true, pub: publicOf(this.keys) };
    const access = [me, ...people.filter((p) => p.userId !== this.me.id)].map((p) => this.shareRow(id, key, p));
    await this.api('POST', '/items', { id, projectId, box, sig: signText(itemSigMessage(id, projectId, 1, box), this.keys), access });
    await this.refresh();
    return this.items.get(id) ?? null;
  }

  async edit(item: VaultItem, content: SecretContent) {
    const key = this.itemKeys.get(item.id);
    if (!key || !this.keys) throw new Error('this secret is not open on this device');
    const box = seal(content, key);
    await this.api('PUT', `/items/${item.id}`, { version: item.version, box, sig: signText(itemSigMessage(item.id, item.projectId, item.version + 1, box), this.keys) });
    await this.refresh();
  }

  async share(item: VaultItem, person: VaultPerson) {
    const key = this.itemKeys.get(item.id);
    if (!key || !this.keys) throw new Error('this secret is not open on this device');
    await this.api('POST', `/items/${item.id}/share`, this.shareRow(item.id, key, person));
    await this.refresh();
  }

  /**
   * Remove people: new item key, encrypted again, wrapped for everyone who stays. (They may
   * have copied the password already — the UI reminds you to change it at the service.)
   */
  async removePeople(item: VaultItem, removeIds: string[]) {
    if (!this.keys || !item.content) throw new Error('this secret is not open on this device');
    const people = await this.people(item.projectId);
    const stay = item.access.map((a) => a.userId).filter((id) => !removeIds.includes(id));
    if (!stay.length) throw new Error('someone has to keep this secret; delete it instead');
    const key = newItemKey();
    const box = seal(item.content, key);
    const access = stay.map((uid) => {
      if (uid === this.me.id) return this.shareRow(item.id, key, { userId: uid, name: this.me.name, ready: true, pub: publicOf(this.keys!) });
      const p = people.find((x) => x.userId === uid);
      if (!p) throw new Error(`${this.team.userName(uid)} is no longer in this project`);
      return this.shareRow(item.id, key, p);
    });
    await this.api('PUT', `/items/${item.id}`, {
      version: item.version,
      box,
      sig: signText(itemSigMessage(item.id, item.projectId, item.version + 1, box), this.keys),
      access,
    });
    await this.refresh();
  }

  async remove(item: VaultItem) {
    await this.api('DELETE', `/items/${item.id}`);
    await this.refresh();
  }

  async restore(item: VaultItem) {
    await this.api('POST', `/items/${item.id}/restore`);
    await this.refresh();
  }

  async history(item: VaultItem) {
    return (await this.api('GET', `/items/${item.id}/history`)).events as { action: string; by: string; target: string | null; detail: string | null; at: number }[];
  }

  /** "Ann copied the password": best effort, never blocks the copy. */
  report(item: VaultItem, action: 'opened' | 'copied' | 'revealed', field?: string) {
    void this.api('POST', `/items/${item.id}/events`, { action, field }).catch(() => {});
  }

  get lastLoaded() {
    return this.loadedAt;
  }
}
