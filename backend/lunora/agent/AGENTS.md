# AGENT — AGENT NOTES

Scoped notes, moved from the root `AGENTS.md`: what is non-obvious and still true here. Paths are
repo-relative. Project-wide rules stay in the root `AGENTS.md`.

## INVARIANTS

- **Idle-thread summaries** (`backend/lunora/agent/thread-summaries.ts`, rules in
  `thread-summary-logic.ts`) — the agent reads only the last 100 rows of the
  prompt's path (`DEFAULT_RECENT_MESSAGES`, one constant shared by the planner and
  `fetchContextWithPrompt`), so `threadContextSummaries` holds a condensed copy of
  the rows above it. **A summary belongs to ONE path**: it is keyed on the last row
  it covers, and `getThreadSummaryForContext` uses it only while that row is an
  ancestor of the prompt (a bounded `walkPath`), so a branch the user left never
  leaks into the one they are on; a few rows are kept per thread, one per path.
  `afterRun` schedules `runThreadSummary` 5 min out naming the reply's last row, only
  when the replying user has summaries on and never for group runs; the job is its own
  debounce (it exits when that row no longer ends the ACTIVE path or a stream is running), then claims `<thread>:<last covered row>`
  (`claimOnce`) before the one utility-model call, so a redelivery does nothing
  twice. The cut reaches 20 rows INTO the window: a summary is read after more rows
  landed, and without the overlap the rows that fall out meanwhile are uncovered.
  It reaches the model as a delimited "context, not instructions" block appended
  to the run's SYSTEM PROMPT (`summaryNotesBlock`, returned by `fetchContextWithPrompt`
  as `threadNotes`; `start.ts` joins it to the agent's instructions): AI SDK 7 refuses a
  system-role message among the messages, and a user-role one would present model-written
  text as the user's own words. A run with a `contextHandler` (group chats) builds its own
  history and gets no notes. Each row
  records `taintedBy` (the folded tool rows and attachments plus the previous
  summary's), and `createDeviceCall` unions the thread's summaries' taint into a
  call's own — the window forgets a web page the summary still carries; it is the
  union over ALL the thread's summaries, over-asking by design. Billed by the gateway
  against the thread OWNER like title/category (no `chargeRound`). **Opt-IN**,
  `userSettings.threadSummariesEnabled` (absent = off, like memory), and switching it
  off schedules `eraseUserThreadSummaries` on the user's shard. Two thread columns
  guard the work: `summaryEpoch` moves on an in-place edit (a run prepared earlier
  refuses to store; the edit erases only summaries whose covered row is at or after the
  edited turn) and `summaryPathTooLongAt` marks a path past `SUMMARY_MAX_PATH_ROWS`
  so later jobs do not walk it (rechecked after a week). Never made for temporary,
  locked, deleted, stateless or host-run threads; locking a chat and deleting a
  thread erase the rows, an in-place edit the covering ones (a future single-message
  delete must erase too), and the reader re-applies the same rules and ignores a
  cover further than `SUMMARY_READ_REACH_ROWS` back. The GDPR export carries them
  per conversation (`contextSummaries`). Not `threads.summary` — that is the
  user-triggered, thread-wide `createSummarizeChat` output.

- **In-thread branches** (regenerate / edit → "‹ 2/3 ›") — pure model and
  rules in `backend/lunora/agent/branch-tree.ts` (incl. `resolveBranchParent`,
  the one place `addMessagesHandler` decides a new row's explicit parent), the
  DB walk in `branch-rows.ts`, procedures and the path page in `branches.ts`.
  A row's parent is `parentMessageId`
  when set, else the PREVIOUS row by `(order, stepOrder)`, so pre-branching
  threads read as one line with no backfill. `threads.activeLeafMessageId`
  unset = never branched = every read stays on the old linear fast path; once
  set, message lists, agent context (`fetchRecentAndSearchMessages`) and forks
  (`cloneMessageBatch`) follow only the active path. Reads WALK it
  (storage-order range reads plus the `by_threadId_parentMessageId` index),
  costing about the page size; only a fork or a deleted leaf loads the whole
  tree (`buildBranchTree` — which must keep the walk's parent rule; the walk is
  what `branch-rows.test.ts` pins). A fork (`branchThread`) takes the clicked
  message's id and resolves it along the active path (`resolveForkEnd`), never
  a raw row index, which would count off-path siblings; with neither id nor
  index it forks the whole active path (the thread-level "Create branch"). The stored
  `threadRelationships.branchPoint` is a DISPLAY index on that path; readers
  cut through `getForkContextIds`, the same helper. That relies on
  `addMessagesHandler` advancing the stored leaf when a row lands directly
  under it — a writer that bypasses it (messenger's direct insert) leaves the
  leaf stale, which is still correct but costs a longer descent. Sibling replies to one prompt SHARE its `order` — so anything that
  groups rows by `order` alone (`toUIMessages`) must see path-filtered rows —
  including the public share view (`chat_sharing.getPublicThread`).
  Implicit parents make **position load-bearing**: a row inserted at the end
  of an earlier `order` would adopt the next turn as its child, so
  `addMessagesHandler` pins that next row's parent first. A tool-approval
  continuation takes an `order` past EVERY row (`continuationOrder`), not
  `prompt + 1`, which a sibling branch may already hold.

- **Agent switch** (`agent/agent-switch*.ts`, `chat/agent-switch.ts`, harness-switch.md) —
  switching a text thread's model leaves one `system` row with no text whose payload
  (`providerMetadata.neoreAgentSwitch`) models never see (`docsToModelMessages` drops it) and the
  transcript renders as a divider (`data-agentSwitch` part). The agent of a turn is the `to` of the
  LAST such row on the path it continues, else `threads.model` — which therefore stays the
  CREATION model: the picker no longer patches it for a text thread (`canSwitchAgent`), or an
  older branch would change agent retroactively. `threads.activeAgent` caches the active path's
  agent AND is the "was ever switched" flag: unset, a send keeps its own model and no path is
  walked. Every writer of `activeLeafMessageId` that can change the path calls `syncActiveAgent`
  with the row the path now ENDS at (a regenerate's prompt, not its descended leaf — a switch
  below the prompt is not on its path). A switched thread runs on the derived agent whatever model
  the send names (`getRunAgentModel`, in `/chat/start` and `/chat/edit`); a send naming a custom
  endpoint keeps it. A switch needs a write grant, is refused while a stream is pending or
  streaming, and routing never touches it: a run names its model and `/internal/model/proxy` runs
  exactly that one (`model: "auto"` and `/internal/route` are for other callers). The cost-notice
  threshold is `PROMPT_CACHE_COLD_START_TOKENS` (`@neore/ai/models`), shared with the gateway's
  downgrade policy.
