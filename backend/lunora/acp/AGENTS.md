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
    - **Agent-reported state** (`session_state`, a turn-less post like `session_open`):
        - Usage (`usage_update`) is stored on `acpSessions.agentState` with `agentStateAt`; each field present replaces the stored one, and a usage report without a cost keeps the stored cost.
        - Order: a report with the desktop's `seq` (counted per session in observation order) is dropped when `seq` is not newer than `agentStateSeq`, so a desktop clock ahead cannot let an older report win. A report without `seq` (an older desktop) is dropped when its time is older than `agentStateAt`. The stored time is capped to the server clock. Every accepted report stores its sequence, so a delayed older report is dropped even when a newer one repeated the values; the desktop does not post a report whose values the backend already holds, so the row is written for each change. A refusal whose outcome is unknown (no answer, an expired window, a restart) is recorded as confirmed when a report shows the value it asked for.
        - The desktop coalesces it to one post per session every 2 s (`HostPoster.flushState`).
        - The advertised commands (`available_commands_update`) are stored as `agentState.availableCommands`, replaced whole when present, and compared field by field, in order, to skip an unchanged list. Their bounds are shared between `vAgentCommands` and the desktop's `agent-state.ts`. The GDPR export leaves the list out.
        - A failed post backs off 30 s, unless a fresh report is waiting; a report failed `MAX_STATE_ATTEMPTS` times with nothing newer is dropped.

- **Coding agents on a paired computer** (`backend/lunora/acp/`, `apps/desktop/src/acp/`, acp-agent-host.md) —
  the web and the phone reach them only through signed `acp_*` device calls (`devices/lib/acp-call.ts`), and the
  computer's Rust core refuses an `acp_start` for a pair the user did not approve in its local window, whatever the
  signature. These calls spend NO nonce: a claim is a 30 s lease (`acp/calls.ts` returns a lapsed one to `pending`),
  the same envelope comes back, and the main process's receipt log (`acp/commands.ts`, keyed by the signed call id,
  written BEFORE the command is acted on) makes the second delivery an acknowledgement. The page's relay retries a
  failed claim or completion until the call's deadline, whatever the error. A call's prompt is cleared from `input` and
  `envelope` on every terminal path (`ACP_CLEARED`). Any new way a call can end must go through `onAcpCallEnded`, or its
  turn stays "Sending". `acp_cancel` and `acp_set_config` each have their own open-call budget (`devices/lib/acp-call.ts`) and a turn's end withdraws its waiting answers (`acp/lib/withdraw.ts`); when the backend ends a turn the desktop did not, the poster stops the agent itself. A refused command keeps a tombstone in the receipt log, so the same envelope is refused again, never run later. A request whose command or target was cut is declined, never allowed, from the web (Rust refuses it too). The numbers they are tuned by were not measured (`acp-s4-throttling.md`).
  **An organization's cap**: an agent on a computer approves its own tools, so it runs for an organization only at the `auto` cap and
  only while the owner is still a member. Every way one is started or sent a turn (a start, `/hosts/send`, a switch to a computer,
  `/clear`, the pull-request guide, a worker) checks `acp/lib/organization-cap.ts` with the thread's own organization first, then
  its `capOrganizationId` (a temporary chat, or a chat saved from one), which a switch carries on, else the caller's verified one. A start files the thread under its project's organization when the project has one, so a start from another space cannot lift that organization's cap; with no such project it files under the caller's organization.
  **Project runner default** (`acp/lib/project-runner.ts`): a start given a `projectId` files the thread under that project (only one the caller may write to)
  and records the computer, agent and folder id there: on the project row for a personal project, on the starter's own `userSettings.projectRunnerDefaults`
  for an organization project, so no member reads another's; a personal project's row only for its owner's sessions. It is recorded when the agent opens, in a mutation of its own the open schedules (`ingest.ts#recordOpenedRunner`, so a failed record never rolls the open back; it carries the open's `lastEventAt`, so a session closed before it runs still records), for the project
  the thread is in then, stamped with the thread's start time and id: an older thread's session (a switch, `/clear`) never replaces a newer thread's runner, and of two started in one millisecond the greater id wins (`runnerReplaces`).
  A start and `getProjectRunnerDefault` read the project, the membership and the device from the primary, as they decide the cap, the start and who may read the default. `getProjectRunnerDefault` returns it only while the device still offers the pair and its project scope admits the project; a
  start refuses a computer kept out of the project (one with no project too, on a computer limited to some), marked `HOST_START_OUT_OF_SCOPE` (`isOutOfScopeStart`) so a caller never reports it as busy; a retry is judged by the project its claim recorded, read once, whichever computer it names. A project moved out of an organization keeps `organizationId: ""`: read it with `||`, never `??`.
  A move between spaces EMPTIES the runner ids (`""`, read as none) in a patch, never removes them (that replaces the row from a stale read); the runner write is a `patchIf` on the organization, move stamp, owner and runner stamp it read, retried from the row as it stands while the project is still personal, has not moved since the thread started (strictly after, as `entryApplies`) and nothing newer is recorded. A session open saves an organization default only for a current member (primary).
  At the cap of `projectRunnerDefaults`, only the oldest `ENTRIES_CHECKED_AT_CAP` projects are read (each row is charged whole), and of those the entries that can never be returned again go before a live one; a moved project's
  settings entries are left on each person's shard, and `organizationChangedAt` retires those from threads started before the move or in its millisecond (strictly after, `entryApplies`); the project is read again just before the settings write, and a move in between saves nothing. The export carries a personal runner on its owned-project entry (`projects/gdpr.ts`).
