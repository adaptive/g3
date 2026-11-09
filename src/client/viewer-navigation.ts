const stateKey = "adaptiveGalleryViewer";
type Browser = Pick<Window, "location" | "history" | "addEventListener" | "removeEventListener">;

export function viewerPhotoId(url: string): string | null {
  const id = new URL(url).searchParams.get("photo");
  return id && /^[a-zA-Z0-9-]{1,128}$/.test(id) ? id : null;
}

export function viewerPhotoUrl(url: string, photoId: string | null): string {
  const next = new URL(url);
  if (photoId) next.searchParams.set("photo", photoId);
  else next.searchParams.delete("photo");
  return `${next.pathname}${next.search}${next.hash}`;
}

/** One history entry per viewer session; moving between photos replaces it. */
export function createViewerNavigation(browser: Browser, select: (id: string | null) => void) {
  let closing = false;
  const changed = () => {
    closing = false;
    select(viewerPhotoId(browser.location.href));
  };
  browser.addEventListener("popstate", changed);
  browser.addEventListener("hashchange", changed);
  const historyState = () => {
    const state: unknown = browser.history.state;
    return state && typeof state === "object" ? { ...state } as Record<string, unknown> : {};
  };
  return {
    open(photoId: string) {
      closing = false;
      const url = browser.location.href;
      const state = historyState();
      if (viewerPhotoId(url)) {
        browser.history.replaceState(state, "", viewerPhotoUrl(url, photoId));
      } else {
        state[stateKey] = { base: viewerPhotoUrl(url, null) };
        browser.history.pushState(state, "", viewerPhotoUrl(url, photoId));
      }
      changed();
    },
    close() {
      if (closing) return;
      const state = historyState();
      const marker = state[stateKey] as { base?: unknown } | undefined;
      const base = viewerPhotoUrl(browser.location.href, null);
      if (viewerPhotoId(browser.location.href) && marker?.base === base) {
        closing = true;
        browser.history.back();
      } else {
        delete state[stateKey];
        browser.history.replaceState(state, "", base);
        changed();
      }
    },
    dispose() {
      browser.removeEventListener("popstate", changed);
      browser.removeEventListener("hashchange", changed);
    },
  };
}
