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
- `turn_start` with a `hostTurnId` that already exists is dropped.

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
  arrive after the timeout are dropped. Every ingest moves `expiresAt` forward.
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
- **Size and type.** A size cap and an allowlist of image types, both set in S8. A
  file over the cap is shown as a download link with its size, not as an image.
- **Transport.** The bytes never pass through the page. The main process reads
  them through the device file operation and uploads them itself. This needs a
  device-signed create on the upload route (`lib/upload-route.ts`), which today
  accepts a session bearer or an API key, never a device signature: the create is signed with the device
  secret, names the folder file, and is checked against the device's user. The
  chunked upload then follows as usual. The ingest carries only the resulting
  upload id, and the mutation checks that the upload belongs to the device's user.
  This adds backend work to S8. The phone reads the same file through a signed URL
  ([mobile-acp-and-remote-control.md](mobile-acp-and-remote-control.md) §3.8).
- **Staleness.** The reference names the file. Editing the file later does not
  change an earlier message, because the message keeps the upload it was saved with.

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
  sessions appear in their export.
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
  streaming with the window hidden for an hour, or the measurement is recorded
  and §10 Q4 decided; a turn whose events stop times out within the reaper window
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
  local prompt; the phone shows "Sending" until `received` and "Working" only from
  `running` (UI test); a claim failing with a server error and then a network reset
  is retried until it succeeds.

**S5 — Registry.** Search and install from the official ACP registry, queried by
the desktop. Pinned versions, checksum verification, installs under the app data
directory, local consent for each install.
- Acceptance: a checksum mismatch is refused; publisher and version are shown
  before install; there is no automatic update.

**S6 — Native session import and capability-driven controls.** Import an agent's
saved sessions as threads, with ids derived from (agent key, native session id).
- Acceptance: importing twice yields one thread; a missing capability hides its
  control.

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

**S8 — Images and files from host agents.** §4.8. Needs S3 (persistence), the
device file operation, and the device-signed create on the upload route (new
backend work, listed in §4.8).
- Acceptance: an image the agent writes in the folder renders inline on desktop
  and on the phone; a Markdown reference to `../secret.png`, to an absolute path
  outside the folder, and to a symlink that leaves the folder each render as text,
  and no bytes are read (test); a file over the cap renders as a link with its
  size; a `.html` or script file is never an image; editing the file afterwards
  leaves the earlier message unchanged.
- The size cap and the type allowlist are set from a measured sample of real agent
  output before S8 starts.

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

1. **Sandbox ACP agents with network allowed?** Recommendation: not in v1. Revisit
   with [sandbox-egress-allowlist.md](sandbox-egress-allowlist.md). Owner's call;
   it is a security decision.
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
