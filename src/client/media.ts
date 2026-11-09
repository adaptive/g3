import type { Variant } from "../shared/types";
import { galleryApiPath, mediaUrl as proxyMediaUrl } from "../shared/types";

export interface MediaGrant {
  photoId: string;
  variant: Variant;
  url: string;
  expiresAt: number;
  version: string;
}

export interface MediaManifest {
  scope: string;
  expiresAt: number;
  items: MediaGrant[];
}

export interface MediaStats {
  mode: "signed" | "proxy" | "unknown";
  grants: number;
  signedUrlRefreshes: number;
  refreshFailures: number;
  proxyFallbacks: number;
  serviceWorker: {
    available: boolean;
    controlled: boolean;
    cacheHits: number;
    cacheMisses: number;
    bytesStored: number;
    bytesServed: number;
    quotaErrors: number;
    entries: number;
    activeGrants: number;
  };
}

const KEY_SEPARATOR = "/";
const usableUntil = (grant: MediaGrant | undefined) =>
  grant && grant.expiresAt - 15_000 > Date.now();
const mediaKey = (photoId: string, variant: Variant) => `${photoId}${KEY_SEPARATOR}${variant}`;
const parseKey = (key: string) => {
  const separator = key.lastIndexOf(KEY_SEPARATOR);
  return {
    photoId: key.slice(0, separator),
    variant: key.slice(separator + 1) as Variant,
  };
};
const validVariant = (value: string): value is Variant =>
  value === "original" || value === "preview" || value === "thumbnail";

