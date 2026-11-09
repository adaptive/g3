import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ViteDevServer } from "vite";

type LocalWorker = Awaited<ReturnType<typeof import("wrangler")["unstable_startWorker"]>>;

/** Bridge Bun's Vite server to a real, persistent workerd Worker. */
export function workerDev(options: { configPath?: string } = {}): Plugin {
  // Vite can reuse this plugin when restarting an inline configuration, and
  // configures the replacement server before tearing down the previous one.
  const shutdowns: Array<() => Promise<void>> = [];
  return {
    name: "gallery-worker-dev",
    apply: "serve",
    async closeServer() {
      await shutdowns.shift()?.();
    },
    async configureServer(server) {
      const { unstable_readConfig, unstable_startWorker } = await import("wrangler");
      const configPath = resolve(
        options.configPath ?? fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
      );
      const start = async () => {
        const config = unstable_readConfig({ config: configPath });
        const worker = await unstable_startWorker({
          // Vite serves assets before a build exists; Wrangler runs only the API.
          config: { ...config, assets: undefined },
          dev: {
            // Keep this state directory isolated from the user's normal Wrangler state.
            persist: process.env.ADAPTIVE_GALLERY_DEV_STATE_DIR ?? join(server.config.root, ".wrangler/state"),
            // Restart below instead of using Bun-incompatible in-place reloads.
            watch: false,
            logLevel: "error",
            server: { hostname: "127.0.0.1", port: 0 },
            inspector: false,
          },
        });
        try {
          await worker.ready;
          return worker;
        } catch (error) {
          await worker.dispose();
          throw error;
        }
      };
      let ready = start();
      await ready;
      let closed = false;
      const workerDir = join(server.config.root, "worker") + sep;
      const sharedDir = join(server.config.root, "src/shared") + sep;
      const configDir = dirname(configPath);
      const envFiles = [".dev.vars", ".env", ".env.local", `.env.${server.config.mode}`, `.env.${server.config.mode}.local`]
        .map((name) => join(configDir, name));
      const onChange = (event: string, filename: string) => {
        if (closed || !["add", "change", "unlink"].includes(event)) return;
        const path = resolve(filename);
        if (
          !path.startsWith(workerDir) && !path.startsWith(sharedDir) &&
          path !== configPath && !envFiles.includes(path)
        ) return;
        ready = ready.catch(() => undefined).then(async (previous) => {
          await previous?.dispose();
          if (closed) throw new Error("The development server has closed.");
          return start();
        });
        void ready.then(() => {
          if (!closed) server.ws.send({ type: "full-reload" });
        }).catch((error) => {
          if (!closed) server.config.logger.error(`Worker reload failed: ${error}`);
        });
      };
      server.watcher.add([workerDir, sharedDir, configPath, ...envFiles]);
      server.watcher.on("all", onChange);
      shutdowns.push(async () => {
        closed = true;
        server.watcher.off("all", onChange);
        await ready.then((worker) => worker.dispose(), () => undefined);
      });

      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split("?", 1)[0];
        if (pathname !== "/api" && !pathname?.startsWith("/api/")) {
          next();
          return;
        }
        void ready.then((worker) => serveApi(server, worker, request, response)).catch((error) => {
          if (response.headersSent) response.destroy(error);
          else next(error);
        });
      });
    },
  };
}

async function serveApi(
  server: ViteDevServer,
  worker: LocalWorker,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
) {
  // The service binding uses RPC, avoiding Wrangler's Bun-incompatible HTTP proxy.
  const runtime = worker.raw.runtimes.find((entry) => entry.mf);
  if (!runtime?.mf) throw new Error("The local Worker runtime is unavailable.");
  const service = await runtime.mf.getWorker(worker.config.name);
  const protocol = server.config.server.https ? "https" : "http";
  const host = incoming.headers.host ?? `127.0.0.1:${incoming.socket.localPort}`;
  const url = new URL(incoming.url ?? "/", `${protocol}://${host}`);
  const headers = new Headers();
  for (let i = 0; i < incoming.rawHeaders.length; i += 2)
    headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
  const controller = new AbortController();
  incoming.once("aborted", () => controller.abort());
  outgoing.once("close", () => {
    if (!outgoing.writableEnded) {
      controller.abort();
      incoming.destroy();
    }
  });
  const init: RequestInit & { duplex?: "half" } = {
    method: incoming.method,
    headers,
    signal: controller.signal,
  };
  if (incoming.method !== "GET" && incoming.method !== "HEAD") {
    init.body = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  const result = await service.fetch(
    new Request(url, init) as unknown as Parameters<typeof service.fetch>[0],
  );
  outgoing.statusCode = result.status;
  for (const [name, value] of result.headers) {
    if (name !== "set-cookie") outgoing.setHeader(name, value);
  }
  const cookies = result.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader("set-cookie", cookies);
  if (result.body)
    await pipeline(
      Readable.fromWeb(result.body as unknown as import("node:stream/web").ReadableStream),
      outgoing,
    );
  else outgoing.end();
}
