import { describe, expect, test } from "bun:test";
import {
  decodeViewerImage,
  viewerNextAction,
  ViewerImageCache,
} from "../src/client/viewer-image";

class FakeImage {
  src = "";
  crossOrigin: string | null = null;
  decoding: HTMLImageElement["decoding"] = "auto";
  decode: () => Promise<void> = () => Promise.resolve();
}

const photo = (id: string) => ({ id });
const media = (options: { fail?: Set<string> } = {}) => ({
  resolve: async (id: string, _variant: "preview", force?: boolean) => {
    const url = `https://media.example/${id}${force ? "?refresh" : ""}`;
    if (options.fail?.has(url)) throw new Error("refresh failed");
    return url;
  },
  proxyUrl: (id: string, _variant: "preview") => `/proxy/${id}`,
});

describe("viewer image preparation", () => {
  test("waits for decode before making a source ready", async () => {
    const image = new FakeImage();
    let finish!: () => void;
    image.decode = () => new Promise<void>((resolve) => { finish = resolve; });
    const pending = decodeViewerImage(media(), photo("one"), () => image);
    await Promise.resolve();
    let complete = false;
    void pending.then(() => { complete = true; });
    await Promise.resolve();
    expect(complete).toBe(false);
    expect(image.crossOrigin).toBe("anonymous");
    expect(image.decoding).toBe("async");
    finish();
    expect((await pending).url).toBe("https://media.example/one");
  });

  test("retries an expired signed URL and then uses the authorized proxy", async () => {
    const imageFactory = () => {
      const image = new FakeImage();
      image.decode = () => image.src.startsWith("https://")
        ? Promise.reject(new Error("expired"))
        : Promise.resolve();
      return image;
    };
    const result = await decodeViewerImage(media(), photo("one"), imageFactory);
    expect(result.url).toBe("/proxy/one");
  });

  test("keeps only the current and adjacent decoded image", async () => {
    const created: FakeImage[] = [];
    const cache = new ViewerImageCache(media(), () => {
      const image = new FakeImage();
      created.push(image);
      return image;
    });
    await cache.prepare(photo("one"));
    await cache.prepare(photo("two"));
    cache.retain(["two", "three"]);
    await Promise.resolve();
    expect(created[0]?.src).toBe("");
    await cache.prepare(photo("three"));
    expect(created).toHaveLength(3);
    cache.dispose();
    await Promise.resolve();
    expect(created.every((image) => image.src === "")).toBe(true);
  });

  test("removes a failed decode so retry starts a fresh request", async () => {
    let decodeAttempts = 0;
    let refreshes = 0;
    const retryMedia = {
      resolve: async (_id: string, _variant: "preview", force?: boolean) => {
        if (force) {
          refreshes++;
          throw new Error("refresh unavailable");
        }
        return "https://media.example/retry";
      },
      proxyUrl: (id: string, _variant: "preview") => `/proxy/${id}`,
    };
    const cache = new ViewerImageCache(retryMedia, () => {
      const image = new FakeImage();
      image.decode = () => {
        decodeAttempts++;
        if (decodeAttempts <= 2) {
          return Promise.reject(new Error("offline"));
        }
        return Promise.resolve();
      };
      return image;
    });

    await expect(cache.prepare(photo("retry"))).rejects.toThrow();
    expect((await cache.prepare(photo("retry"))).url).toBe("https://media.example/retry");
    expect(refreshes).toBe(1);
    cache.dispose();
  });

  test("limits concurrent decode work while rapid requests replace the window", async () => {
    const created: FakeImage[] = [];
    let active = 0;
    let maximum = 0;
    const cache = new ViewerImageCache(media(), () => {
      const image = new FakeImage();
      image.decode = () => new Promise<void>((resolve) => {
        active++;
        maximum = Math.max(maximum, active);
        setTimeout(() => { active--; resolve(); }, 10);
      });
      created.push(image);
      return image;
    });
    const requests = ["a", "b", "c", "d", "e"].map((id) => cache.prepare(photo(id)).catch(() => null));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(created).toHaveLength(2);
    cache.retain(["d", "e"]);
    await Promise.all(requests);
    await Bun.sleep(30);
    expect(created.length).toBe(4);
    expect(maximum).toBeLessThanOrEqual(2);
    expect(created.slice(0, 2).every((image) => image.src === "")).toBe(true);
    cache.dispose();
  });

  test("does not create an image when a cancelled media grant arrives late", async () => {
    let finish!: (url: string) => void;
    const delayedMedia = {
      resolve: async () => new Promise<string>((resolve) => { finish = resolve; }),
      proxyUrl: (id: string, _variant: "preview") => `/proxy/${id}`,
    };
    let created = 0;
    const cache = new ViewerImageCache(delayedMedia, () => { created++; return new FakeImage(); });
    const request = cache.prepare(photo("late")).catch(() => null);
    cache.retain([]);
    finish("https://media.example/late");
    await request;
    await Promise.resolve();
    expect(created).toBe(0);
    cache.dispose();
  });
});

describe("viewer pagination", () => {
  test("advances within a loaded page", () => {
    expect(viewerNextAction({ index: 3, loaded: 20, total: 40, hasMore: true }))
      .toEqual({ kind: "advance", index: 4 });
  });

  test("requests the next page at its boundary", () => {
    expect(viewerNextAction({ index: 19, loaded: 20, total: 40, hasMore: true }))
      .toEqual({ kind: "load", index: 20 });
  });

  test("stops at the actual total", () => {
    expect(viewerNextAction({ index: 39, loaded: 40, total: 40, hasMore: false }))
      .toEqual({ kind: "end" });
  });
});
