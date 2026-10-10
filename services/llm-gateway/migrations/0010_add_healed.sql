-- Migration 0010: Add healed column to usage_log
-- Tracks whether a structured output response was repaired by the gateway healing pipeline.

ALTER TABLE usage_log ADD COLUMN healed INTEGER NOT NULL DEFAULT 0;
