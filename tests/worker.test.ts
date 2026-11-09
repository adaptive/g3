import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createTestHarness } from "wrangler";
import type { GalleryResponse } from "../src/shared/types";

const root = resolve(import.meta.dirname, "..");
const server = createTestHarness();
type WorkerExports = Awaited<
  ReturnType<ReturnType<typeof server.getWorker>["getExport"]>
>;
type WorkerFetchInit = Parameters<WorkerExports["fetch"]>[1];
const adminPassword = "correct-horse-admin-2026";
const guestPassword = "correct-horse-guest-2026";
const noGuestAdminPassword = "no-legacy-guest-admin-2026";
const fixturePhotoId = "00000000-0000-4000-8000-000000000001";
const fixtureUploadId = "00000000-0000-4000-8000-000000000002";
const schema = await readFile(join(root, "schema.sql"), "utf8");
async function storedPassword(password: string) {
  const salt = new Uint8Array(16).fill(7);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, key, 256);
  const encoded = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return { salt: encoded(salt), hash: encoded(new Uint8Array(bits)) };
}
async function initializeCleanDatabase(db: { prepare(query: string): { run(): Promise<unknown> } }) {
  // Trigger bodies are single SQLite statements despite their internal semicolons.
  for (const match of schema.matchAll(/\s*(CREATE TRIGGER\b[\s\S]*?\bEND|[^;]+);/gi)) {
    const statement = match[1].trim();
    if (statement && !/^PRAGMA foreign_keys/i.test(statement))
      await db.prepare(statement).run();
  }
}
let mutationOrigin = "";
let adminCookie = "";
let guestCookie = "";
let rotatedWorkerConfigPath = "";
let rotatedWorkerName = "";
let noGuestWorkerName = "";
let signedWorkerName = "";
let testRoot = "";
let exported!: WorkerExports;

// A 1×1 JPEG fixture, reused to check that the original download is byte-identical.
const jpeg = Uint8Array.from(
  Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9oADAMBAAIAAwAAABAf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=",
    "base64",
  ),
);


beforeAll(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "adaptive-gallery-worker-test-"));
  const configPath = join(testRoot, "wrangler.jsonc");
  const assetDirectory = join(testRoot, "assets");
  await mkdir(assetDirectory, { recursive: true });
  await writeFile(join(assetDirectory, "index.html"), `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="description" content="A private place for shared moments."><title>Adaptive Gallery</title></head><body><div id="root"></div></body></html>`);
  await writeFile(join(assetDirectory, "favicon.ico"), await readFile(join(root, "public/favicon.ico")));
  await writeFile(join(assetDirectory, "favicon.svg"), await readFile(join(root, "public/favicon.svg")));
  const databaseName = `adaptive-gallery-test-${process.pid}`;
  rotatedWorkerName = `adaptive-gallery-test-${process.pid}-rotated`;
  noGuestWorkerName = `adaptive-gallery-test-${process.pid}-no-guest`;
  signedWorkerName = `adaptive-gallery-test-${process.pid}-signed`;
  rotatedWorkerConfigPath = join(testRoot, "wrangler.rotated.jsonc");
  const noGuestWorkerConfigPath = join(testRoot, "wrangler.no-guest.jsonc");
  const signedWorkerConfigPath = join(testRoot, "wrangler.signed.jsonc");
  const config = (name: string, dbName = databaseName, databaseId = "00000000-0000-0000-0000-000000000000") => JSON.stringify({
      name,
      main: join(root, "worker/index.ts"),
      compatibility_date: "2026-11-01",
      assets: {
        directory: assetDirectory,
        binding: "ASSETS",
        not_found_handling: "single-page-application",
        run_worker_first: ["/api", "/api/*", "/g/*", "/favicon.ico"],
      },
      d1_databases: [{
        binding: "DB",
        database_name: dbName,
        database_id: databaseId,
      }],
      r2_buckets: [{
        binding: "PHOTOS",
        bucket_name: dbName,
      }],
    }, null, 2);
  await writeFile(configPath, config(`adaptive-gallery-test-${process.pid}`));
  await writeFile(rotatedWorkerConfigPath, config(rotatedWorkerName));
  await writeFile(signedWorkerConfigPath, config(signedWorkerName));
  await writeFile(
    noGuestWorkerConfigPath,
    config(noGuestWorkerName, `${databaseName}-no-guest`, "00000000-0000-0000-0000-000000000001"),
  );
  await server.update({
    root: testRoot,
    workers: [
      {
        configPath,
        secrets: {
          ADMIN_PASSWORD: adminPassword,
        },
      },
      {
        configPath: rotatedWorkerConfigPath,
        secrets: {
          ADMIN_PASSWORD: "rotated-admin-password-2026",
        },
      },
      {
        configPath: noGuestWorkerConfigPath,
        secrets: { ADMIN_PASSWORD: noGuestAdminPassword },
      },
      {
        configPath: signedWorkerConfigPath,
        secrets: {
          ADMIN_PASSWORD: adminPassword,
          R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
          R2_BUCKET_NAME: "adaptive-gallery-photos",
          R2_ACCESS_KEY_ID: "local-read-only-key",
          R2_SECRET_ACCESS_KEY: "local-signing-secret-not-a-live-credential",
        },
      },
    ],
  });
  const listening = await server.listen();
  mutationOrigin = listening.url.origin;
  exported = await server.getWorker().getExport();
  const db = (await server.getWorker().getEnv()).DB;
  await initializeCleanDatabase(db);
  const empty = await db.prepare("SELECT COUNT(*) AS total FROM galleries").first() as { total: number } | null;
  assert.equal(empty?.total, 0, "a clean schema starts without a seeded gallery");
  const fixtureCredentials = await storedPassword(guestPassword);
  await db.prepare(
    "INSERT INTO galleries (id, slug, title, event_date, description, visibility, cover_photo_id, password_salt, password_hash, created_at) VALUES ('default', 'default', ?, '2025-10-14', ?, 'private', ?, ?, ?, '2025-10-14T10:00:00.000Z')",
  ).bind(
    "Seeded gallery fixture",
    "Gallery and media rows are test data, not schema defaults.",
    fixturePhotoId,
    fixtureCredentials.salt,
    fixtureCredentials.hash,
  ).run();
  await db
    .prepare(
      "INSERT INTO photos (id, gallery_id, filename, content_type, bytes, width, height, created_at, original_key, thumbnail_key, preview_key) VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      fixturePhotoId,
      "fixture.jpg",
      "image/jpeg",
      jpeg.byteLength,
      1,
      1,
      "2025-10-14T10:00:00.000Z",
      "fixture/default/original",
      "fixture/default/thumbnail",
      "fixture/default/preview",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO uploads (id, gallery_id, filename, content_type, bytes, width, height, created_at, updated_at, status) VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, 'pending')",
    )
    .bind(
      fixtureUploadId,
      "unfinished-fixture.jpg",
      "image/jpeg",
      jpeg.byteLength,
      1,
      1,
      "2025-10-14T10:01:00.000Z",
      "2025-10-14T10:01:00.000Z",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO upload_parts (upload_id, variant, object_key, bytes) VALUES (?, 'original', ?, ?)",
    )
    .bind(fixtureUploadId, "uploads/legacy-in-progress/original", jpeg.byteLength)
    .run();
  const bucket = (await server.getWorker().getEnv()).PHOTOS;
  await bucket.put("fixture/default/original", jpeg, {
    httpMetadata: { contentType: "image/jpeg" },
  });
  await bucket.put("fixture/default/thumbnail", jpeg, {
    httpMetadata: { contentType: "image/jpeg" },
  });
  await bucket.put("fixture/default/preview", jpeg, {
    httpMetadata: { contentType: "image/jpeg" },
  });
  const noGuestWorker = server.getWorker(noGuestWorkerName);
  const noGuestDb = (await noGuestWorker.getEnv()).DB;
  await initializeCleanDatabase(noGuestDb);
});

afterAll(async () => {
  try {
    await server.close();
  } finally {
    if (testRoot) await rm(testRoot, { recursive: true, force: true });
  }
});

