# CHAT — AGENT NOTES — REFERENCE

The rules are summarized in `backend/lunora/chat/AGENTS.md`, which agents load automatically; this file holds the reasoning and detail. Paths are repo-relative where they start at a top-level folder; shorter ones (`chat/…`, `lib/…`, `persistent/…`, `auth/…`) are relative to `backend/lunora/` (`persistent/…` to `backend/lunora/chat/streaming/`).

## INVARIANTS

- **Edge streaming** — agent execution is decoupled from SSE delivery. The agent
  loop runs as a background job on the JOBS QUEUE (not the scheduler — see
  "Sharding and concurrency" in `backend/AGENTS.md`) (`backend/lunora/chat/execute.ts:runStreamingAgent`),
  claims its stream once (`claimStreamRun`) and writes to
  `persistentChunks`; the client streams from the gateway, which polls
  `/chat/chunks` and relays NDJSON. Stream token is HMAC
  `{streamId}:{userId}:{threadId}:{expiresAt}:{hmac}`, 30 min TTL.
  **Interrupted runs** (`chat/streaming/persistent/interrupted*.ts`,
  `chat/lib/interrupted-run.ts`): a run about to generate registers its job args on the
  stream (`registerResumableRun`), beats every minute (`beatRun`; the beat patches the
  stream row, so never faster) and marks each tool call while it executes
  (`markToolRun`, via `markToolRuns`). One watchdog chain per stream (`watchRun`, a
  scheduler action, every minute) sees a claimed, unpaused stream with a beat older
  than 3 minutes as dead and queues the SAME resume a rate-limit pause queues: a
  `pause` marked `pauseCause: "interrupted"`, claimed by `claimRunResume` (so redelivery
  still resumes once). `from`, the reply rows and the step count are DERIVED from the
  saved rows, never from the dead run's memory (`settleSavedRows`); anything that is
  not a finished row or an empty placeholder, a trailing tool call without its result,
  a delivered steer or an open tool mark fails the run visibly instead. A tool that
  is safe to repeat (`lib/repeatable-tools.ts`) leaves no open mark: its start is
  checked against the stream (live, held by this run) but not counted, so a death
  inside it drops the unsaved step and the resume asks the model again, which calls
  the tool anew. Repeating such a call may cost a second search or fetch, never a
  second write. A tool says so explicitly or is unsafe: built-ins by name in
  `BUILTIN_TOOLS_SAFE_TO_REPEAT`; MCP and connector tools when the server says
  `readOnlyHint: true` and neither `destructiveHint` nor `openWorldHint` (the hints
  the quick check also refuses on); device tools never. At most 3
  resumes per reply (`interruptions`), independent of the 3 rate-limit pauses; the
  4th interruption fails with an error line. Opt out with
  `userSettings.resumeInterruptedRuns === false` (absent = on): the stream then
  expires into `timeout` as before. An interrupted pause is not shown as a rate-limit
  wait and "Retry now" skips it. Not covered: tool-approval continuations, group
  turns and stateless runs register nothing, so they still time out.

