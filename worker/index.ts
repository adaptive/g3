import type {
  EventSettings,
  GalleryResponse,
  MediaManifest,
  Photo,
  Role,
  SessionResponse,
  UploadInput,
  UploadRecord,
  Variant,
} from "../src/shared/types";
import { MAX_FILE_BYTES, MAX_PIXELS, MEDIA_LEASE_MS } from "../src/shared/types";
import { createR2Signer } from "./r2-signing";
import { cleanupAbandonedUploads, cleanupDeletingGalleries } from "./maintenance";

interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
  meta?: { changes?: number };
}
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
interface D1Database {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<D1Result<T>[]>;
}
interface R2Object {
  body: ReadableStream<Uint8Array>;
  etag?: string;
  httpEtag?: string;
  httpMetadata?: { contentType?: string };
  size: number;
}
interface R2Bucket {
  put(
    key: string,
    body: ReadableStream | ArrayBuffer | ArrayBufferView,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string; contentDisposition?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
}
interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ASSETS: { fetch(request: Request): Promise<Response> };
  ADMIN_PASSWORD?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}
interface GalleryRow extends Record<string, unknown> {
  id: string;
  slug: string;
  title: string;
  event_date: string;
  description: string;
  visibility: string;
  cover_photo_id: string | null;
  password_salt: string | null;
  password_hash: string | null;
  password_version: number;
  created_at: string;
  status: string;
  photo_count: number;
}
const SESSION_COOKIE = "gallery_session";
const guestCookieName = (gallery: GalleryRow) => `gallery_access_${gallery.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
const SESSION_SECONDS = 60 * 60 * 12;
const PAGE_SIZE = 48;
const ADMIN_UPLOAD_PAGE_SIZE = 100;
const LIMITS: Record<Variant, number> = {
  original: MAX_FILE_BYTES,
  preview: 12 * 1024 * 1024,
  thumbnail: 2 * 1024 * 1024,
};
const VARIANTS: Variant[] = ["original", "thumbnail", "preview"];
type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "too_large"
  | "conflict"
  | "setup_required"
  | "internal_error";
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
  ) {
    super(code);
  }
}

const json = (value: unknown, status = 200, headers?: HeadersInit) => {
  const out = new Headers(headers);
  out.set("Content-Type", "application/json; charset=utf-8");
  out.set("Cache-Control", "no-store, max-age=0");
  out.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(value), { status, headers: out });
};
const errorResponse = (error: unknown) =>
  error instanceof HttpError
    ? json({ error: error.code }, error.status)
    : json({ error: "internal_error" }, 500);
function fail(status: number, code: ApiErrorCode): never {
  throw new HttpError(status, code);
}
const secureId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function configuredAdmin(env: Env): string {
  const admin = env.ADMIN_PASSWORD ?? "";
  if (admin.length < 12) fail(503, "setup_required");
  return admin;
}
const encoder = new TextEncoder();
async function hmac(message: string, password: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(message)),
  );
}
const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
function equal(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function signature(expires: number, env: Env) {
  return toBase64Url(await hmac(`admin.${expires}`, configuredAdmin(env)));
}
function requestCookie(request: Request, name = SESSION_COOKIE) {
  return (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? "";
}
async function verifySig(message: string, sig: string, secret: string) {
  const expected = await hmac(message, secret);
  const actual = Uint8Array.from(
    atob(sig.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (sig.length % 4)) % 4)),
    (char) => char.charCodeAt(0),
  );
  return equal(expected, actual);
}
async function session(request: Request, env: Env, gallery?: GalleryRow): Promise<Role | null> {
  try {
    const adminToken = requestCookie(request);
    const adminParts = adminToken.split(".");
    if (adminParts[0] === "admin" && adminParts.length === 3) {
      const [, expiryText, sig] = adminParts;
      const expiry = Number(expiryText);
      if (/^\d{10,}$/.test(expiryText) && sig && expiry > Math.floor(Date.now() / 1000) && expiry <= Math.floor(Date.now() / 1000) + SESSION_SECONDS + 60 && await verifySig(`admin.${expiry}`, sig, configuredAdmin(env))) return "admin";
    }
    if (!gallery) return null;
    const scopedToken = requestCookie(request, guestCookieName(gallery));
    const token = scopedToken || adminToken;
    if (!token) return null;
    const pieces = token.split(".");
    if (pieces[0] === "guest" && pieces.length === 5) {
      const [, galleryId, versionText, expiryText, sig] = pieces;
      const expiry = Number(expiryText), version = Number(versionText);
      if (galleryId !== gallery.id || !gallery.password_hash || version !== Number(gallery.password_version) || !/^\d{10,}$/.test(expiryText) || expiry <= Math.floor(Date.now() / 1000) || expiry > Math.floor(Date.now() / 1000) + SESSION_SECONDS + 60) return null;
      const valid = await verifySig(`guest.${galleryId}.${version}.${expiry}`, sig, configuredAdmin(env));
      return valid ? "guest" : null;
    }
    return null;
  } catch {
    return null;
  }
}
const cookie = (value: string, maxAge: number) =>
  `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
const namedCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
function requireRole(role: Role | null, required: Role) {
  if (!role) fail(401, "unauthorized");
  if (required === "admin" && role !== "admin") fail(403, "forbidden");
}
function checkMutation(request: Request) {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) fail(403, "forbidden");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
    fail(403, "forbidden");
}
async function bodyJson<T>(request: Request, maxBytes = 64 * 1024): Promise<T> {
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > maxBytes) fail(413, "too_large");
  if (!request.body) fail(400, "bad_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        fail(413, "too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as T;
    } catch {
      return fail(400, "bad_request");
    }
  } finally {
    reader.releaseLock();
  }
}
const safeFilename = (filename: string) => {
  const base = filename
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 180);
  return base || "photo";
};
const isImageType = (type: string): boolean =>
  [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
  ].includes(type.toLowerCase());
