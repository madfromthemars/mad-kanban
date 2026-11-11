// Where a person's vault keys live on this device: IndexedDB in Obsidian's app storage
// (never the vault folder). On desktop the keys are also sealed with the OS keychain
// (Electron safeStorage) when it's available.

const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function safeStorage(): any | null {
  try {
    const electron = (window as any).require?.('electron');
    const ss = electron?.remote?.safeStorage ?? electron?.safeStorage;
    return ss?.isEncryptionAvailable?.() ? ss : null;
  } catch {
    return null;
  }
}

export interface Pin {
  boxPub: string;
  signPub: string;
  /** The person confirmed a changed key (compared safety codes). */
  confirmedAt?: number;
}

export class VaultKeystore {
  private dbp: Promise<IDBDatabase>;

  constructor(name: string) {
    this.dbp = new Promise((resolve, reject) => {
      const open = indexedDB.open(name, DB_VERSION);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('kv')) open.result.createObjectStore('kv');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }

  private async store(mode: IDBTransactionMode) {
    return (await this.dbp).transaction('kv', mode).objectStore('kv');
  }

  private async get<T>(key: string): Promise<T | null> {
    return ((await req((await this.store('readonly')).get(key))) as T) ?? null;
  }

  private async set(key: string, value: unknown) {
    await req((await this.store('readwrite')).put(value, key));
  }

  async loadKeys(): Promise<string | null> {
    const v = await this.get<{ sealed?: boolean; data: string }>('keys');
    if (!v) return null;
    if (!v.sealed) return v.data;
    const ss = safeStorage();
    if (!ss) throw new Error('this computer can no longer open its saved password key (OS keychain unavailable)');
    const buf = Uint8Array.from(atob(v.data), (c) => c.charCodeAt(0));
    return ss.decryptString((window as any).require('buffer').Buffer.from(buf));
  }

  async saveKeys(exported: string) {
    const ss = safeStorage();
    if (ss) {
      const enc: Uint8Array = ss.encryptString(exported);
      let s = '';
      for (const b of enc) s += String.fromCharCode(b);
      await this.set('keys', { sealed: true, data: btoa(s) });
    } else await this.set('keys', { sealed: false, data: exported });
  }

  async clearKeys() {
    await req((await this.store('readwrite')).delete('keys'));
  }

  async pins(): Promise<Record<string, Pin>> {
    return (await this.get<Record<string, Pin>>('pins')) ?? {};
  }

  async savePins(p: Record<string, Pin>) {
    await this.set('pins', p);
  }

  async close() {
    (await this.dbp).close();
  }
}
