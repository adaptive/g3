const encoder = new TextEncoder();
const DEFAULT_EXPIRY_SECONDS = 600;
const MAX_EXPIRY_SECONDS = 600;
const SERVICE = "s3";
const REGION = "auto";
const MAX_SIGNING_KEY_CACHE_ENTRIES = 16;

export interface R2SignerConfig {
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

export interface SignedGetOptions {
  /** Absolute expiration time, in milliseconds since the Unix epoch. */
  expiresAt?: number;
  /** Original filename, for a browser download response override. */
  filename?: string;
  /** Return the object as a download instead of displaying it inline. */
  download?: boolean;
}

export interface SignedGet {
  url: string;
  /** Absolute expiration time, rounded down to the signed second. */
  expiresAt: number;
}

export interface R2Signer {
  signGet(key: string, options?: SignedGetOptions): Promise<SignedGet>;
}

interface CompleteConfig {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const signingKeys = new Map<string, Promise<CryptoKey>>();

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeObjectKey(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes instanceof ArrayBuffer ? bytes : bytes.buffer, bytes instanceof ArrayBuffer ? 0 : bytes.byteOffset, bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.byteLength), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function hmac(key: CryptoKey | Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = key instanceof Uint8Array
    ? await crypto.subtle.importKey("raw", bufferSource(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    : key;
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
}

function timestamp(date: Date) {
  const iso = date.toISOString();
  return {
    long: iso.replace(/[:-]|\.\d{3}/g, ""),
    day: iso.slice(0, 10).replace(/-/g, ""),
  };
}

function credentialScope(day: string) {
  return `${day}/${REGION}/${SERVICE}/aws4_request`;
}

function createSigningKeyResolver(config: CompleteConfig): (day: string) => Promise<CryptoKey> {
  // Hash the credential pair once per signer rather than repeating an extra
  // WebCrypto digest for each URL in a batch. The module cache contains only
  // the fingerprint and non-extractable derived key, never plaintext secrets.
  const fingerprint = sha256(`${config.accessKeyId}\0${config.secretAccessKey}`).then(hex);
  return async (day) => {
    const cacheKey = `${day}:${await fingerprint}`;
    let signingKey = signingKeys.get(cacheKey);
    if (signingKey) {
      signingKeys.delete(cacheKey);
      signingKeys.set(cacheKey, signingKey);
    } else {
      signingKey = (async () => {
        const dateKey = await hmac(encoder.encode(`AWS4${config.secretAccessKey}`), day);
        const regionKey = await hmac(dateKey, REGION);
        const serviceKey = await hmac(regionKey, SERVICE);
        return crypto.subtle.importKey(
          "raw",
          bufferSource(await hmac(serviceKey, "aws4_request")),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
      })();
      signingKeys.set(cacheKey, signingKey);
    }

    // Previous date keys are no longer useful. Bound credentials that rotate
    // repeatedly within the same day to a small most-recently-used cache.
    for (const oldKey of signingKeys.keys()) {
      if (!oldKey.startsWith(`${day}:`)) signingKeys.delete(oldKey);
    }
    while (signingKeys.size > MAX_SIGNING_KEY_CACHE_ENTRIES) {
      signingKeys.delete(signingKeys.keys().next().value!);
    }
    try {
      return await signingKey;
    } catch (error) {
      if (signingKeys.get(cacheKey) === signingKey) signingKeys.delete(cacheKey);
      throw error;
    }
  };
}

function contentDisposition(filename: string): string {
  if (!filename || filename.length > 255 || /[\r\n\0]/.test(filename)) {
    throw new TypeError("R2 download filename must be 1–255 characters without control characters.");
  }
  const asciiFallback = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/[\\"]|[\r\n]/g, "_")
    .slice(0, 150) || "download";
  const utf8Name = Array.from(encoder.encode(filename), (byte) => {
    const char = String.fromCharCode(byte);
    return /^[A-Za-z0-9!#$&+.^_`|~-]$/.test(char)
      ? char
      : `%${byte.toString(16).padStart(2, "0").toUpperCase()}`;
  }).join("");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Name}`;
}

function canonicalQuery(entries: Array<[string, string]>): string {
  return entries
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName !== rightName) return leftName < rightName ? -1 : 1;
      return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function configFrom(env: R2SignerConfig): CompleteConfig | null {
  const names = ["R2_ACCOUNT_ID", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
  const values = names.map((name) => env[name]?.trim() ?? "");
  if (values.every((value) => value === "")) return null;
  if (values.some((value) => value === "")) {
    throw new Error("R2 signing requires R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.");
  }
  const [rawAccountId, bucketName, accessKeyId, secretAccessKey] = values as [string, string, string, string];
  const accountId = rawAccountId.toLowerCase();
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("R2_ACCOUNT_ID must be a 32-character hexadecimal account ID.");
  }
  if (!/^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$/.test(bucketName) || bucketName.includes("..")) {
    throw new Error("R2_BUCKET_NAME must be a 3–63 character lowercase R2 bucket name.");
  }
  if (!/^[\x21-\x7e]{1,128}$/.test(accessKeyId) || !/^[\x21-\x7e]{1,256}$/.test(secretAccessKey)) {
    throw new Error("R2 signing credentials must be non-empty printable ASCII strings.");
  }
  return { accountId, bucketName, accessKeyId, secretAccessKey };
}

/**
 * Create read-only S3 Signature V4 URLs for direct R2 GETs. No request is made
 * to R2 while signing. Keep the returned URLs private: each is a bearer token.
 *
 * If none of the optional R2 signing configuration is supplied, return null so
 * callers can retain their authenticated Worker media route.
 */
export function createR2Signer(env: R2SignerConfig): R2Signer | null {
  const config = configFrom(env);
  if (!config) return null;

  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const basePath = `/${encodeRfc3986(config.bucketName)}/`;
  const signingKeyFor = createSigningKeyResolver(config);

  return {
    async signGet(key, options = {}) {
      if (typeof key !== "string" || key.length === 0 || encoder.encode(key).byteLength > 1024) {
        throw new TypeError("R2 object key must contain 1–1024 UTF-8 bytes.");
      }

      const signedAt = new Date();
      const signedTime = timestamp(signedAt);
      const nowSeconds = Math.floor(signedAt.getTime() / 1000);
      const expiresAt = options.expiresAt ?? (nowSeconds + DEFAULT_EXPIRY_SECONDS) * 1000;
      if (!Number.isFinite(expiresAt)) throw new TypeError("R2 URL expiry must be a finite timestamp in milliseconds.");
      const expirySeconds = Math.floor(expiresAt / 1000);
      const expiresIn = expirySeconds - nowSeconds;
      if (expiresIn < 1 || expiresIn > MAX_EXPIRY_SECONDS) {
        throw new RangeError("R2 signed URL expiry must be between 1 and 600 seconds from now.");
      }

      const pathname = `${basePath}${encodeObjectKey(key)}`;
      const scope = credentialScope(signedTime.day);
      const query: Array<[string, string]> = [
        ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
        ["X-Amz-Credential", `${config.accessKeyId}/${scope}`],
        ["X-Amz-Date", signedTime.long],
        ["X-Amz-Expires", String(expiresIn)],
        ["X-Amz-SignedHeaders", "host"],
        ["response-cache-control", "private, no-store, max-age=0"],
      ];
      if (options.download || options.filename) {
        if (!options.filename) throw new TypeError("An original filename is required for download URLs.");
        query.push(["response-content-disposition", contentDisposition(options.filename)]);
      }

      const queryString = canonicalQuery(query);
      const canonicalRequest = [
        "GET",
        pathname,
        queryString,
        `host:${host}\n`,
        "host",
        "UNSIGNED-PAYLOAD",
      ].join("\n");
      const stringToSign = [
        "AWS4-HMAC-SHA256",
        signedTime.long,
        scope,
        hex(await sha256(canonicalRequest)),
      ].join("\n");
      const keyForSigning = await signingKeyFor(signedTime.day);
      const signature = hex(await hmac(keyForSigning, stringToSign));
      const url = `https://${host}${pathname}?${queryString}&X-Amz-Signature=${signature}`;
      return { url, expiresAt: expirySeconds * 1000 };
    },
  };
}
