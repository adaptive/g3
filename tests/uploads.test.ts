import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  detectImageType,
  readImageDimensions,
  type PreparedPhoto,
} from "../src/client/image";
import {
  createUploadQueue,
  type UploadStatus,
  type UploadTask,
} from "../src/client/uploads";
import { galleryApiPath, type Photo } from "../src/shared/types";
import type { SavedUpload, UploadRecoveryStore } from "../src/client/upload-recovery";

function png(width: number, height: number): File {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return new File([bytes], "test.png", { type: "image/png" });
}

const prepared = async (file: File): Promise<PreparedPhoto> => ({
  input: {
    filename: file.name,
    contentType: "image/png",
    bytes: file.size,
    width: 10,
    height: 10,
  },
  original: file,
  preview: new Blob(["preview"], { type: "image/jpeg" }),
  thumbnail: new Blob(["thumb"], { type: "image/jpeg" }),
});

class FakeXhr {
  upload: { onprogress: ((event: { loaded: number }) => void) | null } = {
    onprogress: null,
  };
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onload: (() => void) | null = null;
  withCredentials = false;
  status = 200;
  responseText = "";
  static sends = 0;
  open() {}
  setRequestHeader(_name: string, _value: string) {}
  send(_blob?: Blob) {
    FakeXhr.sends += 1;
    const call = FakeXhr.sends;
    queueMicrotask(() => this.upload.onprogress?.({ loaded: 7 }));
    setTimeout(() => {
      this.status = FakeXhr.failFirstPreview && call === 2 ? 500 : 200;
      this.responseText =
        this.status === 200
          ? '{"ok":true}'
          : '{"error":"temporary network failure"}';
      this.onload?.();
    }, 0);
  }
  abort() {
    this.onabort?.();
  }
  static failFirstPreview = false;
}

class ControlledXhr {
  upload: { onprogress: ((event: { loaded: number }) => void) | null } = {
    onprogress: null,
  };
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onload: (() => void) | null = null;
  withCredentials = false;
  status = 200;
  responseText = "";
  static instances: ControlledXhr[] = [];
  static active = 0;
  static maxActive = 0;
  open() {}
  setRequestHeader() {}
  send() {
    ControlledXhr.instances.push(this);
    ControlledXhr.active += 1;
    ControlledXhr.maxActive = Math.max(
      ControlledXhr.maxActive,
      ControlledXhr.active,
    );
  }
  succeed() {
    ControlledXhr.active -= 1;
    this.status = 200;
    this.onload?.();
  }
  abort() {
    if (ControlledXhr.active > 0) ControlledXhr.active -= 1;
    this.onabort?.();
  }
  static reset() {
    ControlledXhr.instances = [];
    ControlledXhr.active = 0;
    ControlledXhr.maxActive = 0;
  }
}

