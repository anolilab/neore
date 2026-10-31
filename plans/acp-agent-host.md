# ACP agent host (desktop)

Status: plan, 2026-10-26. Part of [agent-host-roadmap.md](agent-host-roadmap.md).
This plan defines the **host channel** and the **host-run thread** marker that
[ssh-environments.md](ssh-environments.md), [agent-orchestrator.md](agent-orchestrator.md),
[outside-agent-mcp.md](outside-agent-mcp.md) and
[mobile-acp-and-remote-control.md](mobile-acp-and-remote-control.md) build on.

## 1. Goal and decision

Users run Agent Client Protocol (ACP) agents, such as Claude Code or Codex
through their ACP adapters, inside Neore threads. The agent runs on the desktop
(or on an SSH host through the desktop) with the user's files and the user's own
agent login. Neore shows its output in the thread, routes its permission
requests to Neore's approval UI, and saves the turn on the backend, so web and
mobile see it.

**Decision.** The desktop main process spawns and owns the agent process. The
backend never spawns one. Commands reach the desktop as backend-signed device
calls through the app-wide relay. Turn output goes from the main process
straight to a device-signed, claim-once ingest route keyed by `(turnId, seq)`.
The thread is a normal thread marked `runner: "host"`. Agent processes run
beside the device sandbox in v1. Every ACP permission request prompts, and there
is no "Always allow". Neore stores no credential for an ACP agent.

## 2. Current state (checked)

| Area | What exists | Where |
| --- | --- | --- |
| Device calls | `listPendingDeviceCalls`, `claimDeviceCall`, `completeDeviceCall`, `reportDeviceCallProgress`, `releaseDeviceCall`; rows in `deviceCalls` (`deadline`, `envelope`, `signature`, `phase`); created by `createDeviceCall`, expired by `expireDeviceCall` | `backend/lunora/devices/functions.ts`, `backend/lunora/devices/internal.ts` |
| Signing | HMAC-SHA256 over `neore-device:<domain>:v1\n` + payload; closed union `DeviceSigningDomain = "call" \| "manifest" \| "progress" \| "result"`; `isFreshTimestamp`; window `DEVICE_SIGNATURE_WINDOW_MS` (10 min, `backend/lunora/devices/lib/constants.ts`; the 5-minute `SIGNED_REQUEST_WINDOW_MS` is for third-party webhooks, not devices) | `backend/lunora/devices/lib/signing.ts`, `backend/lunora/lib/crypto.ts`, `packages/device-core/src/envelope.rs` |
| Eligibility | `isDeviceEligibleThread`: owner only, not deleted, not public, no group chat, no `externalThreadId`, no `threadAccess` grant | `backend/lunora/devices/internal.ts` |
| Relay | mounted app-wide after first paint; 30 s heartbeat updates `devices.lastSeenAt`; only the main window advertises `device` (`siteCapabilities`) | `apps/web/src/features/devices/components/device-relay.tsx`, `apps/web/src/lib/native/native-bridge.tsx`, `apps/desktop/src/main.ts` |
| Close | `canHideOnClose`: hide on macOS or with a tray; otherwise closing quits | `apps/desktop/src/main.ts` |
| Streams | `createStream`, `addChunk` (stamps `seq` itself), `setStreamStatus`; `persistentChunks` by `by_streamId_seq`; timeout sweep `cleanupExpiredStreams` | `backend/lunora/chat/streaming/persistent/` |
| Stream reads | the sender streams through the gateway with a token from `/chat/start` (`createStreamToken`); any other reader, including after a reload, uses the live queries `getActiveStreamForThread` and `getStreamBody` | `backend/lunora/chat/http.ts`, `backend/lunora/chat/streaming/index.ts` |
| Webhook routing | `.global()` `shardRoutes` (`key` → `ownerId`) routes unauthenticated HTTP to the owner's shard | `backend/lunora/schema.ts` |

Browser-run local models (`backend/lunora/chat/local-models.ts`, `saveLocalTurn`)
save text after the turn. They do not fit host turns, which stream, carry tool
parts and approvals, and need cancel and reconnect.

## 3. Who may start what

| Entry point | What is allowed |
| --- | --- |
| Desktop local window (Quick Composer, the device window) | add an agent or folder (native dialog), start a session with any approved pair, prompt, cancel, answer permissions |
| Web or mobile, signed in as the owner, **continue** | prompt into an existing session of a thread they own, cancel, answer a permission (approve once or decline) |
| Web or mobile, **start** | only with an (agent, folder) pair already approved in a local window |
| Outside agents (MCP, REST) | read only; never write into a host-run thread ([outside-agent-mcp.md](outside-agent-mcp.md) §3) |

- Consent is stored in the desktop's Rust device store, per (agent, folder). It
  is granted and revoked only in a local window, never by a web request.
- The desktop publishes the approved pairs as **offers**, signed with the
  `manifest` domain alongside the tool manifest: `{ agentKey, agentLabel,
  folderId, folderLabel }`. Paths and command lines never leave the desktop. The
  backend stores them on `devices.acpOffers` (written by `updateDeviceManifest`).
- Rust refuses an `acp_start` whose `(agentKey, folderId)` is not in its store,
  even with a valid signature. A test pins that refusal.
- **Input from outside the local shell is ordinary user input.** It never changes
  consent, the folder or the agent. Chat text never answers a permission
  request: only the typed `acp_permission_answer` command does (§4.4).

## 4. The host channel

### 4.1 Commands: backend-queued device calls

New action kinds in the `call` domain, verified by `envelope.rs`, dispatched by
`engine.rs`:

| Kind | Payload | Desktop does |
| --- | --- | --- |
| `acp_start` | `sessionId`, `agentKey`, `folderId`, `threadId` | checks the offer locally, spawns, handshakes, opens a session |
| `acp_send` | `sessionId`, `turnId`, `text`, attachment refs | queues or runs the prompt (refused if a turn is running and the agent cannot queue) |
| `acp_cancel` | `sessionId`, `turnId` | cancels; every open tool call ends as cancelled; prompts the agent holds queued for that session are dropped, so Stop releases nothing later |
| `acp_permission_answer` | `sessionId`, `requestId`, `optionId` | answers if still pending, first answer wins |

- Each call's result (via `completeDeviceCall`, `result` domain) is only
  `accepted` or `refused: <reason>`. Turn output never travels in a call result.
- **Own budget and window.** ACP kinds are not device tools, so they get their own
  open-call budget (3 per device, counted separately from device tools) and their
  own claim window of 60 s. The device tools' 20 s window (`DEVICE_CLAIM_WINDOW_MS`)
  is unchanged. A stuck send therefore never blocks `acp_cancel`.
- **Claim lease.** For `acp_*` kinds a claim is a lease, not a hand-over. Today a
  claimed call has no way back: if the desktop crashes after `claimDeviceCall` and
  before it persists the command, the call expires unrun. A claimed `acp_*` call
  that is not completed within the lease (set in S4 from measured latency) returns to
  `pending` and can be claimed again until its deadline. The desktop writes its
  local receipt before it completes the call, so a redelivered call whose id is
  already in the receipt log is acknowledged, not run twice.
