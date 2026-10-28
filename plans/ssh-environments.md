# SSH remote hosts

Status: plan, 2026-10-26. Part of [agent-host-roadmap.md](agent-host-roadmap.md).
Extends device execution ([device-execution.md](device-execution.md)) to a server
the user reaches over SSH, and carries ACP sessions there
([acp-agent-host.md](acp-agent-host.md)).

## 1. Goal and decision

A desktop user adds a server by its SSH address. Neore uploads and starts a
headless host binary there. File work, `shell_run` and ACP sessions then run
where the code lives. Web and mobile see the server as one more device.

**Decision.** Authority stays on the desktop. The desktop's Rust verifier
(`packages/device-core`, through `packages/device-core-node`) checks every
backend-signed call and runs local approval in the local window. Only then does
it forward the approved action over the SSH stdio pipe. The remote binary,
`neore-host`, a headless target of the same crate, trusts exactly that pipe. It
holds no device secret, no pairing and no keychain entry, and it opens no
listener. That stops anyone from impersonating the desktop to the backend. It does
not make a host's results true (§10). Host keys are pinned in a Neore-owned store behind a trust prompt, and
a changed key is refused. One long-lived connection per host, multiplexed with
`ControlMaster`. `ForwardAgent` is off by default.

Rejected: a device secret on the remote box. Anyone with root there could forge
results and calls, and approval would have to move to a machine with no window.

## 2. Current state (checked)

- `packages/device-core/src/`: `envelope.rs` (verify signed calls), `approval.rs`
  (local prompts and rules), `engine.rs` (action dispatch), `shell.rs` and
  `sandbox.rs` (`shell_run` under Landlock or `sandbox-exec`), `fs.rs`, `mcp.rs`,
  `store.rs` (pairing secret in the OS keyring), `hmac.rs`.
- `packages/device-core/Cargo.toml` is a library only (`[lib] device_core`). On
  Linux it pulls `keyring` with the Secret Service backend, which links libdbus.
  On macOS it pulls the Apple keychain backend.
- CI: `test.yml`'s `device-core` job runs the crate's tests on ubuntu-22.04,
  windows-latest and macos-latest. `desktop.yml` builds the napi addon per
  packaged arch.
- `apps/desktop/src/device/` (`index.ts`, `channels.ts`, `validate.ts`,
  `window/`) wires the addon, the IPC channels and the local device window.
- Backend: a device is a `devices` row (`backend/lunora/schema.ts`: `name`,
  `platform`, `encryptedSecret`, `manifest`, `lastSeenAt`, `revokedAt`) with
  signed calls in `deviceCalls`. There is no transport notion today.

## 3. Identity: an SSH host is a device the desktop speaks for

- Each SSH host gets its own `devices` row, so the web lists it, the agent sees
  its manifest (`getDeviceToolContext`), and calls target it by `deviceId`.
- New optional columns: `transport: v.optional(v.literal("ssh"))` (unset =
  local) and `viaDeviceId: v.optional(v.id("devices"))`, the desktop that holds
  it.
- Pairing runs through the existing `registerDevice` path, from the desktop's
  local window, with a local click. Like any device, it writes the
  `shardRoutes` row `device:<deviceId>` that routes the ingest
  ([acp-agent-host.md](acp-agent-host.md) §4.2). The host device's secret is stored in the
  **desktop's** keychain, keyed by host device id. `store.rs` grows from one
  pairing to a keyed set. The remote box never sees the secret.
- The desktop's relay claims calls for its own device and for every host device
  whose `viaDeviceId` is itself. `listPendingDeviceCalls` takes the list of
  device ids the relay speaks for, and the backend checks each one's
  `viaDeviceId`. The relay (`device-relay.tsx`) changes with it, and the
  procedure's row in `docs/security/authz-matrix.md` is updated to say so.
  The `viaDeviceId` check is an ownership check, not a security control. A
  client can name any device it owns, so the real guard is the desktop's secret:
  only the desktop that holds a host's secret can sign its results.
