-- One row per LLM API call
CREATE TABLE usage_log (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  org_id TEXT,
  thread_id TEXT,
  -- Model info
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_api_id TEXT NOT NULL,
  routed_model_id TEXT,
  routing_confidence REAL,
  -- Token counts (actual from provider)
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  -- Cost (microdollars: $1.00 = 1,000,000)
  cost_microdollars INTEGER NOT NULL DEFAULT 0,
  -- Performance
  latency_ms INTEGER NOT NULL DEFAULT 0,
  ttft_ms INTEGER,
  -- Metadata
  is_streaming BOOLEAN NOT NULL DEFAULT TRUE,
  finish_reason TEXT,
  error_code TEXT,
  source TEXT NOT NULL DEFAULT 'internal',
  api_key_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_usage_user_date ON usage_log(user_id, created_at);
CREATE INDEX idx_usage_org_date ON usage_log(org_id, created_at);
CREATE INDEX idx_usage_model ON usage_log(model_id, created_at);
CREATE INDEX idx_usage_api_key ON usage_log(api_key_id, created_at);

-- Materialized daily aggregates (populated by scheduled cron)
CREATE TABLE usage_daily (
  user_id TEXT NOT NULL,
  org_id TEXT,
  model_id TEXT NOT NULL,
  date TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_microdollars INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, model_id, date)
);

-- SaaS API key validation cache (short TTL, source of truth in the backend)
CREATE TABLE api_key_cache (
  key_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT,
  tier TEXT NOT NULL DEFAULT 'free',
  rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  uses_own_keys BOOLEAN NOT NULL DEFAULT FALSE,
  cached_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Provider health tracking
CREATE TABLE provider_health (
  provider TEXT NOT NULL,
  model_api_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'healthy',
  error_rate_5m REAL NOT NULL DEFAULT 0,
  avg_latency_5m_ms INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  last_failure_at TEXT,
  circuit_breaker_until TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, model_api_id)
);
CREATE INDEX idx_health_updated ON provider_health(updated_at);

-- Notification rules for cost/usage alerts
CREATE TABLE notification_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT,
  name TEXT NOT NULL,
  metric TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  period TEXT NOT NULL DEFAULT 'day',
  model_filter TEXT,
  action TEXT NOT NULL DEFAULT 'notify',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_triggered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_rules_user ON notification_rules(user_id, is_active);
