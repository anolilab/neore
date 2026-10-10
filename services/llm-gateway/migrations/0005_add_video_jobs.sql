-- Migration: add video_jobs table for async video generation job tracking
-- Video generation takes 30s-5min; jobs are submitted immediately and polled for completion.

CREATE TABLE IF NOT EXISTS video_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    org_id TEXT,
    api_key_id TEXT,
    model_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model_api_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    aspect_ratio TEXT,
    resolution TEXT,
    duration_seconds REAL,
    fps INTEGER,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | succeeded | failed
    video_url TEXT,
    error_message TEXT,
    cost_microdollars INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    completed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_video_jobs_user_id ON video_jobs (user_id);
CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs (status);
CREATE INDEX IF NOT EXISTS idx_video_jobs_created_at ON video_jobs (created_at);
