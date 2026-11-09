import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  estimateCosts,
  estimateGallery,
  renderReport,
  type UsageInput,
} from "../scripts/usage-report";

const base = (): UsageInput => ({
  periodDays: 30,
  worker: { requests: 0, cpuMilliseconds: 0, maxDailyRequests: 0, maxCpuMillisecondsPerInvocation: 1 },
  d1: { rowsRead: 0, rowsWritten: 0, storageGB: 0, maxDailyRowsRead: 0, maxDailyRowsWritten: 0 },
  r2: { storageGB: 0, classAOperations: 0, classBOperations: 0 },
});

test("R2 free thresholds and one-unit overages round upward", () => {
  const usage = base();
  usage.r2 = { storageGB: 10, classAOperations: 1_000_000, classBOperations: 10_000_000 };
  assert.equal(estimateCosts(usage).paid.r2, 0);
  usage.r2 = { storageGB: 10.01, classAOperations: 1_000_001, classBOperations: 10_000_001 };
  // R2 rounds storage to 11 GB and both operation totals to the next million.
  assert.equal(estimateCosts(usage).paid.r2, 4.88);
});

test("paid estimate adds worker base and only usage above included allowances", () => {
  const usage = base();
  usage.worker = {
    requests: 15_000_000,
    cpuMilliseconds: 40_000_000,
    maxDailyRequests: 500_000,
    maxCpuMillisecondsPerInvocation: 15,
  };
  usage.d1 = {
    rowsRead: 26_000_000_000,
    rowsWritten: 51_000_000,
    storageGB: 6,
    maxDailyRowsRead: 900_000_000,
    maxDailyRowsWritten: 2_000_000,
  };
  const paid = estimateCosts(usage).paid;
  assert.equal(paid.worker, 6.7);
  assert.equal(paid.d1, 2.75);
  assert.equal(paid.total, 9.45);
});

test("free usage above daily limits is flagged instead of billed as overage", () => {
  const usage = base();
  usage.worker.maxDailyRequests = 100_001;
  usage.d1.maxDailyRowsRead = 5_000_001;
  const free = estimateCosts(usage).free;
  assert.equal(free.freeWorkerStatus, "over daily limit");
  assert.equal(free.freeD1Status, "over daily limit");
  assert.equal(free.total, 0);
});

test("gallery model separates signed Worker requests from R2 GET savings", () => {
  const result = estimateGallery({ pageViews: 1_000_000 });
  assert.equal(result.oldWorkerRequests, 50_000_000);
  assert.equal(result.signedWorkerRequests, 2_000_000);
  // The signed media manifest is included in the existing gallery response.
  assert.equal(result.currentPaidWorkerRequestCost, 17);
  assert.equal(result.signedPaidWorkerRequestCost, 5);
  assert.equal(result.currentR2Gets, 48_000_000);
  assert.equal(result.signedR2Gets, 48_000_000);
  assert.equal(result.currentR2ReadCost, 13.68);
  assert.equal(result.signedR2ReadCost, 13.68);
});

test("browser cache scenario reduces R2 reads while keeping the worker model explicit", () => {
  const result = estimateGallery({ pageViews: 1_000_000, imageCacheHitRate: 0.5 });
  assert.equal(result.signedWorkerRequests, 2_000_000);
  assert.equal(result.signedR2Gets, 24_000_000);
  assert.equal(result.signedR2ReadCost, 5.04);
});

test("a separate batch signing endpoint can model its extra Worker request", () => {
  const result = estimateGallery({ pageViews: 1, signingRequestsPerView: 1 });
  assert.equal(result.signedWorkerRequests, 3);
});

test("missing daily evidence remains unverified and is disclosed", () => {
  const usage = base();
  delete usage.worker.maxDailyRequests;
  delete usage.d1.maxDailyRowsRead;
  const report = renderReport(usage);
  assert.match(report, /Free Workers checks: unverified/);
  assert.match(report, /not a live Cloudflare read/);
});

test("rejects invalid numbers and cache rates", () => {
  const usage = base();
  usage.r2.storageGB = Number.NaN;
  assert.throws(() => estimateCosts(usage), /r2\.storageGB/);
  assert.throws(() => estimateGallery({ pageViews: 1, imageCacheHitRate: 1.1 }), /between 0 and 1/);
});