export class GalleryMediaClient {
  readonly slug: string;
  private readonly fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly grants = new Map<string, MediaGrant>();
  private readonly waiters = new Map<string, Array<(url: string) => void>>();
  private refreshQueued = false;
  private epoch = 0;
  private scope: string | null = null;
  private expiry = 0;
  private mode: MediaStats["mode"] = "unknown";
  private disposed = false;
  private readonly values = {
    signedUrlRefreshes: 0,
    refreshFailures: 0,
    proxyFallbacks: 0,
  };
  private readonly onControllerChange = () => this.sendGrants();
  private readonly onPageshow = () => this.sendGrants();
  private readonly onVisibilityChange = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible")
      this.sendGrants();
  };
  private readonly onServiceWorkerMessage = (event: MessageEvent) => {
    if (
      event.data?.type !== "REQUEST_GRANTS" ||
      typeof navigator === "undefined" ||
      !("serviceWorker" in navigator) ||
      event.source !== navigator.serviceWorker.controller
    ) return;
    this.sendGrants();
  };

  constructor(slug: string, fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch) {
    this.slug = slug;
    this.fetcher = fetcher;
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", this.onControllerChange);
      navigator.serviceWorker.addEventListener("message", this.onServiceWorkerMessage);
    }
    if (typeof window !== "undefined") window.addEventListener("pageshow", this.onPageshow);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  /** Attach grants returned with the authorized gallery response. */
  setManifest(manifest: MediaManifest | null | undefined) {
    if (this.disposed) return;
    if (
      !manifest ||
      typeof manifest.scope !== "string" ||
      !manifest.scope ||
      !Number.isFinite(manifest.expiresAt) ||
      manifest.expiresAt <= Date.now() ||
      manifest.expiresAt > Date.now() + 10 * 60 * 1000 + 5_000 ||
      !Array.isArray(manifest.items)
    ) {
      this.switchToProxy();
      return;
    }
    if (this.scope !== manifest.scope) {
      this.epoch++;
      this.clearCache(this.scope);
      this.grants.clear();
      this.scope = manifest.scope;
    }
    this.mode = "signed";
    this.expiry = manifest.expiresAt;
    this.pruneExpiredGrants();
    for (const item of manifest.items) {
      if (!this.isValidGrant(item, manifest.scope, manifest.expiresAt)) continue;
      this.grants.set(mediaKey(item.photoId, item.variant), item);
    }
    this.sendGrants();
  }

  /** Resolve a signed URL, issuing one batch request for all current waiters. */
  resolve(photoId: string, variant: Variant, forceRefresh = false): Promise<string> {
    if (this.disposed || this.mode === "proxy" || this.mode === "unknown")
      return Promise.resolve(this.proxyUrl(photoId, variant));
    const key = mediaKey(photoId, variant);
    const grant = this.grants.get(key);
    if (forceRefresh && grant) {
      this.grants.delete(key);
      this.revokeGrant(grant.url);
    }
    if (!forceRefresh && usableUntil(grant)) return Promise.resolve(grant!.url);
    if (!this.scope) return Promise.resolve(this.proxyUrl(photoId, variant));
    const promise = new Promise<string>((resolve) => {
      const queue = this.waiters.get(key) ?? [];
      queue.push(resolve);
      this.waiters.set(key, queue);
    });
    this.queueRefresh();
    return promise;
  }

  /** Return a stable same-origin proxy fallback for a failed cross-origin image. */
  proxyUrl(photoId: string, variant: Variant): string {
    return proxyMediaUrl(photoId, variant, this.slug);
  }

  noteProxyFallback() {
    this.values.proxyFallbacks += 1;
  }

  /** Expire grants and revoke this gallery's persistent image cache on logout. */
  clear() {
    this.epoch++;
    const oldScope = this.scope;
    this.scope = null;
    this.expiry = 0;
    this.mode = "unknown";
    this.grants.clear();
    this.waiters.forEach((queue, key) => {
      const { photoId, variant } = parseKey(key);
      queue.forEach((resolve) => resolve(this.proxyUrl(photoId, variant)));
    });
    this.waiters.clear();
    this.clearCache(oldScope);
  }

  clearAll() {
    this.clear();
    clearBrowserMediaCaches();
  }

  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.removeEventListener("controllerchange", this.onControllerChange);
      navigator.serviceWorker.removeEventListener("message", this.onServiceWorkerMessage);
    }
    if (typeof window !== "undefined") window.removeEventListener("pageshow", this.onPageshow);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  async stats(): Promise<MediaStats> {
    const controller =
      typeof navigator !== "undefined" && "serviceWorker" in navigator
        ? navigator.serviceWorker.controller
        : null;
    const sw = {
      available: typeof navigator !== "undefined" && "serviceWorker" in navigator,
      controlled: Boolean(controller),
      cacheHits: 0,
      cacheMisses: 0,
      bytesStored: 0,
      bytesServed: 0,
      quotaErrors: 0,
      entries: 0,
      activeGrants: 0,
    };
    if (controller && typeof MessageChannel !== "undefined") {
      try {
        Object.assign(sw, await this.messageWorker(controller, { type: "STATS" }));
      } catch {
        /* Diagnostic counts are best-effort. */
      }
    }
    return {
      mode: this.mode,
      grants: this.grants.size,
      ...this.values,
      serviceWorker: sw,
    };
  }

  private isValidGrant(grant: MediaGrant, scope: string, manifestExpiry: number) {
    if (
      !grant ||
      typeof grant.photoId !== "string" ||
      !validVariant(grant.variant) ||
      typeof grant.url !== "string" ||
      !/^https:\/\//i.test(grant.url) ||
      typeof grant.version !== "string" ||
      !Number.isFinite(grant.expiresAt) ||
      grant.expiresAt <= Date.now() ||
      grant.expiresAt > manifestExpiry ||
      !scope
    ) return false;

    try {
      const url = new URL(grant.url);
      return url.protocol === "https:" && url.hostname.endsWith(".r2.cloudflarestorage.com");
    } catch {
      // Treat malformed API data as an unusable grant. The gallery can still
      // use its same-origin media proxy instead of failing to render.
      return false;
    }
  }

  private switchToProxy() {
    this.epoch++;
    const oldScope = this.scope;
    this.scope = null;
    this.expiry = 0;
    this.mode = "proxy";
    this.grants.clear();
    this.clearCache(oldScope);
    for (const [key, queue] of this.waiters) {
      const { photoId, variant } = parseKey(key);
      queue.forEach((resolve) => resolve(this.proxyUrl(photoId, variant)));
    }
    this.waiters.clear();
  }

  private queueRefresh() {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(async () => {
      const keys = [...this.waiters.keys()];
      const ok = await this.refreshManifest(
        keys.slice(0, 48).map((key) => {
          const { photoId, variant } = parseKey(key);
          return { id: photoId, variant };
        }),
      );
      const batch = keys.slice(0, 48);
      for (const key of batch) {
        const { photoId, variant } = parseKey(key);
        const url = ok
          ? this.grants.get(key)?.url ?? this.proxyUrl(photoId, variant)
          : this.proxyUrl(photoId, variant);
        this.waiters.get(key)?.forEach((resolve) => resolve(url));
        this.waiters.delete(key);
      }
      this.refreshQueued = false;
      if (this.waiters.size) this.queueRefresh();
    });
  }

  private async refreshManifest(photos: Array<{ id: string; variant: Variant }>) {
    if (this.mode === "proxy") return false;
    const requestEpoch = this.epoch;
    try {
      const response = await this.fetcher(
        galleryApiPath(this.slug, "/api/media"),
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ photos }),
        },
      );
      if (this.disposed || this.epoch !== requestEpoch) return false;
      if (response.status === 401 || response.status === 403) {
        this.clear();
        return false;
      }
      if (!response.ok) throw new Error(`Media URL request failed (${response.status}).`);
      const manifest = (await response.json()) as MediaManifest | null;
      if (this.disposed || this.epoch !== requestEpoch) return false;
      if (!manifest) {
        this.switchToProxy();
        return false;
      }
      this.values.signedUrlRefreshes += 1;
      this.setManifest(manifest);
      return this.mode === "signed";
    } catch {
      this.values.refreshFailures += 1;
      return false;
    }
  }

  private sendGrants() {
    this.pruneExpiredGrants();
    if (!this.scope || this.expiry <= Date.now() || this.mode !== "signed" || typeof navigator === "undefined" || !("serviceWorker" in navigator))
      return;
    const controller = navigator.serviceWorker.controller;
    if (!controller) return;
    controller.postMessage({
      type: "GRANTS",
      slug: this.slug,
      scope: this.scope,
      expiresAt: this.expiry,
      items: [...this.grants.values()],
    });
  }

  private pruneExpiredGrants() {
    const now = Date.now();
    for (const [key, grant] of this.grants)
      if (grant.expiresAt <= now) this.grants.delete(key);
  }

  private clearCache(scope: string | null) {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.controller?.postMessage({
      type: "CLEAR",
      slug: this.slug,
      scope,
    });
  }

  private revokeGrant(url: string) {
    if (!this.scope || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.controller?.postMessage({
      type: "REVOKE_URL",
      slug: this.slug,
      scope: this.scope,
      url,
    });
  }

  private messageWorker(controller: ServiceWorker, message: object) {
    return new Promise<Record<string, number>>((resolve, reject) => {
      const channel = new MessageChannel();
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        channel.port1.onmessage = null;
        channel.port1.close();
        channel.port2.close();
        complete();
      };
      const timeout = setTimeout(() => finish(() => reject(new Error("Service worker did not reply."))), 500);
      channel.port1.onmessage = (event) => {
        finish(() => resolve(event.data ?? {}));
      };
      try {
        controller.postMessage(message, [channel.port2]);
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }
}

/** Logout helper for the gallery manager, which is outside any one gallery. */
export function clearBrowserMediaCaches() {
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator)
    navigator.serviceWorker.controller?.postMessage({ type: "CLEAR_ALL" });
}

declare global {
  interface Window {
    __adaptiveGalleryMediaStats?: () => Promise<MediaStats>;
  }
}

export function installMediaDiagnostics(client: GalleryMediaClient) {
  if (typeof window === "undefined") return () => {};
  window.__adaptiveGalleryMediaStats = () => client.stats();
  return () => {
    if (window.__adaptiveGalleryMediaStats) delete window.__adaptiveGalleryMediaStats;
  };
}

