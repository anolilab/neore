# device-core

The Rust core of Neore's device execution: the code that lets the backend ask
a user's own computer (or an SSH server they own) to read files, write files
and run shell commands, and that decides whether it may. Not published
(`publish = false`), no UI.

Every security decision on the paired side lives here: envelope signatures,
approval rules, root confinement of paths, the shell sandbox, output caps and
the audit log. The page is a relay only; it cannot invent, alter or replay a
call. The design is in `plans/device-execution.md` and
`plans/ssh-environments.md`; the user-facing view is `docs/devices.mdx`.

Consumers: `packages/device-core-node` wraps it as a N-API addon for the
Electron shell (`apps/desktop`), and the `neore-host` binary in this crate is
what the desktop installs on a server.

## Two halves

The `keychain` feature (on by default) selects the half:

| Half                               | Modules                                                                                       | Builds with                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------- |
| Paired side (desktop)              | `approval`, `engine` (+ `engine/hosts`), `envelope`, `hmac`, `store`, `install`, `ssh`, `acp` | default features (`keychain`) |
| Shared actions (also `neore-host`) | `actions`, `fs`, `shell`, `sandbox`, `mcp`, `frame`, `host`, `acp_permission`                 | `--no-default-features`       |

`actions.rs` plans and runs `fs_*`, `shell_run` and local MCP calls from
explicit inputs (shared folders, shell policy) and imports no pairing,
envelope, approval or keychain. The desktop `engine` verifies the signed call
and asks the person first, then calls it. `neore-host --stdio` (`host.rs`,
`frame.rs`) trusts only its pipe, binds no socket, and re-checks the folders
and the sandbox on its own machine.

`neore-host` must be built `--no-default-features`: it holds no pairing, so it
links no keyring (and on Linux no libdbus). CI checks that the release binary
links neither. A plain `cargo build` of it links the keyring.

## Module map

| Module                  | Role                                                                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `envelope`, `hmac`      | The wire format: a JSON payload _string_ plus `hex(HMAC-SHA256(secret, "neore-device:<domain>:v1\n" + payload))`. No canonical JSON. HMAC is hand-written over `sha2`, pinned by the RFC 4231 vectors |
| `engine`                | `DeviceState`: pairing, the signed relay, approvals, shell, MCP. Hosts supply an event `Sink`; the engine never reaches into a UI                                                                     |
| `approval`              | Prompts answered only in the local `device` window; unanswered prompts are denied at their deadline                                                                                                   |
| `store`                 | Persisted state in one owner-only JSON file; secrets live in the OS keychain (service `dev.neore.device`)                                                                                             |
| `fs`                    | File access confined to the user's shared folders (canonical roots; `..` and symlinks cannot escape)                                                                                                  |
| `shell`, `sandbox`      | `shell_run` through the user's shell with a timeout and capped output, inside an OS sandbox (Landlock on Linux, `sandbox-exec` on macOS; Windows has none)                                            |
| `mcp`                   | Local MCP servers over stdio, configured only in the local window                                                                                                                                     |
| `ssh`, `install`        | The desktop's side of a server: pinned host keys, passphrase pipes, frame client, `neore-host` upload checked by SHA-256                                                                              |
| `acp`, `acp_permission` | Coding agents speaking the Agent Client Protocol: the spawn plan and local-only permission answers                                                                                                    |
| `frame`, `host`         | The `neore-host` protocol: big-endian `u32` length + JSON, stdout carries frames only                                                                                                                 |

## Test vectors

Two sets of vectors are shared on purpose:

- **Action vectors**, `tests/common/actions.json` (loaded by `tests/common/vectors.rs`).
  The desktop engine's unit test and `tests/host_stdio.rs` (in-process and the
  real binary over stdio) run the same list and must observe the same result. A
  new tool or a changed result goes into this file.
- **HMAC/envelope vectors**, pinned on both sides: `src/envelope.rs` here and
  `backend/lunora/devices/lib/signing.test.ts`. Change one, update both.

## Testing

```bash
cargo test --manifest-path packages/device-core/Cargo.toml
cargo test --manifest-path packages/device-core/Cargo.toml --no-default-features   # what neore-host runs
cargo fmt  --manifest-path packages/device-core/Cargo.toml -- --check
```

- `tests/ssh_host.rs` starts a throwaway `sshd` on 127.0.0.1 as the current
  user, with its own host key and a throwaway client key. It skips when there
  is no `sshd`; `NEORE_REQUIRE_SSHD=1` turns a missing one into a failure (CI
  sets it on Linux and macOS). Tests that install the host use a parameterised
  remote root and must never touch the real `~/.neore`.
- `NEORE_REQUIRE_SANDBOX=1` makes the sandboxed vectors fail instead of skip
  when the machine has no sandbox.
- `NEORE_HOST_BIN` points `tests/host_stdio.rs` at a prebuilt `neore-host`
  (CI uses the static musl build), so the same tests run against what ships.
- On Linux the default build needs `libdbus-1-dev` and `pkg-config` for the
  keyring.

Prefer debug builds locally; a release build is only needed for the addon and
`neore-host` packaging.
