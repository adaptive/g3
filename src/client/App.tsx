import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Eye,
  ImagePlus,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Maximize2,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-solid";
import type {
  AdminUploadsResponse,
  EventSettings,
  GalleryResponse,
  Photo,
  SessionResponse,
  UploadRecord,
  Visibility,
} from "../shared/types";
import { galleryApiPath } from "../shared/types";
import {
  GalleryMediaClient,
  installMediaDiagnostics,
} from "./media";
import { GalleryImage } from "./media-image";
import { ViewerImageCache, viewerNextAction } from "./viewer-image";
import { createViewerNavigation, viewerPhotoId } from "./viewer-navigation";
import { createViewerGestures } from "./viewer-gestures";
import { createAdminUploadListing, type AdminUploadListing } from "./admin-uploads";
import { createUploadQueue, type UploadTask } from "./uploads";
import { clearAllUploadRecovery, createUploadRecoveryStore } from "./upload-recovery";
import { createUploadBatchRefresh } from "./upload-refresh";
import { PhotoGrid, type PhotoGridHandle } from "./photo-grid";
import Galleries, { GalleryPasswordSettings } from "./Galleries";
import { SponsorLink } from "./sponsor-link";
import { RepositoryLink } from "./repository-link";

type Notice = { kind: "success" | "error"; text: string };
type QueuedFile = UploadTask;
class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { "content-type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    const messages: Record<string, string> = {
      unauthorized:
        path.endsWith("/login")
          ? "The password is incorrect. Please try again."
          : "Your session has expired. Please sign in again.",
      forbidden: "You do not have permission to make this change.",
      rate_limited:
        "Too many sign-in attempts. Please wait a minute and try again.",
      setup_required: "The gallery needs to be configured by its owner.",
      not_found: "This gallery or photograph could not be found.",
      bad_request: "Check your settings. Private galleries need a password of at least 12 characters.",
      internal_error: "We could not complete that request. Please try again.",
    };
    throw new ApiError(
      response.status,
      messages[data?.error || ""] ||
        data?.error ||
        data?.message ||
        `Request failed (${response.status})`,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

function galleryRequest<T>(slug: string, path: string, init?: RequestInit) {
  return api<T>(galleryApiPath(slug, path), init);
}

function PhotoStudy() {
  return (
    <div class="photo-study" aria-hidden="true">
      <span class="study-frame study-back" />
      <span class="study-frame study-front">
        <span>a.</span>
      </span>
    </div>
  );
}

function AccessGate(props: {
  slug: string;
  onSignedIn: () => void;
  initialMode?: "guest" | "admin";
  sessionExpired?: boolean;
}) {
  const [mode, setMode] = createSignal<"guest" | "admin">(props.initialMode ?? "guest"),
    [password, setPassword] = createSignal(""),
    [error, setError] = createSignal(""),
    [busy, setBusy] = createSignal(false);
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await api(galleryApiPath(props.slug, "/api/login"), {
        method: "POST",
        body: JSON.stringify({ role: mode(), password: password() }),
      });
      props.onSignedIn();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "That password didn’t work. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <main class="access-page">
      <header class="topbar">
        <a class="wordmark" href="/">
          <span class="wordmark-icon">g.</span>
          <span>gallery</span>
        </a>
        <span class="event-pill">
          <LockKeyhole size={14} /> Private gallery
        </span>
      </header>
      <div class="access-main">
        <PhotoStudy />
        <section class="access-card">
          <h1>A private view.</h1>
          <p>Enter this gallery’s password to view its photographs.</p>
          <div
            class="access-tabs"
            role="group"
            aria-label="Choose how to sign in"
          >
            <button
              aria-pressed={mode() === "guest"}
              class={mode() === "guest" ? "selected" : ""}
              onClick={() => {
                setMode("guest");
                setError("");
              }}
            >
              Guest
            </button>
            <button
              aria-pressed={mode() === "admin"}
              class={mode() === "admin" ? "selected" : ""}
              onClick={() => {
                setMode("admin");
                setError("");
              }}
            >
              Administrator
            </button>
          </div>
          <Show when={props.sessionExpired}>
            <p role="status">Your administrator session has expired. Please sign in again.</p>
          </Show>
          <form onSubmit={submit}>
            <label for="password">
              {mode() === "admin" ? "Admin password" : "Guest password"}
            </label>
            <div class="password-input">
              <LockKeyhole size={17} />
              <input
                id="password"
                type="password"
                autocomplete="current-password"
                required
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                placeholder="Enter your password"
              />
            </div>
            <Show when={error()}>
              <p class="form-error" role="alert">
                <CircleAlert size={15} />
                {error()}
              </p>
            </Show>
            <button
              class="button button-dark access-submit"
              type="submit"
              disabled={busy()}
            >
              <Show when={busy()}>
                <LoaderCircle size={17} />
              </Show>
              {busy() ? "Opening…" : "Enter the gallery"}
            </button>
          </form>
          <div class="access-foot">
            <ShieldCheck size={15} />
            <span>
              Access is limited to people with the gallery password.
            </span>
          </div>
        </section>
      </div>
      <footer class="footer">
        <span class="wordmark small">
          <span class="wordmark-icon">g.</span>
          <span>gallery</span>
        </span>
        <span>Every photograph, in one place.</span>
        <RepositoryLink />
      </footer>
    </main>
  );
}

function LoginDialog(props: { onClose: () => void; onSignedIn: () => void }) {
  const [password, setPassword] = createSignal(""),
    [error, setError] = createSignal(""),
    [busy, setBusy] = createSignal(false);
  let input: HTMLInputElement | undefined;
  onMount(() => {
    const prev = document.activeElement as HTMLElement;
    document.body.style.overflow = "hidden";
    input?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
      else if (e.key === "Tab") {
        const d = input?.closest('[role="dialog"]'),
          els = d
            ? [
                ...d.querySelectorAll<HTMLElement>(
                  "button:not([disabled]),input:not([disabled]),a[href]",
                ),
              ]
            : [],
          first = els[0],
          last = els.at(-1);
        if (first && last && e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (
          first &&
          last &&
          !e.shiftKey &&
          document.activeElement === last
        ) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    onCleanup(() => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = "";
      prev.focus();
    });
  });
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ role: "admin", password: password() }),
      });
      props.onSignedIn();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "That password didn’t work. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      class="login-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <section
        class="login-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-login-title"
      >
        <button
          class="icon-button login-close"
          onClick={props.onClose}
          aria-label="Close admin sign in"
        >
          <X size={18} />
        </button>
        <h2 id="admin-login-title">Admin sign in</h2>
        <p>Sign in to manage this event gallery.</p>
        <form onSubmit={submit}>
          <label for="admin-password">Admin password</label>
          <div class="password-input">
            <LockKeyhole size={16} />
            <input
              ref={(el) => (input = el)}
              id="admin-password"
              type="password"
              autocomplete="current-password"
              required
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              placeholder="Enter your password"
            />
          </div>
          <Show when={error()}>
            <p class="form-error" role="alert">
              <CircleAlert size={15} />
              {error()}
            </p>
          </Show>
          <button
            type="submit"
            class="button button-dark access-submit"
            disabled={busy()}
          >
            <Show when={busy()}>
              <LoaderCircle size={17} />
            </Show>
            {busy() ? "Opening…" : "Continue"}
          </button>
        </form>
      </section>
    </div>
  );
}

