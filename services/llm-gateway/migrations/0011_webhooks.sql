-- Migration 0011: Webhook event delivery
-- Stores user-registered HTTP endpoints that receive signed gateway event payloads.

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,         -- HMAC signing key (user-provided or auto-generated)
  events TEXT NOT NULL,         -- JSON array: ['completion', 'budget_exceeded', 'guardrail_triggered', 'provider_error']
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_delivery_at INTEGER,
  last_delivery_status INTEGER  -- HTTP status code of last delivery attempt
);

CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(user_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_user_active ON webhooks(user_id, is_active);
