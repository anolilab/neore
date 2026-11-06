# LLM GATEWAY KNOWLEDGE BASE

## INVARIANTS

- **LLM Gateway** (`services/llm-gateway/`) proxies **all** LLM and embedding
  calls for token counting, cost tracking and smart routing. D1 for usage,
  separate KV namespaces for rate limits and pricing. `/v1/*` is the public
  surface the browser posts to; `/internal/*` (and the backend-only `/v1/usage`,
  `/v1/cache`, `/v1/events`…) are served ONLY to the backend's service binding —
  see "Services (service bindings)" in `backend/AGENTS.md`. The backend plugs in via `gateway-language-model.ts` /
  `gateway-embedding-model.ts`, which implement `LanguageModelV3` /
  `EmbeddingModelV3` and serialise call options over the binding's `fetch` — so
  every LLM call routes through the gateway with no change to tool execution,
  persistence or the agent loop. `LLM_GATEWAY_SIGNING_SECRET` is now only the
  gateway -> backend direction (chunk polling, usage reports, key validation,
  stream tokens). Billing: 1 credit = 1,000 microdollars, via
  `deductCreditsFromGateway`.

- **Video render queue** — `POST /v1/videos` enqueues and returns 202; the
  Worker's `queue()` handler consumes it. **Cross-config invariant:**
  `VIDEO_RENDER_MAX_ATTEMPTS = 3` in the consumer MUST equal `maxRetries: 2`
  (+ initial delivery) on the `Queues.Consumer` `settings` in `alchemy.run.ts` — a mismatch
  silently drops messages on the final attempt, before the DLQ. Provider keys go
  in `CACHE_KV` under `video_render_secret:{jobId}` (TTL 2h) so the queue payload
  never carries secrets. `markRenderFailed` is idempotent and is called from both
  the render core (non-retryable) and the consumer (retries exhausted, because
  the core leaves the row `in_progress` between attempts).

- **FAL media** — music has no AI SDK V3 primitive, so the gateway calls FAL's
  queue API directly (`providers/music-factory.ts`). Response shapes vary per
  model, so the shape-guessing is isolated and unit-tested on both sides:
  `extractAudioPart` (gateway) and `backend/lunora/chat/lib/fal-media-parsing.ts`
  (`extractFalAudioUrl`, `resolveFalVideoUrl`). Video content-type resolution
  deliberately ignores `output.content_type` and falls back to `video/mp4`.
