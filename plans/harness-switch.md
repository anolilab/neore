# Harness switch inside a thread

Status: plan, 2026-10-26. Part of [agent-host-roadmap.md](agent-host-roadmap.md).
Depends on provider capabilities ([provider-capabilities.md](provider-capabilities.md))
for the native-load path, and on ACP S4 for switches to or from a host agent.

## 1. Goal and decision

A user changes the agent behind a thread mid-conversation: another cloud model,
or another agent on a desktop or SSH host. The thread, its history and its
branches stay. The new agent gets the context it needs, and the switch is visible
in the transcript.

Decision: **a switch between cloud models, or between host agents, keeps the
thread and records a handoff.** A switch between cloud and host (either way) forks
a new linked thread instead, because a thread's runner is fixed at creation
([acp-agent-host.md](acp-agent-host.md) §5.1). The handoff says what the new agent
was given. Native session reuse is used only when the same agent can load its own
session and the capability report says so. Otherwise the new agent gets a portable
context.

## 2. Current state (checked)

- The model is chosen per send. The chat send action takes a `model` argument
  (`ChatStartBody` in `backend/lunora/chat/http.ts`). A switch today is a change of that
  argument, with no record in the transcript.
- `threadRelationships.branchType` has four values: `branch`, `continuation`,
  `comparison`, `subagent` (`backend/lunora/schema.ts`, around line 2547). None
  describes an agent change inside one thread.
- Host threads (ACP plan) bind a session to one (agent, folder, host) triple. A
  switch between host agents therefore ends one session and starts another inside
  the same host thread. A cloud thread never becomes a host thread.
- Message parts are written through `backend/lunora/agent/table-writes.ts`, which
  is the cross-module write surface for threads and messages.

## 3. Design

### The switch

- `switchThreadAgent({ threadId, target, clientId })`, a mutation. A cloud-model
  switch needs a write grant on the thread, the same right a collaborator already
  has to pick the model of a send. A host target, and any fork, is owner-only
  (host threads cannot be shared). `target` is a cloud model id, or an offered (agent, folder, host) pair from the
  ACP host's offer list. A host target on a cloud thread, or a cloud target on a
  host thread, returns `forked: <threadId>` and creates the linked thread instead.
  `clientId` makes it claim-once (scope `switch`), so a double tap switches once. A cloud-model target is checked with the same enabled-model and paid-model rules a send uses (`requireEnabledModel`, `assertPaidModel`) before the switch is written or a fork is made; execution checks again, because entitlement can change.
- Refused while a turn in the thread is streaming. The user waits, or stops the
  turn first. This is a hard rule, so a transcript never has two agents writing
  at once.
- The switch writes one message part, kind `agentSwitch`, carrying the previous
  agent, the new agent, the handoff mode and the message id where the handoff
  starts. The transcript renders it as a divider.
- The agent for the next turn is derived from the active branch: the `to` of the
  last `agentSwitch` part on the active path, or the thread's creation model when the
  path has none. Moving to a sibling branch therefore restores that branch's agent
  with no extra write. `threads.activeAgent` is only a cache of the active path's value
  for the thread list and the composer's first paint. It is rewritten when a switch
  lands or the active leaf changes, and the derived value wins if they differ.
  Regenerate uses the agent recorded on the regenerated message's path, so history
  stays reproducible.
- A switch applies to the active branch only, because its part sits on that path.
  Sibling branches keep their own agents.

### Handoff modes

| Mode | When | What the new agent receives |
| --- | --- | --- |
| `native` | the same host agent, the same folder and the same host as the saved session, and its capability report says it can load a saved session | nothing extra. It reattaches to its own session id |
| `portable` | any other switch | a handoff prompt: a summary of older turns, plus the last turns verbatim up to a budget |
| `delta` | switching back to an agent that already saw part of the thread | only the messages after the last message that agent saw, recorded on its previous `agentSwitch` part |
| `none` | the user chooses a fresh start | nothing. Labelled as a new conversation |

Rules:

- The handoff prompt marks the transcript as **data written by the user and by
  earlier agents**, not as instructions. It is quoted, and the prompt says so.
- A summary of older turns is produced by the cloud utility model through the
  gateway (`getUtilityModel`, which needs the request's service fetch, per
  `CLAUDE.md`). It runs in an action. The write is a mutation after it. Its cost
  is charged once through `chargeRound`. A host agent's switch uses no summary
  call; the desktop sends the verbatim budget only.
- The token budget is one constant, set in S2. Measure it on real threads first.
- If a `native` reattach fails, the switch falls back to `portable` and the
  `agentSwitch` part says so. It never silently starts from nothing.
- The handoff never shortens the user's own message. If the verbatim tail and the
  summary do not fit the budget, the switch fails with a clear message instead of
  cutting. Room is reserved for the attachments of the message being sent.
