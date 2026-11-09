import { fileURLToPath } from "node:url";

type DatabaseBinding = {
  binding: string;
  database_name?: string;
  database_id?: string;
};
type RunWrangler = (args: string[]) => Promise<string>;
type QueryResult<T> = { success: boolean; results: T[] };

const CONFIG_PATH = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("../schema.sql", import.meta.url));
const REQUIRED_COLUMNS = {
  gallery_schema: ["id", "schema_version"],
  galleries: [
    "id", "slug", "title", "event_date", "description", "visibility", "cover_photo_id",
    "password_salt", "password_hash", "password_version", "photo_count", "status", "created_at",
  ],
  photos: [
    "id", "gallery_id", "filename", "content_type", "bytes", "width", "height", "created_at",
    "status", "original_key", "thumbnail_key", "preview_key",
  ],
  uploads: [
    "id", "gallery_id", "filename", "content_type", "bytes", "width", "height", "created_at",
    "updated_at", "status",
  ],
  upload_parts: ["upload_id", "variant", "object_key", "bytes"],
  upload_attempts: ["id", "upload_id", "variant", "object_key", "status", "created_at"],
  login_attempts: ["bucket", "window_start", "count"],
} as const;
const REQUIRED_OBJECTS = [
  "photos_gallery_page", "photos_page", "uploads_gallery_created", "uploads_pending_stale",
  "upload_attempts_by_upload", "photos_count_after_insert", "photos_count_after_delete",
  "photos_count_after_update", "uploads_activity_insert", "upload_parts_activity_insert",
  "upload_parts_activity_update", "upload_parts_activity_delete", "upload_attempts_activity_insert",
  "upload_attempts_activity_update", "upload_attempts_activity_delete",
] as const;
const TABLES_QUERY =
  "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_cf_KV' ORDER BY name";
const COLUMNS_QUERY =
  `SELECT tbl.name AS table_name, column_info.name AS column_name FROM sqlite_schema AS tbl JOIN pragma_table_info(tbl.name) AS column_info WHERE tbl.type = 'table' AND tbl.name IN (${Object.keys(REQUIRED_COLUMNS).map((table) => `'${table}'`).join(", ")})`;
const OBJECTS_QUERY =
  "SELECT name FROM sqlite_schema WHERE type IN ('index', 'trigger') ORDER BY name";

/** Create D1 when needed without rewriting the template configuration. */
export async function ensureDatabase(
  database: DatabaseBinding,
  runWrangler: RunWrangler,
): Promise<void> {
  if (database.database_id === "00000000-0000-0000-0000-000000000000") {
    throw new Error("Remove the placeholder database_id from wrangler.jsonc, or replace it with an existing D1 database's real ID.");
  }
  if (database.database_id) return;
  if (!database.database_name) {
    throw new Error(`Set database_name for the ${database.binding} D1 binding before initializing it.`);
  }

  // Let Wrangler handle account selection. Only create after a successful
  // lookup, so permission and network errors cannot create an ambiguous DB.
  const databases: unknown = JSON.parse(await runWrangler(["d1", "list", "--json"]));
  if (!Array.isArray(databases) || databases.some((db) =>
    !db || typeof db !== "object" || typeof db.name !== "string"
  )) {
    throw new Error("Wrangler returned an invalid D1 database list; initialization stopped.");
  }
  if (databases.some((db) => db.name === database.database_name)) return;

  await runWrangler([
    "d1", "create", database.database_name,
    "--update-config=false",
  ]);
}

function parseQueryRows<T>(output: string, description: string): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`Could not inspect D1 schema (${description}); database initialization stopped.`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`Wrangler returned an invalid D1 inspection result (${description}); initialization stopped.`);
  }
  const result = parsed[0] as QueryResult<T> | null;
  if (!result || result.success !== true || !Array.isArray(result.results)) {
    throw new Error(`D1 schema inspection failed (${description}); database initialization stopped.`);
  }
  return result.results;
}

async function inspectRows<T>(
  binding: string,
  target: "--local" | "--remote",
  query: string,
  description: string,
  runWrangler: RunWrangler,
): Promise<T[]> {
  const output = await runWrangler([
    "d1", "execute", binding,
    "--command", query,
    target,
    "--json",
  ]);
  return parseQueryRows<T>(output, description);
}

function hasRequiredObjects(rows: { name: string }[]): boolean {
  const found = new Set(rows.map(({ name }) => name));
  return REQUIRED_OBJECTS.every((name) => found.has(name));
}

/**
 * Initialize only a clean database. A recognized current schema is left
 * untouched; any other application schema is refused with instructions to use
 * a fresh D1 database. This command never alters or copies existing data.
 */
