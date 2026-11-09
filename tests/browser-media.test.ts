import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { test } from "bun:test";
import {
  GalleryMediaClient,
  type MediaGrant,
  type MediaManifest,
} from "../src/client/media";

const objectVersion = "a".repeat(64);
const signed = (id: string, variant: MediaGrant["variant"], _expiresAt = Date.now() + 120_000) =>
  `https://account.r2.cloudflarestorage.com/photos/${id}/${variant}?X-Amz-Signature=${Math.random()}`;

function testNavigator(postMessage?: (message: unknown, ports?: MessagePort[]) => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const messages: unknown[] = [];
  const controller = {
    postMessage: (message: unknown, ports?: MessagePort[]) => {
      messages.push(message);
      postMessage?.(message, ports);
    },
  };
  const listeners = new Map<string, Set<(event?: any) => void>>();
  const addListener = (type: string, callback: (event?: any) => void) => {
    const entries = listeners.get(type) ?? new Set();
    entries.add(callback);
    listeners.set(type, entries);
  };
  const removeListener = (type: string, callback: (event?: any) => void) => {
    const entries = listeners.get(type);
    entries?.delete(callback);
    if (!entries?.size) listeners.delete(type);
  };
  const dispatch = (type: string, event?: any) => {
    for (const callback of listeners.get(type) ?? []) callback(event);
  };
  let visibilityState = "visible";
  const fake = {
    serviceWorker: {
      controller,
      addEventListener: addListener,
      removeEventListener: removeListener,
    },
  };
  const fakeWindow = { addEventListener: addListener, removeEventListener: removeListener };
  const fakeDocument = {
    addEventListener: addListener,
    removeEventListener: removeListener,
    get visibilityState() { return visibilityState; },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: fake });
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  return {
    messages,
    controller,
    dispatchServiceWorker: dispatch,
    dispatchPageShow: (event?: any) => dispatch("pageshow", event),
    dispatchVisibilityChange: (nextState = "visible") => {
      visibilityState = nextState;
      dispatch("visibilitychange");
    },
    restore() {
      if (previous) Object.defineProperty(globalThis, "navigator", previous);
      else delete (globalThis as { navigator?: unknown }).navigator;
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else delete (globalThis as { window?: unknown }).window;
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
      else delete (globalThis as { document?: unknown }).document;
    },
  };
}

test("batches missing signed URLs in groups of 48 and reuses grants until renewal", async () => {
  const nav = testNavigator();
  const requests: number[] = [];
  const client = new GalleryMediaClient("madeira-event", async (_url, init) => {
    const photos = (JSON.parse(String(init?.body)) as { photos: Array<{ id: string; variant: MediaGrant["variant"] }> }).photos;
    requests.push(photos.length);
    const expiresAt = Date.now() + 120_000;
    const manifest: MediaManifest = {
      scope: "scope-one",
      expiresAt,
      items: photos.map((photo) => ({
        photoId: photo.id,
        variant: photo.variant,
        url: signed(photo.id, photo.variant, expiresAt),
        expiresAt,
        version: objectVersion,
      })),
    };
    return Response.json(manifest);
  });
  try {
    client.setManifest({ scope: "scope-one", expiresAt: Date.now() + 120_000, items: [] });
    const urls = await Promise.all(
      Array.from({ length: 49 }, (_, index) => client.resolve(`photo-${index}`, "thumbnail")),
    );
    assert.deepEqual(requests, [48, 1]);
    assert.equal(urls.length, 49);
    assert.ok(urls.every((url) => url.includes("X-Amz-Signature=")));
    const priorCount = requests.length;
    assert.equal(
      await client.resolve("photo-0", "thumbnail"),
      urls[0],
    );
    assert.equal(requests.length, priorCount);
    client.setManifest({ scope: "scope-two", expiresAt: Date.now() + 120_000, items: [] });
    assert.ok(nav.messages.some((message) => (message as { type?: string; scope?: string }).type === "CLEAR" && (message as { scope?: string }).scope === "scope-one"));
  } finally {
    client.dispose();
    nav.restore();
  }
});