- Permission modes do not widen across a switch. A target that does not offer the
  source's mode falls back to the strictest mode it offers, and a new agent is never
  broader than the one it replaces.
- Text from the transcript that begins with `/` is quoted in the handoff, so no
  agent command runs because of it. Only the user's own send starts a command.

### Prompt caching across a switch

A provider's prompt cache holds an exact prefix for one provider and model, so
every switch starts cold. The first turn after a switch pays full input price for
everything it sends, and Anthropic adds a cache-write surcharge on top. The
gateway already counts this cost elsewhere: it caches the system prompt and the
last tool definition (`services/llm-gateway/src/providers/adapters/prompt-cache.ts`),
its router refuses a tier downgrade above `POLICY_THRESHOLDS.downgradeMaxContextTokens`
(20k tokens) because the re-send costs more than the cheaper tier saves
(`routing/policy.ts`), and momentum keeps a thread on one tier for the same reason
(`routing/momentum.ts`). An explicit switch overrides all of that on purpose, so it
says what it costs.

- **Cost notice on long threads.** Above the router's threshold (one shared
  constant, the same 4-characters-per-token estimate as `estimateContextTokens`),
  the switch control says that the next reply re-reads the conversation without
  the cache, with an estimate in credits for the target. Below it, no notice.
- **Above the threshold, `portable` is the default for cloud to cloud too.** The
  summary plus verbatim tail is smaller than the full history, so the cold first
  turn costs less. The user can choose "keep full history" instead. Below the
  threshold the new model gets the full history, as in S1.
- **The handoff is built once and sent byte for byte.** Its text is stored on the
  `agentSwitch` part and sits at one fixed place in the context: after the system
  prompt, before the turns that follow the switch. Every later turn sends it
  unchanged, so from the second turn on the new provider can cache the prefix.
  Nothing in it varies per turn (no timestamps, no re-summarising). Only a new
  switch builds a new handoff.
- **Switching back does not count on the old cache.** Cache lifetimes are minutes
  (5 by default, 60 with the extended TTL), so `delta` saves tokens but is priced
  in the notice like any other switch.
- **Routing never undoes a switch.** The switched-to model is what the next turns
  run on: automatic routing does not move the thread to another provider or model
  until the user switches again. S1 checks how routing treats an explicitly chosen
  model and pins it if it does not already.
- **Host agents** keep their own cache and bill their own account (roadmap trust
  rule 9). The same byte-stable rule applies to what the desktop sends as the
  handoff.

### Consent and trust

- A switch never grants consent. Switching to a host agent is a start, so it
  follows the start rules in [acp-agent-host.md](acp-agent-host.md) §3: only an
  offered pair (agent, folder) can be a target.
- A host agent's first prompt contains transcript text that may have come from
  web pages or tool output. Permission prompts on the host still apply to every
  action. The handoff text is not a permission.

### Data

- `threads.activeAgent`: optional cache of the active path's agent. Shape `{ kind: "model", model }` or
  `{ kind: "host", hostId, agentKey, folderId }`.
- Message part `agentSwitch`: `{ from, to, mode, startMessageId, fallbackReason? }`.
  Stored as one `system` row with no text in `messages`, its payload in
  `providerMetadata.neoreAgentSwitch` (the `messages` table has no `parts` column; `parts` is
  `streamDeltas`). S1 adds a checked shape for it in `agent/table-writes.ts`, the only writer, and
  tests that readers skip it (the model context) or fall back to a plain row (a marker that does not
  check). S1 writes `mode: "full"`: the new model sees the whole path, as before.
- No new table. A cloud-to-host or host-to-cloud switch that forks is recorded as a
  `threadRelationships` row with the existing `continuation` branch type; S3 checks
  that this value fits the fork, and adds a value only if it does not.

## 4. Touchpoints

- `backend/lunora/chat/http.ts` (`ChatStartBody`): the `model` field stays. A send
  with no model uses the active path's agent.
- `backend/lunora/agent/table-writes.ts`: writes the `agentSwitch` part and the
  pointer, through the thread write surface.
- `backend/lunora/chat/execute.ts`: builds the handoff context before the first
  turn after a switch.
- `backend/lunora/schema.ts`: `activeAgent` on `threads`.
- `backend/lunora/acp/`: `native` reattach and the host context call (ACP S4).
- `apps/web/src/features/chat/`: the divider, the switch control in the composer
  bar, and a disabled state while a turn streams.
- `apps/mobile/` (mobile plan §3): the same divider and the switch control, once
  mobile can start host sessions.
- `docs/security/authz-matrix.md`: a row for `switchThreadAgent`.

## 5. Slices