type AdminProps = {
  slug: string;
  open: boolean;
  event: EventSettings;
  onClose: () => void;
  onSave: (e: EventSettings) => Promise<void>;
  onVisibility: (v: Visibility) => void;
  queue: QueuedFile[];
  busy: boolean;
  onRetry: (f: QueuedFile) => void;
  onCancel: () => void;
  onDiscard: (id: string) => void;
  onResume: () => void;
  onDiscardSaved: () => void;
  recoveryWarning: string;
  uploads: UploadRecord[];
  uploadListing: AdminUploadListing;
  onLoadMoreUploads: () => void;
  onReloadUploads: () => void;
  saving: boolean;
  onRemoveUpload: (u: UploadRecord) => void;
  onAdd: () => void;
  onUnauthorized: () => void;
};
function AdminPanel(props: AdminProps) {
  const [draft, setDraft] = createSignal(props.event);
  let panel: HTMLElement | undefined;
  createEffect(() => setDraft(props.event));
  createEffect(() => {
    if (!props.open) return;
    const prev = document.activeElement as HTMLElement;
    panel?.querySelector<HTMLElement>("button")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        props.onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const els = [
        ...panel.querySelectorAll<HTMLElement>(
          "button:not([disabled]),input:not([disabled]),textarea:not([disabled]),a[href]",
        ),
      ];
      if (!els.length) return;
      const first = els[0],
        last = els.at(-1)!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", key);
    onCleanup(() => {
      document.removeEventListener("keydown", key);
      prev.focus();
    });
  });
  const save = async (e: SubmitEvent) => {
    e.preventDefault();
    if (props.saving) return;
    try {
      await props.onSave(draft());
    } catch {
    }
  };
  return (
    <Show when={props.open}>
      <div
        class="admin-backdrop"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) props.onClose();
        }}
      >
        <aside
          ref={(el) => (panel = el)}
          class="admin-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Manage your gallery"
        >
          <header class="panel-head">
            <div>
              <h2>Gallery settings</h2>
            </div>
            <button
              class="icon-button"
              onClick={props.onClose}
              aria-label="Close settings"
            >
              <X size={19} />
            </button>
          </header>
          <form class="settings-form" onSubmit={save}>
            <label for="event-title">Event title</label>
            <input
              id="event-title"
              maxLength={120}
              value={draft().title}
              disabled={props.saving}
              onInput={(e) =>
                setDraft((v) => ({ ...v, title: e.currentTarget.value }))
              }
              required
            />
            <label for="event-date">Event date</label>
            <input
              id="event-date"
              type="date"
              value={draft().date?.slice(0, 10) || ""}
              disabled={props.saving}
              onInput={(e) =>
                setDraft((v) => ({ ...v, date: e.currentTarget.value }))
              }
            />
            <label for="event-description">A few words about this event</label>
            <textarea
              id="event-description"
              rows={3}
              maxLength={1000}
              value={draft().description}
              disabled={props.saving}
              onInput={(e) =>
                setDraft((v) => ({ ...v, description: e.currentTarget.value }))
              }
              placeholder="A note to set the scene…"
            />
            <Show
              when={
                draft().title !== props.event.title ||
                draft().date !== props.event.date ||
                draft().description !== props.event.description
              }
            >
              <button
                type="submit"
                class="button button-dark save-button"
                disabled={props.saving}
              >
                {props.saving ? <LoaderCircle size={15} /> : <Check size={15} />}{" "}
                Save event details
              </button>
            </Show>
          </form>
          <div class="panel-divider" />
          <section class="setting-group">
            <span class="setting-title">Who can see this?</span>
            <p>Private keeps the gallery behind its guest password.</p>
            <div
              class="visibility-switch"
              role="group"
              aria-label="Gallery visibility"
              aria-busy={props.saving}
            >
              <button
                class={props.event.visibility === "private" ? "active" : ""}
                disabled={props.saving}
                aria-pressed={props.event.visibility === "private"}
                onClick={() => props.onVisibility("private")}
              >
                <LockKeyhole size={15} /> Private
              </button>
              <button
                class={props.event.visibility === "public" ? "active" : ""}
                disabled={props.saving}
                aria-pressed={props.event.visibility === "public"}
                onClick={() => props.onVisibility("public")}
              >
                <Eye size={15} /> Public
              </button>
            </div>
            <Show when={props.saving}>
              <p role="status">Saving gallery settings…</p>
            </Show>
          </section>
          <div class="panel-divider" />
          <GalleryPasswordSettings slug={props.slug} onUnauthorized={props.onUnauthorized} />
          <div class="panel-divider" />
          <section class="setting-group">
            <div class="setting-row">
              <div>
                <span class="setting-title">Add photographs</span>
                <p>JPEG, PNG, WebP and HEIC · up to 50 MiB each</p>
              </div>
              <button
                class="icon-button outlined"
                onClick={props.onAdd}
                aria-label="Choose photos to upload"
              >
                <ImagePlus size={18} />
              </button>
            </div>
            <p class="upload-recovery-help">
              Unfinished uploads can be saved on this device for 7 days, up to
              100 photos or 200 MiB. Sign in here again to resume them.
            </p>
            <Show when={props.recoveryWarning}>
              <p class="queue-error" role="status">
                {props.recoveryWarning} Keep this tab open until uploads finish.
              </p>
            </Show>
            <Show when={props.busy && !props.recoveryWarning}>
              <p class="upload-recovery-help" role="status">
                {props.queue.some((task) => ["queued", "processing", "uploading"].includes(task.status) && !task.savedForRecovery)
                  ? "Saving files for recovery… keep this tab open."
                  : "Unfinished uploads are saved on this device."}
              </p>
            </Show>
            <Show when={props.queue.some((task) => task.status === "paused")}>
              <div class="upload-recovery" role="status">
                <p>Resume your unfinished photographs. Photos already added will stay in the gallery.</p>
                <div class="recovery-actions">
                  <button class="text-button" onClick={props.onResume}>Resume saved uploads</button>
                  <button class="text-button" onClick={props.onDiscardSaved}>Discard saved uploads</button>
                </div>
              </div>
            </Show>
            <Show when={props.queue.length > 0}>
              <div class="upload-queue" aria-live="polite">
                <div class="queue-head">
                  <span>
                    {props.busy
                      ? "Uploading your photographs"
                      : "Recent uploads"}
                  </span>
                  <Show when={props.busy}>
                    <button class="text-button" onClick={props.onCancel}>
                      Cancel remaining
                    </button>
                  </Show>
                </div>
                <For each={props.queue}>
                  {(f) => (
                    <div class="queue-item" classList={{ "has-actions": ["error", "paused", "cancelled"].includes(f.status) }}>
                      <span class={`queue-file-icon ${f.status}`}>
                        <ImagePlus size={16} />
                      </span>
                      <div class="queue-file">
                        <span class="queue-filename" title={f.file.name}>
                          {f.file.name}
                        </span>
                        <Show
                          when={f.status === "error"}
                          fallback={
                            <small>
                              {f.status === "queued"
                                ? "Waiting"
                                : f.status === "processing"
                                  ? "Preparing photo…"
                                  : f.status === "uploading"
                                    ? "Uploading…"
                                    : f.status === "complete"
                                      ? "Added to gallery"
                                      : f.status === "paused"
                                        ? `Saved · interrupted at ${f.progress}%`
                                        : "Cancelled"}
                            </small>
                          }
                        >
                          <small class="queue-error">{f.error}</small>
                        </Show>
                        <Show
                          when={
                            f.status === "processing" ||
                            f.status === "uploading"
                          }
                        >
                          <span
                            class="progress-track"
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={f.progress}
                            aria-label={`${f.file.name} upload progress`}
                          >
                            <span
                              style={{ width: `${Math.max(f.progress, 6)}%` }}
                            />
                          </span>
                        </Show>
                      </div>
                      <Show
                        when={["error", "paused", "cancelled"].includes(f.status)}
                        fallback={
                          <Show
                            when={
                              f.status === "complete" ||
                              f.status === "cancelled"
                            }
                          >
                            <button
                              class="mini-action"
                              onClick={() => props.onDiscard(f.id)}
                              aria-label={`Dismiss ${f.file.name}`}
                            >
                              <X size={15} />
                            </button>
                          </Show>
                        }
                      >
                        <div class="queue-actions">
                          <button
                            class="mini-action"
                            onClick={() => props.onRetry(f)}
                            aria-label={`${f.status === "paused" ? "Resume" : "Retry"} ${f.file.name}`}
                          >
                            {f.status === "paused" ? "Resume" : "Retry"}
                          </button>
                          <button class="mini-action" onClick={() => props.onDiscard(f.id)} aria-label={`Discard ${f.file.name}`}>
                            <X size={15} />
                          </button>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show when={props.uploadListing.total > 0}>
              <p class="unfinished-upload-count" role="status">
                Unfinished uploads · {props.uploads.length} of {props.uploadListing.total} loaded
              </p>
            </Show>
            <For
              each={props.uploads.filter(
                (u) => (u.status === "pending" || u.status === "deleting") &&
                  !props.queue.some((task) => task.id === u.id),
              )}
            >
              {(u) => (
                <div class="pending-upload">
                  <span>
                    <LoaderCircle size={15} />
                    <span>
                      <strong>{u.filename}</strong>
                      <small>
                        {u.status === "deleting"
                          ? "Removal pending · select to retry"
                          : "Upload needs attention · remove to retry"}
                      </small>
                    </span>
                  </span>
                  <button
                    class="mini-action danger"
                    onClick={() => props.onRemoveUpload(u)}
                    aria-label={`Remove unfinished upload ${u.filename}`}
                    title="Remove unfinished upload"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              )}
            </For>
            <Show when={props.uploadListing.error}>
              <p class="queue-error" role="alert">{props.uploadListing.error}</p>
            </Show>
            <Show when={props.uploadListing.nextCursor || props.uploadListing.error}>
              <button
                class="button button-outline unfinished-upload-more"
                disabled={props.uploadListing.loading}
                onClick={() => props.uploadListing.nextCursor ? props.onLoadMoreUploads() : props.onReloadUploads()}
              >
                {props.uploadListing.loading ? "Loading unfinished uploads…" : props.uploadListing.error ? "Retry loading unfinished uploads" : "Load more unfinished uploads"}
              </button>
            </Show>
          </section>
          <div class="panel-divider" />
          <div class="admin-note">
            <ShieldCheck size={18} />
            <p>
              Your photos are stored privately. Original files are kept exactly
              as you uploaded them.
            </p>
          </div>
          <div class="panel-divider" />
          <section class="setting-group">
            <span class="setting-title">Support Adaptive Gallery</span>
            <p>Help support ongoing development.</p>
            <SponsorLink />
          </section>
        </aside>
      </div>
    </Show>
  );
}

