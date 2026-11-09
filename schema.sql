PRAGMA foreign_keys = ON;

CREATE TABLE gallery_schema (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1)
);

CREATE TABLE galleries (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT 'A day worth remembering',
  event_date TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  cover_photo_id TEXT,
  password_salt TEXT,
  password_hash TEXT,
  password_version INTEGER NOT NULL DEFAULT 1,
  photo_count INTEGER NOT NULL DEFAULT 0 CHECK (photo_count >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleting')),
  created_at TEXT NOT NULL
);

CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'deleting')),
  original_key TEXT NOT NULL,
  thumbnail_key TEXT NOT NULL,
  preview_key TEXT NOT NULL
);
CREATE INDEX photos_gallery_page ON photos (gallery_id, status, created_at DESC, id DESC);
CREATE INDEX photos_page ON photos (status, created_at DESC, id DESC);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'deleting'))
);
CREATE INDEX uploads_gallery_created ON uploads (gallery_id, created_at DESC);
CREATE INDEX uploads_pending_stale ON uploads (status, updated_at, id);

CREATE TABLE upload_parts (
  upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  variant TEXT NOT NULL CHECK (variant IN ('original', 'thumbnail', 'preview')),
  object_key TEXT NOT NULL UNIQUE,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  PRIMARY KEY (upload_id, variant)
);

CREATE TABLE upload_attempts (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  variant TEXT NOT NULL CHECK (variant IN ('original', 'thumbnail', 'preview')),
  object_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  created_at TEXT NOT NULL
);
CREATE INDEX upload_attempts_by_upload ON upload_attempts (upload_id, variant, created_at);

CREATE TABLE login_attempts (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0)
);

CREATE TRIGGER photos_count_after_insert
AFTER INSERT ON photos
WHEN NEW.status = 'published'
BEGIN
  UPDATE galleries SET photo_count = photo_count + 1 WHERE id = NEW.gallery_id;
END;

CREATE TRIGGER photos_count_after_delete
AFTER DELETE ON photos
WHEN OLD.status = 'published'
BEGIN
  UPDATE galleries SET photo_count = MAX(0, photo_count - 1) WHERE id = OLD.gallery_id;
END;

CREATE TRIGGER photos_count_after_update
AFTER UPDATE OF status, gallery_id ON photos
BEGIN
  UPDATE galleries
  SET photo_count = MAX(0, photo_count - 1)
  WHERE id = OLD.gallery_id AND OLD.status = 'published';
  UPDATE galleries
  SET photo_count = photo_count + 1
  WHERE id = NEW.gallery_id AND NEW.status = 'published';
END;

CREATE TRIGGER uploads_activity_insert
AFTER INSERT ON uploads
BEGIN
  UPDATE uploads SET updated_at = NEW.created_at WHERE id = NEW.id;
END;

CREATE TRIGGER upload_parts_activity_insert
AFTER INSERT ON upload_parts
BEGIN
  UPDATE uploads
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.upload_id;
END;

CREATE TRIGGER upload_parts_activity_update
AFTER UPDATE ON upload_parts
BEGIN
  UPDATE uploads
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.upload_id;
  UPDATE uploads
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = OLD.upload_id AND OLD.upload_id <> NEW.upload_id;
END;

CREATE TRIGGER upload_parts_activity_delete
AFTER DELETE ON upload_parts
BEGIN
  UPDATE uploads
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = OLD.upload_id;
END;

CREATE TRIGGER upload_attempts_activity_insert
AFTER INSERT ON upload_attempts
BEGIN
  UPDATE uploads
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.upload_id;
END;

CREATE TRIGGER upload_attempts_activity_update
AFTER UPDATE ON upload_attempts
BEGIN
  UPDATE uploads
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.upload_id;
  UPDATE uploads
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = OLD.upload_id AND OLD.upload_id <> NEW.upload_id;
END;

CREATE TRIGGER upload_attempts_activity_delete
AFTER DELETE ON upload_attempts
BEGIN
  UPDATE uploads
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = OLD.upload_id;
END;

INSERT INTO gallery_schema (id, schema_version) VALUES (1, 1);
