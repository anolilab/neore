# DEVICE CORE KNOWLEDGE BASE — REFERENCE

The rules are summarized in `packages/device-core/AGENTS.md`, which agents load automatically; this file holds the reasoning and detail. Paths are repo-relative where they start at a top-level folder (`packages/…`, `apps/…`, `backend/…`); `device-core/src/…` means `packages/device-core/src/…`, bare Rust file names (`actions.rs`, `ssh.rs`, `engine/…`) live in `packages/device-core/src/`, `tests/…` in `packages/device-core/`, and `ssh-environments.md` is a design doc.

## INVARIANTS

- **Device execution** (`packages/device-core/src/{shell,sandbox}.rs`, `backend/lunora/devices/`,
  `features/devices`) is remote code execution
  on the user's machine, so the page is a RELAY only: the backend signs each
  call (HMAC, domain-prefixed payload STRING — no canonical JSON) with a
  per-device secret, Rust verifies signature/device/expiry/nonce, asks in the
  LOCAL `device` window (the only capability with the answer/settings
  commands) and signs the result, which `completeDeviceCall` verifies. Device
  tools exist only in interactive runs of a thread the user owns ALONE
  (`getDeviceToolContext`: no grant, not public/group/messenger) and are `off`
  headless whatever the mode. A call that follows untrusted content carries a
  server-computed, SIGNED `taintedBy` (`devices/lib/taint.ts`, fail-closed):
  it always prompts and never offers "Always allow"; `shell_run`/`fs_write`
  never do either. `shell_run` runs in an OS sandbox (`packages/device-core/src/sandbox.rs`:
  Landlock / `sandbox-exec`; Windows has none) that writes only the shared
  folders + a per-run `$TMPDIR` and hides the rest of `$HOME`. Network has three tiers
  (`NetworkTier`: Off default / "Common dependencies only" / On; the settings key
  `shellNetwork`, with `allowShellNetwork` its legacy bool). The middle tier lets a program
  connect to ONE loopback port, a per-run CONNECT-only proxy (`egress.rs`) that dials a fixed
  list of registries and source hosts, and the proxy requires the TLS ClientHello's server name to
  equal the CONNECT host (no SNI, Encrypted ClientHello or non-TLS bytes end the tunnel); macOS enforces it, **Linux refuses it** (Landlock filters
  by port, not address, so the proxy's port would open on every host) rather than downgrading,
  and Windows has no sandbox. Off is blocked
  on macOS and Linux; on Linux that is a seccomp filter making `socket(2)` fail with `EPERM` for
  every family except `AF_UNIX` and `AF_NETLINK` (and `io_uring_setup`), on little-endian
  x86_64 and aarch64 only (elsewhere the call is refused unless unsandboxed shells are allowed, and then it keeps
  Landlock and the prompt says the network is NOT blocked); Windows does not restrict it. **Local MCP servers run in the same sandbox**
  (`mcp.rs`): listing their tools for the manifest starts one too, so both paths go through
  `actions::plan_mcp_launch`; each has its own tier (default "Common dependencies only" where enforceable, else Off) and a private
  folder `<app data>/mcp/<name>/` holding its `$TMPDIR` and package caches (the user's own `~/.npm`
  etc. stay unreachable: a writable one would let a server plant a package the user later runs outside
  the sandbox). The running process is keyed on its planned policy, so changed shared folders, tier or
  sandbox setting restart it. Allowed paths and the host list are in `packages/device-core/README.md`.
  Where there is no sandbox the call
  is REFUSED unless the user turned off "Require sandbox for shell commands and local MCP servers"
  (stored inverted, `allowUnsandboxedShell`, so absent = required). Allow
  rules, shared folders, that setting and local MCP servers live only in Rust. **The pairing secret crosses the page exactly once**
  (`registerDevice` → `device_pair`), accepted because pairing needs a local
  click, a later page compromise cannot read it back, and a web revoke deletes
  the server copy; an asymmetric scheme was deferred to avoid new crypto
  crates. The HMAC vectors are pinned on BOTH sides — change one, update both.

- **`device-core` has two halves** (ssh-environments.md). `actions.rs` plans
  and runs `fs_*`/`shell_run` from explicit inputs (folders, shell policy) and
  imports no pairing, envelope, approval or keychain; the desktop `engine.rs`
  verifies, asks, then calls it. The `keychain` feature (default) is the paired
  half (`approval`, `engine`, `envelope`, `hmac`, `store`). `neore-host --stdio`
  (`host.rs`, `frame.rs`) is built `--no-default-features`, trusts only its pipe,
  and re-checks the folders and the sandbox on ITS machine. Both paths share the
  vectors in `tests/common/actions.json`; a new tool or a changed result goes there.
  Desktop main-process calls go through `HostTransport` (`apps/desktop/src/device/transport.ts`).

- **Servers over SSH** (`device-core/src/ssh.rs`, `engine/hosts.rs`, ssh-environments.md): a server
  is a `devices` row of its own (`transport: "ssh"`, `viaDeviceId` = the desktop that holds it) whose secret
  lives only in THIS desktop's keychain, one entry per device id (`store.rs`). Calls, manifests, progress and
  results for it are verified and signed on the desktop with that secret, after the same local approval
  (prompt naming the server, no "Always allow"); only the approved action goes down the pipe to `neore-host`.
  Every relay procedure takes the desktop's id for a server and compares it with the row: an ownership
  check, not a security control — the guard is that only the holder of the secret can sign. `ssh` runs with
  `-F /dev/null`, pinned keys in `<appData>/ssh/known_hosts` (never the user's), `UpdateHostKeys=no` (else ssh
  would add keys behind the trust prompt) and no `BatchMode` (it disables askpass). The passphrase reaches ssh
  through `SSH_ASKPASS` and two FIFOs in a 0700 dir — no listener, no file; it has its own IPC channel
  (`promptSecret`), never `promptAnswer`. `ControlPath` is `<appData>/ssh/cm/%C`, falling back to
  `~/.neore/cm` when that overflows a Unix socket path (macOS's default userData does), never `/tmp`.
  Tests start a real `sshd` as the current user (`tests/ssh_host.rs`; `NEORE_REQUIRE_SSHD=1` makes a missing one
  fail). Windows desktops have no passphrase helper or multiplexing yet.

- **A terminal on a server** (`hostTerminal` → `ssh.rs#terminal_args`) is the local `ssh` on the terminal module's PTY,
  riding the connection's master: `host_connect` first (the trust prompt and passphrase come BEFORE any window), then
  `-O check`, then the same hardened options with `-t`, `ControlMaster=no`, `BatchMode=yes` (all asking stays in the
  device window), `ForwardAgent=no` whatever the server's flag (the terminal requests no forwarding, but a server the user opted
  into forwarding for exposes the agent socket to that account on the server anyway), and `-e none` — without it `~C` opens ssh's command
  line and a person can add a `-L` listener. `ProxyCommand=false` is deliberate: ssh tries the control socket before
  it connects, so with the master gone it fails instead of opening a connection of its own. No remote command; the
  server starts the user's login shell. Ending the master (Disconnect, forgetting the key) ends the terminal; ssh
  exits 255 and the page words it as the connection ending.

- **Host software on a server** (`device-core/src/install.rs`, `apps/desktop/scripts/host-bundle.mjs`, ssh-environments.md
  §8): the desktop uploads `neore-host` over the server's own ssh master and the server checks the SHA-256 against the
  one shipped in `resources/neore-host/manifest.json` BEFORE `chmod 700` and the rename, so a wrong digest or a dropped
  upload leaves nothing executable at `~/.neore/host/<version>/neore-host`. The remote root is a parameter
  (`Root::dir`) because the sshd tests run as the developer: they must never touch the real `~/.neore`. Release binaries
  are built `--no-default-features`; a plain `cargo build` of `neore-host` links the keyring. `host_upgrade` is a
  LOCAL-window channel only and refuses while any session is open to the target.

- **Server lifecycle** (`lifecycle.rs`, `engine/reconnect.rs`, `launch.rs`): a server the person connected is KEPT
  connected until they disconnect it. A 1 s tick (`DeviceState::supervise`, a `Weak` thread started by the napi
  constructor) sees a dead link, closes that session FIRST and `-O exit`s its master only when ssh gave the connection
  up (exit 255 or unknown: the network went away and the master may be wedged; a host that merely ended leaves a healthy
  master to share), then retries with 2/4/8/16/32 s waits, at most 5 attempts per 10 minutes, one attempt per server at a
  time and 45 s each. A background attempt asks NOBODY (no passphrase, no trust prompt): a login that needs a person, a
  changed key, a missing or outdated install (exit 2) stops the retrying at once and waits for "Retry", which is the
  ordinary `hostConnect`; only the local window's Retry (`retry: true`) starts the attempts over, a page's connect
  counts as one more attempt of the window and is refused once it is full.
  The host is started `--stdio --launch <id>`, files `<run>/<id>.pid` and removes it on exit; a lost connection leaves it
  running until the server notices, so the next session sends a `reap` frame naming the launches THIS computer started
  (kept in memory per server). The host stops an id only after its program is `neore-host` and its arguments carry
  `--launch <id>` (through a pidfd on Linux); SIGTERM makes a host kill every command's process group before it exits
  (`shell::kill_running`), since only the host's thread enforces a command's timeout. Any other
  host (another computer's, one from before a restart) is counted and left alone. The run folder is `~/.neore/host/run`
  (tests: `NEORE_HOST_RUN_DIR`, which `env -i` keeps out of a real launch). Forwarded agent: the host links the session's
  `SSH_AUTH_SOCK` from `<run>/agent-<desktop tag>.sock` and its children inherit that path. `ssh::MULTIPLEXING` is a fixed
  `false` on Windows (one ssh process per server, said in the window), not a measurement; the CI step
  `Measure ssh ControlMaster (Windows)` records whether Win32 OpenSSH could multiplex and fails when it cannot say.

- **Files on a server** (protocol 3): `list` (one folder, name-sorted, a page at a time with an `after` cursor), `tar` and
  `cancel` are host ops of the stdio pipe, reached from the LOCAL window only (`host_files_list` / `host_file_read` /
  `host_download`; no signed call, no prompt, the person is the one asking) and never by the agent, so none of it enters
  `taintedBy`. `tar` is hand-written ustar (`archive.rs`) walked by `openat` + `O_NOFOLLOW` from the folder's descriptor, the
  same confinement as `fs_list`: symlinks (inside or out), hard-linked files (`st_nlink > 1`: another name may be outside), FIFOs
  and devices are LEFT OUT, not followed and not archived,
  and the desktop never unpacks the file it saves — the host's word is not trusted to name paths or plant links. Chunks are
  raw frames (`frame.rs` `CHUNK_TAG`), not JSON, followed by the ordinary response. The reader of the connection NEVER waits
  for the disk (it carries every other request's answer): chunks queue by bytes, and a writer more than 64 MiB behind
  ends the download; an idle minute ends one too. A `list` page reads the folder's names but keeps only the page. The save path comes from a native dialog in the main
  process, never from the window. Unix hosts only: a Windows host answers "not supported". The 10,000-file budget is pinned
  in `tests/ssh_host.rs` with the numbers it was set from.

- **Coding agents on a server** (`device-core/src/{agent_host,engine/host_agents}.rs`, `apps/desktop/src/acp/{remote-process,servers}.ts`,
  ssh-environments.md S7): the desktop speaks ACP and `neore-host` only owns the process, so the whole session stack is
  shared with the computer's own agents. The `agent` request streams stdout/stderr as chunk frames (tag 1/2) and takes stdin as
  chunk frames of the same id; `hello.agents` announces it (no protocol bump), and the host kills the agent's process group on
  cancel, on its stdin ending and on SIGTERM. A server's agents and approvals live on its `Host` row, the core picks the secret by
  the DEVICE a payload names (`acp_prepare`/`acp_sign`/`sign_turn`), and a server's poster is its own. `TurnChanges` and media read
  the desktop's disk, so they are off for a server (`folderIsRemote`): a new reader of the agent's folder must stay off for it too.
  The agent's environment is built on the server, not copied from the desktop.

- **No write waits on a pipe** (`device-core/src/outbox.rs`): `neore-host` writes its stdout, and the desktop writes
  ssh's stdin, through one writer thread with a byte-bounded queue. The host's request reader and the app's synchronous
  napi calls (`host_agent_write`/`_stop`) only queue, a cancel with extra room (`URGENT_HEADROOM`); a connection too far
  behind for even that is closed, which makes the host stop every agent. Producers (an agent's output, an archive) wait
  for room instead, holding the agent back. An agent that does not read its stdin is stopped at `INPUT_BUDGET`
  (8 MiB), not buffered further. Every thread a launch spawns is joined before its request ends (the pumps `poll`, so a
  `setsid` descendant holding a pipe cannot keep one). Narrowing a server's shared folders drops the approvals outside
  them in the core (`apply_update`) and the desktop stops those sessions (`reviewApprovals`); removing a server or
  unpairing ends its sessions FIRST (`ServerAgents.remove`), because the end of each turn is signed with a secret the
  core deletes right after. The person's variables can never replace `SSH_AUTH_SOCK`.
