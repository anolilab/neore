# ACP — AGENT NOTES

## INVARIANTS

- **Host-run threads** (`backend/lunora/acp/`, `apps/desktop/src/acp/`,
  acp-agent-host.md) — a coding agent runs on a paired computer and the
  thread is `threads.runner = "host"` (`acp/lib/host-thread.ts`; deliberately
  not a create field, so a client cannot mint one). The desktop MAIN process
  posts the output to `POST /hosts/ingest` (signed with the device secret under
  the `turn` domain, `Rust DeviceCore.signTurn`, which signs nothing but a turn
  post for this device); the page is not in that path, and the backend origin
  is baked in at build time (`NEORE_BACKEND_URL`), never taken from the page.
  Non-obvious: every event takes one `(turnId, seq)` slot and writes one
  `persistentChunks` row (tool, permission and the end of the turn too), because
  `lastSeq` is read off `by_streamId_seq` and never kept as a counter on the
  stream row — a write per post would re-run `getActiveStreamForThread` for
  every viewer. The reaper window moves forward only after half of it is gone
  for the same reason. The device owner comes from the `.global()` `shardRoutes`
  row `device:<id>` (cached per isolate), the signature is checked on the
  owner's shard, and the per-device limit sits AFTER that, inside
  `applyHostEvents`, so a forged post never spends a victim's budget. The
  harness is one database for every shard, so "a post into another user's
  thread is refused" is proved by the explicit owner comparisons in
  `applyHostEvents`, not by shard isolation. A host stream ends through
  `endHostStream` from every path (the host's `turn_end`, the reaper, a revoked
  device, Stop), which sets the status and `hostState: ended` in one write.
  **Files a host reply shows** (acp-agent-host.md §4.8): only a Markdown
  IMAGE in the reply (`![](path)`, never a plain link) is looked at, at the end
  of the turn, by the desktop main process. Rust (`DeviceCore.acpReadMedia`,
  `fs::read_media`) resolves it against the approved folder alone and opens it
  through the same confined walk as `fs_read`; a path out of the folder (`..`,
  absolute, a link out) is refused by the canonicalisation BEFORE any open (the
  test makes the outside files mode 000 to prove it). Type is the file's bytes
  AND its extension agreeing, from a short list with no SVG/HTML/script. The
  upload goes over TUS to `/hosts/uploads` (`acp/upload-http.ts`), each request
  signed in Rust under the `upload` domain (`DeviceCore.signUpload`); the
  ingest's `media` event carries only the upload id, which the INGEST ACTION
  finalizes for the device's owner (`acp/upload.ts#finalizeHostUpload`) and
  stores as `storageKey`/`fileId` itself — a device-sent key is dropped. A
  finalize failure never fails the post (the desktop would stop posting the
  turn); the file is noted as not attached. A finalize deletes the staged
  upload, so its result is remembered per (owner, upload id) in `actionCache`
  and a resend of a post whose answer was lost reuses it (one file row); the
  device's `hosts/ingest` budget is spent BEFORE the finalize
  (`spendHostBudget`, then `applyHostEvents({ budgetSpent })`) so a post that
  would answer 429 never uses an upload up. Device creates have their own
  limit, `hosts/uploads/create`. The core judges a reference's TEXT first
  (`fs::lexically_inside`, no backslash or drive forms in
  `media::is_plain_path`) so agent text cannot make the system resolve a
  network or automounted path. Content-addressed storage makes a
  later edit of the file leave an earlier message alone. The reply's text parts
  carry `providerMetadata.neore.runner = "host"`, which makes the reader skip
  Markdown images (`hostMarkdownComponents`): a remote one would be fetched.
  The size caps and the type list are PROVISIONAL (not measured) — one pair of
  constants, `acp/lib/constants.ts` and `device-core/src/media.rs`, pinned
  equal by `media-limits.test.ts`.
  Host turns write no usage row and charge no credit.
  **Agent-reported state** (`session_state`, a turn-less post like `session_open`): what the agent says about itself
  outside its turns (`usage_update`: the context meter) is stored on `acpSessions.agentState` with `agentStateAt`.
  Each field present replaces the stored one; a report older than `agentStateAt` is dropped, and one whose values are
  stored writes nothing. The desktop coalesces it to one post per session every 2 s, keeps the newest value of each
  field, and signs a fresh payload on every send (`HostPoster.flushState`). Read it through `getHostSession`.
  **File-event hooks** (`apps/desktop/src/acp/hooks/`, acp-agent-host.md §4.10)
  read `.neore/hooks.json` from the approved folder — repository content, so inert until the
  local device window approves that file's SHA-256 (re-read and re-hashed when a hook fires),
  and a hook can only send a prompt to the already-open session. The watcher drops events
  during and shortly after any turn; do not shorten that window or let a hook start a session. `acp_*` device calls have
  their own claim window (60 s) and open-call budget (3 per device); the backend
  queues `acp_cancel` itself (`devices/lib/acp-call.ts`) because
  `createDeviceCall` refuses anything the manifest does not list.
  **A host thread can have several sessions** (harness switch S3): a switch to another host agent ends the thread's session
  and opens the next in the SAME thread, so `sessionOfThread` is the newest by creation and an older one stays as an `ended` row.
  The handoff for the new agent rides the first `acp_send` (`acp/lib/pending-handoff.ts`, derived from the path, no flag), never
  the saved message; a switch across the runner makes a new thread linked by a `continuation` relationship.

- **Coding agents on a paired computer** (`backend/lunora/acp/`, `apps/desktop/src/acp/`, acp-agent-host.md) —
  the web and the phone reach them only through signed `acp_*` device calls (`devices/lib/acp-call.ts`), and the
  computer's Rust core refuses an `acp_start` for a pair the user did not approve in its local window, whatever the
  signature. These calls spend NO nonce: a claim is a 30 s lease (`acp/calls.ts` returns a lapsed one to `pending`),
  the same envelope comes back, and the main process's receipt log (`acp/commands.ts`, keyed by the signed call id,
  written BEFORE the command is acted on) makes the second delivery an acknowledgement. The page's relay retries a
  failed claim or completion until the call's deadline, whatever the error. A call's prompt is cleared from `input` and
  `envelope` on every terminal path (`ACP_CLEARED`). Any new way a call can end must go through `onAcpCallEnded`, or its
  turn stays "Sending". `acp_cancel` has its own open-call budget and a turn's end withdraws its waiting answers (`acp/lib/withdraw.ts`); when the backend ends a turn the desktop did not, the poster stops the agent itself. A refused command keeps a tombstone in the receipt log, so the same envelope is refused again, never run later. A request whose command or target was cut is declined, never allowed, from the web (Rust refuses it too). The numbers they are tuned by were not measured (`acp-s4-throttling.md`).
