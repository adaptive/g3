import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  Check,
  CircleAlert,
  Eye,
  FolderPlus,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Settings2,
  Share2,
  Trash2,
  X,
} from "lucide-solid";
import type { GallerySummary, Visibility } from "../shared/types";
import { clearBrowserMediaCaches } from "./media";
import { clearAllUploadRecovery } from "./upload-recovery";
import { createRequestLifecycle } from "./request-lifecycle";
import { SponsorLink } from "./sponsor-link";
import { RepositoryLink } from "./repository-link";

type Draft = {
  title: string;
  slug: string;
  date: string;
  description: string;
  visibility: Visibility;
  password: string;
};

const newDraft = (): Draft => ({
  title: "",
  slug: "",
  date: "",
  description: "",
  visibility: "private",
  password: "",
});
const slugify = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
    .replace(/-$/g, "");
const shareUrl = (slug: string) => `${location.origin}/g/${encodeURIComponent(slug)}`;

function errorMessage(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const messages: Record<string, string> = {
    unauthorized: "Your admin session expired. Sign in again.",
    forbidden: "You do not have permission to do that.",
    rate_limited: "Too many sign in attempts. Wait a minute, then try again.",
    conflict: "That address is already in use. Choose a different one.",
    bad_request: "Check the details and try again.",
    internal_error: "We could not complete that request. Please try again.",
  };
  return messages[code] || code || "Something went wrong. Please try again.";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { "content-type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(body?.error || `Request failed (${response.status})`);
  }
  return (response.status === 204 ? undefined : response.json()) as Promise<T>;
}

