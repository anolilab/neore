-- Virtual API keys table for SaaS-grade key lifecycle management.
-- Keys are stored by SHA-256 hash only; the raw key is shown once at creation time.
CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,
  key_hash    TEXT NOT NULL UNIQUE,          -- SHA-256 of the raw gk_* key
  prefix      TEXT NOT NULL,                -- First 12 chars of key for display
  user_id     TEXT NOT NULL,
  org_id      TEXT,
  name        TEXT NOT NULL DEFAULT 'Default',
  tier        TEXT NOT NULL DEFAULT 'free', -- free | pro | enterprise
  max_budget_usd REAL,                      -- NULL = unlimited spend
  spent_usd   REAL NOT NULL DEFAULT 0,
  rpm_limit   INTEGER NOT NULL DEFAULT 60,
  tpm_limit   INTEGER NOT NULL DEFAULT 100000,
  expires_at  TEXT,                         -- ISO8601 datetime or NULL = never expires
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE INDEX idx_api_keys_user ON api_keys(user_id, is_active);
