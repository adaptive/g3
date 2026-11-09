import assert from "node:assert/strict";
import { test } from "bun:test";
import { buildUsageQuery, collectUsage } from "../scripts/collect-usage";

const accountId = "a".repeat(32);
const now = new Date("2026-11-08T15:30:00.000Z");

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const fixture = {
  data: {
    viewer: {
      accounts: [{
        workersInvocationsAdaptive: [{
          sum: { requests: 120, errors: 2 },
          quantiles: { cpuTimeP50: 4, cpuTimeP99: 8 },
          dimensions: { datetime: "2026-11-08T12:00:00Z", scriptName: "gallery" },
        }],
        d1AnalyticsAdaptiveGroups: [{
          sum: { rowsRead: 700, rowsWritten: 11 },
          dimensions: { databaseId: "db-1", date: "2026-11-07" },
        }],
        d1StorageAdaptiveGroups: [{
          max: { databaseSizeBytes: 1024 }, dimensions: { databaseId: "db-1", date: "2026-11-07" },
        }],
        r2OperationsAdaptiveGroups: [
          { sum: { requests: 13 }, dimensions: { actionType: "PutObject", bucketName: "photos" } },
          { sum: { requests: 48 }, dimensions: { actionType: "GetObject", bucketName: "photos" } },
          { sum: { requests: 1 }, dimensions: { actionType: "NewAction", bucketName: "photos" } },
        ],
        r2StorageAdaptiveGroups: [
          { max: { objectCount: 2, payloadSize: 800, metadataSize: 20 }, dimensions: { bucketName: "photos", datetime: "2026-11-07T00:00:00Z" } },
          { max: { objectCount: 3, payloadSize: 900, metadataSize: 30 }, dimensions: { bucketName: "photos", datetime: "2026-11-08T00:00:00Z" } },
        ],
      }],
    },
  },
};

test("query is read-only and bounded to the account's previous UTC day", () => {
  const query = buildUsageQuery(accountId, {
    start: "2026-11-07T00:00:00.000Z",
    end: "2026-11-08T00:00:00.000Z",
    d1Date: "2026-11-07",
  });
  assert.match(query, /accountTag: "a{32}"/);
  assert.match(query, /datetime_geq: "2026-11-07T00:00:00\.000Z"/);
  assert.match(query, /datetime_leq: "2026-11-08T00:00:00\.000Z"/);
  assert.match(query, /date_geq: "2026-11-07"/);
  assert.match(query, /limit: 10000/);
  assert.doesNotMatch(query, /mutation\s/i);
});

test("collects supported metrics and keeps unknown actions out of billed class totals", async () => {
  let request: RequestInit | undefined;
  const result = await collectUsage({
    accountId, apiToken: "test-secret-token", now,
    fetchImpl: async (_input, init) => {
      request = init;
      return response(fixture);
    },
  });
  assert.equal(request?.method, "POST");
  assert.equal(new Headers(request?.headers).get("authorization"), "Bearer test-secret-token");
  assert.equal(result.collection.requestedRangeStart, "2026-11-07T00:00:00.000Z");
  assert.equal(result.collection.requestedRangeEnd, "2026-11-08T00:00:00.000Z");
  assert.equal(result.observed.workers.requests, 120);
  assert.equal(result.observed.workers.peakHourlyCpuTimeP99Value, 8);
  assert.equal(result.observed.workers.cpuTimeQuantilesByGroup[0].cpuTimeP50, 4);
  assert.equal(result.observed.d1.rowsRead, 700);
  assert.equal(result.observed.d1.rowsWritten, 11);
  assert.equal(result.observed.r2.classAOperations, 13);
  assert.equal(result.observed.r2.classBOperations, 48);
  assert.equal(result.observed.r2.latestStorageByBucket.photos.payloadBytes, 900);
  assert.match(result.collection.completenessWarnings.join(" "), /Unknown R2 action/);
  assert.equal(result.collection.billingEstimateEligible, false);
  assert.ok(result.raw);
  assert.equal(JSON.stringify(result).includes("test-secret-token"), false);
});

test("missing credentials and malformed account IDs fail before making a request", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return response(fixture); };
  await assert.rejects(collectUsage({ accountId, apiToken: "  ", fetchImpl }), /CF_API_TOKEN is required/);
  await assert.rejects(collectUsage({ accountId: "not-an-id", apiToken: "secret", fetchImpl }), /CF_ACCOUNT_ID/);
  assert.equal(called, false);
});

test("authentication and unsupported schema errors are explicit and never become zeroes", async () => {
  await assert.rejects(
    collectUsage({ accountId, apiToken: "secret", fetchImpl: async () => response({}, 403) }),
    /HTTP 403/,
  );
  await assert.rejects(
    collectUsage({ accountId, apiToken: "secret", fetchImpl: async () => response({ errors: [{ message: "Cannot query field rowsRead" }] }) }),
    /Cannot query field rowsRead/,
  );
});

test("network call has a bounded timeout", async () => {
  const capture: { signal: AbortSignal | null } = { signal: null };
  await collectUsage({
    accountId, apiToken: "test", now,
    fetchImpl: async (_input, init) => {
      capture.signal = init?.signal as AbortSignal;
      return response(fixture);
    },
  });
  assert.ok(capture.signal instanceof AbortSignal);
  assert.equal(capture.signal.aborted, false);
});

test("timeout failures are reported without credentials", async () => {
  await assert.rejects(
    collectUsage({
      accountId, apiToken: "do-not-print", now,
      fetchImpl: async () => { throw new DOMException("timed out", "TimeoutError"); },
    }),
    /timed out after 20 seconds/,
  );
});
