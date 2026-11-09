import { createPhotoVariantEncoder } from "./image-encoding";
import type {
  ImageWorkerRequest,
  ImageWorkerResponse,
} from "./image-worker-client";
import { MAX_PIXELS } from "../shared/types";

interface WorkerScope {
  postMessage(message: ImageWorkerResponse): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ImageWorkerRequest>) => void,
  ): void;
}
const scope = globalThis as unknown as WorkerScope;
const encoder = createPhotoVariantEncoder();

function send(response: ImageWorkerResponse) {
  scope.postMessage(response);
}

scope.addEventListener("message", (event: MessageEvent<ImageWorkerRequest>) => {
  const { blob, requestId } = event.data;
  void (async () => {
    if (typeof OffscreenCanvas === "undefined") {
      send({ type: "fallback", requestId, reason: "OffscreenCanvas is unavailable in workers." });
      return;
    }
    let bitmap: ImageBitmap | null = null;
    let category: "decode" | "conversion" | "processing" = "decode";
    try {
      const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
      const heic = bytes.length >= 12 &&
        String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp";
      if (heic) {
        category = "conversion";
        try {
          // The CSP build performs libheif decoding in its own Blob worker and
          // returns a bitmap; the OffscreenCanvas work below stays in this worker.
          const { heicTo } = await import("heic-to/csp");
          bitmap = await heicTo({
            blob,
            type: "bitmap",
            options: { imageOrientation: "from-image" },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          send({ type: "failure", requestId, category: "conversion", message });
          return;
        }
      } else {
        bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      }
      category = "processing";
      if (!Number.isSafeInteger(bitmap.width * bitmap.height) || bitmap.width * bitmap.height > MAX_PIXELS)
        throw new Error("Photo exceeds the 60 megapixel limit.");
      const preview = await encoder.encode(bitmap, "preview");
      const thumbnail = await encoder.encode(bitmap, "thumbnail");
      send({ type: "success", requestId, preview, thumbnail, width: bitmap.width, height: bitmap.height });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({
        type: "failure",
        requestId,
        category,
        message: category === "decode"
          ? "This photo could not be decoded. It may be damaged or use an unsupported encoding."
          : message,
      });
    } finally {
      bitmap?.close();
    }
  })();
});
