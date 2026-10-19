# Gateway `/v1/responses` — Implementation Plan

**Created:** 2026-10-19
**Status:** Implemented
**Scope:** `services/llm-gateway/src/routes/v1/`

## Why

The public gateway speaks Chat Completions (`routes/v1/completions.ts`: auth, rate
limit, idempotency, routing, usage, cache). Newer OpenAI-style clients and agent
SDKs only speak the Responses API, so they cannot use the gateway or the public
API.

## Approach — a translating adapter, not a second pipeline

`POST /v1/responses` converts the request into a `/v1/chat/completions` body,
sends it through the existing router in-process, and converts the reply back.
Auth, rate limits, idempotency, routing, billing and caching therefore run once,
in the one place that already owns them. The chat route gained what the adapter
needed (tool calls in replies and in replayed history, usage on streams), so the
fixes live there and benefit both routes.

Telemetry is recorded once per client call. The inner request carries the outer
request's id and telemetry (`lib/dispatched-request.ts`, a module-private symbol on
the env, never a header), so the app-level middleware records the call on the
outer `/v1/responses` request only: one SERVER root span, one
`gateway.requests_total`, one log line. The chat call's GenAI span nests under
that root. The outer request is the one recorded, so its refusals (401, 400
before dispatch) still show.

Request mapping:

- `input` string → one user message; array of items → `message` items (roles,
  `input_text` / `output_text` parts), `function_call` and
  `function_call_output` → assistant `tool_calls` / `tool` messages.
- `instructions` → leading system message.
- `max_output_tokens` → `max_tokens`; `temperature`, `top_p`, `stream` pass
  through; `tools` of `type: "function"` → chat `tools`; `tool_choice` `auto`,
  `none`, `required` or `{ type: "function", name }` → chat `tool_choice`. A
  streamed request sets `stream_options.include_usage`, so `response.completed`
  carries usage.
- `text.format` (`json_schema` / `json_object`) → `response_format`.
- Hosted tools (`web_search`, `file_search`, …) and `previous_response_id` are
  refused with a 400 naming the field — the gateway is stateless.

Response mapping:

- Non-streaming: `{ id: "resp_…", object: "response", status, model, output:
  [message | function_call…], usage: { input_tokens, output_tokens,
  total_tokens } }`. When the request declares tools, the reply's `tool_calls` come
  back as `function_call` items.
- Streaming: chat SSE → `response.created`, `response.output_item.added`,
  `response.output_text.delta`, `response.function_call_arguments.delta`,
  `response.output_item.done`, `response.completed` (+ `[DONE]`).
- Upstream errors keep their status and are re-wrapped in the Responses error
  shape.

The pure translators live in `routes/v1/responses-map.ts` (no I/O) so they are
unit-tested directly; the route file only wires them.

## Known limits

These are the chat route's, inherited (see the header of `responses.ts`):

- `text.format` is enforced only on a non-streaming request. The chat stream
  carries no structured-output validation.
- Streamed text is not scanned for PII; a non-streaming reply is.
- A reply that calls tools skips structured-output validation, since its text is
  empty by design.

## Tests

`responses-map.test.ts`: string and item inputs, tool round trip, refused
fields, `tool_choice` mapping, finish-reason mapping, SSE event order, usage on
`response.completed`, and a tool-call stream. `responses-route.test.ts`: a stubbed
dispatcher proves auth headers are forwarded and a tool request is dispatched
non-streaming, and the real app-level middleware records the call once with the
inner request adopting the outer's id and telemetry.
`integration/responses.integration.test.ts`: the real app with the mock model.
`integration/otel-export.integration.test.ts` drives `POST /v1/responses`, streamed
and not, and pins one SERVER span, one `gateway.requests_total` datapoint and the
GenAI span parented to the root. `integration/tool-calls.integration.test.ts` and
`convert-messages.test.ts` cover the chat route's tool replay, tool calls and
stream usage that this route depends on, and `integration/tool-choice.integration.test.ts`
pins each `tool_choice` form at the model.

## Out of scope

Stored responses / `previous_response_id`, hosted tools, background mode.
