# DEVICE CORE KNOWLEDGE BASE

The rules for working in `packages/device-core/`. The detail and reasoning are in
[docs/agents/device-core.md](../../docs/agents/device-core.md).

## INVARIANTS

- **Device execution** is RCE on the user's machine: the page is a RELAY only. The backend HMAC-signs each call (domain-prefixed payload STRING, no canonical JSON) with a per-device secret; Rust verifies signature/device/expiry/nonce, asks in the LOCAL `device` window, signs the result; `completeDeviceCall` verifies it.
- Only the local `device` window may hold the answer/settings commands.
- Device tools exist only in interactive runs of a thread the user owns ALONE (`getDeviceToolContext`), and are `off` headless.
- A call after untrusted content carries a server-computed, SIGNED `taintedBy` (`devices/lib/taint.ts`, fail-closed): it always prompts, never offers "Always allow"; `shell_run`/`fs_write` never offer it either.
- `shell_run` runs in the OS sandbox (`src/sandbox.rs`: Landlock / `sandbox-exec`; Windows has none): writes only shared folders + per-run `$TMPDIR`, hides the rest of `$HOME`.
- Network tiers (`NetworkTier`, key `shellNetwork`, legacy `allowShellNetwork`): Off default. The middle tier's CONNECT proxy (`egress.rs`) must require the ClientHello server name == CONNECT host; Linux REFUSES the middle tier, never downgrades.
- Off on Linux is a seccomp filter (`socket(2)` → `EPERM` except `AF_UNIX`/`AF_NETLINK`, plus `io_uring_setup`) on x86_64/aarch64 LE only; elsewhere refuse unless unsandboxed shells are allowed, and then say the network is NOT blocked.
- Local MCP servers run in the same sandbox, both paths via `actions::plan_mcp_launch`, each with its own tier and private `<app data>/mcp/<name>/`; never make the user's own package caches reachable. Restart on policy change. Allowed paths and hosts: `README.md`.
- No sandbox → REFUSE unless the user disabled "Require sandbox…" (`allowUnsandboxedShell`, absent = required).
- Allow rules, shared folders, that setting and local MCP servers live ONLY in Rust.
- The pairing secret crosses the page exactly once (`registerDevice` → `device_pair`). HMAC vectors are pinned on BOTH sides — change one, update both.
- **`device-core` has two halves**: `actions.rs` imports no pairing/envelope/approval/keychain; `engine.rs` verifies, asks, then calls it. The paired half is the default `keychain` feature.
- `neore-host --stdio` is built `--no-default-features`, trusts only its pipe and re-checks folders and sandbox on its own machine. New tools/changed results go in `tests/common/actions.json`. Desktop main-process calls use `HostTransport`.
- **Servers over SSH**: a server's secret lives only in this desktop's keychain (`store.rs`, one entry per device id); everything for it is verified and signed on the desktop after the same local approval (no "Always allow"). The relay's desktop-id comparison is NOT the security control.
- `ssh` runs with `-F /dev/null`, pinned keys in `<appData>/ssh/known_hosts` (never the user's), `UpdateHostKeys=no`, no `BatchMode`.
- The passphrase goes via `SSH_ASKPASS` + two FIFOs in a 0700 dir (no listener, no file), on its own IPC channel `promptSecret`, never `promptAnswer`. `ControlPath` is `<appData>/ssh/cm/%C` (fallback `~/.neore/cm`), never `/tmp`.
- SSH tests use a real `sshd` (`tests/ssh_host.rs`; `NEORE_REQUIRE_SSHD=1` fails when missing).
- **A terminal on a server** (`ssh.rs#terminal_args`): `host_connect` first (prompts BEFORE any window), `-O check`, then `-t`, `ControlMaster=no`, `BatchMode=yes`, `ForwardAgent=no`, `-e none`, `ProxyCommand=false`, no remote command. Keep every one of these flags.
- **Host software on a server** (`src/install.rs`): verify the SHA-256 from `resources/neore-host/manifest.json` BEFORE `chmod 700` and the rename.
- The remote root is a parameter (`Root::dir`): tests must never touch the real `~/.neore`. Release binaries build `--no-default-features`. `host_upgrade` is LOCAL-window only and refuses while a session is open.
- **Server lifecycle**: keep a connected server connected until the person disconnects. The supervise tick closes the session FIRST, `-O exit`s the master only on exit 255/unknown, retries (2–32 s, ≤ 5 per 10 min, one at a time, 45 s each).
- Background attempts ask NOBODY; a login needing a person, a changed key or a missing/outdated install stops retrying until "Retry" (`hostConnect`).
- Hosts start `--stdio --launch <id>` with `<run>/<id>.pid`; reap only launches this computer started, and only after confirming program `neore-host` with `--launch <id>` (pidfd on Linux). SIGTERM kills every command's process group (`shell::kill_running`).
- Run folder `~/.neore/host/run` (tests: `NEORE_HOST_RUN_DIR`). `ssh::MULTIPLEXING` is fixed `false` on Windows (no passphrase helper there either).
- **Files on a server** (`list`/`tar`/`cancel`): LOCAL window only, never the agent; no signed call, no prompt.
- `tar` (`archive.rs`) walks with `openat` + `O_NOFOLLOW` and LEAVES OUT symlinks, hard-linked files, FIFOs and devices; the desktop never unpacks what it saves. The save path comes from a native dialog, never the window.
- The connection reader never waits for disk: chunks (`CHUNK_TAG` raw frames) queue by bytes; > 64 MiB behind or an idle minute ends the download. Unix hosts only.
- **Coding agents on a server**: `neore-host` only owns the process; the host kills the agent's process group on cancel, stdin end and SIGTERM. The core picks the secret by the payload's DEVICE.
- `TurnChanges` and media stay off for a server (`folderIsRemote`); any new reader of the agent's folder must too. Build the agent's environment on the server.
- **No write waits on a pipe** (`src/outbox.rs`): one writer thread, byte-bounded queue; readers and napi calls only queue (cancel gets `URGENT_HEADROOM`); producers wait for room. Stop an agent at `INPUT_BUDGET` (8 MiB).
- Join every thread a launch spawns before its request ends.
- Narrowing shared folders drops out-of-folder approvals (`apply_update`, `reviewApprovals`); removing a server or unpairing ends sessions FIRST (`ServerAgents.remove`).
- The person's variables can never replace `SSH_AUTH_SOCK`.
- **A machine that pairs itself by code** (`src/headless/`, `/device/host` in `backend/lunora/auth/cli-device-auth.ts`, `registerHeadlessDevice`): a `transport: "headless"` device with its OWN secret. The secret crosses only https (plain http loopback is debug-build + `NEORE_HOST_DEV_INSECURE_LOOPBACK=1` only), appears in the redemption response and nowhere else, and is kept where the owner was told before approving (keychain, else a 0600 file in a 0700 folder). An unreadable pairing is refused, never re-made. `pair`/`run`/`unpair` share one lock. Details: `README.md`.
