import { MAX_FILE_BYTES, MAX_PIXELS, type UploadInput } from "../shared/types";
import {
  IMAGE_PREVIEW_EDGE,
  IMAGE_PREVIEW_JPEG_QUALITY,
  IMAGE_THUMBNAIL_EDGE,
  IMAGE_THUMBNAIL_JPEG_QUALITY,
} from "./image-settings";
import {
  createImageWorkerRunner,
  ImageWorkerUnavailableError,
} from "./image-worker-client";
import { createPhotoVariantEncoder } from "./image-encoding";

export interface PreparedPhoto {
  input: UploadInput;
  original: File;
  thumbnail: Blob;
  preview: Blob;
}

export type DetectedImageType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/heic"
  | "image/heif";

export interface PhotoPreparationOptions {
  signal?: AbortSignal;
}

export interface PhotoPreparer {
  prepare(file: File, options?: PhotoPreparationOptions): Promise<PreparedPhoto>;
  cancelActive(): void;
  dispose(): void;
}

export const PHOTO_VARIANT_SETTINGS = {
  preview: { maxEdge: IMAGE_PREVIEW_EDGE, quality: IMAGE_PREVIEW_JPEG_QUALITY },
  thumbnail: {
    maxEdge: IMAGE_THUMBNAIL_EDGE,
    quality: IMAGE_THUMBNAIL_JPEG_QUALITY,
  },
} as const;

/** Read byte signatures instead of trusting a file picker MIME type. */
export async function detectImageType(file: File): Promise<DetectedImageType> {
  const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  )
    return "image/webp";
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brands = new Set<string>();
    brands.add(ascii(bytes, 8, 4));
    for (let i = 16; i + 4 <= bytes.length; i += 4)
      brands.add(ascii(bytes, i, 4));
    if (
      [...brands].some((brand) =>
        [
          "heic",
          "heix",
          "hevc",
          "hevx",
          "heim",
          "heis",
          "hevm",
          "hevs",
        ].includes(brand),
      )
    )
      return "image/heic";
    if ([...brands].some((brand) => ["mif1", "msf1"].includes(brand)))
      return "image/heif";
  }
  throw new Error(
    "Unsupported image. Choose a JPEG, PNG, WebP, HEIC or HEIF photo.",
  );
}

/** Extract dimensions without asking the browser to allocate a decoded bitmap. */
export async function readImageDimensions(
  file: File,
  type: DetectedImageType,
): Promise<{ width: number; height: number } | null> {
  const bytes = new Uint8Array(
    await file.slice(0, Math.min(file.size, 2 * 1024 * 1024)).arrayBuffer(),
  );
  if (type === "image/png" && bytes.length >= 24)
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  if (type === "image/webp" && bytes.length >= 30) {
    const kind = ascii(bytes, 12, 4);
    if (kind === "VP8X")
      return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
    if (kind === "VP8L" && bytes[20] === 0x2f) {
      return {
        width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        height:
          1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
      };
    }
    if (kind === "VP8 " && bytes.length >= 30)
      return {
        width: u16le(bytes, 26) & 0x3fff,
        height: u16le(bytes, 28) & 0x3fff,
      };
  }
  if (type === "image/jpeg") {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        return {
          width: (bytes[offset + 5] << 8) | bytes[offset + 6],
          height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        };
      }
      offset += length;
    }
  }
  if (type === "image/heic" || type === "image/heif") {
    let largest: { width: number; height: number } | null = null;
    for (let i = 4; i + 16 < bytes.length; i += 1) {
      if (ascii(bytes, i, 4) === "ispe") {
        const width = u32be(bytes, i + 8);
        const height = u32be(bytes, i + 12);
        if (
          width &&
          height &&
          (!largest || width * height > largest.width * largest.height)
        )
          largest = { width, height };
      }
    }
    if (largest) return largest;
  }
  return null;
}

/**
 * One lazily-created worker per upload queue. A missing/blocked worker or
 * missing OffscreenCanvas falls back to the original window canvas path.
 */
