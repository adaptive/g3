import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";
import { Database } from "bun:sqlite";

const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");

test("clean schema installs version 1 with an empty gallery directory", () => {
  const database = new Database(":memory:");
  try {
    database.exec(schema);
    assert.deepEqual(
      database.query("SELECT schema_version FROM gallery_schema WHERE id = 1").get(),
      { schema_version: 1 },
    );
    assert.deepEqual(database.query("SELECT COUNT(*) AS total FROM galleries").get(), { total: 0 });
    assert.deepEqual(
      database.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      [
        { name: "galleries" },
        { name: "gallery_schema" },
        { name: "login_attempts" },
        { name: "photos" },
        { name: "upload_attempts" },
        { name: "upload_parts" },
        { name: "uploads" },
      ],
    );
    assert.deepEqual(
      (database.query("PRAGMA table_info(uploads)").all() as Array<{ name: string }>).map((row) => row.name),
      ["id", "gallery_id", "filename", "content_type", "bytes", "width", "height", "created_at", "updated_at", "status"],
    );
  } finally {
    database.close();
  }
});

test("clean schema requires a gallery for photos and unfinished uploads", () => {
  const database = new Database(":memory:");
  try {
    database.exec(schema);
    assert.throws(() => database.query(
      "INSERT INTO photos (id, gallery_id, filename, content_type, bytes, width, height, created_at, original_key, thumbnail_key, preview_key) VALUES ('photo', 'missing', 'a.jpg', 'image/jpeg', 1, 1, 1, '2026-01-01', 'a/o', 'a/t', 'a/p')",
    ).run());
    assert.throws(() => database.query(
      "INSERT INTO uploads (id, gallery_id, filename, content_type, bytes, width, height, created_at, updated_at) VALUES ('upload', 'missing', 'a.jpg', 'image/jpeg', 1, 1, 1, '2026-01-01', '2026-01-01')",
    ).run());
  } finally {
    database.close();
  }
});