- **Pinned MCP tools** (`chat/lib/mcp-tool-fingerprint.ts`, `mcp-tools.ts`, `agent-run.ts#resumeApprovedRun`) — a
  run that pauses for an approval records a fingerprint per MCP tool it offered (`mcpToolFingerprints`): a hash of the
  server (name or connector slug, url, protocol), the tool name, the input JSON Schema (keys sorted; `required`, `enum`,
  `type` and dependency name lists sorted as sets, data such as `const` left in order) and the behaviour hints (never the
  display title or description). Only hashes are stored. The continuation re-lists the tools and compares: unchanged
  runs; changed, removed, or still offered but unhashable this time (`unverified`) is answered as denied with a reason the
  model reads, so a fresh call goes through the tool's permission again. A continuation that pauses again records the
  fingerprints AND permission keys of the tools it offered. After a 401 the OAuth retry runs a relisted tool only if it
  hashes the same as the first listing (`createAuthRetrySession`'s `sameTool`); a failed check refuses. A schema that
  does not resolve within `FINGERPRINT_DEADLINE_MS` leaves the tool unpinned, and an OAuth retry on it is refused. The
  pin covers the ONE approved call: an "Always allow" or timed grant is keyed by tool (`mcp:<server>:<tool>`, or
  `connector:<slug>:<tool>`), like `auto`, so it covers a new call to the changed tool. The pin tells servers apart by
  name (or connector slug) + url + protocol; low-risk trust and OAuth sign-ins use name + url, and permission keys the
  name alone, so credentials never distinguish two saved entries. Interrupted and rate-limit resumes re-list the tools and replay no saved call; a repeatable tool that was
  in flight is called afresh against the current list.

- **Rate-limit pause** (`backend/lunora/chat/lib/rate-limit-pause.ts`, `chat/lib/pause-run.ts`, `persistent/library.ts#pauseRunForRateLimit`) —
  a provider 429 (or a 5xx that names a retry time) pauses the run instead of failing it. The GATEWAY reads the provider's
  headers/body (`services/llm-gateway/src/lib/retry-after.ts`) and sends `rateLimit: { status, retryAt }` beside
  `fallbackReason` — on the 502 body, an in-band error part and a mid-read throw — only while the step has produced nothing
  visible; the backend decides on that field alone, never on message text, and a bare 429 with no field still fails. The
  stream stays `pending|streaming` with `persistentStreams.pause` set (so stop, the live query and the expiry sweep need no
  new status; `expiresAt` moves past `retryAt`), the rejected step's empty placeholder row is deleted, and the resume is the
  SAME `runStreamingAgent` job re-enqueued with `resume: <pause id>` at `retryAt` (the pause stores the job's input).
  `claimRunResume` claims by pause id, so a redelivery, "Retry now" (`chat/rate-limit-retry.ts`, which queues the same
  resume for now) and a stale delayed job all no-op after the first; the resume streams from the last row the run saved
  (`pause.from`), not from the user message — `failPendingSteps` plus a user-message prompt would make a mid-run resume a
  sibling reply. Caps: a pause ≤ 10 min, one per step (keyed on `from`), 3 per run; past them, or with a delivered steer, or
  stateless, or in a group turn / approval continuation, the run fails as before. Nothing waits in an action or a queue
  invocation. The AI SDK never retries these (`GatewayLanguageModel` throws a plain `Error`, not an `APICallError`), so the
  pause is the only retry. The countdown in the chat is `aria-hidden`; a polite status region speaks every 30 s.

- **Browser automation** — `browserTool` runs through the Cloudflare Browser
  Rendering worker via `@neore/service-sdk/browser-renderer`. There is no
  Browserbase/Playwright path any more and `BROWSERBASE_API_KEY` does nothing;
  `browser-node.ts` gates on the `SERVICE_BROWSER_RENDERER` binding alone
  (`isServiceBound`), and the tool has no env requirement. The SSRF guard
  `validateDomain` lives in `tools/utilities.ts`, not `browser-node.ts`, so the
  security suite imports the real function rather than a copy.

- **Ask-user** (`chat/tools/ask-user.ts`) — a question IS a tool-approval
  request: the tool hard-codes `needsApproval: true`, so the pause, snapshot
  and claim are the approval machinery's. It is answered only through
  `chat_ask_user.answerAskUser` (`respondToToolApproval` refuses it — an
  approval with no answer would resume with nothing); the continuation swaps
  in `createAnsweredAskUserTool(answer)` so the answer is the tool result, and a
  dismiss is a denial with a reason. Headless runs drop it whatever its mode
  (`BUILTIN_TOOLS_NEEDING_A_PERSON`). Its constants live in
  `ask-user-constants.ts` because `agent-run.ts` importing the tool module
  (which loads the agent client) breaks the import graph in unit tests.

- **Low-risk quick check** (`chat/lib/low-risk-approval.ts`, `low-risk-check.ts`) — opt-in
  (`aiUserPreferences.autoApproveLowRisk`, absent = off, set only by `setAutoApproveLowRisk`).
  An eligible `ask` tool's `needsApproval` becomes a function: taint, then the per-user budget
  (`chat/toolAutoApprove`), then one utility-model call (no tools, strict `{lowRisk, reason}`, 8 s
  deadline); anything but a clean `lowRisk: true` is a prompt. **Eligibility is decided before the
  model is asked and the verdict can never widen it:** MCP/connector tools only (every built-in that
  defaults to `ask` is a person tool or a delegation), **only from a server the user trusts**
  (`aiUserPreferences.lowRiskTrustedServers`, `chat/lib/low-risk-trust.ts`: a server's tool descriptions and
  schemas reach the model unfiltered, so a malicious server could steer it into another server's read tool
  with chat data, and the check sees only the key and arguments; an entry is an MCP server's name AND url,
  or a connector's slug, so a url change drops the trust; written only by `setLowRiskTrustedServer`, at most
  50; the run's `describe` stamps `ToolDescriptor.trustId` and the mid-run re-check in
  `getLowRiskApprovalContext` takes it too, so revoking trust holds from the next call, and a call that
  names no server is refused), no user override (only the DEFAULT `ask`), no
  destructive/open-world annotation, not headless, not an API-key run, and the thread must pass
  `isDeviceEligibleThread` (the owner alone — a collaborator's turn would otherwise replace the
  owner's consent). **The tool name must START with a read verb** (`READ_VERBS`: get, list, search,
  read, fetch, find, query, describe, lookup, view — the leading word of the key's tool name, split on
  `_ - .` or a camelCase boundary), so `create_issue`, `save_issue`, `create_event` and `sendemail` are
  never checked; `OUTWARD_WORDS` stays as a second gate for a read verb followed by a write
  (`get_or_create_user`), scanned over the TOOL's name only (a server called "mail" does not turn its
  tools away; a noun like `message` or `pr` in the tool's own name still does). An allowlist, not a blocklist: a new write verb is a prompt by default.
  **Never after context the person did not write in this chat:** taint is `computeTaint(options.messages)`
  (any tool result or attached file or image), `messagesCarryAttachedText` (`chat/lib/attached-text.ts`: an
  attached document's extracted text and a captured browser page, which `/chat/start` and the edit path put
  into the user message as plain TEXT parts that `computeTaint` cannot tell from typing — found by their
  `[Document: …]` / `[Attached Document]` / `[Web page context]` line label or the page's structural marker,
  and built through `documentTextPart` so the label and the detector cannot drift) AND `untrustedContext`
  (retrieved knowledge, memories or project context in the system prompt, plus ANY skill text there:
  `execute.ts` ORs `injectsSkillText(skillRun)` — an enabled skill's description or an invoked skill's
  instructions — into `RunContext.untrustedContext`). Skills are all-or-nothing on purpose: `skills.source`
  is client-supplied at creation, agents write skills from chats that may have read third-party content, and
  marketplace forks, imports and organisation-shared skills are other people's text, so "this user wrote it"
  cannot be told cheaply or reliably. A user with any enabled skill therefore never gets the check; narrowing
  that needs a server-minted authorship marker first. A thread summary records attached text as `files` taint
  when it folds the rows in (`thread-summaries.ts`); summaries written before that are not repaired. The tools are built while the
  context loads, so the check awaits that promise at the first call; a continuation reloads nothing and
  reads `toolRunConfig.untrustedContext` off its snapshot (absent = tainted). **The setting and the
  thread's sharing are re-read at every call**, in the same mutation that spends the budget unit
  (`consumeLowRiskCheck`), so switching it off or sharing the thread mid-run holds from the next call
  (`getLowRiskApprovalContext` at run start only decides whether to build the check). The approval is
  stamped on the saved call by tool call id (`providerOptions.neore.autoApproval`, next to the MCP
  label) through `stampSavedToolCalls`, which `finishRun`, `endStoppedRun`, `failRun` and the
  continuation's failure path all call; a stamp that fails is logged and never changes how the run
  ended. A `chat.low_risk_check` event is logged per decision.

- **Side questions** (`chat/aside.ts`, `apps/web/src/features/chat/aside/`) — a model call on a
  READ-ONLY snapshot of the thread (active path, plus the reply so far from the live stream) that writes
  nothing: the question and answer live in the client's `useAsideStore` for the session. Same model as the
  thread, falling back to the utility model for a non-text model or a plan that lapsed. A thread on a
  custom endpoint the caller cannot reach (deleted, a collaborator's account, `local-browser`, a malformed
  id) is refused, never rerouted to a hosted model; a host-run thread sends the QUESTION ALONE (its
  messages never reach a cloud model, as with follow-up suggestions). Billed like translate
  (`chargeDailyLimit` "Text" right before the model call, gateway meters it); an aside on the thread's own
  model is also recorded with `scheduleReplyUsage` under `aside:<entryId>`, a utility-model or host-run one
  is not, and the usage backfill skips the added "Side question" row. The answer arrives whole: an action returns
  once and an HTTP action has no service binding, so token streaming needs a chunk table. "Add to
  thread" (`addAsideToThread`) writes ONE assistant row (`agentName` "Side question") and is refused
  while a reply runs, because a row landing after the run's pending row would split the reply across
  branches. `parseCustomModelId` returns `null`, not `undefined`, for a non-custom id.

- **Context compaction** (`backend/lunora/agent/thread-compaction*.ts`, `chat/compaction.ts`,
  `apps/web/src/features/chat/compaction/`) — replaces a thread's older turns in the model's input only; stored
  messages are never touched. It is a `threadContextSummaries` row with `kind: "compact"`. Auto-compact runs in
  `runStreamingAgent` before the reply builds its context.
- **Time-boxed tool allows** ("Allow for 1 hour" / "for today" on the approval card) — a key -> expiry record in
  `aiUserPreferences.toolPermissionGrants`, NOT an `auto` override, and deliberately absent from `auth/fields.ts` so no
  client input can set one. `resolveToolPermission` lifts only an `ask` to `auto`, before the API-key clamp; `off` wins,
  a headless run ignores grants (it does not even read them — the same "inherits nothing" rule as every other consent),
  and `device:` keys and `builtin:askUser` never take one (the device approves again, with taint known only there;
  `respondToToolApproval` refuses it). A tool built under a grant gets `needsApproval: () => Date.now() >= expiresAt`,
  so a long run notices the lapse at the next call. "Today" ends at the user's next local midnight from
  `userSettings.timezone` (UTC when unset). Lapsed entries are pruned on every grant write and by the
  `pruneExpiredToolPermissionGrants` housekeeping sweep. The MCP-app proxy (`lib/mcp-apps.ts`) does not honour grants.

- **Auto-continue ("Deep Work")** — raises the agent loop from 5 to 25
  `maxSteps`. All triggers use it by default.

- **Requested secrets** (`backend/lunora/chat/{request-secret,lib/secret-*}.ts`) — the `requestSecret` card hands a
  value to the server once; the agent only ever holds a `ref`. A header secret is stored ENCRYPTED in
  `aiUserPreferences.mcpSecretHeaders`, bound to the server's name AND url, never in `mcpServers[].headers` (plaintext
  Settings shows and the audit history snapshots); it is joined to its server only in `getMCPServersQuery`,
  `getMcpSecretHeadersQuery` (connection test), and left out of `redactPreferences`. Settings does not list these
  headers; a save that sends `mcpServers` prunes the ones whose server moved or whose header was typed by hand. Spending
  a ref needs the turn to have been STARTED by the owner: a continuation runs as the owner, so `startedBy` rides in the run
  snapshot (`vToolRunConfig`) and `ToolCtx`. The ciphertext goes when a reply ends for good (`finishRun` unpaused,
  `failRun`, `endStoppedRun`, a group turn's end), not at a pause — a consumer tool set to `ask` pauses the run — and when a
  paused reply is ABANDONED: `stopActiveForThread` (also while another reply is live; a live reply keeps its own) or a
  stopped stream that never started or was waiting out a limit, and `createStreamWithMessage` (a new message moves past the
  request), all through `discardPausedThreadSecrets` (a group turn's pause is the same snapshot, so the same path). That
  call skips reply keys that still have a live stream (a pause with several requests shares one key), clears the thread's
  references in one pass, DENIES the reply's pending SECRET requests (`resolvedBy: "abandoned"`; answering one is refused with
  `TOOL_REQUEST_ABANDONED`; other pending approvals stay answerable, and a Stop denies them even when a claimed run keeps its
  ciphertext until it settles) and marks the references `abandoned`, which a late spend reads. A Stop naming a prompt abandons
  only that prompt's reply.
  The card sends the server address it showed (`expectedUrl`); the answer is refused if the saved server's URL differs.