**S1 — Explicit switch for cloud models.** The path-derived agent and its `activeAgent` cache, the `agentSwitch` part
and the divider. No handoff yet: the new model sees the same history it always
did.
- Acceptance: a switch is recorded and rendered; the next turn uses the new
  model; switching to a sibling branch and back restores each branch's agent; a regenerate of an older message uses the model recorded on it; a double
  `clientId` switches once; a switch during a stream is refused; automatic
  routing does not change the model on the turns after a switch; a switch on a
  thread above the cache threshold shows the cost notice, and one below it does
  not.

**S2 — Portable handoff for cloud models.** Summary of older turns plus the
verbatim tail, and delta on switching back.
- Acceptance: the context sent to the model contains the handoff inside the
  budget (test with a long thread); switching back sends only messages after the
  last one the earlier model saw; the summary call is charged once and a retry does
  not charge again (an action produces the summary first, uncharged; one mutation then takes the claim-once on `switch:<clientId>`, calls `chargeRound` and writes the switch, so a failed write rolls back the claim and the charge together and a retry is not refused); a
  handoff that cannot fit fails with a message and nothing is charged; the handoff
  bytes in the context are identical on the first and the third turn after a
  switch (test), and on a provider that caches, the second turn's usage reports
  cache reads; above the threshold a cloud-to-cloud switch defaults to `portable`.
- Built in S2: above the threshold the confirm step shows the credit estimate for the handoff and for the full
  history before the divider is written (`previewAgentSwitch`, priced client-side with the target's catalog price).
  `delta` keeps what the agent saw before it left, adds the stored handoff of what happened since, and then the turns
  after; when the model's earlier divider lies outside the 100-row context window the switch is `portable` instead,
  since the context could not give the model what a delta says it already has. Each summary
  call is one metered gateway call; a retry after a failed write summarises again, but is charged (`chargeRound`) once.
  The Anthropic cache breakpoint on the handoff message and the provider's cache reads need a real provider to check.

**S3 — Host handoff.** Host to host, in the same thread, using the `portable` mode.
Cloud to host, and host to cloud, create a new thread linked to the source through
lineage, with the handoff as its first context. The runner never changes inside a
thread ([acp-agent-host.md](acp-agent-host.md) §5.1). Needs ACP S4.
- Acceptance: the host agent's first prompt contains the handoff; a host-to-host
  switch keeps the thread and its runner; a cloud-to-host switch creates one linked
  thread and leaves the source thread on its runner; a switch to a pair not in the
  offer list is refused; no consent is created by a switch (test: the offer list is
  unchanged after the switch).

**S4 — Native reattach.** Same host agent, `native` mode, when its capability
report says it can load a saved session, and only when agent, folder and host all match the saved session (otherwise the switch is `portable`). Needs ACP S6 (saved session ids).
- Acceptance: a switch to the same agent in a different offered folder, or on another host, uses `portable` and never reattaches the old session; the reattach uses the saved native session id; when the load fails,
  the transcript shows the fallback reason and the turn runs in `portable` mode.

## 6. Invariants crossed

- Claim-once on `clientId` for switches. Redelivered handoff summaries do not
  re-charge.
- `chargeRound` once for the cloud summary call. Never for host switches.
- RLS: a cloud-model switch needs a write grant, a host switch or fork is
  owner-only; the handoff is built from the thread's own rows.
- `.output()` on `switchThreadAgent`, and an authz-matrix row.
- A new message part kind goes through `agent/table-writes.ts`, not a direct
  insert.

## 7. Risks

- **Context loss.** A summary drops detail the next agent needs. Mitigation: the
  verbatim tail, and a visible "summarised" note with an option to view the full
  transcript.
- **Summary cost.** Long threads cost a model call per switch. Mitigation: switches
  reuse a stored summary until the thread grows past a threshold.
- **Cache cost.** Each switch re-sends the context uncached once. Mitigation: the
  cost notice, `portable` by default above the threshold, and a byte-stable
  handoff so only the first turn after a switch is cold.
- **Prompt injection through transcript text.** Handled by the data-not-instructions
  framing and by per-action permission prompts on host agents.
- **Confusing ownership.** After a switch, a reply has a different author. The
  divider and the per-message agent label keep it clear.

## 8. Open questions

1. **Summary model.** Recommendation: the cloud utility model, cheapest tier that
   passes the S2 quality check.
2. **Budget size.** Decided in S2: 12,000 estimated tokens (`HANDOFF_BUDGET_TOKENS`), measured on a 300-turn fixture; the reason is on the constant. The attachments of the next message are not reserved for in S2: the handoff is its own message ahead of the turns, and the user's next message is appended unchanged. A host handoff (S3), where the handoff and the first prompt are one message, reserves room then.
3. **Switching mid-stream.** Recommendation: refuse, as stated in §3.
4. **Stored summary.** Decided: stored on the `agentSwitch` part (§3, prompt
   caching), so the handoff is byte-stable; a repeat switch reuses it and
   recomputes only after the thread grows.
