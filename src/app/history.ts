import type { HistoryItem } from './types/studio';

export const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

const HISTORY_DB_NAME = 'atelier-session-history';
const HISTORY_DB_VERSION = 1;
const HISTORY_STORE_NAME = 'items';
const LEGACY_STORAGE_KEY = 'rmbg_atelier_history';

interface HistoryStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

interface HistoryRequest<T> {
  result: T;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface HistoryTransaction {
  error: Error | null;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  objectStore(name: string): HistoryObjectStore;
}

interface HistoryObjectStore {
  getAll(): HistoryRequest<HistoryItem[]>;
  put(item: HistoryItem): void;
  delete(id: string): void;
  clear(): void;
  createIndex(name: string, keyPath: string, options: { unique: boolean }): void;
}

interface HistoryDatabase {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options: { keyPath: string }): HistoryObjectStore;
  transaction(name: string, mode: 'readonly' | 'readwrite'): HistoryTransaction;
  close(): void;
}

interface HistoryIndexedDb {
  open(name: string, version: number): HistoryRequest<HistoryDatabase> & { onupgradeneeded: (() => void) | null };
}

const browserGlobals = globalThis as typeof globalThis & {
  indexedDB?: HistoryIndexedDb;
  localStorage?: HistoryStorage;
};

export function filterFreshHistory(items: HistoryItem[], now = Date.now()): HistoryItem[] {
  const cutoff = now - HISTORY_TTL_MS;
  return items
    .filter((item) => Number.isFinite(item.timestamp) && item.timestamp >= cutoff)
    .sort((a, b) => b.timestamp - a.timestamp);
}

export function appendHistoryItem(
  items: HistoryItem[],
  item: HistoryItem,
  now = Date.now(),
): HistoryItem[] {
  return filterFreshHistory([item, ...items], now);
}

export function createHistoryId(now = Date.now()): string {
  const randomId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `hist-${now}-${randomId}`;
}

function readLegacyHistory(): HistoryItem[] {
  try {
    const saved = browserGlobals.localStorage?.getItem(LEGACY_STORAGE_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved) as unknown;
    return Array.isArray(parsed) ? (parsed as HistoryItem[]) : [];
  } catch {
    return [];
  }
}

function removeLegacyHistory(): void {
  try {
    browserGlobals.localStorage?.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // The IndexedDB copy is authoritative after migration.
  }
}

function hasIndexedDb(): boolean {
  return Boolean(browserGlobals.indexedDB);
}

function openHistoryDb(): Promise<HistoryDatabase> {
  return new Promise((resolve, reject) => {
    const indexedDb = browserGlobals.indexedDB as HistoryIndexedDb | undefined;
    const request = indexedDb?.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
    if (!request) {
      reject(new Error('IndexedDB is unavailable.'));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HISTORY_STORE_NAME)) {
        const store = db.createObjectStore(HISTORY_STORE_NAME, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open session history.'));
  });
}

function readAll(db: HistoryDatabase): Promise<HistoryItem[]> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(HISTORY_STORE_NAME, 'readonly');
    const request = transaction.objectStore(HISTORY_STORE_NAME).getAll();
    request.onsuccess = () => resolve((request.result as HistoryItem[]) || []);
    request.onerror = () => reject(request.error ?? new Error('Unable to read session history.'));
  });
}

function putItems(db: HistoryDatabase, items: HistoryItem[]): Promise<void> {
  if (items.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(HISTORY_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(HISTORY_STORE_NAME);
    items.forEach((item) => store.put(item));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Unable to save session history.'));
  });
}

function deleteItems(db: HistoryDatabase, ids: string[]): Promise<void> {
  if (ids.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(HISTORY_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(HISTORY_STORE_NAME);
    ids.forEach((id) => store.delete(id));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Unable to clean session history.'));
  });
}

function clearItems(db: HistoryDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(HISTORY_STORE_NAME, 'readwrite');
    transaction.objectStore(HISTORY_STORE_NAME).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Unable to clear session history.'));
  });
}

export async function loadHistory(now = Date.now()): Promise<HistoryItem[]> {
  if (!hasIndexedDb()) return filterFreshHistory(readLegacyHistory(), now);

  const db = await openHistoryDb();
  try {
    const stored = await readAll(db);
    const legacy = readLegacyHistory();
    const storedIds = new Set(stored.map((item) => item.id));
    const toMigrate = legacy.filter((item) => !storedIds.has(item.id));
    if (toMigrate.length > 0) await putItems(db, toMigrate);

    const allItems = [...stored, ...toMigrate];
    const fresh = filterFreshHistory(allItems, now);
    const freshIds = new Set(fresh.map((item) => item.id));
    const expiredIds = allItems
      .filter((item) => !freshIds.has(item.id))
      .map((item) => item.id);
    await deleteItems(db, expiredIds);

    if (legacy.length > 0) removeLegacyHistory();
    return fresh;
  } finally {
    db.close();
  }
}

export async function addHistoryItem(item: HistoryItem): Promise<HistoryItem[]> {
  if (!hasIndexedDb()) {
    const current = filterFreshHistory(readLegacyHistory());
    const updated = appendHistoryItem(current, item);
    browserGlobals.localStorage?.setItem(LEGACY_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  }

  const db = await openHistoryDb();
  try {
    const current = await loadHistory();
    await putItems(db, [item]);
    return appendHistoryItem(current, item);
  } finally {
    db.close();
  }
}

export async function clearHistoryStore(): Promise<void> {
  removeLegacyHistory();
  if (!hasIndexedDb()) return;

  const db = await openHistoryDb();
  try {
    await clearItems(db);
  } finally {
    db.close();
  }
}
