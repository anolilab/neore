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

- `switchThreadAgent({ threadId, target, clientId })`, an owner-only mutation.
  `target` is a cloud model id, or an offered (agent, folder, host) pair from the
  ACP host's offer list. A host target on a cloud thread, or a cloud target on a
  host thread, returns `forked: <threadId>` and creates the linked thread instead.
  `clientId` makes it claim-once (scope `switch`), so a double tap switches once.
- Refused while a turn in the thread is streaming. The user waits, or stops the
  turn first. This is a hard rule, so a transcript never has two agents writing
  at once.
- The switch writes one message part, kind `agentSwitch`, carrying the previous
  agent, the new agent, the handoff mode and the message id where the handoff
  starts. The transcript renders it as a divider.
- The thread row gets one optional field, `activeAgent`, the agent for the next
  turn. The part is the record; the field is the pointer. Regenerate uses the agent
  that was active when the regenerated message was written, so history stays
  reproducible.
- A switch applies to the active branch only. Sibling branches keep their own
  agents.

### Handoff modes

| Mode | When | What the new agent receives |
| --- | --- | --- |
| `native` | the same host agent, and its capability report says it can load a saved session | nothing extra. It reattaches to its own session id |
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

### Consent and trust

- A switch never grants consent. Switching to a host agent is a start, so it
  follows the start rules in [acp-agent-host.md](acp-agent-host.md) §3: only an
  offered pair (agent, folder) can be a target.
- A host agent's first prompt contains transcript text that may have come from
  web pages or tool output. Permission prompts on the host still apply to every
  action. The handoff text is not a permission.

### Data

- `threads.activeAgent`: optional. Shape `{ kind: "model", model }` or
  `{ kind: "host", hostId, agentKey, folderId }`.
- Message part `agentSwitch`: `{ from, to, mode, startMessageId, fallbackReason? }`.
  The `parts` column is `v.array(v.any())` (`backend/lunora/schema.ts`), so the
  database takes the new part with no schema change. S1 adds a checked shape for it in
  `agent/table-writes.ts`, the only writer, and a test that a reader skips unknown
  part kinds.
- No new table. A cloud-to-host or host-to-cloud switch that forks is recorded as a
  `threadRelationships` row with the existing `continuation` branch type; S3 checks
  that this value fits the fork, and adds a value only if it does not.

## 4. Touchpoints

- `backend/lunora/chat/http.ts` (`ChatStartBody`): the `model` field stays. A send
  with no model uses `activeAgent`.
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

**S1 — Explicit switch for cloud models.** `activeAgent`, the `agentSwitch` part
and the divider. No handoff yet: the new model sees the same history it always
did.
- Acceptance: a switch is recorded and rendered; the next turn uses the new
  model; a regenerate of an older message uses the model recorded on it; a double
  `clientId` switches once; a switch during a stream is refused.

**S2 — Portable handoff for cloud models.** Summary of older turns plus the
verbatim tail, and delta on switching back.
- Acceptance: the context sent to the model contains the handoff inside the
  budget (test with a long thread); switching back sends only messages after the
  last one the earlier model saw; the summary call is charged once and a retry does
  not charge again (claim-once on `switch:<clientId>` before `chargeRound`); a
  handoff that cannot fit fails with a message and nothing is charged.

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
report says it can load a saved session. Needs ACP S6 (saved session ids).
- Acceptance: the reattach uses the saved native session id; when the load fails,
  the transcript shows the fallback reason and the turn runs in `portable` mode.

## 6. Invariants crossed

- Claim-once on `clientId` for switches. Redelivered handoff summaries do not
  re-charge.
- `chargeRound` once for the cloud summary call. Never for host switches.
- RLS: a switch is owner-only; the handoff is built from the owner's thread.
- `.output()` on `switchThreadAgent`, and an authz-matrix row.
- A new message part kind goes through `agent/table-writes.ts`, not a direct
  insert.

## 7. Risks

- **Context loss.** A summary drops detail the next agent needs. Mitigation: the
  verbatim tail, and a visible "summarised" note with an option to view the full
  transcript.
- **Summary cost.** Long threads cost a model call per switch. Mitigation: switches
  reuse a stored summary until the thread grows past a threshold.
- **Prompt injection through transcript text.** Handled by the data-not-instructions
  framing and by per-action permission prompts on host agents.
- **Confusing ownership.** After a switch, a reply has a different author. The
  divider and the per-message agent label keep it clear.

## 8. Open questions

1. **Summary model.** Recommendation: the cloud utility model, cheapest tier that
   passes the S2 quality check.
2. **Budget size.** Measure on real threads in S2; no value is fixed here.
3. **Switching mid-stream.** Recommendation: refuse, as stated in §3.
4. **Stored summary.** Recommendation: store it on the `agentSwitch` part, so a
   repeat switch reuses it, and recompute only after the thread grows.
