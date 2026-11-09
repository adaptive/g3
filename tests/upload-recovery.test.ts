import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  clearAllUploadRecovery,
  createUploadRecoveryStore,
  UPLOAD_RECOVERY_MAX_BYTES,
  UPLOAD_RECOVERY_MAX_FILES,
  UPLOAD_RECOVERY_TTL_MS,
  exceedsUploadRecoveryLimits,
  type SavedUpload,
} from "../src/client/upload-recovery";

type FakeRequest = {
  result: any;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded: (() => void) | null;
  onblocked: (() => void) | null;
};

class FakeTx {
  error: Error | null = null;
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private pending = 0;
  private completeQueued = false;
  private aborted = false;
  constructor(private readonly state: FakeState, private readonly names: string[]) {}
  objectStore(name: string) {
    if (!this.names.includes(name)) throw new Error("Object store outside transaction");
    return new FakeObjectStore(this, name, this.state);
  }
  request<T>(read: () => T, write?: () => void) {
    this.pending += 1;
    const req: FakeRequest = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
    };
    queueMicrotask(() => {
      if (this.aborted) return;
      try {
        req.result = read();
        req.onsuccess?.();
        write?.();
      } catch (error) {
        req.error = error as Error;
        this.abort(error as Error);
      } finally {
        this.pending -= 1;
        this.queueComplete();
      }
    });
    return req;
  }
  mutate(operation: () => void) {
    if (this.aborted) throw new Error("Transaction aborted");
    operation();
    this.queueComplete();
  }
  private queueComplete() {
    if (this.pending !== 0 || this.aborted || this.completeQueued) return;
    this.completeQueued = true;
    queueMicrotask(() => {
      this.completeQueued = false;
      if (this.pending === 0 && !this.aborted) this.oncomplete?.();
    });
  }
  abort(error?: Error) {
    if (this.aborted) return;
    this.aborted = true;
    this.error = error ?? null;
    queueMicrotask(() => this.onabort?.());
  }
}

class FakeObjectStore {
  constructor(private readonly tx: FakeTx, private readonly name: string, private readonly state: FakeState) {}
  getAll() {
    return this.tx.request(() => [...this.state.stores.get(this.name)!.values()]);
  }
  get(key: unknown) {
    return this.tx.request(() => this.state.stores.get(this.name)!.get(JSON.stringify(key)));
  }
  put(value: any, explicitKey?: unknown) {
    const key = explicitKey ?? [value.gallery, value.id];
    this.tx.mutate(() => this.state.stores.get(this.name)!.set(JSON.stringify(key), structuredClone(value)));
  }
  delete(key: any) {
    this.tx.mutate(() => {
      const store = this.state.stores.get(this.name)!;
      if (key && typeof key === "object" && "lower" in key) {
        for (const [encoded, value] of store) {
          const row = value as any;
          if (row.gallery >= key.lower[0] && row.gallery <= key.upper[0] && row.id >= key.lower[1] && row.id <= key.upper[1]) store.delete(encoded);
        }
      } else store.delete(JSON.stringify(key));
    });
  }
  clear() { this.tx.mutate(() => this.state.stores.get(this.name)!.clear()); }
}

class FakeState {
  upgraded = false;
  stores = new Map<string, Map<string, unknown>>([
    ["uploads", new Map()],
    ["meta", new Map()],
  ]);
}

class FakeDatabase {
  objectStoreNames: { contains: (name: string) => boolean };
  onversionchange: (() => void) | null = null;
  constructor(private readonly state: FakeState) {
    this.objectStoreNames = { contains: (name) => state.stores.has(name) };
  }
  createObjectStore(name: string) {
    if (!this.state.stores.has(name)) this.state.stores.set(name, new Map());
  }
  transaction(names: string | string[]) {
    return new FakeTx(this.state, Array.isArray(names) ? names : [names]);
  }
  close() {}
}

class FakeKeyRange {
  private constructor(readonly lower: unknown[], readonly upper: unknown[]) {}
  static bound(lower: unknown[], upper: unknown[]) { return new FakeKeyRange(lower, upper); }
}

