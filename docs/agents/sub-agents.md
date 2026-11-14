# SUB AGENTS — AGENT NOTES — REFERENCE

The rules are summarized in `backend/lunora/sub-agents/AGENTS.md`, which agents load automatically; this file holds the
detail. Paths are relative to `backend/lunora/`.

## WHO A CHILD WAITS FOR

- **A one-shot child pauses for approval** when the owner's chat or a task started its chain (`sub-agents/execute.ts`,
  `pauseForApproval` for every non-worker run outside an eval's chain). The task round itself still drops its own `ask`
  tools: only the child it delegated to can wait, because the parent's delegate call returned at admission. A task round
  has `delegateToSubAgent` only when its owner set the tool to `auto` (a headless run drops `ask`).
  - **Who cannot start a chain**: a trigger run gets no tools, or only the bot's shell and file tools
    (`triggers/execute.ts`); a messenger reply's tool groups never include sub-agents (`messenger/lib/reply-tools.ts`);
    an outside agent's run turns the sub-agent tools off (`chat/lib/tool-permissions.ts`). A trigger still names itself
    on the chain, so the rule below holds if its tools ever widen.
  - **An eval's chain never waits** (`chainSource` `eval:<resultId>`, `chainPausesForApproval`): an eval measures one
    headless answer, so its child refuses an `ask` tool as any headless run does.
  - **One waiting child per source.** Each task or trigger run starts a fresh thread, so the per-thread cap of 3 never
    fills across runs. The run names its source (`runHeadlessAgent({ chainSource })` → `ToolCtx.chainSource` →
    `subAgentRuns.chainSource`, `task:<taskId>` / `trigger:<triggerId>`), a nested child inherits it, and while a run of
    that source is `awaiting` (`by_chainSource_and_status`) its next delegation is refused with `chainWaitProblem`, which
    the delegating run reads as the tool's error. Runs a single round admits before any of them waits can all wait (at most
    3, the per-thread cap). The pause's snapshot does not keep the source: a resumed child's own sub-agents fall back to
    the per-thread cap. A chat-started chain has only the per-thread cap.
  - **The owner is told** by the pause itself: `recordPendingToolApprovals` writes a `tool_approval` (or `ask_user`,
    `secret_request`) notification to the child thread's owner, linking to the child's thread, plus the phone push and the
    four-hour reminder; the dedupe key is the approval id. A sub-agent's pause names who started its chain in the body
    (`chainStarterLabel`: "a task", "a trigger", else the dispatch source); the owner's own chat adds none.
  - **Where it shows**: the child's thread (answer there), the parent conversation's `listSubAgentApprovals` card (the task
    run's thread), and the bell. The snapshot keeps `dispatchOrigin`, so an answered child still dispatches as the task's
    unattended origin, not as the lead.
  - **Tasks are not held.** The round ends on its own answer (`completeRound`), the recurrence sweep reads only the task's
    own status, so the next slot runs as usual; the child's result posts back to the round's thread when it ends
    (`postRunResult`).
  - **Timeout**: the request's own expiry (`PENDING_APPROVAL_TTL_MS`, 7 days) reaps the run with
    `SUB_AGENT_APPROVAL_EXPIRED_MESSAGE`, posted back to the parent.

## LIFECYCLE

- **A new message in a child ends its wait.** The send (`chat/http.ts`, `afterSave`) calls `afterOwnerMessage` after the
  save and its claim, for every content type and for a resend. A send that starts a new thread skips it.
  - The call runs in its own transaction, once per send, also when the stream or run fails after the save. A failed
    call is retried once (`AFTER_SAVE_RETRY_MS`), so it never fails the send.
  - `endApprovalWaits` reads the child's waiting runs and the latest turn's open requests, with no pending-row
    history. A run ends only when none of its requests is still open on that turn, so a wait its continuation started
    again stays.
  - The same call releases the results held for the thread (`releaseHeldResults`). It isn't gated on a pending request,
    because the send itself may have just closed one (`discardPausedThreadSecrets`).
- **A hard delete ends the thread's runs** (`endSubAgentRunsOfDeletedThread`, on `agent/threads.ts`'s first page):
  - It sets the thread's `deletingAt` first. From then on a going thread takes no post (`isGoneParent`), admits no new
    run (`admitCommon`, "This chat is being deleted."), and its worker queue starts nothing (`startNextWorkerRun`, with
    `claimQueuedRun` as a backstop; a worker whose row is already gone starts nothing either).
  - The mark holds for an hour (`isGoingThread`, `DELETING_HOLDS_MS`). A chain that fails or is abandoned has no hook to
    clear it, so past that the thread is live again.
  - It marks every unposted result bound for the thread `postFailed`, and cancels its worker queue newest first. Both
    are paged, with a continuation past a per-call bound (`markDeletedThreadResults`, `cancelDeletedThreadQueue`).
  - It ends the runs the thread is the child of first, so the Stop path then reaches what that child delegated. Then it
    ends what the thread delegated, including worker messages the user typed, which a Stop leaves alone
    (`delegatedTree`'s `withTyped`).
  - The tree reads one page per status, so the rest of what the thread delegated ends in batches of 100 with a
    continuation (`cancelDeletedThreadDelegated`), scheduled only after a pass that ended something. Before then, a
    queued run of a going or missing lead is refused at claim (`claimQueuedRun`, `isLeadGoing`). A worker's line stops
    at such a run (`startNextWorkerRun`), so the refusal doesn't walk the line.
- **A result waits while its parent has a request its owner can still answer** (pending, unexpired, and open on the
  parent's latest turn; `waitsOnOpenRequest`), as well as while the parent's one-shot run goes.
  - An answer (`resumeClaimedRun`) or a send releases it.
  - The run records the token and due time of its current post check (`postCheckId`, `postCheckAt`), and a check acts
    only while its token is current. A release supersedes the pending check only if it moves the time forward, or if
    the check is more than a minute overdue (it may have been deferred or dead-lettered); otherwise it schedules nothing. Nothing is cancelled, so a rolled-back release leaves the old check in place. The
    backed-off recheck covers an expiry.
- Every end goes through `finishRun`, so a resumed run's live continuation stops too (`liveContinuationOf`).
