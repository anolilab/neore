-- The provider prompt-cache readings (src/usage/provider-cache-readings.ts) read every chat row a
-- provider answered over a 1- to 30-day range. A partial index holding only those rows, with every
-- column the readings filter on or sum, lets both of their queries run from the index alone instead
-- of reading each row from the table. Its WHERE clause must stay the same as `answered()` there,
-- term for term, or SQLite stops using it.
CREATE INDEX IF NOT EXISTS idx_usage_log_provider_cache ON usage_log (
    created_at, provider, model_id, prompt_tokens, cached_tokens,
    completion_tokens, cache_hit, error_code, session_type, finish_reason
)
WHERE cache_hit = 0 AND error_code IS NULL AND prompt_tokens > 0 AND completion_tokens > 0
    AND session_type = 'text' AND finish_reason IS NOT 'cancelled';
