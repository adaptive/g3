import type { Photo, Variant } from "../shared/types";
import type { SavedUpload, UploadRecoveryStore } from "./upload-recovery";
import {
  createPhotoPreparer,
  preparePhoto,
  type PhotoPreparer,
  type PreparedPhoto,
} from "./image";

export type UploadStatus =
  | "queued"
  | "processing"
  | "uploading"
  | "complete"
  | "error"
  | "cancelled"
  | "paused";
export interface UploadTask {
  id: string;
  file: File;
  status: UploadStatus;
  progress: number;
  currentStage?: string;
  bytesSent?: number;
  error?: string;
  photo?: Photo;
  recovered?: boolean;
  savedForRecovery?: boolean;
}
type TaskInternal = UploadTask & { uploadId?: string; attempt: number };
export interface UploadQueueDependencies {
  apiPath?: (path: string) => string;
  preparePhoto?: typeof preparePhoto;
  photoPreparer?: PhotoPreparer;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  XMLHttpRequest?: typeof XMLHttpRequest;
  recovery?: UploadRecoveryStore;
  recoveryLockName?: string;
  onRecoveryWarning?: (message: string) => void;
}
export interface UploadQueue {
  add(files: File[]): void;
  retry(taskId: string): void;
  cancel(): void;
  remove(taskId: string): Promise<void>;
  restore(): Promise<void>;
  resume(): void;
  forget(): Promise<void>;
  dispose(): void;
}

