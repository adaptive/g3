import assert from "node:assert/strict";
import { test } from "bun:test";
import { ensureDatabase, initializeSchema } from "../scripts/prepare-deploy";

const database = {
  binding: "DB",
  database_name: "adaptive-gallery",
};

test("creates a missing named database without rewriting the template config", async () => {
  const calls: string[][] = [];
  await ensureDatabase(database, async (args) => {
    calls.push(args);
    return args[1] === "list" ? "[]" : "";
  });
  assert.deepEqual(calls, [
    ["d1", "list", "--json"],
    ["d1", "create", "adaptive-gallery", "--update-config=false"],
  ]);
});

test("reuses an existing database by name without creating one", async () => {
  const calls: string[][] = [];
  await ensureDatabase(database, async (args) => {
    calls.push(args);
    return JSON.stringify([{ name: "adaptive-gallery", uuid: "db-id" }]);
  });
  assert.deepEqual(calls, [["d1", "list", "--json"]]);
});

test("uses a custom configured database name when creating", async () => {
  const calls: string[][] = [];
  await ensureDatabase(
    { binding: "PHOTOS_DB", database_name: "my-wedding-photos" },
    async (args) => {
      calls.push(args);
      return args[1] === "list" ? "[]" : "";
    },
  );
  assert.deepEqual(calls, [
    ["d1", "list", "--json"],
    ["d1", "create", "my-wedding-photos", "--update-config=false"],
  ]);
});

test("skips all commands when a real database ID is configured", async () => {
  let calls = 0;
  await ensureDatabase(
    { ...database, database_id: "9a32d4cc-8e45-4ad9-9d0b-70e393a100c4" },
    async () => {
      calls += 1;
      return "";
    },
  );
  assert.equal(calls, 0);
});

test("does not create a database when listing fails", async () => {
  const calls: string[][] = [];
  await assert.rejects(
    ensureDatabase(database, async (args) => {
      calls.push(args);
      throw new Error("authentication failed");
    }),
    /authentication failed/,
  );
  assert.deepEqual(calls, [["d1", "list", "--json"]]);
});

test("rejects invalid list JSON without creating a database", async () => {
  const calls: string[][] = [];
  await assert.rejects(
    ensureDatabase(database, async (args) => {
      calls.push(args);
      return "not json";
    }),
  );
  assert.deepEqual(calls, [["d1", "list", "--json"]]);
});

test("rejects an invalid list shape without creating a database", async () => {
  const calls: string[][] = [];
  await assert.rejects(
    ensureDatabase(database, async (args) => {
      calls.push(args);
      return JSON.stringify({ databases: [] });
    }),
  );
  assert.deepEqual(calls, [["d1", "list", "--json"]]);
});

test("requires a database name when no ID is configured", async () => {
  let calls = 0;
  await assert.rejects(
    ensureDatabase({ binding: "DB" }, async () => {
      calls += 1;
      return "[]";
    }),
    /database_name/,
  );
  assert.equal(calls, 0);
});

test("rejects the all-zero placeholder ID", async () => {
  let calls = 0;
  await assert.rejects(
    ensureDatabase(
      { ...database, database_id: "00000000-0000-0000-0000-000000000000" },
      async () => {
        calls += 1;
        return "[]";
      },
    ),
    /placeholder|zero|real/i,
  );
  assert.equal(calls, 0);
});

const tables = ["gallery_schema", "galleries", "photos", "uploads", "upload_parts", "upload_attempts", "login_attempts"];
const columns = [
  ["gallery_schema", "id"], ["gallery_schema", "schema_version"],
  ...["id", "slug", "title", "event_date", "description", "visibility", "cover_photo_id", "password_salt", "password_hash", "password_version", "photo_count", "status", "created_at"].map((name) => ["galleries", name]),
  ...["id", "gallery_id", "filename", "content_type", "bytes", "width", "height", "created_at", "status", "original_key", "thumbnail_key", "preview_key"].map((name) => ["photos", name]),
  ...["id", "gallery_id", "filename", "content_type", "bytes", "width", "height", "created_at", "updated_at", "status"].map((name) => ["uploads", name]),
  ["upload_parts", "upload_id"], ["upload_parts", "variant"], ["upload_parts", "object_key"], ["upload_parts", "bytes"],
  ["upload_attempts", "id"], ["upload_attempts", "upload_id"], ["upload_attempts", "variant"], ["upload_attempts", "object_key"], ["upload_attempts", "status"], ["upload_attempts", "created_at"],
  ["login_attempts", "bucket"], ["login_attempts", "window_start"], ["login_attempts", "count"],
].map(([table_name, column_name]) => ({ table_name, column_name }));
const objects = [
  "photos_gallery_page", "photos_page", "uploads_gallery_created", "uploads_pending_stale",
  "upload_attempts_by_upload", "photos_count_after_insert", "photos_count_after_delete",
  "photos_count_after_update", "uploads_activity_insert", "upload_parts_activity_insert",
  "upload_parts_activity_update", "upload_parts_activity_delete", "upload_attempts_activity_insert",
  "upload_attempts_activity_update", "upload_attempts_activity_delete",
].map((name) => ({ name }));
const json = (results: unknown[]) => JSON.stringify([{ success: true, results }]);

