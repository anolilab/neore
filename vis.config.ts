import { defineConfig } from "@visulima/vis/config";

// Workspace task defaults, hand-merged from the former nx.json.
// Per-project configuration lives in each project's project.json
// (sourceRoot, tags, implicitDependencies, targets).
//
// NOTE: `dependsOn` takes *target* names ("^build", "test", …).
// File/named-input patterns belong in `inputs`. vis silently ignores
// unknown `dependsOn` entries, so mixing the two disables input
// tracking without any error — keep them strictly separate.

export default defineConfig({
    // Guards the dependency graph. A violation FAILS `vis run` (exit 1);
    // `--skip-constraints` bypasses it. The rules below describe the graph as it
    // actually is today, so adding one is a deliberate act, not an accident.
    //
    // The rule that earns its keep is `library: ["library"]` — a package reaching
    // back into an app or a service is the failure that rots a monorepo quietly,
    // and nothing else in the toolchain catches it.
    //
    // `enforceApplicationBoundary` is off on purpose. It forbids depending on ANY
    // deployment target, but `web` and `browser-extension` legitimately import
    // `@neore/backend`'s generated API surface (`api`, `dataModel`) — 42 value
    // imports and 76 type-only ones. That edge is the architecture. The narrower
    // `allowedDependencyTypes` below still bans everything else.
    // TODO: task caching is per-target only (`cache: true` below) and stays on
    // this machine. vis also ships a remote cache — `--cache-backend http`
    // (Turborepo-compatible) or `reapi` — and a `vis cache` family for
    // inspecting it. CI wires up neither, so every run rebuilds from scratch.
    // Note that .github/workflows/lint.yml calls a reusable workflow from
    // anolilab/workflows, so enabling this means passing inputs there rather
    // than adding a step here.

    constraints: {
        typeBoundaries: {
            allowedDependencyTypes: {
                application: ["library", "service"],
                library: ["library"],
                service: ["library"],
                tool: ["library"],
            },
            enforceApplicationBoundary: false,
        },
    },

    // Replaces secretlint. `vis secrets` carries a bundled gitleaks-compatible
    // ruleset, scans git history (`--history`), and emits SARIF — none of which
    // the old setup had, and it needs no config file of its own.
    //
    // `kingfisher.cypress.2` is Cypress's `projectId` config key. This repo has no
    // Cypress, but it does have a projects feature, so the rule fired on every
    // `projectId:` in the tree — 93 of 118 findings, all noise.
    secrets: {
        baseline: ".secrets-baseline.json",
        // The 26 baselined findings are all false positives in e2e fixtures,
        // generated code and a docs example.
        //
        // `redact` masks values in scan output. It does NOT reach `--init`: the
        // baseline was written with `vis secrets --init --redact`, and any
        // refresh needs that flag again or it re-commits the values in clear.
        redact: true,
        rules: {
            // `kingfisher.azureopenai.host.1` matches an Azure OpenAI resource
            // HOSTNAME (`<name>.openai.azure.com`), which is not a credential. The
            // native-provider feature validates and pins those hosts, so its code
            // and tests name them on purpose; the key itself is never in source.
            exclude: ["kingfisher.cypress.2", "kingfisher.azureopenai.host.1"],
        },
        walk: {
            // `_generated/` is machine-written from `backend/lunora/**`, which IS
            // scanned — so nothing reaches it that was not already checked at its
            // source. It is excluded because the baseline anchors findings to line
            // numbers, and every codegen run shifts them: a Lunora upgrade grew
            // functions.ts and three already-baselined false positives
            // (`createApiKey`/`listApiKeys`/`revokeApiKey` in the function
            // registry) came back as NEW, blocking an unrelated commit.
            //
            // Needs the `**` form. The docs say directory markers are supported,
            // but a bare `backend/lunora/_generated/` matches nothing here.
            //
            // The lingui catalogs are excluded for the same reason: they are
            // extracted from `apps/web/src/**`, which IS scanned, and every
            // `lingui extract` renumbers them — `msgid "One-time password"`
            // tripped the generic-password rule and would re-surface on each run.
            excludePatterns: ["backend/lunora/_generated/**", "apps/web/src/locales/**"],
        },
    },

    // Replaces lint-staged. The old `@anolilab/lint-staged-config` dep exported a
    // `defineConfig` builder that this repo never called and shipped no
    // `.lintstagedrc`, so nothing ran on commit — this is the first staged config
    // the repo has actually had.
    //
    // eslint is deliberately NOT here. It is red repo-wide (8.8k problems across
    // 11 projects), so wiring it to pre-commit would block every commit until
    // that debt is paid. Add it once `pnpm lint:eslint` is green.
    staged: {
        "*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,json,jsonc,yml,yaml,md,css,html}": "prettier --config=.prettierrc.cjs --ignore-unknown --write",
    },

    security: {
        allowBuilds: {
            // "esbuild": true,
        },
    },

    namedInputs: {
        default: ["sharedGlobals", "{projectRoot}/**/*", "!{projectRoot}/**/*.md"],
        sharedGlobals: ["{workspaceRoot}/.nvmrc", "{workspaceRoot}/package.json", "{workspaceRoot}/tsconfig.base.json"],
        production: [
            "default",
            "!{projectRoot}/eslint.config.mjs",
            "!{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)",
            "!{projectRoot}/tsconfig.spec.json",
            "!{projectRoot}/src/test-setup.[jt]s",
        ],
    },

    tasks: {
        build: {
            dependsOn: ["^build"],
            inputs: ["production", "^production"],
            cache: true,
        },
        "build:prod": {
            dependsOn: ["^build:prod"],
            inputs: ["production", "^production"],
            cache: true,
        },
        "lint:eslint": {
            inputs: ["default", "{workspaceRoot}/eslint.config.mjs"],
            cache: true,
        },
        "lint:eslint:fix": {
            inputs: ["default", "{workspaceRoot}/eslint.config.mjs"],
            cache: false,
        },
        "lint:package-json": {
            inputs: ["default"],
            cache: true,
        },
        "lint:prettier": {
            inputs: ["default", "{workspaceRoot}/.prettierrc.cjs"],
            cache: true,
        },
        "lint:prettier:fix": {
            inputs: ["default", "{workspaceRoot}/.prettierrc.cjs"],
            cache: false,
        },
        "lint:types": {
            // Type-checking a consumer needs its dependencies' emitted .d.ts files.
            dependsOn: ["^build"],
            inputs: ["default", "^production"],
            cache: true,
        },
        test: {
            inputs: ["default", "^production", "{projectRoot}/vite.config.ts", "{projectRoot}/vitest.config.ts"],
            cache: true,
        },
        "test:coverage": {
            inputs: ["default", "^production", "{projectRoot}/vite.config.ts", "{projectRoot}/vitest.config.ts"],
            cache: true,
        },
        "build-storybook": {
            dependsOn: ["^build", "^build-storybook"],
            inputs: [
                "default",
                "^production",
                "{workspaceRoot}/.storybook/**/*",
                "{projectRoot}/.storybook/**/*",
                "{projectRoot}/tsconfig.json",
                "{projectRoot}/tsconfig.storybook.json",
            ],
            cache: true,
        },
        dev: {
            persistent: true,
            cache: false,
        },
    },
});