- Revoking the desktop revokes its host devices in the same mutation. Revoking a
  host alone leaves the desktop paired.
- Turn ingest for an ACP session on an SSH host is signed by the desktop with the
  host device's secret ([acp-agent-host.md](acp-agent-host.md) §4.2). `neore-host`
  only streams events to the desktop over the pipe.

## 4. Host keys

- Store: `<appData>/ssh/known_hosts`, file mode 0600, inside a 0700 directory.
  Neore never writes the user's `~/.ssh/known_hosts`.
- Every `ssh` invocation passes `-o UserKnownHostsFile=<store>`,
  `-o GlobalKnownHostsFile=/dev/null` (`NUL` on Windows) and
  `-o StrictHostKeyChecking=yes`. ssh itself enforces the pin.
- First use: the desktop reads the server's key without authenticating, then
  shows host, port, key type and SHA-256 fingerprint in the local window. Only an
  explicit "Trust" writes the entry. There is no silent accept.
- Changed key: ssh refuses. The desktop shows the old and new fingerprints and
  offers no one-click override. Re-trust means removing the old entry in host
  settings, then running first-use trust again.
- `~/.ssh/config` and `~/.ssh/known_hosts` are read, read-only, to suggest
  aliases and to pre-fill the expected fingerprint in the trust prompt. A
  suggestion never trusts by itself.

## 5. Authentication

- The user's own `ssh` client, with the user's SSH agent or a key file the user
  names (`-i`). Existing setups keep working.
- A key passphrase is asked for in the local window. `SSH_ASKPASS` points at a
  small helper of the desktop, with `SSH_ASKPASS_REQUIRE=force`. The passphrase
  is never stored, logged, or put on a command line.
- v1 passes `-o PasswordAuthentication=no -o KbdInteractiveAuthentication=no`.
  A host that needs a password or an OTP fails with "use a key or an SSH agent".
- `-o ForwardAgent=no` by default. Forwarding is an explicit per-host opt-in,
  shown with a warning.

## 6. Connection and process hygiene

- **One long-lived connection per host.** `-o ControlMaster=auto`,
  `-o ControlPath=<appData>/ssh/cm/%C` (directory 0700, never `/tmp`),
  `-o ControlPersist=10m`. Uploads and reconnects reuse the master instead of
  opening a new session each time, which is what trips a server's connection
  limits and its firewall.
- The `neore-host --stdio` process runs inside that connection. Its stdin and
  stdout carry length-prefixed JSON frames: request, response, event. stderr is
  the remote log.
- **Clean remote environment.** The launch is
  `exec env -i HOME="$HOME" PATH=/usr/bin:/bin LANG=C.UTF-8 ~/.neore/host/<version>/neore-host --stdio`.
  `SSH_AUTH_SOCK` is absent unless forwarding is on. When it is on, the binary is
  given a stable socket path, not the session-scoped one that dies with the
  launching session.
- **No listener anywhere.** `neore-host` binds no socket. On the desktop side
  the only channel is the ssh child's stdio. No port forward is opened on either
  machine.
- **Stop only what we started.** The desktop stops a `neore-host` only if it
  launched that one (pid file under `~/.neore/host/run/` holding a launch nonce).
  A host process found running at connect is left alone at disconnect.
- **Fresh log per launch:** `~/.neore/host/logs/<launch-id>.log`, so a failure
  is never read from an older run.
- **Reconnect:** exponential backoff with a cap, at most 5 attempts per
  10 minutes, then a Retry button. A locked SSH agent waits for the user and
  never turns into repeated prompts.

## 7. Actions on the host

- `neore-host` reuses `engine.rs`, `shell.rs`, `sandbox.rs` and `fs.rs`. It
  never calls `envelope.rs` or `approval.rs`: by the time a frame arrives, the
  desktop has verified the signature, checked expiry and nonce, and taken the
  approval. Today `engine.rs` imports `approval`, `envelope` and the keyring-backed
  `store`, so S2 first moves the action dispatch into a module with none of those
  imports. The desktop keeps its current path through it.
