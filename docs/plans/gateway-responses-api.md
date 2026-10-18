# Gateway `/v1/responses` — Implementation Plan

**Created:** 2026-10-19
**Status:** Planned
**Scope:** `services/llm-gateway/src/routes/v1/`

## Why

The public gateway speaks Chat Completions (`routes/v1/completions.ts`, 965
lines: auth, rate limit, idempotency, routing, usage, cache). Newer OpenAI-style
clients and agent SDKs only speak the Responses API, so they cannot use the
gateway or the public API.

## Approach — a translating adapter, not a second pipeline

`POST /v1/responses` converts the request into a `/v1/chat/completions` body,
sends it through the existing router in-process, and converts the reply back.
Auth, rate limits, idempotency, routing, billing and caching therefore run once,
in the one place that already owns them. Nothing in `completions.ts` changes.

Request mapping:

- `input` string → one user message; array of items → `message` items (roles,
  `input_text` / `output_text` parts), `function_call` and
  `function_call_output` → assistant `tool_calls` / `tool` messages.
- `instructions` → leading system message.
- `max_output_tokens` → `max_tokens`; `temperature`, `top_p`, `stream`,
  `user` pass through; `tools` of `type: "function"` → chat `tools`;
  `tool_choice` passes through.
- Hosted tools (`web_search`, `file_search`, …) and `previous_response_id` are
  refused with a 400 naming the field — the gateway is stateless.

Response mapping:

- Non-streaming: `{ id: "resp_…", object: "response", status, model, output:
  [message | function_call…], usage: { input_tokens, output_tokens,
  total_tokens } }`.
- Streaming: chat SSE → `response.created`, `response.output_item.added`,
  `response.output_text.delta`, `response.function_call_arguments.delta`,
  `response.output_item.done`, `response.completed` (+ `[DONE]`).
- Upstream errors keep their status and are re-wrapped in the Responses error
  shape.

The pure translators live in `routes/v1/responses-map.ts` (no I/O) so they are
unit-tested directly; the route file only wires them.

## Tests

`responses-map.test.ts`: string and item inputs, tool round trip, refused
fields, finish-reason mapping, SSE event order and a tool-call stream. Route
test: a mocked completions app proves auth headers are forwarded.

## Out of scope

Stored responses / `previous_response_id`, hosted tools, background mode.
