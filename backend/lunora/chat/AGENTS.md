# CHAT — AGENT NOTES

The rules for working in `backend/lunora/chat/`. The detail and reasoning are in
[docs/agents/backend-chat.md](../../../docs/agents/backend-chat.md).

## INVARIANTS

- **Edge streaming** — the agent loop (`chat/execute.ts:runStreamingAgent`) runs on the JOBS QUEUE, not the scheduler; it claims its stream once (`claimStreamRun`) and writes `persistentChunks`, which the gateway polls (`/chat/chunks`) and relays as NDJSON.
- Stream token is HMAC `{streamId}:{userId}:{threadId}:{expiresAt}:{hmac}`, 30 min TTL.
- Interrupted runs: register (`registerResumableRun`), beat once a minute (`beatRun`, never faster) and mark tool calls (`markToolRuns`); the `watchRun` watchdog resumes a run with a beat > 3 min old via a `pauseCause: "interrupted"` pause claimed by `claimRunResume`.
- A resume derives `from`, rows and step count from SAVED rows (`settleSavedRows`), never the dead run's memory; anything unfinished (trailing tool call, delivered steer, open tool mark) fails visibly. Max 3 resumes per reply.
- Opt-out is `userSettings.resumeInterruptedRuns === false` (absent = on). Approval continuations, group turns and stateless runs register nothing.
- **Rate-limit pause** — pause only on the gateway's `rateLimit: { status, retryAt }` field, never on message text; a bare 429 without it still fails.
- Paused streams stay `pending|streaming` with `persistentStreams.pause`; the resume is the SAME `runStreamingAgent` job with `resume: <pause id>`, claimed by `claimRunResume` (redelivery, "Retry now", stale jobs no-op) and streaming from `pause.from`.
- Caps: pause ≤ 10 min, one per step, 3 per run; steer/stateless/group/approval-continuation runs fail instead. Never wait inside an action or queue invocation. Countdown is `aria-hidden`, with a polite status region.
- **Browser automation** — `browserTool` uses the Browser Rendering worker (`@neore/service-sdk/browser-renderer`), gated on the `SERVICE_BROWSER_RENDERER` binding (`isServiceBound`); no Browserbase path.
- The SSRF guard `validateDomain` stays in `tools/utilities.ts` so the security suite tests the real function.
- **Ask-user** (`chat/tools/ask-user.ts`) — keep `needsApproval: true` hard-coded; answer only via `chat_ask_user.answerAskUser` (`respondToToolApproval` must refuse it); headless runs drop it (`BUILTIN_TOOLS_NEEDING_A_PERSON`).
- Ask-user takes ONE form per call: `question` (+`choices`) or `questions` (≤ `ASK_USER_MAX_QUESTIONS`). The reply must match the form (`answer` text vs `answers` list); `resolveQuestionAnswers` validates picks against the call's own choices inside the claim, and the stored output carries `answer` OR `answers`, never both.
- Ask-user constants stay in `ask-user-constants.ts`; `agent-run.ts` must not import the tool module.
- **Low-risk quick check** (`chat/lib/low-risk-approval.ts`, `low-risk-check.ts`) — opt-in (`aiUserPreferences.autoApproveLowRisk`, absent = off, set only by `setAutoApproveLowRisk`); order: taint, budget (`chat/toolAutoApprove`), one utility-model call; anything but a clean `lowRisk: true` prompts.
- Eligibility is decided BEFORE the model and the verdict never widens it: MCP/connector tools only, from a trusted server only (`aiUserPreferences.lowRiskTrustedServers`, name AND url or connector slug, written only by `setLowRiskTrustedServer`, max 50; a call naming no server is refused).
- Also required: only the DEFAULT `ask` (no user override), no destructive/open-world annotation, not headless, not an API-key run, `isDeviceEligibleThread` (owner alone).
- The tool name must START with a `READ_VERBS` verb (allowlist), and `OUTWARD_WORDS` over the tool's own name is a second gate; a new write verb prompts by default.
- Never after context the person did not write: taint = `computeTaint(messages)` + `messagesCarryAttachedText` (build attached text only through `documentTextPart`) + `untrustedContext` (knowledge, memories, project context, ANY skill text via `injectsSkillText`). Any enabled skill disables the check.
- A continuation reads `toolRunConfig.untrustedContext` from its snapshot (absent = tainted). Setting and thread sharing are re-read at every call in `consumeLowRiskCheck`.
- Stamp the approval via `stampSavedToolCalls` (`providerOptions.neore.autoApproval`) on every run end; a failed stamp never changes the run's outcome. Log `chat.low_risk_check` per decision.
- **Side questions** (`chat/aside.ts`) — read-only snapshot, writes nothing (answer lives in `useAsideStore`); refuse an unreachable custom endpoint, never reroute to a hosted model; a host-run thread sends the QUESTION ALONE.
- Aside billing: `chargeDailyLimit` "Text" right before the model call; own-model asides also `scheduleReplyUsage` under `aside:<entryId>`. `addAsideToThread` writes ONE row and is refused while a reply runs. `parseCustomModelId` returns `null` for a non-custom id.
- **Time-boxed tool allows** — stored in `aiUserPreferences.toolPermissionGrants`, never an `auto` override, and kept OUT of `auth/fields.ts` so no client input sets one.
- `resolveToolPermission` lifts only `ask` → `auto`, before the API-key clamp; `off` wins; headless runs never read grants; `device:` keys and `builtin:askUser` never take one. The MCP-app proxy (`lib/mcp-apps.ts`) ignores grants.
- Granted tools get `needsApproval: () => Date.now() >= expiresAt`; "today" ends at local midnight (`userSettings.timezone`, UTC default); prune via `pruneExpiredToolPermissionGrants`.
- **Auto-continue ("Deep Work")** — raises `maxSteps` from 5 to 25; all triggers use it by default.
- **Requested secrets** — the agent only ever holds a `ref`. Store header secrets ENCRYPTED in `aiUserPreferences.mcpSecretHeaders` (bound to server name AND url), never in `mcpServers[].headers`; join only in `getMCPServersQuery`/`getMcpSecretHeadersQuery`; keep them out of `redactPreferences`.
- Spending a ref requires the turn STARTED by the owner (`startedBy` in `vToolRunConfig` and `ToolCtx`).
- Delete the ciphertext when a reply ends for good (not at a pause) and when a paused reply is abandoned, always through `discardPausedThreadSecrets`, which denies pending SECRET requests (`resolvedBy: "abandoned"`, `TOOL_REQUEST_ABANDONED`).
- Refuse an answer when the saved server's URL differs from the card's `expectedUrl`.
- **Generated titles** (`agent/thread-title.ts`) — a regenerate reads its prompt at run time: the earliest successful user prompt within the active path's last `DEFAULT_RECENT_MESSAGES` rows. `admitTitleRun` checks the thread and takes the charge in one transaction; the answer is recorded on the charge (`recordTitleAnswer`) so a retry writes it without a second call.
- A locked chat's prompt never reaches a title model: each request goes through `titleDispatchGateway`, which takes a `title-dispatch` claim in the same transaction as the lock check and holds it until answered; `enableThreadLock` refuses while one is held. Keep both sides if either changes.
