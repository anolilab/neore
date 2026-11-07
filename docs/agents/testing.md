# TESTING — WHAT TO TEST AND HOW

Rules for agents writing tests and for review bots reviewing them. Change this file and the bot instructions in
`.pr_agent.toml` and `.coderabbit.yaml` together.

## What to test

- Test behaviour that can break: authorization and locked-thread guards, organization scoping, erasure and export,
  persistence and migrations, queues, schedules and resumes, races, external-format parsing, billing and claim-once
  paths, read-budget limits (test past 25 rows before claiming a read is complete, see `backend/AGENTS.md`).
- A bug fix starts with the fewest tests that fail on `main` for that reason, then the fix.
- Extend before you add: when an existing test or table covers the behaviour, add a row or an assertion there. Write a
  new test only when no case fits.
- Test at one layer: the lowest one that fails on `main`. Do not repeat the case in a wrapper, at each call site, or in
  web and mobile copies of the same logic.
- Do not test types, constants, re-exports, generated code (`_generated/**`, locale catalogs) or a library's own
  behaviour.

## How

- Cross-shard behaviour shows only in e2e: the harness is one database for every shard (`backend/lunora/AGENTS.md`).
- Time: fake timers and an injected clock, never a real wait or a wall-clock comparison. A test that crosses an hour or
  day boundary pins the clock.
- No per-test timeout and no `retry`. A flaky test is fixed, not retried or skipped without a written reason.
- Web components: `*.render.test.tsx` with Testing Library; assert what the user sees and does (roles, names, keyboard),
  not implementation details.
- Mobile: test the pure rules directly; inject a store or a platform module rather than mocking native modules
  globally.

## For reviewers

Ask only for fewer or smaller tests, or for the one missing test of a behaviour listed under "What to test". Do not ask
for more coverage in general, for snapshot tests, or for tests of code this pull request does not change.
