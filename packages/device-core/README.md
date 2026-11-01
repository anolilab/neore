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
| Paired side (desktop)              | `approval`, `engine` (+ `engine/hosts`, `engine/host_agents`), `envelope`, `hmac`, `store`, `install`, `ssh`, `acp` | default features (`keychain`) |
| Shared actions (also `neore-host`) | `actions`, `fs`, `shell`, `sandbox`, `mcp`, `frame`, `host`, `agent_host`, `agent_env`, `acp_permission` | `--no-default-features`       |

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
| `mcp`                   | Local MCP servers over stdio, configured only in the local window, started inside the same OS sandbox as `shell_run` (below)                                                                         |
| `egress`                | The "common dependencies only" network tier: a CONNECT-only filtering proxy on the loopback and the fixed list of hosts it dials (below)                                                             |
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

## Sandboxed local MCP servers

A local MCP server starts in the same OS sandbox as `shell_run` (`sandbox.rs`), whether the
engine lists its tools for the manifest or a call starts it. It can change files only in the shared
folders and in a private folder of its own, and the rest of `$HOME` is hidden. Where the OS has no
sandbox (Windows, or a Linux kernel without Landlock) the server is **not started** unless the user
turned off "Require sandbox for shell commands and local MCP servers", exactly like a shell command;
its tools are then absent from the manifest and the device window says why. The environment is cleared
down to `PATH`, `HOME`, `LANG` and `TERM`, plus the server's own `env` from settings.

What a package launcher (`npx`, `uvx`, `bunx`, `deno`, `pip`, `cargo`…) is given, and why:

