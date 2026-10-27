# Mobile control of hosts: host-run threads, approvals, offline cache

Status: plan, 2026-10-26. Part of [agent-host-roadmap.md](agent-host-roadmap.md).
The phone side of [acp-agent-host.md](acp-agent-host.md),
[ssh-environments.md](ssh-environments.md) and
[agent-orchestrator.md](agent-orchestrator.md).

## 1. Goal and decision

A phone shows the user's threads, including those run on a desktop or SSH host.
It can continue a host session, cancel a turn, answer an ACP permission request,
and see what is running. Its wider reach is limited to M6 (pull requests: list, and
merge after confirmation) and M7 (projects and files). It never runs an agent.

**Decision.** The phone is a control client only. It runs no agent, holds no
agent credential, stores no SSH key and pairs no device. It reads host-run
threads through the same queries and stream relay as any thread. Its commands go
to the backend, which queues them as signed device calls for the desktop's
relay. Approvals on the phone are approve once or decline, for ACP permission
requests only, with the full details shown. Offline, the phone shows a read-only
cache labelled with its sync time, and nothing is ever replayed.

## 2. Current state (checked)

- `apps/mobile/` is an Expo app with expo-router. Sign-in uses the extension
  grant. The thread list and message reads exist.
- `apps/mobile/src/chat/stream.ts` reads the gateway's NDJSON relay (shared line
  grammar from `@neore/chat-ui`), with resume. `plans/mobile-phase-4-slices.md`
  slice 2 tracks wiring it into the thread screen
  (`apps/mobile/app/chat/[threadId].tsx`).
- `packages/client-runtime/src/` already holds the shared client code:
  `live-queries.ts`, `ws-ticket.ts`, `shard-routing.ts`, `session-read.ts`,
  `token-refresh.ts`. The mobile app imports it (`apps/mobile/src/auth/`).
- Mobile push is not built. Web Push exists for browsers only
  (`backend/lunora/notifications/`). APNs and FCM are mobile slice 3.
- Device presence is `devices.lastSeenAt`, updated by the relay's 30 s
  heartbeat (`heartbeatDevice`, `backend/lunora/devices/functions.ts`).

## 3. Design

### 3.1 Reading

- A host-run thread is an ordinary thread with `runner: "host"`
  ([acp-agent-host.md](acp-agent-host.md) §5.1). The phone lists and reads it with
  the existing queries. A turn the phone sent streams through the gateway relay
  with the token from `/hosts/send`, read by `stream.ts`. A turn it did not send
  is read with the live queries `getActiveStreamForThread` and `getStreamBody`
  through `packages/client-runtime`, as the web does after a reload.
- **Host status** comes from `getHostSession` (session `status`) plus the device's
  `lastSeenAt`. "Online" means a heartbeat within 75 s (`DEVICE_ONLINE_WINDOW_MS`). A hidden desktop window
  may be throttled and look offline for a while; the phone shows "last seen
  <time>" rather than a hard "offline" until 5 minutes have passed.
- The phone never connects to a host. Everything it shows comes from the backend.
- Capability-gated controls (cancel, steer) read `getThreadCapabilities`
  ([provider-capabilities.md](provider-capabilities.md)) through the same rules
  as the web. `unknown` hides the control.

### 3.2 Sending, cancelling

1. The phone calls `POST /hosts/send` with a client request id. Cancel calls
   `cancelHostTurn`.
2. The backend checks ownership (`isDeviceEligibleThread`), that the thread is
   host-run, and that the session's device is paired.
3. The backend creates the user message, the pending reply and the stream, and
   queues an `acp_send` device call. The turn is `accepted`. The phone shows
   "Sending".
4. The desktop relay claims the call and the main process persists it. The turn is
   `received`, and only then does the phone change to "Waiting for the agent". The
   phone shows "Working" once the turn is `running`, never earlier.
5. Output reaches the phone through the stream relay. It never comes back in the
   call result.
6. If no relay claims the call before its deadline, the call expires, the turn
   ends with the error, and the phone shows "host did not answer". Nothing is
   queued on the phone or replayed later.
7. If the phone dies after step 1, the backend still delivers the call. On relaunch
   the phone reads the stream state. It replays nothing.
   ([acp-agent-host.md](acp-agent-host.md) §4.6, the host states.)

A retried send with the same request id is one send (claim-once on the request
id at `/hosts/send`).

### 3.3 Starting a session