export function createPhotoPreparer(): PhotoPreparer {
  const runner = createImageWorkerRunner();
  const fallbackEncoder = createPhotoVariantEncoder();
  let disposed = false;

  return {
    async prepare(file, options = {}) {
      if (disposed) throw new Error("Photo preparer has been disposed.");
      if (options.signal?.aborted) throw makeAbortError();
      if (file.size > MAX_FILE_BYTES)
        throw new Error("Photo exceeds the 50 MiB limit.");
      if (file.size === 0) throw new Error("This file is empty.");
      const contentType = await detectImageType(file);
      const dimensions = await readImageDimensions(file, contentType);
      if (options.signal?.aborted) throw makeAbortError();
      if (dimensions) assertDimensions(dimensions.width, dimensions.height);

      try {
        const outcome = await runner.process(file, options.signal);
        if (outcome.type === "success") {
          if (options.signal?.aborted) throw makeAbortError();
          return {
            input: {
              filename: file.name,
              contentType,
              bytes: file.size,
              width: outcome.result.width,
              height: outcome.result.height,
            },
            original: file,
            preview: outcome.result.preview,
            thumbnail: outcome.result.thumbnail,
          };
        }
      } catch (error) {
        if (error instanceof ImageWorkerUnavailableError) {
          // Use the window canvas path when this browser cannot start the worker.
        } else if (
          error instanceof Error &&
          error.name === "ImageConversionError"
        ) {
          throw new Error(
            `This HEIC/HEIF photo could not be converted in this browser. ${error.message}`,
          );
        } else throw error;
      }
      if (options.signal?.aborted) throw makeAbortError();
      return prepareOnMainThread(file, contentType, fallbackEncoder, options.signal);
    },
    cancelActive() {
      runner.cancelActive();
    },
    dispose() {
      disposed = true;
      runner.dispose();
    },
  };
}

const defaultPhotoPreparer = createPhotoPreparer();

/** Convenient one-off API kept for callers that do not own an upload queue. */
export function preparePhoto(
  file: File,
  options?: PhotoPreparationOptions,
): Promise<PreparedPhoto> {
  return defaultPhotoPreparer.prepare(file, options);
}

async function prepareOnMainThread(
  file: File,
  contentType: DetectedImageType,
  encoder: ReturnType<typeof createPhotoVariantEncoder>,
  signal?: AbortSignal,
): Promise<PreparedPhoto> {
  let decodeBlob: Blob = file;
  if (contentType === "image/heic" || contentType === "image/heif") {
    try {
      const { heicTo } = await import("heic-to/csp");
      if (signal?.aborted) throw makeAbortError();
      decodeBlob = await heicTo({
        blob: file,
        type: "image/jpeg",
        quality: 0.9,
      });
    } catch (error) {
      if (signal?.aborted) throw makeAbortError();
      const detail =
        error instanceof Error ? error.message : "Unknown decoder error";
      throw new Error(
        `This HEIC/HEIF photo could not be converted in this browser. ${detail}`,
      );
    }
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(decodeBlob, {
      imageOrientation: "from-image",
    });
  } catch {
    throw new Error(
      "This photo could not be decoded. It may be damaged or use an unsupported encoding.",
    );
  }
  try {
    if (signal?.aborted) throw makeAbortError();
    assertDimensions(bitmap.width, bitmap.height);
    const preview = await encoder.encode(bitmap, "preview");
    if (signal?.aborted) throw makeAbortError();
    const thumbnail = await encoder.encode(bitmap, "thumbnail");
    if (signal?.aborted) throw makeAbortError();
    return {
      input: {
        filename: file.name,
        contentType,
        bytes: file.size,
        width: bitmap.width,
        height: bitmap.height,
      },
      original: file,
      thumbnail,
      preview,
    };
  } finally {
    bitmap.close();
  }
}

function makeAbortError() {
  return new DOMException("Photo processing cancelled.", "AbortError");
}

function assertDimensions(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_PIXELS
  ) {
    throw new Error("Photo exceeds the 60 megapixel limit.");
  }
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}
function u32be(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] * 256 + bytes[offset + 1]) * 256 + bytes[offset + 2]) *
      256 +
      bytes[offset + 3]) >>>
    0
  );
}
function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}
function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}
