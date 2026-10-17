-- Usage charges a render queue could not settle within its delivery attempts.
-- The */5 cron (`sweepPendingUsage`, src/usage/pending.ts) re-sends each one
-- until the backend accepts it, with exponential backoff, and drops it after
-- `PENDING_USAGE_MAX_ATTEMPTS`. `next_attempt_at` is epoch milliseconds.
CREATE TABLE IF NOT EXISTS usage_pending (
    request_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_pending_next_attempt_at ON usage_pending (next_attempt_at);
