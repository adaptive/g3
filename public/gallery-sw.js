/*
 * Small, explicit image cache for signed R2 media. Cache Storage ignores
 * Cache-Control, so every entry carries its own expiry and size metadata.
 * Grant URLs live only in worker memory, scoped to the client that received
 * the authorized page manifest. After a worker restart, the first image request
 * may bypass this cache while the page restores its current unexpired grants.
 * Originals are always fetched uncached.
 */
const CACHE_NAME = "adaptive-gallery-media-v1";
const CACHE_ORIGIN = "https://media-cache.adaptive-gallery.invalid";
const CACHE_LIMIT = 100 * 1024 * 1024;
const RETAIN_BYTES_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LEASE = 10 * 60 * 1000;
const GRANT_RESTORE_COOLDOWN = 1_000;
const manifests = new Map();
const counters = new Map();
const clientEpochs = new Map();
const restoreRequests = new Map();
let sizeIndex = null;
let indexedBytes = 0;
let mutationQueue = Promise.resolve();
function serializeMutation(operation) {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.catch(() => {});
  return result;
}
const nextEpoch = (clientId) => {
  const value = (clientEpochs.get(clientId) || 0) + 1;
  clientEpochs.set(clientId, value);
  return value;
};

const counter = (clientId) => {
  if (!counters.has(clientId)) {
    counters.set(clientId, {
      cacheHits: 0,
      cacheMisses: 0,
      bytesStored: 0,
      bytesServed: 0,
      quotaErrors: 0,
      entries: 0,
    });
  }
  return counters.get(clientId);
};

const grantKey = (photoId, variant) => `${photoId}/${variant}`;
const cacheUrl = (slug, scope, grant) =>
  `${CACHE_ORIGIN}/${encodeURIComponent(slug)}/${encodeURIComponent(scope)}/${encodeURIComponent(grant.photoId)}/${grant.variant}/${encodeURIComponent(grant.version)}`;

function validGrant(item, origin, expiresAt) {
  if (!item || typeof item.photoId !== "string" || typeof item.version !== "string") return false;
  if (!/^[a-f0-9-]{36}$/i.test(item.photoId) || !/^[a-f0-9]{64}$/i.test(item.version)) return false;
  if (!["thumbnail", "preview", "original"].includes(item.variant)) return false;
  if (item.variant === "original") return true;
  if (!Number.isFinite(item.expiresAt) || item.expiresAt <= Date.now() || item.expiresAt > expiresAt) return false;
  try {
    const url = new URL(item.url);
    return url.protocol === "https:" && url.origin !== origin && url.hostname.endsWith(".r2.cloudflarestorage.com");
  } catch {
    return false;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("adaptive-gallery-media-") && name !== CACHE_NAME).map((name) => caches.delete(name)));
    sizeIndex = null;
    await sweepExpired();
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const source = event.source;
  const clientId = source && "id" in source ? source.id : "";
  if (!clientId) return;
  const message = event.data || {};
  if (message.type === "GRANTS") {
    const origin = self.location.origin;
    if (typeof message.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(message.slug)) return;
    if (typeof message.scope !== "string" || message.scope.length > 180) return;
    if (!Number.isFinite(message.expiresAt) || message.expiresAt <= Date.now() || message.expiresAt > Date.now() + MAX_LEASE + 5_000) return;
    const prior = manifests.get(clientId);
    const sameScope = prior && prior.scope === message.scope && prior.slug === message.slug;
    if (!sameScope) {
      nextEpoch(clientId);
      if (prior) event.waitUntil(clearClientCache(prior.slug, prior.scope));
    }
    const grants = sameScope ? prior.grants : new Map();
    for (const [url, grant] of grants) {
      if (grant.expiresAt <= Date.now() || grant.manifestExpiresAt <= Date.now())
        grants.delete(url);
    }
    for (const item of message.items || []) {
      if (!validGrant(item, origin, message.expiresAt)) continue;
      grants.set(item.url, {
        ...item,
        scope: message.scope,
        slug: message.slug,
        manifestExpiresAt: message.expiresAt,
      });
    }
    manifests.set(clientId, {
      slug: message.slug,
      scope: message.scope,
      expiresAt: message.expiresAt,
      grants,
    });
    restoreRequests.delete(clientId);
    return;
  }
  if (message.type === "CLEAR") {
    restoreRequests.delete(clientId);
    event.waitUntil(clearClient(clientId, message.slug, message.scope));
    return;
  }
  if (message.type === "REVOKE_URL") {
    const current = manifests.get(clientId);
    if (current && current.slug === message.slug && current.scope === message.scope)
      current.grants.delete(message.url);
    return;
  }
  if (message.type === "CLEAR_ALL") {
    for (const affectedClient of new Set([...clientEpochs.keys(), ...manifests.keys()])) nextEpoch(affectedClient);
    manifests.clear();
    counters.clear();
    restoreRequests.clear();
    event.waitUntil(serializeMutation(async () => {
      await caches.delete(CACHE_NAME);
      sizeIndex = new Map();
      indexedBytes = 0;
    }));
    return;
  }
  if (message.type === "STATS" && event.ports?.[0]) {
    event.waitUntil((async () => {
      const stats = {
        ...counter(clientId),
        activeGrants: manifests.get(clientId)?.grants.size || 0,
      };
      const cache = await caches.open(CACHE_NAME);
      const keys = await cache.keys();
      let entries = 0;
      for (const key of keys) if (await cache.match(key)) entries++;
      stats.entries = entries;
      event.ports[0].postMessage(stats);
    })());
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const clientId = event.clientId;
  const manifest = manifests.get(clientId);
  if (!manifest || manifest.expiresAt <= Date.now()) {
    if (manifest) {
      manifests.delete(clientId);
      restoreRequests.delete(clientId);
    }
    const restore = requestGrantRestore(clientId, request);
    if (restore) event.waitUntil(restore);
    return;
  }
  const grant = manifest.grants.get(request.url);
  if (!grant || grant.manifestExpiresAt <= Date.now() || grant.expiresAt <= Date.now()) return;
  if (grant.variant === "original") return;
  // Register the lifetime promise synchronously, while the fetch event is
  // still dispatching. A successful image response need not wait for its
  // optional cache copy, but the worker can finish that copy in the background.
  let finishLifetime;
  const lifetime = new Promise((resolve) => { finishLifetime = resolve; });
  event.waitUntil(lifetime);
  event.respondWith(
    serveImage(request, clientId, grant, clientEpochs.get(clientId) || 0, finishLifetime),
  );
});

