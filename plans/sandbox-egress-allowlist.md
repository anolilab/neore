# Sandbox egress allowlist — letting agent code reach only the hosts it needs

Status: **proposed, not implemented.** This note is for the person who builds it;
nothing in the tree changes with it. Every file and line reference was read on
`origin/main` (`3798fbae`). Claims about the sandbox provider come from the
installed SDK types (`e2b` 2.56.0, pinned in `pnpm-workspace.yaml:74`); claims
the types do not settle are listed in §7 and must be tested before they are
relied on.

We run model-written and repository-supplied code in sandboxes, and today that
code can open a connection to any host on the internet. In a coding-agent run it
holds the user's provider API key in its environment and the whole repository on
disk. The goal is a per-run list of hosts, denied by default, so a prompt-injected
or malicious repository cannot send those out or pull a payload in from an
arbitrary server.

## 1. Current state

### 1.1 Coding-agent run (`backend/lunora/coding-agents/`)

- `startRun` creates the sandbox with `{ metadata, timeoutMs }` only
  (`runner.ts:139`; the interface is `runner.ts:80`, the E2B call
  `sandbox-provider.ts:77-86`). **No network option is passed**, so the SDK's
  default applies: "If `allowOut` is not specified, all outbound traffic is
  allowed" (`e2b` `dist/index.d.ts:8915`).
- The run is one detached bash script (`commands.ts:317-339`): `git clone`
  (`:328`), install the pinned CLI with `npm install -g` (`:333`, command at
  `:219-224`), then the agent (`:335`).
- The agent runs with `--permission-mode bypassPermissions` (Claude) or
  `--dangerously-bypass-approvals-and-sandbox` (Codex), `commands.ts:266-284`:
  nobody answers prompts, and the file says the E2B sandbox is "the boundary".
  Egress is half of that boundary and is currently open.
- The user's provider key is in the agent's environment for the whole run
  (`agentEnv`, `commands.ts:193-201`; passed at `runner.ts:165-168`). The GitHub
  token is deliberately not: it is read from a file by the clone subshell and
  deleted before the agent starts (`commands.ts:310-315`, `:328`).
- The clone URL host is user-supplied. `parseRepoUrl` accepts any `https://`
  host and returns `url.href` unchanged for a non-GitHub host
  (`commands.ts:121-162`, esp. `:148` and `:161`). It does not reject IP
  literals, `localhost` or single-label names. A GitHub token is attached only
  when `repo.github` is set (`execute.ts:160`).
- `CODING_AGENT_E2B_TEMPLATE` selects a prebuilt template with the CLIs
  installed (`sandbox-provider.ts:12`); without it every run installs from the
  npm registry.

### 1.2 Pull-request rebuild (same folder)

- `startPullRequest` creates a **fresh** sandbox, again with no network option
  (`runner.ts:374`), writes the stored diff and the GitHub credential, and starts
  `buildPullRequestScript` (`commands.ts:443-465`): clone (`:454`), `git apply`,
  commit with hooks disabled, push (`:461`).
- This sandbox runs no agent and no repository code; the patch is applied as
  data. It still holds the GitHub token, so open egress is defence in depth
  here rather than a live exploit path.
- **It never calls the GitHub API.** The pull request itself is opened by the
  backend (`PullRequestApi.createPullRequest`, `runner.ts:424-426`, called from
  `execute.ts`). The sandbox needs the git host and nothing else. It also only
  ever runs for `github.com` repositories (`pullRequestProblem`,
  `runner.ts:322-340`).

### 1.3 Device shell (`packages/device-core/`, shell in `apps/desktop`)

Device execution lives in `packages/device-core/src/` (Rust) with the Electron
shell in `apps/desktop`. (CLAUDE.md still says `apps/native` and
`src-tauri/src/device/`; neither exists on `main`.) The shell sandbox is
`packages/device-core/src/sandbox.rs`. What it does about the network differs by
OS, and **CLAUDE.md's "network is NOT restricted" is true only for two of three**:

