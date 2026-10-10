# Device execution — agent tools that run on the user's own computer

Status: **approved, implemented** (LobeHub gap #15). The lead's review added
§3.8 (taint), the folder picker (§5) and the flood caps (§3.9).

LobeHub's desktop app installs local MCP connectors, gives the agent a terminal
and local-file context, and can pair a browser tab as a device. This plan brings
the first three to Neore through the Tauri shell (`apps/native`).

This is **remote code execution on the user's machine, triggered by a language
model that reads untrusted text.** Every decision below is taken from that
starting point: the model, the web page, the network and the backend are each
assumed capable of asking for something harmful, and the last word is always
the person sitting at the device.

## 1. Terms

| Term          | Meaning                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| device        | One paired install of the desktop shell, for one user. Row in `devices` (per-user shard).                                         |
| device secret | 32 random bytes shared by the backend and the device's Rust core. Signs every call and every result. Never readable by the page. |
| device tool   | A tool the device advertises in its signed manifest: `fs_list`, `fs_read`, `fs_write`, `shell_run`, or `mcp__<server>__<tool>`.  |
| call          | One invocation of a device tool by an agent run. Row in `deviceCalls` — also the audit log.                                      |
| page          | The deployed web app in the shell's main window. A **dumb pipe** between backend and Rust; it can neither forge nor approve.      |
| approval UI   | A LOCAL Tauri window (`device`, bundled HTML like the Quick Composer) the remote page cannot script or call into.                |

## 2. Relay

No new socket and no new Durable Object. The relay is a **mailbox on the user's
own shard**, driven by the live-query socket the page already holds.

```
agent run (jobs queue, owner's shard)            page (main window)                Rust core
─────────────────────────────────────           ──────────────────                ─────────
tool.execute(input)
  insert deviceCalls {pending, sig}  ───live──►  listPendingDeviceCalls
                                                 claimDeviceCall ──mutation──►
                                                 invoke device_execute(envelope) ─► verify HMAC, expiry, nonce
                                                                                    approval window (unless allow rule)
                                                                                    run, cap output, sign result
                                                 completeDeviceCall(result,sig) ◄── return
  poll row (250 ms → 2 s backoff)  ◄──
  verify result HMAC, return to model
```

- **Where it runs.** Device tools are offered only in a run whose user OWNS the
  thread (see §3), so the run, the `devices` row and the `deviceCalls` row are
  all on that user's shard, which is also where the page's socket lands by
  default (`withCallerShard`). No cross-shard hop exists.
- **Presence.** The page calls `heartbeatDevice` every 30 s while the shell is
  open (and on focus). A device is **online** when `lastSeenAt` is under 75 s
  old. Tools are built only for online devices, so an offline device is simply
  absent from the tool set; the model never sees a tool it cannot reach.
- **Call lifecycle** (`status`): `pending` → `claimed` (device took it, awaiting
  approval / running) → `completed` | `failed` | `denied` | `expired`. A
  `claimed` call also carries a `phase` from the device's SIGNED progress
  reports (§3.4): `prompting` (the approval window shows it) → `running`
  (approved, or allowed by a rule, and executing). Forward-only, display only.
  `claimDeviceCall` is claim-once (status check in the mutation), so two windows
  of the same shell — or a stale page — cannot both run it.
- **Timeouts.**
  - not claimed within **20 s** → `expired`, tool result "device offline".
  - claimed but not finished by `deadline` (**5 min**: approval wait + run) →
    `expired`. The device refuses envelopes past their `expiresAt`, so a late
    approval can never run a call the model has already given up on.
  - shell commands have their own run timeout (**60 s** default, max 10 min —
    still inside the queue's 15 min wall time), MCP calls **120 s**.
  - The run's abort signal (user pressed Stop) marks the call `expired` too.
  - A cron-free reaper: the tool itself writes the terminal state when it gives
    up; the per-shard housekeeping sweep expires any row a killed run left
    `pending`/`claimed` past its deadline.
- **Why polling, not pause-and-resume.** A pause would reuse the tool-approval
  continuation, but a device call is short (seconds) and the queue job already
  has the budget; backoff polling costs ≤ ~40 shard reads per call worst case
  and keeps the agent loop linear. Revisit if calls routinely wait minutes.
- **Tool manifest.** On pairing and whenever it changes (roots edited, MCP
  server added, a stdio server's `tools/list` changes) Rust produces a manifest
  `{ tools: [{ name, description, inputSchema, kind, readOnly }] }`, signed with
  the device secret; the page forwards it to `updateDeviceManifest`, which
  verifies the signature and stores it. Caps: 64 tools, 2 KB description,
  16 KB schema per tool, 256 KB total.

## 3. Security model

### 3.1 Who can cause a call (server side)

Device tools are added by `buildAgentTools` only when **all** hold — checked in
one internal query (`devices_functions.getDeviceToolContext`) against the
thread, not trusted from arguments:

1. the run is **interactive** (`headless` unset) — see §3.6;
2. the run's `userId` **owns** the thread (`thread.userId === userId`);
3. the thread has **no collaborators** — no `threadAccess` grant, not a group
   thread (group turns never call `buildAgentTools` with device tools), not
   public — so no other person's text is in the context that picks the call;
4. the device belongs to the same `userId`, is not revoked, and is online.

A collaborator in someone else's thread therefore never sees even their OWN
device tools there, and the owner's devices are never reachable from a
collaborator's turn. Sub-agent children, triggers, tasks, evals, messenger and
workflows are headless and get none.

Every device procedure is owner-only: `deviceId` from args is always compared to
`ctx.auth.userId` (RLS policy `owner` on both tables as defence in depth).

### 3.2 Pairing and revocation

1. In the shell, Settings → Devices → **"Use this computer for agent tools"**.
2. `registerDevice({ name, platform })` (rate-limited 5/hour) creates the row and
   returns `{ deviceId, secret }` **once**; the secret is stored encrypted
   (`lib/encryption.ts`, same as BYOK keys) because the backend must sign with it.
3. The page invokes `device_pair({ deviceId, secret, accountLabel, origin })`.
   Rust opens the LOCAL approval window: _"Allow Neore account <label> to request
   actions on this computer? Every action will ask you first."_ Only a click
   there stores the pairing (app data dir, file mode 0600). Declining calls
   nothing back; the page then calls `revokeDevice`.
4. After that Rust never returns the secret to anyone.

Revocation, either side:

- **Web** `revokeDevice` sets `revokedAt` and wipes the secret: no new call can
  be signed, pending calls are expired. Works from any browser (lost laptop).
- **Device** "Unpair" in the local settings window deletes the local pairing;
  every later envelope is refused as "not paired". The page then revokes too.

**The secret passes through the page exactly once** (`registerDevice`'s answer
→ `device_pair`). A script running in the page AT that moment sees it. That is
accepted because (a) it still cannot approve anything — every call needs a
click in the local window (§3.3) — and cannot create an allow rule; (b) pairing
itself only completes on a local confirmation click; (c) either side can revoke,
and a web revoke wipes the server copy so nothing more is ever signed with it; and
(d) a later compromise of the page cannot learn it, because Rust never hands it
back. The alternative — the device generating an Ed25519 key pair and the server
holding only the public key, with the server signing calls under its own key —
removes even that window, but needs asymmetric crypto crates on the Rust side.
It is **deferred**, not rejected: swap the HMAC for signatures without changing
the relay if the threat model tightens.

### 3.3 Approval on the device

- **Every call needs an approval in the local approval window**, which shows:
  the thread title, the tool, the full arguments (pretty-printed; for
  `shell_run` the exact command line and working directory, for `fs_write` the
  path and a size + head of the content), and **Deny / Allow once /
  Always allow this tool**. It comes to the front with a system notification.
  Unanswered by the envelope's `expiresAt` → denied.
- **Allow rules live ONLY in Rust**, keyed `<tool name>` per pairing, and can be
  set ONLY from the approval window or the local settings window. Neither the
  page nor the backend can create one, so no server compromise, prompt
  injection or XSS can turn a prompt into a silent run.
- **`shell_run` and `fs_write` cannot be always-allowed** in v1 — the button is
  not offered — and neither can ANY tool when the call is tainted (§3.8).
  Allow rules make sense for `fs_list`, `fs_read` and MCP tools the user
  trusts.
- The server-side permission layer still applies first: a device tool the user
  set to `off` in Settings → Tools is removed. Its server default is `auto`
  (the device prompt IS the approval; a second chat-side prompt would ask twice).
  Key: `device:<deviceId>:<tool>`, source `"device"`.

### 3.4 Envelope integrity

Server → device envelope:
`{ callId, deviceId, tool, input, threadTitle, issuedAt, expiresAt, nonce }`
plus `sig = HMAC-SHA256(secret, canonical JSON)`. Rust checks: paired deviceId,
signature (constant time), `expiresAt` not passed and ≤ 10 min ahead, nonce not
seen (in-memory set, pruned at expiry). So the page can relay but cannot invent,
alter or replay a call — even for an always-allowed tool.

Device → server result: `{ callId, ok, output, truncated, exitCode? }` signed
the same way; `completeDeviceCall` verifies before accepting, so a page script
cannot feed the model a fabricated result either.

Device → server progress: `{ v, kind: "progress", callId, deviceId, phase,
issuedAt }`, domain `neore-device:progress:v1`, emitted by Rust as the
`neore:device-progress` event to the main window when the approval prompt is
queued (`prompting`) and just before the action runs (`running`). The page
relays it to `reportDeviceCallProgress`, which verifies the HMAC, freshness
(10 min) and the call id, and only moves a `claimed` call's `phase` forward.
It is what the chat shows ("Waiting for approval on …"); nothing decides on it,
and no report can end a call. The vectors for all four domains are pinned on
both sides.

HMAC-SHA256 is implemented over the `sha2` crate already in the lockfile (pinned
by RFC 4231 test vectors) — **no new crate**.

### 3.5 Filesystem, shell and MCP limits

- **Roots.** `fs_*` and `shell_run`'s cwd are confined to folders the user added
  in the local settings window. Paths are canonicalised (symlinks resolved) and
  must stay under a canonical root; `..`, absolute paths outside roots, device
  files and a symlink escaping a root are refused. No roots → the fs/shell tools
  are not in the manifest.
- **Output caps.** Rust caps every result at **64 KiB** (UTF-8 safe, `truncated:
  true`); `fs_read` reads at most 1 MiB and returns the first 64 KiB; the
  backend re-caps whatever arrives (never trusts the device's count) and stores
  at most 64 KiB in `deviceCalls.output`.
- **Shell.** `shell_run({ command, cwd?, timeoutMs? })` runs via the user's shell
  (`sh -c` / `cmd /C`) as the user, with a timeout, stdin closed and the process
  group killed on timeout. Never always-allowable. It runs in an **OS sandbox**
  (`device/sandbox.rs`): writes only in the shared folders and a private
  per-run `$TMPDIR` (which also receives the common cache variables:
  `XDG_CACHE_HOME`, `npm_config_cache`, `PIP_CACHE_DIR`, `UV_CACHE_DIR`,
  `GOCACHE`, `GOMODCACHE`, `YARN_CACHE_FOLDER`, `BUN_INSTALL_CACHE_DIR`, unless
  already set inside a shared folder); reads only system folders and a fixed list of per-user
  toolchain folders; the rest of `$HOME` is invisible. Network is NOT
  restricted. Linux uses Landlock (best effort across ABIs; no Landlock → no
  sandbox) with `PR_SET_NO_NEW_PRIVS`, macOS `sandbox-exec` with a generated
  profile, Windows has none (a kill-on-close Job Object, reported unsandboxed).
  The Rust-side setting "Require sandbox for shell commands" (default ON)
  refuses the call where the OS cannot sandbox; turned off, such a call runs
  unconfined. The prompt's first line says which, before the user approves.
- **Local MCP (stdio).** Servers are configured ONLY in the local settings window
  (command, args, env). Adding one shows the exact command line for
  confirmation. The page can never add, edit or start one. Rust spawns lazily on
  first use, speaks JSON-RPC 2.0 over stdio (hand-rolled: `initialize`,
  `tools/list`, `tools/call` — no new crate), kills it after 10 min idle and on
  exit, restarts once on crash, drains stderr to a capped log. Tool names are
  `mcp__<server>__<tool>` sanitised to `[a-z0-9_]`.
- **Mobile** has none of this (`cfg(desktop)`); the shell simply never pairs.

### 3.6 Headless runs

Denied. `resolveToolPermission` treats source `"device"` like a tool needing a
person: removed whenever `headless` is set, whatever the user's mode, and
`headlessApproved` cannot re-admit it. Triggers, tasks, evals, messenger,
workflows and sub-agents never reach a device. An opt-in is out of scope (§8).

### 3.7 Audit

- **Server:** every `deviceCalls` row is the audit record (tool, input, status,
  approval outcome, output head, timings, thread). Visible under Settings →
  Devices → activity; pruned after 30 days by the per-shard housekeeping sweep.
  GDPR export/delete covers both tables.
- **Device:** Rust appends one JSON line per decision/run to
  `<app data>/device-audit.jsonl` (rotated at 5 MB), readable from the local
  settings window — the record that survives a compromised backend.

### 3.8 Taint: calls that follow untrusted content

The backend computes `taintedBy` for every call from the messages the model saw
before it (AI SDK `ToolExecutionOptions.messages`): a result of a web/search/
fetch/browser built-in → `web`; `knowledgeSearch` → `knowledge`; an MCP or
connector tool → `mcp`; an earlier device tool → `device`; a file part in a user
message → `files`; anything unrecognised → `web` (fail closed). Only built-ins
whose output is our own (documents, dates, the user's `askUser` answer, …) are
exempt. The list is part of the SIGNED envelope, so the page cannot strip it.

When it is non-empty the approval window shows a warning ("This request follows
content from the web / external tools — check it carefully") and **never offers
"Always allow"**, and an existing allow rule does NOT skip the prompt. Messenger
text never reaches a device at all (messenger runs are headless, §3.6).

### 3.9 Flood caps

- at most **3** open (`pending` + `claimed`) calls per device — a fourth is
  refused with "the device is busy";
- at most **20** device calls per agent run (per tool-set build — a run resumed
  after a chat-side approval starts a new count);
- plus the per-user `devices/call` rate limit (60/min).

A looping model therefore cannot stack up approval prompts.

## 4. Backend

- **Tables** (both per-user shard, RLS `owner`, decided in `policies.ts`):
  - `devices`: `userId`, `name`, `platform`, `encryptedSecret?`, `manifest?`,
    `manifestUpdatedAt?`, `lastSeenAt?`, `revokedAt?`, `createdAt`.
    Index `by_userId`.
  - `deviceCalls`: `userId`, `deviceId`, `threadId`, `toolName`, `input`
    (capped 32 KB), `status`, `envelope`, `claimedAt?`, `completedAt?`,
    `deadline`, `output?`, `truncated?`, `exitCode?`, `error?`, `phase?`,
    `phaseAt?`, `toolCallId?`, `createdAt`.
    Indexes `by_deviceId_status`, `by_userId_createdAt`, `by_userId_toolCallId`.
- **Procedures** (`backend/lunora/devices/`): `registerDevice`, `revokeDevice`,
  `renameDevice`, `listDevices`, `heartbeatDevice`, `updateDeviceManifest`,
  `listPendingDeviceCalls` (live), `claimDeviceCall`, `completeDeviceCall`,
  `releaseDeviceCall` (the shell refused the envelope itself — fail the call
  now instead of at its deadline; unsigned, it can only stop the caller's own
  claimed call), `reportDeviceCallProgress` (signed phase, §3.4),
  `getDeviceCallByToolCall` (the chat row's live status), `listDeviceCalls` — all `authMutation`/`authQuery` with `.output()`, rows in
  `docs/security/authz-matrix.md`. Internal: `getDeviceToolContext`,
  `createDeviceCall`, `getDeviceCall`, `expireDeviceCall`, sweep.
- **Tool proxy** (`chat/lib/device-tools.ts`): builds one AI SDK `tool()` per
  manifest entry, runtime name `device_<short id>__<tool>`, descriptor source
  `"device"`, and `execute` = create call → poll → verify → return
  `{ output, truncated, exitCode }` or a clear error string ("the device is
  offline", "denied on the device", "timed out"). Wired in `buildAgentTools`
  (which gets `threadId`), so interactive runs and approval continuations see
  the same set.
- **Rate limits:** `devices/register` 5/h, `devices/call` 60/min per user,
  `devices/heartbeat` 4/min per device, `devices/manifest` 30/h.
- **Billing:** device calls use no paid service; they cost nothing beyond the
  model tokens the run already pays for. No credits are charged per call.

## 5. Native shell (`apps/native`)

- **New remote commands** (added to `build.rs`'s manifest and the runtime
  `remote-app` capability): `device_status`, `device_pair`, `device_manifest`,
  `device_execute`, `device_open_settings`. That is the whole remote surface;
  none of them returns the secret, and none can approve or change settings.
- **New local window** `device` (bundled `src/device.html`), capability
  `capabilities/device.json` with LOCAL-only commands: `device_prompt_current`,
  `device_prompt_answer`, `device_settings_get`, `device_settings_update`
  (roots, MCP servers, removing allow rules, unpair), `device_pick_folder`,
  `device_audit_tail`. The remote
  page cannot reach these (different window + local-only capability).
- **Modules:** `device/mod.rs` (state, pairing store), `device/hmac.rs`,
  `device/envelope.rs` (verify/sign/nonce), `device/fs.rs` (roots + ops),
  `device/shell.rs`, `device/mcp.rs` (stdio client + process manager),
  `device/approval.rs` (pending prompts, window). Rust unit tests: HMAC vectors,
  envelope verify (bad sig, expired, replay, unknown device), root confinement
  (`..`, symlink escape), output capping at a char boundary, allow-rule
  exclusions for shell/write, MCP JSON-RPC framing against a fake server.
- **One new crate: `tauri-plugin-dialog`**, for the folder picker. It is driven
  from Rust (`device_pick_folder`, a command only the local `device` window may
  call), so no window — local or remote — holds a `dialog:*` permission at all.
  A typed path stays as the fallback. Everything else (`sha2`,
  `base64`, `getrandom`, `serde_json`, std process/threads) was already there.

## 6. Web (`apps/web`)

- `lib/native/bridge.ts`: `nativeDevice.{status, pair, manifest, execute,
  openSettings}` — feature-detected no-ops outside the shell.
- `features/devices/`: `DeviceRelay` (mounted in the shell only, after first
  paint: heartbeat, manifest sync, `listPendingDeviceCalls` live query → claim →
  `device_execute` → complete), and Settings → **Devices**: list with online
  state, rename, revoke, per-device recent activity, and in the shell a pair
  button plus "Open device settings".
- Chat: device tool calls get their own row (`DeviceToolCall`, a chat-ui
  component slot picked by the `device_<tag>__<tool>` runtime name): device
  icon and name, the tool, and a live status line with `role="status"` —
  "Waiting for <device> to pick this up", "Sent to <device>", "Waiting for
  approval on <device>", "Running on <device>", then "Done / Denied / Failed on
  <device>" or "Expired — <device> didn't answer". While the tool part is in
  flight the row subscribes to `getDeviceCallByToolCall` (the tool stores the AI
  SDK `toolCallId` on the row); once it returned, the outcome comes from the
  tool output's `status`, so no finished call opens a subscription. The
  device's name comes from the MCP-style label (`mcpLabels`, device as the
  "server") once the run is saved, and from the live row before that.
- Translations in all 8 locales. No new first-paint query: the relay's live
  query only mounts inside the shell, after first paint.

## 7. Implementation order

1. Rust core: hmac/envelope/fs/shell/mcp/approval + tests.
2. Schema, policies, procedures, sweep, authz rows, rate limits.
3. Tool proxy + `resolveToolPermission` (`"device"`) + `buildAgentTools` wiring
   and tests (routing, eligibility gate, headless removal, offline/timeout,
   result signature, caps).
4. Web bridge, relay, settings UI, i18n.
5. `CLAUDE.md` "Native shell", `apps/native/README.md`.

## 8. Out of scope (v1)

- Pairing a **browser tab** as a device (a tab cannot run processes; it could
  only offer page context — separate feature).
- Headless / background use of devices (would need a device-side standing
  policy with its own consent design).
- OS-level sandboxing of local MCP server processes, a Windows shell sandbox
  (AppContainer), and network restriction for `shell_run`.
- Device tools in shared, group or public threads.
- Remote MCP servers proxied through the device (network from the user's LAN).
- Streaming partial output of long commands into the chat.
- Mobile.
