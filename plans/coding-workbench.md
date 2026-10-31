# Coding workbench: coding agents, source control, chat, mobile and the desktop browser

Status: planned 2026-10-31, owner-approved scope. Starts once the open PRs of the agent-host
build (#431, #433, #434, #435, #440, #441, #442, #443, #444) have merged. Develop S8–S10
([develop-mode.md](develop-mode.md)) run alongside and are not repeated here.

It also takes up items earlier plans had rejected or parked on a watch list; the owner decided
to build them, and §10 records the invariants that changes. Each slice is one PR. Sizes:
S = one small PR, M = one PR that needs design, L = several PRs (split into the listed slices).

Read first: CLAUDE.md (every subsystem named below has its invariants there),
[agent-host-roadmap.md](agent-host-roadmap.md) §4 (trust rules), [acp-agent-host.md](acp-agent-host.md),
[ssh-environments.md](ssh-environments.md), [develop-mode.md](develop-mode.md),
[harness-switch.md](harness-switch.md), [mobile-phase-4-slices.md](mobile-phase-4-slices.md).

## 0. Rules every slice keeps

- Untrusted text (PR bodies, webhook payloads, agent output, pasted prompts, page content) is
  evidence, never instructions, and never drives an action without the person.
- Device and host calls stay signed per device; a call that follows untrusted content carries
  its signed `taintedBy` and always prompts. Nothing below adds a channel a web page can drive.
- Every new client procedure: `.output()`, inline `.max(MAX_LENGTH.x)`, an authz-matrix row.
  Every new table: RLS policy or `UNPOLICED_TABLES` reason, one owning module, erasure in
  `<module>/gdpr.ts`, schema baseline. Every outbound fetch has a deadline.
- Periodic work in `shardSweeps()` / `PERIODIC_JOBS`; long work on the jobs queue with
  claim-once. UI strings through lingui; WCAG 2.1 AA.

## 1. Wave 1 — security and reliability (start here)

| # | Slice | Size | Acceptance (each a test) |
| --- | --- | --- | --- |
| 1.1 | **Hidden characters out of prompts.** One shared filter (Unicode tag block U+E0000–E007F, bidi embeddings/overrides/isolates, other `\p{Cf}`, U+2028/2029, C0 controls except `\n`/`\t`) applied to composer input, pasted text, prompt links (§4.3) and queued messages, server-side at `/chat/start` too. Reuse `apps/desktop/src/acp/hooks/hidden-text.ts` by moving it to a shared package. | S | a prompt with tag characters arrives without them; the composer shows that characters were removed |
| 1.2 | **Rotate a webhook trigger's secret and URL.** New secret shown once; the old one stops at once (or after an opt-in 24 h overlap). | S | a delivery signed with the old secret is refused after rotation |
| 1.3 | **Native webhook replay window.** Signatures without a timestamp (GitHub, GitLab token) are claimed by delivery id with a TTL at least as long as the provider's retry window; document the gap. | S | a replay after the claim TTL of the current code is refused |
| 1.4 | **Resume interrupted runs.** A run killed by a deploy, crash or isolate eviction resumes from its last saved row (the rate-limit pause's resume path), at most 3 automatic resumes per reply, opt-out in settings; the 4th fails visibly. | M | a run whose worker dies mid-step finishes as one reply with one charge; the 4th interruption fails it |
| 1.5 | **Auto-archive never takes a thread that waits on a person** (pending approval, question, secret card). | S | a thread with a pending approval is skipped by the sweep |
| 1.6 | **Long-message guard.** A clear client-side cap below the 1 MiB RPC limit; a large paste becomes a text attachment (offer, undo). | S | an oversize prompt shows the cap, never a raw 413 |
| 1.7 | **Handoff that fits the target.** A handoff budget derived from the target model's context, falling back to a summarised handoff, never an overflow. | S | a switch to a small-context model succeeds with a summarised handoff |
| 1.8 | **Version and clock safety.** Host/backend protocol version check with an update notice; a plain-language clock-skew error on signed calls; a "could not start" recovery page in the desktop shell (`did-fail-load`, `render-process-gone`) with retry and a link to the last good release; a notice when a restarted app did not apply its update. | M | an old host gets an update notice instead of failing calls; a skewed clock names the cause |
| 1.9 | **Agents never starve the computer.** Host agent processes start at lower priority (`nice`/`setpriority`, Windows below-normal) and, on Linux, with an OOM score that sacrifices the agent before the desktop app or `neore-host`. | M | a spawned agent runs at the lower priority; the shell and host do not |
| 1.10 | **Diagnostics.** "Copy diagnostics" per device and SSH server (versions, route, last errors, clock offset; no secrets). Fish started without the terminal-query stall. | S | the copied text holds no secret; fish starts within the timeout |

## 2. Wave 2 — coding agents on the user's computer (host agents)

| # | Slice | Size | Acceptance |
| --- | --- | --- | --- |
| 2.1 | **The agent's own options.** Read ACP config options and modes (`session/set_config_option`, `session/set_mode`): models, reasoning effort, Plan/Build. Show them in the composer next to the model; capabilities report them (`provider-capabilities.md`). | M | choosing a mode sends the signed call and the agent confirms it |
| 2.2 | **The agent's own slash commands** (`available_commands_update`) in the `/` menu, marked as the agent's; `$` keeps our skills. | M | a command the agent lists appears and is sent verbatim |
| 2.3 | **Steer or queue during a host turn.** Queue by default; steer = cancel the turn and send the queued text first (what ACP allows), with the person told. | M | a message sent mid-turn runs after it, in order, once |
| 2.4 | **Plan entries and terminals.** ACP `plan` updates as a live task list row; ACP terminals (`terminal/create` etc.) offered by the host inside the same sandbox rules as `shell_run`, output tail and exit status shown. | M | a plan update renders; a terminal runs only in the shared folder and is killed on cancel |
| 2.5 | **Usage from the agent.** `usage_update` drives the context meter and shows cost when the agent reports it; still no charge. | S | the meter moves with the agent's report |
| 2.6 | **More registry agents.** `npx`/`uvx` distributions installed into a managed prefix at a pinned version with integrity checked (lockfile or hash), never "latest"; custom binary path and launch arguments for local agents. | M | an `npx` agent installs at its pinned version and refuses a mismatched integrity |
| 2.7 | **Fork a host session natively** when the agent supports `session/fork`; otherwise a portable handoff into a new session. | M | a fork keeps history in the agent; an unsupported agent gets a handoff |
| 2.8 | **File checkpoints and rewind.** Per turn, a snapshot of the shared folder's tracked changes in hidden git refs (or a file-copy store outside git repos); editing an earlier prompt offers "restore files to that point" and says the agent forgets the later turns. | L (3 slices: snapshot, restore, UI) | restore brings back the files of turn N and refuses outside the shared folders |
| 2.9 | **A worktree per host thread.** Optional per project: branch naming (prefix, from title), creation in a sibling folder inside the shared folders, cleanup of merged or archived threads with "keep local changes". Consent stays per folder: a worktree is approved through its repository folder. | L (2 slices) | two threads in one repo edit separate worktrees; cleanup never deletes uncommitted work without asking |
| 2.10 | **Ports and dev servers.** List listening ports started by a thread's agent or terminal processes, open a preview through a local proxy in the shell (loopback only), and stop a server a thread started. | M | a port opened by the agent appears; Stop ends that process group only |
| 2.11 | **"Allow all edits this session"** (owner decision, §10): an opt-in grant for file edits inside the shared folders for the rest of ONE session. Never for `shell_run`, terminals or network, never for a tainted call, never stored, ends with the session, shown as a badge with "Revoke". The approval window offers it only for an edit that is not tainted. | M | an untainted edit in the session is applied without a prompt; a tainted edit or a shell call still prompts; a new session prompts again |

## 3. Wave 3 — source control

| # | Slice | Size | Acceptance |
| --- | --- | --- | --- |
| 3.1 | **After Develop S9 — the linked-PR surface only.** S9 links a PR to the thread that made it; this adds the thread panel listing linked PRs (several, cross-repo), sidebar badges, and linking an existing PR by hand. | S | a hand-linked PR shows on its thread and in the sidebar |
| 3.2 | **Watch a pull request** (depends on Develop S10). An agent tool and a button: the thread wakes on check failure, merge conflict, new review or comment, from S10's freshness signals and the trigger event sources. | M | a failed check posts a wake into the watched thread once |
| 3.3 | **After Develop S9 — the commit text only.** S9 does host checkouts, pushes and PR creation through the adapter; this adds the AI-written commit message and PR title/body from the thread's work (untrusted-input rules) and optional stripping of co-author and "generated by" lines from merge messages. | S | a generated PR body never contains text the PR's own diff instructed |
| 3.4 | **PR actions.** Request reviewers, edit title/description and one's own comments, open a revert PR, approve waiting fork workflows. | S–M | each action through the adapter with a capability flag |
| 3.5 | **Clone onto a paired computer.** Pick a repository, clone into a shared folder over the device (HTTPS fallback when SSH auth fails), progress and retry. | M | a clone lands only inside a shared folder |
| 3.6 | **Stacked pull requests** (owner moved from watch): show a stack, merge it bottom-up, rebase the rest after a merge (GitHub first). | M | merging the base of a 3-stack rebases the next onto it |

## 4. Wave 4 — chat and composer

| # | Slice | Size | Acceptance |
| --- | --- | --- | --- |
| 4.1 | **Compaction.** `/compact`, an auto-compact threshold setting, and a "compact" chip when returning to a thread after the prompt cache expired; builds on `agent/thread-summaries.ts`. | M | `/compact` replaces older turns in the context, never in the thread |
| 4.2 | **Queue editing.** Edit a queued message in place, "send now", a default follow-up behaviour (queue or steer); the queue survives reload with its attachments (store attachment ids, not blobs). | S | a reloaded queue keeps its attachment |
| 4.3 | **Prompt links.** `/new?prompt=…&model=…&project=…` opens a draft that never runs by itself; copy a link from a message or the palette; text passes 1.1's filter. | M | opening a link never sends; hidden characters are gone |
| 4.4 | **Answers with files.** Attach files or paste an image into an ask-user answer. | M | the answer carries the file to the agent |
| 4.5 | **Quote as a chip.** Selecting text in a reply offers "Quote", inserting a chip with source link and an optional comment. | M | the chip renders and its link scrolls to the source |
| 4.6 | **Regenerate a title** from the thread menu (and on demand for agents through the MCP write tools). | S | the title changes once per click, charged as a utility call |
| 4.7 | **Keyboard focus.** F6 cycles sidebar → thread → composer → panels; F2 renames and the context-menu key opens the menu in the thread list. | M | F6 visits each area in order (axe and e2e) |
| 4.8 | **Uploads.** HEIC/HEIF converted to JPEG before upload; PDF rendered in the file viewer. | S–M | a HEIC upload arrives as JPEG |
| 4.9 | **Snooze.** Custom time; a snoozed thread wakes early on approval, failure or a question. | S | a pending approval un-snoozes |
| 4.10 | **HTML answers.** The agent can answer with a sandboxed page (chart, table, collage) that inherits the theme, rendered in an isolated frame with a strict CSP; extends the canvas and [auto-media-and-inline-widgets.md](auto-media-and-inline-widgets.md). | M | the page cannot reach our origin or the network beyond its own data |
| 4.11 | **Prompt stash** (owner moved from watch): save the draft under a name, restore it later, across devices. | S | a stashed draft restores on another device |
| 4.12 | **Theme editor** (owner moved from watch): separate themes for light and dark, a palette command and shortcut, a custom theme editor with import of a VS Code theme JSON and export. | M | an imported theme meets WCAG contrast or is flagged |

## 5. Wave 5 — permissions and sharing

| # | Slice | Size | Acceptance |
| --- | --- | --- | --- |
| 5.1 | **Per-thread permission mode.** Supervised / auto-edit / auto / full for cloud tools, chosen per thread with a default, shown beside the model; maps onto the existing per-tool Auto/Ask/Off and the low-risk check (#435). Host approvals keep their own rules (§2.11). | M | "supervised" asks for every write tool; the mode survives reload |
| 5.2 | **Guests who can ask.** A guest link (24 h, one browser) whose messages wait for the owner to Send or Dismiss; attachment caps; files deleted on dismiss or expiry; revoked on archive. | M | a guest message never runs until the owner sends it |

## 6. Wave 6 — mobile

| # | Slice | Size | Acceptance |
| --- | --- | --- | --- |
| 6.1 | **Push** (APNs/FCM) for finished, failed, approval, question; tap opens the thread. This is mobile phase 4 slice 3. | M | a question notifies once and opens its thread |
| 6.2 | **Over-the-air updates** (expo-updates) that keep drafts; a crash-report opt-in. | M | an update applies on next launch with the draft intact |
| 6.3 | **Share sheet and voice.** Share text, images or files into a new or current thread; voice input in the composer. | M | a shared image lands as an attachment |

## 7. Wave 7 — hosts, CLI and onboarding

| # | Slice | Size | Acceptance |
| --- | --- | --- | --- |
| 7.1 | **CLI sign-in by code and thread scripting.** Device-code sign-in (URL + short code approved in the app, no callback port) and `neore thread start/send --wait` with exit codes 0/1/2. | M | sign-in works over SSH with no browser on the box |
| 7.2 | **Headless host service.** `neore-host` as a user service (systemd/launchd) on a machine the person owns, paired as its own device; the device secret in the OS keychain, or a 0600 file only where no keychain exists, said in the pairing UI. Owner decision required (§10). | L (2 slices) | the service pairs, survives a reboot, and refuses calls not signed for it |
| 7.3 | **First-run setup.** A step to pair this computer, add an SSH server and install a coding agent, skippable, rerunnable from settings. | M | each step can be skipped and resumed |
| 7.4 | **Terminal history across reconnects** (owner decision, §10). | M | see §10 |
| 7.5 | **Direct routes** (owner moved from watch): a direct LAN or tailnet route between the desktop app and its SSH servers, or the phone and the desktop, for terminal and preview traffic only, with the relay as fallback. Signed calls keep going through the backend. | L (2 slices) | a direct route is used when reachable and falls back without dropping the session |
| 7.6 | **Spread new host threads across computers** (owner moved from watch): when the person has several online hosts offering the same agent and folder, pick by load (CPU, memory, running turns) with "prefer / less often / manual only" per host. | M | a busy host is skipped; "manual only" is never chosen |

## 8. Wave 8 — webhooks

| # | Slice | Size | Acceptance |
| --- | --- | --- | --- |
| 8.1 | **Payload placeholders and a delivery log.** `{{body.x}}` / headers / query values in the trigger prompt (inserted as quoted data, never as instructions), and a delivery log showing each request's outcome and the prompt it produced. | M | a placeholder fills from the payload; `{{`-syntax inside a value is not re-expanded |

## 9. Wave 9 — the desktop browser and simulators

An embedded browser in the desktop shell is the base for four items. It is a browser TAB,
not remote control of the operating system (still rejected, roadmap §7).

| # | Slice | Size | Acceptance |
| --- | --- | --- | --- |
| 9.1 | **Desktop browser panel.** `WebContentsView` tabs in the shell, in their own session partition (not the app's), with no Node, no preload of ours, permission prompts per site, downloads to a chosen folder. | L (2 slices) | a page in the panel cannot reach `window.neoreNative` or the app's cookies |
| 9.2 | **A live agent browser you can take over.** Device browser tools that drive a panel tab (navigate, read, click, type) as signed device calls with taint; the person watches live, can take control (agent paused) and give it back; read-only viewers on other devices see screenshots only. | L (2 slices) | while the person holds control no agent input reaches the tab; every agent action is a signed call |
| 9.3 | **Import cookies from another browser** into the panel's partition only, per site the person picks, after a confirm dialog; Chromium-family and Firefox stores; secrets decrypted through the OS keychain prompt; never sent to the backend. | M | only picked sites are imported; nothing leaves the computer |
| 9.4 | **Default web browser** (macOS first): links opened from other apps open in the panel or a new thread; a setting and an easy way back. | M | setting and unsetting the default works and is reversible |
| 9.5 | **Simulator and emulator panel** (owner moved from watch): stream an iOS Simulator or Android Emulator running on the desktop or an SSH server into a panel, with device tools for agents (tap, type, screenshot, install build) as signed device calls. macOS for iOS. | L (3 slices) | a frame stream shows in the panel; an agent tap is a signed, approved call |

## 10. Owner decisions that change existing invariants

- **Resuming interrupted runs (1.4).** CLAUDE.md says a delivery that dies mid-run is never
  re-run, because its step may already have been paid. The resume restarts from the last SAVED
  row, so a step that finished and saved is never re-run. The killed step's model call may have
  been billed by the provider: the gateway records usage per call whether or not the backend
  survives, so that call is charged once as the gateway recorded it, and the re-run of that
  step is a new call charged on its own. Acceptance therefore means "no completed step charged
  twice", not "one model call". Paid media generation (`runJobOnce`) keeps its never-re-run rule.
  Update CLAUDE.md ("Every queue target must tolerate redelivery") in the same PR.

- **"Allow all edits this session" (2.11).** CLAUDE.md "Device execution" says host and device
  prompts never offer "Always allow". This adds a narrower grant: file edits only, inside shared
  folders, one session, never stored. Update CLAUDE.md and the approval window copy in the same
  PR; `shell_run`, terminals and network keep once-only prompts. **Taint:** an ACP permission
  request comes from the agent's own tool loop, and we cannot see what the agent itself read.
  So the grant is refused (and an existing one suspended) only on the taint sources WE know:
  the thread's device-call taint (`devices/lib/taint.ts`), a handoff into the session that
  carried untrusted content (the takeover taint of harness S3), and an approval request whose
  path or text the host flags. Beyond those, the safety is the shared-folder scope and the
  one-session limit; the approval window says so in plain words.
- **Terminal history across reconnects (7.4).** CLAUDE.md "Terminal" says nothing about a
  terminal is stored. Keep that for disk: history is held IN MEMORY by the host process (for an
  SSH server: `neore-host`; locally: the terminal host utility process) for a bounded size
  (5,000 lines and 8 MiB), so a window close or a dropped connection reattaches to the same
  shell with its scrollback. It dies with the shell or the host process. Update CLAUDE.md.
- **Headless host service (7.2)** reopens issue #369 ("a device secret on SSH hosts", roadmap
  §7). Scope it to a machine the person owns and pairs locally; an SSH-reached server keeps its
  secret on the desktop as today.

## 11. Order and parallelism

Three agents at once. Waves 1 and 2 first (1.x are small and unblock trust; 2.1–2.3 are the
most-felt gap), then 3 and 4 interleaved, then 5–9. Inside a wave, slices that touch
the same module run one after the other. Every slice: failing test first, an independent
review on the opus model before merge, and the repository's merge rule.

## 12. Not in scope

Tunnels and LAN pairing for a self-hosted server, per-provider multi-account CLIs, provider
sign-in flows, custom model prices and subscription pooling, server-published themes,
OpenTelemetry export, a repo-level config file: no self-hosted server exists, and the gateway
owns pricing and credentials.
