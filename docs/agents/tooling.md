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

## Linters

`pnpm lint` runs the root vis target `lint:all` (root `project.json`): every project's `lint:eslint`, plus the root
`lint:oxlint`, `lint:oxfmt` and `lint:dedupe`, in parallel, failing if any fails. vis treats the root `package.json`
scripts as root targets, except those that start with `vis run`. A root script that shares its name with a project
target (`deploy`, `test:storybook`, …) is set to a no-op in `project.json`, or `vis run <name>` would run it too
(`vis run deploy` would run the Alchemy deploy); `pnpm <name>` still runs it. Add a name there when a project gains a
target that matches a root script.

ESLint is the authority; oxlint is a fast first pass that enforces only what ESLint enforces, and gates CI like it.
`.oxlintrc.json` is generated, never edited: `pnpm lint:oxlint:sync` (`scripts/sync-oxlint-rules.mjs`) asks ESLint, from
inside each project, which files it lints and how each rule is set, then enables a rule only when ESLint sets it the
same way on every file it lints (or every file that loads its plugin), and ignores every file ESLint does not lint.
Every oxlint category is off. Run it after a change to an ESLint config or to `@anolilab/eslint-config`. When the
oxlint job reports code ESLint accepts, add the rule to `OXLINT_DIFFERS` in the script, with its reason, and sync.
No enabled rule is type-aware today, so oxlint needs no build; the sync turns type-aware mode on when one is, and from
then on oxlint needs built packages and the backend codegen first, like `lint:types`. The JS-plugin versions in the
`lint` catalog match the ones `@anolilab/eslint-config` loads, so both run the same rule code.

## Git hooks

`vis hook install` (run by `postinstall`) points `core.hooksPath` at `.vis/hooks/_`, which runs the scripts in
`.vis/hooks/`. **pre-commit** runs the secret scan and `vis staged` (oxfmt on staged code, data, CSS and HTML,
Prettier on Markdown, `sort-package-json` on staged `package.json` files, from the `staged` map in `vis.config.ts`).
**pre-push** runs the package.json order check and the same two formatters in check mode on every file changed since
the merge base with `main`, root files included. Both hooks and `pnpm lint:oxfmt` run from the repository root and read
the same ignore files: `.gitignore` (nested ones too) and the root `.prettierignore`, the only one, which also lists the
projects and docs that have no format check. pre-push then runs `vis affected lint:types:fast` from that same base. The fast type check runs `tsrs`, a Rust port of the compiler
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