function ViewerImage(props: {
  media: GalleryMediaClient;
  photo: Photo;
  adjacent?: Photo;
}) {
  const [displayed, setDisplayed] = createSignal<{ url: string; id: string; filename: string } | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [failed, setFailed] = createSignal(false);
  const [retry, setRetry] = createSignal(0);
  const cache = new ViewerImageCache(props.media);
  let generation = 0;

  createEffect(() => {
    const photo = props.photo;
    const adjacent = props.adjacent;
    retry();
    const request = ++generation;
    cache.retain(adjacent ? [photo.id, adjacent.id] : [photo.id]);
    setLoading(true);
    setFailed(false);
    void cache.prepare(photo).then(
      (decoded) => {
        if (request !== generation) return;
        setDisplayed({ url: decoded.url, id: photo.id, filename: photo.filename });
        setLoading(false);
      },
      () => {
        if (request !== generation) return;
        setDisplayed(null);
        setFailed(true);
        setLoading(false);
      },
    );
    if (adjacent) void cache.prepare(adjacent).catch(() => {});
    onCleanup(() => { generation++; });
  });
  onCleanup(() => cache.dispose());

  return (
    <>
      <Show when={displayed()}>
        {(image) => <img src={image().url} alt={image().filename} decoding="async" draggable={false} />}
      </Show>
      <Show when={loading()}>
        <span class="viewer-image-status" role="status" aria-live="polite">Loading photograph…</span>
      </Show>
      <Show when={failed()}>
        <div class="viewer-fail" role="alert">
          <CircleAlert size={22} />
          <span>This photograph could not be loaded.</span>
          <button class="button button-outline" onClick={() => setRetry((n) => n + 1)}>Retry</button>
        </div>
      </Show>
    </>
  );
}

