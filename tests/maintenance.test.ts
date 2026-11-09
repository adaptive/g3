import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { cleanupAbandonedUploads, cleanupDeletingGalleries, type MaintenanceEnv } from "../worker/maintenance";

const root = new URL("..", import.meta.url).pathname;
const schema = await readFile(`${root}schema.sql`, "utf8");

type R2Page = { objects: Array<{ key: string }>; truncated: boolean; cursor?: string };

function createHarness() {
  const database = new Database(":memory:");
  database.exec(schema);
  database.exec(`
    INSERT INTO galleries (id, slug, created_at) VALUES
      ('event-a', 'event-a', '2026-01-01T00:00:00.000Z'),
      ('event-b', 'event-b', '2026-01-02T00:00:00.000Z');
    INSERT INTO photos (id, filename, content_type, bytes, width, height, created_at, original_key, thumbnail_key, preview_key, gallery_id)
      VALUES ('legacy-photo', 'legacy.jpg', 'image/jpeg', 12, 1, 1, '2026-01-03T00:00:00.000Z', 'legacy/original', 'legacy/thumbnail', 'legacy/preview', 'event-a');
  `);

  const objects = new Set<string>();
  let failDeleteCount = 0;
  let queryCount = 0;
  const d1: MaintenanceEnv["DB"] = {
    prepare(query: string) {
      let values: SQLQueryBindings[] = [];
      return {
        bind(...bound: unknown[]) {
          values = bound.map((value) => {
            if (
              value === null ||
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "bigint" ||
              typeof value === "boolean"
            ) {
              return value;
            }
            throw new TypeError("The D1 fixture only accepts scalar SQL bindings.");
          });
          return this;
        },
        async first<T>() {
          queryCount++;
          return database.query(query).get(...values) as T | null;
        },
        async all<T>() {
          queryCount++;
          return {
            success: true,
            results: database.query(query).all(...values) as T[],
          };
        },
        async run() {
          queryCount++;
          const outcome = database.query(query).run(...values);
          return { success: true, meta: { changes: outcome.changes } };
        },
      };
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  const photos: MaintenanceEnv["PHOTOS"] = {
    async list({ prefix, cursor, limit }): Promise<R2Page> {
      const found = [...objects]
        .filter((key) => key.startsWith(prefix) && (!cursor || key > cursor))
        .sort()
        .slice(0, limit + 1);
      const truncated = found.length > limit;
      const page = found.slice(0, limit).map((key) => ({ key }));
      return {
        objects: page,
        truncated,
        cursor: truncated ? page.at(-1)?.key : undefined,
      };
    },
    async delete(keys) {
      if (failDeleteCount > 0) {
        failDeleteCount--;
        throw new Error("simulated R2 failure");
      }
      for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key);
    },
  };
  const env: MaintenanceEnv = { DB: d1, PHOTOS: photos };

  const insertUpload = (
    id: string,
    status: "pending" | "deleting",
    updatedAt: string,
  ) => {
    database
      .query(
        "INSERT INTO uploads (id, filename, content_type, bytes, width, height, created_at, updated_at, status, gallery_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, `${id}.jpg`, "image/jpeg", 12, 1, 1, updatedAt, updatedAt, status, "event-a");
  };
  const addPart = (id: string, variant: string, key: string) => {
    database
      .query("INSERT INTO upload_parts (upload_id, variant, object_key, bytes) VALUES (?, ?, ?, ?)")
      .run(id, variant, key, 12);
    objects.add(key);
  };
  const addAttempt = (
    id: string,
    uploadId: string,
    key: string,
    status = "ready",
    createdAt = "2026-01-01T00:00:00.000Z",
  ) => {
    database
      .query(
        "INSERT INTO upload_attempts (id, upload_id, variant, object_key, status, created_at) VALUES (?, ?, 'preview', ?, ?, ?)",
      )
      .run(id, uploadId, key, status, createdAt);
    objects.add(key);
  };
  return {
    database,
    objects,
    env,
    insertUpload,
    addPart,
    addAttempt,
    setDeleteFailure(count: number) {
      failDeleteCount = count;
    },
    get queryCount() {
      return queryCount;
    },
    resetQueryCount() {
      queryCount = 0;
    },
  };
}

test("a clean schema maintains photo counts through state changes", () => {
  const { database } = createHarness();
  try {
    assert.equal(
      (database.query("SELECT photo_count AS count FROM galleries WHERE id = 'event-a'").get() as { count: number }).count,
      1,
    );
    assert.equal(
      (database.query("SELECT photo_count AS count FROM galleries WHERE id = 'event-b'").get() as { count: number }).count,
      0,
    );

    database
      .query(
        "INSERT INTO photos (id, filename, content_type, bytes, width, height, created_at, original_key, thumbnail_key, preview_key, gallery_id) VALUES ('second', 'second.jpg', 'image/jpeg', 12, 1, 1, '2026-01-04T00:00:00.000Z', 's/o', 's/t', 's/p', 'event-a')",
      )
      .run();
    database.query("UPDATE photos SET status = 'deleting' WHERE id = 'legacy-photo'").run();
    assert.equal(
      (database.query("SELECT photo_count AS count FROM galleries WHERE id = 'event-a'").get() as { count: number }).count,
      1,
    );
    database.query("UPDATE photos SET gallery_id = 'event-b' WHERE id = 'second'").run();
    assert.deepEqual(
      database
        .query("SELECT id, photo_count AS count FROM galleries ORDER BY id")
        .all(),
      [
        { id: "event-a", count: 0 },
        { id: "event-b", count: 1 },
      ],
    );
    database.query("DELETE FROM photos WHERE id = 'second'").run();
    assert.equal(
      (database.query("SELECT photo_count AS count FROM galleries WHERE id = 'event-b'").get() as { count: number }).count,
      0,
    );
  } finally {
    database.close();
  }
});

test("gallery deletion is bounded, retryable, and removes recorded keys outside the upload prefix", async () => {
  const { database, objects, env, setDeleteFailure } = createHarness();
  try {
    database.query("UPDATE galleries SET status = 'deleting' WHERE id = 'event-a'").run();
    database.query("UPDATE photos SET status = 'deleting' WHERE id = 'legacy-photo'").run();
    objects.add("legacy/original");
    objects.add("legacy/thumbnail");
    objects.add("legacy/preview");
    database.query(
      "INSERT INTO uploads (id, filename, content_type, bytes, width, height, created_at, updated_at, status, gallery_id) VALUES ('00000000-0000-4000-8000-000000000020', 'orphan.jpg', 'image/jpeg', 12, 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'deleting', 'event-a')",
    ).run();
    database.query(
      "INSERT INTO upload_parts (upload_id, variant, object_key, bytes) VALUES ('00000000-0000-4000-8000-000000000020', 'original', 'legacy-attempt/original', 12)",
    ).run();
    objects.add("legacy-attempt/original");

    setDeleteFailure(1);
    const failed = await cleanupDeletingGalleries(env, { galleryId: "event-a", now: Date.parse("2026-01-05T00:00:00.000Z") });
    assert.deepEqual(failed.failures, ["event-a"]);
    assert.equal((database.query("SELECT status FROM galleries WHERE id = 'event-a'").get() as { status: string }).status, "deleting");
    assert.equal((database.query("SELECT COUNT(*) AS total FROM photos WHERE gallery_id = 'event-a'").get() as { total: number }).total, 1);

    const retried = await cleanupDeletingGalleries(env, { galleryId: "event-a", now: Date.parse("2026-01-05T00:00:00.000Z") });
    assert.deepEqual(retried.failures, []);
    assert.equal(retried.photosDeleted, 1);
    assert.equal(retried.uploadsDeleted, 1);
    assert.equal(retried.galleriesDeleted, 1);
    assert.equal(objects.has("legacy-attempt/original"), false);
    assert.equal(database.query("SELECT id FROM galleries WHERE id = 'event-a'").get(), null);
  } finally {
    database.close();
  }
});

test("gallery deletion advances through photos in batches of 100", async () => {
  const { database, env } = createHarness();
  try {
    database.query("UPDATE galleries SET status = 'deleting' WHERE id = 'event-a'").run();
    database.query("UPDATE photos SET status = 'deleting' WHERE id = 'legacy-photo'").run();
    for (let index = 0; index < 101; index++) {
      database.query(
        "INSERT INTO photos (id, filename, content_type, bytes, width, height, created_at, original_key, thumbnail_key, preview_key, gallery_id, status) VALUES (?, 'photo.jpg', 'image/jpeg', 12, 1, 1, ?, ?, ?, ?, 'event-a', 'deleting')",
      ).run(`20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, `2026-01-${String(1 + Math.floor(index / 28)).padStart(2, "0")}T00:00:00.000Z`, `batch/${index}/o`, `batch/${index}/t`, `batch/${index}/p`);
    }

    const first = await cleanupDeletingGalleries(env, { galleryId: "event-a" });
    assert.equal(first.photosDeleted, 100);
    assert.equal((database.query("SELECT COUNT(*) AS total FROM photos WHERE gallery_id = 'event-a'").get() as { total: number }).total, 2);
    assert.equal((database.query("SELECT status FROM galleries WHERE id = 'event-a'").get() as { status: string }).status, "deleting");

    const second = await cleanupDeletingGalleries(env, { galleryId: "event-a" });
    assert.equal(second.photosDeleted, 2);
    assert.equal(second.galleriesDeleted, 1);
    assert.equal(database.query("SELECT id FROM galleries WHERE id = 'event-a'").get(), null);
  } finally {
    database.close();
  }
});

test("cleanup removes stale uploads but preserves fresh uploads and published photos", async () => {
  const harness = createHarness();
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  try {
    harness.insertUpload("stale", "pending", "2026-11-01T00:00:00.000Z");
    harness.addPart("stale", "original", "uploads/stale/original/a");
    harness.addAttempt("stale-attempt", "stale", "uploads/stale/preview/b");
    harness.database.query("UPDATE uploads SET updated_at = '2026-11-01T00:00:00.000Z' WHERE id = 'stale'").run();
    harness.insertUpload("fresh", "pending", "2026-11-08T11:59:00.000Z");
    harness.addPart("fresh", "original", "uploads/fresh/original/a");
    harness.objects.add("legacy/original");
    harness.objects.add("legacy/thumbnail");

    const result = await cleanupAbandonedUploads(harness.env, { now });
    assert.equal(result.scanned, 1);
    assert.equal(result.uploadsDeleted, 1);
    assert.equal(result.uploadsRemaining, 0);
    assert.equal(harness.objects.has("uploads/stale/original/a"), false);
    assert.equal(harness.objects.has("uploads/stale/preview/b"), false);
    assert.equal(harness.objects.has("uploads/fresh/original/a"), true);
    assert.equal(harness.objects.has("legacy/original"), true);
  } finally {
    harness.database.close();
  }
});

test("R2 failures leave a deleting upload row so a later pass can retry", async () => {
  const harness = createHarness();
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  try {
    harness.insertUpload("retry", "pending", "2026-11-01T00:00:00.000Z");
    harness.addPart("retry", "original", "uploads/retry/original/a");
    harness.database.query("UPDATE uploads SET updated_at = '2026-11-01T00:00:00.000Z' WHERE id = 'retry'").run();
    harness.setDeleteFailure(1);
    const failed = await cleanupAbandonedUploads(harness.env, { now });
    assert.deepEqual(failed.failures, ["retry"]);
    assert.equal(failed.uploadsDeleted, 0);
    assert.equal(
      (harness.database.query("SELECT status FROM uploads WHERE id = 'retry'").get() as { status: string }).status,
      "deleting",
    );
    const retried = await cleanupAbandonedUploads(harness.env, { now });
    assert.equal(retried.failures.length, 0);
    assert.equal(retried.uploadsDeleted, 1);
    assert.equal(harness.objects.has("uploads/retry/original/a"), false);
  } finally {
    harness.database.close();
  }
});

test("cleanup reclaims an attempt which has been stale for the full retention window", async () => {
  const harness = createHarness();
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  try {
    harness.insertUpload("active", "pending", "2026-11-01T00:00:00.000Z");
    harness.addAttempt(
      "live-attempt",
      "active",
      "uploads/active/preview/live",
      "pending",
      "2026-11-01T00:00:00.000Z",
    );
    harness.database.query("UPDATE uploads SET updated_at = '2026-11-01T00:00:00.000Z' WHERE id = 'active'").run();
    const first = await cleanupAbandonedUploads(harness.env, { now });
    assert.equal(first.uploadsDeleted, 1);
    assert.equal(first.uploadsRemaining, 0);
    assert.equal(harness.objects.has("uploads/active/preview/live"), false);
    assert.equal(
      (harness.database.query("SELECT id FROM uploads WHERE id = 'active'").get()),
      null,
    );
    assert.equal(
      (harness.database.query("SELECT id FROM upload_attempts WHERE id = 'live-attempt'").get()),
      null,
    );
  } finally {
    harness.database.close();
  }
});

test("a recent pending write on a deleting upload remains tracked until it settles", async () => {
  const harness = createHarness();
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  const recentAttempt = new Date(now - 30 * 60 * 1000).toISOString();
  try {
    harness.insertUpload("deleting-live", "deleting", "2026-11-01T00:00:00.000Z");
    harness.addAttempt(
      "recent-live-attempt",
      "deleting-live",
      "uploads/deleting-live/preview/live",
      "pending",
      recentAttempt,
    );

    const whilePending = await cleanupAbandonedUploads(harness.env, { now });
    assert.equal(whilePending.uploadsDeleted, 0);
    assert.equal(whilePending.uploadsRemaining, 1);
    assert.equal(harness.objects.has("uploads/deleting-live/preview/live"), true);
    assert.equal(
      (harness.database.query("SELECT status FROM upload_attempts WHERE id = 'recent-live-attempt'").get() as { status: string }).status,
      "pending",
    );

    harness.database
      .query("UPDATE upload_attempts SET status = 'failed' WHERE id = 'recent-live-attempt'")
      .run();
    const afterPutSettles = await cleanupAbandonedUploads(harness.env, { now });
    assert.equal(afterPutSettles.uploadsDeleted, 1);
    assert.equal(harness.objects.has("uploads/deleting-live/preview/live"), false);
    assert.equal(
      harness.database.query("SELECT id FROM uploads WHERE id = 'deleting-live'").get(),
      null,
    );
  } finally {
    harness.database.close();
  }
});

test("new upload-part activity refreshes updated_at and protects an in-progress upload", async () => {
  const harness = createHarness();
  const now = Date.now();
  try {
    const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    const halfHourAgo = new Date(now - 30 * 60 * 1000).toISOString();
    harness.insertUpload("recent-activity", "pending", oneHourAgo);
    harness.addAttempt("recent-attempt", "recent-activity", "uploads/recent-activity/preview/live", "pending", halfHourAgo);
    const touched = (harness.database.query("SELECT updated_at FROM uploads WHERE id = 'recent-activity'").get() as { updated_at: string }).updated_at;
    assert.ok(Date.parse(touched) >= Date.parse(halfHourAgo));
    const result = await cleanupAbandonedUploads(harness.env, { now });
    assert.equal(result.scanned, 0);
    assert.equal(result.uploadsRemaining, 0);
    assert.equal(harness.objects.has("uploads/recent-activity/preview/live"), true);
  } finally {
    harness.database.close();
  }
});

test("new uploads inherit their creation time", async () => {
  const harness = createHarness();
  const now = Date.now();
  try {
    const createdAt = new Date(now - 60 * 60 * 1000).toISOString();
    harness.insertUpload("fresh-row", "pending", createdAt);
    const row = harness.database.query("SELECT created_at, updated_at FROM uploads WHERE id = 'fresh-row'").get() as { created_at: string; updated_at: string };
    assert.equal(row.updated_at, row.created_at);
    const result = await cleanupAbandonedUploads(harness.env, { now });
    assert.equal(result.scanned, 0);
    assert.equal(result.uploadsRemaining, 0);
  } finally {
    harness.database.close();
  }
});

test("R2 listing is paged and can resume after deleting the first page", async () => {
  const harness = createHarness();
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  try {
    harness.insertUpload("many", "pending", "2026-11-01T00:00:00.000Z");
    harness.objects.add("uploads/many/untracked/1");
    harness.objects.add("uploads/many/untracked/2");
    const first = await cleanupAbandonedUploads(harness.env, {
      now,
      objectPageSize: 1,
    });
    assert.equal(first.uploadsDeleted, 0);
    assert.equal(first.uploadsRemaining, 1);
    assert.equal(harness.objects.has("uploads/many/untracked/1"), false);
    assert.equal(harness.objects.has("uploads/many/untracked/2"), true);
    const second = await cleanupAbandonedUploads(harness.env, {
      now,
      objectPageSize: 1,
    });
    assert.equal(second.uploadsDeleted, 1);
    assert.equal(harness.objects.size, 0);
  } finally {
    harness.database.close();
  }
});

test("default cleanup batch stays within the Free-plan D1 subrequest budget", async () => {
  const harness = createHarness();
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  try {
    for (let index = 0; index < 26; index++) {
      const id = `stale-${String(index).padStart(2, "0")}`;
      harness.insertUpload(id, "pending", "2026-11-01T00:00:00.000Z");
    }
    harness.resetQueryCount();
    const result = await cleanupAbandonedUploads(harness.env, { now });
    assert.equal(result.scanned, 25);
    assert.equal(result.uploadsDeleted, 25);
    assert.equal(result.uploadsRemaining, 1);
    assert.ok(harness.queryCount < 1000, `${harness.queryCount} D1 statements were issued`);
  } finally {
    harness.database.close();
  }
});

test("cleanup resumes through many failed-attempt references in bounded batches", async () => {
  const harness = createHarness();
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  try {
    harness.insertUpload("many-refs", "pending", "2026-11-01T00:00:00.000Z");
    for (let index = 0; index < 137; index++) {
      const suffix = String(index).padStart(3, "0");
      harness.addAttempt(
        `attempt-${suffix}`,
        "many-refs",
        `uploads/many-refs/preview/${suffix}`,
        "failed",
      );
    }
    harness.database.query("UPDATE uploads SET updated_at = '2026-11-01T00:00:00.000Z' WHERE id = 'many-refs'").run();

    let passes = 0;
    let deleted = 0;
    while (passes < 10 && deleted < 137) {
      harness.resetQueryCount();
      const result = await cleanupAbandonedUploads(harness.env, {
        now,
        limit: 1,
        objectPageSize: 25,
      });
      assert.ok(harness.queryCount < 1000, `${harness.queryCount} D1 statements were issued`);
      assert.ok(result.objectsDeleted <= 50, `${result.objectsDeleted} objects exceeded this pass's bound`);
      deleted += result.objectsDeleted;
      passes++;
    }
    assert.equal(deleted, 137);
    assert.ok(passes > 1);
    assert.equal(harness.objects.size, 0);
    assert.equal(
      harness.database.query("SELECT id FROM uploads WHERE id = 'many-refs'").get(),
      null,
    );
  } finally {
    harness.database.close();
  }
});
