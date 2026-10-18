# Peer gap backlog — Plans

**Created:** 2026-10-19
**Status:** Planned. Nothing in this file is built; each item names the concrete blocker.

Gaps found by comparing the open feature requests of comparable open-source
chat, gateway, workflow and voice/document projects against this tree. Each item
says what is missing, the smallest design that fits our architecture, and why it
is not built yet. Three items have their own plans:
`knowledge-retrieval-quality.md`, `gateway-responses-api.md`,
`workflow-canvas-a11y.md`.

Corrections from the first pass: hands-free voice already runs on ElevenLabs
Scribe realtime with a Web Speech fallback (`voice-mode/listen.ts`), the gateway
already serves `/v1/audio/transcriptions`, `/v1/audio/translations` and an
OpenAI Realtime WebSocket proxy, and the response cache is exact-match. Those
are not gaps.

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

`docs/plans/document-parser.md` already says OCR needs the container route; the
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
