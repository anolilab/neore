-- Add cache_hit column to usage_log for tracking prompt-level cache savings.
-- cache_hit = 1 means the response was served from CACHE_KV (no LLM token spend).
ALTER TABLE usage_log ADD COLUMN cache_hit INTEGER NOT NULL DEFAULT 0;

-- Index for cache analytics: how many requests hit the cache per user/model
CREATE INDEX IF NOT EXISTS idx_usage_log_cache_hit ON usage_log (user_id, model_id, cache_hit, created_at);