function call(path: string, init: WorkerFetchInit = {}, cookie = "") {
  const headers = new Headers(init.headers as unknown as HeadersInit);
  if (cookie) headers.set("cookie", cookie);
  if (["POST", "PATCH", "PUT", "DELETE"].includes(init.method?.toUpperCase() ?? "GET")) {
    headers.set("origin", mutationOrigin);
  }
  return exported.fetch(new URL(path, mutationOrigin), { ...init, headers });
}

async function json<T>(response: { json(): Promise<unknown> }): Promise<T> {
  return response.json() as Promise<T>;
}

async function login(role: "admin" | "guest", password: string) {
  const path = role === "admin" ? "/api/login" : "/api/galleries/default/login";
  const response = await call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, password }),
  });
  const setCookie = response.headers.get("set-cookie") ?? "";
  return { response, cookie: setCookie.split(";", 1)[0] };
}

async function expiredAdminCookie() {
  const expiry = Math.floor(Date.now() / 1000) - 10;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(adminPassword),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`admin.${expiry}`),
    ),
  );
  return `gallery_session=admin.${expiry}.${Buffer.from(signature).toString("base64url")}`;
}

async function uploadPhoto(
  cookie = adminCookie,
  base = "/api/admin/uploads",
) {
  const created = await call(
    base,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "tiny.jpg",
        contentType: "image/jpeg",
        bytes: jpeg.byteLength,
        width: 1,
        height: 1,
      }),
    },
    cookie,
  );
  assert.equal(created.status, 201);
  const { id } = await json<{ id: string }>(created);
  for (const variant of ["original", "thumbnail", "preview"]) {
    const result = await call(
      `${base}/${id}/${variant}`,
      {
        method: "PUT",
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(jpeg.byteLength),
        },
        body: jpeg,
      },
      cookie,
    );
    assert.equal(result.status, 200, `upload ${variant}`);
  }
  return id;
}

test("anonymous visitor is denied in private mode and API data is not cached", async () => {
  const response = await call("/api/gallery");
  assert.equal(response.status, 401);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
  assert.doesNotMatch(
    await response.clone().text(),
    /password|session secret/i,
  );
  assert.equal(
    (await json<{ canView: boolean }>(await call("/api/session"))).canView,
    false,
  );
});

test("role sessions use secure cookies; guest can view but cannot manage or upload", async () => {
  const admin = await login("admin", adminPassword);
  assert.equal(admin.response.status, 200);
  assert.match(admin.response.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.match(admin.response.headers.get("set-cookie") ?? "", /Secure/);
  assert.match(
    admin.response.headers.get("set-cookie") ?? "",
    /SameSite=Strict/i,
  );
  adminCookie = admin.cookie;

  const guest = await login("guest", guestPassword);
  assert.equal(guest.response.status, 200);
  guestCookie = guest.cookie;
  assert.equal((await call("/api/gallery", {}, guestCookie)).status, 200);
  assert.equal((await call("/api/admin/uploads", {}, guestCookie)).status, 403);
  assert.equal(
    (
      await call(
        "/api/admin/settings",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
        guestCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/api/admin/uploads",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
        guestCookie,
      )
    ).status,
    403,
  );
});

test("gallery fixture data can be inserted into the clean schema", async () => {
  const gallery = await json<GalleryResponse>(
    await call("/api/gallery", {}, adminCookie),
  );
  assert.equal(gallery.event.title, "Seeded gallery fixture");
  assert.equal(gallery.event.date, "2025-10-14");
  assert.equal(gallery.event.description, "Gallery and media rows are test data, not schema defaults.");
  assert.equal(gallery.event.coverPhotoId, fixturePhotoId);
  assert.ok(gallery.photos.some((photo) => photo.id === fixturePhotoId));
  const original = await call(
    `/api/photos/${fixturePhotoId}/original`,
    {},
    adminCookie,
  );
  assert.equal(original.status, 200);
  assert.deepEqual(new Uint8Array(await original.arrayBuffer()), jpeg);
  const uploads = await json<{ uploads: Array<{ id: string }> }>(
    await call("/api/admin/uploads", {}, adminCookie),
  );
  assert.ok(uploads.uploads.some((item) => item.id === fixtureUploadId));
});

test("private derivative responses revalidate only after authorization and originals remain uncached", async () => {
  const path = `/api/photos/${fixturePhotoId}/thumbnail`;
  const first = await call(path, {}, adminCookie);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "private, no-cache");
  const etag = first.headers.get("etag");
  assert.ok(etag);
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), jpeg);

  const conditional = await call(path, { headers: { "if-none-match": `W/${etag}` } }, adminCookie);
  assert.equal(conditional.status, 304);
  assert.equal(await conditional.text(), "");
  assert.equal(conditional.headers.get("etag"), etag);

  const denied = await call(path, { headers: { "if-none-match": etag } });
  assert.equal(denied.status, 401, "a cached validator cannot bypass the gallery access check");

  const original = await call(`/api/photos/${fixturePhotoId}/original`, { headers: { "if-none-match": etag } }, adminCookie);
  assert.equal(original.status, 200);
  assert.equal(original.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(original.headers.get("etag"), null);
  assert.deepEqual(new Uint8Array(await original.arrayBuffer()), jpeg);
});

test("derivative validators change when a published variant key changes", async () => {
  const db = (await server.getWorker().getEnv()).DB;
  const bucket = (await server.getWorker().getEnv()).PHOTOS;
  const originalKey = `fixture/default/thumbnail`;
  const replacementKey = `fixture/default/thumbnail-replaced-${crypto.randomUUID()}`;
  const before = await call(`/api/photos/${fixturePhotoId}/thumbnail`, {}, adminCookie);
  const oldEtag = before.headers.get("etag");
  assert.ok(oldEtag);
  await before.body?.cancel();
  await bucket.put(replacementKey, jpeg, { httpMetadata: { contentType: "image/jpeg" } });
  await db.prepare("UPDATE photos SET thumbnail_key = ? WHERE id = ?").bind(replacementKey, fixturePhotoId).run();
  try {
    const changed = await call(`/api/photos/${fixturePhotoId}/thumbnail`, { headers: { "if-none-match": oldEtag } }, adminCookie);
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), oldEtag);
    assert.deepEqual(new Uint8Array(await changed.arrayBuffer()), jpeg);
  } finally {
    await db.prepare("UPDATE photos SET thumbnail_key = ? WHERE id = ?").bind(originalKey, fixturePhotoId).run();
    await bucket.delete(replacementKey);
  }
});

test("gallery HTML exposes escaped share metadata only for public galleries and serves a real favicon", async () => {
  const privatePage = await call(`/g/default?photo=${fixturePhotoId}`);
  const privateHtml = await privatePage.text();
  assert.equal(privatePage.status, 200);
  assert.match(privateHtml, /<title>Adaptive Gallery<\/title>/);
  assert.match(privateHtml, /name="robots" content="noindex, nofollow"/);
  assert.doesNotMatch(privateHtml, /Seeded gallery fixture|fixture\.jpg|og:image/);

  const create = await call("/api/admin/galleries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: 'Meet <script>alert("x")</script> & friends', slug: "seo-public-gallery", visibility: "public" }),
  }, adminCookie);
  assert.equal(create.status, 201);
  const photoId = await uploadPhoto(adminCookie, "/api/galleries/seo-public-gallery/admin/uploads");
  assert.equal((await call(`/api/galleries/seo-public-gallery/admin/uploads/${photoId}/complete`, { method: "POST" }, adminCookie)).status, 201);
  const settings = await call("/api/galleries/seo-public-gallery/admin/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: 'Meet <script>alert("x")</script> & friends', date: "", description: 'Say "hello" & enjoy <photos>', visibility: "public", coverPhotoId: photoId }),
  }, adminCookie);
  assert.equal(settings.status, 200);

  const publicPage = await call(`/g/seo-public-gallery?photo=${photoId}`);
  const publicHtml = await publicPage.text();
  assert.equal(publicPage.status, 200);
  assert.match(publicHtml, /<title>Meet &lt;script&gt;alert\("x"\)&lt;\/script&gt; &amp; friends<\/title>/);
  assert.doesNotMatch(publicHtml, /<script>alert\("x"\)<\/script>/);
  assert.match(publicHtml, new RegExp(`<link rel="canonical" href="${mutationOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/g/seo-public-gallery">`));
  assert.match(publicHtml, /property="og:image" content="https?:\/\/[^\"]+\/api\/galleries\/seo-public-gallery\/photos\/[a-f0-9-]+\/preview"/);
  assert.match(publicHtml, /name="twitter:card" content="summary_large_image"/);
  assert.match(publicHtml, /Say &quot;hello&quot; &amp; enjoy &lt;photos&gt;/);
  assert.doesNotMatch(publicHtml, /name="robots" content="noindex/);

  const icon = await call("/favicon.ico");
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type") ?? "", /image\/vnd\.microsoft\.icon|image\/x-icon/);
  const iconBytes = new Uint8Array(await icon.arrayBuffer());
  assert.deepEqual(iconBytes.subarray(0, 4), Uint8Array.from([0, 0, 1, 0]));
});

