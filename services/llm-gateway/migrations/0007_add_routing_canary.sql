-- Migration 0007: Add routing_canary column to usage_log
-- Tracks whether a request was routed to a canary model for A/B evaluation analytics.
ALTER TABLE usage_log ADD COLUMN routing_canary INTEGER NOT NULL DEFAULT 0;