test("initializes an empty database, then verifies the completed schema", async () => {
  const calls: string[][] = [];
  let installed = false;
  const run = async (args: string[]) => {
    calls.push(args);
    if (args.includes("--file")) { installed = true; return ""; }
    if (args.some((arg) => arg.includes("pragma_table_info"))) return json(columns);
    if (args.some((arg) => arg.includes("type = 'table'"))) return json(installed ? tables.map((name) => ({ name })) : []);
    if (args.some((arg) => arg.includes("schema_version"))) return json([{ schema_version: 1 }]);
    if (args.some((arg) => arg.includes("sqlite_schema WHERE type IN"))) return json(objects);
    return json(columns);
  };
  assert.equal(await initializeSchema(database, "--local", run, "/tmp/schema.sql", "/tmp/config.jsonc"), "initialized");
  assert.ok(calls.some((args) => args.includes("--file") && args.includes("/tmp/schema.sql")));
  assert.ok(calls.every((args) => args.includes("--local")));
  assert.ok(calls.every((args) => args.includes("--config") && args.includes("/tmp/config.jsonc")));
});

test("skips a valid version 1 database", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args.some((arg) => arg.includes("pragma_table_info"))) return json(columns);
    if (args.some((arg) => arg.includes("type = 'table'"))) return json(tables.map((name) => ({ name })));
    if (args.some((arg) => arg.includes("schema_version"))) return json([{ schema_version: 1 }]);
    if (args.some((arg) => arg.includes("sqlite_schema WHERE type IN"))) return json(objects);
    return json(columns);
  };
  assert.equal(await initializeSchema(database, "--remote", run), "already-initialized");
  assert.ok(calls.every((args) => args.includes("--remote")));
  assert.ok(!calls.some((args) => args.includes("--file")));
});

test("refuses a preexisting unmarked database without applying schema", async () => {
  const calls: string[][] = [];
  await assert.rejects(initializeSchema(database, "--local", async (args) => {
    calls.push(args);
    return json([{ name: "d1_migrations" }]);
  }), /already contains tables/);
  assert.ok(!calls.some((args) => args.includes("--file")));
});

test("refuses unsupported markers and incomplete current schemas", async () => {
  await assert.rejects(initializeSchema(database, "--local", async (args) => {
    if (args.some((arg) => arg.includes("pragma_table_info"))) return json(columns);
    if (args.some((arg) => arg.includes("type = 'table'"))) return json(tables.map((name) => ({ name })));
    if (args.some((arg) => arg.includes("schema_version"))) return json([{ schema_version: 0 }]);
    if (args.some((arg) => arg.includes("sqlite_schema WHERE type IN"))) return json(objects);
    return json(columns);
  }), /unsupported or incomplete/);
  await assert.rejects(initializeSchema(database, "--local", async (args) => {
    if (args.some((arg) => arg.includes("pragma_table_info"))) return json(columns.filter(({ table_name }) => table_name !== "photos"));
    if (args.some((arg) => arg.includes("type = 'table'"))) return json(tables.map((name) => ({ name })));
    if (args.some((arg) => arg.includes("schema_version"))) return json([{ schema_version: 1 }]);
    if (args.some((arg) => arg.includes("sqlite_schema WHERE type IN"))) return json(objects.filter(({ name }) => name !== "photos_count_after_update"));
    return json(columns);
  }), /unsupported or incomplete/);
});

test("refuses a current marker with a missing trigger without executing schema", async () => {
  const calls: string[][] = [];
  await assert.rejects(initializeSchema(database, "--local", async (args) => {
    calls.push(args);
    if (args.some((arg) => arg.includes("pragma_table_info"))) return json(columns);
    if (args.some((arg) => arg.includes("type = 'table'"))) return json(tables.map((name) => ({ name })));
    if (args.some((arg) => arg.includes("schema_version"))) return json([{ schema_version: 1 }]);
    if (args.some((arg) => arg.includes("sqlite_schema WHERE type IN"))) return json(objects.slice(1));
    return json(columns);
  }), /unsupported or incomplete/);
  assert.ok(!calls.some((args) => args.includes("--file")));
});

test("refuses a marked schema missing a runtime column", async () => {
  const calls: string[][] = [];
  await assert.rejects(initializeSchema(database, "--local", async (args) => {
    calls.push(args);
    if (args.some((arg) => arg.includes("pragma_table_info"))) {
      return json(columns.filter(({ table_name, column_name }) => !(table_name === "galleries" && column_name === "password_salt")));
    }
    if (args.some((arg) => arg.includes("type = 'table'"))) return json(tables.map((name) => ({ name })));
    if (args.some((arg) => arg.includes("schema_version"))) return json([{ schema_version: 1 }]);
    if (args.some((arg) => arg.includes("sqlite_schema WHERE type IN"))) return json(objects);
    return json(columns);
  }), /unsupported or incomplete/);
  assert.ok(!calls.some((args) => args.includes("--file")));
});

test("inspection failures stop before schema SQL", async () => {
  const calls: string[][] = [];
  await assert.rejects(initializeSchema(database, "--local", async (args) => {
    calls.push(args);
    throw new Error("inspection failed");
  }), /inspection failed/);
  assert.ok(!calls.some((args) => args.includes("--file")));
});