test("missing signing configuration uses proxy URLs without renewal requests", async () => {
  const nav = testNavigator();
  let calls = 0;
  const client = new GalleryMediaClient("private-gallery", async () => {
    calls++;
    return Response.json(null);
  });
  try {
    client.setManifest(undefined);
    assert.equal(
      await client.resolve("00000000-0000-4000-8000-000000000001", "thumbnail"),
      "/api/galleries/private-gallery/photos/00000000-0000-4000-8000-000000000001/thumbnail",
    );
    assert.equal(calls, 0);
  } finally {
    client.dispose();
    nav.restore();
  }
});

test("ignores malformed signed URLs without failing gallery initialization", async () => {
  const nav = testNavigator();
  const client = new GalleryMediaClient("private-gallery", async () => Response.json({
    scope: "safe-scope",
    expiresAt: Date.now() + 60_000,
    items: [],
  }));
  const id = "00000000-0000-4000-8000-000000000011";
  try {
    assert.doesNotThrow(() => client.setManifest({
      scope: "safe-scope",
      expiresAt: Date.now() + 60_000,
      items: [{
        photoId: id,
        variant: "thumbnail",
        url: "https://[",
        expiresAt: Date.now() + 30_000,
        version: objectVersion,
      }],
    }));
    assert.equal(await client.resolve(id, "thumbnail"),
      "/api/galleries/private-gallery/photos/00000000-0000-4000-8000-000000000011/thumbnail");
  } finally {
    client.dispose();
    nav.restore();
  }
});

test("media URL refresh timeouts resolve waiting images through the proxy", async () => {
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => AbortSignal.abort();
  const nav = testNavigator();
  const client = new GalleryMediaClient("private-gallery", (_url, init) => {
    assert.equal(init?.signal?.aborted, true);
    return Promise.reject(new DOMException("Timed out", "TimeoutError"));
  });
  const id = "00000000-0000-4000-8000-000000000012";
  try {
    client.setManifest({ scope: "safe-scope", expiresAt: Date.now() + 60_000, items: [] });
    assert.equal(await client.resolve(id, "thumbnail"),
      "/api/galleries/private-gallery/photos/00000000-0000-4000-8000-000000000012/thumbnail");
  } finally {
    client.dispose();
    nav.restore();
    AbortSignal.timeout = originalTimeout;
  }
});

test("stats closes its message channel ports after a service worker reply", async () => {
  const channels: Array<{ port1: any; port2: any }> = [];
  const OriginalMessageChannel = globalThis.MessageChannel;
  class FakeMessageChannel {
    port1 = { onmessage: null as ((event: { data: unknown }) => void) | null, closed: false, close() { this.closed = true; } };
    port2 = { closed: false, close() { this.closed = true; } };
    constructor() { channels.push(this); }
  }
  Object.defineProperty(globalThis, "MessageChannel", { configurable: true, value: FakeMessageChannel });
  const nav = testNavigator(() => {
    channels.at(-1)?.port1.onmessage?.({ data: { cacheHits: 3 } });
  });
  const client = new GalleryMediaClient("private-gallery");
  try {
    const stats = await client.stats();
    assert.equal(stats.serviceWorker.cacheHits, 3);
    assert.equal(channels[0]?.port1.closed, true);
    assert.equal(channels[0]?.port2.closed, true);
  } finally {
    client.dispose();
    nav.restore();
    Object.defineProperty(globalThis, "MessageChannel", { configurable: true, value: OriginalMessageChannel });
  }
});

test("a media manifest response arriving after clear cannot restore grants or notify the worker", async () => {
  const nav = testNavigator();
  let release: ((response: Response) => void) | undefined;
  const client = new GalleryMediaClient("private-gallery", async () => new Promise<Response>((resolve) => {
    release = resolve;
  }));
  const id = "00000000-0000-4000-8000-000000000010";
  const pending = client.resolve(id, "thumbnail");
  await Promise.resolve();
  client.clear();
  const messagesAtClear = nav.messages.length;
  const expiry = Date.now() + 60_000;
  release?.(Response.json({
    scope: "late-scope",
    expiresAt: expiry,
    items: [{ photoId: id, variant: "thumbnail", url: signed(id, "thumbnail", expiry), expiresAt: expiry, version: objectVersion }],
  }));
  assert.equal(await pending, "/api/galleries/private-gallery/photos/00000000-0000-4000-8000-000000000010/thumbnail");
  await Promise.resolve();
  const internal = client as unknown as { grants: Map<string, MediaGrant>; mode: string };
  assert.equal(internal.grants.size, 0);
  assert.equal(internal.mode, "unknown");
  assert.equal(nav.messages.slice(messagesAtClear).some((message) => (message as { type?: string }).type === "GRANTS"), false);
  client.dispose();
  nav.restore();
});