function AdminLogin(props: { onSuccess: () => void }) {
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await request("/api/login", {
        method: "POST",
        body: JSON.stringify({ role: "admin", password: password() }),
      });
      props.onSuccess();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="gallery-admin-login" onSubmit={submit}>
      <div>
        <h2>Admin sign in</h2>
        <p>Manage galleries, privacy and photographs from one place.</p>
      </div>
      <label for="galleries-admin-password">Admin password</label>
      <div class="password-input">
        <LockKeyhole size={16} />
        <input
          id="galleries-admin-password"
          type="password"
          autocomplete="current-password"
          required
          value={password()}
          onInput={(event) => setPassword(event.currentTarget.value)}
          placeholder="Enter your admin password"
        />
      </div>
      <Show when={error()}>
        <p class="form-error" role="alert"><CircleAlert size={15} /> {error()}</p>
      </Show>
      <button class="button button-dark" type="submit" disabled={busy()}>
        <Show when={busy()}><LoaderCircle size={16} /></Show>
        {busy() ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export default function Galleries() {
  const refreshLifecycle = createRequestLifecycle();
  const [galleries, setGalleries] = createSignal<GallerySummary[]>([]);
  const [isAdmin, setIsAdmin] = createSignal(false);
  const [needsAdminLogin, setNeedsAdminLogin] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal("");
  const [notice, setNoticeValue] = createSignal("");
  const [noticeError, setNoticeError] = createSignal(false);
  const setNotice = (message: string, error = false) => {
    setNoticeValue(message);
    setNoticeError(error);
  };
  const [createOpen, setCreateOpen] = createSignal(false);
  const [createDraft, setCreateDraft] = createSignal(newDraft());
  const [createBusy, setCreateBusy] = createSignal(false);
  const [createError, setCreateError] = createSignal("");
  const [createTouchedSlug, setCreateTouchedSlug] = createSignal(false);
  const [editingSlug, setEditingSlug] = createSignal<string | null>(null);
  const [editDraft, setEditDraft] = createSignal(newDraft());
  const [editBusy, setEditBusy] = createSignal(false);
  const [editError, setEditError] = createSignal("");
  const [copiedSlug, setCopiedSlug] = createSignal("");
  const [deletingSlug, setDeletingSlug] = createSignal<string | null>(null);
  const adminRoute = () => /^\/admin\/?$/.test(location.pathname);
  let deletionPollTimer: number | undefined;
  let deletionPolling = false;
  let directoryDisposed = false;
  const clearDeletionPollTimer = () => {
    if (deletionPollTimer !== undefined) clearTimeout(deletionPollTimer);
    deletionPollTimer = undefined;
  };
  const stopDeletionPolling = () => {
    deletionPolling = false;
    clearDeletionPollTimer();
  };
  const handleUnauthorized = (cause: unknown) => {
    if (!(cause instanceof Error) || cause.message !== "unauthorized") return;
    setIsAdmin(false);
    setGalleries([]);
    setEditingSlug(null);
    setCreateOpen(false);
    setNeedsAdminLogin(true);
    void refresh();
  };

  const refresh = async (options: { background?: boolean } = {}): Promise<boolean> => {
    const background = options.background ?? false;
    const refreshRequest = refreshLifecycle.begin();
    if (!background) {
      setLoading(true);
      setLoadError("");
    }
    try {
      const session = await request<{ role: string | null }>("/api/session", {
        signal: AbortSignal.any([refreshRequest.signal, AbortSignal.timeout(10_000)]),
      });
      if (!refreshRequest.isCurrent()) return false;
      setIsAdmin(session.role === "admin");
      if (session.role !== "admin") {
        setGalleries([]);
        setEditingSlug(null);
        setCreateOpen(false);
      }
      const result = await request<{ galleries: GallerySummary[] }>("/api/galleries", {
        signal: AbortSignal.any([refreshRequest.signal, AbortSignal.timeout(10_000)]),
      });
      if (!refreshRequest.isCurrent()) return false;
      setGalleries(result.galleries);
      if (result.galleries.some((gallery) => gallery.status === "deleting")) {
        scheduleDeletionPolling();
      } else stopDeletionPolling();
      return true;
    } catch (cause) {
      if (!refreshRequest.isCurrent()) return false;
      if (cause instanceof Error && cause.message === "unauthorized") {
        setIsAdmin(false);
        setGalleries([]);
        setEditingSlug(null);
        setCreateOpen(false);
        setNeedsAdminLogin(true);
        stopDeletionPolling();
      }
      if (!background) {
        setLoadError(errorMessage(cause));
      }
      return false;
    } finally {
      if (!background && refreshRequest.isCurrent()) setLoading(false);
    }
  };
  const scheduleDeletionPolling = () => {
    deletionPolling = true;
    if (document.visibilityState === "visible") scheduleNextDeletionPoll();
  };
  const scheduleNextDeletionPoll = () => {
    if (!deletionPolling || directoryDisposed || document.visibilityState !== "visible" || deletionPollTimer !== undefined) return;
    deletionPollTimer = window.setTimeout(async () => {
      deletionPollTimer = undefined;
      if (!deletionPolling || directoryDisposed || document.visibilityState !== "visible") return;
      if (loading()) {
        scheduleNextDeletionPoll();
        return;
      }
      await refresh({ background: true });
      if (directoryDisposed || !deletionPolling) return;
      if (galleries().some((gallery) => gallery.status === "deleting")) scheduleNextDeletionPoll();
      else stopDeletionPolling();
    }, 10_000);
  };
  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") clearDeletionPollTimer();
    else scheduleNextDeletionPoll();
  };
  onMount(() => {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void refresh();
  });
  onCleanup(() => {
    directoryDisposed = true;
    refreshLifecycle.dispose();
    stopDeletionPolling();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  });

  const beginEdit = (gallery: GallerySummary) => {
    setEditingSlug(gallery.slug);
    setEditError("");
    setEditDraft({
      title: gallery.title,
      slug: gallery.slug,
      date: gallery.date?.slice(0, 10) || "",
      description: gallery.description,
      visibility: gallery.visibility,
      password: "",
    });
  };
  const copyLink = async (slug: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl(slug));
      setCopiedSlug(slug);
      setNotice("Gallery link copied.");
      window.setTimeout(() => setCopiedSlug(""), 1800);
    } catch {
      setNotice("Copy was unavailable. Use the gallery link in your browser’s address bar.");
    }
  };
  const createGallery = async (event: SubmitEvent) => {
    event.preventDefault();
    if (createBusy()) return;
    setCreateBusy(true);
    setCreateError("");
    try {
      const draft = createDraft();
      await request<GallerySummary>("/api/admin/galleries", {
        method: "POST",
        body: JSON.stringify({
          ...draft,
          password: draft.visibility === "private" ? draft.password : undefined,
          slug: slugify(draft.slug || draft.title),
          date: draft.date,
        }),
      });
      setCreateDraft(newDraft());
      setCreateTouchedSlug(false);
      setCreateOpen(false);
      setNotice("Gallery created. You can open it and add photos now.");
      await refresh();
    } catch (cause) {
      handleUnauthorized(cause);
      setCreateError(errorMessage(cause));
    } finally {
      setCreateBusy(false);
    }
  };
  const saveGallery = async (event: SubmitEvent) => {
    event.preventDefault();
    const slug = editingSlug();
    if (!slug || editBusy()) return;
    setEditBusy(true);
    setEditError("");
    try {
      const draft = editDraft();
      await request(`/api/admin/galleries/${encodeURIComponent(slug)}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: draft.title,
          date: draft.date,
          description: draft.description,
          visibility: draft.visibility,
          password: draft.password || undefined,
        }),
      });
      setEditingSlug(null);
      setNotice("Gallery settings saved.");
      await refresh();
    } catch (cause) {
      handleUnauthorized(cause);
      setEditError(errorMessage(cause));
    } finally {
      setEditBusy(false);
    }
  };
  const deleteGallery = async (gallery: GallerySummary) => {
    if (deletingSlug()) return;
    if (!confirm(`Delete “${gallery.title}” and all ${gallery.photoCount} photographs? This cannot be undone.`)) return;
    setDeletingSlug(gallery.slug);
    try {
      await request<{ status?: string }>(`/api/admin/galleries/${encodeURIComponent(gallery.slug)}`, {
        method: "DELETE",
      });
      const refreshed = await refresh();
      if (refreshed) {
        setNotice(galleries().some((item) => item.slug === gallery.slug)
          ? "Deletion is continuing in the background. Check back shortly for progress."
          : "Gallery deleted.");
      } else {
        setNotice("Deletion was requested and will continue in the background. Refresh to check progress.");
      }
    } catch (cause) {
      handleUnauthorized(cause);
      setNotice(cause instanceof Error && cause.message === "conflict"
        ? "An upload is still finishing. Retry deletion shortly."
        : errorMessage(cause), true);
      await refresh();
    } finally {
      setDeletingSlug(null);
    }
  };
  const signOut = async () => {
    stopDeletionPolling();
    refreshLifecycle.invalidate();
    setLoading(false);
    clearBrowserMediaCaches();
    try {
      await request("/api/logout", { method: "POST", body: "{}" });
      let cleared = true;
      try { await clearAllUploadRecovery(); }
      catch { cleared = false; }
      await refresh();
      setNotice(cleared ? "" : "Signed out, but saved uploads could not be cleared. Remove this site's stored data on a shared device.", !cleared);
    } catch (cause) {
      handleUnauthorized(cause);
      setLoadError(errorMessage(cause));
    }
  };
  const signedIn = () => {
    setNotice("");
    setNeedsAdminLogin(false);
    void refresh();
  };

  return (
    <main class="galleries-page">
      <a class="skip-link" href="#gallery-list">Skip to galleries</a>
      <header class="topbar">
        <a class="wordmark" href="/" aria-label="Gallery home">
          <span class="wordmark-icon">g.</span>
          <span>gallery</span>
        </a>
        <div class="topbar-right">
          <span class="event-pill"><span class="status-dot" /> {isAdmin() ? "Gallery manager" : "Shared photographs"}</span>
          <Show when={isAdmin()} fallback={
            <Show when={adminRoute()}>
              <a class="button button-quiet" href="/">Browse galleries</a>
            </Show>
          }>
            <button class="button button-quiet" onClick={() => void signOut()}>
              <LogOut size={16} /> Sign out
            </button>
          </Show>
        </div>
      </header>

      <section class="galleries-intro">
        <div>
          <span class="eyebrow">YOUR COLLECTIONS</span>
          <h1>{isAdmin() ? "Galleries" : "A place for every occasion."}</h1>
          <p>{isAdmin()
            ? "Create a home for each event and choose who can see it."
            : "Open a public gallery, or use the private link and password you were given."}</p>
        </div>
        <Show when={isAdmin()}>
          <button class="button button-dark" onClick={() => { setCreateOpen((value) => !value); setCreateError(""); }}>
            <Show when={createOpen()} fallback={<><FolderPlus size={17} /> New gallery</>}>
              <X size={16} /> Close form
            </Show>
          </button>
        </Show>
      </section>

      <Show when={(adminRoute() || needsAdminLogin()) && !isAdmin() && !loading()}>
        <AdminLogin onSuccess={signedIn} />
      </Show>

      <Show when={isAdmin() && createOpen()}>
        <form class="gallery-create-form" onSubmit={createGallery}>
          <div class="gallery-form-heading">
            <div><span class="eyebrow">NEW COLLECTION</span><h2>Set up a gallery</h2></div>
            <p>Give this event a name and choose its privacy.</p>
          </div>
          <div class="gallery-form-grid">
            <div class="field-span-two">
              <label for="create-title">Gallery title</label>
              <input id="create-title" required maxLength={120} value={createDraft().title}
                onInput={(event) => {
                  const title = event.currentTarget.value;
                  setCreateDraft((draft) => ({ ...draft, title, slug: createTouchedSlug() ? draft.slug : slugify(title) }));
                }} placeholder="e.g. Summer gathering" />
            </div>
            <div>
              <label for="create-slug">Link address</label>
              <div class="gallery-slug-input"><span>/g/</span><input id="create-slug" required maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={createDraft().slug}
                onInput={(event) => { setCreateTouchedSlug(true); setCreateDraft((draft) => ({ ...draft, slug: slugify(event.currentTarget.value) })); }} placeholder="summer-gathering" /></div>
              <small>Letters, numbers and hyphens.</small>
            </div>
            <div>
              <label for="create-date">Event date</label>
              <input id="create-date" type="date" value={createDraft().date} onInput={(event) => setCreateDraft((draft) => ({ ...draft, date: event.currentTarget.value }))} />
            </div>
            <div class="field-span-two">
              <label for="create-description">Description</label>
              <textarea id="create-description" rows={2} maxLength={1000} value={createDraft().description} onInput={(event) => setCreateDraft((draft) => ({ ...draft, description: event.currentTarget.value }))} placeholder="A few words about the occasion" />
            </div>
            <fieldset class="gallery-access-choice field-span-two">
              <legend>Who can view this gallery?</legend>
              <label class={createDraft().visibility === "private" ? "access-choice selected" : "access-choice"}>
                <input type="radio" name="create-visibility" checked={createDraft().visibility === "private"} onChange={() => setCreateDraft((draft) => ({ ...draft, visibility: "private" }))} />
                <LockKeyhole size={17} /><span><strong>Private</strong><small>Password required</small></span>
              </label>
              <label class={createDraft().visibility === "public" ? "access-choice selected" : "access-choice"}>
                <input type="radio" name="create-visibility" checked={createDraft().visibility === "public"} onChange={() => setCreateDraft((draft) => ({ ...draft, visibility: "public", password: "" }))} />
                <Eye size={17} /><span><strong>Public</strong><small>Anyone with the link</small></span>
              </label>
            </fieldset>
            <Show when={createDraft().visibility === "private"}>
              <div class="field-span-two">
                <label for="create-password">Guest password</label>
                <div class="password-input"><KeyRound size={16} /><input id="create-password" type="password" required minLength={12} maxLength={256} autocomplete="new-password" value={createDraft().password} onInput={(event) => setCreateDraft((draft) => ({ ...draft, password: event.currentTarget.value }))} placeholder="At least 12 characters" /></div>
                <small>Use at least 12 characters and a different password from the administrator’s. Share it with invited guests; it cannot be viewed later.</small>
              </div>
            </Show>
          </div>
          <Show when={createError()}><p class="form-error" role="alert"><CircleAlert size={15} /> {createError()}</p></Show>
          <div class="gallery-form-actions"><button type="button" class="button button-quiet" onClick={() => setCreateOpen(false)}>Cancel</button><button type="submit" class="button button-dark" disabled={createBusy()}><Show when={createBusy()}><LoaderCircle size={16} /></Show>{createBusy() ? "Creating…" : "Create gallery"}</button></div>
        </form>
      </Show>

      <section id="gallery-list" class="gallery-list" aria-labelledby="gallery-list-title">
        <div class="gallery-list-heading"><h2 id="gallery-list-title">{isAdmin() ? "All galleries" : "Public galleries"}</h2><Show when={!loading()}><span>{galleries().length} {galleries().length === 1 ? "gallery" : "galleries"}</span></Show></div>
        <Show when={loadError()}><div class="gallery-load-error" role="alert"><CircleAlert size={18} /><span>{loadError()}</span><button class="button button-outline" onClick={() => void refresh()}>Try again</button></div></Show>
        <Show when={loading()}><div class="gallery-loading"><LoaderCircle size={20} /> Loading galleries…</div></Show>
        <Show when={!loading() && !loadError() && galleries().length === 0}>
          <div class="gallery-no-results"><div class="empty-icon"><FolderPlus size={21} /></div><h3>{isAdmin() ? "Your galleries start here" : "No public galleries yet"}</h3><p>{isAdmin() ? "Create a gallery for your next event. You can keep it private or make it public." : "Private galleries are available through the link shared by their owner."}</p><Show when={isAdmin()}><button class="button button-dark" onClick={() => setCreateOpen(true)}><FolderPlus size={16} /> Create a gallery</button></Show></div>
        </Show>
        <div class="gallery-card-grid">
          <For each={galleries()}>{(gallery) => {
            const editing = () => editingSlug() === gallery.slug;
            return <article class="managed-gallery-card">
              <div class="managed-gallery-topline"><span class={`gallery-visibility ${gallery.visibility}`}>
                {gallery.visibility === "private" ? <LockKeyhole size={13} /> : <Eye size={14} />}
                {gallery.visibility === "private" ? "Private" : "Public"}
              </span><Show when={isAdmin()}><span class="gallery-photo-count">{gallery.photoCount} {gallery.photoCount === 1 ? "photo" : "photos"}</span></Show></div>
              <a class="managed-gallery-main" href={gallery.status === "deleting" ? undefined : `/g/${encodeURIComponent(gallery.slug)}`}>
                <h3>{gallery.title}</h3>
                <Show when={gallery.date}><p>{new Date(`${gallery.date.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</p></Show>
                <Show when={gallery.description}><p class="managed-gallery-description">{gallery.description}</p></Show>
              </a>
              <Show when={gallery.status === "deleting"}><p role="status">Deletion is continuing in the background. Retry to check progress.</p></Show>
              <div class="managed-gallery-actions">
                <Show when={gallery.status !== "deleting"} fallback={
                  <button class="button button-dark" disabled={deletingSlug() !== null} onClick={() => void deleteGallery(gallery)}>
                    <Trash2 size={15} /> {deletingSlug() === gallery.slug ? "Deleting…" : "Retry deletion"}
                  </button>
                }>
                <a class="button button-dark" href={`/g/${encodeURIComponent(gallery.slug)}`}><Eye size={15} /> Open gallery</a>
                <Show when={isAdmin()}>
                  <button class="icon-button gallery-action-icon" title="Copy gallery link" aria-label={`Copy link for ${gallery.title}`} onClick={() => void copyLink(gallery.slug)}>{copiedSlug() === gallery.slug ? <Check size={16} /> : <Share2 size={16} />}</button>
                  <button class="icon-button gallery-action-icon" title="Manage gallery" aria-label={`Manage ${gallery.title}`} onClick={() => editing() ? setEditingSlug(null) : beginEdit(gallery)}>{editing() ? <X size={17} /> : <Settings2 size={17} />}</button>
                </Show>
                </Show>
              </div>
              <Show when={editing() && gallery.status !== "deleting"}>
                <form class="gallery-edit-form" onSubmit={saveGallery}>
                  <h4>Manage gallery</h4>
                  <label for={`edit-title-${gallery.id}`}>Title</label><input id={`edit-title-${gallery.id}`} required maxLength={120} value={editDraft().title} onInput={(event) => setEditDraft((draft) => ({ ...draft, title: event.currentTarget.value }))} />
                  <label for={`edit-date-${gallery.id}`}>Event date</label><input id={`edit-date-${gallery.id}`} type="date" value={editDraft().date} onInput={(event) => setEditDraft((draft) => ({ ...draft, date: event.currentTarget.value }))} />
                  <label for={`edit-description-${gallery.id}`}>Description</label><textarea id={`edit-description-${gallery.id}`} rows={2} maxLength={1000} value={editDraft().description} onInput={(event) => setEditDraft((draft) => ({ ...draft, description: event.currentTarget.value }))} />
                  <fieldset class="gallery-access-choice">
                    <legend>Visibility</legend>
                    <label class={editDraft().visibility === "private" ? "access-choice selected" : "access-choice"}><input type="radio" name={`edit-visibility-${gallery.id}`} checked={editDraft().visibility === "private"} onChange={() => setEditDraft((draft) => ({ ...draft, visibility: "private" }))} /><LockKeyhole size={16} /><span><strong>Private</strong></span></label>
                    <label class={editDraft().visibility === "public" ? "access-choice selected" : "access-choice"}><input type="radio" name={`edit-visibility-${gallery.id}`} checked={editDraft().visibility === "public"} onChange={() => setEditDraft((draft) => ({ ...draft, visibility: "public" }))} /><Eye size={16} /><span><strong>Public</strong></span></label>
                  </fieldset>
                  <label for={`edit-password-${gallery.id}`}>Change guest password</label>
                  <div class="password-input"><KeyRound size={16} /><input id={`edit-password-${gallery.id}`} type="password" autocomplete="new-password" minLength={12} maxLength={256} required={editDraft().visibility === "private" && !gallery.hasPassword} value={editDraft().password} onInput={(event) => setEditDraft((draft) => ({ ...draft, password: event.currentTarget.value }))} placeholder="Leave blank to keep current password" /></div>
                  <small>{gallery.hasPassword ? "A new password will sign out current guests." : editDraft().visibility === "private" ? "This private gallery needs a password of at least 12 characters." : "Set a password before making this gallery private."}</small>
                  <Show when={editError()}><p class="form-error" role="alert"><CircleAlert size={15} /> {editError()}</p></Show>
                  <div class="gallery-form-actions"><button type="button" class="button button-quiet danger-text" disabled={deletingSlug() !== null} onClick={() => void deleteGallery(gallery)}><Trash2 size={15} /> {deletingSlug() === gallery.slug ? "Deleting…" : "Delete"}</button><button type="submit" class="button button-dark" disabled={editBusy() || deletingSlug() !== null}><Show when={editBusy()}><LoaderCircle size={15} /></Show>{editBusy() ? "Saving…" : "Save changes"}</button></div>
                </form>
              </Show>
            </article>;
          }}</For>
        </div>
      </section>

      <footer class="footer">
        <span class="wordmark small"><span class="wordmark-icon">g.</span><span>gallery</span></span>
        <span>Every photograph, in one place.</span>
        <div class="footer-links">
          <RepositoryLink />
          <Show when={isAdmin()} fallback={<a href="/admin">Admin sign in</a>}>
            <SponsorLink />
          </Show>
        </div>
      </footer>
      <Show when={notice()}><div class={`toast ${noticeError() ? "error" : "success"}`} role="status"><span>{noticeError() ? <CircleAlert size={16} /> : <Check size={16} />} {notice()}</span><button aria-label="Dismiss message" onClick={() => setNotice("")}><X size={15} /></button></div></Show>
    </main>
  );
}

export function GalleryPasswordSettings(props: { slug: string; onSaved?: () => void; onUnauthorized?: () => void }) {
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await request(`/api/admin/galleries/${encodeURIComponent(props.slug)}`, {
        method: "PATCH",
        body: JSON.stringify({ password: password() }),
      });
      setPassword("");
      setSaved(true);
      props.onSaved?.();
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof Error && cause.message === "unauthorized")
        props.onUnauthorized?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="gallery-password-settings" onSubmit={submit}>
      <label for="gallery-password-settings">Change guest password</label>
      <div class="password-input"><KeyRound size={16} /><input id="gallery-password-settings" type="password" required minLength={12} maxLength={256} autocomplete="new-password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} placeholder="At least 12 characters" /></div>
      <small>Use at least 12 characters, different from the admin password. Changing it signs out current guests.</small>
      <Show when={error()}><p class="form-error" role="alert"><CircleAlert size={15} /> {error()}</p></Show>
      <Show when={saved()}><p role="status"><Check size={15} /> Password updated.</p></Show>
      <button type="submit" class="button button-dark" disabled={busy()}><Show when={busy()}><LoaderCircle size={15} /></Show>{busy() ? "Saving…" : "Update password"}</button>
    </form>
  );
}
