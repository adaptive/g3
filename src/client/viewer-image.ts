import type { Photo } from "../shared/types";
import type { GalleryMediaClient } from "./media";

type ImageLike = Pick<HTMLImageElement, "src" | "crossOrigin" | "decoding" | "decode">;
export type ImageFactory = () => ImageLike;

export interface DecodedViewerImage {
  id: string;
  url: string;
  image: ImageLike;
}

/** Fetch and decode before publishing a new viewer source to the DOM. */
export async function decodeViewerImage(
  media: Pick<GalleryMediaClient, "resolve" | "proxyUrl">,
  photo: Pick<Photo, "id">,
  createImage: ImageFactory = () => new Image(),
  cancelled: () => boolean = () => false,
  onImage: (image: ImageLike) => void = () => {},
): Promise<DecodedViewerImage> {
  let url = await media.resolve(photo.id, "preview");
  const decode = async (source: string) => {
    if (cancelled()) throw new Error("Image request was cancelled.");
    const image = createImage();
    onImage(image);
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.src = source;
    await image.decode();
    if (cancelled()) {
      image.src = "";
      throw new Error("Image request was cancelled.");
    }
    return { id: photo.id, url: source, image };
  };

  try {
    return await decode(url);
  } catch {
    if (cancelled()) throw new Error("Image request was cancelled.");
    const proxy = media.proxyUrl(photo.id, "preview");
    if (url === proxy) throw new Error("Could not decode photograph.");
    try {
      url = await media.resolve(photo.id, "preview", true);
    } catch {
      url = proxy;
    }
    if (url === proxy) return decode(proxy);
    try {
      return await decode(url);
    } catch {
      return decode(proxy);
    }
  }
}

/** Decide whether a viewer's next arrow can advance or should fetch another page. */
export function viewerNextAction(input: {
  index: number;
  loaded: number;
  total: number;
  hasMore: boolean;
}): { kind: "advance"; index: number } | { kind: "load"; index: number } | { kind: "end" } {
  const next = input.index + 1;
  if (next < input.loaded) return { kind: "advance", index: next };
  if (next < input.total && input.hasMore) return { kind: "load", index: next };
  return { kind: "end" };
}

/** Keep at most the displayed image plus one adjacent decoded image. */
export class ViewerImageCache {
  private readonly entries = new Map<string, {
    promise: Promise<DecodedViewerImage>;
    resolve: (value: DecodedViewerImage) => void;
    reject: (error: unknown) => void;
    cancelled: boolean;
    image?: ImageLike;
  }>();
  private readonly queue: Array<{ id: string; photo: Pick<Photo, "id"> }> = [];
  private active = 0;
  private readonly maxActive = 2;
  private disposed = false;

  constructor(
    private readonly media: Pick<GalleryMediaClient, "resolve" | "proxyUrl">,
    private readonly createImage: ImageFactory = () => new Image(),
  ) {}

  prepare(photo: Pick<Photo, "id">): Promise<DecodedViewerImage> {
    if (this.disposed) return Promise.reject(new Error("Image cache is closed."));
    const existing = this.entries.get(photo.id);
    if (existing) return existing.promise;
    let resolve!: (value: DecodedViewerImage) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<DecodedViewerImage>((yes, no) => { resolve = yes; reject = no; });
    this.entries.set(photo.id, { promise, resolve, reject, cancelled: false });
    this.queue.push({ id: photo.id, photo });
    this.pump();
    return promise;
  }

  retain(photoIds: readonly string[]) {
    const keep = new Set(photoIds);
    for (const [id, entry] of this.entries) {
      if (keep.has(id)) continue;
      this.entries.delete(id);
      entry.cancelled = true;
      if (entry.image) entry.image.src = "";
      entry.reject(new Error("Image request was cancelled."));
    }
    for (let index = this.queue.length - 1; index >= 0; index--)
      if (!this.entries.has(this.queue[index]!.id)) this.queue.splice(index, 1);
    this.pump();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.retain([]);
  }

  private pump() {
    while (!this.disposed && this.active < this.maxActive && this.queue.length) {
      const task = this.queue.shift()!;
      const entry = this.entries.get(task.id);
      if (!entry || entry.cancelled) continue;
      this.active++;
      let completed = false;
      void decodeViewerImage(
        this.media,
        task.photo,
        this.createImage,
        () => entry.cancelled || this.disposed,
        (image) => { entry.image = image; },
      ).then(
        (image) => { completed = true; entry.resolve(image); },
        (error) => entry.reject(error),
      ).finally(() => {
        this.active--;
        if (this.entries.get(task.id) === entry && (!completed || entry.cancelled))
          this.entries.delete(task.id);
        this.pump();
      });
    }
  }
}
