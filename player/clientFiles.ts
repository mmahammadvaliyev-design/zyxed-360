// «Файлы клиента»: зритель опубликованного тура может прикрепить к карточке
// трубы/заметки СВОИ файлы. Они хранятся только в браузере этого устройства
// (IndexedDB) — автору не отправляются и в тур не попадают. Ключ — id тура +
// id карточки, поэтому после обновления тура (новый экспорт с тем же id)
// файлы клиента остаются на месте.
//
// Хранилище может быть недоступно (приватный режим, запрет cookies/данных,
// некоторые file://-настройки) — тогда все вызовы кидают ошибку, а вызывающий
// показывает понятное сообщение и не ломает тур.

export interface ClientFile {
  id: string;
  owner: string; // `${tourId}|${cardId}`
  name: string;
  type: string;
  size: number;
  added: number;
  blob: Blob;
}

const DB_NAME = "zyxed360-client-files";
const STORE = "files";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB недоступен"));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch (e) {
      reject(e as Error);
      return;
    }
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("owner", "owner");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Не удалось открыть хранилище"));
  });
  dbPromise.catch(() => { dbPromise = null; }); // следующая попытка откроет заново
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Ошибка хранилища"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Ошибка хранилища"));
    tx.onabort = () => reject(tx.error ?? new Error("Не хватает места в хранилище браузера"));
  });
}

export async function listClientFiles(owner: string): Promise<ClientFile[]> {
  const db = await openDb();
  const rows = await done(db.transaction(STORE).objectStore(STORE).index("owner").getAll(owner) as IDBRequest<ClientFile[]>);
  return rows.sort((a, b) => a.added - b.added);
}

export async function addClientFiles(owner: string, files: File[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const now = Date.now();
  files.forEach((f, i) => {
    const rec: ClientFile = {
      id: `${now}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      owner,
      name: f.name || "file",
      type: f.type,
      size: f.size,
      added: now + i,
      blob: f,
    };
    store.put(rec);
  });
  await txDone(tx);
  // Просим браузер не вычищать данные при нехватке места (где поддерживается).
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* не критично */
  }
}

export async function removeClientFile(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await txDone(tx);
}
