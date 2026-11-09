/** Read-only collector for Cloudflare GraphQL Analytics. */
const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const LIMIT = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;
const CLASS_A = new Set([
  "CopyObject", "CreateMultipartUpload", "CompleteMultipartUpload", "ListBuckets",
  "ListObjects", "ListMultipartUploads", "ListParts", "PutBucket", "PutBucketCors",
  "PutBucketEncryption", "PutBucketLifecycleConfiguration", "PutObject", "UploadPart",
  "UploadPartCopy", "LifecycleStorageTierTransition",
]);
const CLASS_B = new Set([
  "GetObject", "HeadBucket", "HeadObject", "UsageSummary", "GetBucketEncryption",
  "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration",
]);

type GraphqlResponse = {
  data?: unknown;
  errors?: { message?: string }[] | null;
};
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CollectorOptions {
  accountId: string;
  apiToken: string;
  now?: Date;
  fetchImpl?: FetchLike;
}

function validAccountId(value: string) {
  return /^[a-f0-9]{32}$/i.test(value);
}

function utcDayWindow(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error("The collector clock is invalid.");
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = today.toISOString();
  const startDate = new Date(today.getTime() - 86_400_000);
  const start = startDate.toISOString();
  return { start, end, d1Date: start.slice(0, 10) };
}

export function buildUsageQuery(accountId: string, window: ReturnType<typeof utcDayWindow>) {
  if (!validAccountId(accountId)) throw new Error("CF_ACCOUNT_ID must be 32 hexadecimal characters.");
  // Values pass strict date validation and the account ID is strictly hexadecimal.
  const account = accountId.toLowerCase();
  const start = JSON.stringify(window.start);
  const end = JSON.stringify(window.end);
  const day = JSON.stringify(window.d1Date);
  return `query AdaptiveGalleryUsage {
    viewer {
      accounts(filter: { accountTag: "${account}" }) {
        workersInvocationsAdaptive(limit: ${LIMIT}, filter: { datetime_geq: ${start}, datetime_leq: ${end} }) {
          sum { requests errors }
          quantiles { cpuTimeP50 cpuTimeP99 }
          dimensions { datetime scriptName }
        }
        d1AnalyticsAdaptiveGroups(limit: ${LIMIT}, filter: { date_geq: ${day}, date_leq: ${day} }) {
          sum { rowsRead rowsWritten }
          dimensions { databaseId date }
        }
        d1StorageAdaptiveGroups(limit: ${LIMIT}, filter: { date_geq: ${day}, date_leq: ${day} }) {
          max { databaseSizeBytes }
          dimensions { databaseId date }
        }
        r2OperationsAdaptiveGroups(limit: ${LIMIT}, filter: { datetime_geq: ${start}, datetime_leq: ${end} }) {
          sum { requests }
          dimensions { actionType bucketName }
        }
        r2StorageAdaptiveGroups(limit: ${LIMIT}, filter: { datetime_geq: ${start}, datetime_leq: ${end} }, orderBy: [datetime_DESC]) {
          max { objectCount payloadSize metadataSize }
          dimensions { bucketName datetime }
        }
      }
    }
  }`;
}

