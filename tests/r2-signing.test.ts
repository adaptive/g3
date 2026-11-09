import assert from "node:assert/strict";
import { test } from "bun:test";
import { createR2Signer } from "../worker/r2-signing";

const config = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_BUCKET_NAME: "adaptive-gallery-photos",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "this-secret-is-only-for-tests-very-secret",
};

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function awsQuery(entries: Array<[string, string]>): string {
  return entries
    .map(([name, value]) => [awsEncode(name), awsEncode(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName
        ? (leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1)
        : leftName < rightName ? -1 : 1,
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(
    bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function referenceSignature(url: URL): Promise<string> {
  const values = [...url.searchParams.entries()].filter(([name]) => name !== "X-Amz-Signature");
  const query = awsQuery(values);
  const request = [
    "GET",
    url.pathname,
    query,
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(request));
  const date = url.searchParams.get("X-Amz-Date")!;
  const shortDate = date.slice(0, 8);
  const scope = url.searchParams.get("X-Amz-Credential")!.split("/").slice(1).join("/");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    date,
    scope,
    toHex(digest),
  ].join("\n");
  const hmac = async (key: CryptoKey | Uint8Array, value: string) => {
    const imported = key instanceof Uint8Array
      ? await crypto.subtle.importKey("raw", bufferSource(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      : key;
    return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(value)));
  };
  const kDate = await hmac(encoder.encode(`AWS4${config.R2_SECRET_ACCESS_KEY}`), shortDate);
  const kRegion = await hmac(kDate, "auto");
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  const signingKey = await crypto.subtle.importKey("raw", bufferSource(kSigning), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", signingKey, encoder.encode(stringToSign)));
}

test("no signing configuration retains the authenticated proxy fallback", () => {
  assert.equal(createR2Signer({}), null);
  assert.equal(createR2Signer({ R2_ACCOUNT_ID: "", R2_BUCKET_NAME: "" }), null);
});

test("partial or malformed configuration fails before signing", () => {
  assert.throws(
    () => createR2Signer({ ...config, R2_SECRET_ACCESS_KEY: undefined }),
    /requires R2_ACCOUNT_ID/,
  );
  assert.throws(
    () => createR2Signer({ ...config, R2_ACCOUNT_ID: "not-an-account-id" }),
    /32-character hexadecimal/,
  );
  assert.throws(
    () => createR2Signer({ ...config, R2_BUCKET_NAME: "../bucket" }),
    /bucket name/,
  );
});

test("GET signatures use R2 path-style addressing and encode unicode object keys", async () => {
  const signer = createR2Signer(config)!;
  const { url: signedUrl } = await signer.signGet("default/original/a b+!é.jpg");
  const url = new URL(signedUrl);
  assert.equal(url.host, `${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
  assert.equal(url.pathname, "/adaptive-gallery-photos/default/original/a%20b%2B%21%C3%A9.jpg");
  assert.equal(url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(url.searchParams.get("X-Amz-Credential")?.startsWith(`${config.R2_ACCESS_KEY_ID}/`), true);
  assert.match(url.searchParams.get("X-Amz-SignedHeaders") ?? "", /^host$/);
  assert.ok(Number(url.searchParams.get("X-Amz-Expires") ?? 0) > 0);
  assert.ok(Number(url.searchParams.get("X-Amz-Expires")) <= 600);
  assert.equal(url.searchParams.get("X-Amz-Signature"), await referenceSignature(url));
  assert.match(url.searchParams.get("response-cache-control") ?? "", /private, no-store/);
  assert.doesNotMatch(signedUrl, new RegExp(config.R2_SECRET_ACCESS_KEY));
});

test("caller-supplied expiry stays within the ten-minute lease", async () => {
  const signer = createR2Signer(config)!;
  const requestedExpiry = Date.now() + 120_000;
  const signed = await signer.signGet("default/thumbnail/photo.jpg", { expiresAt: requestedExpiry });
  const url = new URL(signed.url);
  assert.ok(Number(url.searchParams.get("X-Amz-Expires")) >= 119);
  assert.ok(Number(url.searchParams.get("X-Amz-Expires")) <= 120);
  assert.ok(signed.expiresAt >= requestedExpiry - 1000);
  assert.ok(signed.expiresAt <= requestedExpiry);
  await assert.rejects(
    signer.signGet("default/thumbnail/photo.jpg", { expiresAt: Date.now() + 601_000 }),
    /between 1 and 600 seconds/,
  );
  await assert.rejects(
    signer.signGet("default/thumbnail/photo.jpg", { expiresAt: Date.now() - 1000 }),
    /between 1 and 600 seconds/,
  );
});

test("original downloads sign response overrides and safely encode filenames", async () => {
  const signer = createR2Signer(config)!;
  const { url: signedUrl } = await signer.signGet("default/original/0001", {
    download: true,
    filename: "Madeira sunset 你好.jpg",
  });
  const url = new URL(signedUrl);
  const disposition = url.searchParams.get("response-content-disposition") ?? "";
  assert.match(disposition, /^attachment; filename=/);
  assert.match(disposition, /filename\*=UTF-8''/);
  assert.match(disposition, /%E4%BD%A0%E5%A5%BD/);
  assert.equal(url.searchParams.get("response-cache-control"), "private, no-store, max-age=0");
  assert.equal(url.searchParams.get("X-Amz-Signature"), await referenceSignature(url));
});

test("download response overrides reject missing or unsafe filenames", async () => {
  const signer = createR2Signer(config)!;
  await assert.rejects(signer.signGet("photo.jpg", { download: true }), /filename is required/);
  await assert.rejects(signer.signGet("photo.jpg", { filename: "bad\r\nfilename.jpg" }), /without control characters/);
});

test("signing-key cache distinguishes same-day credential rotation", async () => {
  const first = createR2Signer(config)!;
  const rotated = createR2Signer({
    ...config,
    R2_SECRET_ACCESS_KEY: "a-rotated-secret-used-only-for-this-test",
  })!;
  const firstUrl = new URL((await first.signGet("default/thumbnail/photo.jpg")).url);
  const rotatedUrl = new URL((await rotated.signGet("default/thumbnail/photo.jpg")).url);
  assert.notEqual(firstUrl.searchParams.get("X-Amz-Signature"), rotatedUrl.searchParams.get("X-Amz-Signature"));
});

test("signer rejects invalid object keys", async () => {
  const signer = createR2Signer(config)!;
  await assert.rejects(signer.signGet(""), /object key must contain/);
  await assert.rejects(signer.signGet("x".repeat(1025)), /object key must contain/);
});
