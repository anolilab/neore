# Password-protected (locked) threads — design note

Status: **implemented, with known gaps** (see "Implementation status" at the end).
The server refuses a locked chat's content at its choke points; the paths that
are still open are listed under "Known gaps", not treated as done.
A client-only lock would be security theatre and is not what shipped.

## What the user gets

The owner sets a passcode on a thread. A locked thread's content (messages,
title, preview, documents, streams) is unavailable until the passcode is
entered in the current session.

## Threat model (what the feature does and does not do)

- **Protects against:** someone using an already-signed-in browser or device
  that is not the owner's own working session (a shared machine, a family
  laptop, a colleague at an unlocked desk).
- **Does not protect against:** the operator or the server (the data is
  readable by the backend, the database and anyone with infrastructure
  access); an attacker who knows the passcode; a compromised account session
  that can call the API (it can ask for the unlock); anyone who already read
  the content before the lock was set; memories or titles derived from the
  content that were stored elsewhere before the lock.
- **Not end-to-end encryption, and not encryption at rest.** The UI copy and
  docs must say so.
- **Recovery:** there is none. A forgotten passcode can be cleared only by
  deleting the thread. This is the honest rule; a reset path would have to
  destroy content and is an open question below.

## Inventory of read and write paths

These are the paths that can expose a thread's messages, title or preview.
File references were checked by grep and reading the surface; the list is
not exhaustive for the long tail of tool files under `chat/tools/`.

### Direct message and thread reads (client-reachable)

| Path | Where | Gate needed |
| --- | --- | --- |
| Message pages and UI messages | `agent/messages.ts`, `chat/functions.ts#getThreadUIMessages` | Refuse without unlock |
| Thread read | `chat/functions.ts#getThread`, `agent/threads.ts` | Refuse, or return only the generic shape |
| Thread list and titles (sidebar, search results, pins, tags, groups, categories, trash) | `chat/functions.ts#getThreads`, `chat/pins`, `chat/tags`, `chat/group`, `agent/threads.ts` | Project to "Locked chat" when locked and not unlocked |
| Branches and paths | `agent/branches.ts`, `agent/branch-rows.ts`, `agent/branch-tree.ts` | Refuse without unlock |
| Forks (`branchThread`, `cloneMessageBatch`) | `agent/branches.ts`, `workflow/fork.ts` | Require unlock; decide whether the fork inherits the lock |
| Composite view | `chat/composite.ts` | Refuse without unlock |
| Documents and canvas artifacts | `agent/documents.ts`, `chat/tools/create-document.ts`, `update-document.ts`, `create-design.ts`, `update-design.ts` | Refuse without unlock |
| Followup suggestions | `chat/execute.ts` (schedules `generateFollowupSuggestionsForThread`), `followupSuggestions` table | Refuse read; skip generation while locked |
| Streaming chunks and persistent streams | `chat/streaming/persistent/library.ts#getChunksAfter`, `chat/streaming/persistent/http-api.ts` and root `http.ts` (`/chat/chunks`), `agent/streams.ts`, stream token (30 min HMAC) | A token minted before the lock must stop working on read |
| Resume | `chat/resume.ts` | Refuse without unlock |
| Edit-abandon and media-abandon | `chat/edit-abandon.ts`, `chat/media-abandon.ts` | Background; must not write content into a locked thread without a claim |
| Translate and autocomplete | `chat/translate.ts`, `chat/autocomplete.ts` | Refuse without unlock (they read a message or the prefix of one) |
| Link preview | `chat/link-preview.ts` | Reads a URL from a message: refuse without unlock |
| Slides | `chat/slides/functions.ts`, `chat/slides/internal.ts` | Refuse without unlock |
| Vault files linked to a thread | `vault/functions.ts`, `agent/files.ts`, `lib/storage-ref.ts`, `agent/display-media.ts` | Signed URLs for attachments must not be issued for a locked thread without unlock |

### Sharing and public surfaces

