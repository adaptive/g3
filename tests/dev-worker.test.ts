import assert from "node:assert/strict";
import { afterAll, beforeAll, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type ViteDevServer } from "vite";
import { workerDev } from "../scripts/dev-worker";

let root = "";
let workerPath = "";
let vite: ViteDevServer | undefined;
let origin = "";
let previousWranglerLogPath: string | undefined;
let restoreWorkerStartup: (() => void) | undefined;
const runtimes: Array<{ disposed: boolean; dispose: () => Promise<void> }> = [];
const payload = Uint8Array.of(0, 1, 255, 128, 13, 10, 42);

function workerSource(revision: number) {
  return `
export default {
  async fetch(request, env) {
    await env.DB.exec("CREATE TABLE IF NOT EXISTS dev_probe (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL)");
    await env.DB.prepare("INSERT INTO dev_probe (revision) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM dev_probe)").run();
    const url = new URL(request.url);
    if (url.pathname !== "/api/probe") return new Response("missing", { status: 404 });
    if (request.method === "POST") {
      const bytes = await request.arrayBuffer();
      await env.PHOTOS.put("dev-probe/original", bytes, { httpMetadata: { contentType: "application/octet-stream" } });
      await env.DB.prepare("INSERT INTO dev_probe (revision) VALUES (?)").bind(${revision}).run();
    }
    const object = await env.PHOTOS.get("dev-probe/original");
    const bytes = object ? [...new Uint8Array(await new Response(object.body).arrayBuffer())] : null;
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS count FROM dev_probe").all();
    const schema = await env.DB.prepare("SELECT schema_version FROM gallery_schema WHERE id = 1").first();
    const response = Response.json({
      revision: ${revision},
      url: request.url,
      origin: request.headers.get("origin"),
      host: request.headers.get("host"),
      cookie: request.headers.get("cookie"),
      rows: results[0].count,
      schemaVersion: schema?.schema_version ?? null,
      bytes,
    });
    if (request.method === "POST") {
      response.headers.append("set-cookie", "probe=one; Path=/; HttpOnly; SameSite=Strict");
      response.headers.append("set-cookie", "probe-two=two; Path=/; HttpOnly; SameSite=Strict");
    }
    return response;
  },
};
`;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "adaptive-gallery-dev-worker-test-"));
  previousWranglerLogPath = process.env.WRANGLER_LOG_PATH;
  process.env.WRANGLER_LOG_PATH = join(root, "wrangler-logs");
  await mkdir(process.env.WRANGLER_LOG_PATH);
  workerPath = join(root, "worker", "index.ts");
  await mkdir(join(root, "worker"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>Vite fixture</title>");
  await writeFile(workerPath, workerSource(1));
  const schemaPath = join(root, "schema.sql");
  await writeFile(schemaPath, await readFile(join(import.meta.dirname, "../schema.sql"), "utf8"));
  const configPath = join(root, "wrangler.jsonc");
  const databaseName = `adaptive-gallery-dev-test-${crypto.randomUUID().slice(0, 8)}`;
  await writeFile(configPath, JSON.stringify({
    name: `adaptive-gallery-dev-test-${crypto.randomUUID().slice(0, 8)}`,
    main: workerPath,
    compatibility_date: "2026-11-01",
    d1_databases: [{
      binding: "DB",
      database_name: databaseName,
    }],
    r2_buckets: [{ binding: "PHOTOS", bucket_name: "adaptive-gallery-dev-test" }],
  }, null, 2));

  const initialization = Bun.spawn(
    [
      process.execPath,
      "--bun",
      join(import.meta.dirname, "../node_modules/wrangler/bin/wrangler.js"),
      "d1",
      "execute",
      "DB",
      "--local",
      "--file",
      schemaPath,
      "--config",
      configPath,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [initializationOut, initializationErr] = await Promise.all([
    new Response(initialization.stdout).text(),
    new Response(initialization.stderr).text(),
  ]);
  assert.equal(
    await initialization.exited,
    0,
    `Wrangler should initialize the clean fixture database before Vite starts:\n${initializationOut}\n${initializationErr}`,
  );

  const wrangler = await import("wrangler");
  const startWorker = wrangler.unstable_startWorker;
  const startupSpy = spyOn(wrangler, "unstable_startWorker").mockImplementation(async (...args) => {
    const worker = await startWorker(...args);
    const dispose = worker.dispose.bind(worker);
    const runtime = { disposed: false, dispose };
    runtimes.push(runtime);
    spyOn(worker, "dispose").mockImplementation(async () => {
      await dispose();
      runtime.disposed = true;
    });
    return worker;
  });
  restoreWorkerStartup = () => startupSpy.mockRestore();

  vite = await createServer({
    configFile: false,
    root,
    plugins: [workerDev({ configPath })],
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  assert(address && typeof address !== "string", "Vite should listen on a TCP port");
  origin = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  try {
    await vite?.close();
  } finally {
    restoreWorkerStartup?.();
    // A failing lifecycle assertion should still release its real workerd.
    await Promise.all(runtimes.filter((runtime) => !runtime.disposed).map((runtime) => runtime.dispose()));
    if (previousWranglerLogPath === undefined)
      delete process.env.WRANGLER_LOG_PATH;
    else process.env.WRANGLER_LOG_PATH = previousWranglerLogPath;
    if (root) await rm(root, { recursive: true, force: true });
  }
});

test("Vite forwards /api to persistent workerd and reloads changed Worker code", async () => {
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Vite fixture/);

  const post = await fetch(`${origin}/api/probe`, {
    method: "POST",
    headers: {
      origin,
      cookie: "viewer=gallery; theme=dark",
      "content-type": "application/octet-stream",
    },
    body: payload,
  });
  assert.equal(post.status, 200);
  const first = await post.json() as {
    revision: number;
    url: string;
    origin: string;
    host: string;
    cookie: string;
    rows: number;
    schemaVersion: number | null;
    bytes: number[];
  };
  assert.equal(new URL(first.url).origin, origin, "workerd must see the frontend origin in request.url");
  assert.equal(first.origin, origin);
  assert.equal(first.host, new URL(origin).host);
  assert.equal(first.cookie, "viewer=gallery; theme=dark");
  assert.equal(first.rows, 2, "Vite should see the row inserted into the initialized test database");
  assert.equal(first.schemaVersion, 1, "Vite should see the clean schema initialized by Wrangler");
  assert.deepEqual(first.bytes, [...payload], "R2 must preserve streamed binary uploads");
  const cookies = post.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], /^probe=one;/);
  assert.match(cookies[1], /^probe-two=two;/);

  await writeFile(workerPath, workerSource(2));
  const deadline = Date.now() + 15_000;
  let updated: typeof first | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/probe`);
      if (response.ok) {
        const result = await response.json() as typeof first;
        if (result.revision === 2) {
          updated = result;
          break;
        }
      }
    } catch {
      // The middleware briefly restarts workerd after the fixture file changes.
    }
    await Bun.sleep(100);
  }
  assert(updated, "Worker code should reload after the source file changes");
  assert.equal(updated.rows, 2, "D1 state should survive a Worker reload");
  assert.deepEqual(updated.bytes, [...payload], "R2 state should survive a Worker reload");
  assert.equal(new URL(updated.url).origin, origin);
});

test("a full Vite restart disposes its old Worker and preserves the replacement", async () => {
  assert(vite);
  for (let restart = 0; restart < 2; restart++) {
    const previous = runtimes.at(-1)!;
    assert.equal(previous.disposed, false);
    await vite.restart();
    assert.equal(previous.disposed, true, "restart must await disposal of the old Worker");
    const replacement = runtimes.at(-1)!;
    assert.notEqual(replacement, previous);
    assert.equal(replacement.disposed, false, "restart must leave the new Worker running");
    const address: import("node:net").AddressInfo | string | null | undefined = vite.httpServer?.address();
    assert(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${origin}/api/probe`);
    assert.equal(response.status, 200);
    const data = await response.json() as { revision: number; rows: number; bytes: number[] };
    assert.equal(data.revision, 2);
    assert.equal(data.rows, 2, "D1 state should survive a full Vite restart");
    assert.deepEqual(data.bytes, [...payload], "R2 state should survive a full Vite restart");
  }
  await vite.close();
  vite = undefined;
  assert(runtimes.every((runtime) => runtime.disposed), "close must dispose every remaining Worker");
});
