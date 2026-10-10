# LLM Gateway

A Cloudflare Worker (Hono) that proxies LLM API calls with usage tracking, smart model routing, guardrails, and a full SaaS-compatible API surface.

## Overview

The LLM Gateway sits between the Lunora backend and upstream AI providers. Every LLM call — streaming, non-streaming, embeddings, images, audio, and realtime — flows through it. The gateway adds:

- **Actual token counting & cost tracking** — recorded in D1 and aggregated daily
- **Smart routing** — scores each query across 8 dimensions and selects the best model for the cost/quality tradeoff
- **Guardrails** — PII masking and prompt-injection blocking before sending to providers
- **Structured output healing** — validates JSON schema compliance and repairs malformed output
- **Idempotency** — deduplicates retried requests using KV
- **Provider health** — circuit-breaker pattern with automatic recovery
- **Webhook delivery** — push events to registered endpoints on completion, budget exceeded, guardrail triggers, and provider errors
- **BYOK** — users and orgs can supply their own provider API keys
- **SaaS API** — OpenAI-compatible `/v1/chat/completions`, `/v1/models`, `/v1/embeddings`, `/v1/images`, `/v1/audio`, `/v1/realtime`

## Architecture

```text
Lunora Backend (service binding SERVICE_LLM_GATEWAY → `InternalApi` entrypoint)
  └─(binding)─→ /internal/stream        Streaming agent execution
  └─(binding)─→ /internal/generate      Non-streaming tasks (titles, memory, etc.)
  └─(binding)─→ /internal/route         Smart model selection
  └─(binding)─→ /internal/model/proxy   LanguageModelV3 proxy (doGenerate/doStream)
  └─(binding)─→ /internal/webhooks      Webhook registration
  └─(binding)─→ /internal/keys          Virtual API key management

Client (Browser / Extension)
  └─(stream token)─→ /v1/stream      NDJSON chunk relay from persistentChunks
  └─(Bearer gk_*)──→ /v1/chat/completions
  └─(Bearer gk_*)──→ /v1/embeddings
  └─(Bearer gk_*)──→ /v1/images/generations
  └─(Bearer gk_*)──→ /v1/audio/speech | transcriptions
  └─(Bearer gk_*)──→ /v1/realtime    WebSocket proxy → OpenAI Realtime API
  └─(Bearer gk_*)──→ /v1/logs
  └─(Bearer gk_*)──→ /v1/rate-limits
  └─(Bearer gk_*)──→ /v1/cache

Upstream Providers
  OpenRouter · Groq · xAI · Google · OpenAI · Requesty · fal.ai
```

### Cloudflare Bindings

| Binding         | Type        | Purpose                                                           |
| --------------- | ----------- | ----------------------------------------------------------------- |
| `USAGE_DB`      | D1 Database | Usage logs, daily aggregates, provider health, webhooks, API keys |
| `RATE_LIMIT_KV` | KV          | Per-user rate limit counters (`rl:*`)                             |
| `PRICING_KV`    | KV          | Pricing cache from models.dev, routing decisions (`pricing:*`)    |
| `CACHE_KV`      | KV          | Prompt cache stats, idempotency keys (`cache:*`, `idem:*`)        |

### D1 Schema (migrations applied in order)

| File                                    | Change                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `0001_usage_tables.sql`                 | `usage_log`, `usage_daily`, `provider_health`, `notification_rules`                                          |
| `0002_fix_usage_daily_pk.sql`           | Fix primary key on `usage_daily`                                                                             |
| `0003_add_routing_tier.sql`             | `routing_tier` column on `usage_log`                                                                         |
| `0004_add_cache_hit.sql`                | `cache_hit` column on `usage_log`                                                                            |
| `0005_add_video_jobs.sql`               | `video_jobs` table                                                                                           |
| `0006_api_keys.sql`                     | `api_key_cache` table for virtual keys                                                                       |
| `0007_add_routing_canary.sql`           | `canary_weights` table                                                                                       |
| `0008_add_guardrail_violations.sql`     | `guardrail_violations` column on `usage_log`                                                                 |
| `0009_add_fallback_reason.sql`          | `fallback_reason` column on `usage_log`                                                                      |
| `0010_add_healed.sql`                   | `healed` column on `usage_log` (structured output repair)                                                    |
| `0011_webhooks.sql`                     | `webhooks` table                                                                                             |
| `0012_add_realtime.sql`                 | Realtime session tracking columns                                                                            |
| `0013_video_jobs_openrouter_compat.sql` | Rewrite `video_jobs` to OpenRouter contract (r2_key, size, generate_audio, callback_url, in_progress status) |
| `0014_add_music_jobs.sql`               | `music_jobs` table                                                                                           |