| Path or variable | Access | Why |
| --- | --- | --- |
| The shared folders | read, write | What a file-oriented server is for; the same folders `fs_*` and `shell_run` reach |
| `<app data>/mcp/<server>/` (private folder) | read, write | The server's own state: below. Created `0700`, one per server name, never shared between servers |
| `<private>/tmp/` as `TMPDIR`, `TMP`, `TEMP` | read, write | Scratch space; emptied at every start |
| `<private>/cache/<tool>/` as `npm_config_cache`, `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `UV_TOOL_DIR`, `YARN_CACHE_FOLDER`, `BUN_INSTALL_CACHE_DIR`, `DENO_DIR`, `COREPACK_HOME`, `GOCACHE`, `GOMODCACHE`, `XDG_CACHE_HOME` | read, write | Each package manager's cache. It is the only place a launcher may write, and it persists, so a server fetched once starts again from its cache (and offline) |
| `<private>/npmrc`, `npmrc-global` as `npm_config_userconfig` / `npm_config_globalconfig` | none (absent) | Keeps npm off the hidden `~/.npmrc`, which can hold registry tokens |
| `GIT_CONFIG_GLOBAL=/dev/null` | — | Git treats an unreadable `~/.gitconfig` as fatal; the hidden one is not consulted |
| Toolchains under `$HOME`: `.asdf .bun .cargo/bin .deno .local/bin .local/lib .local/share/{fnm,mise,pnpm,uv} .nix-profile .nvm .pyenv .rbenv .rustup .sdkman .volta go/bin` | read | So per-user `node`, `python`, `uv`, `cargo`… still run. Not `~/.cargo` whole (credentials), `~/.npmrc`, `~/.ssh`, `~/.config` |
| System folders (Linux: `/usr /lib /bin /etc /opt /nix /proc /sys /dev…`; macOS: everything outside `$HOME`) | read | The runtime and its libraries |
| `npm_config_offline`/`UV_OFFLINE` (network Off) or `npm_config_prefer_offline` (otherwise) | — | Off: a server whose packages are cached starts without waiting for a network it does not have |

The user's real caches (`~/.npm`, `~/.cache/uv`, `~/Library/Caches`) are deliberately neither
readable nor writable. A writable one would let a sandboxed server plant a package that the user later
runs outside the sandbox; a readable one can hold private-registry tarballs. The cost is one download
per server, through the server's network tier. A server's folder is deleted when the server is removed or
its command or arguments change (a new tier or `env` keeps it); a server that is edited to point at other
shared folders, another tier or another sandbox setting is restarted, because the running process is
keyed on the policy it was planned under.

A server that needs more than this (a config file under `$HOME`, a socket in `/run`) does not run
sandboxed; there is no per-server opt-out, only the global setting above.

## Network tiers

Shell commands and each MCP server have one of three tiers (`sandbox::NetworkTier`, stored as
`off` / `dependencies` / `on`). Shell commands default to Off; a server saved before the tiers existed
defaults to Common dependencies only where this computer can enforce it (macOS) and to Off elsewhere
(`mcp::default_network`), so it still starts. A newly added one is offered the same default in the device
window (a package launcher cannot start from an empty cache with the network off, but "Common dependencies
only" is not selectable where it is refused).

| Tier | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Off | `(deny network*)` | seccomp: `socket(2)` fails except `AF_UNIX` / `AF_NETLINK` | not enforced |
| Common dependencies only | enforced (below) | **refused** | not enforced (no sandbox) |
| On | open | open | open |

**Common dependencies only** runs a filtering proxy per sandboxed run (`egress.rs`) and points the program
at it with `HTTP(S)_PROXY` (and `NODE_USE_ENV_PROXY=1`). On macOS the profile denies all network and allows
outbound connections to exactly `localhost:<proxy port>`, so a tool that ignores the proxy variables has no
network at all. The proxy accepts only `CONNECT <host>:443` for a host in the list below (exact names, no
wildcards, no IP literals), resolves it itself, refuses addresses that are loopback, private, link-local or
otherwise special-use (including an IPv4 address carried in IPv6: mapped, `::/96`, NAT64, 6to4; Teredo is
dropped outright), and connects to the address it checked, with one deadline for lookup and connect. Plain-HTTP
proxying is refused. When a failed run asked for a host the list does not contain, the error ends with the names
that were blocked.

After the `200` the proxy reads the client's first TLS record and requires a ClientHello whose server name
(SNI) is exactly the CONNECT host (case aside). No server name, a hidden one (Encrypted ClientHello), a second
`server_name`, a hello spread over several records, or bytes that are not a TLS handshake end the tunnel before
anything is sent upstream; the refusal is added to the blocked names with the reason. Without this check
the CONNECT line would only be a claim, and a client could open a pipe to a listed host's address and ask it for
any other site it serves. Clients that send an Encrypted ClientHello extension (browsers do, as GREASE) are not
served. Node (`npm`, `npx`), `uv`, `cargo`, `git` and `curl` were run through the real filter (`measure_dependency_hosts`)
and their hellos passed; `go`, `gem`, `yarn` and `pip` were not exercised. The proxy also bounds what a tunnel can
hold: a read or write that stalls ends it once the other direction has been closed for 30 s or the proxy
stops, so a peer that stops reading cannot keep a worker.

It is **refused on Linux**, not downgraded: Landlock (ABI 4) filters TCP connects by port only, so allowing
the proxy's port would allow that port on every host (a program knows its own `HTTPS_PROXY`), and seccomp
cannot read a socket address. A per-server network namespace with a socket bridge would fix it and was not
built. A Linux server or shell command set to this tier fails to start with a message naming the setting; Off
and On work there. Windows has no sandbox, so no tier is enforced.

Limits worth knowing: the proxy checks the name in the handshake and does not open the TLS stream after it, so a
listed host that also serves other sites could be asked for them with an HTTP `Host` header inside the
encrypted stream, and a listed host receives whatever the program sends it (a push to a repository, a
package publish). The approval prompt says so.

A sandboxed server (and a sandboxed shell command) can still **write the shared folders**, so files it leaves
there (git hooks, package scripts, `node_modules/.bin`, build outputs) can run later outside the sandbox, when you
or another tool use that folder. Share only folders you trust a server with, and treat what it wrote there as you
would code it sent you.

The list (`egress::DEPENDENCY_HOSTS`; `cargo test egress` fails if this table and the code disagree):

| Host | Used by |
| --- | --- |
| `registry.npmjs.org` | npm, npx, pnpm, bun: metadata and tarballs |
| `registry.yarnpkg.com` | yarn: the registry alias in lockfiles |
| `nodejs.org` | node-gyp: Node headers for native addons |
| `pypi.org` | pip, uv, uvx: the index |
| `files.pythonhosted.org` | pip, uv, uvx: wheels and sdists |
| `index.crates.io` | cargo: the sparse index |
| `static.crates.io` | cargo: crate downloads |
| `proxy.golang.org` | go: module proxy |
| `sum.golang.org` | go: checksum database |
| `rubygems.org` | gem, bundler: downloads |
| `index.rubygems.org` | bundler: compact index |
| `github.com` | git over https; release downloads start here |
| `codeload.github.com` | repository and tag archives (npm and cargo git dependencies) |
| `objects.githubusercontent.com` | release assets and objects GitHub redirects to |
| `release-assets.githubusercontent.com` | release assets (managed Python builds, tool releases) |

`cargo test --lib measure_dependency_hosts -- --ignored --nocapture` runs `npx`, `uvx`, `cargo fetch`,
`git ls-remote` and a release download through the real filter in the real sandbox and prints what each did
(macOS; needs the network). Those reached the registry, index, download and `github.com` /
`release-assets.githubusercontent.com` entries and nothing else; the Go, Ruby, yarn, node-gyp, `codeload` and
`objects` entries come from the tools' documented defaults and were not exercised.

SSH servers (`neore-host`) keep the on/off shell-network switch; the tiers are not offered for them yet.
