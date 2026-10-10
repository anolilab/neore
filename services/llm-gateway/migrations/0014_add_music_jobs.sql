-- Migration: add music_jobs table for async music generation tracking.
-- Music generation takes 10-30s; jobs are submitted via POST /v1/music and
-- polled via GET /v1/music/:jobId. Schema mirrors video_jobs (0013) for
-- operational symmetry between the two render queues.

CREATE TABLE music_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    org_id TEXT,
    api_key_id TEXT,
    -- Canonical model id, e.g. "fal/stable-audio-25"
    model_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    -- FAL endpoint slug (used as URL path), e.g. "fal-ai/stable-audio-25/text-to-audio"
    model_api_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    negative_prompt TEXT,
    duration_seconds REAL,
    seed INTEGER,
    callback_url TEXT,
    -- Status: pending | in_progress | completed | failed
    status TEXT NOT NULL DEFAULT 'pending',
    -- R2 object key for the rendered audio bytes (NULL until status=completed)
    r2_key TEXT,
    mime_type TEXT,
    sample_rate INTEGER,
    error_message TEXT,
    cost_microdollars INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    started_at DATETIME,
    completed_at DATETIME
);

CREATE INDEX idx_music_jobs_user_id ON music_jobs (user_id);
CREATE INDEX idx_music_jobs_status ON music_jobs (status);
CREATE INDEX idx_music_jobs_created_at ON music_jobs (created_at);