const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function validInput(value: unknown): UploadInput {
  if (!value || typeof value !== "object") return fail(400, "bad_request");
  const input = value as UploadInput;
  if (
    typeof input.filename !== "string" ||
    typeof input.contentType !== "string" ||
    !isImageType(input.contentType) ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 1 ||
    input.bytes > MAX_FILE_BYTES ||
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width < 1 ||
    input.height < 1 ||
    input.width * input.height > MAX_PIXELS
  )
    fail(400, "bad_request");
  return {
    filename: safeFilename(input.filename),
    contentType: input.contentType.toLowerCase(),
    bytes: input.bytes,
    width: input.width,
    height: input.height,
  };
}
function magicMatches(type: string, head: Uint8Array) {
  if (type === "image/jpeg")
    return (
      head.length >= 3 &&
      head[0] === 0xff &&
      head[1] === 0xd8 &&
      head[2] === 0xff
    );
  if (type === "image/png")
    return (
      head.length >= 8 &&
      head[0] === 0x89 &&
      head[1] === 0x50 &&
      head[2] === 0x4e &&
      head[3] === 0x47 &&
      head[4] === 0x0d &&
      head[5] === 0x0a &&
      head[6] === 0x1a &&
      head[7] === 0x0a
    );
  if (type === "image/webp")
    return (
      head.length >= 12 &&
      String.fromCharCode(...head.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...head.slice(8, 12)) === "WEBP"
    );
  if (type === "image/avif") {
    // AVIF uses the ISO base media file format. Accept either a declared AVIF
    // major brand or AVIF listed among the compatible brands in the ftyp box.
    if (head.length < 20 || String.fromCharCode(...head.slice(4, 8)) !== "ftyp")
      return false;
    const boxLength = (head[0] * 0x1000000) + (head[1] << 16) + (head[2] << 8) + head[3];
    if (boxLength < 16 || boxLength > 0xffffffff) return false;
    const brands = [String.fromCharCode(...head.slice(8, 12))];
    for (let offset = 16; offset + 4 <= Math.min(boxLength, head.length); offset += 4)
      brands.push(String.fromCharCode(...head.slice(offset, offset + 4)));
    return brands.some((brand) => brand === "avif" || brand === "avis");
  }
  if (type === "image/heic" || type === "image/heif")
    return (
      head.length >= 12 &&
      String.fromCharCode(...head.slice(4, 8)) === "ftyp" &&
      /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1|miaf)$/.test(
        String.fromCharCode(...head.slice(8, 12)),
      )
    );
  return false;
}
async function inspectAndPut(
  request: Request,
  key: string,
  type: string,
  limit: number,
  env: Env,
  filename?: string,
) {
  const stated = Number(request.headers.get("Content-Length") ?? 0);
  if (!Number.isSafeInteger(stated) || stated < 1) fail(400, "bad_request");
  if (stated > limit) fail(413, "too_large");
  if (
    (request.headers.get("Content-Type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase() !== type
  )
    fail(400, "bad_request");
  if (!request.body) fail(400, "bad_request");
  const reader = request.body.getReader();
  const first: Uint8Array[] = [];
  let firstLength = 0;
  let total = 0;
  // Read enough of the ISO BMFF ftyp box to see AVIF brands listed after the
  // major brand. This is still a small, fixed prefix before streaming to R2.
  while (firstLength < 64) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      fail(413, "too_large");
    }
    if (total > stated) {
      await reader.cancel();
      fail(400, "bad_request");
    }
    first.push(value);
    firstLength += value.byteLength;
  }
  const head = new Uint8Array(Math.min(firstLength, 64));
  let offset = 0;
  for (const chunk of first) {
    const prefix = chunk.subarray(0, head.length - offset);
    head.set(prefix, offset);
    offset += prefix.length;
    if (offset === head.length) break;
  }
  if (!magicMatches(type, head)) {
    await reader.cancel();
    fail(400, "bad_request");
  }
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (first.length) {
        controller.enqueue(first.shift()!);
        return;
      }
      try {
        const item = await reader.read();
        if (item.done) {
          if (total !== stated)
            controller.error(new HttpError(400, "bad_request"));
          else controller.close();
          return;
        }
        total += item.value.byteLength;
        if (total > stated) {
          controller.error(new HttpError(400, "bad_request"));
          await reader.cancel();
          return;
        }
        if (total > limit) {
          controller.error(new HttpError(413, "too_large"));
          await reader.cancel();
          return;
        }
        controller.enqueue(item.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  const fixed = new FixedLengthStream(stated);
  try {
    const results = await Promise.allSettled([
      env.PHOTOS.put(key, fixed.readable, {
        httpMetadata: {
          contentType: type,
          cacheControl: "private, no-store, max-age=0",
          ...(filename ? { contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` } : {}),
        },
      }),
      source.pipeTo(fixed.writable),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  } catch (error) {
    await env.PHOTOS.delete(key).catch(() => undefined);
    throw error;
  }
  return total;
}

async function findGallery(env: Env, slug: string): Promise<GalleryRow | null> {
  return env.DB.prepare("SELECT * FROM galleries WHERE slug = ?").bind(slug).first<GalleryRow>();
}
function galleryEvent(row: GalleryRow): EventSettings {
  return {
    title: row.title,
    date: row.event_date,
    description: row.description,
    visibility: row.visibility === "public" ? "public" : "private",
    coverPhotoId: row.cover_photo_id || null,
  };
}
function hasGalleryPassword(row: GalleryRow) {
  return Boolean(row.password_hash);
}
function gallerySummary(row: GalleryRow) {
  return {
    id: row.id,
    slug: row.slug,
    ...galleryEvent(row),
    createdAt: row.created_at,
    photoCount: Number(row.photo_count),
    hasPassword: hasGalleryPassword(row),
    status: row.status,
  };
}
async function galleries(env: Env, visibility?: "public") {
  const rows = await env.DB.prepare(`SELECT * FROM galleries ${visibility ? "WHERE status = 'active' AND visibility = 'public'" : ""} ORDER BY created_at DESC, slug`).all<GalleryRow>();
  return rows.results.map(gallerySummary);
}
const decodeBase64Url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4)), (char) => char.charCodeAt(0));
async function passwordHash(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt.slice().buffer as ArrayBuffer, iterations: 100_000 }, key, 256);
  return toBase64Url(new Uint8Array(bits));
}
async function makePassword(password: string, env: Env) {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024 || password === (env.ADMIN_PASSWORD ?? "")) fail(400, "bad_request");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: toBase64Url(salt), hash: await passwordHash(password, salt) };
}
async function matchesPassword(password: string, gallery: GalleryRow) {
  if (gallery.password_salt && gallery.password_hash) {
    try { return equal(decodeBase64Url(await passwordHash(password, decodeBase64Url(gallery.password_salt))), decodeBase64Url(gallery.password_hash)); } catch { return false; }
  }
  return false;
}
async function access(request: Request, env: Env, gallery: GalleryRow): Promise<{ role: Role | null; canView: boolean }> {
  const role = await session(request, env, gallery);
  return { role, canView: role === "admin" || gallery.visibility === "public" || role === "guest" };
}
const photoRow = (row: Record<string, unknown>): Photo => ({
  id: String(row.id),
  filename: String(row.filename),
  contentType: String(row.content_type),
  bytes: Number(row.bytes),
  width: Number(row.width),
  height: Number(row.height),
  createdAt: String(row.created_at),
});
type MediaSelection = { row: Record<string, unknown>; variant: Variant };
async function mediaManifest(
  env: Env,
  gallery: GalleryRow,
  role: Role | null,
  selections: MediaSelection[],
): Promise<MediaManifest | null> {
  let signer: ReturnType<typeof createR2Signer>;
  try { signer = createR2Signer(env); }
  catch { fail(503, "setup_required"); }
  if (!signer) return null;
  const expiresAt = Math.floor((Date.now() + MEDIA_LEASE_MS) / 1000) * 1000;
  const scope = toBase64Url(await hmac(
    `media-v1.${gallery.id}.${gallery.password_version}.${gallery.visibility}.${role ?? "anonymous"}`,
    configuredAdmin(env),
  ));
  const items = await Promise.all(selections.map(async ({ row, variant }) => {
    const key = String(row[`${variant}_key`]);
    // R2 keys are immutable per upload attempt. Replacing a variant changes its cache identity.
    const version = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(key))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const signed = await signer.signGet(key, {
      expiresAt,
      download: variant === "original",
      filename: variant === "original" ? String(row.filename) : undefined,
    });
    return { photoId: String(row.id), variant, version, ...signed };
  }));
  return { scope, expiresAt, items };
}
async function media(request: Request, env: Env, url: URL, gallery: GalleryRow) {
  const mediaPath = url.pathname.replace(/^\/api\/galleries\/[a-z0-9]+(?:-[a-z0-9]+)*/, "/api");
  const match = mediaPath.match(
    /^\/api\/photos\/([0-9a-f-]{36})\/(original|thumbnail|preview)$/i,
  );
  if (!match) fail(404, "not_found");
  const { role, canView } = await access(request, env, gallery);
  if (!canView) requireRole(role, "guest");
  const row = await env.DB.prepare(
    "SELECT filename, content_type, original_key, thumbnail_key, preview_key FROM photos WHERE id = ? AND gallery_id = ? AND status = 'published'",
  )
    .bind(match[1], gallery.id)
    .first<Record<string, unknown>>();
  if (!row) fail(404, "not_found");
  const variant = match[2] as Variant;
  const key = String(row[`${variant}_key`]);
  const object = await env.PHOTOS.get(key);
  if (!object) fail(404, "not_found");
  const headers = new Headers({
    "Cache-Control": variant === "original"
      ? "no-store, max-age=0"
      : "private, no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Type": variant === "original"
      ? String(row.content_type)
      : variant === "thumbnail"
        ? (object.httpMetadata?.contentType === "image/webp" || object.httpMetadata?.contentType === "image/avif"
          ? object.httpMetadata.contentType
          : "image/jpeg")
        : "image/jpeg",
  });
  if (variant !== "original") {
    // Variant keys are immutable for a published photo. This lets a private
    // browser cache reuse the bytes after an authorization check on revalidation.
    const identity = [gallery.id, gallery.password_version, gallery.visibility, row.id, variant, key, object.httpEtag ?? object.etag ?? "", object.size, headers.get("Content-Type")].join("\0");
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(identity));
    const etag = `"ag-${toBase64Url(new Uint8Array(digest))}"`;
    headers.set("ETag", etag);
    const ifNoneMatch = request.headers.get("If-None-Match");
    if (ifNoneMatch?.split(",").some((candidate) => {
      const value = candidate.trim();
      return value === "*" || value.replace(/^W\//, "") === etag;
    })) {
      await object.body.cancel();
      return new Response(null, { status: 304, headers });
    }
  }
  if (variant === "original")
    headers.set(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(String(row.filename))}`,
    );
  return new Response(object.body, { headers });
}

function escapeHtmlAttribute(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]!);
}

async function galleryHtml(request: Request, env: Env, url: URL, slug: string) {
  const upstream = await env.ASSETS.fetch(new Request(new URL("/", url), {
    headers: { Accept: "text/html" },
  }));
  if (!upstream.ok || !upstream.headers.get("Content-Type")?.includes("text/html")) return upstream;

  const gallery = await findGallery(env, slug);
  let title = "Adaptive Gallery";
  let description = "A private place for shared moments. An independent event photo gallery.";
  let coverUrl: string | null = null;
  let indexable = false;
  if (gallery?.status === "active" && gallery.visibility === "public") {
    title = gallery.title.trim() || title;
    description = gallery.description.trim() || `Photographs from ${title}.`;
    indexable = true;
    const cover = gallery.cover_photo_id
      ? await env.DB.prepare("SELECT id FROM photos WHERE id = ? AND gallery_id = ? AND status = 'published'").bind(gallery.cover_photo_id, gallery.id).first<{ id: string }>()
      : await env.DB.prepare("SELECT id FROM photos WHERE gallery_id = ? AND status = 'published' ORDER BY created_at DESC, id DESC LIMIT 1").bind(gallery.id).first<{ id: string }>();
    if (cover) coverUrl = new URL(`/api/galleries/${encodeURIComponent(slug)}/photos/${encodeURIComponent(cover.id)}/preview`, url.origin).href;
  }

  const canonical = new URL(`/g/${encodeURIComponent(slug)}`, url.origin).href;
  const tags = [
    `<link rel="canonical" href="${escapeHtmlAttribute(canonical)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHtmlAttribute(title)}">`,
    `<meta property="og:description" content="${escapeHtmlAttribute(description)}">`,
    `<meta property="og:url" content="${escapeHtmlAttribute(canonical)}">`,
    `<meta name="twitter:card" content="${coverUrl ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${escapeHtmlAttribute(title)}">`,
    `<meta name="twitter:description" content="${escapeHtmlAttribute(description)}">`,
    coverUrl ? `<meta property="og:image" content="${escapeHtmlAttribute(coverUrl)}"><meta name="twitter:image" content="${escapeHtmlAttribute(coverUrl)}">` : "",
    indexable ? "" : `<meta name="robots" content="noindex, nofollow">`,
  ].join("");
  const rewritten = new HTMLRewriter()
    .on("title", { element(element) { element.setInnerContent(title); } })
    .on('meta[name="description"]', { element(element) { element.setAttribute("content", description); } })
    .on("head", { element(element) { element.append(tags, { html: true }); } })
    .transform(upstream);
  const headers = securityHeaders(new Headers(rewritten.headers));
  headers.set("Cache-Control", "private, no-store, max-age=0");
  return new Response(request.method === "HEAD" ? null : rewritten.body, {
    status: rewritten.status,
    statusText: rewritten.statusText,
    headers,
  });
}

async function throttle(request: Request, env: Env) {
  const minute = Math.floor(Date.now() / 60_000);
  const addr = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const digest = toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(addr))),
  ).slice(0, 32);
  const buckets = [`ip:${digest}`, "global"];
  const limits = [8, 100];
  for (let index = 0; index < buckets.length; index++) {
    const result = await env.DB.prepare(
      "INSERT INTO login_attempts (bucket, window_start, count) VALUES (?, ?, 1) ON CONFLICT(bucket) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END, window_start = excluded.window_start RETURNING count",
    )
      .bind(buckets[index], minute)
      .first<{ count: number }>();
    if ((result?.count ?? limits[index] + 1) > limits[index])
      fail(429, "rate_limited");
  }
  await env.DB.prepare("DELETE FROM login_attempts WHERE window_start < ?")
    .bind(minute - 2880)
    .run();
}
interface AdminUploadCursor {
  v: 1;
  galleryId: string;
  createdAt: string;
  id: string;
  kind: 0 | 1;
}

interface GalleryPhotoCursor {
  v: 1;
  galleryId: string;
  createdAt: string;
  id: string;
}

function encodeGalleryPhotoCursor(cursor: GalleryPhotoCursor): string {
  return btoa(String.fromCharCode(...encoder.encode(JSON.stringify(cursor))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeGalleryPhotoCursor(value: string, galleryId: string): GalleryPhotoCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(value)) throw new Error("invalid");
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))) as Partial<GalleryPhotoCursor>;
    if (parsed.v !== 1 || parsed.galleryId !== galleryId || typeof parsed.createdAt !== "string" || parsed.createdAt.length > 64 || !Number.isFinite(Date.parse(parsed.createdAt)) || typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.id)) throw new Error("invalid");
    return parsed as GalleryPhotoCursor;
  } catch {
    fail(400, "bad_request");
  }
}

