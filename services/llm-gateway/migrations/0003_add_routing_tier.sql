-- Add routing_tier column to usage_log for smart routing observability.
-- Populated when the /internal/generate or /internal/stream endpoint receives
-- a routing_tier value (passed from the backend after calling /internal/route).
-- Nullable so existing rows remain valid.
ALTER TABLE usage_log ADD COLUMN routing_tier TEXT;
