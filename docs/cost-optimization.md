# Cloudflare cost optimization

This guide covers Adaptive Gallery's Cloudflare Workers, D1 and private R2 implementation. Collect an account baseline before treating any estimate as a budget. Account allowances are shared with other services, so account-wide measurements matter.

## Read-only daily usage snapshot

The collector calls Cloudflare's read-only GraphQL Analytics endpoint for the previous complete UTC day. It requests Worker requests/errors and CPU p50/p99 by group, D1 row counts and storage by database, and R2 operations/storage by bucket. Cloudflare's [Workers for Platforms observability example](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/observability/) documents `workersInvocationsAdaptive` with `requests`, `errors`, `cpuTimeP50`/`cpuTimeP99`, and datetime/script dimensions are also shown in the [Preview metrics example](https://developers.cloudflare.com/workers/previews/test-and-debug/). The [D1 metrics guide](https://developers.cloudflare.com/d1/observability/metrics-analytics/) demonstrates `d1AnalyticsAdaptiveGroups` filtered by `date_geq`/`date_leq` and grouped on `databaseId` and `date`; it also documents the D1 storage dataset. The [R2 metrics guide](https://developers.cloudflare.com/r2/platform/metrics-analytics/) documents the operations and storage datasets, their time filters, and bucket dimensions. These are daily `date` fields for D1 and `datetime` fields for Worker/R2 data, matching the respective examples. It requires an API token with Account Analytics Read and access to the explicit account ID.

Set `CF_API_TOKEN` and `CF_ACCOUNT_ID` in your local shell or secret manager, then run:

```sh
bun scripts/collect-usage.ts > usage-snapshot.json
```

The tool makes a GraphQL POST that only contains a `query`; it never logs the token or sends a write request. It fails explicitly on authentication, API, GraphQL/schema, or missing-metric errors rather than interpreting them as zero. Output contains the raw GraphQL data plus normalized observed values and warnings. Keep that file private because it includes account usage metadata. Do not paste credentials into shell history or commit the snapshot.

This is an observed one-day snapshot, not a billing-period export. The cited GraphQL examples name the CPU quantiles but do not state the returned unit, so the collector preserves the field names and raw values without labeling them milliseconds. Worker CPU p50/p99 also do not establish the exact maximum execution time needed to qualify for the Free per-invocation CPU limit. The collector does not obtain full billing-period totals or all daily peaks, so its output is deliberately not accepted directly by the cost estimator. Review field coverage, completeness warnings, account aggregation and date range before using any value. Unsupported GraphQL fields are surfaced as errors; check the current official schema/dashboard and update the collector deliberately if Cloudflare changes it.

For browser cache evidence, open the gallery and run `window.__adaptiveGalleryMediaStats()` in that tab's developer console before and after a repeat-view exercise. It reports current-tab and controlling service-worker-session counters such as mode, grants, signed URL refreshes, cache hits/misses, bytes stored/served, quota errors and entries. Counters reset on reload and do not represent all visitors, R2 billing, or Cloudflare-wide analytics. The service worker cache is capped at 100 MiB, retains image bytes for up to seven days, and requires a current, unexpired grant on every cache read.

## Usage estimate

For a monthly estimate, export the corresponding full billing-period totals from the Cloudflare dashboard and write a file such as `usage.json`. A daily GraphQL snapshot above is useful for a sample but is not a substitute for billing history or observed maximums:

```json
{
  "periodDays": 30,
  "source": "Cloudflare dashboard, 2026-10-01 through 2026-10-31",
  "worker": {
    "requests": 0,
    "cpuMilliseconds": 0,
    "maxDailyRequests": 0,
    "maxCpuMillisecondsPerInvocation": 0
  },
  "d1": {
    "rowsRead": 0,
    "rowsWritten": 0,
    "storageGB": 0,
    "maxDailyRowsRead": 0,
    "maxDailyRowsWritten": 0
  },
  "r2": {
    "storageGB": 0,
    "classAOperations": 0,
    "classBOperations": 0
  },
  "gallery": {
    "pageViews": 0,
    "imagesPerView": 48,
    "otherWorkerRequestsPerView": 2,
    "signingRequestsPerView": 0,
    "imageCacheHitRate": 0
  }
}
```

Replace every zero with observed account totals. In Workers & Pages, use the Worker request and CPU metrics for the same date range; inspect CPU per invocation separately because an average does not qualify the Free-plan 10 ms invocation cap. In D1, inspect each database's Metrics → Row Metrics and use daily peaks as well as monthly totals. In R2, use storage and operation metrics for the full account and billing period. Keep unobserved fields absent rather than filling them with zero; absent daily peak metrics cause a Free-plan status of `unverified`.

Run the offline estimator:

```sh
bun scripts/usage-report.ts usage.json
```

The report estimates Workers Paid, Free Workers/D1 eligibility, and R2 charges. R2 Standard units round up to the next GB or million operations, then the account's included allowance is subtracted. Free Workers and D1 daily caps fail closed: exceeding a cap can make requests or queries fail; it does not turn that usage into a paid overage. The Paid estimate includes the Workers account subscription and assumes no products outside Workers, D1 and R2. It estimates account-billed totals only when the input covers all scripts, databases, buckets and usage sharing those allowances. Confirm output units and current rates against Cloudflare's [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/) and [R2](https://developers.cloudflare.com/r2/pricing/) pricing pages before a budget decision.

The optional gallery model assumes 48 image requests per page, two other Worker requests, the signed manifest included in the existing gallery response, no pagination, and a user-provided browser cache hit rate. It does not infer real page views or cache hits. Set `signingRequestsPerView` if URL renewals use a separate batch endpoint. Current and signed R2 GET counts stay equal until the browser image cache hit rate is observed. Browser diagnostic counters from `window.__adaptiveGalleryMediaStats()` apply to the current tab only; they are not Cloudflare billing or account-wide analytics.

Browser byte retention and access expiry are separate. A fresh grant can authorize reuse of identical bytes for up to seven days after storage. An expired grant never authorizes a cache hit. Expired retained entries are removed on access/maintenance or service-worker activation; an inactive browser cannot guarantee immediate physical deletion from its disk. The service worker keeps signed URLs only in memory and does not cache API/session responses or original downloads.

After a service-worker restart, the first R2 thumbnail/preview request may use the network while the worker asks its page to replay current, unexpired grants. Further requests can reuse cached bytes. Page visibility restoration also replays those grants; neither path renews the lease or calls the signing endpoint. Both the page and service worker prune expired grants on manifest updates. The `activeGrants` service-worker diagnostic reports its retained in-memory URL grants; it is not a count of cached image entries.

New thumbnails use a natively available AVIF encoder, then WebP, then JPEG. Capability probes run once per upload queue, and each result's MIME type is checked to reject the browser's implicit PNG fallback. Existing stored JPEGs are unchanged. R2 metadata carries the actual thumbnail MIME for both proxy and signed delivery; no schema migration is required. The service-worker cache identity already includes the immutable object key's version, so different encoded bytes cannot reuse the old object's cache entry.

Proxy thumbnails and previews also permit browser HTTP caching with `private, no-cache` and an ETag derived from the gallery policy, photo, variant key, R2 object ETag, size and MIME type. Every conditional request still checks gallery access, published ownership and object existence before returning `304 Not Modified`; the unused R2 response stream is cancelled. This reduces repeated image-body transfers while keeping immediate proxy authorization. It does not eliminate Worker, D1 or R2 read operations. APIs and original downloads remain `no-store`, and proxy responses remain outside the signed-grant service-worker cache.

Local verification on 2026-11-08: typecheck, all 160 tests, production build and Wrangler deployment dry run passed. Chromium loaded the production module worker, processed two images through the same worker, and decoded the resulting 640×480 WebP thumbnail and JPEG preview. A generated 1600×1200 gradient/grain fixture produced a 9,686-byte WebP thumbnail versus 16,938 bytes for its JPEG baseline at quality 0.78; this synthetic comparison is not a photo-quality study or a production savings measurement. Chromium's native AVIF request returned PNG, correctly selecting WebP instead. AVIF selection, HTML canvas fallback, MIME mismatches, grant restoration/pruning and logout races have automated coverage. Native AVIF encoding on a supporting browser, Safari/Firefox behavior and live R2 delivery remain unverified. No deployment or stored-image conversion was performed.

## Implementation and acceptance checks

1. Compare a full billing period and daily peaks before and after the changes. Record Worker requests, maximum CPU per invocation, D1 rows read/written, R2 GB-months and Class A/B operations. Include a same-gallery repeat-view sample and record browser cache hits, misses, bytes and quota errors.
2. Keep the PHOTOS bucket private. Supply the signing endpoint with a dedicated read-only R2 API token for that bucket. Configure Worker secrets `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`; never send the key or secret to a browser. Generated GET URLs have a ten-minute lifetime and expose one read operation for one object. Leave current media-proxy behavior available when signing credentials are not configured.
3. Verify batch GET signing for visible thumbnails and on-demand preview/original URLs: request method, active gallery, current role/password access, published photo ownership, variant and maximum batch length must be checked before signing. Signing URLs alone should not read objects from R2. Measure the signing CPU at realistic batches in a deployed test environment before relying on the Free plan.
4. Test expiry, URL tampering, wrong object/variant, private and public galleries, gallery switching, password rotation, visibility changes, deletion, sign-out, CORS, content disposition, and URL refresh. Previously issued URLs remain valid until their ten-minute expiry. Do not promise immediate revocation for direct R2 links or bytes already saved by a browser.
5. Cache only thumbnail/preview images actually requested by the visitor. Bytes have a seven-day retention deadline and a 100 MiB cap; every cache read independently requires the tab's current, unexpired ten-minute grant for the same gallery, photo, variant, content version and access scope. Fresh authorized grants can reuse retained bytes after an old URL expires. Handle quota eviction gracefully and clear relevant entries on sign-out or scope changes. Session, login, admin, upload and proxy API responses, and original downloads are excluded.
6. Validate output size and image quality after preview compression changes. Confirm originals remain byte-identical and the client-side worker fallback works in supported browsers. Background processing improves UI responsiveness; only smaller stored variants or prevented duplicate uploads reduce R2 storage.
7. Initialize an empty D1 database from the complete `schema.sql` using `bun run db:init:local` for local development or the clean-install deployment command. Verify photo counts start at zero and remain accurate through upload, publish, delete, restore, and gallery delete. Exercise scheduled and manual stale-upload cleanup with recent, stale, retried and interrupted uploads. Cleanup must be idempotent and must not remove a live upload or a published object.
8. Deploy to a staging Worker and private test bucket. Recheck actual dashboard metrics and service behavior; local `workerd` tests do not qualify deployed Free-plan CPU, daily quotas, browser cache eviction, or external R2 CORS.

## R2 browser CORS policy

Use [r2-cors.example.json](r2-cors.example.json) as a Wrangler-format starting point, replacing `https://gallery.example.com` with the exact gallery origin. `bun run cf:r2-cors --origin https://gallery.example.com` previews the exact-origin GET/HEAD policy without making a Cloudflare change. `--apply` explicitly invokes Wrangler and replaces existing bucket CORS rules, so merge any other needed rules first. Keep public bucket access disabled: CORS is not authorization. The asset CSP permits R2 API hosts in `img-src` and `connect-src`; operators may narrow these to their account host. Confirm direct original-download headers on a live test object before enabling signing for legacy objects.

## Current cost levers

- Static frontend assets already use Cloudflare Static Assets and avoid Worker invocations.
- Image decoding and 2560-pixel preview / 640-pixel thumbnail generation already run in the uploader's browser. A dedicated browser Web Worker can keep the page responsive; encoded-size reductions affect stored bytes, while R2 Internet egress is already free.
- Direct R2 signed URLs can remove per-image Worker and D1 reads. They do not reduce R2 GET operations or storage. A service worker cache can prevent repeat image GETs on the same device, but a first download still reads R2.
- Gallery listings and pages use a maintained `photo_count`; SQLite triggers keep it accurate across concurrent publication, status changes, moves and deletions without scanning all photos per view.
- Pending upload cleanup can recover abandoned R2 objects. Set a safe age threshold and bound each cleanup batch; upload cancellation and retries must continue to work.
- Upload completion refreshes the session, gallery and pending-upload list once when the queue settles, rather than once per photo. Preparation overlaps the current upload with a one-photo lookahead; decoding and network uploads each remain serial.
- Cold signed-image responses stream to the page while the service worker saves a copy in the background. Cache writes retain their grant checks and quota bounds.
- Photo pagination uses a composite timestamp/ID range on the existing gallery index. Large loaded photo grids render a moving window of cards; visitors can choose to show every loaded photograph for assistive technology or browser text search.