async function requestUsage(query: string, token: string, fetchImpl: FetchLike): Promise<GraphqlResponse> {
  let response: Response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
      throw new Error(`Cloudflare Analytics API request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    throw error;
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new Error(`Cloudflare Analytics API returned HTTP ${response.status}; check the token's Account Analytics Read permission and account access.`);
    throw new Error(`Cloudflare Analytics API returned HTTP ${response.status}.`);
  }
  const result = await response.json() as GraphqlResponse;
  if (result.errors?.length) {
    const details = result.errors.map((item) => item.message ?? "unspecified GraphQL error").join("; ");
    throw new Error(`Cloudflare GraphQL analytics query failed: ${details}`);
  }
  if (!result.data || typeof result.data !== "object")
    throw new Error("Cloudflare GraphQL response did not include data.");
  return result;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Cloudflare GraphQL response is missing ${path}.`);
  return value as Record<string, unknown>;
}

function groups(value: unknown, path: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`Cloudflare GraphQL response is missing ${path} groups.`);
  return value.map((item, index) => object(item, `${path}[${index}]`));
}

function requiredNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`Cloudflare GraphQL response is missing a usable ${path} metric.`);
  return value;
}

function aggregateUsage(raw: GraphqlResponse, accountId: string, range: ReturnType<typeof utcDayWindow>) {
  const root = object(raw.data, "data");
  const viewer = object(root.viewer, "viewer");
  const accounts = groups(viewer.accounts, "accounts");
  const account = accounts.find((item) => {
    const candidate = item.accountTag;
    return typeof candidate === "string" && candidate.toLowerCase() === accountId.toLowerCase();
  }) ?? accounts[0];
  if (!account) throw new Error("Cloudflare GraphQL returned no account data for CF_ACCOUNT_ID.");

  const workerRows = groups(account.workersInvocationsAdaptive, "workersInvocationsAdaptive");
  const d1Rows = groups(account.d1AnalyticsAdaptiveGroups, "d1AnalyticsAdaptiveGroups");
  const d1StorageRows = groups(account.d1StorageAdaptiveGroups, "d1StorageAdaptiveGroups");
  const r2Rows = groups(account.r2OperationsAdaptiveGroups, "r2OperationsAdaptiveGroups");
  const r2StorageRows = groups(account.r2StorageAdaptiveGroups, "r2StorageAdaptiveGroups");

  let workerRequests = 0;
  let workerErrors = 0;
  const cpuQuantiles: { datetime: string | null; scriptName: string | null; cpuTimeP50: number | null; cpuTimeP99: number | null }[] = [];
  for (const [i, row] of workerRows.entries()) {
    const sum = object(row.sum, `workersInvocationsAdaptive[${i}].sum`);
    const quantiles = object(row.quantiles, `workersInvocationsAdaptive[${i}].quantiles`);
    const dimensions = object(row.dimensions, `workersInvocationsAdaptive[${i}].dimensions`);
    workerRequests += requiredNumber(sum.requests, "Worker requests");
    workerErrors += requiredNumber(sum.errors, "Worker errors");
    const p50 = quantiles.cpuTimeP50;
    const p99 = quantiles.cpuTimeP99;
    cpuQuantiles.push({
      datetime: typeof dimensions.datetime === "string" ? dimensions.datetime : null,
      scriptName: typeof dimensions.scriptName === "string" ? dimensions.scriptName : null,
      cpuTimeP50: p50 === null || p50 === undefined ? null : requiredNumber(p50, "Worker CPU p50"),
      cpuTimeP99: p99 === null || p99 === undefined ? null : requiredNumber(p99, "Worker CPU p99"),
    });
  }

  let d1RowsRead = 0;
  let d1RowsWritten = 0;
  const d1ByDatabase = new Map<string, { rowsRead: number; rowsWritten: number }>();
  for (const [i, row] of d1Rows.entries()) {
    const sum = object(row.sum, `d1AnalyticsAdaptiveGroups[${i}].sum`);
    const dimensions = object(row.dimensions, `d1AnalyticsAdaptiveGroups[${i}].dimensions`);
    if (typeof dimensions.databaseId !== "string")
      throw new Error(`Cloudflare GraphQL response is missing d1AnalyticsAdaptiveGroups[${i}].databaseId.`);
    const rowsRead = requiredNumber(sum.rowsRead, "D1 rows read");
    const rowsWritten = requiredNumber(sum.rowsWritten, "D1 rows written");
    const perDb = d1ByDatabase.get(dimensions.databaseId) ?? { rowsRead: 0, rowsWritten: 0 };
    perDb.rowsRead += rowsRead;
    perDb.rowsWritten += rowsWritten;
    d1ByDatabase.set(dimensions.databaseId, perDb);
    d1RowsRead += rowsRead;
    d1RowsWritten += rowsWritten;
  }

  const d1Storage = new Map<string, number>();
  for (const [i, row] of d1StorageRows.entries()) {
    const max = object(row.max, `d1StorageAdaptiveGroups[${i}].max`);
    const dimensions = object(row.dimensions, `d1StorageAdaptiveGroups[${i}].dimensions`);
    if (typeof dimensions.databaseId !== "string")
      throw new Error(`Cloudflare GraphQL response is missing d1StorageAdaptiveGroups[${i}].databaseId.`);
    d1Storage.set(dimensions.databaseId, requiredNumber(max.databaseSizeBytes, "D1 database storage"));
  }

  const operationMap: Record<string, number> = {};
  let classAOperations = 0;
  let classBOperations = 0;
  const unknownActions: string[] = [];
  for (const [i, row] of r2Rows.entries()) {
    const sum = object(row.sum, `r2OperationsAdaptiveGroups[${i}].sum`);
    const dimensions = object(row.dimensions, `r2OperationsAdaptiveGroups[${i}].dimensions`);
    if (typeof dimensions.actionType !== "string")
      throw new Error(`Cloudflare GraphQL response is missing r2OperationsAdaptiveGroups[${i}].actionType.`);
    const actionType = dimensions.actionType;
    const requests = requiredNumber(sum.requests, "R2 requests");
    operationMap[actionType] = (operationMap[actionType] ?? 0) + requests;
    if (CLASS_A.has(actionType)) classAOperations += requests;
    else if (CLASS_B.has(actionType)) classBOperations += requests;
    else unknownActions.push(actionType);
  }

  const r2Storage = new Map<string, { datetime: string; objectCount: number; payloadBytes: number; metadataBytes: number }>();
  for (const [i, row] of r2StorageRows.entries()) {
    const max = object(row.max, `r2StorageAdaptiveGroups[${i}].max`);
    const dimensions = object(row.dimensions, `r2StorageAdaptiveGroups[${i}].dimensions`);
    if (typeof dimensions.bucketName !== "string" || typeof dimensions.datetime !== "string")
      throw new Error(`Cloudflare GraphQL response is missing R2 storage bucket/time dimensions at row ${i}.`);
    const bucketName = dimensions.bucketName;
    const existing = r2Storage.get(bucketName);
    if (!existing || dimensions.datetime > existing.datetime) {
      r2Storage.set(bucketName, {
        datetime: dimensions.datetime,
        objectCount: requiredNumber(max.objectCount, "R2 object count"),
        payloadBytes: requiredNumber(max.payloadSize, "R2 payload storage"),
        metadataBytes: requiredNumber(max.metadataSize, "R2 metadata storage"),
      });
    }
  }

  const completenessWarnings: string[] = [];
  for (const [name, rows] of [
    ["workersInvocationsAdaptive", workerRows],
    ["d1AnalyticsAdaptiveGroups", d1Rows],
    ["d1StorageAdaptiveGroups", d1StorageRows],
    ["r2OperationsAdaptiveGroups", r2Rows],
    ["r2StorageAdaptiveGroups", r2StorageRows],
  ] as const) {
    if (rows.length === LIMIT) completenessWarnings.push(`${name} returned ${LIMIT} groups; result may be truncated.`);
  }
  if (unknownActions.length)
    completenessWarnings.push(`Unknown R2 action type(s) excluded from Class A/B totals: ${[...new Set(unknownActions)].join(", ")}.`);
  if (workerRows.length && workerRows.some((row) => object(row.quantiles, "worker quantiles").cpuTimeP99 == null))
    completenessWarnings.push("Worker CPU p99 was unavailable for some groups; the 10 ms Free per-invocation limit remains unqualified.");
  if (workerRows.length && workerRows.some((row) => object(row.quantiles, "worker quantiles").cpuTimeP50 == null))
    completenessWarnings.push("Worker CPU p50 was unavailable for some groups.");

  return {
    schemaVersion: 1,
    collection: {
      kind: "observed account usage snapshot",
      accountId,
      requestedRangeStart: range.start,
      requestedRangeEnd: range.end,
      d1UtcDay: range.d1Date,
      collectedAt: new Date().toISOString(),
      queryRowLimit: LIMIT,
      completenessWarnings,
      billingEstimateEligible: false,
      note: "Observed metrics do not include the full billing-period history, peak daily requests for all products, or maximum per-invocation CPU. Worker cpuTimeP50/cpuTimeP99 retain the GraphQL field names because the referenced GraphQL documentation does not specify their units. Do not use this snapshot alone as a monthly bill or a Free-plan qualification.",
    },
    observed: {
      workers: {
        requests: workerRequests,
        errors: workerErrors,
        cpuTimeQuantilesByGroup: cpuQuantiles,
        peakHourlyCpuTimeP99Value: cpuQuantiles.reduce<number | null>((peak, row) =>
          row.cpuTimeP99 === null ? peak : Math.max(peak ?? 0, row.cpuTimeP99), null),
      },
      d1: {
        rowsRead: d1RowsRead,
        rowsWritten: d1RowsWritten,
        dailyByDatabase: Object.fromEntries(d1ByDatabase),
        storageBytesByDatabase: Object.fromEntries(d1Storage),
      },
      r2: {
        operationsByAction: operationMap,
        classAOperations,
        classBOperations,
        latestStorageByBucket: Object.fromEntries(r2Storage),
      },
    },
    raw: raw.data,
  };
}

export async function collectUsage(options: CollectorOptions) {
  if (!options.apiToken.trim()) throw new Error("CF_API_TOKEN is required.");
  if (!validAccountId(options.accountId)) throw new Error("CF_ACCOUNT_ID must be 32 hexadecimal characters.");
  const range = utcDayWindow(options.now ?? new Date());
  const query = buildUsageQuery(options.accountId, range);
  const raw = await requestUsage(query, options.apiToken, options.fetchImpl ?? fetch);
  return aggregateUsage(raw, options.accountId, range);
}

if (import.meta.main) {
  const token = process.env.CF_API_TOKEN;
  const accountId = process.env.CF_ACCOUNT_ID;
  if (!token || !accountId) {
    console.error("Set CF_API_TOKEN and CF_ACCOUNT_ID to collect read-only account usage.");
    console.error("The token needs Account Analytics Read. No values are printed or stored.");
    process.exitCode = 2;
  } else {
    try {
      const result = await collectUsage({ apiToken: token, accountId });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Usage collection failed.");
      process.exitCode = 1;
    }
  }
}