- `createDeviceCall`'s other gates apply: the kinds are listed in the manifest, the
  device was online within `DEVICE_ONLINE_WINDOW_MS` (75 s), the per-user
  `devices/call` rate limit holds, and input is capped at 32 KiB.
- An unclaimed call expires (`expireDeviceCall`) and the client sees "host did not
  answer". The stream for a host send ends with that error at the deadline, so it is
  not left pending for the housekeeping sweep. Nothing is queued silently or
  replayed later.
- The procedures that create these calls first require `isDeviceEligibleThread`
  and `threads.runner === "host"`, and that the session's `deviceId` is paired
  and not revoked.
- **Prompt text is cleared at the end of a call.** A device call keeps its text in `input` and in its signed `envelope`, and the audit list previews `input` for 30 days. For `acp_*` calls, both fields are cleared once the call reaches a terminal status. The desktop has the envelope by then, and the thread keeps the text as the user's message. Tool calls keep today's behaviour; clearing them would be a separate change.

### 4.2 Turn output: the ingest route

`POST /hosts/ingest`, an HTTP action in the new `acp` module, mounted in
`backend/lunora/http.ts`. Body: `{ payload: string, signature: string }`. The
payload is a JSON string:

```
{ v: 1, kind: "turn", deviceId, threadId, turnId, firstSeq, issuedAt, events: [...] }
```

`kind` is required by `parseSignedPayload`, which checks `v`, `kind` and `deviceId`.