function requestGrantRestore(clientId, request) {
  if (!clientId || !isDirectVariantRequest(request)) return null;
  const lastRequest = restoreRequests.get(clientId);
  if (lastRequest !== undefined && Date.now() - lastRequest < GRANT_RESTORE_COOLDOWN) return null;
  restoreRequests.set(clientId, Date.now());
  return self.clients.get(clientId).then((client) => {
    client?.postMessage({ type: "REQUEST_GRANTS" });
  }).catch(() => {
    // The page may have closed; the request itself still follows the network path.
  });
}

function isDirectVariantRequest(request) {
  if (request.method !== "GET") return false;
  try {
    const url = new URL(request.url);
    return url.protocol === "https:" &&
      url.hostname.endsWith(".r2.cloudflarestorage.com") &&
      /\/(?:thumbnail|preview)(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

async function serveImage(request, clientId, grant, epoch, finishLifetime) {
  let cacheWorkScheduled = false;
  try {
    let cache;
    let key;
    try {
      cache = await caches.open(CACHE_NAME);
      key = new Request(cacheUrl(grant.slug, grant.scope, grant));
    } catch {
      return fetch(request);
    }
    const state = counter(clientId);
    let cached;
    try {
      cached = await cache.match(key);
    } catch {
      return fetch(request);
    }
    if (cached) {
      if (!grantStillActive(clientId, request.url, grant, epoch)) return fetch(request);
      const retainedUntil = Number(cached.headers.get("X-AG-Retain-Until"));
      if (retainedUntil > Date.now()) {
        state.cacheHits++;
        state.bytesServed += Number(cached.headers.get("X-AG-Bytes")) || 0;
        return cached;
      }
      await cache.delete(key);
      removeIndexed(key.url);
    }

    state.cacheMisses++;
    const response = await fetch(request);
    if (!response.ok || response.type === "opaque" || response.type === "opaqueredirect") return response;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("image/")) return response;

    if (grantStillActive(clientId, request.url, grant, epoch)) {
      cacheWorkScheduled = true;
      void cacheImageResponse(cache, key, response, request, clientId, grant, epoch, state)
        .catch(() => {
          // Cache storage is an optional optimization; keep the network response successful.
        })
        .finally(finishLifetime);
    }
    return response;
  } finally {
    if (!cacheWorkScheduled) finishLifetime();
  }
}

async function cacheImageResponse(cache, key, response, request, clientId, grant, epoch, state) {
  const blob = await response.clone().blob();
  if (!blob.size || blob.size > CACHE_LIMIT) return;
  const now = Date.now();
  const headers = new Headers(response.headers);
  headers.set("X-AG-Retain-Until", String(now + RETAIN_BYTES_MS));
  headers.set("X-AG-Bytes", String(blob.size));
  headers.set("X-AG-Stored", String(now));
  const copy = new Response(blob, { status: response.status, statusText: response.statusText, headers });
  if (!grantStillActive(clientId, request.url, grant, epoch)) return;
  await serializeMutation(async () => {
      if (!grantStillActive(clientId, request.url, grant, epoch)) return false;
      await indexCache(cache);
      if (indexedBytes + blob.size > CACHE_LIMIT)
        await evictUntil(Math.max(0, CACHE_LIMIT - blob.size));
      try {
        await cache.put(key, copy.clone());
      } catch (error) {
        if (error?.name !== "QuotaExceededError") return false;
        state.quotaErrors++;
        await evictUntil(Math.max(0, CACHE_LIMIT - blob.size));
        try { await cache.put(key, copy.clone()); } catch { return false; }
      }
      const cachedCopy = await cache.match(key);
      if (!cachedCopy) return false;
      if (!grantStillActive(clientId, request.url, grant, epoch)) {
        await cache.delete(key);
        removeIndexed(key.url);
        return false;
      }
      state.bytesStored += blob.size;
      rememberIndexed(
        key.url,
        blob.size,
        Number(cachedCopy.headers.get("X-AG-Retain-Until")),
        now,
      );
      return true;
    });
}

async function evictUntil(limit) {
  const cache = await caches.open(CACHE_NAME);
  const index = await indexCache(cache);
  const entries = [...index.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);
  for (const [url] of entries) {
    if (indexedBytes <= limit) break;
    await cache.delete(new Request(url));
    removeIndexed(url);
  }
}

async function sweepExpired() {
  const cache = await caches.open(CACHE_NAME);
  for (const [url, entry] of await indexCache(cache))
    if (!entry.retainUntil || entry.retainUntil <= Date.now()) {
      await cache.delete(new Request(url));
      removeIndexed(url);
    }
  await evictUntil(CACHE_LIMIT);
}

async function clearClient(clientId, slug, scope) {
  const current = manifests.get(clientId);
  if (current && (!slug || current.slug === slug) && (!scope || current.scope === scope)) {
    nextEpoch(clientId);
    manifests.delete(clientId);
  }
  await serializeMutation(async () => {
    const cache = await caches.open(CACHE_NAME);
    const prefix = `${CACHE_ORIGIN}/${encodeURIComponent(slug || current?.slug || "")}/`;
    const scopeSegment = scope ? `${encodeURIComponent(scope)}/` : "";
    for (const key of await cache.keys()) {
      const url = key.url;
      if (url.startsWith(prefix) && (!scope || url.startsWith(`${prefix}${scopeSegment}`))) {
        await cache.delete(key);
        removeIndexed(url);
      }
    }
  });
}

async function clearClientCache(slug, scope) {
  return clearClient("", slug, scope);
}

async function indexCache(cache) {
  if (sizeIndex) return sizeIndex;
  sizeIndex = new Map();
  indexedBytes = 0;
  for (const key of await cache.keys()) {
    const response = await cache.match(key);
    if (!response) continue;
    const entry = {
      size: Number(response.headers.get("X-AG-Bytes")) || 0,
      retainUntil: Number(response.headers.get("X-AG-Retain-Until")) || 0,
      storedAt: Number(response.headers.get("X-AG-Stored")) || 0,
    };
    sizeIndex.set(key.url, entry);
    indexedBytes += entry.size;
  }
  return sizeIndex;
}

function rememberIndexed(url, size, retainUntil, storedAt) {
  if (!sizeIndex) sizeIndex = new Map();
  removeIndexed(url);
  sizeIndex.set(url, { size, retainUntil, storedAt });
  indexedBytes += size;
}

function removeIndexed(url) {
  const prior = sizeIndex?.get(url);
  if (!prior) return;
  sizeIndex.delete(url);
  indexedBytes = Math.max(0, indexedBytes - prior.size);
}

function grantStillActive(clientId, url, grant, epoch) {
  if ((clientEpochs.get(clientId) || 0) !== epoch) return false;
  const manifest = manifests.get(clientId);
  const current = manifest?.grants.get(url);
  return Boolean(
    manifest &&
      manifest.slug === grant.slug &&
      manifest.scope === grant.scope &&
      manifest.expiresAt > Date.now() &&
      current &&
      current.version === grant.version &&
      current.expiresAt > Date.now(),
  );
}
