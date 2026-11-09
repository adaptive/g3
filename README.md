# Adaptive Gallery

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fadaptive%2Fadaptive-gallery)
[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub-EA4AAA?logo=githubsponsors)](https://github.com/sponsors/adaptive)

A reusable photo gallery manager built with SolidJS, TypeScript, Vite and Cloudflare Workers. Bun manages dependencies and runs the local development scripts; the deployed API runs on Cloudflare Workers. One installation can host several event galleries, each with its own public or password-protected access, while keeping full-resolution originals in a private R2 bucket. One administrator password manages all galleries.

The deployment provisions D1 and R2 from `wrangler.jsonc`. Keep the bucket private. Photo access uses the authenticated Worker by default; optional direct R2 delivery issues ten-minute read links after checking gallery access. Set a strong administrator password (at least 12 characters) when deploying. Each private gallery has its own password, managed in the admin dashboard. A clean installation starts with no galleries; sign in at `/admin` to create the first one.

## Local development

Requirements: Bun 1.4.4. Bun manages dependencies and runs development, builds, tests, database initialization and deployment; Node.js is not required. `bunfig.toml` routes package executables through Bun. The project has no direct Miniflare dependency or dependency patches; Wrangler includes Miniflare internally. Local API requests and Worker tests use workerd through Wrangler's service-binding interface. Cloudflare executes the deployed Worker in its Workers runtime.

```sh
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and set `ADMIN_PASSWORD` to a strong password of at least 12 characters. Then initialize an empty local D1 database and run Vite with the local Worker runtime:

```sh
bun run db:init:local
bun run dev
```

Open the local address printed by Vite. `.dev.vars` is ignored by Git. Never commit passwords or replace them with production values in a checked-in file.

## Deploy to your Cloudflare account

Use **Deploy to Cloudflare** above from a public clone. Cloudflare provisions one D1 database and one private R2 bucket. Set a strong `ADMIN_PASSWORD` of at least 12 characters. Confirm the build command is `bun run build` and the deploy command is `bun run deploy`; the default `npx wrangler deploy` skips database initialization. The deployment command ensures D1 exists, initializes an empty database from `schema.sql` using the `DB` binding, then deploys the Worker.

`ADMIN_PASSWORD` is the only secret needed for the initial deployment. The `PHOTOS` binding provides R2 access without S3 API credentials. Cloudflare discovers setup secrets from [`.dev.vars.example`](.dev.vars.example), so optional R2 signing values are documented below rather than listed there. If the setup form still asks for `R2_*` values, start a new deployment from the updated repository revision. See Cloudflare's [template secret configuration](https://developers.cloudflare.com/changelog/post/2025-07-01-workers-deploy-button-supports-environment-variables-and-secrets/).

The template deliberately omits `database_id`. Wrangler can provision or find the database by `database_name`; do not insert an all-zero placeholder ID. These behaviors follow Cloudflare's [automatic resource provisioning](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/) and [deploy button guidance](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

`schema.sql` contains the complete schema for a clean installation. Initialization accepts an empty database or one already initialized with this schema version. It refuses an existing unmarked or unsupported schema without changing it. Configure a fresh D1 database for a clean installation; there is no upgrade or data migration step.

For a manual setup, install dependencies, create an empty D1 database and a private R2 bucket, update their IDs and names in `wrangler.jsonc`, set the Worker administrator secret using `bun run cf secret put ADMIN_PASSWORD`, then run:

```sh
bun run deploy:manual
```

`deploy:manual` builds the frontend, ensures D1 exists, initializes an empty remote database and deploys the Worker. `bun run deploy` performs the database and deployment steps without first building, for a build service that runs the configured build command separately. When `database_id` is omitted, the setup script uses Wrangler to look for `database_name` and creates it only if missing. A configured ID is preserved; lookup or initialization errors stop the deployment before publishing. Later deployments recognize the initialized schema and leave its data intact. In Cloudflare Workers Builds, `bun.lock` selects Bun and the `packageManager` field pins version 1.4.4, following the [build image version rules](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/). Use `bun run build` as the build command and `bun run deploy` as the deploy command. To enforce a frozen install explicitly, set the build variable `SKIP_DEPENDENCY_INSTALL=1` and use `bun install --frozen-lockfile && bun run build` as the build command. Set secrets before the first deploy. `bun run deploy:dry-run` checks the generated Worker bundle without deploying or running remote database setup.

Keep `PHOTOS` private and do not enable an `r2.dev` public URL or custom domain for it. A single installation can contain several galleries. Use a fresh D1 database and private R2 bucket for each independently operated installation.

## Optional lower-cost media delivery

Configure all four Worker secrets `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` to enable direct signed R2 GETs. The token must have read-only access to the same private bucket as `PHOTOS`. Leave all four unset to retain Worker media delivery; partial configuration returns a setup error. Never expose the signing secret to browsers. Preview and original links are generated on demand; thumbnail links arrive with the authorized gallery response.

After the initial deployment, add them under the Worker's **Settings → Variables and Secrets**, or use the interactive commands below. For local development, add the same four names and their values to the ignored `.dev.vars` file.

```sh
bun run cf secret put R2_ACCOUNT_ID
bun run cf secret put R2_BUCKET_NAME
bun run cf secret put R2_ACCESS_KEY_ID
bun run cf secret put R2_SECRET_ACCESS_KEY
```

Direct links remain valid for up to ten minutes after sign-out, a password reset, a visibility change or deletion of a gallery record. Removing the R2 object also removes future direct access, but downloaded copies cannot be recalled. Use the proxy configuration when immediate authorization of every future media request is required. The browser's service worker can retain thumbnail/preview bytes for seven days, capped at 100 MiB, and only serves them while the tab holds a current, unexpired grant for the same access scope and content version. Originals and API responses are excluded. Sign-out and local policy changes clear relevant caches; browser storage is best-effort and may be evicted.

Signed grants stay in memory. If the browser restarts the service worker, it asks the active page to replay its existing, unexpired grants; the first image can still use the network while later requests reuse the cache. Returning to a visible page also replays grants. This does not extend their authorization deadline. Expired grants are pruned as manifests arrive.

Before enabling direct reads, configure exact-origin GET/HEAD CORS on the bucket. This command previews the policy; `--apply` explicitly replaces the bucket's CORS rules after review:

```sh
bun run cf:r2-cors --origin https://gallery.example.com
```

The asset CSP permits Cloudflare's R2 S3 API hosts; operators can narrow its `img-src` and `connect-src` entries to their account host. Existing objects and signed response-header overrides need live R2 qualification, including original download filenames. See [cost optimization](docs/cost-optimization.md) for setup, usage collection, browser diagnostics and acceptance checks.

The clean schema maintains gallery photo counts transactionally and tracks upload activity. A daily cleanup at 03:17 UTC removes at most 25 uploads inactive for 24 hours, with bounded R2 listing and retryable deletion. Gallery deletion hides the gallery immediately and removes its objects in bounded batches, with automatic retries hourly. Its administrator card remains visible until removal finishes; **Retry deletion** advances another batch. Administrators can also invoke `POST /api/admin/maintenance` from the same origin.

## Gallery basics

- Supported still photo formats: JPEG, PNG, WebP, HEIC and HEIF. A cancellable browser Web Worker prepares 2560-pixel JPEG previews and 640-pixel thumbnails. New thumbnails use native AVIF when its encoder is available, otherwise WebP, then JPEG. Encoder support is probed once per queue and checked against the actual output MIME type: unsupported canvas encoders can silently return PNG. There is no added WASM encoder dependency. Existing JPEG thumbnails keep working; this does not convert stored photos. See [canvas encoding support](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas/convertToBlob).
- Unsupported worker/canvas environments use the window fallback with the same format selection. An unavailable worker is released and remembered for the queue, avoiding a failed worker attempt for every photo. Temporary canvases and decoded bitmaps are released after processing. The CSP-safe HEIC decoder loads only for HEIC/HEIF. Original uploads are retained byte for byte.
- Uploads use one decoder and one network upload at a time. The next photo can be prepared while the current one uploads, with at most one prepared photo waiting. The gallery refreshes when the batch settles. The initial limits are 50 MiB and 60 megapixels per photo.
- Unfinished uploads are saved with their original files in IndexedDB when browser storage and Web Locks are available. After reopening the same gallery and signing in as administrator, choose **Resume saved uploads** or **Discard saved uploads**. Recovery waits for this action, rechecks already-published photos and restarts interrupted photo transfers using the same upload identity. Saved files expire after seven days, with a combined limit of 100 photos or 200 MiB across galleries on this origin. Completed/discarded files and all saved uploads on sign-out are cleared. Storage failures leave ordinary uploads available with a warning to keep the tab open; browser eviction can still remove recovery data.
- The photo viewer uses the browser's native modal dialog for keyboard focus containment and background inertness. Escape, arrow navigation, backdrop closing and focus restoration into the virtualized photo grid are supported. On mobile, photographs fill the available width with overlaid navigation, horizontal swipe, pinch zoom and bounded panning. The zoom button and double click also toggle zoom; arrow keys pan while zoomed. Photo links use `?photo=<id>`; refresh restores the selected photo, Back closes the viewer, and Forward restores it. Shared links find later photos through the authorized paginated listing, with retry/cancel feedback. Navigation continues across photo pages, prepares one adjacent preview and keeps the displayed image visible while the next preview decodes. Failed previews can be retried. Photo pagination remains usable if its boundary photograph is deleted between requests.
- Open the home page to browse public galleries. Private galleries stay out of the public list and can be opened by their `/g/<slug>` link after entering their password.
- Administrators sign in at **Admin sign in** or `/admin`. The dashboard creates, edits, shares and deletes galleries. New galleries are private by default; an administrator can choose public access or set a unique password for each private gallery.
- Admins can switch into a gallery to upload, retry and remove photos; choose the cover; edit the title, date and description; and change visibility. Changing a private gallery's password invalidates its previous guest sessions.
- The administrator's unfinished-upload list shows its total count and loads additional pages of 100 records, including pending photo removals. Its gallery-scoped cursor remains usable if a boundary record is removed between requests.
- API responses and original downloads use `Cache-Control: no-store`. Proxy thumbnails and previews use `private, no-cache` with content validators: the browser may retain bytes, but every reuse requires a successful access check before the Worker returns `304 Not Modified`. Switching to private blocks future proxy requests immediately. Optional direct links and service-worker image cache access follow the ten-minute grant policy described above; previously downloaded copies cannot be recalled.
- Public gallery pages provide gallery-specific titles, descriptions, canonical URLs and cover images to social preview crawlers. Private, missing and deleting galleries retain generic metadata without a cover, even when the page request includes an administrator cookie. The signed-in browser can display its authorized gallery name in the tab title. Both ICO and SVG favicons are included.
- Sessions expire and use secure, HttpOnly cookies. Guest sessions are scoped to one gallery; the administrator session can manage all galleries. Changing `ADMIN_PASSWORD` invalidates administrator sessions and guest sessions issued for gallery passwords. Mutating requests must come from the gallery's own origin.

There are no individual user accounts, guest uploads, ZIP downloads, RAW images, video or Live Photo playback. Cloudflare charges may apply for Workers, D1 and R2 usage.

## License and HEIC notices

Adaptive Gallery source is provided under the MIT License. The HEIC conversion dependency, `heic-to`, and the `libheif` and `libde265` libraries used by its upstream build are LGPL-3.0. The deployed app's versioned notices, unminified replaceable CSP bundle and package sources are published at `/third-party/heic-to-1.6.7/`. The exact upstream `libheif` 1.23.7 and `libde265` 1.0.16 source release archives, license texts, build recipe and SHA-256 checksums are published at `/third-party/vendor/`. After Vite builds the client, the build copies the `heic-to` distribution files from the pinned dependency directly into `dist/client/third-party/heic-to-1.6.7/`; it stops if that package's version or license changes. Generated files stay under `dist/`, and required licenses and sources remain included in the deployed assets. Rebuild with `bun run build` after `bun install --frozen-lockfile`. See the vendor build notes before changing this dependency, its build options or any bundled components.

## Release checks

```sh
bun run typecheck
bun run test
bun run build
bun run deploy:dry-run
```

Vite builds the frontend into `dist/client/`; Wrangler bundles the Worker from `worker/index.ts` during deployment. Local development uses a Vite middleware bridge to the Worker. Keep `dist/` ignored; only `dist/client/` is served as static assets. The [asset exclusion file](public/.assetsignore) keeps hidden metadata, credentials, source maps, logs and test output out of Cloudflare uploads, following Cloudflare's [asset exclusion rules](https://developers.cloudflare.com/workers/static-assets/binding/#ignoring-assets). Required third-party sources and licenses are intentionally public. Run `bun run clean` to remove build output and any generated HEIC files left by older builds; local database state and credentials are preserved.

Run `bun run check:toolchain` to verify the project with Bun and system utilities on `PATH` and no Node executable available. CI uses this same Node-free check, including frozen install, tests against disposable clean databases, build, deploy dry run and a Vite/Worker dev-server smoke check. It does not initialize or modify the normal local database.

Before a live release, qualify the deployed administrator and guest sessions, public/private access changes, upload/resume/delete flows and original downloads. Test Safari, Firefox, physical mobile devices and real HEIC/HEIF captures as well as Chromium. Optional direct delivery also needs live R2 CORS, signed-header and filename checks. Local checks and a deployment dry run do not verify those external services or device behaviors.