Event kinds: `session_open` (capability report, optional native session id),
`turn_start` (local prompts only: the user text), `text` and `reasoning` deltas,
`tool` (upsert by tool call id), `permission_request` (request id, tool, target,
command, folder, the agent's options), `permission_resolved`, `turn_end`
(`finished` | `cancelled` | `failed`).

`turn_end` carries the turn's outcome, so the desktop, the ingest route and the clients
read one contract:

- `status`: `finished` | `cancelled` | `failed`. A usage-limit stop (§6.1) is `failed` with
  `reason: "usage_limit"`, not a fourth status, so a client that only knows the three still
  shows a stopped turn. `resetAt` (epoch ms) rides along when the agent said when it resets;
  both are bounded strings or numbers and validated like any other event field.
- `summary` (optional, §4.9): `files` (at most 200 entries of `{ path, added, removed }`,
  `path` inside the approved folder and at most 1,024 characters, counts non-negative
  integers) and `patch` (the frozen unified diff as text, at most 256 KiB; over that the
  entry is `{ tooLarge: true }` and the file list and counts stay).

`applyHostEvents` rejects the whole post on a field outside these bounds, as it does for
every other event. The exact field names are settled in the wire-format spec before S3's
route is written; this section fixes the shape and the limits.

Verification, in this order. Every auth failure gets the same answer (401):

1. Parse; reject past 256 KiB. The unauthenticated flood guard is an in-isolate
   per-IP counter, not a mutation on `__root__`, because every post would otherwise
   serialise on the root shard. The durable budget is the per-device limit in step 5.
2. Resolve the shard from the `.global()` `shardRoutes` row `device:<deviceId>`,
   the pattern messenger and trigger webhooks use. `registerDevice` writes that
   row, and `revokeDevice` deletes it. A device paired before this slice has no
   row: `heartbeatDevice` writes it when missing, so such a device works after its
   next heartbeat without re-pairing. No row gives 401, before any Durable Object
   is touched. The ingest has no user session, so `onThreadShard` does not apply.
3. `inShard(ctx, ownerId, ...)` (`backend/lunora/lib/http-shard.ts`). `runQuery`
   an internal query that loads the device there. If it is missing or revoked,
   401.
4. Decrypt `encryptedSecret` (as `backend/lunora/devices/functions.ts` does), then
   `verifyDevicePayload(secret, "turn", payload, signature)` and
   `isFreshTimestamp(issuedAt, now, DEVICE_SIGNATURE_WINDOW_MS)`.
5. Only now, the per-device rate limit (`hosts/ingest`), keyed by the verified
   `deviceId`, so forged posts cannot exhaust a victim's budget.
6. `threadShardFor(ctx, ownerId, threadId)` (`backend/lunora/lib/thread-shard.ts`)
   must equal `ownerId`. Host-run threads are never shared, so anything else is
   refused.
7. `runMutation(internal.acp.ingest.applyHostEvents, ...)`. The action never
   touches `ctx.db`. Internal mutations run without RLS, so the mutation compares
   owners explicitly: `thread.userId === device.userId`,
   `thread.runner === "host"`, and the thread's `acpSessions.deviceId === deviceId`.

The desktop batches deltas, at most one post per 250 ms per turn.

### 4.3 Claim-once by `(turnId, seq)`

`turnId` is a UUID minted by whoever starts the turn (the backend for remote
sends, the desktop for local ones) and stored on `persistentStreams.hostTurnId`.
Each event has `seq = firstSeq + index`. For host streams, `addChunk` takes the
host's `seq` instead of stamping its own. In `applyHostEvents`, one transaction:

- events with `seq <= lastSeq` are dropped (redelivery);
- if `firstSeq > lastSeq + 1`, the whole post answers 409 with `{ next }` and the
  desktop resends from there;
- `turn_start` with a `hostTurnId` that already exists is dropped;
- `turn_start` for a new turn while the thread still has a live host stream answers 409 with
  `{ error: "turn_in_progress" }` and no `next`: the earlier turn's end is still on its way
  (its output is being retried), so the desktop tries again with backoff; the reaper bounds the
  wait;
- a session-level post `{ close: true, events: [] }` (no `threadId`) ends the session at once and
  any turn still live on it as `interrupted`. The desktop sends it once the session's turns have
  been delivered (a turn post into an ended session is refused). It is idempotent, and answers
  success for a session it does not know.

The desktop stops posting when 401 has answered every try for a minute and at least five tries
(a removed computer; one clock blip is retried), and never follows a redirect from the ingest URL.

The stored `seq` is the claim, so no `idempotencyClaims` row per chunk is needed.
A replay older than the signed window fails step 4. A replay inside it is
dropped by `seq`, so the stored `seq` outlives every replay that could pass.

### 4.4 Permission requests and answers

- A `permission_request` is written as an awaiting approval part on the pending
  reply row, with the tool, target, command and folder in full.
- The local window shows the same request at once.
- Remote answers come from `answerHostPermission` (authMutation, owner only),
  which queues `acp_permission_answer`. It accepts only an option the agent
  offered whose kind is allow-once or reject.
- Rust holds the pending request. The first answer, local or remote, wins. A
  later answer is refused as `already_answered`, and the local prompt closes when
  a remote answer lands.
- Options of an "always" kind are never shown and never sent. Rust refuses them
  from any source in v1.
- **Pending requests sit in one bar above the composer**, one line each (tool,
  target, folder), expandable to the full command. Several requests from one
  session group into one bar with **Approve all**.
- **Approve all is a batch of allow-once answers, not a rule.** It answers exactly
  the requests the bar showed when it was pressed, each with that request's own
  allow-once option, and records one answer per request. A request that arrives
  afterwards prompts on its own. Nothing is remembered for later calls, so it is
  not "Always allow" and rule 5 of the roadmap holds. It is shown only when every
  grouped request offers an allow-once option and its full details are
  available to expand; otherwise the bar falls back to per-line buttons. The same
  bar and rule apply on the web and on the phone (mobile M3), where the answers
  travel as separate `acp_permission_answer` calls.
- **Device tool calls are not batched.** Approvals that Neore's own device
  execution asks for (`shell_run`, `fs_write`, tainted calls) keep one decision
  per call in the local device window.

### 4.5 Window, quit, throttling

- The main process holds unsent events in a bounded in-memory queue, with
  backoff. Each post is signed through `packages/device-core-node`; the secret
  never leaves Rust.
- With a hidden main window (macOS, or with a tray), the relay and turns keep
  running. Without a tray, closing quits.
- Quit kills every agent process tree: process groups on Unix, a job object on
  Windows.
- A stream with no event for the reaper window is set to `timeout` by
  `cleanupExpiredStreams`, the status the code already uses, and the thread's
  status is reset. The host is then sent `acp_cancel` for that turn. Events that
  arrive after the timeout are dropped. Every terminal path (the reaper timeout, cancel,
  revoke, `turn_end`) sets `hostState: ended` in the same mutation that sets the stream
  status, and the UI shows "Working" only while the stream is not terminal. Every ingest moves `expiresAt` forward.
  S3 sets the window.
- Electron throttles timers in hidden windows. S3 measures relay claim latency
  and heartbeat gaps with the window hidden for an hour. If either misses its
  budget, set `backgroundThrottling: false` on the main window and measure the
  battery cost before keeping it.

- A turn waiting on a permission answer is not silent. The reaper does not time out
  a stream that has a pending permission request.
- On a desktop restart or update, in-flight host turns end at once, and their pending
  requests become not resumable. Before an update installs, the app counts running
  turns and says so.
- A restart that comes after the reaper has already timed the turn out still ends as
  `interrupted`: the backend moves `persistentStreams.hostEndReason` from `timeout` to
  `interrupted` and writes no second reply. The Continue offer (S4) reads
  `hostEndReason` of the thread's last stream, not the reply row.
- **A turn cut off by a restart says so and can continue.** It ends with the reason
  `interrupted` (restart, update or crash, as the desktop knows on its next start),
  not as a plain error. The reply offers **Continue**: an ordinary send into the
  same session, or into a new one when the old one cannot be loaded, whose prompt
  tells the agent its last turn was interrupted by a restart and that any
  background work it started (a background shell, a watcher) was stopped with it.
  Without that note an agent that was waiting on its own background task waits
  for a completion that will never come. Continue is offered, never sent on its
  own: the desktop restarting does not mean the user wants the turn to run again.
- Reconnects use jittered exponential backoff with a cap, reset only after a
  connection stays up. After a long suspension, the relay replaces its connection
  instead of probing it.

### 4.6 Sending and reading a host turn

- **Remote send:** `POST /hosts/send`, an HTTP action shaped like `/chat/start`
  and mounted the same way (`onCallerShard`; a host-run thread is always on its
  owner's shard). It takes a client request id, claimed once (`claimOnce` scope
  `host-send`, key `<userId>:<requestId>`, TTL 24 h, added to the scope table in
  `backend/lunora/lib/claim-once.ts`). Through an internal mutation it creates the
  user message, the pending reply and a `persistentStreams` row with
  `producer: "host"`, queues `acp_send`, and returns
  `{ messageId, streamId, streamToken }` from the same `createStreamToken`. The
  sender streams through the gateway relay, exactly as for a cloud turn.
- **Every other reader** (a reload, a second browser, a turn started in the local
  window, a phone that did not send) uses `getActiveStreamForThread` and
  `getStreamBody`, the live queries cloud turns already use. A host stream is an
  ordinary `persistentStreams` row, so both find it with no new token mint. Their output validators (`vStreamBody` and the
  active-stream result in `chat/streaming/index.ts`) do not carry `hostState` today, so S3
  adds it to both, and a test reads each state back after a reload.

- **Host states, shown to every client.** A host turn moves through four states,
  stored as `persistentStreams.hostState`: `accepted` (the backend stored the
  message, the pending reply and the stream, and queued the call), `received` (the
  desktop relay claimed the call and the main process persisted it), `running`
  (the agent sent its first turn event), and `ended`. The UI shows "Sending" until
  `received`, and "Working" only from `running`. Nothing shows provider activity
  before the host has acknowledged the turn. Web and mobile read the same field.
- **A command can arrive before the session.** The host may receive a send for a
  session it has not finished opening (a phone sends just after a start, or the
  desktop restarts). The host persists the command under the session id before it
  acknowledges the call. It applies the command once `session_start` completes. If
  the session never starts, or the command passes its envelope's `expiresAt`, the
  command ends the stream with a clear error. The receipt is written first, so a
  crash between the two cannot lose the command.
- **Retries cover any failure.** The relay retries a failed claim or completion until
  the call's deadline, whatever the error. A retry that only covers one HTTP status
  strands the call.
- **The backend owns delivery, not the phone.** `/hosts/send` stores the command
  before it returns. If the phone dies after its request, the row already exists
  and the host still gets the call. On relaunch the phone reads the stream state. It
  replays nothing.

### 4.7 Native child agents

Some agents start child agents of their own. A child is shown only when the agent
reports it, through the subagents group of the capability report
([provider-capabilities.md](provider-capabilities.md) §4). Without that report, the
children stay inside the agent and nothing is shown.

- **Ownership.** A child belongs to the parent tool call that spawned it. The
  spawn call's id is the key, and it never changes. A later event that names the
  child, but carries no spawn, does not create a card.
- **Buffering.** Child events that arrive before the parent card exists are held
  in a per-session buffer, with a fixed byte budget (set in slice S7 from
  measurements). Overflow is logged and the excess is dropped. The buffer is
  drained once the parent card exists.
- **Storage.** A child transcript is a `subagentTranscript` part on the parent
  message, keyed by the spawn id. A native child is not a thread and gets no
  thread row. It has no runs, charges or queue. Those belong to workers
  ([agent-orchestrator.md](agent-orchestrator.md)).
- **Settling.** A child's completion ends its card. A duplicate terminal event is
  ignored. A completion message with no streamed text keeps its full text.
- **Resume.** On session load, the parent's stored spawn parts rebuild the
  ownership table. Nothing is replayed into the transcript.

### 4.8 Images and files a host agent writes

An agent cannot call our tools, so it has no `show_image`. It writes a file in
the folder and refers to it in its reply. Rules:

- **What counts.** A Markdown image in a reply, or a file the agent reports as
  created, whose target resolves to a file inside the approved folder. Only image
  types render inline. Other files become download links.
- **Resolution.** Resolve the target relative to the folder root, then
  canonicalise it. A path that leaves the folder (`..`, an absolute path elsewhere,
  a symlink that exits the folder) is refused and shown as text. The check runs in
  the main process, never in the page.
- **Size and type.** A size cap and an allowlist of image types, both set in S8 (provisional until measured; see "S8 as built"). A
  file over the cap is shown as a download link with its size, not as an image.
- **Transport.** The bytes never pass through the page. The main process reads
  them through the device file operation and uploads them itself. This needs a
  device-signed create on the upload route (`lib/upload-route.ts`), which today
  accepts a session bearer or an API key, never a device signature: the create is signed with the device
  secret, names the folder file, and is checked against the device's user. The
  chunked upload that follows is authenticated
  the same way: every request carries a device signature header under a new `upload` signing
  domain. The create has no upload id yet (the handler mints it), so it is signed over the
  method, the path, the declared size and type, a nonce and the issue time; the nonce is
  claim-once, so a replayed create is refused. `HEAD` and `PATCH` are signed over the
  method, the server-issued upload id and the issue time; a `PATCH` is also signed over its
  `Upload-Offset` and the SHA-256 of its body, and the route checks both against the request
  before the handler sees it (a modified chunk or offset under an otherwise valid signature is
  refused, with a test). The route resolves the device's user from the signature, builds its
  handler for that user exactly as for a session caller, and answers another user's
  upload id as not found. No user session or API key is ever handed to the desktop,
  and none reaches the agent. The ingest carries only the resulting
  upload id, and the mutation checks that the upload belongs to the device's user.
  This adds backend work to S8. The phone reads the same file through a signed URL
  ([mobile-acp-and-remote-control.md](mobile-acp-and-remote-control.md) §3.8).
- **Staleness.** The reference names the file. Editing the file later does not
  change an earlier message, because the message keeps the upload it was saved with.

### 4.9 What a host turn changed

- Each finished host turn shows a compact summary under the reply: the files the
  agent wrote, with added and removed line counts, and an **Open diff** that shows
  the patch as it was at the end of that turn. Later edits do not change it.
- **Only named writes count.** The desktop records a file when the agent's own
  tool call says it wrote it: an ACP tool call with `diff` content, or an edit
  event that names paths. Before a write the desktop keeps the file's earlier
  bytes when the request names the path; the patch is frozen when the tool call
  completes. It never uses `git status` or a folder-wide diff as evidence of what
  the turn did, because other edits in the folder are not the agent's. A write it
  cannot attribute is left out, not guessed.
- Paths outside the approved folder are never read, the same rule as §4.8.
- The summary and patch are posted with the turn's final events on the ingest
  route. Patches are stored as a part on the reply row, capped in size; a patch
  over the cap keeps its file list and line counts and says the diff is too large
  to keep. The phone reads the same part.

## 5. Data changes

### 5.1 Tables and fields

| Change | Owner module | Notes |
| --- | --- | --- |
| `threads.runner: v.optional(v.literal("host"))` | chat (via `backend/lunora/agent/table-writes.ts`) | set at creation, never changed. A switch between cloud and host forks a new linked thread ([harness-switch.md](harness-switch.md)); a switch between host agents stays in the thread; added to `vThreadCreateFields` (`backend/lunora/agent/validators.ts`) and so spread into `vThreadDocFields`, or `.output()` rejects host threads |
| new table `acpSessions` | new `backend/lunora/acp/` | `userId`, `threadId`, `deviceId`, `agentKey`, `agentLabel`, `folderId`, `folderLabel`, `status` (`starting`, `idle`, `busy`, `offline`, `ended`), `capabilities` (`vCapabilityReport`, [provider-capabilities.md](provider-capabilities.md)), `nativeSessionId`, `lastEventAt`, timestamps. `.shardBy("userId")`; indexes `by_threadId`, `by_userId_status`, `by_deviceId` |
| `persistentStreams.producer: v.optional(v.literal("host"))`, `hostTurnId: v.optional(v.string())`, `hostState: v.optional(v.union(v.literal("accepted"), v.literal("received"), v.literal("running"), v.literal("ended")))`, index `by_hostTurnId` | chat streaming | unset = cloud. `hostState` drives "Sending" versus "Working" (§4.6) |
| `devices.acpOffers` | devices | written only by `updateDeviceManifest` from the signed manifest |
| `shardRoutes` key `device:<deviceId>` | devices | written by `registerDevice` and by `heartbeatDevice` when missing, deleted by `revokeDevice`; routes the ingest |
| `DeviceSigningDomain` gains `"turn"` | devices + Rust | HMAC vectors pinned on both sides (`signing.test.ts`, the Rust tests) |

- `isHostRunThread(thread)` lives in `backend/lunora/acp/lib/host-thread.ts`.
  It is the one helper the other plans call.
- Native session ids (S6) go on `acpSessions.nativeSessionId`, never on
  `threads.externalThreadId`, which would make the thread device-ineligible.
- Host-run threads cannot be shared, made public or joined to a group in v1. The
  share and invite procedures refuse them, because a grant would break
  `isDeviceEligibleThread`.

- Clients skip a message part of an unknown kind instead of failing the message, so
  older builds can read a thread that a newer desktop wrote.

### 5.2 Module, procedures, policies

- `backend/lunora/acp/module.ts` owns `acpSessions`. `backend/lunora/acp/gdpr.ts` erases them
  and is wired into the deletion workflow (`backend/lunora/gdpr/workflows/deletion-workflow.ts`).
  Its export collector goes in the export workflow the same way, so a user's ACP
  sessions appear in their export, followed by the tool, permission and turn-end events of their
  host turns (the prompt and the saved reply are ordinary messages, exported with the
  conversations). It is paged: the workflow asks again with `next` until there is none.
- Deleting a host thread, soft or hard (`acp/lib/thread-removed.ts`), ends its live turn without a
  reply, queues the host an `acp_cancel` and ends the session; the `acpSessions` row stays as the
  tombstone a redelivered `session_open` reads.
- Thread, message and stream writes go through their owners' write surfaces
  (`backend/lunora/agent/table-writes.ts`, the streaming library).
- `revokeDevice` also sets each of the device's `acpSessions` to `ended` and ends
  its open host streams with an error, in the same mutation.
- `steerRun` refuses a host stream. `DELETE /threads/{threadId}` refuses a host
  thread for outside agents, because that route does not reach `runChatStart`.
- A host worker's `finishRun` writes `subAgentRuns` through the sub-agents write
  surface, not directly from the `acp` module.
- Procedures, each with `.output()` and a row in `docs/security/authz-matrix.md`:
  `listHostSessions`, `getHostSession`, `startHostSession` (remote start),
  `answerHostPermission`, `cancelHostTurn`.
- `startHostSession` takes a `clientId`, claim-once under scope `host-start`, so a
  double tap starts one session.
- `acpSessions` gets an owner policy in `backend/lunora/lib/rls/policies.ts`.
- `runChatStart` (`backend/lunora/chat/http.ts`) refuses a thread where
  `isHostRunThread` is true. Both `/chat/start` and `POST /api/v1/chat` call
  it, so this is also the refusal the MCP and REST paths hit.
- The final reply is written through the agent write surface on `turn_end`, so
  branches and `failPendingSteps` apply. A regenerate on a host thread is a new
  host turn saved as a sibling, as `saveLocalTurn({ branch })` does for local
  models.
- Host turns create no usage rows and charge no credits: the agent bills its own
  account. Skipping `scheduleReplyUsage` is deliberate, and that is said in its
  header comment.

## 6. Where the agent runs, and the sandbox

- Agents are child processes of the desktop main process, or of `neore-host` on
  an SSH host ([ssh-environments.md](ssh-environments.md)). The page never gets a
  process handle. New desktop code lives in `apps/desktop/src/acp/` (process
  manager, ACP client, ingest poster). New local-window methods are added only to
  `apps/desktop/src/device/window/preload.ts`, never to the site preload
  (`apps/desktop/src/preload.ts`).
- **v1: beside the device sandbox, not inside `shell_run`'s.** The agent needs
  outbound network for its model API, which the macOS profile blocks by default.
  It runs its own tools under its own permission modes, which a wrapper would
  double-prompt. And the taint model (`backend/lunora/devices/lib/taint.ts`) sees
  only calls Neore executes.
- The cost: every permission request prompts, there is no "Always allow", and
  the UI says the agent runs with the user's rights. Its environment is built,
  not inherited (PATH, HOME, locale, what its adapter documents); no device
  secret or Neore token is ever in it.
- **User-set environment variables.** A built environment breaks an agent that
  needs a proxy (`HTTPS_PROXY`, `NO_PROXY`), a custom endpoint or base URL, or a CLI
  flag read from the environment. So the local window lets the user add variables
  globally and per agent; per agent wins. They are stored in Rust with the other
  local settings (like allow rules and shared folders), never sent to the backend
  or shown to the page, and applied at spawn on top of the built environment. A
  name Neore reserves (its own `NEORE_*`, `ELECTRON_*`, `NODE_OPTIONS`) is
  refused. Values are treated as secrets: masked in the window, never logged. On
  an SSH host the same list lives on the desktop and is passed to `neore-host`
  over the stdio channel ([ssh-environments.md](ssh-environments.md)).

### 6.1 When a host agent hits its usage limit

- A host agent bills its own account (roadmap trust rule 9), so it can stop on
  that account's limit. When the adapter reports a usage-limit stop, the reply
  ends with that reason, the reset time if the agent gave one, and an offer: switch
  to another offered agent (harness-switch S3, host to host in the thread) or
  continue on a cloud model (a fork, harness-switch S3). The offer is never taken
  automatically, because the other agent bills a different account.
- **Taking the offer runs the stopped turn again.** The switch re-sends that turn's
  prompt and attachments to the new agent, whoever started it: the user, a lead's
  dispatch, a trigger, or a turn whose page has since reloaded. The prompt comes
  from the stored user row, never from the composer, so it works with an empty
  composer and on another device.
- The desktop shows the agent's reported limit and reset time in the local
  window when the adapter exposes them. Missing values show as unknown, never as
  zero.

## 7. Protocol

ACP is JSON-RPC 2.0 over the agent's stdin and stdout. Version, capability names
and SDK package are not fixed here. S1 reads them from the published spec and
records the version next to the handshake.

- Negotiate the version at initialize. Use only what the agent advertises, mapped
  into a capability report ([provider-capabilities.md](provider-capabilities.md) §5).
- Pass the agent's option ids back unchanged; never invent one. A cancel ends
  every in-flight tool call as cancelled. Probes never open a session.
- An SDK only if maintained, licence-compatible and past `minimumReleaseAge`;
  otherwise a small client written on the spec.

## 8. Slices

"Verified" means run on macOS and Linux. Windows is listed where it differs.
Protocol tests run against recorded transcripts and a fake agent that checks every
outgoing frame, including the race where the end-of-turn status arrives before the
prompt response.

**S1 — Local run, desktop only.** Register a command in the local window, spawn,
handshake, open a session, prompt, stream text into the local window, cancel. No
backend.
- Acceptance: a prompt gets an answer; after cancel no tool call is running; a
  prompt sent while busy is queued or refused, never dropped; a version probe
  opens no session; quit kills the whole process tree (macOS, Linux; Windows job
  object tested separately).

**S2 — Consent and permissions, local.** Per (agent, folder) consent; permission
prompts in the local window with tool, target, command and folder; no "Always
allow".
- Acceptance: approve continues the agent; decline ends that tool call as
  declined and the agent receives the decline; a second request later in the same
  session still reaches the prompt; an unapproved folder is refused before spawn;
  an "always" option is never sent.

**S3 — Persistence and web view.** `threads.runner`, `acpSessions`, the ingest
route, `turn` domain signing, host streams, final reply write, reaper, the
throttling measurement.
- Acceptance: a page reload mid-turn shows the text so far; a second browser
  sees the same thread; a redelivered post is dropped; a gap answers 409 and the
  resend fills it; an unknown or revoked device, a bad signature or a stale
  `issuedAt` all answer 401 without the per-device limit moving; a post into another user's thread is refused; a turn keeps
  streaming with the window hidden for an hour (moved to S4, below); a turn whose events stop times out within the reaper window
  and the host is sent a cancel; a regenerate saves as a sibling; `runChatStart`
  refuses a host thread; the host states (§4.6: `accepted`, `received`, `running`,
  `ended`) are stored and read back by a second client.

**S4 — Remote start, continue, cancel, answer.** Offers in the manifest,
`/hosts/send`, `startHostSession`, `cancelHostTurn`, `answerHostPermission`, and
the retry rule of §4.6 (the relay retries a failed claim or completion until the
deadline, whatever the error).
- Acceptance: a valid signature for an unapproved pair is refused by Rust; a
  continue from the web reaches the agent and streams back; with the host offline
  the call expires with "host did not answer" and nothing runs later; a remote
  approve after a local one is `already_answered`; a remote answer closes the
  local prompt; "Approve all" sends one allow-once answer per request it showed and
  none for a request that arrived after the bar was drawn (test); the phone shows "Sending" until `received` and "Working" only from
  `running` (UI test); a claim failing with a server error and then a network reset
  is retried until it succeeds; killing the main process between claim and receipt returns the call to `pending` and it runs once when re-claimed, and killing it after the receipt but before completion acknowledges the call without running it twice.
- Acceptance (moved from S3): with the main window hidden for an hour, a relay claim
  is under 10 s at the 95th percentile and no heartbeat gap passes 60 s, or the
  numbers are recorded and §10 Q4 decided. S3 could not measure it: the thing that
  slips when hidden is the page relay that claims `acp_cancel`, and S3 adds no
  remote path that sends one to a turn the user is waiting on. S4 adds those paths
  and measures there; `plans/acp-s3-throttling.md` stays the record of the method
  and the safe default (throttling on).

**S4 as built** (differences from the text above):
- `/hosts/send` writes the user's message and the host stream in one mutation, like the local-turn path
  (`createHostStream`); it writes no pending reply row, because `finishHostTurn` saves the reply when the turn ends.
  It is called from the browser with the owner's bearer, not through the gateway; the stream token it returns is the
  same `createStreamToken`, but the web reads a host turn from the persisted stream, as every other reader does.
- `acp_*` calls spend no nonce. A lapsed claim redelivers the same envelope, which a persisted nonce would refuse, so the
  replay defence is the main process's receipt log, keyed by the signed call id, written before the command is acted on
  and kept until the envelope expires. The core checks (`acp_prepare`), the main process writes the receipt and acts,
  the core signs (`acp_sign`). A command is not persisted beyond its receipt: that is S7.
- Claim lease 30 s (`ACP_CLAIM_LEASE_MS`, a guess, to be set from the throttling measurement); the claim window gates only
  the first claim. Clocks are scheduled checks on one call (`acp/calls.ts`), not a sweep.
- Remote answers find the Rust-side request by the id the backend shows (`requestId` on the core's permission request).
  "Approve all" is the local window's bar and was built with S2; its test (a request that arrives after the bar is drawn
  is not answered) is `approve_all_answers_exactly_the_requests_named_each_with_its_own_option`.
- Not built here: attachments on `acp_send` (S8), a session id sent before the session opens (S7, built: see below), and the throttling
  measurement (harness in [acp-s4-throttling.md](acp-s4-throttling.md); not run).

**S5 — Registry.** Search and install from the official ACP registry, queried by
the desktop. Pinned versions, checksum verification, installs under the app data
directory, local consent for each install.
- Acceptance: a checksum mismatch is refused; publisher and version are shown
  before install; there is no automatic update.

**S5 as built:**
- Source: the registry the protocol publishes, `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
  (`{ version, agents[] }`; entry format `agent.schema.json` in `agentclientprotocol/registry`). Read by the
  desktop main process (`acp/registry.ts`) when the local window searches, with a 15 s deadline and a 5 MiB cap;
  nothing reads it at any other time.
- **Installable = a `binary` download for this platform with a published `sha256`.** The schema makes `sha256`
  optional (42 of 107 targets carry none on the day this was written), and `npx`/`uvx` entries carry none at
  all. Those are listed with the reason and cannot be installed: without a checksum there is nothing to verify,
  and an `npx` launch would run whatever the package manager resolves that day. `.tar.gz`, `.zip` and a bare
  binary unpack; `.tar.bz2` (4 targets) is refused with a reason.
- The window sends only an agent id and the version it listed. The main process takes the entry from its own
  snapshot (at most 15 minutes old, same version or "search again"), words a native confirmation from it
  (publisher, version, license, source, the checksum) and downloads only after a "yes", https only (also after
  redirects), 10 min deadline, 500 MiB cap, into a staging folder the core made.
- The core (`device-core/src/acp_install.rs`, reachable through the addon only, not `acp_update`) hashes the file
  and refuses a mismatch, unpacks refusing absolute paths, `..`, links and anything over 2 GiB / 20,000 entries,
  resolves the command inside the unpacked folder (a bare name never reaches PATH), sets the executable bit only
  then, renames into `<data dir>/acp-agents/<key>/<version>` and records the agent with an `install` pin
  (version, publisher, source, sha256). Registry `env` goes through the same checks as a typed variable and a
  program-changing name refuses the install. Only the pinned version stays on disk.
- An install approves no folder. Installing over an installed key is another explicit install and drops its
  folder approvals unless it is the same program (same command, arguments and verified archive checksum): a new
  version, or the same version republished with different bytes, loses them. A same-version reinstall moves the
  old folder aside until the new one is recorded and puts it back on failure. The old version's folder is pruned
  by a separate core call (`acp_install_prune`) the main process makes after it closed the sessions that lost
  their approval. A key registered by hand is never replaced. Saving a different command clears the pin and
  deletes the installed files; removing an installed agent deletes them too.
- The registry client mirrors the core's checks (version rule, program-changing variable names, argument and
  name limits, command inside the download) so such entries are listed as not installable with the reason; the
  core stays the authority. A search within a minute of the last filters that answer instead of fetching again.
  Installs are refused where coding agents cannot run (`acpSupported`).
- No update path: the registry is not compared with installed agents, there is no timer, and a newer version is
  a new install the user confirms. Tests: no fetch from registering the handlers, loading the view or waiting a
  week; the spawn plan keeps the recorded command and version until an install changes it.
- Not built: re-hashing the installed binary at spawn, `.tar.bz2`, uninstalling an old version separately, and
  archives that contain links: on `darwin-aarch64`, 2 of the 11 installable agents (a tar.gz with 2 link entries,
  another with 4) are refused by the unpacker until links are handled safely.

**S6 — Native session import and capability-driven controls.** Import an agent's
saved sessions as threads, with ids derived from (agent key, native session id).
- Acceptance: importing twice yields one thread; a missing capability hides its
  control.

**S6 as built:**
- Started from the local device window only (no `acp_*` kind, no public procedure, so no authz-matrix row). Each approved
  (agent, folder) row shows **Import sessions…** only when the agent's last handshake reported both `sessions.listNative`
  and `sessions.load` (`device/window/import-control.ts`, through `isAvailable`/`capabilityOf` of `@neore/ai/capabilities`).
  A report is kept per agent key in the main process (`AcpManager.allReports`), filled by every handshake (Check version, a
  started session), dropped when the agent's command changes or it is reinstalled. **No report hides the control**: the user
  runs **Check version** once per app start. The main process checks the report again and sends no `session/list` or
  `session/load` for an agent that did not advertise it (`acp/import.ts`).
- The mapping is `acp/capabilities.ts#reportFromHandshake` and covers the `sessions` group only: `loadSession === true` and a
  non-null `sessionCapabilities.list`. What the agent left out is `not_offered`; every other member stays unknown. It is also sent
  with every `session_open`, together with the agent's own session id (`nativeSessionId`).
- `session/list` is asked with the approved folder as `cwd`, and any entry for another working directory is dropped (the agent may
  ignore the filter). At most 10 pages and 200 sessions.
  An import lists the folder's sessions again and refuses an id that is not in the list, since the id comes from the window.
- `session/load` replays the history as `session/update`s (`acp/replay.ts`): each user message starts a turn, the agent's text and
  reasoning that follow belong to it. Tool calls are not kept, as for a live turn (a reply row holds text and reasoning). Text is
  masked with the user's variable values, cut to the backend's limits, and the first 1000 turns are kept. The window is told how many
  were dropped or shortened.
- **One thread per (user, agent key, native session id).** `import_open` (a session-level post) looks the triple up through
  `acpSessions.by_userId_agentKey_nativeSessionId` in the same mutation that inserts, and a shard runs one mutation at a time, so two
  imports, concurrent or a week apart, leave one thread. A session that ran here is found the same way, because a live session records
  its native id. The answer says `existing`, and `ended` when nothing more is wanted; the host then posts nothing else.
- The transcript follows as `import_turn` posts, 25 turns and about 150 KB at most, claimed by `importedTurns` (the position of the
  first turn in the post, as `(turnId, seq)` claims a live event): turns the backend holds are dropped, a post that starts past it
  answers 409 with `next`. `import_end` closes it. Rows go through `addMessagesHandler` and `buildHostReply`. An interrupted import
  resumes from `next`; the transcript is collected before the open, so a session that cannot be loaded leaves no empty thread.
- A session whose thread was deleted (soft or hard) or is gone is replaced by the next `import_open`, and the hard delete removes the
  session with the thread (`acp/functions.ts#deleteSessionsOfThread`), so a deleted import can be imported again, also when it was
  deleted mid-way. An unfinished import can be finished from another computer of the same user: the open hands the session over, and
  the first computer's later posts are refused. The host also stops keeping text at 8 million characters in all (turns past it count
  as dropped), so one hostile session cannot fill the main process.