| OS      | Mechanism                         | Network today                                                                                                                                                                                                                                                                                        |
| ------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | `sandbox-exec`, generated SBPL    | **Denied** unless the user turns on "Allow network for shell commands": `(deny network*)` when `Policy.network` is false (`sandbox.rs:42-44`, `:202-203`). The setting defaults to off (`store.rs:43-46`) and reaches the policy at `engine.rs:748`.                                                 |
| Linux   | Landlock, child between fork/exec | **Not restricted.** The ruleset is built with `handle_access(AccessFs::from_all(target))` and a scope set (`sandbox.rs:282-297`); no network access right is handled, although `target` is ABI V5. `Policy.network` is documented as "Linux does not enforce either value yet" (`sandbox.rs:42-43`). |
| Windows | none (Job Object only)            | **Not restricted**, and the command is reported as unsandboxed (`sandbox.rs:11-13`).                                                                                                                                                                                                                 |

The only control is all-or-nothing: one boolean, which the device window
describes as "blocked where the sandbox can enforce it (macOS)"
(`apps/desktop/src/device/window/device.ts:236-243`; the confirm text at `:334`
warns "an approved command could then send files or data to any server").
There is no host granularity anywhere. Local MCP servers are not sandboxed at all (CLAUDE.md, device
execution notes), and the approval text says local IPC and network access are
"NOT isolated" (`sandbox.rs:406-407`).

### 1.4 Other sandboxes that run model-written code

These also call `Sandbox.create` with no network option. They are outside the
three run types the brief names; §6 scopes them explicitly.