| Path | Where | Gate needed |
| --- | --- | --- |
| Share link creation and toggle | `chat/sharing.ts`, `agent/sharing.ts` | Refuse to share a locked thread, or require unlock |
| Public share view | `chat/sharing.ts#getPublicThread` (action), `chat/lib/public-thread.ts` | Refuse for a locked thread (no unlock proof on the anonymous path) |
| Collaborator access (`threadAccess`) | `chat/sharing.ts`, `agent/thread-read-access.ts` | Grantees need the passcode too, or grants are refused |
| Thread export (JSON, TXT, PDF download) | `chat/functions.ts#getFullThreadForExport` (`authQuery`, line ~2461), called from `apps/web/src/features/chat/thread-list/hooks/use-thread-handlers.tsx` | Refuse without unlock |
| Live queries (subscriptions to any read above) | `apps/web` `crpc` live queries (`lib/lunora/live-queries.ts`); the subscription's args carry the proof | See "Unlock proof": a token in args changes the query key, and expiry does not end a subscription by itself |
| Public v1 API and CLI | `public-api/routes.ts` (`/threads`, `/threads/{id}`, `/threads/{id}/messages`, `/chat/stream`), `apps/cli` | Keys have no unlock path, so they must refuse locked threads entirely |

### Search and retrieval

| Path | Where | Gate needed |
| --- | --- | --- |
| Text search over threads and messages | `chat/functions.ts#searchThreads` (~line 2122), `chat/functions.ts#searchMessages` (~line 2204), `agent/threads.ts#searchThreadsByTitleAndSummary`, `agent/messages.ts#searchMessages` | Exclude locked threads (no match on title, summary or content) |
| Vector / semantic search | `agent/vector/index.ts` (`searchVectors`, `threadId` filter is optional, line ~148–159), `agent/vector/tables.ts` | Exclude locked threads at query time (Vectorize metadata filter) or at index time; a query without `threadId` returns other threads' hits |
| Knowledge retrieval | `knowledge/retrieve.ts`, `chat/tools/knowledge-search.ts` | Only when a locked thread's files are attached |
| Memory retrieval and "memories used" | `memory/retrieve.ts`, `memory/functions.ts`, `messages.retrievedMemories` | Memories derived from a locked thread must not be injected into other threads |

### Background and system readers (no user proof)

These run on the scheduler or queue, so they have no unlock proof. They must
check the lock themselves, and the rule is "skip while locked".

| Path | Where | Gate needed |
| --- | --- | --- |
| Memory extraction after each reply | `memory/extract.ts#extractMemories`, scheduled from `chat/execute.ts` (afterRun) | Skip locked threads; decide what happens to memories made before the lock |
| Memory reflection and compression | `memory/reflection*.ts`, `memory/compress.ts` | Same rule |
| Title and category jobs | `chat/functions.ts#createTitleChat` (line ~1347) and `#createCategoryChat` (~1422), scheduled from `chat/http.ts` (`/chat/start`) via `chat/lib/start-title-jobs.ts#startTitleJobs` | Skip for locked; the title is generated from the first prompt, so it can hold content |
| Daily Brief | `notifications/daily-brief.ts` (reads `home/overview.ts` `recentThreads` titles, sends them to the model and to push) | Exclude locked threads from the brief, and the titles must never reach it |
| Notifications and push text | `notifications/notify.ts` (`title` is the subject, often the thread title), `notifications/push.ts`, `notifications/functions.ts` | Redact thread titles and content for locked threads |
| Home overview | `home/overview.ts` (`recentThreads` titles, approval `threadTitle`, task titles) | Project to "Locked chat" |
| Sub-agent post-back | `sub-agents/functions.ts#postRunResult`, `sub-agents/execute.ts` | Refuse to post into or out of a locked thread |
| Tasks and triggers | `tasks/*`, `triggers/*`, `chat/execute.ts`, `chat/lib/headless-run.ts` | A task or trigger linked to a locked thread must not read its content in background |
| Messenger | `messenger/*` (14 files, reply path reads thread context) | A locked thread is not a messenger target |
| GDPR export and deletion | `gdpr/steps/*`, `agent/gdpr.ts`, `memory/gdpr.ts`, `knowledge/gdpr.ts`, `pages/gdpr.ts` | Export includes content: needs a decision (see open questions). Deletion must still work |
| Usage rollups | `usage/*` | Counts only; confirm no thread titles in per-skill breakdowns |
| Evals | `evals/execute.ts` | Eval threads are not user threads; no change expected |
| Coding agents and devices | `coding-agents/*`, `devices/*` | A run that reads a locked thread's messages must be refused |

### Write paths that touch a locked thread

