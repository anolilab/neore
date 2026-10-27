# Gap backlog — Plans

**Created:** 2026-10-19
**Status:** Planned. Nothing in this file is built; each item names the concrete blocker.

Capabilities of chat, gateway, workflow and voice/document handling that this
tree does not have, or has only in part. Each item says what is missing, the
smallest design that fits our architecture, and why it is not built yet. Three
earlier items are built (knowledge retrieval quality, the gateway `/v1/responses`
route, workflow canvas accessibility); their plans were removed and live on in git
history.

Already covered, so not gaps: hands-free voice already runs on ElevenLabs
Scribe realtime with a Web Speech fallback (`voice-mode/listen.ts`), the gateway
already serves `/v1/audio/transcriptions`, `/v1/audio/translations` and an
OpenAI Realtime WebSocket proxy, and the response cache is exact-match.

## MCP elicitation

`@ai-sdk/mcp` 2.0.73 exposes `onElicitationRequest`, and we declare no
elicitation capability, so servers that need it fail or degrade silently. The
blocker is architectural: a server asks WHILE a tool call is in flight, inside a
queue-job agent run (`runStreamingAgent`) with no browser attached. The ask-user
tool cannot be reused — it pauses a run BETWEEN steps through the approval
snapshot. Design: persist a pending elicitation on the tool part, notify the
user (`notify()`), have the handler wait on a claim row with a hard deadline
(well under the queue visibility timeout) and answer `decline` on expiry.
Needs its own table, a UI card and an authz-matrix row. **Not built:** large,
and servers that depend on it are rare today.

## Inbound email trigger

Triggers are `schedule | webhook | event` and `event` is not built. An email
trigger needs Cloudflare Email Routing → an `email()` handler exported from the
backend Worker (`src/server.ts`), per-trigger addresses
(`t-<triggerId>.<token>@<domain>`, token checked in constant time against a
stored hash), MIME parsing, claim-once on `Message-ID`
(`lib/claim-once.ts`), and the existing run path used by webhook triggers. It
also needs an Email Routing rule and a verified domain in `alchemy.run.ts`.
**Not built:** the infrastructure cannot be exercised locally or in CI, so it
needs a staging account first.

## Semantic response cache

`lib/prompt-cache.ts` is exact-match KV (temperature 0, no tools). A semantic
layer would embed the last user turn and look up a Vectorize index of cached
answers above a similarity threshold. Risk is wrong answers served to a
different intent, and it must be per-user or per-org to avoid cross-tenant
leaks. **Not built:** low hit rate for chat traffic, real correctness risk.

## Custom themes

`features/appearance` has accent presets only. A user-defined accent is
cross-layer, not small: a new `userSettings` field (the schema drift gate, the
validators in `auth/fields.ts`), the persisted UI store, the pre-paint boot
script, `AppearanceSync`, and runtime-derived `--primary`/ring/foreground tokens
that must hold WCAG AA in both modes (`color-contrast.ts` can check, a derivation
step would be new) and be injected without breaking the CSP. **Not built:**
needs its own plan and a product call; presets already cover seven accents.

## Meeting mode with diarization

Scribe supports speaker labels and the gateway already transcribes uploaded
audio. A "meeting" would take a recording (TUS upload path), transcribe with
diarization, and hand the transcript to a summary/skill run. **Not built:**
product decision on retention, consent and pricing first.

## OCR for scanned documents

`plans/document-parser.md` already says OCR needs the container route; the
Rust Worker has no OCR. A vision-model fallback (`vision-analysis.ts`) per page
is possible for small files. **Not built:** waits on the container decision.

## Live data-source sync

Knowledge sources are uploads, pasted text, URLs and folders. Live sync of Git
hosts, notes apps and mail would be connectors-fed ingestion (MCP resources →
`ingest.ts`) on a schedule through the jobs queue. **Not built:** per-provider
work, quota and re-index cost need design.

## Native audio/video input to multimodal models