The phone may start a session only from the device's **offers**: (agent, folder)
pairs already approved in a local window (`devices.acpOffers`). The picker shows
offer labels only. The phone cannot add an agent or a folder, and Rust refuses
any pair not in its store even with a valid signature.

### 3.4 Approvals

- **ACP permission requests** appear as an approval card in the thread. The card
  shows the tool, the full target path or command, the folder and the host. A
  request whose details are truncated or missing cannot be approved; only decline
  is offered.
- The card offers **Approve once** and **Decline**. These map to the agent's
  allow-once and reject option ids, passed back unchanged. No "Always allow"
  exists on any client for ACP in v1.
- The answer is a typed command: `answerHostPermission` with the request id and
  the option id, queued as `acp_permission_answer`. Chat text typed on the phone
  is a prompt and never answers a request.
- The first answer wins, from the phone, the web or the desktop's local window.
  A late answer shows "already answered on <device>", and the local prompt
  closes when a remote answer lands.
- **Device-tool approvals** (Neore's own `shell_run`, `fs_write`, ...) are never
  answerable on the phone. They stay in the desktop's local window, as the device
  model requires.

### 3.5 Offline cache

- A read-only cache in `expo-sqlite`: the thread list, the last 50 messages of
  the 20 most recent threads, and host and worker status. Each row carries
  `syncedAt`.
- Every cached screen shows "Last synced <time>". A cached running session shows
  "last seen", never "running".
- While offline, the composer, approve, cancel and start controls are disabled.
  Nothing is written locally for later sending, and reconnecting only refreshes.
- Sign-out drops the cache.

### 3.6 Running rail

- A rail lists the user's active host turns and worker runs:
  `listHostSessions` with status `busy`, plus `listActiveWorkerRuns`
  ([agent-orchestrator.md](agent-orchestrator.md) §5). It adds no new store.
- Tapping a row opens its thread.

### 3.7 Pull requests

- A list of the pull requests opened by the user's host turns and cloud coding
  runs. It is a query over runs that recorded a PR URL. Each row shows title, branch,
  check status and review state.
- **Merge is an outward action.** The control opens a confirmation that names the
  PR title and the target branch. A swipe only opens that confirmation; a merge
  cannot happen in one gesture.
- The backend has no merge call today. Coding runs create PRs and nothing more. A
  merge is a new GitHub write, and the coding-agents connection must request a
  token scope for it. Until that scope exists, the merge control is hidden and the
  PR is read-only.
- A merge is refused when a required check is failing or a review is required, and
  the refusal gives the reason. Overriding a refusal is desktop-only.

### 3.8 Files and projects

- A file a host agent writes into a thread becomes a file part. The desktop main
  process uploads the bytes itself with a device-signed create, and the page is not
  in that path (ACP §4.8). Bytes never ride in an RPC body (`CLAUDE.md`, storage). The device-signed
  ingest carries metadata only. The phone shows and downloads the file through a
  signed URL from `ctx.storage.getSignedUrl`.
- Projects: `createProject` already exists (`backend/lunora/projects/functions.ts`,
  an `authMutation`). The phone calls it. The project list is a live query, so
  web and phone update together.
- A photo or document attached on the phone goes through the same upload route as
  the web app.

## 4. Touchpoints

Backend (defined in other plans, except the M6 pull-request list and merge, which
this plan adds, and the M7 file reads, which go through the ACP S8 signed-URL path):

- `backend/lunora/acp/`: `/hosts/send`, `cancelHostTurn`,
  `answerHostPermission`, `startHostSession`, `listHostSessions`,
  `getHostSession`.
- `backend/lunora/devices/functions.ts`: `heartbeatDevice` and `listDevices` for
  presence.
- `backend/lunora/sub-agents/functions.ts`: `listActiveWorkerRuns`.

Mobile:

- `apps/mobile/src/chat/`: host send, cancel and approval calls next to
  `chat-api.ts`; host turns streamed with `stream.ts`.
- `apps/mobile/app/chat/[threadId].tsx`: approval card, host status line,
  capability-gated controls.
- `apps/mobile/src/lib/`: the offline cache.
- `packages/client-runtime/src/`: any query helper both web and mobile need goes
  here, not into the app.

## 5. Slices

**M1 — Read host-run threads.** Needs mobile slice 2 and ACP S3.
- Acceptance: a thread run on a desktop appears in the phone's list and streams
  while the desktop runs it; the list matches the web app's for the same account;
  host status reads "last seen" after the desktop quits.

**M2 — Continue and cancel.** Needs ACP S4.
- Acceptance: a prompt from the phone reaches the agent and its reply streams
  back; the same request id twice sends once; with the desktop quit the send
  fails with "host did not answer" and nothing runs when the desktop returns;
  cancel ends the turn with no tool call left running; the phone shows "Sending"
  until the host has received the turn, and "Working" only after it runs (a test
  holds the call unclaimed and checks the label); a phone killed right after the
  send still gets the reply on relaunch, with no second send.

**M3 — ACP approvals.** Needs ACP S4. Timely only with push (§9 Q1).
- Acceptance: approve once and decline work end to end; no "Always allow" option
  is rendered; a request with truncated details offers decline only; an answer
  after the desktop answered shows "already answered"; a device-tool approval
  never renders an approve button.

**M4 — Offline cache.** Cached rows never overwrite newer live data, and a row missing from the cache never proves it was deleted.
- Acceptance: in airplane mode the last synced list and messages show with their
  sync time; every write control is disabled; reconnecting refreshes and sends
  nothing that was not sent before; sign-out empties the cache.

**M5 — Running rail and start from offers.** Needs orchestrator S2 and ACP S4.
- Acceptance: the rail shows the user's active host turns and worker runs and
  empties as they finish; the start picker lists only offered pairs; a start for
  a pair revoked on the desktop is refused.

**M6 — Pull requests: list and merge.** Needs the new GitHub merge scope. `listPullRequests` (authQuery) and `mergePullRequest` (authMutation) each get an authz-matrix row. The merge is claim-once on the request id (scope `pr-merge`), and both GitHub calls carry a deadline (`fetchWithDeadline`). A host turn's PR URL is recorded from the `gh pr create` output in its tool result, so the list can show it.
- Acceptance: a PR opened by a host turn lists with its checks; no merge happens
  without the confirmation (UI test); a PR with a failing required check refuses
  the merge and shows why; a merge request id merges once.

**M7 — Files and projects.** M7a (projects) needs nothing new. M7b (files a host
agent wrote) needs ACP S8. A file the phone attaches itself still goes through the
upload route, with the phone's own session, as in §3.8.
- Acceptance: a project created on the phone appears on web within the live-query
  window; a file written by a host agent appears in the thread and downloads through
  a signed URL that expires; no mutation argument carries file bytes (test).

## 6. Invariants

- No agent process, agent credential, SSH key or device pairing on the phone.
- Prompts from the phone never change consent and never answer a permission.
- Approvals: ACP only, approve once or decline, full details, first answer wins.
- No offline replay. Every command carries its own request id.
- No provider-name checks in mobile UI. Controls follow capabilities.
- A merge needs a confirmation the user takes, and is never a single gesture.
- File bytes travel through the upload route, never in a mutation argument.

## 7. Parity with the desktop

The 28-row feature matrix lives in `plans/desktop-and-mobile-apps.md` §7.
This plan adds host rows: host-run threads (read, continue, cancel), host status,
ACP approvals, start from offers, offline cache, running rail. It also adds
pull-request listing and merge (§3.7), file receipt from host agents, and project
creation (§3.8). Device execution, SSH host setup, agent install and host pairing
stay desktop-only.

## 8. Risks

- **Streaming markdown on React Native** is unsolved
  (`plans/desktop-and-mobile-apps.md` §8). It is the main risk for M1, and
  this plan does not reduce it. **Decided 2026-10-26: the mobile app stays on Expo.**
  The gate is the frame-time measurement in `mobile-phase-4-slices.md` slice 2
  (p95 under 33 ms on a 50-message thread, mid-range Android). If that measurement
  fails, the choice of a native shell over a shared Rust layout core is reopened as
  a new owner decision, not taken silently.
- **Live-query budget.** Host status and the rail add subscriptions. Fold them
  into one composite query per screen rather than one subscription per host.
- **Background suspension.** Without push, an approval waits until the user opens
  the app. The card says so.
- **Stale presence.** Throttled heartbeats on a hidden desktop make a host look
  idle. §3.1 softens "offline" to "last seen".

## 9. Open questions

1. **Push for approvals and finished runs** (mobile slice 3). Recommendation:
   ship M3 after push, or ship it with a visible "open the app to see requests"
   note.
2. **Phone-only users.** A user with no desktop cannot run ACP agents. No cloud
   runner is planned (roadmap §7). Recommendation: say so in the empty state of
   the host list.
3. **Cache size.** Recommendation: 20 threads and 50 messages each. Revisit after
   M4 measures storage on a low-end device.