| Path | Gate needed |
| --- | --- |
| `chat/start` and new messages | Refuse without unlock proof |
| Streams (`runStreamingAgent`, background jobs on the queue) | Enqueue only with unlock; a queued job must re-check the lock before writing rows |
| Agent continuations (tool approval, ask-user) | Refuse without unlock |
| Imports into a locked thread | Refuse |
| Messenger inbound into a locked thread | Refuse |

## Proposed design

### Data

- Thread fields: `lockedAt` (optional number), `passcodeHash` (string,
  optional) and `passcodeSalt` (string, optional). The hash never leaves the
  backend and is never logged.
- Hash: PBKDF2-SHA256 through WebCrypto (no new dependency), salted,
  compared with `lib/crypto.ts#timingSafeEqual`. **Verify the iteration cap
  of the pinned workerd before choosing the count**: Workers has historically
  capped PBKDF2 iterations at 100,000, and a higher count throws
  `NotSupportedError` at runtime, not at compile time.

### Unlock proof

- `unlockThread(threadId, passcode)` verifies the passcode, then returns a
  short-lived token `{threadId, userId, expiresAt}` signed with HMAC under a
  new server secret. The client keeps it in memory only, never in
  `localStorage`. It is sent as an argument to gated reads and writes.
- Reload or idle timeout clears it, so the thread re-locks.
- The proof is verified on every gated call (a mutation or an action, or an
  authQuery that does not depend on the clock).
- **Live queries.** A live query re-runs only when a write touches a table it
  read (CLAUDE.md, `live-queries.ts`), never on a timer. So an expired proof
  keeps a subscription streaming until something writes. Expiry therefore
  needs a deliberate mechanism: the client drops the subscription when the
  proof expires, and re-lock writes a row that bumps the thread, so every
  live reader re-runs and is refused. A token in the args also changes the
  query key, so each refresh opens a new subscription (the cap is 32 per
  socket, `TOO_MANY_SUBSCRIPTIONS`). Reading `Date.now()` inside a query is
  what `nondeterministic_query_mutation` flags, so the expiry check cannot
  simply live in a query.
- A stream token minted before the lock must be re-checked on
  `/chat/chunks`, not trusted for its 30 minutes.

### Rate limit

- `@lunora/ratelimit`, keyed per user and thread, with exponential backoff
  after repeated failures. Mirror the existing limiters in `file.ts` and
  `connectors/`.

### Choke points (proposed)

1. **Read admission.** `resolveThreadReadAccess` (and `requireOwnedThread`,
   `requireThreadPermission`) gain a lock check after the ownership and grant
   decision. A locked thread without a valid proof returns the generic "not
   found" error that the access helpers already use. This covers the message
   and thread reads that go through admission.
2. **Projection.** One helper turns a thread row into a locked stub
   (`Locked chat`, no title, no preview, no summary). Every list and
   notification path calls it. This is the largest part of the work: at least
   eight files.
3. **System readers.** A single `isThreadLocked` check in each background
   reader (memory extraction, followup generation, brief, sub-agent post-back,
   tasks and triggers). This is the easiest path to forget.
4. **Public and API surfaces.** Refuse locked threads on the anonymous share
   view and on API keys (no unlock path there).
5. **Vector search.** Filter locked threads out at query time, or drop their
   vectors at index time when a thread is locked.

### Why this is not a single choke point

`resolveThreadReadAccess` decides who may read a thread, but it does not
decide what a list, a notification, a background job, a vector query or a
share link shows. Those read rows directly through RLS (the owner policy
returns the whole row, title included) or through `systemDb`. Making the lock
hold therefore means touching about 25 files and adding a background-job rule
to each, which is past the ~10-file limit set for this feature.

## Estimated size

- Backend: schema fields, unlock and proof module, rate limit, choke-point
  checks in about 8 read helpers, projection helper, background checks in about
  8 jobs, public-API and share refusals, vector filter. Roughly 1,200 lines
  including tests.
- Frontend: passcode dialog (lingui, accessible, focus trap), lock icon and
  generic row, in-memory proof store, re-lock on idle and reload. Roughly 500
  lines.
- Tests: hashing and verify, token sign, verify and expiry, one refusal test
  per gated path, rate limit, and a guard test that every new read of
  `threads.title` goes through the projection.

Suggested phasing: (1) lock state, unlock, the read admission check, the chat
and stream refusals and the projection of lists and home; (2) background
readers, notifications and the Daily Brief; (3) vector search, sharing, the
public API and GDPR export.

