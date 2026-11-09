export interface WorkerImageResult {
  preview: Blob;
  thumbnail: Blob;
  width: number;
  height: number;
}

export interface ImageWorkerRequest {
  blob: Blob;
  requestId: string;
}

export type ImageWorkerResponse =
  | ({ type: "success" } & WorkerImageResult & { requestId: string })
  | { type: "fallback"; requestId: string; reason: string }
  | {
      type: "failure";
      requestId: string;
      category: "decode" | "conversion" | "processing";
      message: string;
    };

export interface ImageWorkerPort {
  postMessage(message: ImageWorkerRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent<ImageWorkerResponse>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<ImageWorkerResponse>) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

export type ImageWorkerOutcome =
  | { type: "success"; result: WorkerImageResult }
  | { type: "fallback"; reason: string };

export class ImageWorkerUnavailableError extends Error {
  constructor(message = "Image processing worker is unavailable.") {
    super(message);
    this.name = "ImageWorkerUnavailableError";
  }
}

function abortError() {
  return new DOMException("Photo processing cancelled.", "AbortError");
}

/** Keeps one module worker alive and processes one image at a time. */
export function createImageWorkerRunner(
  createWorker: () => ImageWorkerPort = () =>
    new Worker(new URL("./image-worker.ts", import.meta.url), {
      type: "module",
    }) as unknown as ImageWorkerPort,
) {
  let worker: ImageWorkerPort | null = null;
  let requestId = 0;
  let pendingReject: ((error: Error) => void) | null = null;
  let unavailableReason: string | null = null;

  const stop = (error?: Error) => {
    const current = worker;
    worker = null;
    current?.terminate();
    const reject = pendingReject;
    pendingReject = null;
    reject?.(error ?? abortError());
  };

  return {
    async process(blob: Blob, signal?: AbortSignal): Promise<ImageWorkerOutcome> {
      if (signal?.aborted) throw abortError();
      if (pendingReject) throw new Error("Image worker is already processing a photo.");
      if (unavailableReason) return { type: "fallback", reason: unavailableReason };

      if (!worker) {
        try {
          worker = createWorker();
        } catch (error) {
          if (signal?.aborted) throw abortError();
          unavailableReason = error instanceof Error ? error.message : "Image processing worker is unavailable.";
          throw new ImageWorkerUnavailableError(
            unavailableReason,
          );
        }
      }

      const activeWorker = worker;
      const id = String(++requestId);
      return new Promise<ImageWorkerOutcome>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          pendingReject = null;
          signal?.removeEventListener("abort", onAbort);
          activeWorker.removeEventListener("message", onMessage);
          activeWorker.removeEventListener("error", onError);
          callback();
        };
        const onMessage = (event: MessageEvent<ImageWorkerResponse>) => {
          if (event.data?.requestId !== id) return;
          const response = event.data;
          finish(() => {
            if (response.type === "success") {
              resolve({
                type: "success",
                result: {
                  preview: response.preview,
                  thumbnail: response.thumbnail,
                  width: response.width,
                  height: response.height,
                },
              });
            } else if (response.type === "fallback") {
              unavailableReason = response.reason;
              stop();
              resolve({ type: "fallback", reason: response.reason });
            } else {
              const error = new Error(response.message);
              error.name = response.category === "decode" ? "ImageDecodeError" :
                response.category === "conversion" ? "ImageConversionError" :
                  "ImageProcessingError";
              reject(error);
            }
          });
        };
        const onError = (event: ErrorEvent) => {
          finish(() => {
            unavailableReason = event.message || "Worker failed to load.";
            stop(new ImageWorkerUnavailableError(event.message));
            resolve({ type: "fallback", reason: unavailableReason });
          });
        };
        const onAbort = () => {
          finish(() => {
            stop(abortError());
            reject(abortError());
          });
        };
        pendingReject = (error) => finish(() => reject(error));
        activeWorker.addEventListener("message", onMessage);
        activeWorker.addEventListener("error", onError);
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          activeWorker.postMessage({ blob, requestId: id });
        } catch (error) {
          finish(() => {
            unavailableReason = "Could not start image processing worker.";
            stop(error instanceof Error ? error : undefined);
            resolve({ type: "fallback", reason: unavailableReason });
          });
        }
      });
    },
    cancelActive() {
      if (pendingReject) stop(abortError());
    },
    dispose() {
      stop(abortError());
    },
  };
}