- The imported session is `ended` (no agent runs for it) and keeps `nativeSessionId` for the native reattach of harness S4.
  `importState` (`importing` | `done`) is unset on a session that ran here, and such a session takes no import turns.
- Not built: import started from the web (a signed `acp_*` call), a re-import that refreshes a changed session, tool parts in
  imported replies, and discovery without **Check version** (the app never starts an agent on its own).

**S7 — Native child agents and early commands.** Early commands (§4.6) and §4.7
(child ownership, buffering, settling). Needs S4 and the subagents group of the
capability report. The host states and the retry rule moved to S3 and S4, because
mobile M2 needs them.
- Acceptance: a send issued before the session opens runs once it opens, and a
  send to a session that never opens, or one past its `expiresAt`, ends its stream
  with an error; a crash between the receipt and the apply loses no command (test:
  kill the main process after the receipt); a child event that arrives before its
  parent card is shown after the card appears, and nothing is shown twice; a child
  event past the byte budget is dropped and logged, not stored.
- The byte budget for child buffering is measured on a real child-heavy session
  before it is fixed.

**S7 as built:**
- **Early commands.** The backend no longer refuses a send to a `starting` session (`session_starting` is gone from `sendToHost`,
  `/hosts/send` and the web composer): the message, the `accepted` stream and the call are stored, and `touchSession` leaves a
  `starting` session `starting` (only `session_open` or a failed start leaves it; `session_open` then opens it `busy` when a
  stream is waiting). A start that is refused, expires, or whose agent never opens (`endUnopenedSession`) now also fails the
  held stream with "The agent did not start" (`endStartingSession`), instead of leaving it to the reaper.