## Open questions

1. **Recovery.** Is "delete the thread to clear the lock" acceptable, or do
   we need an owner-only reset that destroys content but keeps the thread?
2. **Memories made before the lock.** Purge memories whose source is a locked
   thread, or keep them but never inject them into other threads?
3. **Collaborators.** Does a grantee need the passcode, or is a locked thread
   simply not shareable?
4. **Forks.** Does a fork of a locked thread inherit the lock?
5. **GDPR export.** Decided: **included**. The owner's export carries a locked
   chat's title and every message, with no proof, because the export is the
   owner's own data-access right and is authenticated and rate-limited. The lock
   protects against a signed-in browser, not against that right. Erasure still
   deletes them (`gdpr/steps.ts`, `gdpr/collect-conversations.test.ts`).
6. **Group chats.** One passcode per thread, or per participant?
7. **Server secret.** Which secret signs the proof, and how is it rotated?
8. **Live-query expiry.** Client-side drop plus a re-lock bump, or a shorter
   subscription lifetime? Either way the expiry check cannot use `Date.now()`
   inside a query.
9. **PBKDF2 cap.** The iteration count the pinned workerd accepts (see the
   Data section). This is unverified.

## Implementation status

### Decisions taken

- **Storage:** `threads.lockedAt` (optional, in `vThreadDocFields`) marks a locked
  chat. The passcode hash, salt, iteration count, epoch and failure/backoff state
  live in the shard-local `threadPasscodes` table, RLS owner-scoped, erased with the
  account (`chat/gdpr.ts`) and with the chat (`agent/threads.ts`, permanent delete).
- **Credential:** PBKDF2-SHA256, WebCrypto, 16-byte random salt per passcode,
  `timingSafeEqual` on the derived key. **Iterations: 600,000**, stored per row.
  Probed on the pinned workerd (`1.20260918.1`): 100,000 / 600,000 / 1,000,000 are all
  accepted (~0.09 s / ~0.6 s / ~1.2 s), so the runtime cap is well above 100,000. Not probed:
  `1.20261006.1`, which is also in the lockfile.
- **Proof:** `thread-unlock\n{threadId}\n{userId}\n{epoch}\n{expiresAt}` HMAC-SHA256
  under `STORAGE_SIGNING_SECRET` (domain-prefixed; no new secret). Token
  `{threadId}:{userId}:{expiresAt}:{hmac}`, 30 minutes. Lock, change and "lock now"
  rotate the epoch, so every outstanding proof stops working at once.
- **Client:** proof in memory only (`lib/lunora/unlock-proofs.ts`), injected into every
  cRPC call, mutation, `useAction` and live subscription that names a thread. Dropped after
  15 minutes idle, on expiry, on a reload, and when the signed-in user changes.
- **Recovery:** none. A forgotten passcode can only be cleared by deleting the chat.
- **Shape of a lock:** owner-only. A locked chat takes no grants and no public view, and
  sharing or publishing a locked chat is refused.
- **Failure accounting:** a wrong passcode is a RESULT (`ok: false`), not a thrown error,
  so the failure count commits. Backoff: free for 4 failures, then 30 s doubling, capped at 1 h.
  A per-user `threadLock/unlock` rate-limit family sits on top.
- **Refusal:** a content read without a valid proof fails `FORBIDDEN` with
  `data.code = "THREAD_LOCKED"`. Admission (`resolveThreadReadAccess`) returns
  `{ kind: "locked" }` to the owner. Callers that do not pass a proof are refused,
  which is the fail-closed default.

### Paths: choke point and test

