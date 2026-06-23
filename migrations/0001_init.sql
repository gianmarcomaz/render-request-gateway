CREATE TABLE IF NOT EXISTS renders (
  render_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  preset TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_renders_workspace_created_at
  ON renders (workspace_id, created_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  render_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
  ON idempotency_keys (expires_at);