## Smart Routing

Model selection runs as four steps. Steps 1-2 produce a _verdict_ (which tier
this turn needs, and how sure we are); step 3 decides whether acting on that
verdict is a good idea; step 4 picks a model inside the chosen tier.

### 1. Score (`src/routing/scorer.ts`)

8 dimensions, <2ms, no network:

1. **Score** (`src/routing/scorer.ts`) — 8 dimensions, <2ms, no LLM calls:
    - `complexity` (0.25 weight) — message length, structure
    - `codeGeneration` (0.15) — code patterns, backtick blocks
    - `reasoning` (0.20) — math, step-by-step patterns
    - `creativity` (0.05) — creative writing signals
    - `contextLength` (0.10) — total token estimate vs 32k
    - `multimodal` (0.05) — image/file attachments
    - `toolUse` (0.10) — number of tools provided
    - `technicalDomain` (0.10) — API/infra terminology

2. **Classify** (`src/routing/tiers.ts`) — map combined score to tier:

    | Tier      | Score range | Default candidates                           |
    | --------- | ----------- | -------------------------------------------- |
    | Simple    | ≤ 0.25      | gemini-2.5-flash, gpt-4o-mini, llama-4-scout |
    | Standard  | ≤ 0.55      | gpt-4o, gemini-2.5-pro, claude-sonnet-4      |
    | Complex   | ≤ 0.80      | claude-sonnet-4, gpt-4.1, gemini-2.5-pro     |
    | Reasoning | ≤ 1.0       | claude-opus-4, o3, gemini-2.5-pro            |

    | Tier      | Score range |
    | --------- | ----------- |
    | Simple    | ≤ 0.25      |
    | Standard  | ≤ 0.55      |
    | Complex   | ≤ 0.80      |
    | Reasoning | ≤ 1.0       |

Tier model pools are recomputed from the catalogue by a cron
(`tier-assignment.ts`) and cached in KV; on a cold start they are derived from
the shipped catalogue rather than a hardcoded list.

### 2. Classify (`src/routing/classifier.ts`) — optional

Surface features cannot separate a one-line question that needs real reasoning
from a long but mechanical edit. When `ROUTING_CLASSIFIER_MODEL` is set, a
small cheap model grades the turn and returns a tier plus a confidence, and its
verdict supersedes the heuristic one.

This is strictly an accuracy upgrade. No configuration, no API key, a provider
error, malformed output, or a missed deadline all return `null` and the
heuristic score is used — routing never blocks a request. Only the last user
message is sent, and verdicts are cached by prompt shape for 5 minutes.

| Setting             | Value  |
| ------------------- | ------ |
| Per-attempt timeout | 1500ms |
| Total deadline      | 3000ms |
| Retries             | 1      |

### 3. Decide (`src/routing/policy.ts`)

The verdict is a claim about the turn; the policy decides what to do with it
given the thread's history.

| Rule                   | Behaviour                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt override        | A tier the user named in their own words (`use opus`, `think harder`) wins — subject to plan permissions. See `routing/override.ts`.                                 |
| Low confidence (< 0.6) | Never downgrades, and caps upgrades at the Standard tier. Being wrong downward costs a bad answer _and_ a retry on a stronger model, so uncertainty resolves upward. |
| Downgrade guard        | Above ~20k context tokens a downgrade is refused: switching models invalidates the provider prompt cache, and the re-send costs more than the cheaper tier saves.    |
| Availability clamp     | A tier with no models the caller can reach is skipped, stepping _up_ by preference.                                                                                  |

Session momentum (`momentum.ts`) still damps near-boundary flapping on the
heuristic score before the policy runs.

Caller-level overrides — the `x-gateway-tier` header and the `routingProfile`
body field — are set by the integration rather than inferred, so they bypass
the policy layer entirely.

**Routing profile overrides** (via `/internal/route` `routingProfile` field):

- `"fast"` — always Simple tier
- `"reasoning"` — always Reasoning tier
- `"premium"` — forces Complex or Reasoning
- `"balanced"` — default heuristic (same as omitting)

### 4. Select (`src/routing/selector.ts`)

