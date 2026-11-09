/**
 * Offline Cloudflare cost estimator. Input values must come from one account's
 * billing period; this tool never calls Cloudflare or reads credentials.
 * Run: bun scripts/usage-report.ts usage.json
 */
export interface UsageInput {
  periodDays: number;
  source?: string;
  worker: {
    requests: number;
    cpuMilliseconds: number;
    maxDailyRequests?: number;
    maxCpuMillisecondsPerInvocation?: number;
  };
  d1: {
    rowsRead: number;
    rowsWritten: number;
    storageGB: number;
    maxDailyRowsRead?: number;
    maxDailyRowsWritten?: number;
  };
  r2: {
    storageGB: number;
    classAOperations: number;
    classBOperations: number;
  };
  gallery?: {
    pageViews: number;
    imagesPerView?: number;
    otherWorkerRequestsPerView?: number;
    signingRequestsPerView?: number;
    /** Fraction of image requests served from local browser cache, from 0 to 1. */
    imageCacheHitRate?: number;
  };
}

export interface PlanEstimate {
  worker: number;
  d1: number;
  r2: number;
  total: number;
  freeWorkerStatus: "eligible" | "over daily limit" | "unverified";
  freeD1Status: "eligible" | "over daily limit" | "unverified";
}

const RATE = {
  workerPaidBase: 5,
  workerRequestsIncluded: 10_000_000,
  workerRequestPerMillion: 0.3,
  workerCpuIncludedMs: 30_000_000,
  workerCpuPerMillionMs: 0.02,
  d1ReadIncludedRows: 25_000_000_000,
  d1ReadPerMillionRows: 0.001,
  d1WriteIncludedRows: 50_000_000,
  d1WritePerMillionRows: 1,
  d1StorageIncludedGB: 5,
  d1StoragePerGBMonth: 0.75,
  r2StorageFreeGBMonth: 10,
  r2ClassAFree: 1_000_000,
  r2ClassBFree: 10_000_000,
  r2StoragePerGBMonth: 0.015,
  r2ClassAPerMillion: 4.5,
  r2ClassBPerMillion: 0.36,
} as const;