- `chat/tools/sandbox-node.ts:136` (a bot's long-lived "computer") and `:239`
  (a thread's command/code sandbox).
- `chat/tools/code-execution-node.ts:42` (`@e2b/code-interpreter`, `runCode`).
- `sandbox/pool.ts:33`: a pool of pre-warmed sandboxes created **before anyone
  has claimed one**. `claimWarmSandbox` exists (`sandbox/pool-functions.ts:22`)
  but grep finds no caller outside generated files, so no pooled sandbox is
  handed to any work today.

## 2. What each sandbox needs to reach

Hostnames below are the working hypothesis; the final list comes from the
measurement in stage 0 (§6), not from this table. The "unverified" rows are
things this document did not confirm in code.

### 2.1 Agent run

| Need                            | Host(s)                                            | Reached by                                                      | Status                                                                                                                                     |
| ------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Clone (GitHub repo)             | `github.com`                                       | `git clone` over https, `commands.ts:205-213`                   | git smart-HTTP on `github.com`; **unverified** that no redirect host is involved                                                           |
| Clone (other host)              | `repo.host` of the run                             | same                                                            | Comes from user input; must be validated before it joins a list (§3.3)                                                                     |
| Large files in the repo         | e.g. LFS hosts                                     | git-lfs, if present in the template                             | **unverified**: whether git-lfs is installed                                                                                               |
| Install the pinned CLI          | `registry.npmjs.org`                               | `npm install -g`, `commands.ts:219-224`                         | Not needed when `CODING_AGENT_E2B_TEMPLATE` ships the CLI; **unverified** that the CLIs' optional dependencies come from the same registry |
| Model API, Claude Code          | `api.anthropic.com`                                | the CLI, key from `ANTHROPIC_API_KEY`                           | **unverified**: any other endpoint the CLI calls (it runs with `DISABLE_TELEMETRY` and `DISABLE_AUTOUPDATER`, `commands.ts:196-199`)       |
| Model API, Codex                | `api.openai.com`                                   | the CLI, key from `CODEX_API_KEY`                               | **unverified**, same question                                                                                                              |
| The repository's own build/test | package registries and mirrors the repository uses | whatever the agent runs (`npm`, `pip`, `cargo`, `go`, `gem`, …) | Open-ended; this is the product trade-off in §3.2                                                                                          |

DNS resolution is implied for all of the above; how the provider treats the
resolver is open question 2.

### 2.2 Pull-request rebuild

| Need               | Host         | Reached by                     |
| ------------------ | ------------ | ------------------------------ |
| Clone the base     | `github.com` | `git clone`, `commands.ts:454` |
| Push the PR branch | `github.com` | `git push`, `commands.ts:461`  |

That is the whole list. No registry, no model host, no GitHub API host. This
makes it the cheapest sandbox to restrict and the right one to ship first.

### 2.3 Device shell

There is no fixed list: the command is whatever the model proposes and the user
approves (`shell_run`, `engine.rs:575`). The honest options are none (today's
macOS default), everything (the toggle), or a list the **user** maintains. §3.5
covers the last.

## 3. Enforcement options

### 3.1 What the provider offers (read from the SDK types)

`Sandbox.create` takes `network?: SandboxNetworkOpts` (`index.d.ts:9289`; type at
`:8912`) and `allowInternetAccess?: boolean` (`:9278-9280`, "works the same as
setting network `denyOut` to `[0.0.0.0/0]`"). The relevant parts:

- `allowOut`: CIDRs, bare IPs or hostnames, with `*.example.com` wildcards
  (the REST schema, `:2670`, says "Allowed entries always take precedence over
  denied entries"). `denyOut`: CIDRs/IPs only, "Domain names are not supported
  for deny rules" (`:2677`). Both accept a callback receiving `{ allTraffic,
rules }`; the idiom for default-deny is `denyOut: ({ allTraffic }) =>
[allTraffic]` (`:8935`), and `ALL_TRAFFIC = "0.0.0.0/0"` is exported
  (`:9941`).
- **`updateNetwork`** (instance `:10816-10822`, static `:9652`) changes a running
  sandbox, but "replaces the current egress configuration atomically — fields
  that are omitted are cleared" (`:9645`, `:9064-9071`). An update that forgets
  `denyOut` re-opens the sandbox; `egressProxy` is cleared the same way.
- **`egressProxy`**: a SOCKS5 proxy "you operate". Tunnelling happens on the host
  after `allowOut`/`denyOut` filtering; "UDP-based traffic — DNS and QUIC/HTTP3 —
  is not tunneled and leaves the sandbox the usual way"; it fails closed when the
  proxy is unreachable (`:8855-8862`). The address must be reachable from the
  provider's infrastructure and not resolve into a private range (`:8886`).
- **`rules`**: per-host header injection, which "does not allow egress on its own"
  (`:8822`, `:8943`). The API never returns the proxy password (`:8903`); it does
  return rule values through the sandbox info endpoint (`SandboxNetworkRuleInfo` inside
  `SandboxNetworkInfo`, `:9029` ff.), so an injected secret is not hidden from whoever can read the
  sandbox's info.
- Nothing in the types gives an **egress log** or a "blocked" event.

### 3.2 The options compared

| Option                                                                                         | Enforced where                                                                                                                                                                                | Cost to us                                                                                                                                                                                                                                                                              | Verdict                                             |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **A. Provider `allowOut` + `denyOut: [ALL_TRAFFIC]`, set at create**                           | Outside the guest, **inferred** (the proxy doc at `:8855` says tunnelling happens on the host "after `allowOut`/`denyOut` filtering"; no type states where the filter runs; open question 13) | One option in `SandboxProvider.create`, a pure allowlist function, no new infrastructure. No egress logs. Domain-match semantics and plan availability unverified (§7). Ties the policy to one vendor, but the `SandboxProvider` seam (`runner.ts:77-81`) keeps the policy itself ours. | **Recommended**                                     |
| B. Our own SOCKS5 egress proxy via `egressProxy`                                               | Outside the guest, on a host we run                                                                                                                                                           | A public, always-on VM or container: Workers cannot listen on SOCKS, so this is a new kind of deployment for this repo (Alchemy stack, secrets, scaling, patching). Gives per-connection logs and policy. Does **not** cover DNS/UDP. Still needs A's filtering in front.               | Later, if logs are needed                           |
| C. In-guest firewall (`nft`/`iptables`), `HTTP(S)_PROXY` env, a hosts file                     | Inside the guest, by code the agent can run                                                                                                                                                   | Needs root in the guest (unverified), and the agent is untrusted code in the same guest; the proxy variables are advisory. Anything the agent can undo is not a boundary.                                                                                                               | Rejected as the control; usable for preflight hints |
| D. Per-run DNS allowlist (a resolver we run, `resolv.conf` pointed at it)                      | Inside the guest                                                                                                                                                                              | Bypassed by an IP literal or any other resolver, and `resolv.conf` is guest-writable. Blocks nothing at the connection level.                                                                                                                                                           | Rejected                                            |
| E. `allowInternetAccess: false`                                                                | Outside the guest                                                                                                                                                                             | Blocks the model API and the git host too; every run type needs some egress.                                                                                                                                                                                                            | Not viable                                          |
| F. Provider `rules` to inject the GitHub credential at the edge, so no token sits in the guest | Outside the guest                                                                                                                                                                             | A `github.com` rule that is live while the agent runs lets untrusted code push with the user's token, which breaks the invariant at `commands.ts:310-315` (token gone before the agent starts). Rule values are also readable back from the info endpoint.                              | Rejected for the agent run                          |

### 3.3 Recommendation: option A

Set the allowlist at sandbox creation, from a pure function of the run:

- A new module `backend/lunora/coding-agents/egress.ts` exports
  `egressAllowlist(input)` for the three run types, returning a sorted,
  de-duplicated host list. Pure, so `runner.test.ts` (which already uses a fake
  sandbox) can assert the exact list per run.
- `SandboxProvider.create` (`runner.ts:80`) gains an optional `network:
{ allowOut: string[] }`. `sandbox-provider.ts` maps it to
  `{ allowOut, denyOut: [ALL_TRAFFIC] }`. The fake provider records it. This is
  the only interface change.
- **`repo.host` is user input, so it is validated before it is allowed.** Reject
  IP literals, `localhost`, single-label names and obviously internal suffixes
  (`.local`, `.internal`) with a plain message at run start. Do it in the new
  module rather than loosening or tightening `parseRepoUrl`, which other callers
  rely on. Prefer exact hosts over wildcards; a wildcard such as
  `*.githubusercontent.com` also covers user-writable hosts.
- **Verify the policy took effect before the agent starts** (a "fail closed"
  step). After `create`, `startRun` runs one short command in the sandbox that
  requests an allowed host (must succeed) and a host that must be blocked (must
  fail). If the blocked host answers, the policy was not applied (an unavailable
  feature, an ignored field) and the run stops with a clear error instead of
  running unrestricted with the user's key. This also gives the implementer a
  cheap regression test against provider behaviour changes.
- Keep the secret rules: nothing in the allowlist or probe is a secret, and no
  secret goes into the probe's command string (`commands.ts:1-10`).

**Profiles for the agent run.** The model API and the git host are fixed; what
the agent may fetch while working on the repository is a product decision, so
make it a named profile, not a flag:

- `strict`: git host, model host. Nothing else. Right for "review", "explain" or
  "small edit" work and with a prebuilt template (no npm host).
- `standard` (default): `strict` plus the common package registries for the
  ecosystems the repository uses, as exact hosts chosen from the stage 0
  measurement (for example npm, PyPI and its file host, crates.io's index and
  static hosts, the Go module proxy and checksum database, RubyGems). Without
  it, an `npm install` in the repository fails, which is most coding tasks.
- A user- or repository-extended list is out of scope for this plan (open
  question 9).

The residual risk of `standard` is stated plainly: an allowed registry host can
receive data as a request path or query, and the allowlist does not stop an
attacker who controls an allowed host. It removes arbitrary destinations; it
does not make the sandbox a data diode.

### 3.4 Why not the others

B is a good second step only if we need to see blocked connections; it adds an
internet-facing service to operate to buy logs and does not close DNS. C and D
fail the test "can the agent undo it". F is attractive for token hygiene but
trades one invariant for another; the existing arrangement (token only in the
clone subshell) is stronger. E cannot work.

### 3.5 Device shell (separate, later)

Do not fold this into the sandbox work above; the mechanisms differ.

- macOS: SBPL network filters are, to the best of our knowledge, port and
  `localhost`/`*` only, with no hostname; **verify against Apple's sandbox
  documentation and the profile grammar in use** before relying on it.
- Linux: Landlock's network rights (ABI V4+) restrict TCP bind/connect by port,
  with no host filter, and do not cover UDP; **verify in the `landlock` crate
  0.4.7 source** (`packages/device-core/Cargo.toml:24`). The current code does
  not use them (`sandbox.rs:282-297`).
- So a host allowlist on the device most plausibly means a **loopback CONNECT
  proxy in the Rust core**: the OS sandbox allows connections to that one port
  only, and the proxy applies the user's host list. The settings page would
  replace the single toggle with a list, and the approval text
  (`network_sentence`, `sandbox.rs:409-421`) would name it.
- Windows has no sandbox, so a proxy there is advisory (a command can ignore the
  proxy variables). It must be reported as "not enforced", never as a restriction.
- Local MCP servers are not sandboxed (CLAUDE.md) and would bypass any of this.

## 4. Failure behaviour

A blocked host must read as a blocked host, and must not burn the user's run.

**Today's wording blames the wrong thing.** A clone that cannot connect ends the
run script with `setup-failed:clone` ("Setup failed at step "clone"",
`runner.ts:268-270`); in the PR flow the same failure is reported as "Could not
clone the repository with your GitHub connection" (`PR_FAILURE`,
`runner.ts:395-400`), which sends the user to their GitHub settings for what
would be our own policy. Distinct wording is needed.

Where the failure can occur and what the user sees:

| When                                       | What actually happens                                                                                                                                                             | What to do                                                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy not applied (verification step)     | The blocked-host probe answers                                                                                                                                                    | Fail the run before the agent starts: "Could not apply the network policy; the run was not started." Kill the sandbox (existing `failRun` path, `execute.ts:125-129`).                |
| Required host unreachable at start         | Clone blocks until `timeout 180` (`commands.ts:328`); install until `timeout 300` (`:333`). Whether the provider drops or rejects packets decides if that is instant or minutes.  | Probe each required host with a short timeout in the verification step; fail fast with `network` as the failing step and a message naming the host.                                   |
| `repo.host` rejected by validation         | Never started                                                                                                                                                                     | Message at run start: the repository host is not allowed, and why (IP literal, internal name).                                                                                        |
| The agent needs a host outside the list    | The CLI or tool prints its own error (`ENOTFOUND`, `Could not resolve host`, `ECONNREFUSED`, a timeout); the model may retry for the rest of the budget (up to the 20-minute run) | On a non-zero exit or timeout, scan the log tail for those signatures and append one line: "Network access in this sandbox is limited to: <list>." The list is shown, not guessed at. |
| Model host blocked (misconfigured profile) | The CLI retries until the run times out                                                                                                                                           | Caught by the start-up probe above, so this should not reach the agent.                                                                                                               |
| PR rebuild cannot reach the git host       | `failed:clone` or `failed:push`                                                                                                                                                   | Separate wording for a network failure vs an auth failure. Distinguish with the same probe, not by guessing from git's exit code.                                                     |

Also: log the **effective allowlist and profile** into the run log at start
(`appendRunLog`, next to "Starting sandbox for …", `execute.ts:162`). That needs
no schema change and is what support reads first. Do not add a column in this
change.

The user cannot widen a run in the first version. A "retry with more access" action
is an open question (§7, 9) because widening is exactly the capability the feature
removes.

## 5. Test strategy

1. **Unit, no network.** `egressAllowlist` for each run type and profile; host
   validation (IP literal, `localhost`, uppercase, trailing dot, unicode, port in
   URL); the log-signature scanner. `runner.test.ts`'s fake provider asserts the
   `network` option passed for `startRun` and `startPullRequest`, and that a
   failed verification stops the run before `startDetached`.
2. **Provider contract, gated on `E2B_API_KEY`, never on every CI run.** One
   sandbox with the PR-rebuild list, then: an allowed host answers; a
   non-listed host does not; `curl --resolve allowed.host:443:<a blocked IP>`
   (SNI-versus-IP); a request to a literal IP; an IPv6 literal; UDP/53 to
   `1.1.1.1` and `8.8.8.8`; the cloud metadata address. These are the §7
   questions, answered once and written down in this document.
3. **Allowlist completeness, without breaking a real run.** In a throwaway
   sandbox with **no** egress policy, run each CLI through a short task against a
   small public repository for each ecosystem, recording the hosts it connects
   to (`ss -tnp` sampled in a loop, or a resolver log; check which tools the
   template has). The result is the stage 0 host list. Re-run it whenever
   `npmVersion` is bumped (`commands.ts:39`, `:50`), because a CLI release can add
   an endpoint.
4. **End to end on staging/preview.** A scripted run with `enforce` on, a task
   that needs the model, a clone and one registry install, and a negative case
   (a task that tries a non-listed host) whose log must show the §4 message.

## 6. Rollout

Gate everything behind one switch read like `CODING_AGENT_E2B_TEMPLATE`
(`sandbox-provider.ts:12`): `CODING_AGENT_EGRESS` = `off` (default until stage 3)
or `enforce`. How a backend env var reaches the deployed Worker is wired in
`alchemy.run.ts` and `backend/lunora/env.ts`, which this plan did not trace; the
implementer must follow the existing `E2B_API_KEY` path and keep
`deploy-env-bindings.test.ts` passing. Turning the switch to `off` is the
rollback, and it affects only sandboxes created afterwards.

| Stage | Scope                                                    | Exit criterion                                                                                                                                                    |
| ----- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Measurement only, no production change                   | The §7 questions answered; the host list per CLI and ecosystem recorded; the provider's plan and availability confirmed.                                          |
| 1     | PR rebuild sandbox, `github.com` only, with verification | A preview-stage PR is pushed under `enforce`; a probe to a non-listed host fails; no push regressions over a soak period. Smallest list, no repository code runs. |
| 2     | Agent run, `standard` profile, staging and preview first | Scripted runs for each CLI and ecosystem pass; the failure messages in §4 are seen once on purpose.                                                               |
| 3     | Agent run in production, default `enforce`               | Failed-run rate by step (`setup-failed:network`, install, agent) is no worse than before apart from intended blocks. Then add `strict` where it fits.             |
| 4     | The other sandboxes (§1.4), by decision                  | See below.                                                                                                                                                        |
| 5     | Device shell                                             | Its own plan; depends on §3.5 verification and a settings design.                                                                                                 |

**Stage 4, the other sandboxes, scoped explicitly.** The bot computer and the
thread sandbox exist to give a model a general-purpose machine (browsing,
installing packages); an allowlist there is a product decision, not a security
patch, and is out of scope here. `code-execution-node.ts` (`runCode`) is the
candidate for registry-only egress. The warm pool (`pool.ts:33`) is not
consumed today; if `claimWarmSandbox` ever gets a caller, the policy must be
applied **at claim** with `updateNetwork` (it replaces the whole config, so
send the complete list and `denyOut` every time), because a pooled sandbox is
created before its destination is known.

## 7. Open questions the implementer must answer first

Each is testable in stage 0. None should be assumed.

1. **Does `allowOut` alone deny everything else, or must `denyOut` be set?** The
   types say only that an unset `allowOut` allows everything (`:8915`). The plan
   assumes both fields are set.
2. **DNS.** Does `denyOut: 0.0.0.0/0` block UDP/53 to arbitrary resolvers? If
   not, DNS tunnelling is an open exfiltration channel, and the SDK itself says
   DNS "leaves the sandbox the usual way" when tunnelling (`:8857`).
3. **IPv6.** Is `::/0` covered by `ALL_TRAFFIC` (`0.0.0.0/0`)? A v6 route would
   bypass the list.
4. **How is a hostname matched** (SNI/Host header, or resolved IP)? Test with
   `curl --resolve`. This decides whether an allowed hostname can be used to
   reach a different server and how `*.` wildcards behave on apex domains (the
   `rules` doc says wildcards "match subdomains at any depth but not the apex
   domain", `:2684`; confirm it holds for `allowOut`).
5. **Plan tier and failure mode.** Is the `network` option available on our
   plan, and if not, does `create` throw or silently ignore it? The verification
   step is the defence either way; this decides whether the error is clear.
6. **Does the control plane survive deny-all?** The backend's `commands.run`,
   `files.write` and `connect` reach the sandbox through the provider; they are
   inbound, so they should, but confirm in stage 1 (every poll in
   `execute.ts:216-246` depends on it).
7. **Which hosts do the CLIs and the toolchain really contact** beyond the model
   API: update or version checks, telemetry that survives the environment
   switches, certificate-revocation endpoints, release-binary downloads that
   redirect to another host, git-lfs. Hosts behind redirects are the usual
   surprise (an install script that downloads a release asset).
8. **Is root available in the guest?** It decides whether the in-guest preflight
   tooling in §5 is possible at all.
9. **Product:** who may extend the list (the user per run, per repository,
   an organisation admin, nobody), and is there any "retry with network open"
   path? Each answer re-introduces an exception to the boundary.
10. **Private package registries and self-hosted git** are the real
    `standard`-profile gap. Is a non-GitHub `repo.host` supported for private
    repositories at all (no token is attached today, `execute.ts:160`), and how
    do their dependencies get through?
11. **Device:** whether the loopback-proxy design (§3.5) is acceptable for local
    MCP servers and for Windows, and whether the toggle is replaced or kept as
    the "everything" setting.
12. **Wiring:** the exact path from the deploy configuration to the new switch
    (§6), and whether the provider contract test (§5.2) may run in CI at all
    given the sandbox cost.
13. **Where is `allowOut`/`denyOut` enforced?** Option A's advantage over C
    rests on the filter running outside the guest. The only evidence is
    inference from the `egressProxy` doc (`:8855`). Confirm that root inside the
    guest cannot remove or bypass the filter (for example by changing routes or
    interfaces) before presenting it as a boundary.
