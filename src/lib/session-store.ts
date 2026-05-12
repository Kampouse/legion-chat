/**
 * session-store.ts
 *
 * Persistent session storage with IndexedDB primary + localStorage fallback.
 * Survives localStorage clears, browser cache purges, etc.
 */

const DB_NAME = "legion-chat";
const STORE_NAME = "sessions";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSession(key: string, data: any): Promise<void> {
  const json = JSON.stringify(data);

  // Always write localStorage as fast-path
  try { localStorage.setItem(key, json); } catch {}

  // Also write to IndexedDB for resilience
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(data, key);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch (e: any) {
    console.warn("[session-store] IndexedDB write failed:", e.message);
  }
}

export async function loadSession(key: string): Promise<any | null> {
  // Try localStorage first (fast, synchronous-ish)
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch {}

  // Fall back to IndexedDB
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    return new Promise<any>((resolve) => {
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function deleteSession(key: string): Promise<void> {
  try { localStorage.removeItem(key); } catch {}
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch {}
}