test("page replays only current unexpired grants to its current worker and removes lifecycle listeners", () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const nav = testNavigator();
  const client = new GalleryMediaClient("private-gallery");
  const oldId = "00000000-0000-4000-8000-000000000025";
  const currentId = "00000000-0000-4000-8000-000000000026";
  try {
    const oldExpiry = now + 5_000;
    client.setManifest({
      scope: "scope-current",
      expiresAt: now + 10_000,
      items: [{
        photoId: oldId,
        variant: "thumbnail",
        url: signed(oldId, "thumbnail", oldExpiry),
        expiresAt: oldExpiry,
        version: objectVersion,
      }],
    });

    now += 6_000;
    const currentExpiry = now + 30_000;
    client.setManifest({
      scope: "scope-current",
      expiresAt: now + 40_000,
      items: [{
        photoId: currentId,
        variant: "thumbnail",
        url: signed(currentId, "thumbnail", currentExpiry),
        expiresAt: currentExpiry,
        version: objectVersion,
      }],
    });

    const beforeRejectedMessage = nav.messages.length;
    nav.dispatchServiceWorker("message", { source: {}, data: { type: "REQUEST_GRANTS" } });
    assert.equal(nav.messages.length, beforeRejectedMessage);

    nav.dispatchServiceWorker("message", {
      source: nav.controller,
      data: { type: "REQUEST_GRANTS" },
    });
    const replay = nav.messages.at(-1) as { type: string; scope: string; items: MediaGrant[] };
    assert.equal(replay.type, "GRANTS");
    assert.equal(replay.scope, "scope-current");
    assert.deepEqual(replay.items.map((grant) => grant.photoId), [currentId]);

    const beforeHidden = nav.messages.length;
    nav.dispatchVisibilityChange("hidden");
    assert.equal(nav.messages.length, beforeHidden);
    nav.dispatchPageShow();
    nav.dispatchVisibilityChange("visible");
    assert.equal(nav.messages.length, beforeHidden + 2);

    client.dispose();
    const afterDispose = nav.messages.length;
    nav.dispatchPageShow();
    nav.dispatchVisibilityChange("visible");
    nav.dispatchServiceWorker("message", {
      source: nav.controller,
      data: { type: "REQUEST_GRANTS" },
    });
    assert.equal(nav.messages.length, afterDispose);
  } finally {
    client.dispose();
    nav.restore();
    Date.now = originalNow;
  }
});

class MemoryCache {
  private readonly items = new Map<string, Response>();
  quotaFailures = 0;
  writeGate: Promise<void> | null = null;
  writes = 0;
  async match(request: Request) {
    return this.items.get(request.url)?.clone();
  }
  async put(request: Request, response: Response) {
    this.writes++;
    const gate = this.writeGate;
    this.writeGate = null;
    if (gate) await gate;
    if (this.quotaFailures > 0) {
      this.quotaFailures--;
      const error = new Error("quota exceeded");
      error.name = "QuotaExceededError";
      throw error;
    }
    this.items.set(request.url, response.clone());
  }
  async delete(request: Request) {
    return this.items.delete(request.url);
  }
  async keys() {
    return [...this.items.keys()].map((url) => new Request(url));
  }
}