- **Shared folders for a host** live in the desktop store, per host, edited only
  in the local window. Each forwarded action carries the folder set, and
  `neore-host` enforces it for `fs_*` and as the `shell_run` write set. The remote
  side keeps no configuration of its own.
- **Sandbox.** `shell_run` uses Landlock on Linux and `sandbox-exec` on macOS. The
  remote executor checks its own sandbox support, because the desktop's check
  describes the desktop, not the host. Each forwarded `shell_run` carries the
  "Require sandbox for shell commands" setting from the desktop store, and
  `neore-host` refuses before it spawns anything when the setting requires a sandbox
  and the host has none (Windows, or a kernel without Landlock). The host reports its
  sandbox support in its handshake, so the approval prompt can say that the command
  will be refused, or will run unsandboxed because the user turned the requirement
  off.
- **Approval prompts** name the host ("on build-box: run `make test`") so the
  user can tell a remote action from a local one.
- **Taint** (`backend/lunora/devices/lib/taint.ts`) is unchanged. It is signed by
  the backend and checked on the desktop.
- **ACP on the host:** `neore-host` spawns the agent beside its sandbox, exactly
  as the desktop does locally ([acp-agent-host.md](acp-agent-host.md) §6), and
  relays its stdio as events over the pipe.

## 8. Remote binary

- Targets: Linux x64 and arm64 first, macOS arm64 and x64 next, Windows last.
- Build: a `[[bin]] neore-host` target in `packages/device-core`. The keyring
  dependency moves behind a cargo feature `keychain` (default on). `neore-host`
  is built with `--no-default-features`, so it links no keyring and no libdbus.
  It is statically linked against musl on Linux.
- Install path: `~/.neore/host/<version>/neore-host`, uploaded over the control
  connection. The remote never fetches it.
- `uname -sm` is checked against the target before upload. A mismatch is
  refused before any bytes move.
- Upload to `neore-host.tmp-<nonce>`, verify SHA-256 on the remote, `chmod 700`,
  then `mv` into place. An interrupted or mismatched upload leaves nothing
  executable at the final path.
- The expected checksums ship inside the desktop build, so a compromised mirror
  cannot change the binary.
- The desktop pins the version it expects. Upgrading is an explicit action, and
  it runs only when no session is active on that host. Old versions are deleted
  after a successful upgrade.

## 9. Slices

**S1 — Transport seam (built).** `HostTransport` in `apps/desktop/src/device/` with one
implementation, `local` (the napi addon). Every device call in the main process
goes through it. No behaviour change.
- Acceptance: the existing device tests pass unchanged; the `device-core` CI job
  stays green on all three OSes.

**S2 — Headless host binary (built).** The engine split (above), the `keychain` feature
gate, the `neore-host` target, and the stdio frame protocol, run locally as a child
process.
- Acceptance: the action test vectors give identical results through stdio and
  through napi; `shell_run` runs sandboxed on Linux and macOS; a test asserts the
  process holds no listening socket; `cargo tree` for `neore-host` shows no
  `keyring`, and `ldd` on the Linux build shows no libdbus.

**S3 — SSH transport and host identity (built).** Spawn `ssh` with the options of §4–§6,
pin keys, ask for passphrases through the helper, and add `transport` and
`viaDeviceId`. Relay claims for host devices. Keyed secrets in `store.rs`. The desktop relay heartbeats each connected host device and signs its manifest with that host's secret, so `createDeviceCall` sees the host as online and offering its agents.
- Acceptance: connect to a test sshd in CI; a changed host key is refused and
  both fingerprints are shown; nothing about a passphrase is written to disk or
  logged; the remote process has no `SSH_AUTH_SOCK` with forwarding off; a call
  for a host whose `viaDeviceId` is another desktop is refused at the ownership
  check, and a desktop without the host's secret cannot produce a valid result
  (test: sign a result with the wrong secret); revoking the desktop revokes its
  hosts.

