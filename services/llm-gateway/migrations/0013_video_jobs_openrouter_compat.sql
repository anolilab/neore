-- Migration: rewrite video_jobs to match OpenRouter video API contract.
-- The service is alpha — no production data — so the table is dropped and recreated
-- with the new shape. New columns: r2_key (R2 object key replacing inline data URL),
-- size (WIDTHxHEIGHT), seed, generate_audio, callback_url. Status enum is widened to
-- include 'in_progress' and renamed 'succeeded' → 'completed' to match OpenRouter.

DROP TABLE IF EXISTS video_jobs;

CREATE TABLE video_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    org_id TEXT,
    api_key_id TEXT,
    -- Canonical model id, e.g. "fal/luma-ray-2"
    model_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    -- Provider-internal model id (the part after the "/" we hand to the SDK)
    model_api_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    -- OpenRouter-aligned request fields
    aspect_ratio TEXT,
    resolution TEXT,
    size TEXT,
    duration_seconds REAL,
    seed INTEGER,
    generate_audio INTEGER NOT NULL DEFAULT 1, -- bool 0/1
    callback_url TEXT,
    -- Status: pending | in_progress | completed | failed
    status TEXT NOT NULL DEFAULT 'pending',
    -- R2 object key for the rendered video bytes (NULL until status=completed)
    r2_key TEXT,
    mime_type TEXT,
    error_message TEXT,
    cost_microdollars INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    completed_at DATETIME
);

CREATE INDEX idx_video_jobs_user_id ON video_jobs (user_id);
CREATE INDEX idx_video_jobs_status ON video_jobs (status);
CREATE INDEX idx_video_jobs_created_at ON video_jobs (created_at);