function serviceWorkerHarness(options: { cacheLimit?: number; networkBytes?: number } = {}) {
  const listeners = new Map<string, (event: any) => void>();
  let cache = new MemoryCache();
  let networkReads = 0;
  let cacheOpenFailure = false;
  let quotaFailures = 0;
  let now = Date.now();
  class TestDate extends Date { static now() { return now; } }
  let nextNetworkResponse: Promise<Response> | null = null;
  let releaseNetworkResponse: ((response: Response) => void) | null = null;
  const backgroundTasks: Promise<unknown>[] = [];
  const clientMessages: Array<{ clientId: string; data: unknown }> = [];
  const caches = {
    async open() {
      if (cacheOpenFailure) {
        cacheOpenFailure = false;
        throw new Error("storage unavailable");
      }
      cache.quotaFailures += quotaFailures;
      quotaFailures = 0;
      return cache;
    },
    async keys() { return ["adaptive-gallery-media-v1"]; },
    async delete() { cache = new MemoryCache(); return true; },
  };
  const self = {
    location: { origin: "https://gallery.example" },
    addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      get: async (clientId: string) => ({
        postMessage: (data: unknown) => clientMessages.push({ clientId, data }),
      }),
    },
  };
  const source = options.cacheLimit
    ? readFileSyncForTest.replace("100 * 1024 * 1024", String(options.cacheLimit))
    : readFileSyncForTest;
  runInNewContext(source, {
    self,
    caches,
    Request,
    Response,
    Headers,
    URL,
    Date: TestDate,
    Map,
    Promise,
    Number,
    Math,
    encodeURIComponent,
    fetch: async () => {
      networkReads++;
      if (nextNetworkResponse) {
        const pending = nextNetworkResponse;
        nextNetworkResponse = null;
        return pending;
      }
      const body = options.networkBytes === undefined
        ? new Blob(["jpeg bytes"])
        : new Blob([new Uint8Array(options.networkBytes)]);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "image/jpeg", "cache-control": "no-store" },
      });
    },
  });
  return {
    get networkReads() { return networkReads; },
    get cacheWrites() { return cache.writes; },
    get clientMessages() { return clientMessages; },
    setNow(value: number) { now = value; },
    failNextCacheOpen() { cacheOpenFailure = true; },
    failNextCachePutWithQuota() { quotaFailures++; },
    holdNextNetworkResponse() {
      nextNetworkResponse = new Promise<Response>((resolve) => {
        releaseNetworkResponse = resolve;
      });
      return (response: Response) => releaseNetworkResponse?.(response);
    },
    holdNextCacheWrite() {
      let release!: () => void;
      cache.writeGate = new Promise<void>((resolve) => { release = resolve; });
      return release;
    },
    async message(clientId: string, data: unknown) {
      const waits: Promise<unknown>[] = [];
      listeners.get("message")?.({
        source: { id: clientId },
        data,
        ports: [],
        waitUntil: (promise: Promise<unknown>) => waits.push(promise),
      });
      await Promise.all(waits);
    },
    async fetch(clientId: string, url: string) {
      let response: Promise<Response> | undefined;
      listeners.get("fetch")?.({
        clientId,
        request: new Request(url),
        respondWith: (value: Promise<Response>) => { response = Promise.resolve(value); },
        waitUntil: (promise: Promise<unknown>) => {
          backgroundTasks.push(Promise.resolve(promise));
        },
      });
      return response ? await response : undefined;
    },
    async drain() {
      const pending = backgroundTasks.splice(0);
      await Promise.all(pending);
    },
    async stats(clientId: string) {
      let value: unknown;
      const waits: Promise<unknown>[] = [];
      listeners.get("message")?.({
        source: { id: clientId },
        data: { type: "STATS" },
        ports: [{ postMessage: (next: unknown) => { value = next; } }],
        waitUntil: (promise: Promise<unknown>) => waits.push(promise),
      });
      await Promise.all(waits);
      return value as Record<string, number>;
    },
    async cacheCount() { return (await cache.keys()).length; },
  };
}

const readFileSyncForTest = await readFile("public/gallery-sw.js", "utf8");