function installFakeIndexedDb() {
  const state = new FakeState();
  const previousIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const previousRange = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
  const factory = {
    open() {
      const result: FakeRequest & { result?: FakeDatabase } = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      };
      const db = new FakeDatabase(state);
      result.result = db;
      queueMicrotask(() => {
        if (!state.upgraded) {
          state.upgraded = true;
          result.onupgradeneeded?.();
        }
        result.onsuccess?.();
      });
      return result;
    },
  };
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: factory });
  Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: FakeKeyRange });
  return {
    state,
    restore() {
      if (previousIndexedDB) Object.defineProperty(globalThis, "indexedDB", previousIndexedDB);
      else delete (globalThis as { indexedDB?: unknown }).indexedDB;
      if (previousRange) Object.defineProperty(globalThis, "IDBKeyRange", previousRange);
      else delete (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange;
    },
  };
}

const slug = "madeira-event";
const uuid = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
function saved(id: string, size = 8, updatedAt = Date.now()): SavedUpload {
  return {
    id,
    file: new File([new Uint8Array(size)], `${id}.jpg`, { type: "image/jpeg", lastModified: 1234 }),
    status: "paused",
    progress: 48,
    uploadId: uuid("901"),
    updatedAt,
  };
}

test("IndexedDB recovery is gallery-scoped and preserves saved File metadata", async () => {
  const fake = installFakeIndexedDb();
  const eventStore = createUploadRecoveryStore(slug);
  const otherStore = createUploadRecoveryStore("other-gallery");
  try {
    const original = saved(uuid("1"));
    await eventStore.put(original);
    assert.deepEqual(await otherStore.load(), []);
    const [restored] = await eventStore.load();
    assert.equal(restored.id, original.id);
    assert.equal(restored.file.name, original.file.name);
    assert.equal(restored.file.type, original.file.type);
    assert.equal(restored.file.lastModified, original.file.lastModified);
    assert.equal(restored.progress, 48);
    await eventStore.clear();
    assert.deepEqual(await eventStore.load(), []);
    assert.equal((await otherStore.load()).length, 0);
  } finally {
    eventStore.close();
    otherStore.close();
    fake.restore();
  }
});

test("upload recovery expires old files and enforces per-origin file and byte caps", async () => {
  const fake = installFakeIndexedDb();
  const store = createUploadRecoveryStore(slug);
  try {
    const expired = saved(uuid("1"));
    await store.put(expired);
    const stored = fake.state.stores.get("uploads")!.get(JSON.stringify([slug, expired.id])) as SavedUpload & { gallery: string };
    fake.state.stores.get("uploads")!.set(JSON.stringify([slug, expired.id]), {
      ...stored,
      updatedAt: Date.now() - UPLOAD_RECOVERY_TTL_MS - 1,
    });
    assert.deepEqual(await store.load(), []);
    const atLimit = Array.from({ length: 4 }, (_, index) => ({
      gallery: index % 2 ? "other-gallery" : slug,
      id: uuid(String(index + 10)),
      file: { size: UPLOAD_RECOVERY_MAX_BYTES / 4 },
    }));
    assert.equal(exceedsUploadRecoveryLimits(atLimit, {
      gallery: slug,
      id: uuid("20"),
      file: { size: 1 },
    }), true);
    assert.equal(exceedsUploadRecoveryLimits(atLimit.slice(1), {
      gallery: slug,
      id: uuid("20"),
      file: { size: UPLOAD_RECOVERY_MAX_BYTES / 4 },
    }), false);
    for (let index = 0; index < UPLOAD_RECOVERY_MAX_FILES; index++)
      await store.put(saved(uuid(String(index + 10)), 1));
    await assert.rejects(store.put(saved(uuid("999"), 1)), /100 photos or 200 MiB/);
    const otherStore = createUploadRecoveryStore("other-gallery");
    await assert.rejects(otherStore.put(saved(uuid("1000"), 1)), /100 photos or 200 MiB/);
    otherStore.close();
  } finally {
    store.close();
    fake.restore();
  }
});

test("global sign-out purge clears retained files and blocks stale store instances", async () => {
  const fake = installFakeIndexedDb();
  const oldTabStore = createUploadRecoveryStore(slug);
  const newTabStore = createUploadRecoveryStore("other-gallery");
  try {
    await oldTabStore.put(saved(uuid("1")));
    await oldTabStore.load();
    await clearAllUploadRecovery();
    assert.deepEqual(await oldTabStore.load(), []);
    await assert.rejects(oldTabStore.put(saved(uuid("2"))), /cleared after sign-out/);
    await newTabStore.put(saved(uuid("3")));
    assert.equal((await newTabStore.load()).length, 1);
  } finally {
    oldTabStore.close();
    newTabStore.close();
    fake.restore();
  }
});
