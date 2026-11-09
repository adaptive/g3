export type RecoverableUploadStatus =
  | "queued"
  | "processing"
  | "uploading"
  | "error"
  | "cancelled"
  | "paused";

export interface SavedUpload {
  id: string;
  file: File;
  status: RecoverableUploadStatus;
  progress: number;
  uploadId?: string;
  error?: string;
  updatedAt: number;
}

export interface UploadRecoveryStore {
  load(): Promise<SavedUpload[]>;
  put(record: SavedUpload): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

export const UPLOAD_RECOVERY_MAX_BYTES = 200 * 1024 * 1024;
export const UPLOAD_RECOVERY_MAX_FILES = 100;
export const UPLOAD_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function exceedsUploadRecoveryLimits(
  existing: readonly { gallery: string; id: string; file: Pick<File, "size"> }[],
  candidate: { gallery: string; id: string; file: Pick<File, "size"> },
): boolean {
  let count = 0;
  let bytes = 0;
  for (const value of existing) {
    if (value.gallery === candidate.gallery && value.id === candidate.id) continue;
    count += 1;
    bytes += value.file.size;
  }
  return count + 1 > UPLOAD_RECOVERY_MAX_FILES || bytes + candidate.file.size > UPLOAD_RECOVERY_MAX_BYTES;
}

const DATABASE_NAME = "adaptive-gallery-upload-recovery";
const DATABASE_VERSION = 2;
const STORE_NAME = "uploads";
const META_STORE_NAME = "meta";
const EPOCH_KEY = "clear-epoch";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATUSES = new Set<RecoverableUploadStatus>([
  "queued",
  "processing",
  "uploading",
  "error",
  "cancelled",
  "paused",
]);

interface StoredUpload extends SavedUpload {
  gallery: string;
}

function isStoredUpload(value: unknown, now: number): value is StoredUpload {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<StoredUpload>;
  return (
    typeof row.gallery === "string" && SLUG.test(row.gallery) &&
    typeof row.id === "string" && UUID.test(row.id) &&
    typeof File !== "undefined" && row.file instanceof File &&
    row.file.size > 0 && row.file.size <= 50 * 1024 * 1024 &&
    typeof row.file.name === "string" && row.file.name.length > 0 && row.file.name.length <= 255 &&
    (typeof row.file.type === "string" && row.file.type.length <= 128) &&
    typeof row.status === "string" && STATUSES.has(row.status as RecoverableUploadStatus) &&
    typeof row.progress === "number" && Number.isFinite(row.progress) && row.progress >= 0 && row.progress <= 100 &&
    (row.uploadId === undefined || (typeof row.uploadId === "string" && UUID.test(row.uploadId))) &&
    (row.error === undefined || (typeof row.error === "string" && row.error.length <= 1000)) &&
    typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) &&
    row.updatedAt <= now && now - row.updatedAt <= UPLOAD_RECOVERY_TTL_MS
  );
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined")
    return Promise.reject(new Error("This browser cannot save upload recovery data."));
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch {
      reject(new Error("Upload recovery storage is unavailable in this browser."));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME))
        db.createObjectStore(STORE_NAME, { keyPath: ["gallery", "id"] });
      if (!db.objectStoreNames.contains(META_STORE_NAME))
        db.createObjectStore(META_STORE_NAME);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("Upload recovery storage is unavailable in this browser."));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error("Upload recovery storage is busy in another tab. Close the older gallery tab and retry."));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

function transactionError(tx: IDBTransaction): Error {
  const error = tx.error;
  if (error?.name === "QuotaExceededError")
    return new Error("Browser storage is full. Remove saved uploads or free browser space before adding more photos.");
  return new Error("Could not save upload recovery data in this browser.");
}

