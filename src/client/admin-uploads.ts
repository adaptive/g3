import type { AdminUploadsResponse } from "../shared/types";

export interface AdminUploadListing extends AdminUploadsResponse {
  loading: boolean;
  error: string;
}

const empty = (): AdminUploadListing => ({
  uploads: [], nextCursor: null, total: 0, loading: false, error: "",
});

/** Keep pagination scoped to the current authenticated listing, including refreshes. */
export function createAdminUploadListing(
  fetchPage: (cursor: string, signal: AbortSignal) => Promise<AdminUploadsResponse>,
  changed: (state: AdminUploadListing) => void,
) {
  let state = empty();
  let revision = 0;
  let controller: AbortController | undefined;
  let disposed = false;
  const publish = (next: AdminUploadListing) => {
    state = next;
    changed(state);
  };
  const invalidate = () => {
    revision++;
    controller?.abort();
    controller = undefined;
  };
  return {
    reset(page?: AdminUploadsResponse) {
      if (disposed) return;
      invalidate();
      publish(page ? { ...page, loading: false, error: "" } : empty());
    },
    fail(cause: unknown) {
      if (disposed) return;
      invalidate();
      publish({ ...empty(), error: cause instanceof Error ? cause.message : "Could not load unfinished uploads." });
    },
    remove(id: string) {
      if (disposed) return;
      invalidate();
      const uploads = state.uploads.filter((upload) => upload.id !== id);
      publish({
        ...state, uploads, loading: false,
        total: Math.max(0, state.total - (state.uploads.length - uploads.length)),
      });
    },
    async loadMore() {
      if (disposed || state.loading || !state.nextCursor) return;
      const cursor = state.nextCursor;
      const currentRevision = revision;
      const request = controller = new AbortController();
      const current = () => !disposed && currentRevision === revision && !request.signal.aborted;
      publish({ ...state, loading: true, error: "" });
      try {
        const page = await fetchPage(cursor, request.signal);
        if (!current()) return;
        const seen = new Set(state.uploads.map((upload) => upload.id));
        publish({
          ...page,
          uploads: [...state.uploads, ...page.uploads.filter((upload) => !seen.has(upload.id))],
          loading: false,
          error: "",
        });
      } catch (cause) {
        if (!current()) return;
        publish({ ...state, loading: false, error: cause instanceof Error ? cause.message : "Could not load more unfinished uploads." });
        throw cause;
      } finally {
        if (current()) controller = undefined;
      }
    },
    dispose() {
      disposed = true;
      invalidate();
    },
  };
}
