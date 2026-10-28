# Agent host roadmap: ACP, SSH, orchestration, outside agents, mobile control

Status: **plan only, nothing started**, 2026-10-26. This file is the index for ten
plans. It holds the decisions they share, the order to build them in, what was
rejected, and the questions the owner must answer before a first slice starts.
Each plan repeats only the parts of these decisions it builds on.

## 1. Ranked plans

Ranked by value to users against cost and risk. "Size" is engineering effort:
M is two to four weeks for one engineer, L is five to eight.

| Rank | Plan | File | Size | Hard dependencies |
| --- | --- | --- | --- | --- |
| 1 | Provider capabilities | [provider-capabilities.md](provider-capabilities.md) | M | none |
| 2 | ACP agent host (desktop) | [acp-agent-host.md](acp-agent-host.md) | L | capabilities S1 |
| 3 | Outside-agent MCP server | [outside-agent-mcp.md](outside-agent-mcp.md) | M | none for S1; ACP S3 for the host-thread refusal test |
| 4 | Orchestrator: persistent workers | [agent-orchestrator.md](agent-orchestrator.md) | L | capabilities S1; ACP S4 for host workers |
| 5 | SSH remote hosts | [ssh-environments.md](ssh-environments.md) | L | device execution (shipped); ACP S3 for ACP over SSH |
| 6 | Mobile control of hosts | [mobile-acp-and-remote-control.md](mobile-acp-and-remote-control.md) | M | mobile slices 1–2 (`mobile-phase-4-slices.md`); ACP S3/S4 |
| 7 | Harness switch inside a thread | [harness-switch.md](harness-switch.md) | M | capabilities S1; ACP S4 for host switches |
| 8 | Settings search | [settings-search.md](settings-search.md) | S | none |
| 9 | Desktop dictation (on-device, opt-in) | [desktop-dictation.md](desktop-dictation.md) | M | none; S1 is a spike with a stop option |
| 10 | Desktop terminal (local window only) | [desktop-terminal.md](desktop-terminal.md) | L | none for S1–S2; SSH S3 for S3 |

Why this order: capabilities are small and every later plan reads them. The ACP
host is the core user ask and defines the host channel and the "host-run thread"
marker the others depend on. MCP is cheap and independent. Workers and SSH are
large and build on the host channel. Mobile is a client of everything above.

## 2. What exists today

| Area | Today | Where |
| --- | --- | --- |
| ACP | absent | `plans/gap-backlog.md` |
| Remote execution | the device channel: backend-signed calls to a machine the user paired, local approval in Rust, a sandboxed `shell_run` | `backend/lunora/devices/`, `packages/device-core/src/`, `apps/desktop/src/device/` |
| Relay | the web page in the desktop shell claims pending device calls and returns signed results; mounted app-wide | `apps/web/src/lib/native/native-bridge.tsx`, `apps/web/src/features/devices/components/device-relay.tsx` |
| Sync between clients | not needed: the backend holds every thread, message and run, and clients read live queries | `backend/lunora/chat/`, `packages/client-runtime/src/` |
| Delegation | one-shot headless sub-agents (depth 2, 3 active per thread), coding agents in E2B, task assignees (chat agent or a `codingAgent` assignment) | `backend/lunora/sub-agents/`, `backend/lunora/coding-agents/validators.ts` |
| Public API | `/api/v1/*`, API keys only, one route table | `backend/lunora/public-api/routes.ts`, `backend/lunora/public-api/identity.ts` |
| Mobile | Expo app: sign-in and thread list; streaming designed, not wired | `apps/mobile/`, `plans/mobile-phase-4-slices.md` |

## 3. The decision that shapes every plan: where a turn runs

**An agent turn runs on the desktop, or on an SSH host through the desktop. The
backend never spawns an agent.**

- The backend keeps the thread, the messages, the approval state and the
  orchestration rows, as it does now. Cloud model turns keep running on the jobs
  queue (`runStreamingAgent`, `backend/lunora/chat/execute.ts`); nothing here
  changes that path.
- An ACP agent is a local process with the user's own login and the user's own
  files. Running it in the cloud would mean copying both to a server.

### The host channel (defined in full in [acp-agent-host.md](acp-agent-host.md) §4)

- **Commands** (start a session, send a prompt, cancel, answer a permission) are
  backend-queued device calls, signed by the backend. The app-wide relay in the
  web page claims each one (`claimDeviceCall`) and hands it to the desktop main
  process, which verifies it in Rust before acting.
- **Turn output** (text, reasoning, tool parts, permission requests, the end of a
  turn) is posted **directly by the desktop main process** to a device-signed,
  claim-once ingest route keyed by `(turnId, seq)`. The page is not in that path.
- **Routing.** The ingest is an HTTP action. It finds the device owner's shard
  through the `.global()` `shardRoutes` row `device:<deviceId>`, loads the device
  there, verifies the signature, and writes only into a thread the device's user
  owns (`backend/lunora/lib/http-shard.ts`, `backend/lunora/lib/thread-shard.ts`).
