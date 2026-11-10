// Tiny IndexedDB key-value store for shared notes: per doc, the Yjs state (offline edits
// survive restarts) and what this device last had in sync (`base`, for 3-way merges).
// Lives in Obsidian's app storage, never inside the vault folder.

export interface DocMeta {
  id: string;
  projectId: string;
  /** Vault path where this device keeps the file now. */
  localPath: string;
  kind: 'md' | 'canvas' | 'file';
  /** Server updatedAt we last wrote to disk (or uploaded). */
  syncedAt: number;
  /** Text/JSON this device last had in sync with the server (md/canvas). */
  base?: string;
  fileId?: string | null;
  /** Local changes not confirmed by the server yet. */
  dirty?: boolean;
  version?: number;
}

const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class NotesStore {
  private dbp: Promise<IDBDatabase>;

  constructor(name: string) {
    this.dbp = new Promise((resolve, reject) => {
      const open = indexedDB.open(name, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('ystate')) db.createObjectStore('ystate');
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }

  private async tx(store: string, mode: IDBTransactionMode) {
    return (await this.dbp).transaction(store, mode).objectStore(store);
  }

  async allMeta(): Promise<DocMeta[]> {
    return req((await this.tx('meta', 'readonly')).getAll()) as Promise<DocMeta[]>;
  }

  async putMeta(m: DocMeta) {
    await req((await this.tx('meta', 'readwrite')).put(m, m.id));
  }

  async deleteDoc(id: string) {
    await req((await this.tx('meta', 'readwrite')).delete(id));
    await req((await this.tx('ystate', 'readwrite')).delete(id));
  }

  async getState(id: string): Promise<Uint8Array | null> {
    return ((await req((await this.tx('ystate', 'readonly')).get(id))) as Uint8Array) ?? null;
  }

  async putState(id: string, state: Uint8Array) {
    await req((await this.tx('ystate', 'readwrite')).put(state, id));
  }

  async get<T>(key: string): Promise<T | null> {
    return ((await req((await this.tx('kv', 'readonly')).get(key))) as T) ?? null;
  }

  async set(key: string, value: unknown) {
    await req((await this.tx('kv', 'readwrite')).put(value, key));
  }

  async close() {
    (await this.dbp).close();
  }
}
