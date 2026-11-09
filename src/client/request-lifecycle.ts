/** Owns one latest-wins request and prevents stale async work from committing. */
export function createRequestLifecycle() {
  let generation = 0;
  let controller: AbortController | undefined;
  let disposed = false;

  const invalidate = () => {
    generation++;
    controller?.abort();
    controller = undefined;
  };

  return {
    begin() {
      invalidate();
      const requestGeneration = generation;
      const requestController = new AbortController();
      controller = requestController;
      return {
        signal: requestController.signal,
        isCurrent: () =>
          !disposed &&
          !requestController.signal.aborted &&
          generation === requestGeneration,
      };
    },
    invalidate,
    dispose() {
      disposed = true;
      invalidate();
    },
  };
}
