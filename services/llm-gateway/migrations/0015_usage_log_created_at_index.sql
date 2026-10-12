-- The raw-log purge filters on `created_at` alone. The existing indexes all lead
-- with user_id/org_id/model_id/api_key_id, so the purge scanned the whole table
-- on every batch. An index on `created_at` lets it read only the expired range.
CREATE INDEX IF NOT EXISTS idx_usage_log_created_at ON usage_log (created_at);