const xhrConstructor = FakeXhr as unknown as typeof XMLHttpRequest;
const waitFor = async (
  read: () => UploadTask | undefined,
  status: UploadStatus,
): Promise<UploadTask> => {
  for (let i = 0; i < 100; i += 1) {
    const task = read();
    if (task?.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Upload did not reach ${status}.`);
};

function recoveryFixture(initial: SavedUpload[] = []) {
  const rows = new Map(initial.map((record) => [record.id, record]));
  const store: UploadRecoveryStore = {
    async load() { return [...rows.values()]; },
    async put(record) { rows.set(record.id, { ...record }); },
    async remove(id) { rows.delete(id); },
    async clear() { rows.clear(); },
    close() {},
  };
  return { rows, store };
}

test("releases the gallery recovery lock after a failed store load", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let lockHeld = false;
  let loads = 0;
  const locks = {
    async request(_name: string, _options: LockOptions, callback: (lock: Lock | null) => unknown) {
      if (lockHeld) return callback(null);
      lockHeld = true;
      try {
        return await callback({} as Lock);
      } finally {
        lockHeld = false;
      }
    },
  } as LockManager;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks },
  });

  try {
    const recovery = recoveryFixture();
    recovery.store.load = async () => {
      loads += 1;
      if (loads === 1) throw new Error("Temporary IndexedDB failure");
      return [];
    };
    const warnings: string[] = [];
    const makeQueue = () => createUploadQueue(() => {}, {
      recovery: recovery.store,
      recoveryLockName: "adaptive-gallery-upload-recovery:default",
      onRecoveryWarning: (message) => warnings.push(message),
    });

    const first = makeQueue();
    await first.restore();
    assert.deepEqual(warnings, ["Temporary IndexedDB failure"]);
    for (let i = 0; lockHeld && i < 10; i += 1) await Promise.resolve();
    assert.equal(lockHeld, false, "failed recovery loading must release its lock");

    const second = makeQueue();
    await second.restore();
    assert.equal(loads, 2, "a second tab can take over and load recovery");
    assert.equal(lockHeld, true, "the succeeding queue retains its lock");
    first.dispose();
    second.dispose();
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

const recoveredId = "00000000-0000-4000-8000-000000000099";
const recoveredPhoto: Photo = {
  id: recoveredId, filename: "test.png", contentType: "image/png", bytes: 24,
  width: 10, height: 10, createdAt: "2026-11-08T10:00:00Z",
};

test("restores saved files paused and reconciles published photos without decoding or uploading again", async () => {
  const recovery = recoveryFixture([{
    id: recoveredId, file: png(10, 10), status: "uploading", progress: 99, updatedAt: Date.now(),
  }]);
  let tasks: UploadTask[] = [];
  const calls: string[] = [];
  const queue = createUploadQueue((next) => { tasks = next; }, {
    recovery: recovery.store,
    preparePhoto: async () => { throw new Error("Published photos must not be decoded again"); },
    fetch: async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return Response.json({ status: "published", photo: recoveredPhoto });
    },
  });
  await queue.restore();
  assert.equal(tasks[0].status, "paused");
  assert.equal(tasks[0].progress, 99);
  assert.equal(tasks[0].file.name, "test.png");
  assert.deepEqual(calls, []);
  queue.resume();
  await waitFor(() => tasks[0], "complete");
  assert.deepEqual(calls, [`GET /api/admin/uploads/${recoveredId}`]);
  assert.equal(recovery.rows.size, 0);
  queue.dispose();
});

test("recovery reuses a stable create ID even when the original create response was never saved", async () => {
  FakeXhr.sends = 0;
  const recovery = recoveryFixture([{
    id: recoveredId, file: png(10, 10), status: "processing", progress: 0, updatedAt: Date.now(),
  }]);
  let tasks: UploadTask[] = [];
  let creates = 0;
  const queue = createUploadQueue((next) => { tasks = next; }, {
    recovery: recovery.store, preparePhoto: prepared, XMLHttpRequest: xhrConstructor,
    fetch: async (url, init) => {
      if (url.endsWith("/complete")) return Response.json(recoveredPhoto);
      if (init?.method === "POST") {
        creates++;
        assert.equal(JSON.parse(String(init.body)).uploadId, recoveredId);
        return Response.json({ id: recoveredId });
      }
      return Response.json({ status: "pending" });
    },
  });
  await queue.restore();
  queue.resume();
  await waitFor(() => tasks[0], "complete");
  assert.equal(creates, 1);
  assert.equal(FakeXhr.sends, 3);
  assert.equal(recovery.rows.size, 0);
  queue.dispose();
});

test("a lost completion response keeps the server identity and retry reconciles instead of reposting", async () => {
  FakeXhr.sends = 0;
  let tasks: UploadTask[] = [];
  let creates = 0;
  let decodes = 0;
  const methods: string[] = [];
  const recovery = recoveryFixture();
  let serverId = "";
  const queue = createUploadQueue((next) => { tasks = next; }, {
    recovery: recovery.store, XMLHttpRequest: xhrConstructor,
    preparePhoto: async (file) => { decodes++; return prepared(file); },
    fetch: async (url, init) => {
      methods.push(init?.method ?? "GET");
      if (url.endsWith("/complete")) throw new TypeError("Connection closed after publish");
      if (init?.method === "POST") {
        creates++;
        serverId = JSON.parse(String(init.body)).uploadId;
        return Response.json({ id: serverId });
      }
      return Response.json({ status: "published", photo: { ...recoveredPhoto, id: serverId } });
    },
  });
  await queue.restore();
  queue.add([png(10, 10)]);
  const failed = await waitFor(() => tasks[0], "error");
  assert.equal(recovery.rows.get(failed.id)?.uploadId, serverId);
  queue.retry(failed.id);
  await waitFor(() => tasks[0], "complete");
  assert.equal(creates, 1);
  assert.equal(decodes, 1);
  assert.equal(FakeXhr.sends, 3);
  assert.deepEqual(methods, ["POST", "POST", "GET"]);
  assert.equal(recovery.rows.size, 0);
  queue.dispose();
});

test("storage quota errors warn without blocking ordinary uploads", async () => {
  FakeXhr.sends = 0;
  const recovery = recoveryFixture();
  recovery.store.put = async () => { throw new DOMException("Storage is full", "QuotaExceededError"); };
  let tasks: UploadTask[] = [];
  const warnings: string[] = [];
  const queue = createUploadQueue((next) => { tasks = next; }, {
    recovery: recovery.store, onRecoveryWarning: (warning) => warnings.push(warning),
    preparePhoto: prepared, XMLHttpRequest: xhrConstructor,
    fetch: async (url, init) => url.endsWith("/complete")
      ? Response.json(recoveredPhoto)
      : Response.json({ id: JSON.parse(String(init?.body)).uploadId }),
  });
  await queue.restore();
  queue.add([png(10, 10)]);
  await waitFor(() => tasks[0], "complete");
  assert.ok(warnings.includes("Storage is full"));
  assert.equal(FakeXhr.sends, 3);
  queue.dispose();
});

test("files selected while storage is loading are saved before any create request", async () => {
  const recovery = recoveryFixture();
  let finishLoad!: (records: SavedUpload[]) => void;
  recovery.store.load = () => new Promise((resolve) => { finishLoad = resolve; });
  let tasks: UploadTask[] = [];
  const queue = createUploadQueue((next) => { tasks = next; }, {
    recovery: recovery.store, preparePhoto: prepared, XMLHttpRequest: xhrConstructor,
    fetch: async (url, init) => {
      if (url.endsWith("/complete")) return Response.json(recoveredPhoto);
      const id = JSON.parse(String(init?.body)).uploadId;
      assert.ok(recovery.rows.has(id));
      return Response.json({ id });
    },
  });
  const ready = queue.restore();
  queue.add([png(10, 10)]);
  assert.equal(tasks[0].status, "queued");
  finishLoad([]);
  await ready;
  await waitFor(() => tasks[0], "complete");
  queue.dispose();
});

test("forget waits for queued writes and leaves no saved files or late records", async () => {
  const recovery = recoveryFixture();
  let tasks: UploadTask[] = [];
  let releaseSave!: () => void;
  recovery.store.put = async (record) => {
    await new Promise<void>((resolve) => { releaseSave = resolve; });
    recovery.rows.set(record.id, record);
  };
  const queue = createUploadQueue((next) => { tasks = next; }, {
    recovery: recovery.store, preparePhoto: prepared,
  });
  await queue.restore();
  queue.add([png(10, 10)]);
  await Promise.resolve();
  const forgotten = queue.forget();
  releaseSave();
  await forgotten;
  assert.deepEqual(tasks, []);
  assert.equal(recovery.rows.size, 0);
  queue.dispose();
});

test("recognizes only actual image signatures and reads PNG dimensions", async () => {
  const file = png(4000, 3000);
  assert.equal(await detectImageType(file), "image/png");
  assert.deepEqual(await readImageDimensions(file, "image/png"), {
    width: 4000,
    height: 3000,
  });
  await assert.rejects(
    () =>
      detectImageType(
        new File(["not a photo"], "fake.jpg", { type: "image/jpeg" }),
      ),
    /Unsupported image/,
  );
});

test("stops after the active decoder finishes when cancelled during preparation", async () => {
  let finishDecode!: (photo: PreparedPhoto) => void;
  let calls = 0;
  let tasks: UploadTask[] = [];
  const queue = createUploadQueue(
    (next) => {
      tasks = next;
    },
    {
      preparePhoto: () =>
        new Promise((resolve) => {
          finishDecode = resolve;
        }),
      fetch: async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
      XMLHttpRequest: xhrConstructor,
    },
  );
  queue.add([png(10, 10)]);
  const task = await waitFor(() => tasks[0], "processing");
  queue.cancel();
  finishDecode(await prepared(task.file));
  await waitFor(() => tasks[0], "cancelled");
  assert.equal(calls, 0);
  queue.dispose();
});

test("waits for a dispatched create request and deletes its stage after cancellation", async () => {
  FakeXhr.sends = 0;
  let releaseCreate!: (response: Response) => void;
  let tasks: UploadTask[] = [];
  const calls: string[] = [];
  const queue = createUploadQueue(
    (next) => {
      tasks = next;
    },
    {
      preparePhoto: prepared,
      XMLHttpRequest: xhrConstructor,
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/api/admin/uploads")
          return new Promise((resolve) => {
            releaseCreate = resolve;
          });
        return Response.json({ ok: true });
      },
    },
  );
  queue.add([png(10, 10)]);
  await waitFor(() => tasks[0], "processing");
  while (!releaseCreate) await new Promise((resolve) => setTimeout(resolve, 1));
  queue.cancel();
  releaseCreate(Response.json({ id: "upload-dispatched" }));
  await waitFor(() => tasks[0], "cancelled");
  assert.deepEqual(calls, [
    "POST /api/admin/uploads",
    "DELETE /api/admin/uploads/upload-dispatched",
  ]);
  assert.equal(FakeXhr.sends, 0);
  queue.dispose();
});

test("upload headers follow the actual WebP and AVIF thumbnail blobs", async () => {
  FakeXhr.failFirstPreview = false;
  for (const type of ["image/webp", "image/avif"]) {
    const sent: Array<{ header: string; bodyType: string }> = [];
    class HeaderXhr extends FakeXhr {
      private header = "";
      setRequestHeader(name: string, value: string) {
        if (name === "Content-Type") this.header = value;
      }
      send(blob?: Blob) {
        sent.push({ header: this.header, bodyType: blob?.type ?? "" });
        super.send(blob);
      }
    }
    let tasks: UploadTask[] = [];
    const queue = createUploadQueue((next) => { tasks = next; }, {
      preparePhoto: async (file) => ({
        ...await prepared(file),
        thumbnail: new Blob(["optimized thumbnail"], { type }),
      }),
      XMLHttpRequest: HeaderXhr as unknown as typeof XMLHttpRequest,
      fetch: async (url) => Response.json(String(url).endsWith("/complete")
        ? { photo: recoveredPhoto }
        : { id: "optimized-upload" }),
    });
    try {
      queue.add([png(10, 10)]);
      await waitFor(() => tasks[0], "complete");
      assert.deepEqual(sent, [
        { header: "image/png", bodyType: "image/png" },
        { header: "image/jpeg", bodyType: "image/jpeg" },
        { header: type, bodyType: type },
      ]);
    } finally {
      queue.dispose();
    }
  }
});

test("cleans an incomplete stage after failure and retries it as a fresh upload", async () => {
  FakeXhr.sends = 0;
  FakeXhr.failFirstPreview = true;
  const deleted: string[] = [];
  const completed: Photo = {
    id: "photo-2",
    filename: "test.png",
    contentType: "image/png",
    bytes: 24,
    width: 10,
    height: 10,
    createdAt: "2026-01-01T00:00:00Z",
  };
  let nextId = 0;
  let tasks: UploadTask[] = [];
  const queue = createUploadQueue(
    (next) => {
      tasks = next;
    },
    {
      preparePhoto: prepared,
      XMLHttpRequest: xhrConstructor,
      fetch: async (input, init) => {
        const url = String(input);
        if (url === "/api/admin/uploads")
          return Response.json({ id: `upload-${++nextId}` });
        const staged = url.match(/^\/api\/admin\/uploads\/(upload-\d+)$/);
        if (staged && init?.method === "DELETE") {
          deleted.push(staged[1]);
          return Response.json({ ok: true });
        }
        if (url.endsWith("/complete")) return Response.json(completed);
        throw new Error(`Unexpected upload request: ${url}`);
      },
    },
  );
  queue.add([png(10, 10)]);
  await waitFor(() => tasks[0], "error");
  assert.equal(tasks[0].error, "temporary network failure");
  assert.deepEqual(deleted, ["upload-1"]);
  queue.retry(tasks[0].id);
  await waitFor(() => tasks[0], "complete");
  assert.equal(tasks[0].photo?.id, "photo-2");
  assert.equal(nextId, 2);
  assert.equal(FakeXhr.sends, 5);
  FakeXhr.failFirstPreview = false;
  queue.dispose();
});

test("keeps create, binary data, completion and cancellation in the queue's gallery", async () => {
  const calls: string[] = [];
  let tasks: UploadTask[] = [];
  let sequence = 0;
  class ScopedXhr extends FakeXhr {
    open(_method?: string, url?: string) { calls.push(`PUT ${url}`); }
  }
  const queue = createUploadQueue((next) => { tasks = next; }, {
    apiPath: (path) => galleryApiPath("family", path),
    preparePhoto: prepared,
    XMLHttpRequest: ScopedXhr as unknown as typeof XMLHttpRequest,
    fetch: async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      if (url.endsWith("/complete")) return Response.json({ id: "photo" });
      if (init?.method === "POST") return Response.json({ id: `stage-${++sequence}` });
      return Response.json({ ok: true });
    },
  });
  queue.add([png(10, 10)]);
  await waitFor(() => tasks[0], "complete");
  assert.deepEqual(calls, [
    "POST /api/galleries/family/admin/uploads",
    "PUT /api/galleries/family/admin/uploads/stage-1/original",
    "PUT /api/galleries/family/admin/uploads/stage-1/preview",
    "PUT /api/galleries/family/admin/uploads/stage-1/thumbnail",
    "POST /api/galleries/family/admin/uploads/stage-1/complete",
  ]);
  // A failed binary request must clean up through the same gallery endpoint.
  calls.length = 0;
  FakeXhr.failFirstPreview = true;
  FakeXhr.sends = 0;
  queue.add([png(10, 10)]);
  await waitFor(() => tasks[1], "error");
  assert.equal(calls.at(-1), "DELETE /api/galleries/family/admin/uploads/stage-2");
  FakeXhr.failFirstPreview = false;
  queue.dispose();
});

test("prepares one next photo during the active upload and keeps both lanes bounded", async () => {
  ControlledXhr.reset();
  const files = [png(10, 10), png(11, 11), png(12, 12)];
  let tasks: UploadTask[] = [];
  let preparations = 0;
  let activePreparations = 0;
  let maxPreparations = 0;
  let sequence = 0;
  const queue = createUploadQueue((next) => { tasks = next; }, {
    XMLHttpRequest: ControlledXhr as unknown as typeof XMLHttpRequest,
    preparePhoto: async (file) => {
      preparations += 1;
      activePreparations += 1;
      maxPreparations = Math.max(maxPreparations, activePreparations);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activePreparations -= 1;
      return prepared(file);
    },
    fetch: async (input) => {
      const url = String(input);
      if (url === "/api/admin/uploads")
        return Response.json({ id: `stage-${++sequence}` });
      if (url.endsWith("/complete"))
        return Response.json({ id: `photo-${sequence}` });
      return Response.json({ ok: true });
    },
  });
  queue.add(files);

  const waitForXhrs = async (count: number) => {
    for (let i = 0; i < 100; i += 1) {
      if (ControlledXhr.instances.length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`Expected ${count} binary requests.`);
  };
  await waitForXhrs(1);
  assert.equal(preparations, 2, "one lookahead is preparing while photo one uploads");
  assert.deepEqual(tasks.map((task) => task.status), ["uploading", "processing", "queued"]);
  for (let index = 0; index < 3; index += 1) {
    ControlledXhr.instances[index].succeed();
    if (index < 2) await waitForXhrs(index + 2);
  }
  await waitForXhrs(4);
  assert.equal(preparations, 3, "photo three starts only after photo two is ready to upload");
  assert.equal(ControlledXhr.active, 1, "only one staged photo upload is active");
  assert.equal(maxPreparations, 1, "only one decoder/preparation runs at a time");

  for (let index = 3; index < 9; index += 1) {
    ControlledXhr.instances[index].succeed();
    if (index < 8) await waitForXhrs(index + 2);
    if (tasks.every((task) => task.status === "complete")) break;
  }
  await waitFor(() => tasks[2], "complete");
  assert.equal(preparations, 3);
  assert.equal(ControlledXhr.maxActive, 1);
  queue.dispose();
});

test("a failed lookahead preparation does not block uploads and can be retried", async () => {
  ControlledXhr.reset();
  let tasks: UploadTask[] = [];
  let secondAttempts = 0;
  let stage = 0;
  const queue = createUploadQueue((next) => { tasks = next; }, {
    XMLHttpRequest: ControlledXhr as unknown as typeof XMLHttpRequest,
    preparePhoto: async (file) => {
      if (file.name === "second.png" && ++secondAttempts === 1)
        throw new Error("decoder failed");
      return prepared(file);
    },
    fetch: async (input) => {
      const url = String(input);
      if (url === "/api/admin/uploads") return Response.json({ id: `stage-${++stage}` });
      if (url.endsWith("/complete")) return Response.json({ id: `photo-${stage}` });
      return Response.json({ ok: true });
    },
  });
  const first = png(10, 10);
  const second = new File([png(10, 10)], "second.png", { type: "image/png" });
  queue.add([first, second]);
  for (let index = 0; index < 3; index += 1) {
    for (let i = 0; ControlledXhr.instances.length <= index && i < 100; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 2));
    ControlledXhr.instances[index].succeed();
    if (index < 2) {
      for (let i = 0; ControlledXhr.instances.length <= index + 1 && i < 100; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  await waitFor(() => tasks[0], "complete");
  await waitFor(() => tasks[1], "error");
  assert.equal(tasks[1].error, "decoder failed");

  queue.retry(tasks[1].id);
  for (let index = 3; index < 6; index += 1) {
    for (let i = 0; ControlledXhr.instances.length <= index && i < 100; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 2));
    ControlledXhr.instances[index].succeed();
    if (index < 5) {
      for (let i = 0; ControlledXhr.instances.length <= index + 1 && i < 100; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  await waitFor(() => tasks[1], "complete");
  assert.equal(secondAttempts, 2);
  queue.dispose();
});

test("cancelling an uncooperative lookahead serializes an immediate retry", async () => {
  ControlledXhr.reset();
  let tasks: UploadTask[] = [];
  let releaseFirstLookahead!: (value: PreparedPhoto) => void;
  let secondAttempts = 0;
  let stage = 0;
  const queue = createUploadQueue((next) => { tasks = next; }, {
    XMLHttpRequest: ControlledXhr as unknown as typeof XMLHttpRequest,
    preparePhoto: (file) => {
      if (file.name !== "second.png") return prepared(file);
      secondAttempts += 1;
      if (secondAttempts === 1)
        return new Promise((resolve) => { releaseFirstLookahead = resolve; });
      return prepared(file);
    },
    fetch: async (input, _init) => {
      const url = String(input);
      if (url === "/api/admin/uploads") return Response.json({ id: `stage-${++stage}` });
      if (url.endsWith("/complete")) return Response.json({ id: `photo-${stage}` });
      return Response.json({ ok: true });
    },
  });
  queue.add([
    png(10, 10),
    new File([png(10, 10)], "second.png", { type: "image/png" }),
  ]);
  for (let i = 0; ControlledXhr.instances.length === 0 && i < 100; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(secondAttempts, 1);
  queue.cancel();
  await waitFor(() => tasks[0], "cancelled");
  await waitFor(() => tasks[1], "cancelled");

  // Retry before the first decoder settles. The real decoder lane must not run
  // both attempts at once even though the cancelled queue wait has already ended.
  queue.retry(tasks[1].id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(secondAttempts, 1, "retry waits for the uncooperative decoder to finish");
  releaseFirstLookahead(await prepared(tasks[1].file));
  for (let i = 0; ControlledXhr.instances.length < 2 && i < 100; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 2));
  for (let index = 1; index < 4; index += 1) {
    if (ControlledXhr.instances[index]) ControlledXhr.instances[index].succeed();
    if (index < 3) {
      for (let i = 0; ControlledXhr.instances.length <= index + 1 && i < 100; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  await waitFor(() => tasks[1], "complete");
  assert.equal(secondAttempts, 2);
  assert.equal(tasks[0].status, "cancelled");
  queue.dispose();
});

test("cancelling marks an already-prepared lookahead terminal without uploading it", async () => {
  ControlledXhr.reset();
  let tasks: UploadTask[] = [];
  let preparations = 0;
  let stages = 0;
  const queue = createUploadQueue((next) => { tasks = next; }, {
    XMLHttpRequest: ControlledXhr as unknown as typeof XMLHttpRequest,
    preparePhoto: async (file) => {
      preparations += 1;
      return prepared(file);
    },
    fetch: async (input, _init) => {
      const url = String(input);
      if (url === "/api/admin/uploads") return Response.json({ id: `stage-${++stages}` });
      if (url.endsWith("/complete")) return Response.json({ id: `photo-${stages}` });
      return Response.json({ ok: true });
    },
  });
  queue.add([png(10, 10), png(11, 11)]);
  for (let i = 0; (ControlledXhr.instances.length === 0 || preparations < 2) && i < 100; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(ControlledXhr.instances.length, 1);
  assert.equal(preparations, 2);
  assert.equal(tasks[1].status, "processing");
  queue.cancel();
  await waitFor(() => tasks[0], "cancelled");
  await waitFor(() => tasks[1], "cancelled");
  assert.equal(stages, 1, "the prepared lookahead never gets a staged upload");
  assert.equal(ControlledXhr.instances.length, 1);
  queue.dispose();
});

test("cancelling active uploads preserves a failed lookahead's retry action", async () => {
  ControlledXhr.reset();
  let tasks: UploadTask[] = [];
  const queue = createUploadQueue((next) => { tasks = next; }, {
    XMLHttpRequest: ControlledXhr as unknown as typeof XMLHttpRequest,
    preparePhoto: async (file) => {
      if (file.name === "failed.png") throw new Error("Cannot decode this photo");
      return prepared(file);
    },
    fetch: async () => Response.json({ id: "stage-first" }),
  });
  queue.add([
    png(10, 10),
    new File([png(10, 10)], "failed.png", { type: "image/png" }),
  ]);
  await waitFor(() => tasks[0], "uploading");
  await waitFor(() => tasks[1], "error");
  queue.cancel();
  await waitFor(() => tasks[0], "cancelled");
  assert.equal(tasks[1].status, "error");
  assert.equal(tasks[1].error, "Cannot decode this photo");
  queue.dispose();
});