function Viewer(props: {
  media: GalleryMediaClient;
  photo: Photo;
  adjacent?: Photo;
  index: number;
  total: number;
  pageLoading: boolean;
  pageError: string;
  onRetryPage: () => void;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  admin: boolean;
  onDelete: () => void;
}) {
  let dialog: HTMLDialogElement | undefined;
  let surface: HTMLDivElement | undefined;
  let gestures: ReturnType<typeof createViewerGestures> | undefined;
  const [zoomed, setZoomed] = createSignal(false);
  const panKey = (event: KeyboardEvent) => {
    if (!zoomed() || event.altKey || event.ctrlKey || event.metaKey) return;
    const offsets: Record<string, [number, number]> = {
      ArrowLeft: [64, 0], ArrowRight: [-64, 0],
      ArrowUp: [0, 64], ArrowDown: [0, -64],
    };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    gestures?.panBy(...offset);
  };
  onMount(() => {
    dialog?.showModal();
    if (surface) gestures = createViewerGestures(surface, () => surface!.querySelector("img"), {
      onPrevious: () => { if (props.index > 0) props.onPrevious(); },
      onNext: () => { if (props.index < props.total - 1) props.onNext(); },
      onZoomChange: setZoomed,
    });
    // Capture before Solid's delegated handlers and the gallery arrow navigation.
    document.addEventListener("keydown", panKey, true);
  });
  createEffect(() => {
    props.photo.id;
    gestures?.reset();
  });
  onCleanup(() => {
    gestures?.dispose();
    document.removeEventListener("keydown", panKey, true);
    if (dialog?.open) dialog.close();
  });
  return (
    <dialog
      ref={(el) => (dialog = el)}
      class="viewer"
      aria-label={`Photograph ${props.index + 1}: ${props.photo.filename}`}
      aria-describedby="viewer-instructions"
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <p id="viewer-instructions" class="visually-hidden">
        Use the arrows or swipe to change photographs. Pinch, double click or use the zoom button to zoom.
        When zoomed, drag or use the arrow keys to pan. Escape closes the photograph.
      </p>
      <header class="viewer-header">
        <div>
          <span class="viewer-counter">
            {String(props.index + 1).padStart(2, "0")} <i>/</i>{" "}
            {String(props.total).padStart(2, "0")}
          </span>
          <span class="viewer-title">{props.photo.filename}</span>
        </div>
        <div class="viewer-tools">
          <button
            class="icon-button"
            onClick={() => gestures?.toggleZoom()}
            aria-label={zoomed() ? "Reset photograph zoom" : "Zoom in on photograph"}
            aria-pressed={zoomed()}
            title={zoomed() ? "Reset zoom" : "Zoom in"}
          >
            <Show when={zoomed()} fallback={<ZoomIn size={19} />}><ZoomOut size={19} /></Show>
          </button>
          <a
            class="icon-button"
            href={props.media.proxyUrl(props.photo.id, "original")}
            onClick={(event) => downloadOriginal(event, props.media, props.photo.id)}
            aria-label={`Download original ${props.photo.filename}`}
            title="Download original"
          >
            <ArrowDownToLine size={19} />
          </a>
          <Show when={props.admin}>
            <button
              class="icon-button"
              onClick={props.onDelete}
              aria-label="Delete photograph"
              title="Delete photograph"
            >
              <Trash2 size={17} />
            </button>
          </Show>
          <button
            class="icon-button"
            data-viewer-close
            onClick={props.onClose}
            aria-label="Close photograph"
          >
            <X size={21} />
          </button>
        </div>
      </header>
      <div class="viewer-stage">
        <Show when={props.index > 0}>
          <button
            class="viewer-nav previous"
            onClick={props.onPrevious}
            aria-label="Previous photograph"
          >
            <ArrowLeft size={21} />
          </button>
        </Show>
        <div class="viewer-image-surface" ref={surface} classList={{ "is-zoomed": zoomed() }}>
          <ViewerImage media={props.media} photo={props.photo} adjacent={props.adjacent} />
        </div>
        <Show when={props.pageLoading || props.pageError}>
          <div class="viewer-page-status" role={props.pageError ? "alert" : "status"}>
            <span>{props.pageError || "Loading more photographs…"}</span>
            <Show when={props.pageError}>
              <button class="button button-outline" onClick={props.onRetryPage}>Retry loading photographs</button>
            </Show>
          </div>
        </Show>
        <Show when={props.index < props.total - 1}>
          <button
            class="viewer-nav next"
            onClick={props.onNext}
            aria-label="Next photograph"
            aria-busy={props.pageLoading}
          >
            <ArrowRight size={21} />
          </button>
        </Show>
      </div>
      <footer class="viewer-footer">
        <span>
          {props.photo.width.toLocaleString()} ×{" "}
          {props.photo.height.toLocaleString()} px
        </span>
        <span>{bytesLabel(props.photo.bytes)}</span>
        <span>
          {props.photo.contentType.replace("image/", "").toUpperCase()}
        </span>
      </footer>
    </dialog>
  );
}

