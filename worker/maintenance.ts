interface StatementLike {
  bind(...values: unknown[]): StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{
    results: T[];
    success: boolean;
    meta?: { changes?: number };
  }>;
  run(): Promise<{
    success: boolean;
    meta?: { changes?: number };
  }>;
}

interface DatabaseLike {
  prepare(query: string): StatementLike;
  batch(statements: StatementLike[]): Promise<Array<{
    success: boolean;
    meta?: { changes?: number };
  }>>;
}

interface PhotosLike {
  list(options: {
    prefix: string;
    cursor?: string;
    limit: number;
  }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
}

export interface MaintenanceEnv {
  DB: DatabaseLike;
  PHOTOS: PhotosLike;
}

export interface CleanupOptions {
  /** Default: the current time. Exposed to make age boundaries reproducible. */
  now?: number;
  /** Default: 24 hours. */
  olderThanMs?: number;
  /** Number of uploads per invocation, clamped to 1–25. Default: 25. */
  limit?: number;
  /** Prefix-listed and D1-recorded objects per upload, clamped to 1–25 each. */
  objectPageSize?: number;
  /** Process one specific deleting gallery when invoked by its retry action. */
  galleryId?: string;
}

export interface CleanupResult {
  scanned: number;
  markedForDeletion: number;
  objectsDeleted: number;
  uploadsDeleted: number;
  uploadsRemaining: number;
  failures: string[];
}

export interface GalleryCleanupResult {
  galleriesScanned: number;
  photosDeleted: number;
  uploadsDeleted: number;
  galleriesDeleted: number;
  pendingGalleries: number;
  failures: string[];
}

const DEFAULT_UPLOADS_PER_RUN = 25;
const MAX_UPLOADS_PER_RUN = 25;
const MAX_OBJECTS_PER_UPLOAD_PER_RUN = 25;
const DEFAULT_PENDING_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Advances gallery deletion in small, repeatable batches. The request marks
 * the gallery deleting; this worker claims child rows before removing them and
 * processes a bounded number of photos and upload prefixes per invocation.
 */
export async function cleanupDeletingGalleries(
  env: MaintenanceEnv,
  options: CleanupOptions = {},
): Promise<GalleryCleanupResult> {
  const now = options.now ?? Date.now();
  const cutoff = new Date(now - Math.max(0, options.olderThanMs ?? DEFAULT_PENDING_AGE_MS)).toISOString();
  const limit = clamp(options.limit ?? 1, 1, 5);
  const objectPageSize = clamp(options.objectPageSize ?? 25, 1, 25);
  const result: GalleryCleanupResult = {
    galleriesScanned: 0,
    photosDeleted: 0,
    uploadsDeleted: 0,
    galleriesDeleted: 0,
    pendingGalleries: 0,
    failures: [],
  };
  const galleryQuery = options.galleryId
    ? env.DB.prepare("SELECT g.id FROM galleries g WHERE g.status = 'deleting' AND g.id = ? ORDER BY g.created_at, g.id LIMIT ?").bind(options.galleryId, limit)
    : env.DB.prepare(
      `SELECT g.id FROM galleries g WHERE g.status = 'deleting'
       ORDER BY EXISTS (
         SELECT 1 FROM uploads u JOIN upload_attempts a ON a.upload_id = u.id
         WHERE u.gallery_id = g.id AND a.status = 'pending' AND a.created_at > ?
       ), g.created_at, g.id LIMIT ?`,
    ).bind(cutoff, limit);
  const galleries = await galleryQuery.all<{ id: string }>();
  result.galleriesScanned = galleries.results.length;

  for (const { id: galleryId } of galleries.results) {
    try {
      const photos = await env.DB.prepare(
        "SELECT id, original_key, thumbnail_key, preview_key FROM photos WHERE gallery_id = ? AND status IN ('published', 'deleting') ORDER BY created_at, id LIMIT ?",
      ).bind(galleryId, 100).all<{ id: string; original_key: string; thumbnail_key: string; preview_key: string }>();
      for (const photo of photos.results) {
        await env.DB.prepare(
          "UPDATE photos SET status = 'deleting' WHERE id = ? AND gallery_id = ? AND status = 'published'",
        ).bind(photo.id, galleryId).run();
        await env.PHOTOS.delete([photo.original_key, photo.thumbnail_key, photo.preview_key]);
        const removed = await env.DB.prepare(
          "DELETE FROM photos WHERE id = ? AND gallery_id = ? AND status = 'deleting'",
        ).bind(photo.id, galleryId).run();
        result.photosDeleted += removed.meta?.changes ?? 0;
      }

      const uploads = await env.DB.prepare(
        "SELECT u.id FROM uploads u WHERE u.gallery_id = ? AND NOT EXISTS (SELECT 1 FROM upload_attempts a WHERE a.upload_id = u.id AND a.status = 'pending' AND a.created_at > ?) ORDER BY u.created_at, u.id LIMIT ?",
      ).bind(galleryId, cutoff, 5).all<{ id: string }>();
      for (const { id: uploadId } of uploads.results) {
        await env.DB.prepare(
          "UPDATE uploads SET status = 'deleting' WHERE id = ? AND gallery_id = ? AND status <> 'deleting'",
        ).bind(uploadId, galleryId).run();
        await env.DB.prepare(
          "UPDATE upload_attempts SET status = 'failed' WHERE upload_id = ? AND status = 'pending' AND created_at <= ?",
        ).bind(uploadId, cutoff).run();
        const pending = await env.DB.prepare(
          "SELECT 1 AS active FROM upload_attempts WHERE upload_id = ? AND status = 'pending' LIMIT 1",
        ).bind(uploadId).first<{ active: number }>();
        if (pending) continue;

        const references = await env.DB.prepare(
          `SELECT object_key FROM (
             SELECT object_key FROM upload_parts WHERE upload_id = ?
             UNION SELECT object_key FROM upload_attempts WHERE upload_id = ? AND status <> 'pending'
           ) ORDER BY object_key LIMIT ?`,
        ).bind(uploadId, uploadId, objectPageSize).all<{ object_key: string }>();
        const page = await env.PHOTOS.list({ prefix: `uploads/${uploadId}/`, limit: objectPageSize });
        const referenceKeys = references.results.map((item) => item.object_key);
        const keys = [...new Set([...referenceKeys, ...page.objects.map((item) => item.key)])];
        if (keys.length) await env.PHOTOS.delete(keys);
        if (referenceKeys.length) {
          const placeholders = referenceKeys.map(() => "?").join(", ");
          await env.DB.batch([
            env.DB.prepare(`DELETE FROM upload_parts WHERE upload_id = ? AND object_key IN (${placeholders})`).bind(uploadId, ...referenceKeys),
            env.DB.prepare(`DELETE FROM upload_attempts WHERE upload_id = ? AND status <> 'pending' AND object_key IN (${placeholders})`).bind(uploadId, ...referenceKeys),
          ]);
        }
        const remainingReferences = await env.DB.prepare(
          "SELECT (SELECT COUNT(*) FROM upload_parts WHERE upload_id = ?) + (SELECT COUNT(*) FROM upload_attempts WHERE upload_id = ?) AS total",
        ).bind(uploadId, uploadId).first<{ total: number }>();
        if (page.truncated || (remainingReferences?.total ?? 0) > 0) continue;

        const removed = await env.DB.prepare(
          "DELETE FROM uploads WHERE id = ? AND gallery_id = ? AND status = 'deleting' AND NOT EXISTS (SELECT 1 FROM upload_attempts WHERE upload_id = ? AND status = 'pending')",
        ).bind(uploadId, galleryId, uploadId).run();
        result.uploadsDeleted += removed.meta?.changes ?? 0;
      }

      const remaining = await env.DB.prepare(
        "SELECT (SELECT COUNT(*) FROM photos WHERE gallery_id = ?) + (SELECT COUNT(*) FROM uploads WHERE gallery_id = ?) AS total",
      ).bind(galleryId, galleryId).first<{ total: number }>();
      if ((remaining?.total ?? 0) === 0) {
        const removed = await env.DB.prepare(
          "DELETE FROM galleries WHERE id = ? AND status = 'deleting' AND NOT EXISTS (SELECT 1 FROM photos WHERE gallery_id = ?) AND NOT EXISTS (SELECT 1 FROM uploads WHERE gallery_id = ?)",
        ).bind(galleryId, galleryId, galleryId).run();
        result.galleriesDeleted += removed.meta?.changes ?? 0;
      }
    } catch {
      result.failures.push(galleryId);
    }
  }
  const pending = await env.DB.prepare("SELECT COUNT(*) AS total FROM galleries WHERE status = 'deleting'").first<{ total: number }>();
  result.pendingGalleries = Number(pending?.total ?? 0);
  return result;
}

/**
 * Removes old, unfinished uploads without scanning the bucket globally.
 * Each upload is marked deleting before touching R2 so interrupted cleanup is
 * resumable. At most one R2 listing page and 25 D1 object references are
 * processed per upload per run. The 25-upload limit is below the current
 * Free-plan 1,000 Cloudflare-service subrequest limit even if each D1 query is
 * counted individually.
 */
export async function cleanupAbandonedUploads(
  env: MaintenanceEnv,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const now = options.now ?? Date.now();
  const olderThanMs = Math.max(0, options.olderThanMs ?? DEFAULT_PENDING_AGE_MS);
  const limit = clamp(options.limit ?? DEFAULT_UPLOADS_PER_RUN, 1, MAX_UPLOADS_PER_RUN);
  const objectPageSize = clamp(
    options.objectPageSize ?? MAX_OBJECTS_PER_UPLOAD_PER_RUN,
    1,
    MAX_OBJECTS_PER_UPLOAD_PER_RUN,
  );
  const cutoff = new Date(now - olderThanMs).toISOString();
  const stale = await env.DB.prepare(
    `SELECT id FROM uploads
     WHERE status = 'deleting' OR (status = 'pending' AND updated_at <= ?)
     ORDER BY CASE WHEN status = 'deleting' THEN 0 ELSE 1 END, updated_at, id
     LIMIT ?`,
  )
    .bind(cutoff, limit)
    .all<{ id: string }>();

  const result: CleanupResult = {
    scanned: stale.results.length,
    markedForDeletion: 0,
    objectsDeleted: 0,
    uploadsDeleted: 0,
    uploadsRemaining: 0,
    failures: [],
  };

  for (const { id } of stale.results) {
    try {
      const marked = await env.DB.prepare(
        `UPDATE uploads
         SET status = 'deleting'
         WHERE id = ? AND status = 'pending' AND updated_at <= ?`,
      )
        .bind(id, cutoff)
        .run();
      result.markedForDeletion += marked.meta?.changes ?? 0;

      // Another maintenance invocation may already have removed the row.
      const exists = await env.DB.prepare(
        "SELECT id FROM uploads WHERE id = ? AND status = 'deleting'",
      )
        .bind(id)
        .first<{ id: string }>();
      if (!exists) continue;

      // A request which has not finished after the full stale-upload window is
      // no longer an active upload. If it later completes, the normal PUT path
      // observes the deleting parent and removes its exact R2 object key.
      await env.DB.prepare(
        `UPDATE upload_attempts
         SET status = 'failed'
         WHERE upload_id = ? AND status = 'pending' AND created_at <= ?`,
      )
        .bind(id, cutoff)
        .run();

      const objects = await env.DB.prepare(
        `SELECT object_key FROM (
           SELECT object_key FROM upload_parts WHERE upload_id = ?
           UNION SELECT object_key FROM upload_attempts
             WHERE upload_id = ? AND status <> 'pending'
         ) ORDER BY object_key LIMIT ?`,
      )
        .bind(id, id, objectPageSize)
        .all<{ object_key: string }>();
      const keys = new Set(objects.results.map((object) => object.object_key));

      const pendingAttempt = await env.DB.prepare(
        "SELECT object_key FROM upload_attempts WHERE upload_id = ? AND status = 'pending' LIMIT 1",
      )
        .bind(id)
        .first<{ object_key: string }>();
      const pendingKey = pendingAttempt?.object_key;

      // Upload keys share this unique, server-generated prefix. Listing it is
      // necessary because an interrupted request can put an object before its
      // D1 attempt is finalized.
      const page = await env.PHOTOS.list({
        prefix: `uploads/${id}/`,
        limit: objectPageSize,
      });
      for (const object of page.objects) {
        if (object.key !== pendingKey) keys.add(object.key);
      }

      const allKeys = [...keys];
      if (allKeys.length) {
        await env.PHOTOS.delete(allKeys);
        result.objectsDeleted += allKeys.length;
      }

      // Delete only references whose R2 delete succeeded. Sorting and limiting
      // advances through arbitrarily many old attempt rows over later passes.
      const referencedKeys = objects.results.map((object) => object.object_key);
      if (referencedKeys.length) {
        const placeholders = referencedKeys.map(() => "?").join(", ");
        await env.DB.batch([
          env.DB.prepare(
            `DELETE FROM upload_parts WHERE upload_id = ? AND object_key IN (${placeholders})`,
          ).bind(id, ...referencedKeys),
          env.DB.prepare(
            `DELETE FROM upload_attempts
             WHERE upload_id = ? AND status <> 'pending' AND object_key IN (${placeholders})`,
          ).bind(id, ...referencedKeys),
        ]);
      }

      // Keep the row while references, pending writes, or more R2 list pages
      // remain. A later invocation starts at the first remaining object.
      const remainingState = await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM upload_parts WHERE upload_id = ?) +
           (SELECT COUNT(*) FROM upload_attempts WHERE upload_id = ?) AS references_left,
           (SELECT COUNT(*) FROM upload_attempts
             WHERE upload_id = ? AND status = 'pending') AS active_attempts`,
      )
        .bind(id, id, id)
        .first<{ references_left: number; active_attempts: number }>();
      if (
        (remainingState?.references_left ?? 0) > 0 ||
        (remainingState?.active_attempts ?? 0) > 0 ||
        page.truncated
      ) continue;

      const removed = await env.DB.prepare(
        `DELETE FROM uploads
         WHERE id = ? AND status = 'deleting'
           AND NOT EXISTS (
             SELECT 1 FROM upload_attempts
             WHERE upload_id = uploads.id AND status = 'pending'
           )`,
      )
        .bind(id)
        .run();
      result.uploadsDeleted += removed.meta?.changes ?? 0;
    } catch {
      // Keep the deleting row and all D1 object references for retry. Do not
      // expose upload keys or error details in a public API response.
      result.failures.push(id);
    }
  }

  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM uploads
     WHERE status = 'deleting' OR (status = 'pending' AND updated_at <= ?)`,
  )
    .bind(cutoff)
    .first<{ total: number }>();
  result.uploadsRemaining = Number(remaining?.total ?? 0);
  return result;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
