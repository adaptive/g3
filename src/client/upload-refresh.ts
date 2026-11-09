import type { UploadTask } from "./uploads";

/** Reconcile completed uploads once the queue is idle, without overlapping loads. */
export function createUploadBatchRefresh(refresh: () => Promise<void>) {
  const completed = new Set<string>();
  let dirty = false;
  let busy = false;
  let refreshing = false;
  let disposed = false;

  const flush = async () => {
    if (disposed || busy || refreshing || !dirty) return;
    dirty = false;
    refreshing = true;
    try {
      // The caller owns error reporting, just as it does for a manual reload.
      await refresh();
    } finally {
      refreshing = false;
      // A second batch can finish while the first reconciliation is in flight.
      if (!disposed && dirty && !busy) void flush().catch(() => {});
    }
  };

  return {
    update(tasks: UploadTask[]) {
      if (disposed) return;
      busy = tasks.some((task) =>
        ["queued", "processing", "uploading"].includes(task.status),
      );
      for (const task of tasks) {
        if (task.status === "complete" && !completed.has(task.id)) {
          completed.add(task.id);
          dirty = true;
        }
      }
      void flush().catch(() => {});
    },
    dispose() {
      disposed = true;
    },
  };
}