test("service worker reuses cached bytes across signed-query rotation within the access scope", async () => {
  const sw = serviceWorkerHarness();
  const id = "00000000-0000-4000-8000-000000000001";
  const expiresAt = Date.now() + 120_000;
  const makeManifest = (scope: string, url: string): MediaManifest => ({
    scope,
    expiresAt,
    items: [{
      photoId: id,
      variant: "thumbnail",
      url,
      expiresAt,
      version: objectVersion,
    }],
  });
  const firstUrl = signed(id, "thumbnail", expiresAt);
  const rotatedUrl = signed(id, "thumbnail", expiresAt);
  const nextScopeUrl = signed(id, "thumbnail", expiresAt);
  await sw.message("tab-a", { type: "GRANTS", slug: "madeira-event", ...makeManifest("scope-one", firstUrl) });
  const first = await sw.fetch("tab-a", firstUrl);
  assert.equal(await first?.text(), "jpeg bytes");
  await sw.drain();
  await sw.message("tab-a", { type: "GRANTS", slug: "madeira-event", ...makeManifest("scope-one", rotatedUrl) });
  const rotated = await sw.fetch("tab-a", rotatedUrl);
  assert.equal(await rotated?.text(), "jpeg bytes");
  assert.equal(sw.networkReads, 1);

  await sw.message("tab-a", { type: "GRANTS", slug: "madeira-event", ...makeManifest("scope-two", nextScopeUrl) });
  await sw.fetch("tab-a", nextScopeUrl);
  await sw.drain();
  assert.equal(sw.networkReads, 2);

  const originalUrl = signed(id, "original", expiresAt);
  await sw.message("tab-a", {
    type: "GRANTS", slug: "madeira-event", scope: "scope-two", expiresAt,
    items: [{ photoId: id, variant: "original", url: originalUrl, expiresAt, version: objectVersion }],
  });
  assert.equal(await sw.fetch("tab-a", originalUrl), undefined);
  assert.equal(await sw.cacheCount(), 1);
  const stats = await sw.stats("tab-a");
  assert.equal(stats.cacheHits, 1);
  assert.equal(stats.cacheMisses, 2);
  await sw.message("tab-a", { type: "CLEAR_ALL" });
  assert.equal(await sw.cacheCount(), 0);
});

test("retained bytes survive URL expiry but require a fresh current manifest grant", async () => {
  const sw = serviceWorkerHarness();
  const id = "00000000-0000-4000-8000-000000000004";
  const start = Date.now();
  const firstExpiry = start + 60_000;
  const firstUrl = signed(id, "thumbnail", firstExpiry);
  const manifest = (url: string, expiry: number): MediaManifest => ({
    scope: "same-scope",
    expiresAt: expiry,
    items: [{ photoId: id, variant: "thumbnail", url, expiresAt: expiry, version: objectVersion }],
  });
  await sw.message("tab-return", { type: "GRANTS", slug: "madeira-event", ...manifest(firstUrl, firstExpiry) });
  await sw.fetch("tab-return", firstUrl);
  await sw.drain();
  sw.setNow(start + 2 * 60_000);
  const freshExpiry = start + 3 * 60_000;
  const freshUrl = signed(id, "thumbnail", freshExpiry);
  await sw.message("tab-return", { type: "GRANTS", slug: "madeira-event", ...manifest(freshUrl, freshExpiry) });
  assert.equal(await (await sw.fetch("tab-return", freshUrl))?.text(), "jpeg bytes");
  assert.equal(sw.networkReads, 1);
  assert.equal((await sw.stats("tab-return")).cacheHits, 1);
});

test("service worker asks the current page to restore grants after restart, then caches later requests", async () => {
  const sw = serviceWorkerHarness();
  const id = "00000000-0000-4000-8000-000000000021";
  const expiresAt = Date.now() + 120_000;
  const url = signed(id, "thumbnail", expiresAt);

  // A restarted worker has no in-memory manifest. Its first request follows
  // the browser's normal network path while the page is asked to replay grants.
  assert.equal(await sw.fetch("tab-restarted", url), undefined);
  await sw.drain();
  assert.equal(sw.clientMessages.length, 1);
  assert.equal(sw.clientMessages[0].clientId, "tab-restarted");
  assert.equal((sw.clientMessages[0].data as { type: string }).type, "REQUEST_GRANTS");
  assert.equal(sw.networkReads, 0);

  await sw.message("tab-restarted", {
    type: "GRANTS",
    slug: "madeira-event",
    scope: "scope-current",
    expiresAt,
    items: [{ photoId: id, variant: "thumbnail", url, expiresAt, version: objectVersion }],
  });
  assert.equal(await (await sw.fetch("tab-restarted", url))?.text(), "jpeg bytes");
  await sw.drain();
  assert.equal(sw.networkReads, 1);
  assert.equal((await sw.stats("tab-restarted")).cacheMisses, 1);
});

