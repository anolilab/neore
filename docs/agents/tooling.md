# TOOLING — REFERENCE

Detail behind the pnpm and vis rules in the root `AGENTS.md`. Paths are repo-relative.

## pnpm 12

**pnpm is 12.x** (`packageManager`; a global pnpm switches to it per
project). Settings live ONLY in `pnpm-workspace.yaml` — `.npmrc` is read for
auth/registry alone, and since 12 an UNKNOWN key there fails every command
(`ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS`) instead of being ignored. Build
scripts are allowed through the `allowBuilds` map (values must stay booleans)
and `strictDepBuilds` is on, so a new dependency with an install script fails
`pnpm install` until it is listed. `autoInstallPeers` is OFF: a REQUIRED peer
(packem's `@visulima/packem-rollup`) must be declared by the package that uses
it, and `pnpm peers check` lists what is missing — most of it optional in
practice (framework adapters of `@visulima/storage-client`, `@lobehub/ui`/`antd`
for `@lobehub/icons`). An UNDECLARED optional peer that some other package
happens to provide can make `pnpm dedupe` flip-flop between two lockfiles on
every run (packem's `rollup`, now declared), so `pnpm dedupe --check` never
passes — run `pnpm dedupe` twice and compare hashes after a big bump.
`minimumReleaseAgeStrict` is on by default in 12 (we set `minimumReleaseAge`),
so a too-young version fails the install rather than falling back. pnpm 12 is a
native (Rust) binary: on a machine with a per-app firewall (OpenSnitch) each
release needs its own allow rule — unapproved, `install`/`audit`/`dedupe`/`view`
hang until a DNS error while `pnpm run` still works. Corepack 0.34 cannot run
it at all (it fetches no `@pnpm/exe.*` binary). CI's `pnpm/action-setup` v6.1
does.

## vis caching

- `vis.config.ts` holds task defaults, `project.json` per-project metadata. In
  `vis.config.ts`, `dependsOn` takes **target names only** — named inputs and
  file globs belong in `inputs`, and vis silently drops them from `dependsOn`,
  **disabling input tracking without saying so**. A cache hit restores files
  only for declared `outputs`, written `{projectRoot}/dist/**/*` (a bare
  `dist/**/*` restores nothing): without them `build:packages` said "read from
  cache" and left a missing or stale `dist` in place. `ai` and `service-sdk`
  declare theirs for `build` and `build:prod` in `project.json`.

## Deploying by hand

CI deploys; run this only when told to.

```bash
# Deployment (CI does this; do not run locally)
# Since pnpm 11 a script named `deploy` (also `clean`, `setup`, `rebuild`)
# SHADOWS the built-in, so bare `pnpm deploy` RUNS `alchemy deploy`.
# Write `pnpm run deploy` anyway; `pnpm pm deploy` is the built-in. CI calls the
# CLI itself: `alchemy deploy --stage "$DEPLOY_ENV" --yes` (deploy.yml).
DEPLOY_ENV=preview pnpm run deploy
```

## Git hooks

`vis hook install` (run by `postinstall`) points `core.hooksPath` at `.vis/hooks/_`, which runs the scripts in
`.vis/hooks/`. **pre-commit** runs the secret scan and `vis staged` (oxfmt on staged code and data files, Prettier on
CSS and HTML, Markdown untouched, `sort-package-json` on staged `package.json` files, from the `staged` map in
`vis.config.ts`). **pre-push** runs the package.json order check and the same two formatters in check mode on every
file changed since the merge base with `main` (root files included; Markdown is skipped, though a project's `lint:oxfmt` in CI checks it; both hooks go through
the `oxfmt:hooks` and `prettier:hooks` scripts, which also read `.formatignore-hooks`, the list of projects without a
`lint:oxfmt` task, read by no project check),
then `vis affected lint:types:fast` from that same base. The fast type check runs `tsrs`, a Rust port of the compiler
with TS 7.1 semantics (beta): about 13 s for every project, against 4.5 min for `lint:types`, plus up to a minute when a
backend change reruns its `codegen`. CI and
`pnpm lint:types` stay on `tsc` 6, so the hook can report a difference that only TS 7 sees; the CI result decides.
It reads the working tree, so it is skipped (with a note) when a pushed ref is not the checked-out commit, when only
deletions are pushed, when there are uncommitted changes or untracked TypeScript files, or on a platform tsrs has no
binary for (Windows on Arm).
`lint:types:fast` depends on the `build` of `@neore/ai` and `@neore/service-sdk` (they export only `dist`) and on the
backend `codegen`, not on `^build`, which would also build the Worker. Lint, tests and the full `tsc` check stay manual:
on a change to a root config every project is affected and they take many minutes. A new worktree needs `pnpm install`
before its first commit, or the hooks cannot find `vis`.