- **The hold is the receipt log, not memory.** `acp/commands.ts` keeps a `start` or `send` receipt WITH its signed envelope
  until the command has been acted on (the file format gains the envelope and signature as entries 4 and 5; a cancel or an
  answer is not kept, since the turn or request it names does not survive a restart). `apply` answers `HELD` for a command it
  kept (a send for a session that is starting or not known yet; a start, until its agent has opened or failed); the call is
  acknowledged at once and `HostCommands.finished` removes the envelope later, so a sent prompt does not stay on disk.
  `HostCommands.recover()` runs at app start, before the poster's own recovery: it re-runs `acpPrepare` on each held envelope
  (consent revoked meanwhile, expiry), acts on starts first and sends after, and a delivery waits for it (a replay that fails is logged and does not
  hold the commands behind it). A held send past its `expiresAt` ends its stream with an error (`endLapsedTurn`); one whose
  session no replayed start will open ends `interrupted`, never runs (the session died with the process, and the message may have
  run before it). The poster reads the running turns left on disk BEFORE the replay, which opens channels and rewrites that
  file, and keeps them in the file until it has ended them. The window between acting on a command and writing "acted on"
  is not atomic: a process killed inside it acts twice.
- **`acp/early-sends.ts`** holds the message against its session (open sessions take it at once, ended ones refuse it). The
  thread comes from the signed envelope (`threadId`), so the turn's channel opens at once (`HostPoster.turnHeld`): the
  backend sees `received` and the reaper keeps hearing keepalives. The message goes in, in arrival order, when the session
  opens; it ends the stream with an error when the start fails, the envelope expires first (a timer, and a check at drain
  time for a computer that slept) or the turn is cancelled. A send for a session this computer has never heard of is held too,
  because the relay can claim the send before the start.
