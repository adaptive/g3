import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  buildR2ReadCorsPolicy,
  configureR2Cors,
  parseCorsArgs,
  resolvePhotosBucket,
  validateCorsOrigin,
  type WranglerConfig,
} from "../scripts/configure-r2-cors";

const wranglerConfig: WranglerConfig = {
  r2_buckets: [{ binding: "PHOTOS", bucket_name: "adaptive-gallery-photos" }],
};

test("accepts exact secure site origins and local development origins", () => {
  assert.equal(validateCorsOrigin("https://gallery.example.com"), "https://gallery.example.com");
  assert.equal(validateCorsOrigin("https://gallery.example.com:8443"), "https://gallery.example.com:8443");
  assert.equal(validateCorsOrigin("http://localhost:5173"), "http://localhost:5173");
  assert.equal(validateCorsOrigin("http://127.0.0.1:4173"), "http://127.0.0.1:4173");
  assert.equal(validateCorsOrigin("http://[::1]:4173"), "http://[::1]:4173");
});

test("rejects wildcard, non-local HTTP, paths, credentials, queries, and fragments", () => {
  for (const origin of [
    "*",
    "https://*.example.com",
    "http://gallery.example.com",
    "https://gallery.example.com/",
    "https://gallery.example.com/photos",
    "https://user:secret@gallery.example.com",
    "https://gallery.example.com?next=/",
    "https://gallery.example.com#section",
    "file:///gallery",
    " https://gallery.example.com",
  ]) {
    assert.throws(() => validateCorsOrigin(origin), origin);
  }
});

test("creates one read-only CORS rule for the exact configured origin", () => {
  const policy = buildR2ReadCorsPolicy("https://gallery.example.com");
  assert.deepEqual(policy, {
    rules: [{
      allowed: {
        origins: ["https://gallery.example.com"],
        methods: ["GET", "HEAD"],
      },
    }],
  });
  assert.doesNotMatch(JSON.stringify(policy), /\*|PUT|POST|DELETE|public|r2\.dev/i);
});

test("parses dry-run by default and validates explicit bucket overrides", () => {
  assert.deepEqual(parseCorsArgs(["--origin", "https://gallery.example.com"]), {
    origin: "https://gallery.example.com",
    bucket: undefined,
    apply: false,
  });
  assert.deepEqual(parseCorsArgs([
    "--origin", "https://gallery.example.com",
    "--bucket", "gallery-images",
    "--apply",
  ]), {
    origin: "https://gallery.example.com",
    bucket: "gallery-images",
    apply: true,
  });
  assert.throws(() => parseCorsArgs(["--origin", "https://gallery.example.com", "--bucket", "../secret"]), /Bucket name/);
  assert.throws(() => parseCorsArgs(["--origin", "https://gallery.example.com", "--unexpected"]), /Unknown option/);
  assert.throws(() => parseCorsArgs(["--origin", "https://gallery.example.com", "--apply", "--dry-run"]), /either --apply or --dry-run/);
});

test("uses the PHOTOS binding unless a validated bucket override is supplied", () => {
  assert.equal(resolvePhotosBucket(wranglerConfig), "adaptive-gallery-photos");
  assert.equal(resolvePhotosBucket(wranglerConfig, "gallery-images"), "gallery-images");
  assert.throws(() => resolvePhotosBucket({ r2_buckets: [] }), /PHOTOS binding/);
  assert.throws(() => resolvePhotosBucket({ r2_buckets: [{ binding: "PHOTOS" }] }), /bucket_name/);
});

test("dry run prints a JSON-ready plan without invoking Wrangler", async () => {
  let calls = 0;
  const plan = await configureR2Cors(["--origin", "https://gallery.example.com"], {
    root: "/project",
    configPath: "/project/wrangler.jsonc",
    readConfig: () => wranglerConfig,
    runWrangler: async () => { calls++; return 0; },
  });
  assert.equal(plan.status, "dry-run");
  assert.equal(plan.bucket, "adaptive-gallery-photos");
  assert.match(plan.note, /replaces existing bucket CORS rules/);
  assert.deepEqual(plan.command.slice(0, 5), ["bun", "--bun", "wrangler", "--config", "/project/wrangler.jsonc"]);
  assert.match(JSON.stringify(plan), /temporary-r2-cors\.json/);
  assert.equal(calls, 0);
});

test("apply writes only the exact CORS JSON to a temporary file and removes it afterward", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "adaptive-gallery-r2-cors-test-"));
  const tempParent = join(tempRoot, "files");
  await mkdir(tempParent);
  const seen: { args?: string[]; policy?: unknown } = {};
  try {
    const plan = await configureR2Cors([
      "--origin", "https://gallery.example.com",
      "--apply",
    ], {
      root: "/project",
      configPath: "/project/wrangler.jsonc",
      readConfig: () => wranglerConfig,
      temporaryDirectory: tempParent,
      runWrangler: async (args) => {
        seen.args = args;
        const filePath = args[args.indexOf("--file") + 1];
        seen.policy = JSON.parse(await readFile(filePath, "utf8"));
        return 0;
      },
    });
    assert.equal(plan.status, "applied");
    assert.equal(plan.bucket, "adaptive-gallery-photos");
    assert.deepEqual(seen.policy, plan.policy);
    assert.ok(seen.args?.includes("r2"));
    assert.ok(seen.args?.includes("cors"));
    assert.ok(seen.args?.includes("set"));
    assert.ok(!seen.args?.includes("--force"));
    assert.deepEqual(await readdir(tempParent), []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("failed apply reports a generic failure and still removes its temporary file", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "adaptive-gallery-r2-cors-failure-test-"));
  const tempParent = join(tempRoot, "files");
  await mkdir(tempParent);
  try {
    await assert.rejects(configureR2Cors([
      "--origin", "https://gallery.example.com",
      "--apply",
    ], {
      root: "/project",
      configPath: "/project/wrangler.jsonc",
      readConfig: () => wranglerConfig,
      temporaryDirectory: tempParent,
      runWrangler: async () => 7,
    }), /exit code 7/);
    assert.deepEqual(await readdir(tempParent), []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
