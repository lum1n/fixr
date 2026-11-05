import type { Report } from "./report.js";
import type { ImageMime } from "./wire.js";

/** One queued report, as persisted before the first request. */
export interface QueuedReport {
  id: string;
  report: Report;
  image?: Blob;
  mime?: ImageMime;
  /** created_at in ms, for the 7-day give-up rule. */
  createdAt: number;
  /** Failed attempts so far. */
  attempts: number;
  /** Epoch ms before which the report is not retried. */
  nextAttemptAt: number;
}

export interface QueueStore {
  put(rec: QueuedReport): Promise<void>;
  delete(id: string): Promise<void>;
  all(): Promise<QueuedReport[]>;
  close(): void;
}

export class MemoryStore implements QueueStore {
  private map = new Map<string, QueuedReport>();
  async put(rec: QueuedReport) {
    this.map.set(rec.id, { ...rec });
  }
  async delete(id: string) {
    this.map.delete(id);
  }
  async all() {
    return [...this.map.values()].map((r) => ({ ...r }));
  }
  close() {}
}

const STORE = "reports";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

/** IndexedDB queue: database `fixr` (configurable), object store `reports`, keyPath `id`. */
export class IdbStore implements QueueStore {
  private dbp: Promise<IDBDatabase>;
  constructor(name = "fixr", private idb: IDBFactory = indexedDB) {
    const open = this.idb.open(name, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    this.dbp = req(open);
    this.dbp.catch(() => {}); // surfaced by the first operation
  }
  private async tx(mode: IDBTransactionMode) {
    const db = await this.dbp;
    const tx = db.transaction(STORE, mode);
    return { tx, store: tx.objectStore(STORE) };
  }
  async put(rec: QueuedReport) {
    const { tx, store } = await this.tx("readwrite");
    store.put(rec);
    await done(tx);
  }
  async delete(id: string) {
    const { tx, store } = await this.tx("readwrite");
    store.delete(id);
    await done(tx);
  }
  async all() {
    const { store } = await this.tx("readonly");
    return (await req(store.getAll())) as QueuedReport[];
  }
  close() {
    this.dbp.then((db) => db.close()).catch(() => {});
  }
}

/** IndexedDB when it is there and opens, else memory (reports then survive only the page). */
export function defaultStore(name?: string): QueueStore {
  if (typeof indexedDB === "undefined") return new MemoryStore();
  try {
    return new IdbStore(name);
  } catch {
    return new MemoryStore();
  }
}
