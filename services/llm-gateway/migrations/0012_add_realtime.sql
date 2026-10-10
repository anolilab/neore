-- Add columns for realtime (WebSocket) sessions
ALTER TABLE usage_log ADD COLUMN session_type TEXT NOT NULL DEFAULT 'text';
ALTER TABLE usage_log ADD COLUMN duration_ms INTEGER;