- **Child agents** (`acp/children.ts`, `child-updates.ts`, `masked-stream.ts`). The wire, checked in the Claude Code ACP
  adapter's published package (0.98.0): a client that declares `_meta["subagent-transcript"]` (or the newer `subagents`
  client capability, a draft with child sessions) gets the child's `session/update`s stamped with
  `_meta.claudeCode.parentToolUseId`, the id of the spawn call; an adapter that is not told to hide them forwards them
  flattened into the main feed all the same. **No agent advertises this in its handshake**, so the host cannot map
  `subagents.ownChildren` from what an agent said, and does not map it from its name: `reportFromHandshake` leaves the group
  `unknown`, which is unsupported. The path is built and tested behind that capability (`capabilityReport` on a session
  stands in for an agent that reports it), and shows nothing for real agents until a source for the report exists. The host
  also declares nothing new at `initialize`.
  What does change for every agent: an update stamped with a parent is now kept out of the parent's reply text and tools
  (it was appended to the reply before), whether or not children are shown.
  The ledger: a card exists once the spawn call was seen (the first sight of a tool call, after its own event is on the wire);
  an event that names a call that never appears makes no card; events before the card wait in one per-session buffer
  (provisional budget `CHILD_BUFFER_BUDGET_BYTES`, 512 KiB per session, at most 8 sessions: **pending measurement**, see [acp-s7-children.md](acp-s7-children.md) for the one real session measured, which never used the buffer); past
  it an event is dropped and logged, never stored; a spawn's terminal update ends its card once (a repeat and anything later
  are ignored), and its text is kept only when the child streamed none; text is masked with the user's variable values and
  held back like the agent's own.
