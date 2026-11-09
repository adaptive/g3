import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Run the project checks with a PATH that contains Bun and common system
 * utilities, but no Node.js executable. This catches accidental Node
 * requirements in scripts, package bins, Wrangler, and the dev server.
 *
 * Run with: bun scripts/check-toolchain.ts
 */

const bunPath = process.execPath;
const worktree = process.cwd();
const sandbox = await mkdtemp(join(tmpdir(), "adaptive-gallery-bun-only-"));
const toolBin = join(sandbox, "bin");
await mkdir(toolBin);

// Do not copy the caller's PATH wholesale: Bun distributions commonly put a
// `node` compatibility shim beside Bun, and Linux CI images commonly install
// Node in /usr/bin. Only expose Bun and a small allowlist of OS tools.
await symlink(bunPath, join(toolBin, "bun"));
const systemTools = [
  "bash",
  "cat",
  "cp",
  "curl",
  "dirname",
  "env",
  "git",
  "gzip",
  "mkdir",
  "mv",
  "pwd",
  "rm",
  "sed",
  "sh",
  "tar",
  "uname",
  "which",
];

for (const name of systemTools) {
  const path = Bun.which(name);
  if (path) await symlink(path, join(toolBin, name)).catch(() => {});
}

const path = toolBin;
if (Bun.which("node", { PATH: path })) {
  throw new Error("The isolated PATH unexpectedly resolves a node executable.");
}

const env = {
  ...process.env,
  PATH: path,
  // Keep Wrangler's log writes inside this disposable directory.
  WRANGLER_LOG_PATH: sandbox,
};

async function run(label: string, args: string[]) {
  console.log(`\n== ${label} ==`);
  const child = Bun.spawn(args, {
    cwd: worktree,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0)
    throw new Error(`${label} failed with exit code ${exitCode}.`);
}

async function devSmoke() {
  console.log("\n== Bun Vite dev-server smoke ==");
  const devState = join(sandbox, "dev-worker-state");
  await run("Initialize disposable Vite D1", [
    bunPath, "--bun", "wrangler", "d1", "execute", "DB",
    "--file", join(worktree, "schema.sql"), "--local", "--json", "--yes",
    "--persist-to", devState, "--config", join(worktree, "wrangler.jsonc"),
  ]);
  const probe = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(),
  });
  const port = probe.port;
  probe.stop(true);

  const child = Bun.spawn(
    [
      bunPath,
      "--bun",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: worktree,
      env: { ...env, ADAPTIVE_GALLERY_DEV_STATE_DIR: devState },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 20_000;
  let response: Response | undefined;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) break;
    } catch {
      // The server is still starting; retry until the bounded deadline.
    }
    await Bun.sleep(100);
  }

  let apiReady = false;
  let apiDiagnostic = "The frontend did not become ready.";
  const apiDeadline = Date.now() + 30_000;
  while (response?.ok && Date.now() < apiDeadline && child.exitCode === null) {
    try {
      const session = await fetch(`${url}api/session`, {
        signal: AbortSignal.timeout(3_000),
      });
      const body = await session.text();
      apiDiagnostic = `HTTP ${session.status}; cache-control=${session.headers.get("cache-control")}; body=${body.slice(0, 600)}`;
      let data: { canView?: unknown; error?: unknown } | null = null;
      try {
        data = JSON.parse(body);
      } catch {
        /* Keep the unexpected response in the diagnostic. */
      }
      apiReady =
        session.headers.get("cache-control")?.includes("no-store") === true &&
        ((session.ok && typeof data?.canView === "boolean") ||
          (session.status === 503 && data?.error === "setup_required"));
      if (apiReady) break;
    } catch (error) {
      apiDiagnostic = String(error);
    }
    // The Worker API can compile after the frontend has started serving HTML.
    await Bun.sleep(200);
  }

  child.kill();
  await child.exited;
  const [stdout, stderr] = await output;
  if (!response?.ok) {
    throw new Error(
      `Vite did not return a successful response.\n${stdout}\n${stderr}`,
    );
  }
  if (!apiReady)
    throw new Error(
      `The Vite Worker API did not respond correctly: ${apiDiagnostic}\n${stdout}\n${stderr}`,
    );
  console.log(`GET / returned ${response.status}; Worker session API passed.`);
}

try {
  console.log(`Bun ${Bun.version}; node is unavailable on PATH.`);
  await run("Frozen Bun install", [bunPath, "install", "--frozen-lockfile"]);
  await run("TypeScript", [bunPath, "run", "typecheck"]);
  await run("Tests", [bunPath, "run", "test"]);
  await run("Production build", [bunPath, "run", "build"]);
  await run("Disposable local D1 clean install", [bunPath, "scripts/check-clean-install.ts"]);
  await run("Wrangler deploy dry run", [bunPath, "run", "deploy:dry-run"]);
  await devSmoke();
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