function encodeAdminUploadCursor(cursor: AdminUploadCursor): string {
  return btoa(String.fromCharCode(...encoder.encode(JSON.stringify(cursor))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeAdminUploadCursor(value: string, galleryId: string): AdminUploadCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(value)) throw new Error("invalid");
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))) as Partial<AdminUploadCursor>;
    if (parsed.v !== 1 || parsed.galleryId !== galleryId || typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt)) || typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.id) || (parsed.kind !== 0 && parsed.kind !== 1)) throw new Error("invalid");
    return parsed as AdminUploadCursor;
  } catch {
    fail(400, "bad_request");
  }
}

async function adminUploads(env: Env, galleryId: string, cursorToken: string | null) {
  const cursor = cursorToken !== null ? decodeAdminUploadCursor(cursorToken, galleryId) : null;
  const params: unknown[] = [galleryId];
  let uploadBoundary = "";
  let photoBoundary = "";
  if (cursor) {
    uploadBoundary = " AND (u.created_at < ? OR (u.created_at = ? AND (u.id < ? OR (u.id = ? AND 0 < ?))))";
    photoBoundary = " AND (p.created_at < ? OR (p.created_at = ? AND (p.id < ? OR (p.id = ? AND 1 < ?))))";
  }
  const uploadParams = [...params];
  const photoParams = [...params];
  if (cursor) {
    uploadParams.push(cursor.createdAt, cursor.createdAt, cursor.id, cursor.id, cursor.kind);
    photoParams.push(cursor.createdAt, cursor.createdAt, cursor.id, cursor.id, cursor.kind);
  }
  uploadParams.push(ADMIN_UPLOAD_PAGE_SIZE + 1);
  photoParams.push(ADMIN_UPLOAD_PAGE_SIZE + 1);
  const [uploadRows, photoRows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT u.*, GROUP_CONCAT(p.variant) AS variants, 0 AS kind FROM uploads u LEFT JOIN upload_parts p ON p.upload_id = u.id WHERE u.gallery_id = ?${uploadBoundary} GROUP BY u.id ORDER BY u.created_at DESC, u.id DESC LIMIT ?`,
    ).bind(...uploadParams).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT p.id, p.filename, p.content_type, p.bytes, p.width, p.height, p.created_at, 1 AS kind FROM photos p WHERE p.gallery_id = ? AND p.status = 'deleting'${photoBoundary} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
    ).bind(...photoParams).all<Record<string, unknown>>(),
    env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM uploads WHERE gallery_id = ?) + (SELECT COUNT(*) FROM photos WHERE gallery_id = ? AND status = 'deleting') AS total",
    ).bind(galleryId, galleryId).first<{ total: number }>(),
  ]);
  const rows = [...uploadRows.results, ...photoRows.results].sort((left, right) =>
    String(right.created_at).localeCompare(String(left.created_at)) ||
    String(right.id).localeCompare(String(left.id)) || Number(right.kind) - Number(left.kind),
  ).slice(0, ADMIN_UPLOAD_PAGE_SIZE + 1);
  const hasMore = rows.length > ADMIN_UPLOAD_PAGE_SIZE;
  const pageRows = rows.slice(0, ADMIN_UPLOAD_PAGE_SIZE);
  const uploads: UploadRecord[] = pageRows.map((row) => ({
    id: String(row.id),
    filename: String(row.filename),
    contentType: String(row.content_type),
    bytes: Number(row.bytes),
    width: Number(row.width),
    height: Number(row.height),
    createdAt: String(row.created_at),
    status: row.kind === 1 ? "deleting" : row.status as UploadRecord["status"],
    variants: row.kind === 1 ? VARIANTS : String(row.variants ?? "")
      .split(",")
      .filter((v): v is Variant => VARIANTS.includes(v as Variant)),
  }));
  const last = pageRows.at(-1);
  return {
    uploads,
    total: Number(count?.total ?? 0),
    nextCursor: hasMore && last ? encodeAdminUploadCursor({
      v: 1,
      galleryId,
      createdAt: String(last.created_at),
      id: String(last.id),
      kind: Number(last.kind) as 0 | 1,
    }) : null,
  };
}

async function handleApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  let pathname = url.pathname;
  const method = request.method;
  if (pathname === "/api/admin/maintenance" && method === "POST") {
    checkMutation(request);
    requireRole(await session(request, env), "admin");
    const uploads = await cleanupAbandonedUploads(env);
    const galleries = await cleanupDeletingGalleries(env);
    return json({ ...uploads, galleries });
  }
  if (pathname === "/api/galleries" && method === "GET") {
    const role = await session(request, env);
    return json({ galleries: await galleries(env, role === "admin" ? undefined : "public") });
  }
  if (pathname === "/api/admin/galleries" && method === "GET") {
    requireRole(await session(request, env), "admin");
    return json({ galleries: await galleries(env) });
  }
  if (pathname === "/api/admin/galleries" && method === "POST") {
    checkMutation(request);
    requireRole(await session(request, env), "admin");
    const body = await bodyJson<{ title?: string; slug?: string; date?: string; description?: string; visibility?: string; password?: string }>(request);
    if (!body || typeof body.title !== "string" || body.title.trim().length < 1 || body.title.length > 160 || typeof body.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug) || body.slug.length > 64 || (body.visibility !== "public" && body.visibility !== "private") || (body.date !== undefined && (typeof body.date !== "string" || body.date.length > 32)) || (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 4000))) fail(400, "bad_request");
    if (body.visibility === "private" && typeof body.password !== "string") fail(400, "bad_request");
    const id = secureId(), createdAt = now();
    const credentials = body.password !== undefined ? await makePassword(body.password, env) : null;
    try {
      await env.DB.prepare("INSERT INTO galleries (id, slug, title, event_date, description, visibility, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, body.slug, body.title.trim(), body.date ?? "", (body.description ?? "").trim(), body.visibility, credentials?.salt ?? null, credentials?.hash ?? null, createdAt).run();
    } catch { fail(409, "conflict"); }
    const row = await findGallery(env, body.slug);
    if (!row) fail(500, "internal_error");
    return json(gallerySummary(row), 201);
  }
  const managedGallery = pathname.match(/^\/api\/admin\/galleries\/([a-z0-9]+(?:-[a-z0-9]+)*)$/);
  if (managedGallery && method === "PATCH") {
    checkMutation(request);
    requireRole(await session(request, env), "admin");
    const row = await findGallery(env, managedGallery[1]);
    if (!row) fail(404, "not_found");
    if (row.status !== "active") fail(409, "conflict");
    const body = await bodyJson<{ title?: string; date?: string; description?: string; visibility?: string; coverPhotoId?: string | null; password?: string }>(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "bad_request");
    const title = body.title === undefined ? row.title : body.title;
    const date = body.date === undefined ? row.event_date : body.date;
    const description = body.description === undefined ? row.description : body.description;
    const visibility = body.visibility === undefined ? row.visibility : body.visibility;
    const coverPhotoId = body?.coverPhotoId === undefined ? row.cover_photo_id : body.coverPhotoId;
    if (typeof title !== "string" || !title.trim() || title.length > 160 || typeof date !== "string" || date.length > 32 || typeof description !== "string" || description.length > 4000 || (visibility !== "public" && visibility !== "private") || !(coverPhotoId === null || typeof coverPhotoId === "string")) fail(400, "bad_request");
    if (coverPhotoId) {
      const cover = await env.DB.prepare("SELECT id FROM photos WHERE id = ? AND gallery_id = ? AND status = 'published'").bind(coverPhotoId, row.id).first();
      if (!cover) fail(400, "bad_request");
    }
    let credentials: { salt: string; hash: string } | null = null;
    if (body.password !== undefined) credentials = await makePassword(body.password, env);
    if (visibility === "private" && !credentials && !hasGalleryPassword(row)) fail(400, "bad_request");
    // A password reset must not overwrite settings saved concurrently by another request.
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [field, column, value] of [
      ["title", "title", title.trim()],
      ["date", "event_date", date],
      ["description", "description", description.trim()],
      ["visibility", "visibility", visibility],
      ["coverPhotoId", "cover_photo_id", coverPhotoId],
    ] as const) {
      if (body[field] !== undefined) {
        fields.push(`${column} = ?`);
        values.push(value);
      }
    }
    if (credentials) {
      fields.push("password_salt = ?", "password_hash = ?", "password_version = password_version + 1");
      values.push(credentials.salt, credentials.hash);
    }
    if (fields.length) {
      const result = await env.DB.prepare(`UPDATE galleries SET ${fields.join(", ")} WHERE id = ? AND status = 'active'`)
        .bind(...values, row.id).run();
      if (!result.meta?.changes) fail(409, "conflict");
    }
    const updated = await findGallery(env, row.slug);
    if (!updated || updated.status !== "active") fail(409, "conflict");
    return json(gallerySummary(updated));
  }
  if (managedGallery && method === "DELETE") {
    checkMutation(request);
    requireRole(await session(request, env), "admin");
    const row = await findGallery(env, managedGallery[1]);
    if (!row) fail(404, "not_found");
    await env.DB.prepare("UPDATE galleries SET status = 'deleting' WHERE id = ? AND status = 'active'").bind(row.id).run();
    const activeAttempt = await env.DB.prepare("SELECT 1 AS active FROM upload_attempts a JOIN uploads u ON u.id = a.upload_id WHERE u.gallery_id = ? AND a.status = 'pending' LIMIT 1").bind(row.id).first<{ active: number }>();
    if (activeAttempt) fail(409, "conflict");
    const progress = await cleanupDeletingGalleries(env, { limit: 1, galleryId: row.id });
    return json({ ok: true, status: "deleting", progress });
  }

  const scoped = pathname.match(/^\/api\/galleries\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(.*))?$/);
  let gallery: GalleryRow | null = null;
  let route = pathname;
  if (scoped) {
    gallery = await findGallery(env, scoped[1]);
    if (!gallery) fail(404, "not_found");
    if (gallery.status !== "active") fail(404, "not_found");
    const suffix = scoped[2] ?? "";
    route = suffix.startsWith("admin/") ? `/api/${suffix}` : suffix.startsWith("photos/") ? `/api/${suffix}` : suffix ? `/api/${suffix}` : "/api/gallery";
    pathname = route;
  } else if (pathname === "/api/gallery" || pathname === "/api/media" || pathname.startsWith("/api/photos/") || pathname.startsWith("/api/admin/settings") || pathname.startsWith("/api/admin/uploads") || pathname.startsWith("/api/admin/photos/")) {
    gallery = await findGallery(env, "default");
    if (gallery && gallery.status !== "active") fail(404, "not_found");
  }
  if (gallery && gallery.status !== "active" && pathname !== "/api/session") fail(404, "not_found");
  if (scoped && (scoped[2] === "session" || scoped[2] === "login" || scoped[2] === "logout")) {
    if (!gallery) fail(404, "not_found");
    if (pathname === "/api/session" && method === "GET") return json(await access(request, env, gallery));
    if (pathname === "/api/login" && method === "POST") {
      checkMutation(request);
      await throttle(request, env);
      const payload = await bodyJson<{ role?: Role; password?: string }>(request, 8 * 1024);
      if (!payload || (payload.role !== "admin" && payload.role !== "guest") || typeof payload.password !== "string") fail(400, "bad_request");
      if (payload.role === "admin") {
        if (payload.password !== configuredAdmin(env)) fail(401, "unauthorized");
        const expiry = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
        const sig = await signature(expiry, env);
        return json({ role: "admin", canView: true } satisfies SessionResponse, 200, { "Set-Cookie": cookie(`admin.${expiry}.${sig}`, SESSION_SECONDS) });
      }
      if (!await matchesPassword(payload.password, gallery)) fail(401, "unauthorized");
      const expiry = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
      const version = Number(gallery.password_version);
      const sig = toBase64Url(await hmac(`guest.${gallery.id}.${version}.${expiry}`, configuredAdmin(env)));
      return json({ role: "guest", canView: true } satisfies SessionResponse, 200, { "Set-Cookie": namedCookie(guestCookieName(gallery), `guest.${gallery.id}.${version}.${expiry}.${sig}`, SESSION_SECONDS) });
    }
    if (pathname === "/api/logout" && method === "POST") {
      checkMutation(request);
      const headers = new Headers();
      headers.append("Set-Cookie", cookie("", 0));
      headers.append("Set-Cookie", namedCookie(guestCookieName(gallery), "", 0));
      return json({ ok: true }, 200, headers);
    }
    fail(404, "not_found");
  }
  if (pathname === "/api/session" && method === "GET") {
    const admin = (await session(request, env)) === "admin";
    const legacyGallery = await findGallery(env, "default");
    if (admin) return json({ role: "admin", canView: true });
    if (!legacyGallery || legacyGallery.status !== "active") return json({ role: null, canView: false });
    return json(await access(request, env, legacyGallery));
  }
  if (pathname === "/api/login" && method === "POST") {
    checkMutation(request);
    await throttle(request, env);
    const payload = await bodyJson<{ role?: Role; password?: string }>(
      request,
      8 * 1024,
    );
    if (
      !payload ||
      typeof payload !== "object" ||
      payload.role !== "admin" ||
      typeof payload.password !== "string"
    )
      fail(400, "bad_request");
    if (payload.password !== configuredAdmin(env)) fail(401, "unauthorized");
    const expiry = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    const setCookie = cookie(`admin.${expiry}.${await signature(expiry, env)}`, SESSION_SECONDS);
    return json(
      { role: payload.role, canView: true } satisfies SessionResponse,
      200,
      {
        "Set-Cookie": setCookie,
      },
    );
  }
  if (pathname === "/api/logout" && method === "POST") {
    checkMutation(request);
    const headers = new Headers();
    headers.append("Set-Cookie", cookie("", 0));
    for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
      const name = part.trim().split("=", 1)[0];
      if (name.startsWith("gallery_access_")) headers.append("Set-Cookie", namedCookie(name, "", 0));
    }
    return json({ ok: true }, 200, headers);
  }
  if (pathname === "/api/gallery" && method === "GET") {
    if (!gallery) fail(404, "not_found");
    const { role, canView } = await access(request, env, gallery);
    if (!canView) requireRole(role, "guest");
    const cursorToken = url.searchParams.get("cursor");
    const cursor = cursorToken !== null ? decodeGalleryPhotoCursor(cursorToken, gallery.id) : null;
    let rows: D1Result<Record<string, unknown>>;
    if (cursor) {
      rows = await env.DB.prepare(
        "SELECT * FROM photos WHERE gallery_id = ? AND status = 'published' AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?",
      )
        .bind(gallery.id, cursor.createdAt, cursor.id, PAGE_SIZE + 1)
        .all();
    } else
      rows = await env.DB.prepare(
        "SELECT * FROM photos WHERE gallery_id = ? AND status = 'published' ORDER BY created_at DESC, id DESC LIMIT ?",
      )
        .bind(gallery.id, PAGE_SIZE + 1)
        .all();
    const more = rows.results.length > PAGE_SIZE;
    const photos = rows.results.slice(0, PAGE_SIZE).map(photoRow);
    const event = galleryEvent(gallery);
    const result: GalleryResponse = {
      event,
      photos,
      nextCursor: more && photos.length
        ? encodeGalleryPhotoCursor({
          v: 1,
          galleryId: gallery.id,
          createdAt: String(rows.results[PAGE_SIZE - 1].created_at),
          id: String(rows.results[PAGE_SIZE - 1].id),
        })
        : null,
      total: Number(gallery.photo_count),
      role,
    };
    const selections: MediaSelection[] = rows.results.slice(0, PAGE_SIZE).map((row) => ({ row, variant: "thumbnail" }));
    if (gallery.cover_photo_id && env.R2_ACCOUNT_ID) {
      const cover = rows.results.find((row) => row.id === gallery!.cover_photo_id) ?? await env.DB.prepare(
        "SELECT * FROM photos WHERE id = ? AND gallery_id = ? AND status = 'published'",
      ).bind(gallery.cover_photo_id, gallery.id).first<Record<string, unknown>>();
      if (cover) selections.push({ row: cover, variant: "preview" });
    }
    const manifest = await mediaManifest(env, gallery, role, selections);
    if (manifest) result.media = manifest;
    return json(result);
  }
  if (pathname === "/api/media" && method === "POST") {
    checkMutation(request);
    if (!gallery) fail(404, "not_found");
    const { role, canView } = await access(request, env, gallery);
    if (!canView) requireRole(role, "guest");
    const body = await bodyJson<{ photos?: { id: string; variant: Variant }[] }>(request, 16 * 1024);
    if (!body || !Array.isArray(body.photos) || body.photos.length < 1 || body.photos.length > PAGE_SIZE || body.photos.some((item) => !item || typeof item.id !== "string" || !/^[0-9a-f-]{36}$/i.test(item.id) || !VARIANTS.includes(item.variant))) fail(400, "bad_request");
    const ids = [...new Set(body.photos.map((item) => item.id))];
    const rows = await env.DB.prepare(
      `SELECT * FROM photos WHERE gallery_id = ? AND status = 'published' AND id IN (${ids.map(() => "?").join(",")})`,
    ).bind(gallery.id, ...ids).all<Record<string, unknown>>();
    if (rows.results.length !== ids.length) fail(404, "not_found");
    const byId = new Map(rows.results.map((row) => [String(row.id), row]));
    const selections: MediaSelection[] = body.photos.map((item) => ({ row: byId.get(item.id)!, variant: item.variant }));
    return json(await mediaManifest(env, gallery, role, selections));
  }
  if (pathname.startsWith("/api/photos/") && method === "GET")
    return gallery ? media(request, env, url, gallery) : fail(404, "not_found");
  if (pathname === "/api/admin/settings" && method === "PATCH") {
    checkMutation(request);
    if (!gallery) fail(404, "not_found");
    requireRole(await session(request, env, gallery), "admin");
    const data = await bodyJson<EventSettings>(request);
    if (
      !data ||
      typeof data.title !== "string" ||
      typeof data.date !== "string" ||
      typeof data.description !== "string" ||
      (data.visibility !== "private" && data.visibility !== "public") ||
      !(data.coverPhotoId === null || typeof data.coverPhotoId === "string") ||
      data.title.length > 160 ||
      data.date.length > 32 ||
      data.description.length > 4000
    )
      fail(400, "bad_request");
    if (data.coverPhotoId) {
      const cover = await env.DB.prepare(
        "SELECT id FROM photos WHERE id = ? AND gallery_id = ? AND status = 'published'",
      )
        .bind(data.coverPhotoId, gallery.id)
        .first();
      if (!cover) fail(400, "bad_request");
    }
    if (data.visibility === "private" && !hasGalleryPassword(gallery)) fail(400, "bad_request");
    await env.DB.prepare(
      "UPDATE galleries SET title = ?, event_date = ?, description = ?, visibility = ?, cover_photo_id = ? WHERE id = ? AND status = 'active'",
    )
      .bind(
        data.title.trim(),
        data.date,
        data.description.trim(),
        data.visibility,
        data.coverPhotoId,
        gallery.id,
      )
      .run();
    const updated = await findGallery(env, gallery.slug);
    if (!updated || updated.status !== "active") fail(409, "conflict");
    return json(galleryEvent(updated));
  }
  if (pathname === "/api/admin/uploads" && method === "GET") {
    if (!gallery) fail(404, "not_found");
    requireRole(await session(request, env, gallery), "admin");
    return json(await adminUploads(env, gallery.id, url.searchParams.get("cursor")));
  }
  const uploadStatus = pathname.match(
    /^\/api\/admin\/uploads\/([0-9a-f-]{36})$/i,
  );
  if (uploadStatus && method === "GET") {
    if (!gallery) fail(404, "not_found");
    requireRole(await session(request, env, gallery), "admin");
    const id = uploadStatus[1];
    const published = await env.DB.prepare(
      "SELECT * FROM photos WHERE id = ? AND gallery_id = ? AND status = 'published'",
    )
      .bind(id, gallery.id)
      .first<Record<string, unknown>>();
    if (published) return json({ status: "published", photo: photoRow(published) });
    const pending = await env.DB.prepare(
      "SELECT status FROM uploads WHERE id = ? AND gallery_id = ?",
    )
      .bind(id, gallery.id)
      .first<{ status: string }>();
    if (pending) return json({ status: pending.status });
    const deleting = await env.DB.prepare(
      "SELECT status FROM photos WHERE id = ? AND gallery_id = ? AND status = 'deleting'",
    )
      .bind(id, gallery.id)
      .first<{ status: string }>();
    if (deleting) return json({ status: "deleting" });
    fail(404, "not_found");
  }
  if (pathname === "/api/admin/uploads" && method === "POST") {
    checkMutation(request);
    if (!gallery) fail(404, "not_found");
    if (gallery.status !== "active") fail(409, "conflict");
    requireRole(await session(request, env, gallery), "admin");
    const body = await bodyJson<UploadInput & { uploadId?: unknown }>(request);
    const input = validInput(body);
    if (body.uploadId !== undefined && (typeof body.uploadId !== "string" || !isUuid(body.uploadId)))
      fail(400, "bad_request");
    const id = typeof body.uploadId === "string" ? body.uploadId.toLowerCase() : secureId();
    const createdAt = now();
    const inserted = await env.DB.prepare(
      "INSERT INTO uploads (id, filename, content_type, bytes, width, height, created_at, updated_at, gallery_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM galleries WHERE id = ? AND status = 'active') AND NOT EXISTS (SELECT 1 FROM photos WHERE id = ?) ON CONFLICT(id) DO NOTHING",
    )
      .bind(
        id,
        input.filename,
        input.contentType,
        input.bytes,
        input.width,
        input.height,
        createdAt,
        createdAt,
        gallery.id,
        gallery.id,
        id,
      )
      .run();
    const existingPhoto = await env.DB.prepare(
      "SELECT gallery_id, filename, content_type, bytes, width, height, status FROM photos WHERE id = ?",
    )
      .bind(id)
      .first<Record<string, unknown>>();
    if (existingPhoto) {
      if (
        existingPhoto.gallery_id !== gallery.id ||
        existingPhoto.status !== "published" ||
        existingPhoto.filename !== input.filename ||
        existingPhoto.content_type !== input.contentType ||
        Number(existingPhoto.bytes) !== input.bytes ||
        Number(existingPhoto.width) !== input.width ||
        Number(existingPhoto.height) !== input.height
      )
        fail(409, "conflict");
      return json({ id }, body.uploadId === undefined || inserted.meta?.changes ? 201 : 200);
    }
    const existingUpload = await env.DB.prepare(
      "SELECT gallery_id, filename, content_type, bytes, width, height, status FROM uploads WHERE id = ?",
    )
      .bind(id)
      .first<Record<string, unknown>>();
    if (existingUpload) {
      if (
        existingUpload.gallery_id !== gallery.id ||
        existingUpload.status !== "pending" ||
        existingUpload.filename !== input.filename ||
        existingUpload.content_type !== input.contentType ||
        Number(existingUpload.bytes) !== input.bytes ||
        Number(existingUpload.width) !== input.width ||
        Number(existingUpload.height) !== input.height
      )
        fail(409, "conflict");
      return json({ id }, body.uploadId === undefined || inserted.meta?.changes ? 201 : 200);
    }
    fail(409, "conflict");
  }
  const part = pathname.match(
    /^\/api\/admin\/uploads\/([0-9a-f-]{36})\/(original|thumbnail|preview)$/i,
  );
  if (part && method === "PUT") {
    checkMutation(request);
    if (!gallery) fail(404, "not_found");
    requireRole(await session(request, env, gallery), "admin");
    const id = part[1];
    const variant = part[2] as Variant;
    const upload = await env.DB.prepare(
      "SELECT filename, content_type, bytes FROM uploads WHERE id = ? AND gallery_id = ? AND status = 'pending'",
    )
      .bind(id, gallery.id)
      .first<{ filename: string; content_type: string; bytes: number }>();
    if (!upload) fail(404, "not_found");
    const alreadyReady = await env.DB.prepare(
      "SELECT p.bytes FROM upload_parts p JOIN uploads u ON u.id = p.upload_id WHERE p.upload_id = ? AND p.variant = ? AND u.gallery_id = ?",
    )
      .bind(id, variant, gallery.id)
      .first<{ bytes: number }>();
    if (alreadyReady) return json({ ok: true, bytes: alreadyReady.bytes });
    const requestedType = (request.headers.get("Content-Type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const type = variant === "original"
      ? upload.content_type
      : variant === "preview"
        ? "image/jpeg"
        : ["image/jpeg", "image/webp", "image/avif"].includes(requestedType)
          ? requestedType
          : "image/jpeg";
    const limit = LIMITS[variant];
    const attemptId = secureId();
    const key = `uploads/${id}/${variant}/${attemptId}`;
    await env.DB.prepare(
      "INSERT INTO upload_attempts (id, upload_id, variant, object_key, created_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM uploads WHERE id = ? AND gallery_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM galleries WHERE id = ? AND status = 'active')) AND NOT EXISTS (SELECT 1 FROM upload_attempts WHERE upload_id = ? AND status = 'pending') AND NOT EXISTS (SELECT 1 FROM upload_parts WHERE upload_id = ? AND variant = ?)",
    )
      .bind(attemptId, id, variant, key, now(), id, gallery.id, gallery.id, id, id, variant)
      .run();
    const reserved = await env.DB.prepare(
      "SELECT 1 FROM upload_attempts a JOIN uploads u ON u.id = a.upload_id JOIN galleries g ON g.id = u.gallery_id WHERE a.id = ? AND a.status = 'pending' AND u.status = 'pending' AND u.gallery_id = ? AND g.status = 'active'",
    )
      .bind(attemptId, gallery.id)
      .first();
    if (!reserved) {
      const previous = await env.DB.prepare(
        "SELECT p.bytes FROM upload_parts p JOIN uploads u ON u.id = p.upload_id WHERE p.upload_id = ? AND p.variant = ? AND u.gallery_id = ?",
      )
        .bind(id, variant, gallery.id)
        .first<{ bytes: number }>();
      if (previous) return json({ ok: true, bytes: previous.bytes });
      fail(409, "conflict");
    }
    let size: number;
    try {
      size = await inspectAndPut(request, key, type, limit, env, variant === "original" ? upload.filename : undefined);
    } catch (error) {
      await env.DB.prepare(
        "UPDATE upload_attempts SET status = 'failed' WHERE id = ? AND status = 'pending'",
      )
        .bind(attemptId)
        .run();
      throw error;
    }
    if (variant === "original" && size !== upload.bytes) {
      await env.DB.prepare(
        "UPDATE upload_attempts SET status = 'failed' WHERE id = ?",
      )
        .bind(attemptId)
        .run();
      await env.PHOTOS.delete(key);
      fail(400, "bad_request");
    }
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE upload_attempts SET status = 'ready' WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM uploads WHERE id = ? AND status = 'pending')",
      ).bind(attemptId, id),
      env.DB.prepare(
        "INSERT INTO upload_parts(upload_id, variant, object_key, bytes) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM uploads WHERE id = ? AND status = 'pending') AND EXISTS (SELECT 1 FROM upload_attempts WHERE id = ? AND status = 'ready') ON CONFLICT(upload_id, variant) DO NOTHING",
      ).bind(id, variant, key, size, id, attemptId),
    ]);
    const active = await env.DB.prepare(
      "SELECT 1 FROM upload_parts p JOIN uploads u ON u.id = p.upload_id WHERE p.upload_id = ? AND p.variant = ? AND p.object_key = ? AND u.status = 'pending'",
    )
      .bind(id, variant, key)
      .first();
    if (!active) {
      await env.DB.prepare(
        "UPDATE upload_attempts SET status = 'failed' WHERE id = ?",
      )
        .bind(attemptId)
        .run();
      await env.PHOTOS.delete(key);
      const previous = await env.DB.prepare(
        "SELECT bytes FROM upload_parts WHERE upload_id = ? AND variant = ?",
      )
        .bind(id, variant)
        .first<{ bytes: number }>();
      if (previous) return json({ ok: true, bytes: previous.bytes });
      fail(404, "not_found");
    }
    return json({ ok: true, bytes: size });
  }
  const uploadComplete = pathname.match(
    /^\/api\/admin\/uploads\/([0-9a-f-]{36})\/complete$/i,
  );
  if (uploadComplete && method === "POST") {
    checkMutation(request);
    if (!gallery) fail(404, "not_found");
    requireRole(await session(request, env, gallery), "admin");
    const id = uploadComplete[1];
    const upload = await env.DB.prepare(
      "SELECT u.*, GROUP_CONCAT(p.variant) AS variants, MAX(CASE WHEN p.variant = 'original' THEN p.object_key END) AS original_key, MAX(CASE WHEN p.variant = 'thumbnail' THEN p.object_key END) AS thumbnail_key, MAX(CASE WHEN p.variant = 'preview' THEN p.object_key END) AS preview_key FROM uploads u JOIN upload_parts p ON p.upload_id = u.id WHERE u.id = ? AND u.gallery_id = ? AND u.status = 'pending' GROUP BY u.id",
    )
      .bind(id, gallery.id)
      .first<Record<string, unknown>>();
    if (!upload) {
      const existing = await env.DB.prepare(
        "SELECT * FROM photos WHERE id = ? AND gallery_id = ? AND status = 'published'",
      )
        .bind(id, gallery.id)
        .first<Record<string, unknown>>();
      if (existing) return json(photoRow(existing));
      fail(404, "not_found");
    }
    if (
      String(upload.variants).split(",").sort().join(",") !==
      "original,preview,thumbnail"
    )
      fail(409, "conflict");
    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM upload_attempts a JOIN uploads u ON u.id = a.upload_id WHERE a.upload_id = ? AND a.status = 'pending' AND u.gallery_id = ?",
    )
      .bind(id, gallery.id)
      .first<{ count: number }>();
    if ((pending?.count ?? 0) > 0) fail(409, "conflict");
    const redundant = await env.DB.prepare(
      "SELECT object_key FROM upload_attempts WHERE upload_id = ? AND object_key NOT IN (SELECT object_key FROM upload_parts WHERE upload_id = ?)",
    )
      .bind(id, id)
      .all<{ object_key: string }>();
    if (redundant.results.length)
      await env.PHOTOS.delete(redundant.results.map((row) => row.object_key));
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO photos (id, filename, content_type, bytes, width, height, created_at, original_key, thumbnail_key, preview_key, gallery_id) SELECT id, filename, content_type, bytes, width, height, created_at, ?, ?, ?, gallery_id FROM uploads WHERE id = ? AND gallery_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM galleries WHERE id = uploads.gallery_id AND status = 'active') AND (SELECT COUNT(*) FROM upload_parts WHERE upload_id = ?) = 3 AND NOT EXISTS (SELECT 1 FROM upload_attempts WHERE upload_id = ? AND status = 'pending') ON CONFLICT(id) DO NOTHING",
      ).bind(
        upload.original_key,
        upload.thumbnail_key,
        upload.preview_key,
        id,
        gallery.id,
        id,
        id,
      ),
      env.DB.prepare(
        "DELETE FROM uploads WHERE id = ? AND gallery_id = ? AND EXISTS (SELECT 1 FROM photos WHERE id = ? AND gallery_id = ? AND status = 'published')",
      ).bind(id, gallery.id, id, gallery.id),
    ]);
    const published = await env.DB.prepare(
      "SELECT * FROM photos WHERE id = ? AND gallery_id = ? AND status = 'published'",
    )
      .bind(id, gallery.id)
      .first<Record<string, unknown>>();
    if (!published) fail(409, "conflict");
    return json(photoRow(published), 201);
  }
  const deletePhoto = pathname.match(
    /^\/api\/admin\/photos\/([0-9a-f-]{36})$/i,
  );
  const deleteUpload = pathname.match(
    /^\/api\/admin\/uploads\/([0-9a-f-]{36})$/i,
  );
  if (method === "DELETE" && (deletePhoto || deleteUpload)) {
    checkMutation(request);
    if (!gallery) fail(404, "not_found");
    requireRole(await session(request, env, gallery), "admin");
    const id = (deletePhoto ?? deleteUpload)![1];
    const owned = deletePhoto
      ? await env.DB.prepare(
          "SELECT id FROM photos WHERE id = ? AND gallery_id = ? UNION SELECT id FROM uploads WHERE id = ? AND gallery_id = ?",
        ).bind(id, gallery.id, id, gallery.id).first()
      : await env.DB.prepare(
          "SELECT id FROM uploads WHERE id = ? AND gallery_id = ?",
        ).bind(id, gallery.id).first();
    // Repeated deletes are idempotent; an ID from another gallery must not reach the R2 prefix sweep.
    if (!owned) return json({ ok: true });
    if (deletePhoto) {
      await env.DB.batch([
        env.DB.prepare("UPDATE photos SET status = 'deleting' WHERE id = ? AND gallery_id = ?").bind(id, gallery.id),
        env.DB.prepare(
          "UPDATE uploads SET status = 'deleting' WHERE id = ? AND gallery_id = ?",
        ).bind(id, gallery.id),
        env.DB.prepare(
          "UPDATE galleries SET cover_photo_id = NULL WHERE cover_photo_id = ? AND id = ?",
        ).bind(id, gallery.id),
      ]);
    } else {
      await env.DB.prepare(
        "UPDATE uploads SET status = 'deleting' WHERE id = ? AND gallery_id = ?",
      ).bind(id, gallery.id).run();
    }
    const upload = await env.DB.prepare(
      "SELECT p.object_key FROM upload_parts p JOIN uploads u ON u.id = p.upload_id WHERE p.upload_id = ? AND u.gallery_id = ? UNION SELECT a.object_key FROM upload_attempts a JOIN uploads u ON u.id = a.upload_id WHERE a.upload_id = ? AND u.gallery_id = ?",
    )
      .bind(id, gallery.id, id, gallery.id)
      .all<{ object_key: string }>();
    const photo = await env.DB.prepare(
      "SELECT original_key, thumbnail_key, preview_key FROM photos WHERE id = ? AND gallery_id = ?",
    )
      .bind(id, gallery.id)
      .first<{
        original_key: string;
        thumbnail_key: string;
        preview_key: string;
      }>();
    const keys = new Set(upload.results.map((row) => row.object_key));
    if (photo)
      [photo.original_key, photo.thumbnail_key, photo.preview_key].forEach(
        (key) => keys.add(key),
      );
    let cursor: string | undefined;
    do {
      const page = await env.PHOTOS.list({
        prefix: `uploads/${id}/`,
        cursor,
        limit: 1000,
      });
      page.objects.forEach((object) => keys.add(object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (!deletePhoto && photo)
      [photo.original_key, photo.thumbnail_key, photo.preview_key].forEach(
        (key) => keys.delete(key),
      );
    if (keys.size) {
      const items = [...keys];
      for (let index = 0; index < items.length; index += 1000)
        await env.PHOTOS.delete(items.slice(index, index + 1000));
    }
    if (deletePhoto) {
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM photos WHERE id = ? AND gallery_id = ? AND status = 'deleting'",
        ).bind(id, gallery.id),
        env.DB.prepare(
          "DELETE FROM uploads WHERE id = ? AND gallery_id = ? AND status = 'deleting'",
        ).bind(id, gallery.id),
      ]);
    } else {
      await env.DB.prepare(
        "DELETE FROM uploads WHERE id = ? AND gallery_id = ? AND status = 'deleting'",
      ).bind(id, gallery.id).run();
    }
    return json({ ok: true });
  }
  fail(404, "not_found");
}

const securityHeaders = (headers: Headers) => {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; worker-src 'self' blob:; img-src 'self' blob: data: https://*.r2.cloudflarestorage.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.r2.cloudflarestorage.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  return headers;
};
export async function fetchHandler(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    const galleryPage = url.pathname.match(/^\/g\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
    if (galleryPage && (request.method === "GET" || request.method === "HEAD"))
      return await galleryHtml(request, env, url, galleryPage[1]);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (
        request.method !== "GET" &&
        request.method !== "POST" &&
        request.method !== "PATCH" &&
        request.method !== "PUT" &&
        request.method !== "DELETE"
      )
        return json({ error: "not_found" }, 404);
      return await handleApi(request, env, url);
    }
    const upstream = await env.ASSETS.fetch(request);
    const headers = securityHeaders(new Headers(upstream.headers));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function scheduledHandler(controller: { cron?: string }, env: Env) {
  const galleries = await cleanupDeletingGalleries(env);
  let result: Awaited<ReturnType<typeof cleanupAbandonedUploads>> | null = null;
  if (!controller.cron || controller.cron === "17 3 * * *") {
    result = await cleanupAbandonedUploads(env);
  }
  // Aggregate counters only; credentials, signed URLs and photo names never enter logs.
  console.log(JSON.stringify({ event: "maintenance", uploadsScanned: result?.scanned ?? 0, uploadsRemoved: result?.uploadsDeleted ?? 0, uploadsRemaining: result?.uploadsRemaining ?? 0, uploadFailures: result?.failures.length ?? 0, galleriesScanned: galleries.galleriesScanned, photosRemoved: galleries.photosDeleted, galleryUploadsRemoved: galleries.uploadsDeleted, galleriesRemoved: galleries.galleriesDeleted, galleriesRemaining: galleries.pendingGalleries, galleryFailures: galleries.failures.length }));
}
export default { fetch: fetchHandler, scheduled: scheduledHandler };
