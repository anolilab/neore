# Gateway daily caps and GenAI spans — Implementation Plan

**Created:** 2026-10-19
**Status:** Implemented (2026-10-19; per-minute token cap and status counts added the same day)
**Scope:** `services/llm-gateway/src/` (`middleware/daily-limit.ts`, `usage/tracker.ts`, `lib/otel/tracer.ts`)

## Daily caps for the public chat route

The gateway limited only requests per minute (`middleware/rate-limit.ts`; the
`/v1/rate-limits` status route says token tracking is "not yet implemented").
The backend has daily quotas for its own chat traffic, but a direct `gk_` key
calling `/v1/chat/completions` (or `/v1/responses`, which goes through it) had
no daily or token cap besides credits.

- `DAILY_REQUEST_LIMITS`, `DAILY_TOKEN_LIMITS` and `TOKENS_PER_MINUTE_LIMITS`,
  `"free=200,pro=5000"`. **All unset by default, and a tier with no entry is
  uncapped**, so deploying changes nothing until an operator chooses numbers. Set
  them as the GitHub environment variables of the same names (`deploy.yml` passes
  them to `alchemy.run.ts`, which binds them where set) or in
  `services/llm-gateway/.dev.vars` locally.
- **Counted from `usage_log`** (`user_id, created_at` is indexed): one aggregate
  read per request, and only when a cap is configured for the caller's tier. All
  three windows come from that one read. A first version kept KV counters; KV
  allows about one write a second per key, so the counter would have stalled under
  exactly the burst a cap is for. The aggregate was checked against SQLite with the
  migrations applied (rows at now, now-30s, now-90s, yesterday, and a midnight
  straddle): the day, the minute and the straddle all count as written.
- Refusal is a `429` with code `DAILY_LIMIT_EXCEEDED` and `Retry-After` to
  00:00 UTC, or, for the per-minute token cap, `TOKENS_PER_MINUTE_EXCEEDED` with
  `Retry-After: 60`. A failed read lets the request through.
- **Approximate by design:** only finished calls are counted, so requests in
  flight are not; a burst of concurrent requests can pass a limit by that many,
  and one call can run the token cap over because it is checked before the call.
  It counts every `saas_api` row of the key, so embeddings and media calls made
  with it count too. It stops a runaway key; credits remain the billing
  boundary.
- Enforced on the chat route (and `/v1/responses`, through it) only. Embeddings
  and media calls made with the same key are counted, so they use up the caps,
  but their routes do not refuse. Mounting the middleware there is a separate
  change: those routes have their own auth and limit chain and their own tests.
- `GET /v1/rate-limits` reports each window's count and cap for the caller's tier.
  A `used` of `null` means the count could not be read.

## GenAI spans

Every model call is already a metric (`gateway.tokens_total`, latency). It now
also exports one span in OpenTelemetry's GenAI conventions, so LLM-aware
backends that ingest OTLP show it as a generation:

- `gen_ai.operation.name` (`chat` | `embeddings`), `gen_ai.provider.name` (and `gen_ai.system`, which older consumers still read),
  `gen_ai.request.model`, `gen_ai.response.model` (the routed model when the
  gateway picked one), `gen_ai.usage.input_tokens` / `output_tokens`, plus
  `gateway.cost_microdollars`, `gateway.finish_reason`, `gateway.request_id`.
- A `CLIENT` span, parented to the request's root span, back-dated by the call's
  latency (`RequestTelemetry.recordSpan`).
- Set by `UsageLogEntry.operation`, which only the chat and embeddings call
  sites pass; media and speech calls export no span.
- **No user id and no prompt or completion text is attached.** Spans go to an
  operator-chosen collector.
- Point `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` (GitHub
  secrets, forwarded by `deploy.yml`) at the backend's OTLP endpoint. Whether a given backend maps these keys to its
  generation view is the backend's contract, not verified here.
- Still operator-level: there is no per-user or per-organization export.