- **Window closed.** On macOS, and wherever a tray exists, closing hides the main
  window, so the relay and running turns continue. Without a tray, closing quits
  and kills the agent process tree. Whether hidden-window throttling slows the
  relay is measured in ACP S3, not assumed.

### Host-run threads

A thread whose turns run on a host carries `threads.runner = "host"`
([acp-agent-host.md](acp-agent-host.md) §5.1). Every other plan reads that one marker through one helper,
`isHostRunThread`. Unset means cloud. The runner is fixed at creation. A switch
between cloud and host forks a new linked thread; a switch between host agents
stays in the thread ([harness-switch.md](harness-switch.md) §3).

### Decided 2026-10-27

- **Cross-runner switch:** a fork, not an in-thread change. One thread would then
  run in two places, and the sharing and ingest rules assume one runner per thread.
  A fork keeps each thread on one runner and records the link through lineage.
- **ACP commands:** their own open-call budget (3 per device) and a 60 s claim
  window; the device tools keep 20 s. A stuck send cannot block cancel.
- **File output from host agents:** the desktop main process uploads the bytes
  itself with a device-signed create. The page never carries output.
- **Mobile M6 and M7:** stay in this roadmap. M6 gets its own GitHub merge scope,
  which is a separate write scope, the same way file write is one.

## 4. Trust rules, in one place

1. **The page is a relay.** It may pass a backend-signed command to the desktop.
   It can never make the desktop spawn a process by itself.
2. **Remote start is narrower than local start.** Web and mobile may continue a
   session, or start one only in a folder and with an agent already approved in a
   local window. Rust refuses anything not pre-approved, even with a valid
   signature.
3. **Input from outside the local shell is ordinary user input.** A prompt from
   web, mobile or an outside agent never changes consent, the folder or the
   agent. Chat text never answers a permission request. Text from a handoff or a dispatch never starts a command.
4. **Permission answers are a typed command.** Only the signed-in owner's web or
   mobile client may send one, carrying the request id and the agent's option id:
   approve once or decline, with the full details shown. The first answer wins
   and the local prompt closes. Outside agents can never send one.
5. **ACP agents run beside the device sandbox in v1**, not inside it. Every ACP
   permission request prompts. There is no "Always allow" for ACP in v1. "Approve
   all" in the approval bar answers only the requests it shows, each once, and
   remembers nothing ([acp-agent-host.md](acp-agent-host.md) §4.4).
6. **SSH authority stays on the desktop.** The desktop verifies every backend
   call and runs local approval. The remote `neore-host` binary holds no device
   secret and no pairing, trusts only its SSH stdio pipe, and opens no listener.
7. **Secrets stay where they are.** Agent logins stay in the agent's own store.
   SSH keys stay in the user's agent or key file. Neore stores neither, and never
   stores an SSH password.
8. **Outside agents cannot write into host-run threads**, checked server-side in
   `runChatStart`, the turn-start path every caller goes through. They cannot
   reach one indirectly either: dispatch to a host worker always asks a person
   ([agent-orchestrator.md](agent-orchestrator.md) §4).
9. **Charging.** Host turns are not charged: the agent bills its own account.
   Cloud workers are charged once per run via `chargeRound` when the run starts.
   Host workers are not charged and still count against the user's `subAgents/run:<tier>` limit.

## 5. Build order

1. Capabilities S1 (types, static declarations, rules, and the `vCapabilityReport`
   validator that ACP S3 stores).
2. In parallel: **ACP S1–S3** (local run, permissions, persistence),
   **SSH S1–S2** (transport seam, headless host binary, no network yet),
   **MCP S1** (read tools), **settings search S1–S3**, **dictation S1** (spike),
   and **terminal S1–S2** (local window only). None of these depends on another.
3. **ACP S4** (remote start and continue, remote permission answers, the host
   states and retry rule). Then **capabilities S2–S3** (stored reports, gated
   controls).
4. **Orchestrator S1–S4** (cloud workers) start after capabilities S1 and run
   beside step 2. **Orchestrator S5** (host workers) needs ACP S4.
5. **SSH S3–S6** (SSH transport, remote install, lifecycle, files), then **SSH S7**
   (ACP on SSH, which needs ACP S3). **Terminal S3** (SSH terminal) needs SSH S3.
6. **MCP S2–S3** (write tools, key UI) after ACP S3, so the host-thread refusal has
   a real host thread to test against.
7. **Mobile M1–M2** after mobile slice 2 and ACP S4; **M3** (approvals) after ACP S4;
   **M4–M5** last among the core mobile slices. M5 also needs orchestrator S2 (`listActiveWorkerRuns`); M7b needs ACP S8.
