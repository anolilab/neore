-- Fix usage_daily PK to include org_id.
-- Without org_id in the PK, INSERT OR REPLACE silently merges data
-- across different orgs for the same user+model+date.
CREATE TABLE usage_daily_new (
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL,
  date TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_microdollars INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, org_id, model_id, date)
);

INSERT INTO usage_daily_new (user_id, org_id, model_id, date, request_count, prompt_tokens, completion_tokens, total_cost_microdollars, avg_latency_ms, error_count)
SELECT user_id, COALESCE(org_id, ''), model_id, date, request_count, prompt_tokens, completion_tokens, total_cost_microdollars, avg_latency_ms, error_count
FROM usage_daily;

DROP TABLE usage_daily;
ALTER TABLE usage_daily_new RENAME TO usage_daily;