/** Runs one decoder and one staged upload at a time, with one-photo lookahead. */
export function createUploadQueue(
  onChange: (tasks: UploadTask[]) => void,
  deps: UploadQueueDependencies = {},
): UploadQueue {
  const apiPath = deps.apiPath ?? ((path: string) => path);
  let tasks: TaskInternal[] = [];
  let cancelled = false;
  let disposed = false;
  let running = false;
  let activeXhr: XMLHttpRequest | null = null;
  let activeRequest: AbortController | null = null;
  let activePreparation: AbortController | null = null;
  let lookaheadTaskId: string | null = null;
  let preparationLane: Promise<void> = Promise.resolve();
  let generation = 0;
  let recoveryEnabled = false;
  let restorePromise: Promise<void> | undefined;
  let recoveryWrites: Promise<void> = Promise.resolve();
  let releaseRecoveryLock: (() => void) | undefined;
  const releaseLock = () => {
    const release = releaseRecoveryLock;
    releaseRecoveryLock = undefined;
    release?.();
  };
  const photoPreparer = deps.photoPreparer ??
    (deps.preparePhoto ? undefined : createPhotoPreparer());

  const notify = () =>
    onChange(
      tasks.map((task) => ({
        id: task.id,
        file: task.file,
        status: task.status,
        progress: task.progress,
        currentStage: task.currentStage,
        bytesSent: task.bytesSent,
        error: task.error,
        photo: task.photo,
        recovered: task.recovered,
        savedForRecovery: task.savedForRecovery,
      })),
    );
  const recoveryWarning = (error: unknown) => {
    deps.onRecoveryWarning?.(
      error instanceof Error ? error.message : "Upload recovery is unavailable.",
    );
  };
  const persist = (task: TaskInternal): Promise<void> => {
    if (disposed || !recoveryEnabled || !deps.recovery || task.status === "complete") return Promise.resolve();
    const record: SavedUpload = {
      id: task.id,
      file: task.file,
      status: task.status,
      progress: task.progress,
      uploadId: task.uploadId,
      error: task.error,
      updatedAt: Date.now(),
    };
    recoveryWrites = recoveryWrites.then(async () => {
      if (!recoveryEnabled) return;
      try {
        await deps.recovery!.put(record);
        if (!disposed && recoveryEnabled && tasks.includes(task) && task.status !== "complete") {
          task.savedForRecovery = true;
          notify();
        }
      }
      catch (error) { recoveryWarning(error); }
    });
    return recoveryWrites;
  };
  const forgetTask = (id: string) => {
    if (!deps.recovery) return Promise.resolve();
    recoveryWrites = recoveryWrites.then(async () => {
      try { await deps.recovery!.remove(id); }
      catch (error) { recoveryWarning(error); }
    });
    return recoveryWrites;
  };
  const set = (id: string, update: Partial<TaskInternal>) => {
    const index = tasks.findIndex((task) => task.id === id);
    if (index >= 0) {
      Object.assign(tasks[index], update);
      notify();
      if (update.status || update.currentStage) void persist(tasks[index]);
    }
  };

  const request = async <T>(
    url: string,
    init?: RequestInit,
    abortOnCancel = true,
  ): Promise<T> => {
    const controller = new AbortController();
    if (abortOnCancel) activeRequest = controller;
    let response: Response;
    try {
      response = await (deps.fetch ?? fetch)(apiPath(url), {
        credentials: "same-origin",
        cache: "no-store",
        ...init,
        signal: controller.signal,
      });
    } finally {
      if (activeRequest === controller) activeRequest = null;
    }
    if (!response.ok) {
      let reason = `Upload request failed (${response.status}).`;
      try {
        const data = (await response.json()) as { error?: string };
        if (data.error) reason = data.error;
      } catch {
        /* use the HTTP status */
      }
      throw Object.assign(new Error(reason), { status: response.status });
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  };

  const putVariant = (
    id: string,
    variant: Variant,
    blob: Blob,
    contentType: string,
    progress: (loaded: number) => void,
  ) =>
    new Promise<void>((resolve, reject) => {
      const xhr = new (deps.XMLHttpRequest ?? XMLHttpRequest)();
      activeXhr = xhr;
      xhr.open(
        "PUT",
        apiPath(`/api/admin/uploads/${encodeURIComponent(id)}/${variant}`),
      );
      xhr.setRequestHeader(
        "Content-Type",
        variant === "original" ? contentType : blob.type,
      );
      xhr.withCredentials = true;
      xhr.upload.onprogress = (event) =>
        progress(Math.min(blob.size, event.loaded));
      xhr.onerror = () => {
        activeXhr = null;
        reject(new Error("Network error while uploading photo data."));
      };
      xhr.onabort = () => {
        activeXhr = null;
        reject(new DOMException("Upload cancelled.", "AbortError"));
      };
      xhr.onload = () => {
        activeXhr = null;
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else {
          let message = `Upload failed (${xhr.status}).`;
          try {
            message = JSON.parse(xhr.responseText).error || message;
          } catch {
            /* retain status */
          }
          reject(new Error(message));
        }
      };
      xhr.send(blob);
    });

  type PreparationOutcome =
    | { prepared: PreparedPhoto; attempt: number }
    | { published: Photo; attempt: number }
    | { error: unknown; attempt: number };

  const prepare = (task: TaskInternal, taskGeneration: number) => {
    const attempt = task.attempt;
    const controller = new AbortController();
    activePreparation = controller;
    set(task.id, {
      status: "processing",
      currentStage: "Preparing previews",
      progress: 0,
      error: undefined,
    });
    const actualWork = preparationLane.then(async (): Promise<PreparationOutcome> => {
      if (
        controller.signal.aborted ||
        cancelled ||
        disposed ||
        taskGeneration !== generation
      )
        throw new DOMException("Preparation cancelled.", "AbortError");
      if (task.recovered || task.uploadId) {
        try {
          const state = await request<{ status: "pending" | "published" | "deleting"; photo?: Photo }>(
            `/api/admin/uploads/${encodeURIComponent(task.uploadId ?? task.id)}`,
          );
          if (state.status === "published" && state.photo) return { published: state.photo, attempt };
          if (state.status === "deleting") throw new Error("This unfinished upload is being removed. Try again after removal finishes.");
          task.uploadId ??= task.id;
        } catch (error) {
          if ((error as { status?: number }).status !== 404) throw error;
          task.uploadId = undefined;
        }
      }
      if (controller.signal.aborted || cancelled || disposed || taskGeneration !== generation)
        throw new DOMException("Preparation cancelled.", "AbortError");
      const prepared = await (deps.preparePhoto
        ? deps.preparePhoto(task.file, { signal: controller.signal })
        : (photoPreparer ?? createPhotoPreparer()).prepare(task.file, {
            signal: controller.signal,
          }));
      return { prepared, attempt };
    });
    // The cancellation race below may settle before a fallback decoder that
    // ignores AbortSignal. Keep the actual decoder lane occupied until it ends.
    preparationLane = actualWork.then(() => undefined, () => undefined);
    const work = actualWork.then<PreparationOutcome, PreparationOutcome>(
      (outcome) => outcome,
      (error) => ({ error, attempt }),
    );
    let abortPreparation!: () => void;
    const aborted = new Promise<PreparationOutcome>((resolve) => {
      abortPreparation = () =>
        resolve({ error: new DOMException("Preparation cancelled.", "AbortError"), attempt });
      if (controller.signal.aborted) {
        abortPreparation();
        return;
      }
      controller.signal.addEventListener("abort", abortPreparation, { once: true });
    });
    return Promise.race([work, aborted]).then((outcome) => {
      // A retry may begin while an old lookahead is settling. Never let the old
      // attempt overwrite its status or feed its prepared bytes into the retry.
      if (outcome.attempt !== task.attempt) return undefined;
      if ("prepared" in outcome || "published" in outcome) {
        if (cancelled || disposed || taskGeneration !== generation) {
          set(task.id, { status: "cancelled", currentStage: undefined });
          return undefined;
        }
        return outcome;
      }
      const error = outcome.error;
      if (
        cancelled ||
        disposed ||
        taskGeneration !== generation ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        set(task.id, { status: "cancelled", currentStage: undefined });
      } else {
        set(task.id, {
          status: "error",
          currentStage: undefined,
          error: error instanceof Error ? error.message : "Photo preparation failed.",
        });
      }
      return undefined;
    }).finally(() => {
      controller.signal.removeEventListener("abort", abortPreparation);
      if (activePreparation === controller) activePreparation = null;
    });
  };

  const upload = async (
    task: TaskInternal,
    taskGeneration: number,
    prepared: PreparedPhoto,
  ) => {
    const id = task.id;
    let completing = false;
    try {
      if (cancelled || disposed || taskGeneration !== generation) {
        set(id, { status: "cancelled", currentStage: undefined });
        return;
      }
      const created = await request<{ id: string }>(
        "/api/admin/uploads",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...prepared.input, uploadId: task.id }),
        },
        false,
      );
      task.uploadId = created.id;
      await persist(task);
      if (cancelled || disposed || taskGeneration !== generation) {
        await cleanup(id);
        set(id, { status: "cancelled", currentStage: undefined });
        return;
      }
      const variants: [Variant, Blob][] = [
        ["original", prepared.original],
        ["preview", prepared.preview],
        ["thumbnail", prepared.thumbnail],
      ];
      const total = variants.reduce((sum, [, blob]) => sum + blob.size, 0);
      let prior = 0;
      for (const [variant, blob] of variants) {
        if (cancelled || disposed || taskGeneration !== generation) {
          await cleanup(id);
          set(id, { status: "cancelled", currentStage: undefined });
          return;
        }
        set(id, {
          status: "uploading",
          currentStage: `Uploading ${variant}`,
          bytesSent: 0,
        });
        await putVariant(
          created.id,
          variant,
          blob,
          variant === "original" ? prepared.input.contentType : "image/jpeg",
          (loaded) => {
            const current = tasks.find((item) => item.id === id);
            if (!current || cancelled || disposed) return;
            const sent = prior + loaded;
            set(id, {
              bytesSent: sent,
              progress: Math.min(99, Math.round((sent / total) * 100)),
            });
          },
        );
        prior += blob.size;
      }
      if (cancelled || disposed || taskGeneration !== generation) {
        await cleanup(id);
        set(id, { status: "cancelled", currentStage: undefined });
        return;
      }
      completing = true;
      const photo = await request<Photo>(
        `/api/admin/uploads/${encodeURIComponent(created.id)}/complete`,
        { method: "POST" },
      );
      task.uploadId = undefined;
      await forgetTask(id);
      set(id, {
        status: "complete",
        currentStage: undefined,
        progress: 100,
        photo,
        recovered: false,
        savedForRecovery: false,
      });
    } catch (error) {
      // A completion response can be lost after publishing. Keep its identity
      // so retry/reload can reconcile instead of creating another photograph.
      if (task.uploadId && !completing) {
        try {
          await cleanup(id);
        } catch {
          /* Keep the original upload error visible; removal remains retryable. */
        }
      }
      if (
        cancelled ||
        disposed ||
        taskGeneration !== generation ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        set(id, { status: "cancelled", currentStage: undefined });
      } else {
        set(id, {
          status: "error",
          currentStage: undefined,
          error: error instanceof Error ? error.message : "Upload failed.",
        });
      }
    }
  };

  const cleanup = async (taskId: string) => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task?.uploadId) return;
    await request<void>(
      `/api/admin/uploads/${encodeURIComponent(task.uploadId)}`,
      { method: "DELETE" },
    );
    task.uploadId = undefined;
  };

  const run = async () => {
    if (running || disposed || cancelled) return;
    running = true;
    try {
      await restorePromise;
      await recoveryWrites;
      if (disposed || cancelled) return;
      let task = tasks.find((candidate) => candidate.status === "queued");
      let taskGeneration = generation;
      let preparation = task ? prepare(task, taskGeneration) : undefined;
      while (task && preparation && !disposed) {
        const outcome = await preparation;
        if (!outcome) {
          if (cancelled) break;
          task = tasks.find((candidate) => candidate.status === "queued");
          taskGeneration = generation;
          preparation = task ? prepare(task, taskGeneration) : undefined;
          continue;
        }
        if (outcome.attempt !== task.attempt || taskGeneration !== generation) {
          if (cancelled) break;
          if (
            outcome.attempt === task.attempt &&
            task.status === "processing"
          )
            set(task.id, { status: "cancelled", currentStage: undefined });
          task = tasks.find((candidate) => candidate.status === "queued");
          taskGeneration = generation;
          preparation = task ? prepare(task, taskGeneration) : undefined;
          continue;
        }
        if ("published" in outcome) {
          task.uploadId = undefined;
          await forgetTask(task.id);
          set(task.id, { status: "complete", progress: 100, currentStage: undefined, photo: outcome.published, recovered: false, savedForRecovery: false });
          task = tasks.find((candidate) => candidate.status === "queued");
          taskGeneration = generation;
          preparation = task ? prepare(task, taskGeneration) : undefined;
          continue;
        }
        // prepare() converts every error outcome to task state before returning.
        if (!("prepared" in outcome)) continue;

        const next = !cancelled
          ? tasks.find((candidate) => candidate.status === "queued")
          : undefined;
        const nextGeneration = generation;
        // Convert preparation failures into task state immediately so they cannot
        // become unhandled while the current photo's network upload is running.
        lookaheadTaskId = next?.id ?? null;
        const nextPreparation = next ? prepare(next, nextGeneration) : undefined;
        await upload(task, taskGeneration, outcome.prepared);
        lookaheadTaskId = null;
        if (cancelled) break;
        if (next && nextPreparation) {
          task = next;
          taskGeneration = nextGeneration;
          preparation = nextPreparation;
        } else {
          task = tasks.find((candidate) => candidate.status === "queued");
          taskGeneration = generation;
          preparation = task ? prepare(task, taskGeneration) : undefined;
        }
      }
    } finally {
      running = false;
      notify();
    }
  };

  const queue: UploadQueue = {
    add(files) {
      cancelled = false;
      if (!running && files.length > 0) generation += 1;
      tasks = [
        ...tasks,
        ...files.map((file) => ({
          id: crypto.randomUUID(),
          file,
          status: "queued" as const,
          progress: 0,
          attempt: 0,
        })),
      ];
      for (const task of tasks.filter((task) => task.status === "queued")) void persist(task);
      notify();
      void run();
    },
    retry(taskId) {
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task || !["error", "cancelled", "paused"].includes(task.status))
        return;
      cancelled = false;
      if (!running) generation += 1;
      task.status = "queued";
      task.progress = 0;
      task.error = undefined;
      task.currentStage = undefined;
      task.attempt += 1;
      void persist(task);
      notify();
      void run();
    },
    cancel() {
      cancelled = true;
      generation += 1;
      activePreparation?.abort();
      photoPreparer?.cancelActive();
      activeRequest?.abort();
      activeXhr?.abort();
      tasks.forEach((task) => {
        if (
          task.status === "queued" ||
          (task.id === lookaheadTaskId && task.status === "processing")
        ) {
          task.status = "cancelled";
          task.currentStage = undefined;
        }
      });
      for (const task of tasks.filter((task) => task.status === "cancelled")) void persist(task);
      notify();
    },
    async remove(taskId) {
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) return;
      if (task.status === "processing" || task.status === "uploading")
        throw new Error("Cancel the active upload before removing it.");
      if (task.recovered) task.uploadId ??= task.id;
      if (task.uploadId) await cleanup(taskId);
      await forgetTask(taskId);
      tasks = tasks.filter((candidate) => candidate.id !== taskId);
      notify();
    },
    restore() {
      if (restorePromise) return restorePromise;
      restorePromise = (async () => {
        if (!deps.recovery || disposed) return;
        if (deps.recoveryLockName) {
          if (!globalThis.navigator?.locks) {
            recoveryWarning(new Error("This browser cannot save upload recovery safely."));
            return;
          }
          const claimed = await new Promise<boolean>((resolve) => {
            void navigator.locks.request(deps.recoveryLockName!, { ifAvailable: true }, async (lock) => {
              if (!lock) { resolve(false); return; }
              await new Promise<void>((release) => {
                releaseRecoveryLock = release;
                resolve(true);
              });
            }).catch(() => resolve(false));
          });
          if (!claimed) {
            recoveryWarning(new Error("Another tab is managing saved uploads for this gallery."));
            return;
          }
        }
        if (disposed) { releaseLock(); return; }
        try {
          const saved = await deps.recovery.load();
          if (disposed) return;
          recoveryEnabled = true;
          const known = new Set(tasks.map((task) => task.id));
          tasks.push(...saved.filter((task) => !known.has(task.id)).map((task) => ({
            ...task, status: "paused" as const, recovered: true, savedForRecovery: true, attempt: 0,
          })));
          for (const task of tasks) if (!task.recovered) void persist(task);
          notify();
        } catch (error) {
          // Keep recovery disabled after a failed load, so this queue cannot
          // write while another tab takes over the gallery's recovery lock.
          recoveryWarning(error);
          releaseLock();
        }
      })();
      return restorePromise;
    },
    resume() {
      for (const task of tasks) if (task.status === "paused") queue.retry(task.id);
    },
    async forget() {
      recoveryEnabled = false;
      queue.cancel();
      await restorePromise;
      recoveryEnabled = false;
      await recoveryWrites;
      await deps.recovery?.clear();
      tasks = [];
      notify();
    },
    dispose() {
      disposed = true;
      cancelled = true;
      generation += 1;
      activePreparation?.abort();
      photoPreparer?.dispose();
      activeRequest?.abort();
      activeXhr?.abort();
      void recoveryWrites.finally(() => {
        deps.recovery?.close();
        releaseLock();
      });
    },
  };
  return queue;
}
