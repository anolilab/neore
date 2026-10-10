-- Migration 0009: Add fallback_reason column to usage_log
-- Tracks which fallback category was triggered: 'infra', 'content_policy', or 'context_overflow'.

ALTER TABLE usage_log ADD COLUMN fallback_reason TEXT;
