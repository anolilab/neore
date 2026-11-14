# SUB AGENTS — AGENT NOTES — REFERENCE

The rules are summarized in `backend/lunora/sub-agents/AGENTS.md`, which agents load automatically; this file holds the
detail. Paths are relative to `backend/lunora/`.

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
    only while its token is current. A release supersedes the pending check only if it moves the time forward;
    otherwise it schedules nothing. Nothing is cancelled, so a rolled-back release leaves the old check in place. The
    backed-off recheck covers an expiry.
- Every end goes through `finishRun`, so a resumed run's live continuation stops too (`liveContinuationOf`).
