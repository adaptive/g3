export type Role = "guest" | "admin";
export type Visibility = "private" | "public";
export interface EventSettings {
  title: string;
  date: string;
  description: string;
  visibility: Visibility;
  coverPhotoId: string | null;
}
export interface GallerySummary extends EventSettings {
  id: string;
  slug: string;
  createdAt: string;
  photoCount: number;
  hasPassword: boolean;
  status?: "active" | "deleting";
}
export interface Photo {
  id: string;
  filename: string;
  contentType: string;
  bytes: number;
  width: number;
  height: number;
  createdAt: string;
}
export interface GalleryResponse {
  event: EventSettings;
  photos: Photo[];
  nextCursor: string | null;
  total: number;
  role: Role | null;
  /** Present only when this installation has direct R2 signing configured. */
  media?: MediaManifest;
}
export interface MediaGrant {
  photoId: string;
  variant: Variant;
  url: string;
  /** Absolute Unix time in milliseconds, including the server's access lease. */
  expiresAt: number;
  version: string;
}
export interface MediaManifest {
  /** Changes when the gallery access policy, password or current role changes. */
  scope: string;
  expiresAt: number;
  items: MediaGrant[];
}
export const MEDIA_LEASE_MS = 10 * 60 * 1000;
export interface SessionResponse {
  role: Role | null;
  canView: boolean;
}
export type Variant = "original" | "thumbnail" | "preview";
export interface UploadInput {
  filename: string;
  contentType: string;
  bytes: number;
  width: number;
  height: number;
}
export interface UploadRecord extends UploadInput {
  id: string;
  status: "pending" | "deleting";
  createdAt: string;
  variants: Variant[];
}
export interface AdminUploadsResponse {
  uploads: UploadRecord[];
  nextCursor: string | null;
  total: number;
}
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_PIXELS = 60_000_000;
/** Map legacy-shaped API paths to one gallery; the slug is captured by its page. */
export const galleryApiPath = (slug: string, path: string) => {
  const base = `/api/galleries/${encodeURIComponent(slug)}`;
  return path.replace(/^\/api\/gallery(?=\?|$)/, base).replace(
    /^\/api\/(?!galleries\/)/,
    `${base}/`,
  );
};
export const mediaUrl = (id: string, variant: Variant = "thumbnail", slug?: string) => {
  const path = `/api/photos/${encodeURIComponent(id)}/${variant}`;
  return slug ? galleryApiPath(slug, path) : path;
};
