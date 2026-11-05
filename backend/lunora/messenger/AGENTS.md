# MESSENGER — AGENT NOTES

Scoped notes, moved from the root `AGENTS.md`: what is non-obvious and still true here. Paths are
repo-relative. Project-wide rules stay in the root `AGENTS.md`.

## INVARIANTS

- **Messenger** — Telegram/Slack/Discord, per-connection webhooks at
  `/messenger/{platform}/{connectionId}`. **BYOK**: bot tokens live in
  `aiUserPreferences.messengerKeys` with the same `{ enabled, encryptedKey }`
  shape as provider keys — no global env vars.
  EVERY platform (plus WhatsApp, LINE, Feishu/Lark, Teams and WeChat beta)
  parses into `InboundMessage` and shares one pipeline
  (`messenger/webhooks.ts#acceptInbound`: freshness → claim-once dedupe →
  pairing → per-connection + per-sender rate limit); adapters keep only their
  signature check and parser. **The claim TTL (`MESSENGER_CLAIM_TTL_MS`, 25h)
  must outlast every adapter's freshness window** (WhatsApp's 24h service
  window, Telegram's 24h retention), or a replay lands after its claim expired
  yet still looks fresh. Feishu REQUIRES an Encrypt Key and WeChat accepts
  safe mode only — without them the platform signs nothing that covers the
  body.
  **Reply tools are opt-in per connection** (`messengerConnections.replyTools`,
  `messenger/lib/reply-tools.ts`): the allowed groups come only from the
  owner's connection row, never from the inbound text; `ask`-mode tools are
  dropped (nobody can approve in a messenger); one `chargeRound` per tool reply,
  5 steps max; the 24h/48h reply window is re-checked after the tool run.
  **Media is fetched by the reply action, never the webhook** (`messenger/media.ts`;
  every download through `lib/media.ts#fetchMedia` — per-platform host allowlist,
  a bot token never follows a redirect off-host, 20 MB, MIME allowlist). A media
  message is also SAVED there, so it is absent from the thread until the action
  runs. The reply model follows what the thread's recent rows carry (`chooseReplyModel`); audio reaches the model only
  as a transcript (`fileIds`, not a part — an audio part would fail most providers).
  Outbound media ships only when a reply's assistant rows carry file parts
  (`listReplyMedia`, owner-granted storage only) — so without reply tools
  (`tools: "none"`, the default) nothing ever attaches one.
