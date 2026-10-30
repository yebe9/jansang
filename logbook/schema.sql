CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  stored_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  impression TEXT,
  metadata TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  video_bytes INTEGER NOT NULL DEFAULT 0,
  video_type TEXT NOT NULL DEFAULT '',
  video_key TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'deleting'))
);
CREATE INDEX IF NOT EXISTS records_recent ON records(state, created_at DESC);