test("service worker prunes expired grants when a same-scope manifest arrives", async () => {
  const sw = serviceWorkerHarness();
  const start = Date.now();
  const firstId = "00000000-0000-4000-8000-000000000022";
  const liveId = "00000000-0000-4000-8000-000000000023";
  const nextId = "00000000-0000-4000-8000-000000000024";
  const firstExpiry = start + 1_000;
  const liveExpiry = start + 7_000;
  const firstUrl = signed(firstId, "thumbnail", firstExpiry);
  const liveUrl = signed(liveId, "thumbnail", liveExpiry);
  await sw.message("tab-prune", {
    type: "GRANTS", slug: "madeira-event", scope: "scope-prune", expiresAt: liveExpiry,
    items: [
      { photoId: firstId, variant: "thumbnail", url: firstUrl, expiresAt: firstExpiry, version: objectVersion },
      { photoId: liveId, variant: "thumbnail", url: liveUrl, expiresAt: liveExpiry, version: objectVersion },
    ],
  });

  sw.setNow(start + 2_000);
  const nextExpiry = start + 20_000;
  const nextUrl = signed(nextId, "thumbnail", nextExpiry);
  await sw.message("tab-prune", {
    type: "GRANTS", slug: "madeira-event", scope: "scope-prune", expiresAt: nextExpiry,
    items: [{ photoId: nextId, variant: "thumbnail", url: nextUrl, expiresAt: nextExpiry, version: objectVersion }],
  });
  assert.equal((await sw.stats("tab-prune")).activeGrants, 2);
});

test("current client grants isolate cache by scope and object version", async () => {
  const sw = serviceWorkerHarness();
  const id = "00000000-0000-4000-8000-000000000011";
  const expiry = Date.now() + 120_000;
  const urlOne = signed(id, "thumbnail", expiry);
  const urlTwo = signed(id, "thumbnail", expiry);
  const grant = (scope: string, url: string, version: string) => ({
    type: "GRANTS", slug: "madeira-event", scope, expiresAt: expiry,
    items: [{ photoId: id, variant: "thumbnail", url, expiresAt: expiry, version }],
  });
  await sw.message("client-one", grant("scope-one", urlOne, objectVersion));
  await sw.fetch("client-one", urlOne);
  await sw.drain();
  assert.equal(await sw.fetch("client-two", urlOne), undefined);

  const nextVersion = "b".repeat(64);
  await sw.message("client-one", grant("scope-one", urlTwo, nextVersion));
  await sw.fetch("client-one", urlTwo);
  await sw.drain();
  assert.equal(sw.networkReads, 2);
  assert.equal(await sw.cacheCount(), 2);
});

test("serialized writes enforce the cache cap and retry transient quota errors", async () => {
  const sw = serviceWorkerHarness({ cacheLimit: 12, networkBytes: 10 });
  const expiry = Date.now() + 120_000;
  const firstId = "00000000-0000-4000-8000-000000000012";
  const secondId = "00000000-0000-4000-8000-000000000013";
  const firstUrl = signed(firstId, "thumbnail", expiry);
  const secondUrl = signed(secondId, "thumbnail", expiry);
  await sw.message("tab-cap", {
    type: "GRANTS", slug: "madeira-event", scope: "scope-cap", expiresAt: expiry,
    items: [firstId, secondId].map((photoId, index) => ({
      photoId,
      variant: "thumbnail",
      url: index === 0 ? firstUrl : secondUrl,
      expiresAt: expiry,
      version: objectVersion,
    })),
  });
  sw.failNextCachePutWithQuota();
  await Promise.all([sw.fetch("tab-cap", firstUrl), sw.fetch("tab-cap", secondUrl)]);
  await sw.drain();
  assert.equal(sw.networkReads, 2);
  assert.equal(await sw.cacheCount(), 1);
  assert.equal((await sw.stats("tab-cap")).quotaErrors, 1);
});

test("cache storage failures leave signed image requests working from R2", async () => {
  const sw = serviceWorkerHarness();
  const id = "00000000-0000-4000-8000-000000000002";
  const expiresAt = Date.now() + 120_000;
  const url = signed(id, "preview", expiresAt);
  await sw.message("tab-storage-error", {
    type: "GRANTS", slug: "madeira-event", scope: "scope-one", expiresAt,
    items: [{ photoId: id, variant: "preview", url, expiresAt, version: objectVersion }],
  });
  sw.failNextCacheOpen();
  const response = await sw.fetch("tab-storage-error", url);
  assert.equal(await response?.text(), "jpeg bytes");
  await sw.drain();
  assert.equal(sw.networkReads, 1);
  assert.equal(await sw.cacheCount(), 0);
});

