-- Migration 0008: Add guardrail_violations column to usage_log
-- Stores JSON array of violation objects from the guardrail pipeline.

ALTER TABLE usage_log ADD COLUMN guardrail_violations TEXT;
