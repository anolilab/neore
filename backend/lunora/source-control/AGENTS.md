# SOURCE CONTROL — AGENT NOTES

## INVARIANTS

- **Develop review** (`backend/lunora/source-control/`, develop-mode.md) — the draft is the
  `reviewDrafts` row, server-side so a reload or second device sees it. `submitReview` claims it
  first (`submittingAt`, a 60 s lease; edits are refused meanwhile), posts ONE host call, and
  clears the draft only on a confirmed review (`submit-review.ts` fixes the order). The claim
  returns its `submittingAt` as a lease token: finish and release act only while the row still
  holds it, and a finish that fails after the host accepted is still `ok`. A 401 on a write gets
  one token renewal and one retry (the host did nothing); no other write is repeated. A refusal
  keeps it (`rejected`, the host's reason is untrusted text); an answer that never came is
  `unconfirmed` — the host may hold the review, so the UI says to look there before resubmitting.
  Comment lines mean something only on the commit the reviewer saw, so a draft with comments
  refuses edits on a newer head (`head_moved`). A reply and a resolve are written at once (the
  review call has no place for a reply). Viewed marks are the host's, read and written through
  GraphQL; a write is never redirected or replayed by the requester.
  **Guides** (`guide-*.ts`, table `pullRequestGuides`): a model's or an agent's answer is INPUT, never
  structure. `assembleGuide` (pure) decides the order (core, dependents, mechanical, not covered), which files are
  mechanical (by name, not the model's say-so), that every changed file lands somewhere, which line ranges exist in
  the diff, and which proposals survive (a comment on a diff line, a label). Applying a comment only writes the
  review DRAFT (`saveDraftCommentFor`); a label has no write. Prompts quote host text with the optimizer's `toJson`
  inside one JSON evidence block. The cloud job runs on the jobs queue under `runJobOnce` (charged to the daily text
  quota); a host guide is a coding-agent turn in the user's checkout, started by ONE transaction (`beginHostGuide`:
  guide row, session, prompt; a refusal throws so none of it stays) and finished by `endHostTurn` →
  `settleHostGuide` → `finalizeHostGuide`, which re-reads the diff and refuses an answer for another head
  (`head_moved`). The host prompt is capped in BYTES of the signed call's JSON (`hostPromptBytes`), not characters.

- **Develop freshness** (`backend/lunora/source-control/freshness*.ts`, `webhook.ts`) — the user
  CHOOSES the repositories (`watchedRepositories`, max 20); only those are polled, through the shard tick
  (`dispatchDueRepoPolls` in `runShardTick`, plus `shardSweeps()` as backstop), never a global loop.
  A row is leased by moving `nextPollAt` out; `recordRepoPoll` applies the answer only while the poll's
  `leasedAt` still matches, so an unwatch (row deleted) or a redelivery records and notifies nothing.
  Polling reads `GET /repos/{o}/{r}/pulls` with `If-None-Match` (`HostRequestOptions.ifNoneMatch` is the
  one place a 304 resolves instead of throwing); the login is stored on the row so an unchanged poll is
  ONE request. The first poll is a silent baseline. The webhook route is `onRoutedShard(…, "watch", id)`;
  the handler never parses the body and `acceptWatchDelivery` only sets `dirtyAt` — keep it that way, what
  changed is read from the host with the user's token. `review_request` notifications dedupe on
  origin + repo + number + the pull request's `updated_at`.

- **Agent pull request tools** (`pr-agent*.ts`, `check-log.ts`, `chat/tools/pull-request.ts`) — an agent acts only on a
  pull request LINKED to its thread (`linkedPullRequestsOfThread`); anything else is refused before any host call, and
  the run offers the tools only to a thread that has a link (`buildAgentTools`). Calls use the person's own connector
  token. A job log is a redirect to a signed storage address: the requester answers it (`redirect: "return"`), and
  the driver fetches it WITHOUT the token, only on `isLogAddress` origins, tail only, excerpt capped
  (`LOG_EXCERPT_MAX_CHARS`). Reads are Auto; reply and re-run are Ask by default; merge is in
  `BUILTIN_TOOLS_NEEDING_A_PERSON` with `needsApproval: true` hard-coded, so no override, grant or headless run skips
  the person, and it merges only the head the approved call names.