- **Wire and storage.** Three event kinds, `child_text`, `child_tool` and `child_end` (all keyed by `spawnId`), in `vHostEvent` (so
  also the `persistentChunks.event` column; the schema-drift gate calls it additive). The reply keeps them as
  `providerMetadata.neore.subagentTranscripts` (one entry per spawn id: text, reasoning, tools, how it ended; at most 16
  children, 64,000 characters each), **not** as a `subagentTranscript` content part: host replies carry no tool parts (so there is
  no parent card in the saved message to hang a part on), and message content is strictly typed, so a new part type would reach
  the schema, `toUIMessages` and the UI. The backend applies the same once-only rules, so a redelivered post and a second end
  leave one transcript.
- **Not built:** rendering `subagentTranscripts` in the thread (nothing reads the metadata yet); the resume rule of §4.7
  (rebuilding ownership from stored spawn parts on session load needs the reattach of harness S4, which nothing does yet);
  a source for the `subagents.ownChildren` report; the byte budget measured on a real child-heavy session (S7's acceptance
  item for it is **pending measurement**: one run of three short children was recorded, peak 0; the live log line of a
  session's peak exists only for an agent that reports its children, so today the offline harness is the way to measure).

**S8 — Images and files from host agents.** §4.8. Needs S3 (persistence), the
device file operation, and the device-signed create on the upload route (new
backend work, listed in §4.8).
- Acceptance: an image the agent writes in the folder renders inline on desktop
  and on the phone; a Markdown reference to `../secret.png`, to an absolute path
  outside the folder, and to a symlink that leaves the folder each render as text,
  and no bytes are read (test); a file over the cap renders as a link with its
  size; a `.html` or script file is never an image; editing the file afterwards
  leaves the earlier message unchanged; an upload `PATCH` or `HEAD` signed by one
  device for another user's upload id is refused as not found, and a request with a
  stale device signature is refused.
- The size cap and the type allowlist are set from a measured sample of real agent
  output before S8 starts.

**S8 as built** (differences from the text above):
- **The cap and the types are provisional.** No sample of real agent output could be taken, so they are
  chosen, not measured, and stand in one pair of constants (`backend/lunora/acp/lib/constants.ts`,
  `packages/device-core/src/media.rs`, pinned equal by `media-limits.test.ts`): an image up to 8 MiB shows inline,
  a file up to 20 MiB is attached as a download (an image over 8 MiB, a PDF, `.txt`/`.log`, `.md`, `.json`), and a
  larger one is named with its size and not uploaded. PNG, JPEG, GIF and WebP only; SVG, HTML, scripts, stylesheets
  and XML are not on the list. A type is the file's bytes AND its extension agreeing. Set them from a sample and
  re-run the pin.
- **Only a Markdown image (`![](path)`) is looked at**, not a plain link and not a file a tool call reports as
  created (that is S9's evidence). An agent links existing files constantly, and a mention is not a request to
  upload one.
- **The route is `/hosts/uploads`, not `/uploads`.** The payload rides in a header (`neore-device-request`,
  base64url JSON) with its signature (`neore-device-signature`); the route checks the signed method, upload id, size,
  type, `Upload-Offset` and body hash against the request. `serveUserUpload` in `lib/upload-route.ts` is the shared
  inner handler, so a session, an API key and a device upload take one code path after authentication.
- **The ingest finalizes the upload.** The `media` event names an upload id; the ingest ACTION finalizes it for the
  device's verified owner and stores `fileId` and `storageKey` itself, only for events the stream does not have yet. A
  failed finalize leaves the file named and marked not attached; it never fails the post. The result is remembered
  per (owner, upload id), so a resend of a post whose answer was lost does not find the upload gone, and the device's
  ingest budget is spent before the finalize.
- **Left out:** attachments on `acp_send` (not in this slice's acceptance and not in the base), files a tool call
  reports as created (S9), Office documents as downloads, and a measured cap. The phone reads the same message
  parts; it was not run here.

**S9 — Turn changes.** §4.9. Needs S3.
- Acceptance: a turn that writes two files shows both with correct line counts; a
  file edited in the folder by something else during the turn is not listed; a
  later edit leaves the stored patch unchanged; a write outside the folder is not
  read; a patch over the cap keeps its file list.

**S9 as built** (differences from the text above):
- A file is recorded from a completed tool call only: ACP `diff` content (both sides are in the message, nothing is read;
  a call first seen already complete still counts), or an edit, delete or move call that names `locations` with no diff,
  whose earlier text is read when the call or its permission request first names the path and whose later text is read at
  completion (`apps/desktop/src/acp/changes.ts`). Declined, failed and cancelled calls, binary files, files over 1 MiB a
  side (in UTF-8 bytes) and a `locations` call first seen already complete (no earlier text exists to read) are left out.
  Every path is resolved against the approved folder, links followed, before anything is read or listed
  (`folder-files.ts`; the open uses `O_NOFOLLOW` and examines the open handle; a verbatim `\\?\` prefix on the core's
  folder is removed so Windows paths compare); the summary carries paths relative to the folder.
- Bounds: at most 200 paths (a dropped file gives its slot back), 16 MiB of text held, one snapshot read at a time that
  stops at the cap, and a diff budget for the turn (table cells, patch bytes): past it a file keeps its counts and loses
  its text, which makes the patch `{ tooLarge: true }`.
- The path rule is one predicate on both sides (`isSummaryPath` / `isFolderRelativePath`), applied on the text that is
  sent, after masking. An entry that fails it is left out; if the backend still refuses a post that carries a summary, the
  host sends the end of the turn again without it, so the reply is not lost.
- **The host's patch cap is 96 KiB, not 256 KiB.** A post is capped at 256 KiB whole and the `turn_end` event, escaped twice,
  must fit one post alone, so a 256 KiB patch could never be sent. The backend still accepts the plan's bounds (200 files,
  256 KiB patch); the host falls back to `{ tooLarge: true }` for the patch and then trims the tail of the file list until the
  event fits (`turnEndEvent`). `MAX_INGEST_BYTES` is unchanged.
- The summary is stored on the reply row as `providerMetadata.neore.hostChanges`, not as a new content part (which would reach
  model conversion on a fork), and reaches clients as `UIMessage.hostChanges`. The turn's `turn_end` chunk keeps no copy of it.
  A turn that only changed files still saves a reply.
- Not built: a rename shown as a rename (a move is a delete plus a create when both paths are named), and fetching the patch
  lazily on Open diff (it rides on the message).

Additions to earlier slices:
- S1 adds user-set environment variables (§6): a variable set for one agent
  reaches that agent and no other; a reserved name is refused; no value appears in
  a log line (test).
- S2 adds the approval bar and Approve all locally (§4.4).
- S4 adds the usage-limit stop and its offer (§6.1); it needs harness-switch S3
  for the switch itself and shows only the reason until then. Acceptance: taking
  the offer on a dispatch-started turn, and after a page reload, re-runs that turn
  on the new agent (test).
- S3 adds the `interrupted` end reason and S4 the Continue offer (§4.5).
  Acceptance: killing the desktop mid-turn ends the turn as `interrupted` on the
  next start; Continue sends a prompt that names the interruption; nothing is sent
  without the user's click.

## 9. Risks

- **Unsandboxed agent on the user's machine.** Mitigated by per-request prompts,
  no "Always allow" and the UI label; §10 Q1.
- **Hidden-window throttling** delays commands, and a hidden host can look
  offline once heartbeats slip. Measured in S3.
- **Protocol drift.** Version negotiation, and a clear "agent too old" error.
- **Third-party code.** Registry agents: publisher and version shown, checksums
  pinned, never auto-updated.
- **Windows.** No device sandbox and different process semantics. Ships after
  macOS and Linux, behind the same flag.

## 10. Open questions

1. **Sandbox ACP agents with network allowed?** Decided 2026-10-27: not in v1;
   agents run beside the sandbox (§6). Revisit with
   [sandbox-egress-allowlist.md](sandbox-egress-allowlist.md).
2. **Usage page bucket for host turns.** Recommendation: none in v1. Later, a
   count-only bucket with no cost.
3. **Registry queried from desktop or backend.** Recommendation: desktop, so the
   backend never sees the install choice. A backend proxy would need
   `fetchWithDeadline` (`backend/lunora/lib/fetch-timeout.ts`).
4. **`backgroundThrottling: false`.** Recommendation: keep throttling on unless
   the S3 measurement fails.
5. **Advertise the client-side terminal capability to agents?** If the desktop does,
   an agent's commands could run inside the device sandbox, which would change §6.
   Recommendation: no in v1. Check the spec at S1 before deciding.

## 11. Invariants crossed

Stated inline above: relay-only page and narrow remote start (§3), signed and
claim-once ingest with explicit owner checks (§4.2–4.3), and the module, policy
and output rules (§5.2). Two more: no secret ever travels in a queue payload or a
device-call payload, and the `turn` domain's HMAC vectors are pinned in both the
TS and the Rust tests.