Where S3 departs from the text above:
- `ssh` runs with `-F /dev/null` (and `UpdateHostKeys=no`, `-T`, `ClearAllForwardings`, `IdentitiesOnly` with `-i`):
  it reads neither the user's nor the system config, so a config cannot add a `RemoteCommand`, a forward or a
  `ProxyCommand`. Jump hosts stay out of v1 (§11).
- `ControlPath` is `<appData>/ssh/cm/%C` only when that fits a Unix socket path (104 bytes on macOS, with
  ssh's temporary suffix); the default macOS userData does not, so it moves to `~/.neore/cm` (0700). Never `/tmp`.
- The askpass helper is a shell script talking to the desktop over two FIFOs in a private directory (ssh
  closes inherited descriptors, and a socket would be a listener). POSIX only: a Windows desktop has no
  passphrase prompt and no multiplexing yet.
- "Always allow" is not offered for a server's calls yet: the allow rules are keyed by tool name and global.
- Agent forwarding is a per-server flag that passes `SSH_AUTH_SOCK` through. Only the local window turns it on (behind a confirmation); a page's pairing request cannot carry it. The stable socket path of §6 is S5.
- `~/.ssh/config` suggestions (§4) and the Windows-desktop askpass are not built.

**S4 — Install and upgrade.** §8. The release build of `neore-host` must pass
`--no-default-features`: a plain `cargo build` links the keyring (the binary logs an error at
startup when it does), so the packaging step is where that is enforced.
- Acceptance: a wrong checksum and a killed upload both leave no executable at
  the final path; an architecture mismatch is refused before upload; an upgrade
  with an active session is refused.

**S5 — Lifecycle.** Backoff, Retry, ownership-based stop, stale-process
detection, ControlMaster reuse.
- Acceptance: drop the network for 60 s and restore it; the host reconnects with
  at most two `ssh` processes alive at any moment (the test counts them); a host
  process the desktop did not start survives a disconnect. On a Windows runner,
  record whether ControlMaster works. If it does not, Windows uses one ssh
  process per host with no multiplexing, and the UI says so.

**S6 — Files on the host.** File tree and reads over the device file actions.
Folder download as one tar stream.
- Acceptance: a 10,000-file folder lists and downloads within a budget set from
  a first measurement and then pinned in the test.

**S7 — ACP on the host.** `HostTransport = ssh` for ACP sessions. Needs ACP S3.
- Acceptance: an ACP turn on the SSH host streams into the thread through the
  desktop's ingest; quitting the desktop kills the remote agent tree.

## 10. Risks

- **Remote box compromise.** Accepted. An attacker with root there can read the
  host's shared folders and lie on the pipe. They cannot forge a backend call or sign
  anything themselves, because the box holds no secret (§1). But the desktop signs
  and relays what the host returns, so a compromised host can fabricate the output
  or status of an action it was asked to run, and the backend accepts the desktop's
  valid signature. Results are labelled with the host they came from, and host
  output is untrusted content: S3 checks how a host-origin result enters
  `taintedBy`, so a later call that follows it still prompts.
- **Reconnect storms** against connection or firewall limits. Covered by one
  master per host and the S5 acceptance.
- **Inherited agent sockets** that die with their session. Covered by §6.
- **Remote binary trust.** Shipped checksums, temp-then-rename (§8).
- **Windows OpenSSH** differs in quoting, paths and multiplexing. Windows hosts
  come last, behind a flag.
- **Sandbox gaps** on hosts without Landlock. Refused by the existing rule. The
  host dialog says so.

## 11. Open questions

1. **Password prompts.** Recommendation: not in v1 (§5).
2. **Bastions, jump hosts, OTP.** Recommendation: out of v1. Revisit when a user
   needs it; `ProxyJump` from the user's `~/.ssh/config` would be the first step.
3. **Importing trust from `~/.ssh/known_hosts`.** Recommendation: a pre-filled
   suggestion in the trust prompt only (§4), never a silent trust.
4. **Checksum source.** Recommendation: shipped inside the desktop build (§8).
   Owner to confirm, since it couples desktop and host releases.
5. **Host devices in the device list.** Recommendation: listed under their
   desktop, with the transport shown, and revoked with it.
