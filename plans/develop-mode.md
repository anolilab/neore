# Develop mode: pull requests across Git hosts

Status: plan, 2026-10-28. Builds on [acp-agent-host.md](acp-agent-host.md) (host agents, turn
changes), [device-execution.md](device-execution.md) (signed device calls),
[provider-capabilities.md](provider-capabilities.md) (capability rules) and the coding agents
(`backend/lunora/coding-agents/`). S1 has no dependency on open work.

## 1. Goal and decision

A **Develop** workspace in the web app and the desktop shell, next to chat. It lists the pull
requests that need the user, shows one as a reviewer reads it, lets an agent explain it, and posts
the user's review back to the host. It works the same way on every supported Git host:

| Host | Cloud path (backend → host API) | Device path (desktop or SSH host) |
| --- | --- | --- |
| GitHub | github.com | GitHub Enterprise Server |
| GitLab | gitlab.com, internet-reachable self-managed | self-managed behind a firewall |
| Forgejo / Gitea | codeberg.org, internet-reachable servers | servers behind a firewall |
| Bitbucket | bitbucket.org | — (Bitbucket Data Center is out of v1) |
| Azure DevOps | dev.azure.com, `*.visualstudio.com` | — (Azure DevOps Server is out of v1) |

GitLab calls a pull request a merge request; the UI uses the host's own word.

**Decision.** One host adapter in the backend (`backend/lunora/source-control/`) with one driver
per host. Each driver declares a **capability report**, read with the same rules as
`@neore/ai/capabilities`: `unknown` is unsupported, and nothing is inferred from a host name in the
UI. Two transports carry a driver's calls:

1. **Cloud path.** The backend Worker calls the host's REST or GraphQL API with the user's token.
   It cannot run a host CLI. This covers every hosted service and any self-hosted server the
   internet can reach.
2. **Device path.** For a server only the user's network can reach, the call becomes a signed
   device call that the desktop or a paired SSH host executes, exactly like a device tool: the
   backend signs, Rust verifies, the page only relays. On the device the driver may use a token
   from the OS keychain or an existing CLI login (`gh`, `glab`, `fj`/`tea`). The token never
   leaves the device.

The UI never branches on the host. It branches on the capability report, and a test enforces it
(the same grep test as provider capabilities S3).

## 2. Current state (checked)

- No develop mode or code workspace exists. The composer modes are Text, Image, Video and Audio
  (`plans/composer-modes-design.md`).
- `connectors/seed.ts` has one Git host connector: GitHub, OAuth through the provider's hosted MCP
  server, scopes `repo`, `read:org`, `read:user`. No GitLab, Bitbucket, Azure DevOps or Forgejo
  connector exists.
- `coding-agents/execute.ts` reuses that connector token for REST (`getGithubToken`, `POST
  /repos/{o}/{r}/pulls`), and `coding-agents/commands.ts` (`gitAuthEnv`) hands it to git as an
  `http.https://github.com/.extraheader`. Both are GitHub-only.
- Webhook triggers already verify GitLab's secret token (`gitlab-token` scheme in
  `webhook-trigger-fields.tsx`).