Picks the healthiest, cheapest model in the chosen tier's pool; falls back to a
higher tier on circuit-break. User-pinned `(provider, model)` per specificity
category (`specificity.ts`) short-circuits tier selection entirely when the
category is detected with ≥0.9 confidence.

### What is cached

Only the classifier verdict, keyed by prompt shape and the tier menu it was
graded against. Finished routing decisions are **not** cached: a decision
embodies the caller's plan, region/provider filter rules and category pins, so
serving one caller's decision to another would silently apply the wrong
restrictions.

### Decision trace

`/internal/route` returns a `decision` object — `source`
(`heuristic` | `classifier` | `classifier-cache` | `caller-override`),
`confidence`, the policy `reason`, the tiers that were actually available, and
the estimated context size. `gateway.route_classifier_ms` is exported when the
classifier ran.

## Guardrails

Applied to all messages before provider dispatch (`src/lib/guardrails.ts`):

| Violation type | Default action | Description                                                       |
| -------------- | -------------- | ----------------------------------------------------------------- |
| `pii`          | `mask`         | Replaces API keys, emails, SSNs, credit cards, phone numbers, IPs |
| `injection`    | `block`        | Blocks prompt injection attempts                                  |
| `sensitive`    | `allow`        | Detection only, no action                                         |