export function createUploadRecoveryStore(gallerySlug: string): UploadRecoveryStore {
  if (!SLUG.test(gallerySlug)) throw new Error("Invalid gallery slug for upload recovery.");
  let database: Promise<IDBDatabase> | undefined;
  let closed = false;
  let capturedEpoch: number | undefined;
  const db = () => {
    if (closed) return Promise.reject(new Error("Upload recovery storage is closed."));
    database ??= openDatabase();
    return database;
  };

  return {
    async load() {
      const connection = await db();
      return new Promise((resolve, reject) => {
        const tx = connection.transaction([STORE_NAME, META_STORE_NAME], "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        const epochRequest = tx.objectStore(META_STORE_NAME).get(EPOCH_KEY);
        const records: SavedUpload[] = [];
        let rowsReady = false;
        let epochReady = false;
        const collect = () => {
          if (!rowsReady || !epochReady) return;
          capturedEpoch ??= typeof epochRequest.result === "number" ? epochRequest.result : 0;
          const now = Date.now();
          for (const value of request.result as unknown[]) {
            if (!isStoredUpload(value, now)) {
              const row = value as Partial<StoredUpload> | null;
              if (row && typeof row.gallery === "string" && typeof row.id === "string")
                store.delete([row.gallery, row.id]);
              continue;
            }
            if (value.gallery === gallerySlug) {
              const { gallery: _gallery, ...record } = value;
              records.push(record);
            }
          }
        };
        request.onsuccess = () => { rowsReady = true; collect(); };
        epochRequest.onsuccess = () => { epochReady = true; collect(); };
        request.onerror = () => {
          try { tx.abort(); } catch { /* transaction already finished */ }
        };
        epochRequest.onerror = () => {
          try { tx.abort(); } catch { /* transaction already finished */ }
        };
        tx.oncomplete = () => resolve(records);
        tx.onabort = () => reject(transactionError(tx));
        tx.onerror = () => reject(transactionError(tx));
      });
    },

    async put(record) {
      const now = Date.now();
      const candidate: StoredUpload = { ...record, gallery: gallerySlug };
      if (!isStoredUpload(candidate, now))
        throw new Error("This upload cannot be saved for recovery. Choose a valid photo and try again.");
      const connection = await db();
      await new Promise<void>((resolve, reject) => {
        const tx = connection.transaction([STORE_NAME, META_STORE_NAME], "readwrite");
        const store = tx.objectStore(STORE_NAME);
        let limitError: Error | undefined;
        let rowsReady = false;
        let epochReady = false;
        const epochRequest = tx.objectStore(META_STORE_NAME).get(EPOCH_KEY);
        const request = store.getAll();
        const writeIfAllowed = () => {
          if (!rowsReady || !epochReady) return;
          const currentEpoch = typeof epochRequest.result === "number" ? epochRequest.result : 0;
          if (capturedEpoch !== undefined && capturedEpoch !== currentEpoch) {
            limitError = new Error("Upload recovery was cleared after sign-out. Reload this gallery before saving more uploads.");
            try { tx.abort(); } catch { /* transaction already finished */ }
            return;
          }
          capturedEpoch ??= currentEpoch;
          const retained: StoredUpload[] = [];
          for (const value of request.result as unknown[]) {
            if (!isStoredUpload(value, now)) {
              const row = value as Partial<StoredUpload> | null;
              if (row && typeof row.gallery === "string" && typeof row.id === "string")
                store.delete([row.gallery, row.id]);
              continue;
            }
            retained.push(value);
          }
          if (exceedsUploadRecoveryLimits(retained, candidate)) {
            limitError = new Error("Saved upload limit reached (100 photos or 200 MiB). Remove saved uploads before adding more.");
            try { tx.abort(); } catch { /* transaction already finished */ }
            return;
          }
          store.put(candidate);
        };
        request.onsuccess = () => { rowsReady = true; writeIfAllowed(); };
        epochRequest.onsuccess = () => { epochReady = true; writeIfAllowed(); };
        request.onerror = () => {
          try { tx.abort(); } catch { /* transaction already finished */ }
        };
        epochRequest.onerror = () => {
          try { tx.abort(); } catch { /* transaction already finished */ }
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(limitError ?? transactionError(tx));
        tx.onerror = () => reject(limitError ?? transactionError(tx));
      });
    },

    async remove(id) {
      if (!UUID.test(id)) return;
      const connection = await db();
      await new Promise<void>((resolve, reject) => {
        const tx = connection.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete([gallerySlug, id]);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(transactionError(tx));
        tx.onerror = () => reject(transactionError(tx));
      });
    },

    async clear() {
      const connection = await db();
      await new Promise<void>((resolve, reject) => {
        const tx = connection.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const range = IDBKeyRange.bound([gallerySlug, ""], [gallerySlug, "\uffff"]);
        store.delete(range);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(transactionError(tx));
        tx.onerror = () => reject(transactionError(tx));
      });
    },

    close() {
      closed = true;
      void database?.then((connection) => connection.close(), () => {});
    },
  };
}

export async function clearAllUploadRecovery(): Promise<void> {
  const connection = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = connection.transaction([STORE_NAME, META_STORE_NAME], "readwrite");
      tx.objectStore(STORE_NAME).clear();
      const meta = tx.objectStore(META_STORE_NAME);
      const epoch = meta.get(EPOCH_KEY);
      epoch.onsuccess = () => {
        const value = typeof epoch.result === "number" ? epoch.result : 0;
        meta.put(value + 1, EPOCH_KEY);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(transactionError(tx));
      tx.onerror = () => reject(transactionError(tx));
    });
  } finally {
    connection.close();
  }
}