- ACP S9 (#401) renders a turn's own changes as a unified diff with line counts; its diff
  component is the starting point for the PR diff view.

## 3. Host facts the design rests on

Checked against the hosts' API documentation on 2026-10-28. "To verify" cells are not yet
confirmed and are checked in the slice that adds that driver; until then the driver declares the
capability `unknown`.

| Capability | GitHub | GitLab | Forgejo / Gitea | Bitbucket | Azure DevOps |
| --- | --- | --- | --- | --- | --- |
| Batched review (stage, then submit once) | yes: pending review, then submit event | yes: draft notes, then `bulk_publish` | to verify (pull reviews API) | to verify | no: threads publish at once |
| Verdicts | approve, request changes, comment | approve; "requested changes" only via `bulk_publish` `reviewer_state` | to verify | to verify | reviewer vote (10, 5, 0, -5, -10) |
| Line comments | `path` + `line` + `side`, `start_line` | `position` with base/head/start SHA and old/new line | to verify | to verify | thread with `filePath` + left/right line |
| Viewed marks on the host | yes (GraphQL `markFileAsViewed`) | not found | not found | not found | not found |
| Auto-merge | yes (GraphQL) | yes (`auto_merge`; `merge_when_pipeline_succeeds` deprecated) | to verify | to verify | yes (auto-complete) |
| Re-run a check | check run `rerequest` | job `retry` | to verify | to verify | Pipelines API (to verify) |
| "Needs my review" list | search `review-requested:` (to verify) | `reviewer_username` / `scope=reviews_for_me` | to verify | to verify | to verify |
| OAuth for a web app | code + PKCE (S256), device flow | OAuth provider (`api`, `read_api`) | to verify | to verify | `vso.code_write`, `vso.threads_full` |
| Diff size limits | 3000 files per PR, 100 per page | offset or keyset pages, 100 per page | instance-set page cap | to verify | to verify |
| Conditional requests | ETag, and a 304 does not count against the rate limit | to verify | to verify | to verify | to verify |

Consequences:

- **Where a host has no batched review, the review is emulated**: drafts live in Neore, and
  submit posts the comments and then the verdict. The UI says so on that host, from the report.
- **Viewed marks are the host's own only on GitHub.** Everywhere else Neore keeps them, keyed to
  the pull request and the file's content hash, and the count says "viewed in Neore".
- A verdict the host lacks is not offered (capability absent), never mapped to a near match
  silently. GitLab's "request changes" is offered only where `bulk_publish` accepts it.

## 4. Design

### Host adapter and drivers

`source-control/drivers/<host>.ts`, one module per host, each exporting a driver: list pull
requests (needs my review, mine, by repository), read one (description, commits, files, diff
pages, conversation, checks), and the write operations its report declares (comment, reply,
resolve, review submit, verdict, viewed mark, re-run, merge, auto-merge, create a pull request).
Drivers return host-neutral shapes; host ids and line addressing stay inside the driver.

### Repository identity

`source-control/identity.ts` parses a remote into `{ hostKind, origin, path }`: SSH and HTTPS
forms, ports, GitLab subgroups (`group/sub/repo`), Forgejo under a URL subpath, Bitbucket
`workspace/repo`, Azure `dev.azure.com/org/project/_git/repo` and `org.visualstudio.com`. A
custom domain's host kind is **declared by the user** when they connect it, never guessed from
the name. Pure and table-tested.

### Credentials

- Hosted services sign in with OAuth where the host offers it to third-party web apps, through
  the existing connector OAuth plumbing (`connectors/oauth.ts`), one connector per host. GitHub
  reuses its connector.
- A personal access token is the fallback and the only option for a self-hosted server on the
  cloud path. It is stored encrypted at rest in the BYOK `{ enabled, encryptedKey }` shape (like
  messenger keys), never returned to the client after saving.
- **Every token is bound to its exact origin.** A driver sends a token only to the origin it was
  saved for: no redirect follow-through to another host, no `extraheader` scoped wider than that
  origin. `gitAuthEnv`'s extraheader is checked against this when S9 generalises it.
- Device-path tokens stay on the device (keychain or CLI login) and are never sent to the backend.

### Network rules

A user-supplied base URL passes the SSRF guard (`validateDomain` rules: no loopback, private or
link-local addresses on the cloud path). Every outbound call has a deadline
(`fetchWithDeadline` / `fetchOk`), and every failed response body is consumed or cancelled.
Pagination is bounded per request and per PR (§3 limits); a PR over the limit shows the files it
could load and says how many it left out.

### Freshness

- Lists are cached per user in shard tables and refreshed on open and by polling.
- Polling covers only repositories the user chose to watch, through the shard tick fan-out
  (`noteShardDue`), never a global loop. GitHub polls with ETag so an unchanged list costs nothing.
- Webhooks are optional, for users who can install them: they reuse the trigger webhook plumbing
  and only mark a repository dirty; polling must work without them.
- A new review request notifies through `notify()` (Web Push where subscribed).

### Review flow

Drafts (pending comments, verdict, summary) are stored server-side per user and pull request, so
they survive reloads and devices. Submit sends them as one review where the host supports it
(§3), confirms the host accepted it, and only then clears the draft. Viewed marks reset for a file
whose content changed since it was marked.

### AI review

A **guide** for one pull request: stops in reading order (the core change first, then what
depends on it), each pointing at the lines worth reading, mechanical changes (renames, snapshots,
lockfiles) grouped last, and every changed file covered somewhere. It is generated by our own
agent on the cloud path from the diff, or by a host agent in a local checkout on the device path,
saved per pull request and head commit, and offered for regeneration when the head moves. The
user's review instructions shape it.

PR titles, bodies, diffs and comments are **untrusted input**. The prompt carries them as
evidence, not instructions (the same wrapping as the prompt optimizer), and the guide can only
propose actions (a comment, a label), which the user applies.

### Write actions and agents

Commenting, submitting a review, approving, requesting changes, re-running checks and merging are
user actions in the UI. Exposed to chat agents as tools, every write is `ask`, and headless runs
drop them, like other `ask` tools. Read tools are `on`.

### Work on a pull request

"Work on this PR" opens a thread with the pull request attached. A cloud coding agent works in a
sandbox clone of its branch; a host agent works in a local checkout on the desktop or SSH host.
The resulting push and the pull request it opens go through the adapter, which retires the
GitHub-only path in `coding-agents/execute.ts`. Pull requests are linked to the thread that made
them.

### Backend shape

A new module `source-control/` owns its tables (connections, cached pull requests, drafts, viewed
marks, guides), each with RLS policies or an `UNPOLICED_TABLES` reason, `.output()` on every
procedure, authz-matrix rows, and GDPR erasure and export in `source-control/gdpr.ts`. The Develop
route adds no query to `/chat`'s first paint.

## 5. Slices

**S1 — Adapter, identity, GitHub read-only.** Driver interface, capability report, identity
parser, the GitHub driver's reads through the GitHub connector token, and the Develop route:
inbox (needs my review, mine, ready to merge, drafts) and a pull request's description, commits,
files, diff and checks.
- Acceptance: the identity parser passes its table (SSH, HTTPS, port, subgroup, subpath, Azure
  forms); a GitHub PR with more than 300 files lists every file up to the host's limit and says
  how many it left out past it; the grep test fails when a host name is injected into UI gating
  code; `/chat` first-paint query count is unchanged.

**S2 — Review on GitHub.** Server-side drafts, line comments and replies, resolve, one batched
submit with a verdict, native viewed marks.
- Acceptance: a draft survives a reload and a second device; a submit that the host refuses keeps
  the draft; a review submitted from Neore shows as one review on github.com; a file marked viewed
  in Neore is viewed on github.com and the reverse.
- Built as: drafts are one `reviewDrafts` row per user and pull request, claimed by a submit
  (lease) so two devices post one review. A reply cannot ride in the host's review call, so it
  is posted at once and the capability report says so (`review.replies` is `divergent`). Viewed
  marks live on the host only; Neore stores none. A submit whose answer never came is
  `unconfirmed`: the draft is kept and the person is told to check the host first.

**S3 — Checks and merge.** Required-aware checks state, re-run of the narrowest scope, merge and
auto-merge where declared, each behind a confirmation.
- Acceptance: an optional failing check does not mark the pull request red; a re-run targets one
  job; merge is refused when the host's rules refuse it, with the host's reason shown.

**S4 — GitLab on the cloud path.** OAuth connector for gitlab.com, PAT for reachable self-managed
servers, the GitLab driver with draft notes and `bulk_publish`, viewed marks kept in Neore.
- Acceptance: S1-S3 acceptance against a GitLab merge request, except where the report declares a
  capability absent; the count reads "viewed in Neore"; a token saved for one origin is never sent
  to another (test with a redirect to a second host).

**S5 — Device path.** A driver call for a firewall-bound server runs as a signed device call on the
desktop or SSH host, with the token from the keychain or a CLI login there.
- Acceptance: a GitHub Enterprise Server and a self-managed GitLab reachable only from the device
  list and review; the backend never receives the token (test); with the device offline the call
  fails with "the device that reaches this server is offline".

**S6 — Forgejo and Gitea.** The driver, verifying the §3 "to verify" cells first.
- Acceptance: S1-S3 acceptance on codeberg.org and a subpath-hosted server; required-check name
  patterns are matched without a backtracking regex (a hostile pattern cannot stall the Worker).

**S7 — Bitbucket and Azure DevOps.** Both drivers, verifying §3 first; batched review emulated
where the host has none.
- Acceptance: an emulated review that fails halfway reports which comments landed and keeps the
  rest as drafts; Azure's verdicts are offered as its votes.

**S8 — Guide.** The AI guide of §4, cloud and device generation, saved per head commit.
- Acceptance: every changed file appears in the guide; a new head commit marks the guide stale;
  an instruction planted in a PR body does not change the guide's structure or trigger an action
  (test); a proposed comment is posted only after the user applies it.
- Built as: stops come back from the model or the agent as untrusted JSON and are rebuilt by
  `assembleGuide` (coverage, order, line ranges and proposals are decided in code). One
  `pullRequestGuides` row per user, pull request and head commit, three kept; the page reads the
  newest guide for the head it shows, else an earlier one marked stale. Cloud: a job on the jobs
  queue, charged to the daily text quota. Host: a coding agent on a paired computer whose approved
  folder names the repository, started and prompted in one transaction. A proposed comment becomes
  a review-draft comment on apply and reaches the host only when the review is submitted; a label
  is shown as a suggestion because no driver declares a label write. The SSH-server path waits for
  S5 and other hosts for S4/S6/S7: the guide is read through the driver's read members and gated
  by the `pullRequest.guide` capability, so a later driver plugs in.

**S9 — Work on a pull request.** The Work-on-PR thread, sandbox and host checkouts, pull request
creation through the adapter on every host, links from pull request to thread.
- Acceptance: a coding agent opens a GitLab merge request; the GitHub-only path in
  `coding-agents/execute.ts` is gone; the git credential is scoped to the one origin.

**S10 — Freshness.** Watched repositories, shard-tick polling with ETag, optional webhooks, review
request notifications.
- Acceptance: an unchanged GitHub list costs one 304 per poll; polling stops for a repository the
  user stops watching; a webhook only marks a repository dirty and never carries data the backend
  trusts without reading it from the host.
- Built as: a `watchedRepositories` row per user and repository holds the cache (page one of the open
  pull requests that name the user as a requested reviewer), its ETag and login, and the schedule.
  The shard tick leases each due row (`dispatchDueRepoPolls`, also a `shardSweeps()` backstop) and
  schedules a poll; an unchanged list is one conditional request, a 304 that changes nothing. The first
  poll is a baseline and notifies nobody. A webhook (`/source-control/webhook/:watchId`, the repository's
  own secret, `X-Hub-Signature-256`) is verified over the raw bytes, claimed once, and sets `dirtyAt`
  only: the body is never parsed. Review teams (`requested_teams`) and repositories with more than 100
  open pull requests are not covered yet; the poll reads page one. A request's notification key
  (`requestDedupeKey`) includes the pull request's `updatedAt`, so a request that falls out of the
  cached page and comes back after an update notifies again.

## 6. Invariants

- The UI decides from the capability report only; `unknown` is unsupported.
- A token is sent only to the origin it was saved for; device-path tokens never leave the device.
- Host content is untrusted; it never becomes instructions and never triggers a write by itself.
- Every write to a host is a user action or an `ask` tool.
- A draft is cleared only after the host confirmed the review.

## 7. Risks

- **Rate limits.** Polling many repositories can exhaust a user's API budget. Mitigated by
  watching only chosen repositories, conditional requests and shard-paced polling.
- **Hostile patterns.** Branch-protection and required-check patterns come from the host; matching
  them with a backtracking regex can stall the Worker. Use a linear glob matcher.
- **Token reach.** A single misplaced credential header leaks a token to another host. Covered by
  the origin-binding invariant and a redirect test per driver.
- **Host API drift.** Five APIs change independently. Each driver has contract tests against
  recorded responses, refreshed when a host announces a change.

## 8. Not in v1

Bitbucket Data Center and Azure DevOps Server; stacked pull requests; dependency-alert pages;
issue tracking beyond what a pull request links; a menu-bar or tray count.

## 9. Open questions

1. **Placement.** This plan assumes Develop is a new workspace (its own route and sidebar entry in
   web and desktop), not a fifth composer mode. Confirm.
2. **OAuth apps.** Which hosts get a registered OAuth app for v1 (GitHub exists; GitLab, Bitbucket
   and Azure need registrations), and which stay token-only.
3. **Self-hosted on the cloud path.** Allow saving a token for an internet-reachable self-hosted
   server in the cloud, or require the device path for every self-hosted server.