function downloadOriginal(
  event: MouseEvent,
  media: GalleryMediaClient,
  photoId: string,
) {
  event.preventDefault();
  void media.resolve(photoId, "original").then((url) => {
    if (url) window.location.assign(url);
  });
}
const emptyEvent: EventSettings = {
  title: "A collection of moments",
  date: "",
  description: "",
  visibility: "private",
  coverPhotoId: null,
};
const bytesLabel = (n: number) =>
  n < 1024 * 1024
    ? `${Math.ceil(n / 1024)} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;
const dateLabel = (v: string) => {
  if (!v) return "";
  const d = new Date(`${v.slice(0, 10)}T12:00:00`);
  return Number.isNaN(+d)
    ? v
    : new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(d);
};

export function App() {
  const path = window.location.pathname;
  const match = path.match(/^\/g\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
  if (match) return <GalleryApp slug={match[1]} />;
  if (path === "/" || path === "/admin" || path === "/admin/") return <Galleries />;
  return <main class="screen-state"><h1>Page not found</h1><a class="button button-dark" href="/">Browse galleries</a></main>;
}

function GalleryApp(props: { slug: string }) {
  // Navigation uses real links so every upload queue keeps its original gallery.
  const slug = props.slug;
  const api = <T,>(path: string, init?: RequestInit) =>
    galleryRequest<T>(slug, path, init);
  const media = new GalleryMediaClient(slug);
  const removeMediaDiagnostics = installMediaDiagnostics(media);
  const [session, setSession] = createSignal<SessionResponse | null>(null),
    [gallery, setGallery] = createSignal<GalleryResponse | null>(null),
    [loading, setLoading] = createSignal(true),
    [loadingMore, setLoadingMore] = createSignal(false),
    [pageError, setPageError] = createSignal(""),
    [error, setError] = createSignal(""),
    [notice, setNotice] = createSignal<Notice | null>(null),
    [viewer, setViewer] = createSignal<number | null>(null),
    [requestedPhotoId, setRequestedPhotoId] = createSignal(viewerPhotoId(window.location.href)),
    [adminPanel, setAdminPanel] = createSignal(false),
    [loginOpen, setLoginOpen] = createSignal(false),
    [needsAdminSignIn, setNeedsAdminSignIn] = createSignal(false),
    [queue, setQueue] = createSignal<QueuedFile[]>([]),
    [busy, setBusy] = createSignal(false);
  const [savingEvent, setSavingEvent] = createSignal(false);
  const [recoveryWarning, setRecoveryWarning] = createSignal("");
  const [uploadListing, setUploadListing] = createSignal<AdminUploadListing>({
    uploads: [], total: 0, nextCursor: null, loading: false, error: "",
  });
  const uploads = () => uploadListing().uploads;
  const uploadPages = createAdminUploadListing(
    (cursor, signal) => api<AdminUploadsResponse>(`/api/admin/uploads?cursor=${encodeURIComponent(cursor)}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    }),
    setUploadListing,
  );
  let uploadQueue: ReturnType<typeof createUploadQueue> | undefined;
  let photoGrid: PhotoGridHandle | undefined;
  let loadGeneration = 0;
  let disposed = false;
  let pickRef: HTMLInputElement | undefined;
  let previousFocus: HTMLElement | null = null;
  let pendingViewerIndex: number | null = null;
  let attemptedPrefetchCursor: string | null = null;
  let photoPageRequest: AbortController | undefined;
  const navigation = createViewerNavigation(window, (id) => {
    pendingViewerIndex = null;
    setRequestedPhotoId(id);
  });
  const selectViewer = (index: number) => {
    const photo = gallery()?.photos[index];
    if (!photo) return;
    navigation.open(photo.id);
    setViewer(index);
  };
  const closeViewer = () => {
    pendingViewerIndex = null;
    navigation.close();
  };
  const previousViewer = () => {
    pendingViewerIndex = null;
    const index = viewer();
    if (index !== null && index > 0) selectViewer(index - 1);
  };
  const load = async (keepMessage = false) => {
    const generation = ++loadGeneration;
    photoPageRequest?.abort();
    photoPageRequest = undefined;
    pendingViewerIndex = null;
    attemptedPrefetchCursor = null;
    setLoadingMore(false);
    setPageError("");
    const current = () => !disposed && generation === loadGeneration;
    setLoading(true);
    setError("");
    if (!keepMessage) setNotice(null);
    uploadPages.reset();
    try {
      const s = await api<SessionResponse>("/api/session");
      if (!current()) return;
      setSession(s);
      if (s.role === "admin") setNeedsAdminSignIn(false);
      if (s.canView) {
        const g = await api<GalleryResponse>("/api/gallery");
        if (!current()) return;
        media.setManifest(g.media);
        setGallery(g);
        if (s.role === "admin") {
          try {
            const pending = await api<AdminUploadsResponse>("/api/admin/uploads", { signal: AbortSignal.timeout(10_000) });
            if (!current()) return;
            uploadPages.reset(pending);
          } catch (cause) {
            if (current()) uploadPages.fail(cause);
          }
        } else uploadPages.reset();
      } else {
        media.clear();
        setGallery(null);
      }
    } catch (e) {
      if (!current()) return;
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        media.clearAll();
      }
      setError(
        e instanceof Error ? e.message : "The gallery could not be loaded.",
      );
    } finally {
      if (current()) {
        setLoading(false);
      }
    }
  };
  const uploadRefresh = createUploadBatchRefresh(() => load(true));
  createEffect(() => {
    if (session()?.role !== "admin") {
      uploadQueue?.cancel();
      return;
    }
    if (uploadQueue) return;
    setRecoveryWarning("");
    uploadQueue = createUploadQueue((tasks) => {
      setQueue(tasks);
      setBusy(
        tasks.some((t) =>
          ["queued", "processing", "uploading"].includes(t.status),
        ),
      );
      uploadRefresh.update(tasks);
      if (tasks.some((task) => task.status === "paused")) setAdminPanel(true);
    }, {
      apiPath: (path) => galleryApiPath(slug, path),
      recovery: createUploadRecoveryStore(slug),
      recoveryLockName: `adaptive-gallery-upload-recovery:${slug}`,
      onRecoveryWarning: setRecoveryWarning,
    });
    void uploadQueue.restore();
  });
  onMount(() => {
    void load();
  });
  onCleanup(() => {
    disposed = true;
    loadGeneration++;
    uploadRefresh.dispose();
    uploadQueue?.dispose();
    uploadPages.dispose();
    photoPageRequest?.abort();
    media.dispose();
    removeMediaDiagnostics();
    navigation.dispose();
  });
  const viewerOpen = createMemo(() => viewer() !== null);
  let advanceViewer: () => void = () => {};
  createEffect(() => {
    if (!viewerOpen()) return;
    previousFocus = document.activeElement as HTMLElement;
    const previousPhotoId = previousFocus.closest<HTMLElement>("[data-photo-id]")?.dataset.photoId
      ?? untrack(() => gallery()?.photos[viewer()!]?.id);
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(
      () => document.querySelector<HTMLElement>("dialog.viewer [data-viewer-close]")?.focus(),
      10,
    );
    const key = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || (e.target instanceof HTMLElement && e.target.matches("input,textarea,[contenteditable=true]"))) return;
      if (e.key === "ArrowRight") { e.preventDefault(); advanceViewer(); }
      else if (e.key === "ArrowLeft") {
        e.preventDefault();
        previousViewer();
      }
    };
    document.addEventListener("keydown", key);
    onCleanup(() => {
      clearTimeout(timer);
      document.removeEventListener("keydown", key);
      document.body.style.overflow = "";
      if (previousFocus?.isConnected && previousFocus !== document.body) previousFocus.focus();
      else if (previousPhotoId) photoGrid?.focusPhoto(previousPhotoId);
    });
  });
  const signOut = async () => {
    loadGeneration++;
    photoPageRequest?.abort();
    photoPageRequest = undefined;
    setLoadingMore(false);
    pendingViewerIndex = null;
    uploadPages.reset();
    media.clearAll();
    try {
      await api("/api/logout", { method: "POST", body: "{}" });
      let recoveryCleared = true;
      try {
        await uploadQueue?.forget();
        await clearAllUploadRecovery();
      } catch {
        recoveryCleared = false;
      }
      uploadQueue?.dispose();
      uploadQueue = undefined;
      setQueue([]);
      setBusy(false);
      setAdminPanel(false);
      setNeedsAdminSignIn(false);
      await load();
      if (!recoveryCleared) setNotice({ kind: "error", text: "Signed out, but saved uploads could not be cleared. Remove this site's stored data on a shared device." });
    } catch (e) {
      setNotice({
        kind: "error",
        text: e instanceof Error ? e.message : "Could not sign out.",
      });
    }
  };
  const deletePhoto = async (p: Photo) => {
    if (
      !confirm(
        `Delete “${p.filename}” from this gallery? This cannot be undone.`,
      )
    )
      return;
    try {
      await api(`/api/admin/photos/${encodeURIComponent(p.id)}`, {
        method: "DELETE",
      });
      setNotice({ kind: "success", text: "Photo deleted." });
      await load(true);
    } catch (e) {
      setNotice({
        kind: "error",
        text:
          e instanceof Error
            ? e.message
            : "Could not delete this photo. Try again.",
      });
    }
  };
  const loadMore = async () => {
    const g = gallery();
    if (!g?.nextCursor || loadingMore()) return false;
    const request = photoPageRequest = new AbortController();
    const generation = loadGeneration;
    const current = () => !disposed && !request.signal.aborted && generation === loadGeneration && gallery() === g;
    setLoadingMore(true);
    setPageError("");
    try {
      const n = await api<GalleryResponse>(
        `/api/gallery?cursor=${encodeURIComponent(g.nextCursor)}`,
        { signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]) },
      );
      if (!current()) return false;
      media.setManifest(n.media);
      setGallery((c) => (c ? { ...n, photos: [...c.photos, ...n.photos] } : n));
      if (pendingViewerIndex !== null && viewer() === pendingViewerIndex - 1) {
        selectViewer(pendingViewerIndex);
        pendingViewerIndex = null;
      }
      return true;
    } catch (e) {
      if (!current()) return false;
      const text = e instanceof Error ? e.message : "Could not load more photos.";
      setPageError(text);
      setNotice({ kind: "error", text });
      pendingViewerIndex = null;
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        media.clearAll();
        setViewer(null);
        await load(true);
      }
      return false;
    } finally {
      if (photoPageRequest === request) {
        photoPageRequest = undefined;
        setLoadingMore(false);
      }
    }
  };
  advanceViewer = () => {
    const index = viewer();
    const current = gallery();
    if (index === null || !current) return;
    const action = viewerNextAction({
      index,
      loaded: current.photos.length,
      total: current.total,
      hasMore: Boolean(current.nextCursor),
    });
    if (action.kind === "advance") selectViewer(action.index);
    else if (action.kind === "load") {
      pendingViewerIndex = action.index;
      if (!loadingMore()) {
        void loadMore().then((loaded) => {
          if (!loaded && pendingViewerIndex === action.index) pendingViewerIndex = null;
        });
      }
    }
  };
  createEffect(() => {
    const index = viewer();
    const current = gallery();
    if (index === null || !current?.nextCursor || loadingMore()) return;
    const cursor = current.nextCursor;
    if (index >= current.photos.length - 2 && index < current.total - 1 && attemptedPrefetchCursor !== cursor) {
      attemptedPrefetchCursor = cursor;
      void loadMore();
    }
  });
  // Resolve shared links through the ordinary authorized, cursor-based listing.
  // Only one page is in flight, and failed pages require an explicit retry.
  createEffect(() => {
    const id = requestedPhotoId();
    const current = gallery();
    if (!id || !current) { setViewer(null); return; }
    const index = current.photos.findIndex((photo) => photo.id === id);
    if (index >= 0) { setViewer(index); return; }
    setViewer(null);
    if (loading() || loadingMore() || pageError()) return;
    if (current.nextCursor) {
      untrack(() => { void loadMore(); });
    } else {
      setNotice({ kind: "error", text: "This photograph is no longer available in this gallery." });
      untrack(closeViewer);
    }
  });
  createEffect(() => {
    const event = gallery()?.event;
    document.title = event ? `${event.title} · Adaptive Gallery` : "Adaptive Gallery";
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description) description.content = event?.description || "A private place for shared moments. An independent event photo gallery.";
  });
  const recoverAdminSession = async () => {
    media.clearAll();
    setAdminPanel(false);
    setViewer(null);
    setNeedsAdminSignIn(true);
    setSession(null);
    setGallery(null);
    uploadPages.reset();
    await load(true);
    if (session()?.canView && session()?.role !== "admin") setLoginOpen(true);
  };
  const updateEvent = async (ev: EventSettings) => {
    if (savingEvent()) return;
    setSavingEvent(true);
    try {
      const saved = await api<EventSettings>("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify(ev),
      });
      setGallery((c) => (c ? { ...c, event: saved } : c));
      setNotice({ kind: "success", text: "Event details saved." });
    } catch (e) {
      setNotice({
        kind: "error",
        text: e instanceof Error ? e.message : "Could not save event details.",
      });
      if (e instanceof ApiError && e.status === 401) {
        await recoverAdminSession();
      }
      throw e;
    } finally {
      setSavingEvent(false);
    }
  };
  const setVisibility = async (v: Visibility) => {
    const g = gallery();
    if (g && !savingEvent() && g.event.visibility !== v)
      try {
        await updateEvent({ ...g.event, visibility: v });
      if (g.event.visibility !== v) await load(true);
      } catch {}
  };
  const setCover = async (p: Photo) => {
    const g = gallery();
    if (g)
      try {
        await updateEvent({ ...g.event, coverPhotoId: p.id });
      } catch {}
  };
  const pickPhotos = () => {
    setAdminPanel(true);
    pickRef?.click();
  };
  const selectFiles = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement,
      files = [...(input.files || [])];
    input.value = "";
    if (files.length) {
      setAdminPanel(true);
      uploadQueue?.add(files);
    }
  };
  const removePending = async (u: UploadRecord) => {
    if (!confirm(`Remove the unfinished upload “${u.filename}”?`)) return;
    try {
      await api(`/api/admin/uploads/${encodeURIComponent(u.id)}`, {
        method: "DELETE",
      });
      uploadPages.remove(u.id);
    } catch (e) {
      setNotice({
        kind: "error",
        text:
          e instanceof Error
            ? e.message
            : "Could not remove the unfinished upload.",
      });
    }
  };
  return (
    <Show
      when={session()?.canView}
      fallback={
        <Show
          when={!session() && loading()}
          fallback={
            <Show
              when={!session() && error()}
              fallback={
                <AccessGate
                  slug={slug}
                  initialMode={needsAdminSignIn() ? "admin" : "guest"}
                  sessionExpired={needsAdminSignIn()}
                  onSignedIn={() => void load()}
                />
              }
            >
              <main class="screen-state">
                <h1>We couldn’t open the gallery.</h1>
                <p>{error()}</p>
                <button class="button button-dark" onClick={() => void load()}>
                  Try again
                </button>
              </main>
            </Show>
          }
        >
          <main class="screen-state">
            <div class="loader-mark">
              <LoaderCircle size={26} />
            </div>
            <p>Opening your gallery…</p>
          </main>
        </Show>
      }
    >
      <Show
        when={!loading() && gallery()}
        fallback={
          <main class="screen-state">
            <div class="loader-mark">
              <LoaderCircle size={26} />
            </div>
            <p>Gathering the photographs…</p>
            <Show when={error()}>
              <p>{error()}</p>
              <button class="button button-dark" onClick={() => void load()}>
                Try again
              </button>
            </Show>
          </main>
        }
      >
        {(() => {
          const ev = () => gallery()?.event || emptyEvent,
            photos = () => gallery()?.photos || [],
            cover = () =>
              photos().find((p) => p.id === ev().coverPhotoId) ||
              (!ev().coverPhotoId ? photos()[0] : undefined),
            coverId = () => ev().coverPhotoId || cover()?.id;
          return (
            <div class="site-shell">
              <a class="skip-link" href="#photographs">
                Skip to photographs
              </a>
              <header class="topbar">
                <a
                  class="wordmark"
                  href="/"
                  aria-label="Gallery, browse galleries"
                >
                  <span class="wordmark-icon">g.</span>
                  <span>gallery</span>
                </a>
                <div class="topbar-right">
                  <div class="gallery-nav-group">
                    <a class="button button-quiet gallery-index-link" href="/" aria-label="Browse galleries">
                      <ArrowLeft size={16} /> <span>Galleries</span>
                    </a>
                    <span class="event-pill">
                      <span class="status-dot" />
                      {ev().visibility === "public"
                        ? "Open gallery"
                        : "Private gallery"}
                    </span>
                  </div>
                  <Show
                    when={session()?.role === "admin"}
                    fallback={
                      <Show
                        when={session()?.role === "guest"}
                        fallback={
                          <button
                            class="button button-quiet admin-trigger"
                            aria-label="Admin sign in"
                            onClick={() => setLoginOpen(true)}
                          >
                            <LockKeyhole size={15} />
                            <span>Admin sign in</span>
                          </button>
                        }
                      >
                        <span class="guest-label">
                          <ShieldCheck size={15} /> Guest access
                        </span>
                        <button
                          class="icon-button"
                          onClick={() => void signOut()}
                          title="Sign out"
                          aria-label="Sign out"
                        >
                          <LogOut size={17} />
                        </button>
                      </Show>
                    }
                  >
                    <button
                      class="button button-quiet admin-trigger"
                      onClick={() => setAdminPanel((v) => !v)}
                      aria-expanded={adminPanel()}
                      aria-label="Manage gallery"
                    >
                      <Settings2 size={16} /> <span>Manage</span>
                    </button>
                    <button
                      class="icon-button"
                      onClick={() => void signOut()}
                      title="Sign out"
                      aria-label="Sign out"
                    >
                      <LogOut size={17} />
                    </button>
                  </Show>
                </div>
              </header>
              <main id="top">
                <Show
                  when={coverId()}
                  fallback={
                    <section class="hero hero-empty">
                      <div class="hero-copy">
                        <h1>{ev().title || emptyEvent.title}</h1>
                        <Show when={ev().date}>
                          <p class="event-date">{dateLabel(ev().date)}</p>
                        </Show>
                        <Show when={ev().description}>
                          <p class="event-description">{ev().description}</p>
                        </Show>
                        <Show
                          when={session()?.role === "admin"}
                          fallback={
                            <p class="empty-line">
                              Photographs will appear here when they’re added.
                            </p>
                          }
                        >
                          <button
                            class="button button-dark"
                            onClick={pickPhotos}
                          >
                            <ImagePlus size={17} /> Add the first photographs
                          </button>
                        </Show>
                      </div>
                      <PhotoStudy />
                    </section>
                  }
                >
                  <section
                    class="hero hero-with-cover"
                    aria-label="Event introduction"
                  >
                    <div class="hero-copy">
                      <h1>{ev().title || emptyEvent.title}</h1>
                    </div>
                    <div class="hero-details">
                      <Show when={ev().date}>
                        <p class="event-date">{dateLabel(ev().date)}</p>
                      </Show>
                      <Show when={ev().description}>
                        <p class="event-description">{ev().description}</p>
                      </Show>
                      <a class="hero-link" href="#photographs">
                        View photographs <ChevronDown size={16} />
                      </a>
                    </div>
                    <div class="hero-photo">
                      <GalleryImage
                        media={media}
                        photo={{ id: coverId()! }}
                        variant="preview"
                        alt=""
                        fetchpriority="high"
                      />
                      <span class="photo-caption">
                        {cover()?.filename || "Event cover"}
                      </span>
                    </div>
                  </section>
                </Show>
                <section
                  id="photographs"
                  class="gallery-section"
                  tabindex="-1"
                  aria-labelledby="photographs-title"
                >
                  <div class="section-heading">
                    <div>
                      <h2 id="photographs-title">Photographs</h2>
                    </div>
                    <div class="gallery-meta">
                      <span>
                        {gallery()?.total}{" "}
                        {gallery()?.total === 1 ? "photograph" : "photographs"}
                      </span>
                      <Show when={session()?.role === "admin"}>
                        <button
                          class="button button-dark add-button"
                          onClick={pickPhotos}
                        >
                          <Upload size={16} /> Add photos
                        </button>
                      </Show>
                    </div>
                  </div>
                  <Show when={requestedPhotoId() && viewer() === null}>
                    <div class="viewer-link-status" role="status">
                      <span>{pageError() || "Finding the shared photograph…"}</span>
                      <Show when={pageError()}>
                        <button class="button button-quiet" onClick={() => void loadMore()}>Retry</button>
                      </Show>
                      <button class="button button-quiet" onClick={closeViewer}>Cancel</button>
                    </div>
                  </Show>
                  <Show
                    when={photos().length > 0}
                    fallback={
                      <div class="gallery-empty">
                        <div class="empty-icon">
                          <ImagePlus size={22} />
                        </div>
                        <h3>No photographs yet</h3>
                        <p>
                          Photos added to this event will appear here.
                        </p>
                        <Show when={session()?.role === "admin"}>
                          <button
                            class="button button-dark"
                            onClick={pickPhotos}
                          >
                            <Upload size={16} /> Choose photographs
                          </button>
                        </Show>
                      </div>
                    }
                  >
                    <PhotoGrid items={photos()} ref={(handle) => { photoGrid = handle; }}>
                        {(p, i) => (
                          <>
                            <button
                              class="photo-open"
                              data-photo-open
                              onClick={() => selectViewer(i())}
                              aria-label={`Open ${p.filename}, photograph ${i() + 1} of ${gallery()?.total}`}
                            >
                              <GalleryImage
                                media={media}
                                photo={p}
                                variant="thumbnail"
                                alt={p.filename}
                                loading="lazy"
                                decoding="async"
                              />
                              <span class="photo-hover">
                                <Maximize2 size={19} />
                                <span>View photograph</span>
                              </span>
                            </button>
                            <div class="photo-info">
                              <span class="photo-name" title={p.filename}>
                                {p.filename}
                              </span>
                              <div class="photo-actions">
                                <Show when={session()?.role === "admin"}>
                                  <button
                                    class="mini-action"
                                    onClick={() => void setCover(p)}
                                    disabled={savingEvent()}
                                    aria-label={`Set ${p.filename} as cover`}
                                    title="Set as cover"
                                  >
                                    {ev().coverPhotoId === p.id ? (
                                      <span class="cover-tag">
                                        <Check size={11} /> Cover
                                      </span>
                                    ) : (
                                      <span class="cover-action">Cover</span>
                                    )}
                                  </button>
                                  <button
                                    class="mini-action danger"
                                    onClick={() => void deletePhoto(p)}
                                    aria-label={`Delete ${p.filename}`}
                                    title="Delete photo"
                                  >
                                    <Trash2 size={15} />
                                  </button>
                                </Show>
                                <a
                                  class="mini-action"
                                  href={media.proxyUrl(p.id, "original")}
                                  onClick={(event) => downloadOriginal(event, media, p.id)}
                                  aria-label={`Download original ${p.filename}`}
                                  title="Download original"
                                >
                                  <ArrowDownToLine size={16} />
                                </a>
                              </div>
                            </div>
                          </>
                        )}
                    </PhotoGrid>
                  </Show>
                  <Show when={gallery()?.nextCursor}>
                    <div class="load-more-wrap">
                      <button
                        class="button button-outline"
                        onClick={() => void loadMore()}
                        disabled={loadingMore()}
                      >
                        {loadingMore() ? (
                          <LoaderCircle size={16} />
                        ) : (
                          <ChevronDown size={17} />
                        )}{" "}
                        {loadingMore() ? "Loading…" : "Load more photographs"}
                      </button>
                    </div>
                  </Show>
                </section>
                <footer class="footer">
                  <span class="wordmark small">
                    <span class="wordmark-icon">g.</span>
                    <span>gallery</span>
                  </span>
                  <span>Every photograph, in one place.</span>
                  <div class="footer-links">
                    <RepositoryLink />
                    <a href="#top">Back to top ↑</a>
                  </div>
                </footer>
              </main>
              <Show when={session()?.role === "admin"}>
                <input
                  ref={(el) => (pickRef = el)}
                  class="visually-hidden"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
                  multiple
                  onChange={selectFiles}
                  aria-label="Choose photos to upload"
                />
                <AdminPanel
                  slug={slug}
                  open={adminPanel()}
                  event={ev()}
                  onClose={() => setAdminPanel(false)}
                  onSave={updateEvent}
                  onVisibility={setVisibility}
                  queue={queue()}
                  busy={busy()}
                  onRetry={(f) => uploadQueue?.retry(f.id)}
                  onCancel={() => uploadQueue?.cancel()}
                  recoveryWarning={recoveryWarning()}
                  onResume={() => uploadQueue?.resume()}
                  onDiscardSaved={() => {
                    void (async () => {
                      for (const task of queue().filter((task) => task.status === "paused")) {
                        try { await uploadQueue?.remove(task.id); }
                        catch (error) {
                          setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not discard saved uploads." });
                          break;
                        }
                      }
                    })();
                  }}
                  onDiscard={(id) =>
                    void uploadQueue?.remove(id).catch((e) =>
                      setNotice({
                        kind: "error",
                        text:
                          e instanceof Error
                            ? e.message
                            : "Could not remove the unfinished upload.",
                      }),
                    )
                  }
                  uploads={uploads()}
                  uploadListing={uploadListing()}
                  onLoadMoreUploads={() => void uploadPages.loadMore().catch((cause) => {
                    if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403))
                      void recoverAdminSession();
                  })}
                  onReloadUploads={() => void load(true)}
                  saving={savingEvent()}
                  onRemoveUpload={removePending}
                  onAdd={pickPhotos}
                  onUnauthorized={() => void recoverAdminSession()}
                />
              </Show>
              <Show when={loginOpen()}>
                <LoginDialog
                  onClose={() => setLoginOpen(false)}
                  onSignedIn={() => {
                    setLoginOpen(false);
                    void load();
                  }}
                />
              </Show>
              <Show when={notice()}>
                {(n) => (
                  <div class={`toast ${n().kind}`} role="status">
                    <span>
                      {n().kind === "success" ? (
                        <Check size={16} />
                      ) : (
                        <CircleAlert size={16} />
                      )}{" "}
                      {n().text}
                    </span>
                    <button
                      onClick={() => setNotice(null)}
                      aria-label="Dismiss message"
                    >
                      <X size={15} />
                    </button>
                  </div>
                )}
              </Show>
              <Show when={viewer() !== null ? photos()[viewer()!] : undefined}>
                {(p) => (
                  <Viewer
                    media={media}
                    photo={p()}
                    adjacent={photos()[viewer()! + 1]}
                    index={viewer()!}
                    total={gallery()?.total ?? photos().length}
                    pageLoading={loadingMore()}
                    pageError={pageError()}
                    onRetryPage={() => {
                      const index = viewer();
                      if (index !== null && index === photos().length - 1) pendingViewerIndex = index + 1;
                      void loadMore();
                    }}
                    onClose={closeViewer}
                    onPrevious={previousViewer}
                    onNext={advanceViewer}
                    admin={session()?.role === "admin"}
                    onDelete={() => {
                      const item = photos()[viewer()!];
                      pendingViewerIndex = null;
                      closeViewer();
                      if (item) void deletePhoto(item);
                    }}
                  />
                )}
              </Show>
            </div>
          );
        })()}
      </Show>
    </Show>
  );
}
