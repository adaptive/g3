import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface WranglerR2Bucket {
  binding: string;
  bucket_name?: string;
}

export interface WranglerConfig {
  r2_buckets?: WranglerR2Bucket[];
}

export interface R2ReadCorsPolicy {
  rules: Array<{
    allowed: {
      origins: [string];
      methods: ["GET", "HEAD"];
    };
  }>;
}

export interface CorsCliOptions {
  origin: string;
  bucket?: string;
  apply: boolean;
}

export interface CorsPlan {
  status: "dry-run" | "applied";
  bucket: string;
  origin: string;
  policy: R2ReadCorsPolicy;
  command: string[];
  note: string;
}

export function validateCorsOrigin(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("*") || value !== value.trim()) {
    throw new Error("--origin must be one exact HTTPS origin (or an HTTP localhost origin for development).");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--origin must be a valid exact HTTPS origin (HTTP is allowed only for localhost development).");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  ) {
    throw new Error("--origin must contain only scheme, host, and optional port; paths, credentials, queries, and fragments are not allowed.");
  }
  const isLocalhost = parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
    throw new Error("--origin must use HTTPS; HTTP is allowed only for localhost, 127.0.0.1, or [::1].");
  }
  return value;
}

function validateBucketName(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$/.test(value) || value.includes("..")) {
    throw new Error("Bucket name must be a 3–63 character lowercase R2 bucket name.");
  }
  return value;
}

export function parseCorsArgs(argv: string[]): CorsCliOptions {
  let origin: string | undefined;
  let bucket: string | undefined;
  let applyRequested = false;
  let dryRunRequested = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--apply") {
      applyRequested = true;
    } else if (flag === "--dry-run") {
      dryRunRequested = true;
    } else if (flag === "--origin" || flag === "--bucket") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
      if (flag === "--origin") {
        if (origin !== undefined) throw new Error("Pass --origin only once.");
        origin = validateCorsOrigin(value);
      } else {
        if (bucket !== undefined) throw new Error("Pass --bucket only once.");
        bucket = validateBucketName(value);
      }
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (applyRequested && dryRunRequested) throw new Error("Pass either --apply or --dry-run, not both.");
  if (!origin) throw new Error("Pass --origin with the exact website origin to allow.");
  return { origin, bucket, apply: applyRequested };
}

export function buildR2ReadCorsPolicy(origin: string): R2ReadCorsPolicy {
  return {
    rules: [{ allowed: { origins: [validateCorsOrigin(origin)], methods: ["GET", "HEAD"] } }],
  };
}

export function resolvePhotosBucket(config: WranglerConfig, override?: string): string {
  if (override) return validateBucketName(override);
  if (!Array.isArray(config.r2_buckets)) {
    throw new Error("wrangler.jsonc has no R2 bucket bindings.");
  }
  const photos = config.r2_buckets.find((binding) => binding.binding === "PHOTOS");
  if (!photos?.bucket_name) {
    throw new Error("Set bucket_name on the PHOTOS binding in wrangler.jsonc or pass --bucket.");
  }
  return validateBucketName(photos.bucket_name);
}

function getWranglerArgs(configPath: string, bucket: string, filePath: string): string[] {
  return ["--config", configPath, "r2", "bucket", "cors", "set", bucket, "--file", filePath];
}

export async function configureR2Cors(
  argv: string[],
  dependencies: {
    root?: string;
    configPath?: string;
    readConfig?: (path: string) => Promise<WranglerConfig> | WranglerConfig;
    runWrangler?: (args: string[]) => Promise<number>;
    temporaryDirectory?: string;
  } = {},
): Promise<CorsPlan> {
  const options = parseCorsArgs(argv);
  const root = resolve(dependencies.root ?? fileURLToPath(new URL("..", import.meta.url)));
  const configPath = resolve(dependencies.configPath ?? join(root, "wrangler.jsonc"));
  const config = dependencies.readConfig
    ? await dependencies.readConfig(configPath)
    : await readWranglerConfig(configPath);
  const bucket = resolvePhotosBucket(config, options.bucket);
  const policy = buildR2ReadCorsPolicy(options.origin);
  const placeholderFile = "<temporary-r2-cors.json>";
  const command = ["bun", "--bun", "wrangler", ...getWranglerArgs(configPath, bucket, placeholderFile)];
  if (!options.apply) {
    return {
      status: "dry-run",
      bucket,
      origin: options.origin,
      policy,
      command,
      note: "Dry run only. Wrangler cors set replaces existing bucket CORS rules. Inspect and merge any current rules before applying.",
    };
  }
  if (!dependencies.runWrangler) throw new Error("No Wrangler runner is available.");

  const tempDirectory = await mkdtemp(join(dependencies.temporaryDirectory ?? tmpdir(), "adaptive-gallery-r2-cors-"));
  try {
    const filePath = join(tempDirectory, "cors.json");
    await writeFile(filePath, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
    const args = getWranglerArgs(configPath, bucket, filePath);
    const exitCode = await dependencies.runWrangler(args);
    if (exitCode !== 0) throw new Error(`Wrangler CORS update failed with exit code ${exitCode}.`);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }

  return {
    status: "applied",
    bucket,
    origin: options.origin,
    policy,
    command,
    note: "R2 CORS update completed. Existing rules were replaced by this exact-origin read policy.",
  };
}

async function readWranglerConfig(configPath: string): Promise<WranglerConfig> {
  const { unstable_readConfig } = await import("wrangler");
  return unstable_readConfig({ config: configPath }) as WranglerConfig;
}

async function runWrangler(args: string[], root: string): Promise<number> {
  const child = Bun.spawn([process.execPath, "--bun", "wrangler", ...args], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

if (import.meta.main) {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const configPath = resolve(root, "wrangler.jsonc");
    const plan = await configureR2Cors(Bun.argv.slice(2), {
      root,
      configPath,
      runWrangler: (args) => runWrangler(args, root),
    });
    console.log(JSON.stringify(plan, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "R2 CORS configuration failed.");
    process.exitCode = 1;
  }
}