8. **ACP S5–S6** (registry, native session import) whenever demand shows.
   **ACP S7** (early commands, native child agents) after ACP S4 and capabilities S2.
   **ACP S8** (images and files from host agents) after ACP S3, the device file
   operation and the device-signed upload create (new backend work in S8).
9. **Harness switch S1** (explicit cloud switch) after capabilities S1. **S2**
   (portable handoff) after S1. **S3** (host handoff: host to host in the thread,
   cloud to host or back as a forked thread) and **S4** (native reattach, which needs ACP S6 for saved session ids) after ACP S4 and capabilities S2.
10. **Orchestrator S6–S8** (stop and stuck runs, receipts, dispatch policy) after
    orchestrator S4. The cloud-run checks do not wait for S5. The host-run checks in S7 and S8 do need S5.
11. **Mobile M6–M7** (pull requests, files and projects) after mobile M4. M6 needs a
    new GitHub merge scope, which is new backend work and is not in any other plan.
    Both stay in this roadmap.
12. **Terminal S4** (Windows) last.

Do not start a slice before the slices it names are merged.

## 6. Open questions for the owner

Each changes a first slice. The recommendation is in the plan named.

| # | Question | Recommendation | Plan |
| --- | --- | --- | --- |
| 1 | Sandbox ACP agents with network allowed, instead of running them beside the sandbox? | **Decided 2026-10-27: beside it in v1**; revisit with the egress allowlist work | [acp-agent-host.md](acp-agent-host.md) §10 |
| 2 | Show host turns on the usage page as their own bucket? | Not in v1; no usage rows for host turns | [acp-agent-host.md](acp-agent-host.md) §10 |
| 3 | Query the ACP registry from the desktop or from the backend? | Desktop, so the backend never sees the install choice | [acp-agent-host.md](acp-agent-host.md) §10 |
| 4 | Turn off background throttling for the main window? | Only if the S3 measurement fails | [acp-agent-host.md](acp-agent-host.md) §10 |
| 5 | SSH password prompts, bastions, OTP? | Out of v1 | [ssh-environments.md](ssh-environments.md) §11 |
| 6 | Where the remote binary's expected checksums come from | Shipped inside the desktop build | [ssh-environments.md](ssh-environments.md) §11 |
| 7 | Does a run started by a user message in a worker thread post back to the lead? | No; only lead dispatches post back | [agent-orchestrator.md](agent-orchestrator.md) §9 |
| 8 | Build OAuth for MCP (v2)? | Only after v1 keys have users | [outside-agent-mcp.md](outside-agent-mcp.md) §9 |
| 9 | Push for approvals before mobile M3 ships? | Yes; M3 without push is usable but slow | [mobile-acp-and-remote-control.md](mobile-acp-and-remote-control.md) §9 |
| 10 | Native mobile shells over a shared Rust layout core, instead of Expo? | **Decided 2026-10-26: stay on Expo.** Reopen only if the slice 2 frame-time gate in `mobile-phase-4-slices.md` fails | [mobile-acp-and-remote-control.md](mobile-acp-and-remote-control.md) §8 |

## 7. Rejected, so they do not come back

- **Remote screen and input control, including unlocking a locked screen.** Far
  more attack surface than device execution, and the device model has no input
  channel by design.
- **Client-to-client sync.** The backend already holds every thread.
- **A cloud runner for ACP agents.** It would need the user's agent login and
  files on a server (§3).
- **A device secret on SSH hosts.** Anyone with root there could forge calls
  (§4 rule 6).
- **A separate nightly learning feature.** Memory reflection covers it
  (`backend/lunora/memory/`).
- **A menu-bar activity widget.** The dock badge covers it.
- **A public model pricing catalog.** The gateway already prices every model.
- **A per-session tool endpoint for host agents.** It would put a Neore credential in the agent's environment, which ACP §6 forbids.

## 8. Watch list (not planned)

- **Direct LAN or mesh-VPN routes with relay fallback.** The relay path is enough
  for v1. Revisit when a user reports a relay-only failure we can measure.
- **A headless runtime with a terminal UI.** `apps/cli` covers scripting. Revisit
  after SSH S2, since it would reuse `neore-host`. An always-on headless host (an
  agent machine that pairs as its own device, with no desktop app) is tracked in
  [#369](https://github.com/anolilab/neore/issues/369), including why it reopens
  the rejected "device secret on SSH hosts" trade-off.
- **Simulator and emulator streaming.** Serves mobile developers only.
- **Host checkpoints.** A snapshot per turn in hidden refs, and refusing a revert the agent cannot rewind. Revisit with the provider capability `checkpoints`.
- **Merge-back of a fork's results into its source.** Revisit when forks ship.
- **A worktree per host session.** It would change the per-folder consent model; revisit if two sessions in one folder collide in practice.
- **Deep links that open a draft without running it.** Low priority.

## 9. Protocol facts

ACP version, capability names and SDK package are deliberately not in these
plans. ACP S1 reads them from the published spec and records the version next to
the handshake code.