export async function initializeSchema(
  database: DatabaseBinding,
  target: "--local" | "--remote",
  runWrangler: RunWrangler,
  schemaPath = SCHEMA_PATH,
  configPath = CONFIG_PATH,
): Promise<"initialized" | "already-initialized"> {
  const configuredRunner = (args: string[]) => runWrangler([...args, "--config", configPath]);
  const names = await inspectRows<{ name: string }>(
    database.binding, target, TABLES_QUERY, "table list", configuredRunner,
  );
  if (names.some((row) => !row || typeof row.name !== "string")) {
    throw new Error("Wrangler returned an invalid D1 table list; database initialization stopped.");
  }
  const tables = new Set(names.map(({ name }) => name));
  if (tables.has("gallery_schema")) {
    await verifySchema(database.binding, target, configuredRunner, "schema");
    return "already-initialized";
  }

  if (tables.size > 0) {
    throw new Error(`This D1 database already contains tables (${[...tables].slice(0, 4).join(", ")}). Adaptive Gallery initializes only an empty database. Use a new, empty D1 database; existing data was left untouched.`);
  }

  await runWrangler([
    "d1", "execute", database.binding,
    "--file", schemaPath,
    target,
    "--json",
    "--yes",
    "--config", configPath,
  ]);

  try {
    await verifySchema(database.binding, target, configuredRunner, "initialized schema");
  } catch {
    throw new Error("The clean-install schema did not initialize completely; stop before deploying and inspect D1.");
  }
  return "initialized";
}

async function verifySchema(
  binding: string,
  target: "--local" | "--remote",
  runWrangler: RunWrangler,
  description: string,
): Promise<void> {
  const versions = await inspectRows<{ schema_version: number }>(
    binding, target, "SELECT schema_version FROM gallery_schema WHERE id = 1",
    `${description} marker`, runWrangler,
  );
  const columns = await inspectRows<{ table_name: string; column_name: string }>(
    binding, target, COLUMNS_QUERY, `${description} columns`, runWrangler,
  );
  const objects = await inspectRows<{ name: string }>(
    binding, target, OBJECTS_QUERY, `${description} indexes and triggers`, runWrangler,
  );
  const columnNames = new Map<string, Set<string>>();
  for (const column of columns) {
    const names = columnNames.get(column.table_name) ?? new Set<string>();
    names.add(column.column_name);
    columnNames.set(column.table_name, names);
  }
  const complete = Object.entries(REQUIRED_COLUMNS).every(([table, required]) =>
    required.every((column) => columnNames.get(table)?.has(column)),
  );
  if (versions.length !== 1 || versions[0]?.schema_version !== 1 || !complete || !hasRequiredObjects(objects)) {
    throw new Error("This D1 database has an unsupported or incomplete Adaptive Gallery schema. Use a new, empty D1 database; existing data was left untouched.");
  }
}

async function runWrangler(args: string[]): Promise<string> {
  const command = Bun.spawn([
    process.execPath, "--bun", "wrangler", ...args,
  ], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdin: "inherit", stdout: "pipe", stderr: "inherit",
  });
  const output = await new Response(command.stdout).text();
  const exitCode = await command.exited;
  if (exitCode !== 0) {
    if (output) console.error(output);
    throw new Error(`Wrangler ${args.slice(0, 2).join(" ")} failed (exit ${exitCode}); D1 initialization stopped.`);
  }
  return output;
}

if (import.meta.main) {
  try {
    const target = Bun.argv.includes("--local")
      ? "--local"
      : Bun.argv.includes("--remote")
        ? "--remote"
        : null;
    if (!target || (Bun.argv.includes("--local") && Bun.argv.includes("--remote"))) {
      throw new Error("Choose exactly one initialization target: --local or --remote.");
    }

    const { unstable_readConfig } = await import("wrangler");
    const config = unstable_readConfig({ config: CONFIG_PATH });
    const database = config.d1_databases.find((binding: DatabaseBinding) => binding.binding === "DB");
    if (!database) throw new Error("Missing DB binding in wrangler.jsonc.");
    const configuredRunWrangler = (args: string[]) => runWrangler([...args, "--config", CONFIG_PATH]);
    if (target === "--remote") await ensureDatabase(database, configuredRunWrangler);
    const result = await initializeSchema(database, target, runWrangler);
    console.log(result === "initialized"
      ? `Initialized ${target === "--local" ? "local" : "remote"} D1 from the clean-install schema.`
      : `The ${target === "--local" ? "local" : "remote"} D1 already has the current schema.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
