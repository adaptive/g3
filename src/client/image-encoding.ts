import {
  IMAGE_PREVIEW_EDGE,
  IMAGE_PREVIEW_JPEG_QUALITY,
  IMAGE_THUMBNAIL_EDGE,
  IMAGE_THUMBNAIL_JPEG_QUALITY,
  IMAGE_THUMBNAIL_WEBP_QUALITY,
  IMAGE_THUMBNAIL_AVIF_QUALITY,
} from "./image-settings";

type EncodingCanvas = OffscreenCanvas | HTMLCanvasElement;
type CanvasFactory = (width: number, height: number) => EncodingCanvas;
type ThumbnailType = "image/avif" | "image/webp" | "image/jpeg";

const thumbnailFormats: ReadonlyArray<{ type: ThumbnailType; quality: number }> = [
  { type: "image/avif", quality: IMAGE_THUMBNAIL_AVIF_QUALITY },
  { type: "image/webp", quality: IMAGE_THUMBNAIL_WEBP_QUALITY },
  { type: "image/jpeg", quality: IMAGE_THUMBNAIL_JPEG_QUALITY },
];

function createCanvas(width: number, height: number): EncodingCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasBlob(canvas: EncodingCanvas, type: string, quality: number): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("Could not encode the photo.")),
    type,
    quality,
  ));
}

/** Shared by the worker and window fallback; capability probes live for one queue. */
export function createPhotoVariantEncoder(factory: CanvasFactory = createCanvas) {
  const supported = new Map<ThumbnailType, boolean>();

  const supports = async (type: ThumbnailType) => {
    if (supported.has(type)) return supported.get(type)!;
    const probe = factory(1, 1);
    try {
      if (!probe.getContext("2d", { alpha: false })) return false;
      // Unsupported canvas types silently return PNG. Never relabel those bytes.
      const blob = await canvasBlob(probe, type, 0.5);
      const available = blob.type === type && blob.size > 0;
      supported.set(type, available);
      return available;
    } catch {
      supported.set(type, false);
      return false;
    } finally {
      probe.width = 1;
      probe.height = 1;
    }
  };

  return {
    async encode(bitmap: ImageBitmap, variant: "preview" | "thumbnail"): Promise<Blob> {
      const edge = variant === "preview" ? IMAGE_PREVIEW_EDGE : IMAGE_THUMBNAIL_EDGE;
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = factory(width, height);
      try {
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("This browser cannot prepare photo previews.");
        context.drawImage(bitmap, 0, 0, width, height);
        if (variant === "preview") {
          const blob = await canvasBlob(canvas, "image/jpeg", IMAGE_PREVIEW_JPEG_QUALITY);
          if (blob.type !== "image/jpeg" || !blob.size)
            throw new Error("This browser could not encode the photo preview as JPEG.");
          return blob;
        }
        for (const { type, quality } of thumbnailFormats) {
          if (!(await supports(type))) continue;
          try {
            const blob = await canvasBlob(canvas, type, quality);
            if (blob.type === type && blob.size > 0) return blob;
          } catch {
            // A supported encoder can still fail for an individual image.
          }
          supported.set(type, false);
        }
        throw new Error("This browser could not encode the photo thumbnail.");
      } finally {
        // Release the backing surface promptly, including in the window fallback.
        canvas.width = 1;
        canvas.height = 1;
      }
    },
  };
}