test("new public and private galleries work with only an admin password secret", async () => {
  const original = exported;
  try {
    exported = await server.getWorker(noGuestWorkerName).getExport();
    const directory = await json<{ galleries: Array<unknown> }>(await call("/api/galleries"));
    assert.deepEqual(directory.galleries, [], "a clean install starts with an empty gallery directory");
    const admin = await login("admin", noGuestAdminPassword);
    assert.equal(admin.response.status, 200);
    adminCookie = admin.cookie;
    for (const gallery of [
      {
        slug: "no-guest-public",
        visibility: "public",
      },
      {
        slug: "no-guest-private",
        visibility: "private",
        password: "no-legacy-private-gallery-password",
      },
    ]) {
      const created = await call(
        "/api/admin/galleries",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: gallery.slug, ...gallery }),
        },
        admin.cookie,
      );
      assert.equal(created.status, 201, gallery.slug);
    }
    assert.equal(
      (await call("/api/galleries/no-guest-public")).status,
      200,
      "a public gallery is available anonymously",
    );
    assert.equal(
      (await call("/api/galleries/no-guest-private")).status,
      401,
      "a private gallery still requires its own password",
    );
    const guest = await call("/api/galleries/no-guest-private/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        role: "guest",
        password: "no-legacy-private-gallery-password",
      }),
    });
    assert.equal(guest.status, 200);
    assert.ok(guest.headers.get("set-cookie"));
  } finally {
    exported = original;
    adminCookie = (await login("admin", adminPassword)).cookie;
  }
});

