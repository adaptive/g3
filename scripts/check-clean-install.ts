import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { initializeSchema } from "./prepare-deploy";

const root = fileURLToPath(new URL("..", import.meta.url));
const schemaPath = join(root, "schema.sql");
const fixture = await mkdtemp(join(tmpdir(), "adaptive-gallery-d1-init-"));
const configPath = join(fixture, "wrangler.jsonc");
const config = {
  name: "adaptive-gallery-clean-install-check",
  compatibility_date: "2026-11-01",
  d1_databases: [
    { binding: "DB", database_name: "clean-install", database_id: "11111111-1111-4111-8111-111111111111" },
    { binding: "LEGACY_DB", database_name: "legacy-check", database_id: "22222222-2222-4222-8222-222222222222" },
  ],
};
await writeFile(configPath, JSON.stringify(config));

async function wrangler(args: string[]): Promise<string> {
  const configuredArgs = args.includes("--config") ? args : [...args, "--config", configPath];
  const localEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(key),
  ));
  const child = Bun.spawn([
    process.execPath, "--bun", "wrangler", ...configuredArgs,
    "--persist-to", fixture,
  ], { cwd: root, env: { ...localEnv, WRANGLER_LOG_PATH: fixture }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Wrangler failed (${exitCode}): ${stderr}\n${stdout}`);
  return stdout;
}

try {
  const database = { binding: "DB", database_name: "clean-install", database_id: config.d1_databases[0].database_id };
  assert.equal(await initializeSchema(database, "--local", wrangler, schemaPath, configPath), "initialized");
  await wrangler(["d1", "execute", "DB", "--command", "INSERT INTO galleries (id, slug, title, created_at) VALUES ('kept', 'kept', 'Keep this gallery', '2026-11-08T00:00:00.000Z')", "--local", "--json"]);
  assert.equal(await initializeSchema(database, "--local", wrangler, schemaPath, configPath), "already-initialized");
  const current = JSON.parse(await wrangler(["d1", "execute", "DB", "--command", "SELECT title FROM galleries WHERE id = 'kept'", "--local", "--json"]));
  assert.deepEqual(current[0].results, [{ title: "Keep this gallery" }]);

  const legacyDatabase = { binding: "LEGACY_DB", database_name: "legacy-check", database_id: config.d1_databases[1].database_id };
  await wrangler(["d1", "execute", "LEGACY_DB", "--command", "CREATE TABLE legacy_data (value TEXT); INSERT INTO legacy_data (value) VALUES ('Keep this value')", "--local", "--json"]);
  await assert.rejects(
    initializeSchema(legacyDatabase, "--local", wrangler, schemaPath, configPath),
    /already contains tables/,
  );
  const result = JSON.parse(await wrangler(["d1", "execute", "LEGACY_DB", "--command", "SELECT value FROM legacy_data", "--local", "--json"]));
  assert.deepEqual(result[0].results, [{ value: "Keep this value" }]);
  console.log("Disposable local D1 initialized twice; existing user schema was refused and retained.");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