Config can be overridden per-request on internal endpoints (the backend's binding only):

```json
{ "guardrails": { "pii": "allow", "injection": "block" } }
```

Or disabled entirely: `{ "guardrails": false }`.

Violations are persisted in `usage_log.guardrail_violations` and trigger webhook events.

## Structured Output

For `/v1/chat/completions` requests with `response_format: { type: "json_schema", ... }`:

1. **Validate** — check response against the provided JSON schema
2. **Heal** — if validation fails, attempt local repair (bracket/quote fixing)
3. **Re-generate** — if local repair fails, call the model again with explicit repair instructions

Healed responses include an `X-Gateway-Healed: true` header and `healed: true` in `usage_log`.

## Authentication

| Endpoint prefix | Auth scheme                                                                               | Who uses it         |
| --------------- | ----------------------------------------------------------------------------------------- | ------------------- |
| `/internal/*`   | None — served only through the `InternalApi` entrypoint (a service binding); 404 publicly | Lunora backend      |
| `/v1/*`         | Bearer token (`Authorization: Bearer gk_*`)                                               | SaaS API clients    |
| `/v1/stream`    | Stream token in request body (`{streamId}:{userId}:{threadId}:{expiresAt}:{hmac}`)        | Browser / extension |

### Virtual API Keys

Keys are provisioned via `POST /internal/keys`. Raw key (`gk_*`) returned once. Subsequent calls use hashed lookup. Keys support per-user budget limits (`monthlyBudgetCents`) and per-minute token limits.

## Environment Variables

Set via `wrangler secret put` for production.

### Required

| Variable         | Description                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `SIGNING_SECRET` | HMAC secret shared with the backend: Gateway → backend calls, stream-token verification   |
| `LUNORA_URL`     | Lunora backend origin — chunk polling, API-key validation, usage reporting, `/chat/start` |

### Optional (platform defaults — users can supply own keys via BYOK)

| Variable                | Provider                                                       |
| ----------------------- | -------------------------------------------------------------- |
| `OPENROUTER_API_KEY`    | OpenRouter                                                     |
| `GROQ_API_KEY`          | Groq                                                           |
| `XAI_API_KEY`           | xAI (Grok)                                                     |
| `GOOGLE_API_KEY`        | Google (Gemini)                                                |
| `OPENAI_API_KEY`        | OpenAI                                                         |
| `FAL_API_KEY`           | fal.ai (FLUX, video)                                           |
| `BFL_API_KEY`           | Black Forest Labs direct (Flux Pro / Flux Kontext)             |
| `REQUESTY_API_KEY`      | Requesty                                                       |
| `CLOUDFLARE_ACCOUNT_ID` | Workers AI REST fallback (when `AI` binding is unavailable)    |
| `CLOUDFLARE_API_KEY`    | Workers AI REST fallback (paired with `CLOUDFLARE_ACCOUNT_ID`) |

### Routing (optional)

| Variable                   | Description                                                                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROUTING_CLASSIFIER_MODEL` | Catalogue model ID used to grade routing difficulty before selection. Unset = heuristic scoring only. Pick something cheap and fast; the call sits in front of the user's turn and a late verdict is discarded. |

### Plain vars (in `wrangler.jsonc`)

| Variable          | Default       | Description                  |
| ----------------- | ------------- | ---------------------------- |
| `APP_NAME`        | `llm-gateway` | Service name in logs         |
| `APP_VERSION`     | `1.0.0`       | Service version              |
| `NODE_ENV`        | `development` | `"production"` in prod env   |
| `ALLOWED_ORIGINS` | _(none)_      | Comma-separated CORS origins |

### OpenTelemetry (optional)

When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, every request is wrapped in a SERVER root span and `gateway.*` counters/histograms are exported to the configured OTLP/HTTP collector (Honeycomb, Grafana, SigNoz, OTel Collector, etc). Leave unset to disable telemetry — the middleware short-circuits to a no-op with zero overhead. The W3C `traceparent` header is honoured for cross-service trace propagation.

| Variable                      | Description                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL of OTLP/HTTP collector (`https://api.honeycomb.io`, etc). HTTP(S) only.  |
| `OTEL_EXPORTER_OTLP_HEADERS`  | Comma-separated `key=value` headers (e.g. `x-honeycomb-team=...,x-dataset=prod`). |
| `OTEL_SERVICE_NAME`           | Override `service.name` resource attribute. Falls back to `APP_NAME`.             |

## API Reference

### SaaS API (`/v1/*`)

All endpoints require `Authorization: Bearer gk_<key>`.

#### Chat Completions

```http
POST /v1/chat/completions
```

OpenAI-compatible. Supports streaming (`"stream": true`), tools, structured output (`response_format`), and idempotency (`Idempotency-Key` header).

Request body:

```json
{
    "model": "gpt-4o",
    "messages": [{ "role": "user", "content": "Hello" }],
    "stream": false,
    "temperature": 0.7,
    "max_tokens": 1000,
    "response_format": { "type": "json_schema", "json_schema": { "name": "result", "schema": { "type": "object" } } },
    "tools": [{ "type": "function", "function": { "name": "search", "parameters": { "type": "object" } } }],
    "transforms": ["middle-out"]
}
```

#### Models

```http
GET /v1/models
```

Returns list of supported models with pricing.

#### Embeddings

```http
POST /v1/embeddings
```

```json
{
    "model": "text-embedding-3-small",
    "input": "text to embed",
    "encoding_format": "float"
}
```

#### Images

```http
POST /v1/images/generations
GET  /v1/images/models
```

Routes to DALL-E (OpenAI) or FLUX/Recraft (fal.ai) based on model.

#### Audio

```http
POST /v1/audio/speech          TTS: text → audio stream
POST /v1/audio/transcriptions  STT: audio file → text
POST /v1/audio/translations    Audio file → English text
GET  /v1/audio/models
```

#### Realtime (WebSocket)

```http
GET /v1/realtime?model=gpt-4o-realtime-preview
Upgrade: websocket
```

Bidirectional WebSocket proxy to OpenAI Realtime API. Session limits: 2 concurrent (free), 10 (pro), 50 (enterprise).

#### Usage & Logs

```http
GET /v1/usage           Daily usage summary
GET /v1/logs            Paginated request history
GET /v1/rate-limits     Current rate limit status
```

#### Cache

```http
GET    /v1/cache        List cached prompts
DELETE /v1/cache/:key   Invalidate a cached prompt
```

---

### Internal API (`/internal/*`)

Reachable only through the backend's service binding to the `InternalApi` entrypoint (`src/index.ts`); the public `fetch` handler answers every `/internal/*` path 404. Nothing is signed.

#### Streaming Generation

```http
POST /internal/stream
```

High-level streaming — emits SSE chunks. Used by backend agent execution.

```json
{
    "modelId": "claude-sonnet-4",
    "provider": "anthropic",
    "modelApiId": "claude-sonnet-4-20250514",
    "messages": [{ "role": "user", "content": "Hello" }],
    "system": "You are a helpful assistant.",
    "toolSchemas": { "myTool": { "description": "Describe the tool", "parameters": { "type": "object" } } },
    "requestId": "req_abc123",
    "userId": "user_123",
    "guardrails": { "pii": "mask", "injection": "block" },
    "transforms": ["middle-out"]
}
```

#### Non-Streaming Generation

```http
POST /internal/generate
```

For title generation, classification, memory extraction.

#### Smart Model Selection

```http
POST /internal/route
```

```json
{
    "messages": [{ "role": "user", "content": "Hello" }],
    "userTier": "pro",
    "preferredQuality": 0.7,
    "routingProfile": "balanced"
}
```

Returns: `{ modelId, provider, modelApiId, tier, score, reasoning }`.

#### LanguageModelV3 Proxy

```http
POST /internal/model/proxy
```

Low-level proxy that implements the AI SDK `LanguageModelV3` interface. Used by `gateway-language-model.ts` so all backend agent LLM calls flow through the gateway with zero changes to tool execution.

#### Webhook Management

```http
POST   /internal/webhooks           Register endpoint
GET    /internal/webhooks?userId=X  List webhooks
DELETE /internal/webhooks/:id       Remove webhook
POST   /internal/webhooks/:id/test  Send test event
```

Webhook event types: `completion`, `budget_exceeded`, `guardrail_triggered`, `provider_error`.

Payloads are signed with `X-Gateway-Signature: sha256=<hmac>`.

#### API Key Management

```http
POST   /internal/keys               Create key (raw returned once)
GET    /internal/keys?userId=X      List keys (prefix shown, hash masked)
DELETE /internal/keys/:keyId        Revoke
PATCH  /internal/keys/:keyId        Update name/budget/limits
```

#### Canary / A-B Routing

```http
POST /internal/canary/weights       Set canary weights
GET  /internal/canary/weights       Get current weights
```

#### Notification Rules

```http
POST /internal/notification-rules   Create rule (budget threshold, error rate)
GET  /internal/notification-rules   List rules
DELETE /internal/notification-rules/:id
```

---

### Health & Metrics

```http
GET /health    Liveness + version
GET /metrics   Prometheus-compatible text metrics
```

---

### OpenAPI / Swagger (dev only)

```http
GET /openapi.json   OpenAPI 3.1 spec
GET /doc            Swagger UI
```

---

## Scheduled Tasks

Cron triggers configured in `wrangler.jsonc`:

| Schedule                      | Task                                                  |
| ----------------------------- | ----------------------------------------------------- |
| `5 0 * * *` (daily 00:05 UTC) | Materialize daily usage aggregates, clean up old logs |
| `0 2 * * *` (daily 02:00 UTC) | Refresh model pricing from models.dev API             |
| `*/5 * * * *` (every 5 min)   | Reset expired circuit breakers                        |

---

## Local Development

```bash
# Install dependencies
pnpm install

# Start with wrangler (uses wrangler.jsonc)
pnpm wrangler dev --env development

# Run tests
pnpm test
pnpm test:integration

# Type check
pnpm lint:types
```

### Applying migrations locally

```bash
pnpm wrangler d1 migrations apply llm-gateway-usage-dev --local
```

---

## Deployment

Deployment is managed by Alchemy IaC (`alchemy.run.ts` in the repo root). CI handles this automatically.

```bash
# Preview deploy
DEPLOY_ENV=preview pnpm deploy

# Production deploy
DEPLOY_ENV=production pnpm deploy
```

Alchemy provisions and manages:

- D1 database (`llm-gateway-usage`)
- KV namespaces (`RATE_LIMIT_KV`, `PRICING_KV`, `CACHE_KV`)
- Worker binding + smart placement

> **Note:** Do not run `wrangler deploy` directly — use Alchemy.

---

## Backend Integration

The gateway integrates with the Lunora backend via four files:

| File                                                 | Role                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| `backend/lunora/chat/lib/gateway-client.ts`          | Client over the gateway's service binding (`gatewayFetch(ctx)`)       |
| `backend/lunora/chat/lib/gateway-language-model.ts`  | `LanguageModelV3` proxy — routes all agent LLM calls through gateway  |
| `backend/lunora/chat/lib/gateway-embedding-model.ts` | `EmbeddingModelV2` proxy — routes all embedding calls through gateway |
| `backend/lunora/chat/lib/gateway-usage.ts`           | Webhook handler for usage reports → credit deduction                  |

The backend reaches the gateway over its `SERVICE_LLM_GATEWAY` binding (declared in `backend/lunora.config.ts`), so **all** LLM calls route through the gateway. No changes to tool execution, message persistence, or agent loops are required.

Edge streaming flow:

1. Agent loop writes chunks to the `persistentChunks` table (backend)
2. Client connects to `POST /v1/stream` with HMAC stream token
3. Gateway polls `POST /chat/chunks` (backend) for new chunks
4. Gateway relays NDJSON to client over HTTP streaming

Stream token format: `{streamId}:{userId}:{threadId}:{expiresAt}:{hmac}` (30-min TTL).