Audio reaches the model only as a transcript. Passing audio/video parts through
needs registry capability flags (`inputModalities`), gateway part mapping per
provider, and size limits at the three upload boundaries. **Not built:** few
registry models accept it today.

## Realtime speech-to-speech call mode

The gateway proxies OpenAI Realtime, but the web client has no call UI and the
backend has no session ticket for it. **Not built:** needs billing per minute,
ticketing and a UI.

## Audit of the remaining items (2026-10-19)

Checked against the code. "Decision" means a product call is needed first.

- **Capability inheritance for custom models: absent, by design.** A custom
  model id (`custom:<provider>:<model>`) never matches the registry
  (`chat/lib/get-agent.ts`), the picker hard-sets text-only
  (`features/settings/lib/custom-models.ts`) and no reasoning options are sent.
  Fix: copy `mode`/capability flags from the registry entry matching
  `modelApiId`, or per-model toggles on the provider row. Decision: infer from
  the name (fast, sometimes wrong for a proxy that reuses a name) or ask the user.
- **Configuration as code: partial.** Skills (`skills/io.ts`) and workflows
  (`workflow-bundle.ts`) import and export; prompts, system-prompt presets and
  evals export do not, and nothing is YAML. Fix: mirror `importSkill` /
  `exportSkill` for prompts and presets as JSON. Decision: format, and whether
  org-shared prompts and variable defaults travel.
- **Backups: partial.** The data export (`gdpr/functions.ts`) is user-triggered
  and now re-importable as a chat source (`chat-import`, provider `neore`). No
  schedule (not in `PERIODIC_JOBS`; a `shardSweeps()` entry could enqueue one)
  and no per-chat or Markdown export. Decision: retention and storage cost,
  whether the link is emailed. The import side does not dedupe: importing a file
  twice duplicates its conversations.
- **Per-key spend limits: per-user only.** Per-key request rates exist
  (`public-api/router.ts`, same limits for every key, tier hard-coded to free).
  better-auth's `remaining`/`refill*` fields are unused, and they are a D1
  read-modify-write, which our rate-limit notes avoid. The gateway's `gk_`
  virtual-key path is effectively unused: the daily caps count by user. Fix:
  a per-key budget on the key row, checked in the router, which first needs
  `apiKeyId` on usage rows. Decision: enforce in the backend (where the key
  lives) or the gateway (where cost lands).
- **MCP beyond tools: tools only.** Resources are read only for MCP Apps UI;
  prompts, sampling and elicitation are absent. Resources/prompts pickers are
  small. Sampling spends the user's credits through the gateway, so it needs a
  deliberate decision. Progress notifications are not possible with
  `@ai-sdk/mcp` 2.0.73 (`RequestOptions` has no `onprogress`, so no
  `progressToken` is sent).
- **ACP: planned, not built.** See `plans/agent-host-roadmap.md` (ACP host,
  SSH hosts, orchestrator, outside-agent MCP, mobile control). **A2A: absent.**
  Speculative; no plan.
- **Observability backends.** Langfuse reads `gen_ai.request.model` /
  `gen_ai.response.model` and `gen_ai.usage.*`, needs
  `x-langfuse-ingestion-version=4` (otherwise data can lag up to ten minutes) and
  `Authorization=Basic <base64 public:secret>` against `…/api/public/otel`.
  LangSmith maps `gen_ai.operation.name` `chat`/`completion` to an LLM run and
  `embedding` (singular) to an embedding run, and `gen_ai.system` to the
  provider; our `embeddings` follows the OpenTelemetry convention and may not
  map there. Sources: langfuse.com/integrations/native/opentelemetry and
  docs.langchain.com/langsmith/trace-with-opentelemetry. Not verified against a
  live backend.
- **Rerankers on Workers AI.** Only `@cf/baai/bge-reranker-base` is listed
  (`query` and `contexts[{text}]` required, `top_k` optional). No multilingual
  reranker was found, so German retrieval stays on the blended order.
