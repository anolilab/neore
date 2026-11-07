# REVIEW CHECKLIST — BEFORE A PULL REQUEST

Read this before opening a pull request and before each push to one. Every item below was raised by a reviewer on
a recent pull request and cost at least one extra review round. Check each one that touches your change; say in the
pull request body which ones you checked and how.

## Size and shape

- Keep a pull request at about 800 changed lines or fewer, generated files (`backend/lunora/_generated/**`,
  `apps/web/src/locales/**`) not counted. One behaviour per pull request. Larger work splits into a stack only when
  each part works alone; prefer separate pull requests from `main` over a stack.
- Do not open a pull request on top of another open one unless it cannot work without it. A stacked pull request is
  rebased onto `main` (`git rebase --onto origin/main <old base head> <branch>`) as soon as its base merges.
- Push fixes in batches: one push per review round. Every push starts a full re-review.

## Hit every surface

The most common gap is a change that works on the path you tested and is missing elsewhere. Say which of these applied:

- **Entry points.** A behaviour reachable from the chat view is usually also reachable from settings, the command
  palette, a keyboard shortcut and the thread menu.
- **Clients.** Web, desktop (wraps web, adds the Electron shell), mobile (separate navigation), the browser extension and
  the CLI. Shared logic lives in `packages/client-runtime` and `packages/chat-ui`.
- **Agents.** A capability a person can trigger is usually one an agent should reach through tools, and scheduled tasks,
  triggers and sub-agents run the same backend paths. Keep it a backend function, not handler or component code.
- **Reverse states.** A way in needs a way out and a way to see it: snooze and wake, lock and unlock, archive and
  restore, link and unlink.
- **Runners.** Cloud runs, host runs on a paired computer, SSH servers and cloud sandboxes differ; decide for each.

## Access and privacy

- **Locked threads.** A thread locked with a passcode never sends its title, prompts or messages anywhere new: not to a
  model (titles, summaries, handoffs), not to a phone, not to another participant, not to anyone else's export. The
  owner's own data export still includes it. Check the lock at
  the moment of use, not only when something is saved; a lock can arrive later.
- **Deleted or no-longer-shared threads** behave like locked ones for anything sent to someone other than the owner
  after the fact. An archived thread stays the owner's: their own task runs may still continue it.
- **Organizations.** Every query for organization data filters by the caller's organization taken from the session on
  the server, never from client input. A person's own data outside any organization stays visible to them. Totals include members who have left. An admin view shows organization projects
  only, never a member's personal projects by name, and never narrows to one person.
- **Group and shared runs.** A tool that reads private data (pull requests, connectors, secrets) checks at execution
  time that the run is the owner's own run, whatever path added the tool (skill, app, approval, extra tools).
- **Account switch and sign-out** clear cached data of the previous account on every client (web, desktop, mobile,
  extension storage, keychain).
- **Authz matrix.** Every new client-reachable procedure gets a reviewed row in `docs/security/authz-matrix.md`
  (`lunora/authz-matrix.guard.test.ts`, rules in `backend/lunora/auth/AGENTS.md`).

## Data lifecycle

- **Erasure and export.** Every new table or field holding user data is deleted by account deletion and included in
  the export, through the module's `gdpr.ts`. An export pages through all rows and reports done only after the last
  page; it never drops rows silently.
- **Retention.** Say how a new kind of row stops growing.

## Backend correctness

- **Read budget.** No unbounded walk of a thread, history or member list inside one function call; page, index or
  keep a pointer. Test a long history.
- **Paid calls run once.** A model call that is charged claims its work once (`backend/lunora/lib` claim-once) so a
  retry or a concurrent run never pays twice, and a charged result is stored or refunded.
- **Concurrency.** For anything queued, scheduled or resumed: two tabs, two runs, a stop that arrives late, a retry
  after a lost send. Model it as explicit states with one owner of each transition.
- **Time.** Dates in the user's time zone where the user sees them; rollups do not split or move a reply across a day
  boundary unexpectedly.
- **Large inputs.** Lists past the first page (projects past 100/200, long check lists, big logs, many review threads)
  are paged, kept newest-first where order matters, and marked when cut ("truncated, N more").
- **Stale results.** A result for an older request (an earlier visit, a reopened dialog) never replaces a newer one.

## Tests

Follow [testing.md](testing.md): the fewest tests that fail on `main` for the reason, at the lowest layer, no real
waits or retries.

## Client and copy

- Every user string through lingui, catalogs regenerated; numbers and dates through the locale formatters.
- Accessible names, required fields announced, keyboard paths tested; touch targets at least 44 pt.
- Errors from the server are shown as errors, never as "not found" or an empty state.

## Before every push

Run from the repository root. The pre-commit hook formats and sorts staged files, and the pre-push hook checks
package.json order, formatting and types (`vis affected lint:types:fast`, the fast `tsrs` check); lint, tests and
the full `tsc` type check below are yours to run:

```bash
pnpm lint:oxfmt:fix                    # formatting, the most frequent avoidable CI failure
pnpm exec sort-package-json <changed package.json files>
pnpm lint:types                        # tsc, as in CI; before opening a pull request and before a push that changes types
pnpm exec vis affected lint:eslint
pnpm exec vis affected test
```

## Independent review

Before opening the pull request, and before each later push that changes behaviour, have a second agent review the
diff against this checklist without your reasoning: give it `git diff origin/main...HEAD` and this file, ask for
concrete failures only, then fix or answer each finding. Prefer the strongest available model for both the work and
the review.