test("logout racing an in-flight image fetch cannot repopulate the cleared private cache", async () => {
  const sw = serviceWorkerHarness();
  const id = "00000000-0000-4000-8000-000000000003";
  const expiresAt = Date.now() + 120_000;
  const url = signed(id, "thumbnail", expiresAt);
  await sw.message("tab-logout-race", {
    type: "GRANTS", slug: "private-event", scope: "private-scope", expiresAt,
    items: [{ photoId: id, variant: "thumbnail", url, expiresAt, version: objectVersion }],
  });
  const release = sw.holdNextNetworkResponse();
  const responsePromise = sw.fetch("tab-logout-race", url);
  for (let attempt = 0; attempt < 20 && sw.networkReads === 0; attempt++)
    await Promise.resolve();
  assert.equal(sw.networkReads, 1);
  await sw.message("tab-logout-race", { type: "CLEAR_ALL" });
  release(new Response(new Blob(["jpeg bytes"]), {
    status: 200,
    headers: { "content-type": "image/jpeg", "cache-control": "no-store" },
  }));
  assert.equal(await (await responsePromise)?.text(), "jpeg bytes");
  await sw.drain();
  assert.equal(await sw.cacheCount(), 0);
});

test("cold image response streams before its body and cache write finish", async () => {
  const sw = serviceWorkerHarness();
  const id = "00000000-0000-4000-8000-000000000014";
  const expiresAt = Date.now() + 120_000;
  const url = signed(id, "thumbnail", expiresAt);
  await sw.message("tab-stream", {
    type: "GRANTS", slug: "madeira-event", scope: "scope-stream", expiresAt,
    items: [{ photoId: id, variant: "thumbnail", url, expiresAt, version: objectVersion }],
  });

  let releaseBody!: () => void;
  const bodyGate = new Promise<void>((resolve) => { releaseBody = resolve; });
  const releaseWrite = sw.holdNextCacheWrite();
  // Hold the response body open after the first chunk. The cloned cache read
  // must not prevent the page from receiving that first chunk.
  const release = sw.holdNextNetworkResponse();
  const responsePromise = sw.fetch("tab-stream", url);
  for (let attempt = 0; attempt < 20 && sw.networkReads === 0; attempt++)
    await Promise.resolve();
  release(new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new Uint8Array([255, 216, 255]));
      await bodyGate;
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "image/jpeg" } }));
  const response = await responsePromise;
  assert.ok(response);
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).value?.byteLength, 3);
  assert.equal(sw.cacheWrites, 0);

  // Let the full response body reach the cache path, then block persistence.
  releaseBody();
  assert.equal((await reader.read()).value?.byteLength, 3);
  for (let attempt = 0; attempt < 20 && sw.cacheWrites === 0; attempt++)
    await Promise.resolve();
  assert.equal(sw.cacheWrites, 1);
  releaseWrite();
  await sw.drain();
  assert.equal(await sw.cacheCount(), 1);
});

test("logout during a background cache write removes the late entry", async () => {
  const sw = serviceWorkerHarness();
  const id = "00000000-0000-4000-8000-000000000015";
  const expiresAt = Date.now() + 120_000;
  const url = signed(id, "thumbnail", expiresAt);
  await sw.message("tab-logout-write", {
    type: "GRANTS", slug: "private-event", scope: "private-scope", expiresAt,
    items: [{ photoId: id, variant: "thumbnail", url, expiresAt, version: objectVersion }],
  });
  const releaseWrite = sw.holdNextCacheWrite();
  const response = await sw.fetch("tab-logout-write", url);
  assert.equal(await response?.text(), "jpeg bytes");
  for (let attempt = 0; attempt < 20 && sw.cacheWrites === 0; attempt++)
    await Promise.resolve();
  assert.equal(sw.cacheWrites, 1);

  // clearAll revokes the manifest immediately; its storage deletion can wait
  // behind the serialized cache write without extending the image response.
  const logout = sw.message("tab-logout-write", { type: "CLEAR_ALL" });
  releaseWrite();
  await Promise.all([sw.drain(), logout]);
  assert.equal(await sw.cacheCount(), 0);
});