| Path | Choke point | Test |
| --- | --- | --- |
| Admission (every helper: `resolveThreadReadAccess`, `requireThreadPermission`, `requireOwnedThread`) | proof check in `agent/thread-read-access.ts` | `agent/thread-lock.test.ts` |
| Reply text edit (`editAssistantReply`), branch switch (`switchBranch`) | `requireOwnedThread(…, unlockProof)` | `agent/thread-lock.test.ts` (edit refused: no proof, expired, older epoch) |
| Composite thread view (`getThreadWithData`) | admission + `throwThreadLocked` | `chat/thread-lock.gates.test.ts` |
| Thread and message reads, branches, streams, documents, files, knowledge, variables, projects | proof-aware admission (agent group) | `agent/thread-lock.gates.test.ts` |
| Lists, titles, search (text and vector), GDPR list | `toLockedThreadStub`; locked hits removed from results | `agent/thread-lock.gates.test.ts` |
| `/chat/chunks`, `/chat/start`, regenerate, edit, media | refused with 403 `THREAD_LOCKED`; stream of a locked chat refused | `chat/thread-lock.gates.test.ts` |
| Public share and public token reads | locked chats cannot be public; `readPublicThread` refuses non-public | `chat/sharing.ts` toggle refused (code); no test |
| Public v1 API (`getThread`, `listThreads`, `listMessages`, stream poll) | `notFoundIfLocked`; locked chats omitted from lists | `public-api/thread-lock.test.ts` |
| Memory extraction after a reply | skip (`isThreadLockedForMemory`) | none (code only) |
| Sub-agent and coding-agent post-back into a locked parent | skip | none (code only) |
| Messenger reply claim | refused (`claimThreadReply`) | none (code only) |
| Notifications: write (`notify`) and inbox read | redacted to "Locked chat", body dropped | `notifications/locked-link.test.ts` |
| Home overview (recent titles, approval titles) and Daily Brief | title withheld, locked flag; brief excludes locked chats | code only |
| Skill draft writes | refused as not found | code only |
| Lock management (enable, unlock, lock now, change, remove) | owner only; failures counted on the row; lockout after 5 failures, reset on success | `agent/thread-lock.test.ts` (attempt accounting, backoff curve, edit refused without proof) |
| Trash, delete, restore | not gated (the recovery path), passcode row removed on permanent delete | none |
| Tool-approval continuation locked after its stream started | refused after the claim, through `failRun` (stream closed, thread out of `running`) | `chat/execute.continuation-lock.test.ts` |
| Attached files: a grant used on a chat other than a locked chat that holds the file | `getFileForUser` refuses a file on another locked chat of the caller's | `agent/files.locked-chat.test.ts` |
| Knowledge scope of a locked chat's own files | `resolveRetrievalScope` takes `unlockProof` / `admittedRun` | `knowledge/retrieval-scope.lock.test.ts` |
| GDPR export of a locked chat | `collectConversations` reads the full row and the admitted message reader | `gdpr/collect-conversations.test.ts` |

### Known gaps