function finiteNonnegative(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a finite, non-negative number.`);
  }
  return value;
}

function validateUsage(value: unknown): asserts value is UsageInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Usage input must be a JSON object.");
  const input = value as Record<string, unknown>;
  finiteNonnegative(input.periodDays, "periodDays");
  if ((input.periodDays as number) <= 0)
    throw new Error("periodDays must be greater than zero.");
  for (const section of ["worker", "d1", "r2"] as const) {
    if (!input[section] || typeof input[section] !== "object" || Array.isArray(input[section]))
      throw new Error(`${section} must be an object.`);
  }
  const worker = input.worker as Record<string, unknown>;
  const d1 = input.d1 as Record<string, unknown>;
  const r2 = input.r2 as Record<string, unknown>;
  for (const key of ["requests", "cpuMilliseconds"])
    finiteNonnegative(worker[key], `worker.${key}`);
  for (const key of ["maxDailyRequests", "maxCpuMillisecondsPerInvocation"])
    if (worker[key] !== undefined) finiteNonnegative(worker[key], `worker.${key}`);
  for (const key of ["rowsRead", "rowsWritten", "storageGB"])
    finiteNonnegative(d1[key], `d1.${key}`);
  for (const key of ["maxDailyRowsRead", "maxDailyRowsWritten"])
    if (d1[key] !== undefined) finiteNonnegative(d1[key], `d1.${key}`);
  for (const key of ["storageGB", "classAOperations", "classBOperations"])
    finiteNonnegative(r2[key], `r2.${key}`);
  if (input.gallery !== undefined) {
    if (!input.gallery || typeof input.gallery !== "object" || Array.isArray(input.gallery))
      throw new Error("gallery must be an object.");
    const gallery = input.gallery as Record<string, unknown>;
    finiteNonnegative(gallery.pageViews, "gallery.pageViews");
    for (const key of ["imagesPerView", "otherWorkerRequestsPerView", "signingRequestsPerView"])
      if (gallery[key] !== undefined) finiteNonnegative(gallery[key], `gallery.${key}`);
    if (gallery.imageCacheHitRate !== undefined) {
      const hitRate = finiteNonnegative(gallery.imageCacheHitRate, "gallery.imageCacheHitRate");
      if (hitRate > 1) throw new Error("gallery.imageCacheHitRate must be between 0 and 1.");
    }
  }
}

const paidDollars = (amount: number) => Math.round((amount + Number.EPSILON) * 100) / 100;
const r2BillableUnits = (usage: number, included: number) =>
  Math.max(0, Math.ceil(usage / 1_000_000) - Math.ceil(included / 1_000_000));

export function estimateCosts(input: UsageInput): { free: PlanEstimate; paid: PlanEstimate } {
  validateUsage(input);
  const r2 = paidDollars(
    Math.max(0, Math.ceil(input.r2.storageGB) - RATE.r2StorageFreeGBMonth) * RATE.r2StoragePerGBMonth +
      r2BillableUnits(input.r2.classAOperations, RATE.r2ClassAFree) * RATE.r2ClassAPerMillion +
      r2BillableUnits(input.r2.classBOperations, RATE.r2ClassBFree) * RATE.r2ClassBPerMillion,
  );
  const freeWorkerStatus =
    input.worker.maxDailyRequests === undefined ||
    input.worker.maxCpuMillisecondsPerInvocation === undefined
      ? "unverified"
      : input.worker.maxDailyRequests > 100_000 || input.worker.maxCpuMillisecondsPerInvocation > 10
        ? "over daily limit"
        : "eligible";
  const freeD1Status =
    input.d1.maxDailyRowsRead === undefined || input.d1.maxDailyRowsWritten === undefined
      ? "unverified"
      : input.d1.maxDailyRowsRead > 5_000_000 || input.d1.maxDailyRowsWritten > 100_000
        ? "over daily limit"
        : "eligible";

  // Free plan usage over a daily cap fails instead of converting into overages.
  const free: PlanEstimate = { worker: 0, d1: 0, r2, total: r2, freeWorkerStatus, freeD1Status };
  const paidWorker = RATE.workerPaidBase +
    Math.max(0, input.worker.requests - RATE.workerRequestsIncluded) / 1_000_000 * RATE.workerRequestPerMillion +
    Math.max(0, input.worker.cpuMilliseconds - RATE.workerCpuIncludedMs) / 1_000_000 * RATE.workerCpuPerMillionMs;
  const paidD1 =
    Math.max(0, input.d1.rowsRead - RATE.d1ReadIncludedRows) / 1_000_000 * RATE.d1ReadPerMillionRows +
    Math.max(0, input.d1.rowsWritten - RATE.d1WriteIncludedRows) / 1_000_000 * RATE.d1WritePerMillionRows +
    Math.max(0, input.d1.storageGB - RATE.d1StorageIncludedGB) * RATE.d1StoragePerGBMonth;
  const paid: PlanEstimate = {
    worker: paidDollars(paidWorker),
    d1: paidDollars(paidD1),
    r2,
    total: paidDollars(paidWorker + paidD1 + r2),
    freeWorkerStatus,
    freeD1Status,
  };
  return { free, paid };
}

export function estimateGallery(input: NonNullable<UsageInput["gallery"]>) {
  finiteNonnegative(input.pageViews, "gallery.pageViews");
  const images = finiteNonnegative(input.imagesPerView ?? 48, "gallery.imagesPerView");
  const otherRequests = finiteNonnegative(
    input.otherWorkerRequestsPerView ?? 2,
    "gallery.otherWorkerRequestsPerView",
  );
  const signingRequests = finiteNonnegative(
    input.signingRequestsPerView ?? 0,
    "gallery.signingRequestsPerView",
  );
  const hitRate = finiteNonnegative(input.imageCacheHitRate ?? 0, "gallery.imageCacheHitRate");
  if (hitRate > 1) throw new Error("gallery.imageCacheHitRate must be between 0 and 1.");
  const cachedImages = Math.floor(images * hitRate);
  const oldWorkerRequests = input.pageViews * (otherRequests + images);
  const signedWorkerRequests = input.pageViews * (otherRequests + signingRequests);
  const currentR2Gets = input.pageViews * images;
  const signedR2Gets = input.pageViews * (images - cachedImages);
  const r2ReadCost = (gets: number) =>
    r2BillableUnits(gets, RATE.r2ClassBFree) * RATE.r2ClassBPerMillion;
  const paidWorkerCost = (requests: number) =>
    RATE.workerPaidBase + Math.max(0, requests - RATE.workerRequestsIncluded) / 1_000_000 * RATE.workerRequestPerMillion;
  return {
    pageViews: input.pageViews,
    oldWorkerRequests,
    signedWorkerRequests,
    currentR2Gets,
    signedR2Gets,
    currentPaidWorkerRequestCost: paidDollars(paidWorkerCost(oldWorkerRequests)),
    signedPaidWorkerRequestCost: paidDollars(paidWorkerCost(signedWorkerRequests)),
    currentR2ReadCost: paidDollars(r2ReadCost(currentR2Gets)),
    signedR2ReadCost: paidDollars(r2ReadCost(signedR2Gets)),
    imageCacheHitRate: hitRate,
  };
}

function usd(value: number) {
  return `$${value.toFixed(2)}`;
}

export function renderReport(input: UsageInput): string {
  validateUsage(input);
  const estimates = estimateCosts(input);
  const lines = [
    "Cloudflare usage estimate (USD)",
    `Source: ${input.source ?? "user-supplied usage export; not a live Cloudflare read"}`,
    `Period: ${input.periodDays} days`,
    "",
    "Plan               Workers             D1                  R2                  Total",
    `Free               ${usd(estimates.free.worker).padEnd(19)} ${usd(estimates.free.d1).padEnd(19)} ${usd(estimates.free.r2).padEnd(19)} ${usd(estimates.free.total)}`,
    `Paid               ${usd(estimates.paid.worker).padEnd(19)} ${usd(estimates.paid.d1).padEnd(19)} ${usd(estimates.paid.r2).padEnd(19)} ${usd(estimates.paid.total)}`,
    `Free Workers checks: ${estimates.free.freeWorkerStatus}; Free D1 checks: ${estimates.free.freeD1Status}. Missing daily peaks or per-invocation CPU means “unverified.”`,
    "",
    "Free-plan overages hit limits and can stop requests/queries; they do not become the paid-plan bill. R2 overages remain billable.",
    "Totals assume this input represents all usage across the account. R2 units round up; account sharing, tax and products outside Workers/D1/R2 are not included.",
  ];
  if (input.gallery) {
    const gallery = estimateGallery(input.gallery);
    lines.push(
      "",
      `Gallery scenario: ${gallery.pageViews} page views, ${input.gallery.imagesPerView ?? 48} images/view, ${Math.round(gallery.imageCacheHitRate * 100)}% browser cache hits.`,
      `Worker requests: current ${gallery.oldWorkerRequests.toLocaleString()} (${usd(gallery.currentPaidWorkerRequestCost)} Paid request subtotal) → signed ${gallery.signedWorkerRequests.toLocaleString()} (${usd(gallery.signedPaidWorkerRequestCost)}).`,
      `R2 image GETs: current ${gallery.currentR2Gets.toLocaleString()} (${usd(gallery.currentR2ReadCost)} beyond free reads) → signed ${gallery.signedR2Gets.toLocaleString()} (${usd(gallery.signedR2ReadCost)}).`,
      "This scenario excludes Workers CPU, D1 rows, signing CPU, uploads, and other API traffic. A gallery view uses the supplied assumptions, not measured analytics.",
    );
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: bun scripts/usage-report.ts <usage.json>");
    process.exitCode = 2;
  } else {
    try {
      const input = JSON.parse(await Bun.file(path).text()) as unknown;
      validateUsage(input);
      console.log(renderReport(input));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Invalid usage input.");
      process.exitCode = 1;
    }
  }
}