test("multiple galleries keep guest passwords, photos, and visibility isolated", async () => {
  const createGallery = async (
    slug: string,
    visibility: "private" | "public",
    password?: string,
  ) => {
    const response = await call(
      "/api/admin/galleries",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: `Test ${slug}`,
          slug,
          visibility,
          ...(password ? { password } : {}),
        }),
      },
      adminCookie,
    );
    assert.equal(response.status, 201, `create ${slug}`);
    return json<{ id: string; slug: string; photoCount: number }>(response);
  };
  await createGallery("test-public", "public");
  await createGallery(
    "test-private-a",
    "private",
    "first-gallery-password-2026",
  );
  await createGallery(
    "test-private-b",
    "private",
    "second-gallery-password-2026",
  );
  await createGallery(
    "test-private-same-password",
    "private",
    "first-gallery-password-2026",
  );
  await createGallery(
    "test-pending-delete",
    "private",
    "pending-delete-gallery-password-2026",
  );

  const anonymousList = await json<{
    galleries: Array<{ slug: string; visibility: string }>;
  }>(await call("/api/galleries"));
  assert.ok(anonymousList.galleries.some((item) => item.slug === "test-public"));
  assert.ok(
    !anonymousList.galleries.some((item) =>
      [
        "test-private-a",
        "test-private-b",
        "test-private-same-password",
      ].includes(item.slug),
    ),
  );
  const adminList = await json<{
    galleries: Array<{ slug: string }>;
  }>(await call("/api/admin/galleries", {}, adminCookie));
  for (const slug of [
    "default",
    "test-public",
    "test-private-a",
    "test-private-b",
    "test-private-same-password",
    "test-pending-delete",
  ])
    assert.ok(adminList.galleries.some((item) => item.slug === slug), slug);

  const aBase = "/api/galleries/test-private-a/admin/uploads";
  const bBase = "/api/galleries/test-private-b/admin/uploads";
  const publicBase = "/api/galleries/test-public/admin/uploads";
  const [aPhoto, bPhoto, publicPhoto] = await Promise.all([
    uploadPhoto(adminCookie, aBase),
    uploadPhoto(adminCookie, bBase),
    uploadPhoto(adminCookie, publicBase),
  ]);
  for (const [slug, id] of [
    ["test-private-a", aPhoto],
    ["test-private-b", bPhoto],
    ["test-public", publicPhoto],
  ]) {
    const complete = await call(
      `/api/galleries/${slug}/admin/uploads/${id}/complete`,
      { method: "POST" },
      adminCookie,
    );
    assert.equal(complete.status, 201, `publish ${slug}`);
  }

  const stagedAUpload = await uploadPhoto(adminCookie, aBase);
  const wrongGalleryUploadDelete = await call(
    `/api/galleries/test-private-b/admin/photos/${stagedAUpload}`,
    { method: "DELETE" },
    adminCookie,
  );
  assert.equal(wrongGalleryUploadDelete.status, 200);
  const bucket = (await server.getWorker().getEnv()).PHOTOS;
  assert.equal(
    (await bucket.list({ prefix: `uploads/${stagedAUpload}/` })).objects.length,
    3,
    "a wrong-gallery delete must leave the upload's R2 objects intact",
  );
  const ownerUploadList = await json<{
    uploads: Array<{ id: string }>;
  }>(
    await call(
      "/api/galleries/test-private-a/admin/uploads",
      {},
      adminCookie,
    ),
  );
  assert.ok(
    ownerUploadList.uploads.some((item) => item.id === stagedAUpload),
    "the upload remains tracked by its owning gallery",
  );
  assert.equal(
    (
      await call(
        `/api/galleries/test-private-a/admin/uploads/${stagedAUpload}/complete`,
        { method: "POST" },
        adminCookie,
      )
    ).status,
    201,
    "the owner can still complete its upload",
  );
  const wrongGalleryPhotoDelete = await call(
    `/api/galleries/test-private-b/admin/photos/${stagedAUpload}`,
    { method: "DELETE" },
    adminCookie,
  );
  assert.equal(wrongGalleryPhotoDelete.status, 200);
  assert.equal(
    (
      await call(
        `/api/galleries/test-private-a/photos/${stagedAUpload}/thumbnail`,
        {},
        adminCookie,
      )
    ).status,
    200,
    "a wrong-gallery photo delete must preserve owner media",
  );
  assert.equal(
    (await bucket.list({ prefix: `uploads/${stagedAUpload}/` })).objects.length,
    3,
    "a wrong-gallery photo delete must leave its R2 objects intact",
  );

  let guestLoginAttempt = 0;
  const loginGallery = async (slug: string, password: string) => {
    guestLoginAttempt += 1;
    const response = await call(`/api/galleries/${slug}/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": `192.0.2.${guestLoginAttempt}`,
      },
      body: JSON.stringify({ role: "guest", password }),
    });
    const setCookie = response.headers.get("set-cookie") ?? "";
    return { response, cookie: setCookie.split(";", 1)[0] };
  };
  const aGuest = await loginGallery(
    "test-private-a",
    "first-gallery-password-2026",
  );
  const bGuest = await loginGallery(
    "test-private-b",
    "second-gallery-password-2026",
  );
  assert.equal(aGuest.response.status, 200);
  assert.equal(bGuest.response.status, 200);
  assert.ok(aGuest.cookie);
  assert.ok(bGuest.cookie);
  const samePasswordGuest = await loginGallery(
    "test-private-same-password",
    "first-gallery-password-2026",
  );
  assert.equal(samePasswordGuest.response.status, 200);
  assert.equal(
    (
      await loginGallery("test-private-a", "second-gallery-password-2026")
    ).response.status,
    401,
  );

  const photoPath = (slug: string, id: string) =>
    `/api/galleries/${slug}/photos/${id}/thumbnail`;
  assert.equal((await call(photoPath("test-private-a", aPhoto))).status, 401);
  assert.equal((await call(photoPath("test-private-b", bPhoto))).status, 401);
  assert.equal((await call(photoPath("test-public", publicPhoto))).status, 200);
  assert.equal(
    (await call(photoPath("test-private-a", aPhoto), {}, aGuest.cookie)).status,
    200,
  );
  assert.equal(
    (await call(photoPath("test-private-b", bPhoto), {}, bGuest.cookie)).status,
    200,
  );
  assert.equal(
    (
      await call(
        photoPath("test-private-a", aPhoto),
        {},
        bGuest.cookie,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await call(
        photoPath("test-private-same-password", aPhoto),
        {},
        aGuest.cookie,
      )
    ).status,
    401,
    "even a shared password session is bound to its gallery",
  );
  const foreignCursor = await call(
    "/api/galleries/test-private-a?cursor=" + encodeURIComponent(bPhoto),
    {},
    adminCookie,
  );
  assert.equal(foreignCursor.status, 400);
  const foreignCover = await call(
    "/api/admin/galleries/test-private-a",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coverPhotoId: bPhoto }),
    },
    adminCookie,
  );
  assert.equal(foreignCover.status, 400);
  for (const invalidBody of [null, [], 42, { title: null }]) {
    const invalidPatch = await call(
      "/api/admin/galleries/test-private-a",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invalidBody),
      },
      adminCookie,
    );
    assert.equal(invalidPatch.status, 400, `reject PATCH ${JSON.stringify(invalidBody)}`);
  }
  const foreignComplete = await call(
    `/api/galleries/test-private-b/admin/uploads/${aPhoto}/complete`,
    { method: "POST" },
    adminCookie,
  );
  assert.ok([404, 409].includes(foreignComplete.status));
  assert.equal(
    (
      await call(
        photoPath("test-private-b", bPhoto),
        {},
        aGuest.cookie,
      )
    ).status,
    401,
  );

  const makePublic = await call(
    "/api/admin/galleries/test-private-a",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: "public" }),
    },
    adminCookie,
  );
  assert.equal(makePublic.status, 200);
  const rotate = await call(
    "/api/admin/galleries/test-private-a",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "rotated-gallery-password-2026" }),
    },
    adminCookie,
  );
  assert.equal(rotate.status, 200);
  assert.equal(
    (await json<{ visibility: string }>(rotate)).visibility,
    "public",
    "changing only the password preserves the current visibility",
  );
  const makePrivate = await call(
    "/api/admin/galleries/test-private-a",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: "private" }),
    },
    adminCookie,
  );
  assert.equal(makePrivate.status, 200);
  assert.equal(
    (await call(photoPath("test-private-a", aPhoto), {}, aGuest.cookie)).status,
    401,
  );
  assert.equal(
    (
      await loginGallery("test-private-a", "first-gallery-password-2026")
    ).response.status,
    401,
  );
  const rotatedGuest = await loginGallery(
    "test-private-a",
    "rotated-gallery-password-2026",
  );
  assert.equal(rotatedGuest.response.status, 200);
  assert.equal(
    (await call(photoPath("test-private-a", aPhoto), {}, rotatedGuest.cookie))
      .status,
    200,
  );
  assert.equal(
    (await call(photoPath("test-private-b", bPhoto), {}, bGuest.cookie)).status,
    200,
    "rotating one password leaves the other gallery session valid",
  );

  const removed = await call(
    "/api/admin/galleries/test-private-a",
    { method: "DELETE" },
    adminCookie,
  );
  assert.equal(removed.status, 200);
  assert.equal((await call("/api/galleries/test-private-a")).status, 404);
  assert.equal(
    (await call(photoPath("test-private-b", bPhoto), {}, bGuest.cookie)).status,
    200,
    "deleting one gallery leaves the other gallery and its photos intact",
  );
  assert.equal((await call(photoPath("test-public", publicPhoto))).status, 200);
  assert.equal(
    (await call("/api/gallery", {}, adminCookie)).status,
    200,
    "the explicitly seeded default gallery remains available",
  );

  const db = (await server.getWorker().getEnv()).DB;
  const pendingGallery = await db
    .prepare("SELECT id FROM galleries WHERE slug = 'test-pending-delete'")
    .first() as { id: string } | null;
  assert.ok(pendingGallery);
  const pendingUploadId = "00000000-0000-4000-8000-000000000003";
  await db
    .prepare(
      "INSERT INTO uploads (id, gallery_id, filename, content_type, bytes, width, height, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
    )
    .bind(
      pendingUploadId,
      pendingGallery.id,
      "still-uploading.jpg",
      "image/jpeg",
      jpeg.byteLength,
      1,
      1,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO upload_attempts (id, upload_id, variant, object_key, status, created_at) VALUES (?, ?, 'original', ?, 'pending', ?)",
    )
    .bind(
      "00000000-0000-4000-8000-000000000004",
      pendingUploadId,
      "uploads/pending-delete/original",
      new Date().toISOString(),
    )
    .run();
  const deferDelete = await call(
    "/api/admin/galleries/test-pending-delete",
    { method: "DELETE" },
    adminCookie,
  );
  assert.equal(deferDelete.status, 409);
  assert.equal(
    (await call("/api/galleries/test-pending-delete")).status,
    404,
    "a gallery queued for deletion is hidden from visitors",
  );
  const deleting = await json<{
    galleries: Array<{ slug: string; status?: string }>;
  }>(await call("/api/admin/galleries", {}, adminCookie));
  assert.equal(
    deleting.galleries.find((item) => item.slug === "test-pending-delete")
      ?.status,
    "deleting",
  );
  await db
    .prepare("UPDATE upload_attempts SET status = 'failed' WHERE upload_id = ?")
    .bind(pendingUploadId)
    .run();
  assert.equal(
    (
      await call(
        "/api/admin/galleries/test-pending-delete",
        { method: "DELETE" },
        adminCookie,
      )
    ).status,
    200,
    "admin can retry deletion after the pending upload is resolved",
  );
});

test("staged photos remain hidden until complete and original downloads retain their bytes", async () => {
  const id = await uploadPhoto();
  const beforeComplete = await call("/api/gallery", {}, adminCookie);
  assert.equal(beforeComplete.status, 200);
  assert.equal(
    (await json<{ photos: Array<{ id: string }> }>(beforeComplete)).photos.some(
      (photo) => photo.id === id,
    ),
    false,
  );
  for (const variant of ["original", "thumbnail", "preview"]) {
    assert.equal(
      (await call(`/api/photos/${id}/${variant}`, {}, adminCookie)).status,
      404,
    );
  }

  const complete = await call(
    `/api/admin/uploads/${id}/complete`,
    { method: "POST" },
    adminCookie,
  );
  assert.equal(complete.status, 201);
  const gallery = await json<{ photos: Array<{ id: string }> }>(
    await call("/api/gallery", {}, adminCookie),
  );
  assert.equal(
    gallery.photos.some((photo) => photo.id === id),
    true,
  );
  for (const variant of ["original", "thumbnail", "preview"]) {
    const guestMedia = await call(
      `/api/photos/${id}/${variant}`,
      {},
      guestCookie,
    );
    assert.equal(guestMedia.status, 200, `private guest can read ${variant}`);
    assert.equal(
      guestMedia.headers.get("cache-control"),
      variant === "original" ? "no-store, max-age=0" : "private, no-cache",
      `cache policy for ${variant}`,
    );
    if (variant === "original")
      assert.deepEqual(new Uint8Array(await guestMedia.arrayBuffer()), jpeg);
  }
  const adminMedia = await call(`/api/photos/${id}/original`, {}, adminCookie);
  assert.equal(adminMedia.status, 200);
  assert.match(adminMedia.headers.get("cache-control") ?? "", /no-store/i);
  assert.match(
    adminMedia.headers.get("content-disposition") ?? "",
    /attachment/i,
  );
  assert.deepEqual(new Uint8Array(await adminMedia.arrayBuffer()), jpeg);
});

test("public visibility permits anonymous requests then private visibility blocks direct media", async () => {
  const adminSessionBefore = await call("/api/session", {}, adminCookie);
  assert.equal(adminSessionBefore.status, 200);
  assert.deepEqual(await json(adminSessionBefore), {
    role: "admin",
    canView: true,
  });
  const id = await uploadPhoto();
  assert.equal(
    (
      await call(
        `/api/admin/uploads/${id}/complete`,
        { method: "POST" },
        adminCookie,
      )
    ).status,
    201,
  );
  const settings = {
    title: "Summer",
    date: "2026-08-10",
    description: "An event",
    visibility: "public",
    coverPhotoId: id,
  };
  const change = (body: unknown) =>
    call(
      "/api/admin/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      adminCookie,
    );
  assert.equal((await change(settings)).status, 200);
  const adminSessionPublic = await call("/api/session", {}, adminCookie);
  assert.equal(adminSessionPublic.status, 200);
  assert.deepEqual(await json(adminSessionPublic), {
    role: "admin",
    canView: true,
  });
  const publicGallery = await call("/api/gallery");
  assert.equal(publicGallery.status, 200);
  assert.match(publicGallery.headers.get("cache-control") ?? "", /no-store/i);
  assert.equal((await call(`/api/photos/${id}/thumbnail`)).status, 200);

  settings.visibility = "private";
  assert.equal((await change(settings)).status, 200);
  const adminSessionPrivate = await call("/api/session", {}, adminCookie);
  assert.equal(adminSessionPrivate.status, 200);
  assert.deepEqual(await json(adminSessionPrivate), {
    role: "admin",
    canView: true,
  });
  assert.equal((await call("/api/gallery", {}, adminCookie)).status, 200);
  assert.equal((await call("/api/gallery")).status, 401);
  const denied = await call(`/api/photos/${id}/thumbnail`);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("cache-control") ?? "", /no-store/i);
  assert.equal((await call("/api/gallery", {}, guestCookie)).status, 200);
  assert.equal(
    (await call(`/api/admin/photos/${id}`, { method: "DELETE" }, adminCookie))
      .status,
    200,
  );
  assert.equal(
    (await call(`/api/admin/photos/${id}`, { method: "DELETE" }, adminCookie))
      .status,
    200,
  );
  assert.equal(
    (await call(`/api/photos/${id}/thumbnail`, {}, adminCookie)).status,
    404,
  );
});

test("an expired admin session cannot change visibility", async () => {
  const current = await json<GalleryResponse>(
    await call("/api/gallery", {}, adminCookie),
  );
  const attempted = await call(
    "/api/admin/settings",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...current.event,
        visibility: current.event.visibility === "private" ? "public" : "private",
      }),
    },
    await expiredAdminCookie(),
  );
  assert.equal(attempted.status, 401);
  assert.deepEqual(await json(attempted), { error: "unauthorized" });

  const unchanged = await call("/api/gallery", {}, adminCookie);
  assert.equal(unchanged.status, 200);
  assert.equal((await json<GalleryResponse>(unchanged)).event.visibility,
    current.event.visibility);
});

test("mutation routes reject cross-origin requests and malformed uploads fail closed", async () => {
  const rejected = await exported.fetch(
    new URL("/api/admin/settings", mutationOrigin),
    {
      method: "PATCH",
      headers: {
        cookie: adminCookie,
        origin: "https://attacker.test",
        "content-type": "application/json",
      },
      body: "{}",
    },
  );
  assert.equal(rejected.status, 403);
  const invalid = await call(
    "/api/admin/uploads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "evil.svg",
        contentType: "image/svg+xml",
        bytes: 10,
        width: 1,
        height: 1,
      }),
    },
    adminCookie,
  );
  assert.ok([400, 415].includes(invalid.status));
  const oversized = await call(
    "/api/admin/uploads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "huge.jpg",
        contentType: "image/jpeg",
        bytes: 50 * 1024 * 1024 + 1,
        width: 1,
        height: 1,
      }),
    },
    adminCookie,
  );
  assert.ok([400, 413].includes(oversized.status));
  const tooManyPixels = await call(
    "/api/admin/uploads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "pixels.jpg",
        contentType: "image/jpeg",
        bytes: 100,
        width: 10_000,
        height: 6_001,
      }),
    },
    adminCookie,
  );
  assert.equal(tooManyPixels.status, 400);
});

test("unfinished uploads are visible only to admins and are removable", async () => {
  const created = await call(
    "/api/admin/uploads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "unfinished.jpg",
        contentType: "image/jpeg",
        bytes: jpeg.length,
        width: 1,
        height: 1,
      }),
    },
    adminCookie,
  );
  assert.equal(created.status, 201);
  const { id } = await json<{ id: string }>(created);
  assert.equal((await call("/api/admin/uploads", {}, guestCookie)).status, 403);
  const listing = await json<{ uploads: Array<{ id: string }> }>(
    await call("/api/admin/uploads", {}, adminCookie),
  );
  assert.ok(listing.uploads.some((upload) => upload.id === id));
  assert.ok(
    [404, 409].includes(
      (
        await call(
          `/api/admin/uploads/${id}/complete`,
          { method: "POST" },
          adminCookie,
        )
      ).status,
    ),
  );
  const removed = await call(
    `/api/admin/photos/${id}`,
    { method: "DELETE" },
    adminCookie,
  );
  assert.ok([200, 204].includes(removed.status));
  const afterRemoval = await json<{ uploads: Array<{ id: string }> }>(
    await call("/api/admin/uploads", {}, adminCookie),
  );
  assert.equal(
    afterRemoval.uploads.some((upload) => upload.id === id),
    false,
  );
});

test("upload status is admin-only, gallery-scoped, and reports pending, published, and deleting states", async () => {
  const created = await call(
    "/api/admin/uploads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "status-pending.jpg",
        contentType: "image/jpeg",
        bytes: jpeg.length,
        width: 1,
        height: 1,
      }),
    },
    adminCookie,
  );
  assert.equal(created.status, 201);
  const { id: pendingId } = await json<{ id: string }>(created);
  const pendingPath = `/api/admin/uploads/${pendingId}`;
  assert.equal((await call(pendingPath)).status, 401);
  assert.equal((await call(pendingPath, {}, guestCookie)).status, 403);
  assert.deepEqual(await json(await call(pendingPath, {}, adminCookie)), {
    status: "pending",
  });
  assert.equal(
    (
      await call(
        `/api/galleries/test-public/admin/uploads/${pendingId}`,
        {},
        adminCookie,
      )
    ).status,
    404,
    "an ID owned by another gallery is not disclosed",
  );

  const db = (await server.getWorker().getEnv()).DB;
  await db
    .prepare("UPDATE uploads SET status = 'deleting' WHERE id = ?")
    .bind(pendingId)
    .run();
  assert.deepEqual(await json(await call(pendingPath, {}, adminCookie)), {
    status: "deleting",
  });
  assert.equal(
    (await call(pendingPath, { method: "DELETE" }, adminCookie)).status,
    200,
  );
  assert.equal((await call(pendingPath, {}, adminCookie)).status, 404);

  const publishedId = await uploadPhoto(adminCookie);
  const complete = await call(
    `/api/admin/uploads/${publishedId}/complete`,
    { method: "POST" },
    adminCookie,
  );
  assert.equal(complete.status, 201);
  const published = await json<{
    status: string;
    photo: { id: string; filename: string; contentType: string };
  }>(await call(`/api/admin/uploads/${publishedId}`, {}, adminCookie));
  assert.equal(published.status, "published");
  assert.equal(published.photo.id, publishedId);
  assert.equal(published.photo.filename, "tiny.jpg");
  assert.equal(published.photo.contentType, "image/jpeg");
  const publishedPath = `/api/admin/uploads/${publishedId}`;
  await db
    .prepare("UPDATE photos SET status = 'deleting' WHERE id = ?")
    .bind(publishedId)
    .run();
  assert.deepEqual(await json(await call(publishedPath, {}, adminCookie)), {
    status: "deleting",
  });
  assert.equal(
    (await call(publishedPath, { method: "DELETE" }, adminCookie)).status,
    200,
  );
  assert.deepEqual(await json(await call(publishedPath, {}, adminCookie)), {
    status: "deleting",
  });
  assert.equal(
    (await call(`/api/admin/photos/${publishedId}`, { method: "DELETE" }, adminCookie)).status,
    200,
  );
  assert.equal((await call(publishedPath, {}, adminCookie)).status, 404);
});

test("upload creation accepts a stable UUID idempotently while rejecting collisions", async () => {
  const uploadId = "4b4d2ea8-b950-4b2f-9a4b-c6fa702d9fd1";
  const payload = (overrides: Record<string, unknown> = {}) => ({
    uploadId,
    filename: "stable.jpg",
    contentType: "image/jpeg",
    bytes: jpeg.length,
    width: 1,
    height: 1,
    ...overrides,
  });
  const create = (body: unknown, base = "/api/admin/uploads") =>
    call(
      base,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      adminCookie,
    );

  const first = await create(payload());
  assert.equal(first.status, 201);
  assert.deepEqual(await json(first), { id: uploadId });
  const repeated = await create(payload());
  assert.equal(repeated.status, 200);
  assert.deepEqual(await json(repeated), { id: uploadId });
  assert.equal((await create(payload({ filename: "different.jpg" }))).status, 409);
  assert.equal((await create(payload({ uploadId: "not-a-uuid" }))).status, 400);
  assert.equal(
    (
      await create(
        payload(),
        "/api/galleries/test-public/admin/uploads",
      )
    ).status,
    409,
    "an ID already owned by another gallery cannot be claimed",
  );

  for (const variant of ["original", "thumbnail", "preview"]) {
    const uploaded = await call(
      `/api/admin/uploads/${uploadId}/${variant}`,
      {
        method: "PUT",
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(jpeg.length),
        },
        body: jpeg,
      },
      adminCookie,
    );
    assert.equal(uploaded.status, 200, `upload ${variant}`);
  }
  assert.equal(
    (
      await call(
        `/api/admin/uploads/${uploadId}/complete`,
        { method: "POST" },
        adminCookie,
      )
    ).status,
    201,
  );
  const publishedRetry = await create(payload());
  assert.equal(publishedRetry.status, 200);
  assert.deepEqual(await json(publishedRetry), { id: uploadId });
  const db = (await server.getWorker().getEnv()).DB as {
    prepare(query: string): {
      bind(...values: unknown[]): {
        first<T>(): Promise<T | null>;
        run(): Promise<unknown>;
      };
    };
  };
  assert.equal(
    await db
      .prepare("SELECT COUNT(*) AS count FROM uploads WHERE id = ?")
      .bind(uploadId)
      .first<{ count: number }>()
      .then((row) => row?.count),
    0,
    "retrying an already-published ID must not recreate a pending upload",
  );
  const publishedObject = await db
    .prepare("SELECT original_key FROM photos WHERE id = ? AND status = 'published'")
    .bind(uploadId)
    .first<{ original_key: string }>();
  const photoCount = await db
    .prepare("SELECT photo_count FROM galleries WHERE id = (SELECT gallery_id FROM photos WHERE id = ?)")
    .bind(uploadId)
    .first<{ photo_count: number }>();
  const bucket = (await server.getWorker().getEnv()).PHOTOS;
  assert.ok(publishedObject);
  assert.ok(await bucket.get(publishedObject.original_key));
  await db
    .prepare(
      "INSERT INTO uploads (id, gallery_id, filename, content_type, bytes, width, height, created_at, updated_at) SELECT id, gallery_id, filename, content_type, bytes, width, height, created_at, created_at FROM photos WHERE id = ?",
    )
    .bind(uploadId)
    .run();
  assert.equal((await create(payload())).status, 200);
  assert.equal(
    (await call(`/api/admin/uploads/${uploadId}`, { method: "DELETE" }, adminCookie)).status,
    200,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT status FROM photos WHERE id = ?")
        .bind(uploadId)
        .first<{ status: string }>()
    )?.status,
    "published",
    "upload cleanup must leave the published photo record intact",
  );
  assert.ok(await bucket.get(publishedObject.original_key));
  assert.deepEqual(
    await db
      .prepare("SELECT photo_count FROM galleries WHERE id = (SELECT gallery_id FROM photos WHERE id = ?)")
      .bind(uploadId)
      .first<{ photo_count: number }>(),
    photoCount,
  );
  assert.equal((await create(payload({ width: 2 }))).status, 409);
  assert.equal(
    (
      await create(
        payload(),
        "/api/galleries/test-public/admin/uploads",
      )
    ).status,
    409,
    "a published ID from another gallery cannot be claimed",
  );
  await db
    .prepare("UPDATE photos SET status = 'deleting' WHERE id = ?")
    .bind(uploadId)
    .run();
  assert.equal((await create(payload())).status, 409);
  await call(`/api/admin/photos/${uploadId}`, { method: "DELETE" }, adminCookie);
});

test("invalid image bytes and mismatched stream lengths leave tracked, removable attempts", async () => {
  const create = await call(
    "/api/admin/uploads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "bad.jpg",
        contentType: "image/jpeg",
        bytes: jpeg.length,
        width: 1,
        height: 1,
      }),
    },
    adminCookie,
  );
  const { id } = await json<{ id: string }>(create);
  const malformed = await call(
    `/api/admin/uploads/${id}/original`,
    {
      method: "PUT",
      headers: { "content-type": "image/jpeg", "content-length": "4" },
      body: Uint8Array.of(1, 2, 3, 4),
    },
    adminCookie,
  );
  assert.equal(malformed.status, 400);
  const oversizedBytes = new Uint8Array(2 * 1024 * 1024 + 1);
  oversizedBytes.set(jpeg.slice(0, 3));
  const oversized = await call(
    `/api/admin/uploads/${id}/thumbnail`,
    {
      method: "PUT",
      headers: {
        "content-type": "image/jpeg",
        "content-length": String(oversizedBytes.length),
      },
      body: oversizedBytes,
    },
    adminCookie,
  );
  assert.equal(oversized.status, 413);
  const uploads = await json<{
    uploads: Array<{ id: string; variants: string[] }>;
  }>(await call("/api/admin/uploads", {}, adminCookie));
  assert.deepEqual(
    uploads.uploads.find((upload) => upload.id === id)?.variants,
    [],
  );
  assert.equal(
    (await call(`/api/admin/photos/${id}`, { method: "DELETE" }, adminCookie))
      .status,
    200,
  );
  const bucket = (await server.getWorker().getEnv()).PHOTOS;
  assert.deepEqual(
    (await bucket.list({ prefix: `uploads/${id}/` })).objects,
    [],
  );
});

test("thumbnail uploads accept JPEG, WebP and AVIF and proxy with the stored format", async () => {
  const webp = Uint8Array.of(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);
  const avif = new Uint8Array(24);
  avif.set([0, 0, 0, 24]);
  avif.set(new TextEncoder().encode("ftypmif1"), 4);
  avif.set(new TextEncoder().encode("avifmif1"), 16);

  for (const [contentType, thumbnail] of [
    ["image/jpeg", jpeg],
    ["image/webp", webp],
    ["image/avif", avif],
  ] as const) {
    const created = await call(
      "/api/admin/uploads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: "optimized.jpg",
          contentType: "image/jpeg",
          bytes: jpeg.length,
          width: 1,
          height: 1,
        }),
      },
      adminCookie,
    );
    assert.equal(created.status, 201);
    const { id } = await json<{ id: string }>(created);
    for (const [variant, body, type] of [
      ["original", jpeg, "image/jpeg"],
      ["thumbnail", thumbnail, contentType],
      ["preview", jpeg, "image/jpeg"],
    ] as const) {
      const response = await call(
        `/api/admin/uploads/${id}/${variant}`,
        {
          method: "PUT",
          headers: { "content-type": type, "content-length": String(body.length) },
          body,
        },
        adminCookie,
      );
      assert.equal(response.status, 200, `${variant} upload as ${type}`);
    }
    const complete = await call(
      `/api/admin/uploads/${id}/complete`,
      { method: "POST" },
      adminCookie,
    );
    assert.equal(complete.status, 201);

    const response = await call(`/api/photos/${id}/thumbnail`, {}, adminCookie);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), contentType);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), thumbnail);
  }
});

test("thumbnail upload rejects a MIME type that disagrees with its bytes", async () => {
  const created = await call(
    "/api/admin/uploads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "mismatched.jpg",
        contentType: "image/jpeg",
        bytes: jpeg.length,
        width: 1,
        height: 1,
      }),
    },
    adminCookie,
  );
  const { id } = await json<{ id: string }>(created);
  const avif = new Uint8Array(24);
  avif.set([0, 0, 0, 24]);
  avif.set(new TextEncoder().encode("ftypavif"), 4);
  avif.set(new TextEncoder().encode("avifmif1"), 16);

  for (const [type, body] of [["image/avif", jpeg], ["image/webp", avif]] as const) {
    const response = await call(
      `/api/admin/uploads/${id}/thumbnail`,
      {
        method: "PUT",
        headers: { "content-type": type, "content-length": String(body.length) },
        body,
      },
      adminCookie,
    );
    assert.equal(response.status, 400, `${type} with mismatched bytes`);
  }
  await call(`/api/admin/uploads/${id}`, { method: "DELETE" }, adminCookie);
});

test("uploads without a known Content-Length are rejected before R2 writes", async () => {
  const created = await call(
    "/api/admin/uploads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "invalid-length.jpg",
        contentType: "image/jpeg",
        bytes: jpeg.length,
        width: 1,
        height: 1,
      }),
    },
    adminCookie,
  );
  const { id } = await json<{ id: string }>(created);
  const response = await call(
    `/api/admin/uploads/${id}/original`,
    {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(jpeg);
          controller.close();
        },
      }),
    },
    adminCookie,
  );
  assert.equal(response.status, 400);
  const bucket = (await server.getWorker().getEnv()).PHOTOS;
  assert.deepEqual((await bucket.list({ prefix: `uploads/${id}/` })).objects, []);
  await call(`/api/admin/uploads/${id}`, { method: "DELETE" }, adminCookie);
});

test("retrying an already completed variant is idempotent and creates no orphan object", async () => {
  const id = await uploadPhoto();
  const repeated = await call(
    `/api/admin/uploads/${id}/original`,
    {
      method: "PUT",
      headers: {
        "content-type": "image/jpeg",
        "content-length": String(jpeg.length),
      },
      body: jpeg,
    },
    adminCookie,
  );
  assert.equal(repeated.status, 200);
  assert.equal(
    (
      await call(
        `/api/admin/uploads/${id}/complete`,
        { method: "POST" },
        adminCookie,
      )
    ).status,
    201,
  );
  const bucket = (await server.getWorker().getEnv()).PHOTOS;
  const stored = await bucket.list({ prefix: `uploads/${id}/` });
  assert.equal(stored.objects.length, 3);
  const original = await call(`/api/photos/${id}/original`, {}, adminCookie);
  assert.deepEqual(new Uint8Array(await original.arrayBuffer()), jpeg);
  assert.equal(
    (await call(`/api/admin/photos/${id}`, { method: "DELETE" }, adminCookie))
      .status,
    200,
  );
  assert.deepEqual(
    (await bucket.list({ prefix: `uploads/${id}/` })).objects,
    [],
  );
});

test("concurrent upload completion and deletion never publish a deleted photo or orphan R2 data", async () => {
  const create = await call(
    "/api/admin/uploads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "race.jpg",
        contentType: "image/jpeg",
        bytes: jpeg.length,
        width: 1,
        height: 1,
      }),
    },
    adminCookie,
  );
  const { id } = await json<{ id: string }>(create);
  const [put, deleted] = await Promise.all([
    call(
      `/api/admin/uploads/${id}/original`,
      {
        method: "PUT",
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(jpeg.length),
        },
        body: jpeg,
      },
      adminCookie,
    ),
    call(`/api/admin/photos/${id}`, { method: "DELETE" }, adminCookie),
  ]);
  assert.ok([200, 400, 404, 409].includes(put.status), `upload race status ${put.status}`);
  assert.equal(deleted.status, 200);
  assert.equal((await call("/api/gallery", {}, adminCookie)).status, 200);
  const gallery = await json<{ photos: Array<{ id: string }> }>(
    await call("/api/gallery", {}, adminCookie),
  );
  assert.equal(
    gallery.photos.some((photo) => photo.id === id),
    false,
  );
  const bucket = (await server.getWorker().getEnv()).PHOTOS;
  assert.deepEqual(
    (await bucket.list({ prefix: `uploads/${id}/` })).objects,
    [],
  );
});

test("concurrent finalize and delete leave neither a visible photo nor R2 objects", async () => {
  const id = await uploadPhoto();
  const [complete, deleted] = await Promise.all([
    call(`/api/admin/uploads/${id}/complete`, { method: "POST" }, adminCookie),
    call(`/api/admin/photos/${id}`, { method: "DELETE" }, adminCookie),
  ]);
  assert.ok([201, 404, 409].includes(complete.status));
  assert.equal(deleted.status, 200);
  const gallery = await json<{ photos: Array<{ id: string }> }>(
    await call("/api/gallery", {}, adminCookie),
  );
  assert.equal(
    gallery.photos.some((photo) => photo.id === id),
    false,
  );
  const bucket = (await server.getWorker().getEnv()).PHOTOS;
  assert.deepEqual(
    (await bucket.list({ prefix: `uploads/${id}/` })).objects,
    [],
  );
});

test("forged and expired session cookies do not authorize requests", async () => {
  assert.equal(
    (await call("/api/gallery", {}, "gallery_session=admin.9999999999.forged"))
      .status,
    401,
  );
  assert.equal(
    (await call("/api/gallery", {}, await expiredAdminCookie())).status,
    401,
  );
});

test("unconfigured direct delivery retains proxy media and omits signed credentials", async () => {
  const response = await call("/api/gallery", {}, adminCookie);
  const gallery = await json<GalleryResponse>(response);
  assert.equal(gallery.media, undefined);
  const signed = await call("/api/media", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ photos: [{ id: fixturePhotoId, variant: "thumbnail" }] }),
  }, adminCookie);
  assert.equal(signed.status, 200);
  assert.equal(await signed.json(), null);
});

test("signed manifests enforce ownership, published state, batch limits and current gallery access", async () => {
  const previous = exported;
  exported = await server.getWorker(signedWorkerName).getExport();
  try {
    const created = await call("/api/admin/galleries", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Signed delivery", slug: "signed-delivery", visibility: "public", password: "signed-gallery-password-2026" }),
    }, adminCookie);
    assert.equal(created.status, 201);
    const base = "/api/galleries/signed-delivery";
    const id = await uploadPhoto(adminCookie, `${base}/admin/uploads`);
    const requestMedia = (photos: unknown[], cookie = "") => call(`${base}/media`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ photos }),
    }, cookie);
    assert.equal((await requestMedia([{ id, variant: "thumbnail" }])).status, 404, "pending uploads never receive grants");
    assert.equal((await call(`${base}/admin/uploads/${id}/complete`, { method: "POST" }, adminCookie)).status, 201);
    const response = await call(base);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const gallery = await json<GalleryResponse>(response);
    assert.equal(gallery.total, 1);
    assert.equal(gallery.media?.items.length, 1);
    const grant = gallery.media!.items[0];
    assert.equal(grant.photoId, id);
    assert.equal(grant.variant, "thumbnail");
    assert.match(grant.version, /^[0-9a-f]{64}$/);
    assert.ok(grant.expiresAt > Date.now());
    assert.ok(grant.expiresAt <= Date.now() + 600_000);
    const url = new URL(grant.url);
    assert.equal(url.hostname, "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    assert.match(url.pathname, new RegExp(`/uploads/${id}/thumbnail/`));
    assert.doesNotMatch(grant.url, /local-signing-secret/);
    const original = await requestMedia([{ id, variant: "original" }, { id, variant: "preview" }]);
    assert.equal(original.status, 200);
    const originals = await json<NonNullable<GalleryResponse["media"]>>(original);
    assert.match(new URL(originals.items[0].url).searchParams.get("response-content-disposition") ?? "", /attachment;.*tiny.jpg/);
    assert.equal((await requestMedia([{ id: fixturePhotoId, variant: "thumbnail" }])).status, 404, "foreign gallery photos cannot be signed");
    assert.equal((await requestMedia([{ id, variant: "unknown" }])).status, 400);
    assert.equal((await requestMedia(Array.from({ length: 49 }, () => ({ id, variant: "thumbnail" })))).status, 400);
    const noOrigin = await exported.fetch(new URL(`${base}/media`, mutationOrigin), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ photos: [{ id, variant: "thumbnail" }] }),
    });
    assert.equal(noOrigin.status, 403);
    assert.equal((await call("/api/admin/galleries/signed-delivery", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility: "private" }),
    }, adminCookie)).status, 200);
    assert.equal((await requestMedia([{ id, variant: "thumbnail" }])).status, 401);
    const privateManifest = await json<NonNullable<GalleryResponse["media"]>>(await requestMedia([{ id, variant: "thumbnail" }], adminCookie));
    assert.notEqual(privateManifest.scope, gallery.media!.scope);
    assert.equal((await call("/api/admin/galleries/signed-delivery", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "rotated-signed-gallery-password-2026" }),
    }, adminCookie)).status, 200);
    const rotated = await json<NonNullable<GalleryResponse["media"]>>(await requestMedia([{ id, variant: "thumbnail" }], adminCookie));
    assert.notEqual(rotated.scope, privateManifest.scope);
    assert.equal((await call(`${base}/admin/photos/${id}`, { method: "DELETE" }, adminCookie)).status, 200);
    assert.equal((await requestMedia([{ id, variant: "thumbnail" }], adminCookie)).status, 404);
    const empty = await json<GalleryResponse>(await call(base, {}, adminCookie));
    assert.equal(empty.total, 0, "deletion updates the materialized count");
  } finally { exported = previous; }
});

test("gallery pagination survives boundary deletion and preserves timestamp ties", async () => {
  const slug = "pagination-order-test";
  const created = await call("/api/admin/galleries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Pagination order test", slug, visibility: "public" }),
  }, adminCookie);
  assert.equal(created.status, 201);
  const gallery = await json<{ id: string }>(created);
  const db = (await server.getWorker().getEnv()).DB;
  const rows = Array.from({ length: 55 }, (_, index) => ({
    id: `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`,
    createdAt: `2026-11-${String(8 - Math.floor(index / 20)).padStart(2, "0")}T12:00:00.000Z`,
  }));
  for (const row of rows) {
    await db.prepare(
      "INSERT INTO photos (id, filename, content_type, bytes, width, height, created_at, original_key, thumbnail_key, preview_key, gallery_id) VALUES (?, ?, 'image/jpeg', 1, 1, 1, ?, ?, ?, ?, ?)",
    ).bind(row.id, `${row.id}.jpg`, row.createdAt, `${row.id}/original`, `${row.id}/thumbnail`, `${row.id}/preview`, gallery.id).run();
  }
  const expected = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const first = await call(`/api/galleries/${slug}`);
  assert.equal(first.status, 200);
  const firstPage = await json<GalleryResponse>(first);
  assert.equal(firstPage.photos.length, 48);
  assert.ok(firstPage.nextCursor);
  const boundaryId = firstPage.photos.at(-1)!.id;
  const secondGallery = await call("/api/admin/galleries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Foreign cursor", slug: "foreign-photo-cursor", visibility: "public" }),
  }, adminCookie);
  assert.equal(secondGallery.status, 201);
  assert.equal((await call(`/api/galleries/foreign-photo-cursor?cursor=${encodeURIComponent(firstPage.nextCursor!)}`)).status, 400);
  assert.equal((await call(`/api/galleries/${slug}?cursor=`)).status, 400);
  const removed = await call(`/api/galleries/${slug}/admin/photos/${boundaryId}`, { method: "DELETE" }, adminCookie);
  assert.equal(removed.status, 200);
  const second = await call(`/api/galleries/${slug}?cursor=${encodeURIComponent(firstPage.nextCursor!)}`);
  assert.equal(second.status, 200);
  const secondPage = await json<GalleryResponse>(second);
  const actualIds = [...firstPage.photos, ...secondPage.photos]
    .map((photo) => photo.id)
    .filter((id) => id !== boundaryId);
  assert.deepEqual(actualIds, expected.map((row) => row.id).filter((id) => id !== boundaryId));
  assert.equal(new Set(actualIds).size, rows.length - 1);
  assert.equal(secondPage.nextCursor, null);
});

test("admin upload queue cursors are stable after boundary deletion and reject another gallery", async () => {
  const db = (await server.getWorker().getEnv()).DB;
  const ids = Array.from({ length: 105 }, (_, index) =>
    `10000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`,
  );
  for (const [index, id] of ids.entries()) {
    await db.prepare(
      "INSERT INTO uploads (id, gallery_id, filename, content_type, bytes, width, height, created_at, updated_at, status) VALUES (?, 'default', ?, 'image/jpeg', 1, 1, 1, ?, ?, 'pending')",
    ).bind(id, `${id}.jpg`, `2099-01-${String(1 + Math.floor(index / 20)).padStart(2, "0")}T00:00:00.000Z`, `2099-01-${String(1 + Math.floor(index / 20)).padStart(2, "0")}T00:00:00.000Z`).run();
  }
  const tiePhotoId = "20000000-0000-4000-9000-000000000001";
  await db.prepare(
    "INSERT INTO photos (id, gallery_id, filename, content_type, bytes, width, height, created_at, original_key, thumbnail_key, preview_key, status) VALUES (?, 'default', 'tie.jpg', 'image/jpeg', 1, 1, 1, '2099-01-01T00:00:00.000Z', 'tie/o', 'tie/t', 'tie/p', 'deleting')",
  ).bind(tiePhotoId).run();
  const first = await json<{ uploads: Array<{ id: string }>; nextCursor: string | null; total: number }>(
    await call("/api/admin/uploads", {}, adminCookie),
  );
  assert.equal(first.uploads.length, 100);
  assert.ok(first.nextCursor);
  assert.ok(first.total >= ids.length);
  const deletedBoundaryId = first.uploads.at(-1)!.id;
  await db.prepare("DELETE FROM uploads WHERE id = ?").bind(deletedBoundaryId).run();

  const otherGallery = await call("/api/admin/galleries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Cursor scope", slug: "cursor-scope", visibility: "public" }),
  }, adminCookie);
  assert.equal(otherGallery.status, 201);
  const foreign = await call(`/api/galleries/cursor-scope/admin/uploads?cursor=${encodeURIComponent(first.nextCursor!)}`, {}, adminCookie);
  assert.equal(foreign.status, 400);
  assert.equal((await call("/api/admin/uploads?cursor=invalid!", {}, adminCookie)).status, 400);
  assert.equal((await call("/api/admin/uploads?cursor=", {}, adminCookie)).status, 400);

  const seen = new Set(first.uploads.map((upload) => upload.id));
  let cursor: string | null = first.nextCursor as string | null;
  while (cursor) {
    const page = await json<{ uploads: Array<{ id: string }>; nextCursor: string | null }>(
      await call(`/api/admin/uploads?cursor=${encodeURIComponent(cursor)}`, {}, adminCookie),
    );
    for (const upload of page.uploads) {
      assert.equal(seen.has(upload.id), false, `duplicate queue entry ${upload.id}`);
      seen.add(upload.id);
    }
    cursor = page.nextCursor;
  }
  for (const id of ids) {
    if (id !== deletedBoundaryId) assert.ok(seen.has(id), `unreachable queue entry ${id}`);
  }
  assert.ok(seen.has(tiePhotoId), "same-time deleting photos remain reachable in the combined queue");
});

test("manual abandoned-upload cleanup requires an administrator and same-origin POST", async () => {
  assert.equal((await call("/api/admin/maintenance", { method: "POST" })).status, 401);
  const response = await call("/api/admin/maintenance", { method: "POST" }, adminCookie);
  assert.equal(response.status, 200);
  const result = await json<{ scanned: number; uploadsDeleted: number; failures: string[] }>(response);
  assert.ok(result.scanned <= 25);
  assert.equal(typeof result.uploadsDeleted, "number");
  assert.deepEqual(result.failures, []);
});

test("changing the admin password invalidates old sessions and permits a new login", async () => {
  exported = await server.getWorker(rotatedWorkerName).getExport();
  assert.equal((await call("/api/admin/uploads", {}, adminCookie)).status, 401);
  assert.equal((await call("/api/gallery", {}, guestCookie)).status, 401);
  const rotated = await login("admin", "rotated-admin-password-2026");
  assert.equal(rotated.response.status, 200);
  adminCookie = rotated.cookie;
  assert.equal((await call("/api/admin/uploads", {}, adminCookie)).status, 200);
  const guest = await login("guest", guestPassword);
  assert.equal(guest.response.status, 200);
  assert.equal((await call("/api/gallery", {}, guest.cookie)).status, 200);
});

test("repeated failed logins are throttled", async () => {
  const attempts = await Promise.all(
    Array.from({ length: 12 }, () => login("guest", "incorrect-password-2026")),
  );
  assert.ok(
    attempts.some(({ response }) => response.status === 429),
    "the rate limiter should return 429",
  );
});