- **GDPR export** includes a locked chat's title and messages (open question 5, decided: included). `collectConversations` reads the full row (`getThreadInternal`) and the admitted message reader, and the list and every client read stay guarded. Erasure deletes them as before.
- **Attachments of a locked chat** (`agent/files.ts#getFileForUser`): a grant alone no longer serves a file that sits on a locked chat of the caller's, in any chat other than that one with its proof. The check reads the caller's own passcode rows and scans each locked chat's messages (`fileIds`) page by page. A file never attached to a message (a stored file that the caller did not save into a message) is not seen by the check. Attaching a file that is also in a locked chat is refused in any other chat, unlocked ones included. A deleted source chat is not checked. **Shared chats are NOT covered:** `/chat/start` runs on the thread OWNER's shard (`chat/http.ts`, `threadShardFor`), where the collaborator's passcode rows do not exist, so a collaborator attaching a file from their own locked chat into the owner's shared chat is still served. Closing it needs the check run on the caller's shard from the HTTP action.
- **Chat-file readers** `file.ts#getChatFileExtraction` and `file.ts#getChatFileImageUrl` take an optional `threadId` and `unlockProof` and gate through the same `fileGatedByLockedChat` as `getFileForUser`: a file on one of the caller's locked chats is refused unless the named chat's valid proof is sent. Test: `file.chat-readers.lock.test.ts`.
  - **Web follow-up (not done):** the composer's extraction chip (`features/chat/thread/use-attachment-extraction.ts`) passes no `threadId`, so for a locked chat's file it reads `null` and shows no "reading" hint; sending still works through `/chat/start`. Passing the chat id there needs the chip to receive the thread (it sits below `useChatThread`'s provider boundary, which throws outside it). The workflow image callers (`features/workflow/hooks/use-workflow-transfer.ts`, `use-resolve-workflow-images.ts`, `backend/lunora/workflow/media-args.ts`) carry no chat id, so a workflow image that sits in a locked chat is refused there too.
- **Knowledge search for a locked chat's own files.** `resolveRetrievalScope` and `knowledge.retrieve.search` accept `unlockProof` and `admittedRun` and search the chat's attachments when either holds. Neither caller passes them yet: the `knowledge_search` tool has no proof or admission in its context, and the run's context retrieval (`chat/lib/agent-run.ts`, `retrieveKnowledgeContext`) is not wired. Both stay empty for a locked chat, as before.
- **Deck proof follows the viewer's chat.** `usePresentationData` takes the chat the viewer is on. A deck opened from another chat is refused until that chat is unlocked (fail closed), not opened by the wrong proof.
- **Branch lock is two writes, not one.** `branchThread` is an action, so the lock copy (`inheritThreadPasscode`) runs as its own mutation right after the branch is created and before any message is copied. A failure drops the branch's passcode rows and the branch, and no content is copied first. The two steps are not one transaction.
- **Admitted runs read only recent turns without a proof.** Their text and vector search still exclude the locked chat's own older rows (`agent/client/search.ts`), so generation context can be shorter than the chat's history.
- **Memory retrieval** can still inject a locked chat's memories into other chats. Only extraction is skipped.
- **Inbound messenger messages** are still saved into a locked chat; only the reply is refused.
- **Tasks and triggers** linked to a locked chat are not checked.
- **Media generation jobs** do not re-check the lock when they finish.
- **Document history** keeps the chat's title after a delete (`recordHistory` on `deleteThread`).
- **Title, category, summary and followup jobs** skip locked chats in code; no test covers it.
- **List, search, export and visibility procedures** are not tested through the procedure harness (`runQuery` cannot be dispatched there).
- **Vector search** filters after fetch, so a top-K result can come back short.
- **Thread page cost** is one row and two statements higher per page (the lock lookup in `withoutLockedThreads`); the read-cost budget was raised to 37 with the reason in the test.
- **Browser behaviour is unverified:** the lock menu, the unlock prompt, the locked row, the tab title and live-query expiry were not driven in a browser. The lingui catalogs are not extracted.
- **Lock menu** shows "Locked chat" in the list even while unlocked, because list procedures do not take a proof.
- **Notifications for a locked chat, after a grant is gone.** Done in `notifications/locked-redact.ts`, and the read path still treats an unreadable chat as unlocked. What now happens:
  - A lock is refused while any grant exists, and a grant is refused on a locked chat. So the users who had access are found from their accepted invites (`threadInvites.acceptedBy`), which outlive a revoked grant.
  - `enableThreadLock` schedules one job per such user, onto THAT user's shard. The job rewrites that user's notifications linking to the chat to the redacted form (generic title, no body, and pending outbox mail for them). It runs one page of 200 rows at a time, resumes from its cursor, and skips rows already redacted.
  - A notification written after the lock is redacted on the owner's shard in `notify()`, before the hand-off, so the recipient's shard receives the redacted form.
  - **Limits.** Unlocking does not restore titles; a redacted row stays redacted. The fan-out is dispatched as the lock commits and reads every page of the chat's invites. A notification scheduled for hand-off before the lock, whose hand-off lands on the recipient's shard after that recipient's redaction job has run, keeps its title for good: the job rewrites only the rows already there, and the read path cannot see the owner's lock. Sent outcome mail cannot be recalled. The read path is unchanged, so a row that was never rewritten still shows its title to a recipient who is not the owner until the job reaches it.
- **Open live subscriptions** keep the content they already received until their args change. The args change on the next render after expiry, and the server refuses any re-run. A subscription can therefore show content for up to about 10 seconds after expiry.
- **Trash, delete, restore and pin edits** are ungated. Delete is the recovery path by design. Settings writers, `makeThreadTemporary` and `updateGroupChat` were not reviewed for the lock.
- **Browser round trip:** the proof-carrying fetch bodies (`/chat/start`, regenerate, edit, media) are wired in `chat-context.tsx` and typechecked, but no browser run confirmed them. Whether `error.data.code` reaches the client on a query error, not only on a mutation, is also unverified.
- **A push or outcome email already running when the chat locks can still deliver the original title, once.** A recipient on another shard cannot read the owner's lock at delivery time, so `loadPushNotification` and `listPendingOutcomeEmails` redact only when the chat is readable on that shard. A job that read the row before the lock landed keeps the title it read.
