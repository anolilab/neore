import { createConfig } from "@anolilab/eslint-config";

/** @type {import("@anolilab/eslint-config").PromiseFlatConfigComposer} */
export default createConfig(
    {
        // `.eslintignore` is no longer supported in Flat config, use `ignores` instead
        ignores: [
            "./eslint.config.js",
            "./.eslint.cache.json",
            // Written by wrangler, not by us — `--fix` reformats it on every run
            // and the next build overwrites it again.
            "./.wrangler/**",
            // Written by `fumadocs-mdx`, not by us.
            "./.source/**",
            // Playwright run artifacts (gitignored, but lint reads the tree).
            "./e2e/.results/**",
            // The shared test user's saved session (`e2e/auth.setup.ts`), also gitignored.
            "./e2e/.auth/**",
            // Lingui-generated message catalogs. Already in `.prettierignore`;
            // every finding in them is `unicorn/no-abusive-eslint-disable` on a
            // blanket disable the generator writes.
            "./src/locales/**",
            // ...globs
        ],
        typescript: {
            isTypeAware: false,
            tsconfigPath: "./tsconfig.json",
            ignoresTypeAware: ["*.json", "*.md"],
        },
        vitest: false,
        react: {
            reactVersion: "19.2",
            reactCompiler: true,
        },
    },
    {
        files: ["**/src/routes/**/*.tsx", "**/src/routes/api/**/*.ts"],
        rules: {
            "import/exports-last": "off",
            "import/prefer-default-export": "off",
            "@typescript-eslint/no-use-before-define": "off",
            // `createFileRoute("/path" as any)` is sometimes needed for newly added routes
            // until the TanStack router generator regenerates the route tree types.
            "@typescript-eslint/no-explicit-any": "off",
            "react-refresh/only-export-components": "off",
        },
    },
    {
        // Source files only. `files: ["**/*"]` also matches `package.json` and
        // `tsconfig.json`, which eslint 10 parses as `jsonc/x` — and naming a
        // JS-only rule for a language that does not support it is a hard error,
        // not a skipped rule. The four services hit this and were scoped the
        // same way; this block only escaped it while every rule in it happened
        // to be language-agnostic.
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        rules: {
            // this need types
            "vitest/prefer-describe-function-title": "off",

            /**
             * The same calibration `backend/eslint.config.js` and the four
             * services reached, applied here for the first time — this config
             * predates that work and never got it. Each is measured, not
             * assumed:
             *
             * `n/no-unsupported-features/node-builtins` — 225 findings, and the
             * names are `File`, `navigator`, `fetch`, `localStorage`, `Blob`,
             * `Response`, `URL.createObjectURL`, `sessionStorage`, `crypto`,
             * `Headers`. This is a BROWSER app that also runs on Workers; the
             * rule is checking them for Node version support. Every finding is a
             * false positive.
             *
             * `explicit-module-boundary-types` — 508. Return types on every
             * exported component and handler, in a codebase that consistently
             * does not write them. Off in the backend and all four services for
             * the same reason; leaving it on here only made this project the
             * odd one out.
             *
             * `import/exports-last` — 285. Already off for `src/routes/**`
             * above, because TanStack Start's `createFileRoute` export belongs
             * at the top. The rest of the app writes exports the same way.
             */
            "@typescript-eslint/explicit-module-boundary-types": "off",
            "import/exports-last": "off",
            "n/no-unsupported-features/node-builtins": "off",

            /**
             * The rest of the same calibration. Each of these was already
             * decided in `backend/eslint.config.js`, with the reasoning written
             * out there — the same codebase, the same authors, the same house
             * style. Repeating 60 lines of prose here would just create a second
             * copy to drift; read that file for the why.
             *
             * The short version: `no-underscore-dangle` because `_id` and
             * `_creationTime` are the document shape, not a style slip.
             * `func-style` because the codebase writes both, and because its
             * autofix converts route components to un-hoisted `const` arrows,
             * which puts `createFileRoute({ component })` above them into the
             * temporal dead zone. `no-await-in-loop` because sequential awaits
             * are the intent where each pass depends on the last.
             *
             * The four left at `warn` are judgement calls the author has to
             * make, not defects: a non-null assertion, an `any`, a complex
             * function and a string that looks like a secret are each sometimes
             * right. `no-secrets` in particular is model ids and provider slugs
             * here, the same as in the backend.
             */
            /**
             * Three rules form a cycle here, and no spelling of a browser global
             * satisfies all three. Probed rather than reasoned about:
             *
             *   globalThis.location.href  -> unicorn/no-unnecessary-global-this
             *                                "Use `location` directly"
             *   location.href             -> no-restricted-globals
             *                                "Unexpected use of 'location'.
             *                                 Use window.location instead"
             *   window.location.href      -> unicorn/prefer-global-this
             *                                "Prefer `globalThis` over `window`"
             *
             * The same holds for `history`, `addEventListener`,
             * `removeEventListener`, `dispatchEvent` and `getSelection` — every
             * member `confusing-browser-globals` lists. 91 errors that no edit
             * could clear.
             *
             * `no-unnecessary-global-this` is the one turned off. It is the
             * least valuable of the three — pure brevity — and it is the one
             * that makes the cycle unbreakable, because it rejects the explicit
             * form the other two converge on. With it off, exactly one spelling
             * satisfies the rest: `globalThis.X`.
             *
             * This reverses an earlier decision here, and the reason is worth
             * recording. The first pass turned off `prefer-global-this` instead
             * and standardised on `window.X`, on the reasoning that neither
             * prefix makes SSR safe — `globalThis.location` throws on a Worker
             * exactly as `window.location` does. True for property ACCESS, and
             * wrong for the case that matters:
             *
             *     typeof globalThis.matchMedia === "function"   // undefined, fine
             *     typeof window.matchMedia === "function"       // ReferenceError
             *
             * `window` is not merely absent on a Worker, it is an unresolved
             * identifier, so the feature-detect guard that makes a site safe is
             * itself unsafe when spelled with `window`. The config was pushing
             * this app toward the form that breaks SSR.
             *
             * With this rule off the fixers no longer ping-pong, so
             * `prefer-global-this --fix` terminates — which is how the existing
             * `window.*` sites were converted.
             */
            "unicorn/no-unnecessary-global-this": "off",

            "@typescript-eslint/explicit-member-accessibility": "off",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-non-null-assertion": "warn",
            "antfu/if-newline": "off",
            "func-style": "off",
            "import/prefer-default-export": "off",
            "jsdoc/check-indentation": "off",
            "no-await-in-loop": "off",
            "no-secrets/no-secrets": "warn",
            "no-underscore-dangle": "off",
            "sonarjs/cognitive-complexity": "warn",
            "unicorn/consistent-boolean-name": "off",
            "unicorn/no-break-in-nested-loop": "off",
            "unicorn/prefer-await": "off",
            "unicorn/prefer-simple-condition-first": "warn",

            /**
             * `e` is 344 of this rule's 375 findings here — `catch (e)` and
             * `(e) => …` event handlers, which is the convention this app is
             * written in throughout.
             *
             * The rule has a point that `e` reads as either `error` or `event`,
             * and it is worth taking one file at a time. It is not worth 344
             * mechanical renames in a single diff, each one a chance to shadow
             * an outer binding. The other names are the same list the backend
             * and services already exempt.
             */
            "unicorn/name-replacements": [
                "error",
                {
                    checkDefaultAndNamespaceImports: false,
                    checkShorthandImports: false,
                    checkShorthandProperties: false,
                    replacements: {
                        args: false,
                        def: false,
                        doc: false,
                        docs: false,
                        e: false,
                        env: false,
                        i: false,
                        j: false,
                        params: false,
                        prop: false,
                        props: false,
                        ref: false,
                        refs: false,
                        rel: false,
                        res: false,
                    },
                },
            ],
            // React uses null as a first-class value: return null (render nothing),
            // useRef<T>(null) (DOM refs), and external APIs/JSON all require null.
            "unicorn/no-null": "off",
            /**
             * The same four zod rules `backend/eslint.config.js` and every
             * service disable, for the same reasons — three of them silently
             * change what a schema ACCEPTS at runtime, and `consistent-import`'s
             * fix is outright broken. This config was the one place still
             * missing them, and `--fix` duly demonstrated all four:
             *
             * `consistent-import` rewrote the USES in `two-factor-form.tsx` to
             * `z.strictObject(...)` while leaving its named `zod/v4` import
             * alone, so `z` was undefined and the file stopped compiling.
             * `prefer-string-schema-with-trim` added `.trim()` to 69 schemas,
             * silently trimming ids, tokens and passwords where a stray space
             * should be an error. `prefer-strict-object` turned four
             * `object()` into `strictObject()`, which rejects any field a caller
             * sends that the schema does not model yet.
             * `no-optional-and-default-together` changes whether a key may be
             * absent versus present-and-undefined.
             */
            "zod/consistent-import": "off",
            "zod/no-optional-and-default-together": "off",
            "zod/prefer-strict-object": "off",
            "zod/prefer-string-schema-with-trim": "off",

            // Zod must always be imported as a namespace: `import * as z from "zod"`.
            //
            // That form has to be exempted from `import/no-namespace`, whose
            // autofix rewrites it into named imports — and zod exports `enum`,
            // so `--fix` emitted `import { object, enum, … } from "zod"` and
            // turned nine files into syntax errors.
            // `lucide-react` joins zod: `import * as LucideIcons` backs a runtime
            // icon lookup by name, and the package exports no `icons` map to
            // destructure instead.
            "import/no-namespace": ["error", { ignore: ["lucide-react", "zod"] }],

            // Autofix turns `Doc<"messages">` inside a JSDoc block into
            // `Doc&lt;"messages">` — half-escaped and unreadable. The comments
            // here describe TypeScript, so `<` is normal prose.
            "jsdoc/text-escaping": "off",

            // `appendChild`, not `append`: with `@cloudflare/workers-types` in
            // scope `append` resolves to a FormData-ish overload taking
            // `string | Response | ReadableStream`, so the autofixed call does
            // not typecheck. Three call sites, all with the reason in a comment
            // the fixer cannot read.
            "unicorn/prefer-dom-node-append": "off",

            "no-restricted-imports": [
                "error",
                {
                    paths: [
                        // No `{ name: "zod", importNames: ["z"] }` here, tempting as
                        // it looks: `no-restricted-imports` reports a namespace
                        // import as the name `*`, which matches every restricted
                        // importName. So that entry banned `import * as z` — the
                        // form its own message asks for — on all 22 files using it.
                        {
                            name: "zod/v4",
                            message: "Import from 'zod' directly: `import * as z from 'zod'`.",
                        },
                    ],
                },
            ],
        },
    },
    {
        /**
         * Prettier owns formatting, and it wants trailing commas in `.jsonc`
         * where `jsonc/comma-dangle` forbids them. Verified by letting eslint
         * fix `wrangler.jsonc` and watching `prettier --check` reject the
         * result — the two disagree about the same 7 lines, so neither state is
         * reachable while both run.
         *
         * Formatting yields to the formatter, as it does for `@stylistic/*` in
         * `packages/chat-ui`.
         */
        files: ["**/*.jsonc"],
        rules: {
            "jsonc/comma-dangle": "off",
        },
    },
    {
        files: ["**/src/routes/**/*"],
        rules: {
            "perfectionist/sort-objects": "off",
        },
    },
    {
        // The `e2e/*.mjs` drivers are standalone Node scripts run by hand against
        // a live stack — not shipped code and not part of the app bundle. Several
        // rules are simply wrong for them rather than being violations worth
        // fixing:
        //
        //  - `playwright` IS correctly a devDependency for a dev-only driver.
        //  - The "hard-coded password" is a throwaway literal for an account the
        //    script creates and abandons.
        //  - `no-console` is the entire point: their output IS the report.
        // Widened from `e2e/**/*.mjs`: the `.ts` Playwright specs are the
        // same kind of file and were tripping the same rules.
        files: ["e2e/**"],
        rules: {
            "import/no-extraneous-dependencies": "off",
            "jsdoc/check-indentation": "off",
            "no-console": "off",
            "sonarjs/no-hardcoded-passwords": "off",
            // `/tmp` for screenshots and traces in a hand-run driver.
            "sonarjs/publicly-writable-directories": "off",
            "unicorn/no-await-expression-member": "off",

            // These two would break the drivers rather than tidy them. The
            // `.catch()` on `waitForResponse` is attached AT CREATION on purpose:
            // awaiting it instead leaves the rejection unattached while the retry
            // loop moves on, which surfaces as an unhandled rejection and kills
            // the run instead of retrying.
            "unicorn/prefer-await": "off",
            "unicorn/prefer-then-catch": "off",

            // The drivers are a sequence of steps against one live stack —
            // sequential awaits in a loop is the intent, not an oversight.
            "no-await-in-loop": "off",

            // `chromium` is a real export of `playwright`; the resolver just
            // cannot see through its type entry.
            "import/named": "off",

            // JSDoc COMPLETENESS on hand-run drivers whose parameters are
            // `(page, options)` and whose output is the report itself. The
            // prose in these files explains why a step exists, which is the part
            // worth having; `@param {Type} name - text` on each is ceremony for
            // a script nothing imports.
            "jsdoc/require-param-description": "off",
            "jsdoc/require-param-type": "off",
            "jsdoc/require-returns": "off",
        },
    },
    {
        /**
         * Documentation, linted as if its fenced code blocks were a program.
         *
         * 82 errors in `src/AGENTS.md` alone, and every one is a category
         * error: a snippet showing `const { data } = useQuery(...)` to
         * illustrate the call is reported as an unused variable and a dead
         * store; an example hook body breaks rules-of-hooks; a `<button>` in a
         * two-line JSX excerpt is missing its `type`. Doc examples are
         * deliberately partial — that is what makes them readable.
         *
         * `markdown/fenced-code-language` stays ON: an unlabelled fence is a
         * real documentation defect, and labelling is what makes the rest work.
         */
        files: ["**/*.md", "**/*.md/**"],
        rules: {
            // Four more of the same class, found after the first pass:
            // an example object written in logical order rather than
            // alphabetical, an `err` binding, a `void` marker, and an empty
            // catch shown as an illustration.
            // A snippet that only reads `typeof api.x` is type-only WITHIN the
            // snippet, so the rule is right about the fence and wrong about the
            // lesson: the form being taught is the value import, because real
            // call sites pass `api.x` to `useQuery`. Left as prose intends.
            "@typescript-eslint/consistent-type-imports": "off",
            "import/no-duplicates": "off",
            "no-empty": "off",
            "no-void": "off",
            "perfectionist/sort-objects": "off",
            "react-hooks/rules-of-hooks": "off",
            "react/button-has-type": "off",
            "sonarjs/no-dead-store": "off",
            "sonarjs/no-unused-vars": "off",
            "sonarjs/unused-import": "off",
            "unicorn/filename-case": "off",
            "unicorn/name-replacements": "off",
            "unused-imports/no-unused-vars": "off",
        },
    },
    {
        /**
         * `styles.css` exists to override styles this app does not own, so both
         * rules that fire on it are inverted here.
         *
         * `no-important` (9): one is the `prefers-reduced-motion` clamp on
         * `animation-duration`, which is the case accessibility guidance
         * specifically calls for; the rest override CodeMirror's and Fumadocs'
         * own injected rules, which carry higher specificity by construction.
         *
         * `use-layers` (21): a cascade layer would LOWER these declarations'
         * precedence, so obeying the rule breaks what the file is for.
         * `packages/ui/src/global.css` does use `@layer base` — design system
         * CSS is the case layers are for.
         */
        files: ["**/styles.css"],
        rules: {
            "css/no-important": "off",
            "css/use-layers": "off",
        },
    },
    {
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        rules: {
            /**
             * `void <promise>;` as a STATEMENT is this codebase's deliberate
             * fire-and-forget marker — `void refetch();`, `void navigate(…)`,
             * `void queryClient.prefetchQuery(…)`. Five separate passes over
             * this tree each checked their sites individually and each reached
             * the same conclusion.
             *
             * `allowAsStatement` is the rule's own option for exactly this. It
             * keeps the case the rule is actually for — `void` in an EXPRESSION,
             * as in `x = void 0` — an error.
             */
            "no-void": ["error", { allowAsStatement: true }],

            /**
             * `Iterator.prototype.toArray()` is ES2025. `tsconfig.base.json`
             * sets `"lib": ["DOM", "DOM.Iterable", "ES2023"]`, so obeying this
             * rule produces code that does not compile — verified:
             *
             *     [1,2].values().toArray()
             *     -> TS2339: Property 'toArray' does not exist on ArrayIterator
             *
             * Turn it back on when `lib` moves to ES2025.
             */
            "unicorn/prefer-iterator-to-array": "off",

            /**
             * Fights Prettier: it wants every call argument on its own line,
             * and Prettier's last-argument hugging collapses them straight back.
             * Its autofix produces `}),);`, which Prettier then rejects.
             * Formatting yields to the formatter.
             */
            "antfu/consistent-list-newline": "off",
        },
    },
    {
        files: ["**/*.tsx"],
        rules: {
            /**
             * Unsatisfiable with `react/function-component-definition` for a
             * default-exported component. Probed both spellings:
             *
             *   const Foo = () => <div/>; export default Foo;
             *       -> unicorn/default-export-style "declare it inline"
             *   export default function Bar() { return <div/>; }
             *       -> react/function-component-definition "not an arrow function"
             *
             * The arrow form is this codebase's component convention and the one
             * `function-component-definition` enforces everywhere else, so the
             * inline-default rule is the one that yields — and only for `.tsx`,
             * where components live.
             */
            "unicorn/default-export-style": "off",
        },
    },
    {
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        rules: {
            /**
             * `no-restricted-types` on `Record<string, unknown>` earned its
             * keep: roughly 290 sites were replaced this session with concrete
             * interfaces — D1 rows typed off the actual SELECT, request and
             * response bodies, tool schemas, cache updaters.
             *
             * What is left is the residue where the rule's own instruction —
             * "describe the keys you actually read" — has no answer, confirmed
             * by five independent passes and a spot check of the survivors:
             *
             *   - library CONTRACTS: TanStack Router's `search` updater and
             *     `validateSearch`, better-auth client action shims
             *   - generic CONSTRAINTS: `<P extends object>` on an HOC, where
             *     `Record<string, unknown>` is actively wrong because it
             *     excludes arrays and class instances
             *   - genuine JSON blobs: audit-log details, React Flow `node.data`
             *     across 14 node types, an audit snapshot whose column is
             *     `v.any()`
             *
             * Demoted to `warn` rather than off, so the signal survives for new
             * code where a real shape usually does exist. Inventing a type for
             * the cases above would be worse than the lint warning.
             */
            "@typescript-eslint/no-restricted-types": "warn",
        },
    },
    {
        /**
         * `import/no-extraneous-dependencies` wants runtime imports to come
         * from `dependencies`. These four files are not runtime:
         * `vitest.setup.ts` is the test bootstrap, `e2e/**` drives a browser by
         * hand, and `react-scan.tsx` is a dev-only profiler component that is
         * tree-shaken out of production. Their imports are devDependencies
         * correctly.
         *
         * The one finding that WAS real is fixed at source rather than here:
         * `react-dropzone` is imported by three files in `src/` and was
         * declared only in the ROOT package.json, so it resolved through
         * hoisting and would break on a clean install or a pnpm layout change.
         * It is now a dependency of this app.
         */
        files: ["**/vitest.setup.ts", "**/e2e/**", "**/src/components/debug/**"],
        rules: {
            "import/no-extraneous-dependencies": "off",
        },
    },
    {
        /**
         * `e2e/` is Playwright, not React Testing Library.
         *
         * `prefer-screen-queries` fired 33 times on `page.getByRole(...)`,
         * telling us to use `screen`. Playwright has no `screen` object —
         * queries hang off the `page` (or a `locator`) by design, and that is
         * the only spelling its API offers. The rule matches on the method name
         * and assumes the wrong library.
         */
        files: ["**/e2e/**"],
        rules: {
            "testing-library/prefer-screen-queries": "off",
        },
    },
    {
        /**
         * Tiptap binds `this` to the extension inside `addProseMirrorPlugins()`
         * and `addKeyboardShortcuts()`, so `this` outside a class is the
         * documented API here, not a mistake. The `const extensionThis = this`
         * alias these files use is what the library's own examples do.
         */
        files: ["**/composer-tiptap/extensions/**"],
        rules: {
            "@typescript-eslint/no-this-alias": "off",
            "unicorn/no-this-assignment": "off",
            "unicorn/no-this-outside-of-class": "off",
        },
    },
    {
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        rules: {
            /**
             * `Math.random()` here is retry-backoff jitter, animation phase and
             * an image seed — none of it a security boundary. Checked every
             * site; the one that WAS in an auth path (an org-slug uniqueness
             * suffix in the backend) was switched to `crypto.randomUUID()`
             * instead of being covered by this.
             */
            "sonarjs/pseudo-random": "off",

            /**
             * `Number(x)` is not `Number.parseInt(x, 10)` / `parseFloat`.
             * Prefix parsing is load-bearing at these sites — a spreadsheet
             * cell of `"12abc"` must resolve to 12, a Slack `ts` of
             * `"1531420618.000200"` must keep its fraction for the replay
             * window. Obeying the rule silently changes what these parse.
             */
            "unicorn/prefer-number-coercion": "off",

            /**
             * Would replace scroll/resize listeners with Intersection- and
             * ResizeObserver, dropping the 50/100ms debounces those handlers
             * carry. That is a timing change to slide scaling and popover
             * positioning, not a refactor.
             */
            "unicorn/prefer-observer-apis": "off",

            /**
             * Unsatisfiable with `@typescript-eslint/member-ordering`: one wants
             * private members first, the other public first, and these classes
             * interleave. Verified by making the move and watching the error
             * swap rules.
             */
            "unicorn/consistent-class-member-order": "off",
        },
    },
    {
        /**
         * The constants in this file map route names to URL segments. Two of
         * them have PASSWORD in the name — the forgot and reset routes — and
         * the rule keys on the constant's NAME, not on any value being secret.
         *
         * (Quoting the pair literally here made the repo's own secret scanner
         * flag this comment, which is a fair demonstration of the point.)
         */
        files: ["**/auth-view-paths.ts"],
        rules: {
            "sonarjs/no-hardcoded-passwords": "off",
        },
    },
    {
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        rules: {
            /**
             * Unsatisfiable pair. Both fire on
             * `useMutation({ onMutate, onError, onSettled })`: perfectionist
             * wants alphabetical, so `onError` first; TanStack's own rule
             * requires `onMutate` first, because that ordering is what makes
             * `context` infer in `onError`/`onSettled`. Six sites, split across
             * both orderings, and no ordering satisfies both.
             *
             * TanStack's rule wins — it encodes a real type-inference
             * requirement, where the other encodes alphabetisation.
             */
            "perfectionist/sort-objects": "off",

            /**
             * `Set.prototype.difference` needs ES2024; `tsconfig.base.json` sets
             * `"lib": [… "ES2023"]`, so the suggested fix is `TS2550`. Same
             * situation as `prefer-iterator-to-array`. Re-enable with the `lib`
             * bump.
             */
            "unicorn/prefer-set-methods": "off",

            /**
             * `export type ModelId = string` carries a doc comment
             * distinguishing it from `AgentModel` and is used at 115 sites.
             * Inlining `string` everywhere is behaviour-identical and strictly
             * less informative.
             */
            "sonarjs/redundant-type-aliases": "off",

            /**
             * Nine findings, one cause: `const { hooks } = useAuth();
             * hooks.useSession()` — dynamically dispatched hooks. `hooks` is
             * composed at runtime in `auth-ui-provider-tanstack.tsx` and is the
             * auth feature's deliberate injection seam. Clearing this means
             * deleting the override point and importing concrete hooks, which
             * is an architectural decision rather than a lint fix.
             */
            "react-compiler/react-compiler": "off",

            /**
             * Every remaining site was checked and none has a stable id: a bar
             * chart over `number[]`, CSV header/row/cell, separator dots, split
             * string parts, conversation titles that collide, and a
             * `selectedModels: string[]` where the same model can be chosen
             * twice. Position IS the identity. The two that DID have an id
             * (a flight number plus departure time, a URL) were fixed.
             */
            "react-x/no-array-index-key": "warn",
        },
    },
    {
        /**
         * Regenerated files that ship a blanket `/* eslint-disable *\/` header:
         * `routeTree.gen.ts` from TanStack Router, `worker-configuration.d.ts`
         * from wrangler. Editing either is undone by the next codegen. Under
         * that header wrangler's own inline `// eslint-disable-line` comments
         * report as unused, which is theirs to emit, not ours to fix.
         */
        files: ["**/routeTree.gen.ts", "**/worker-configuration.d.ts"],
        linterOptions: {
            reportUnusedDisableDirectives: "off",
        },
        rules: {
            "unicorn/no-abusive-eslint-disable": "off",
        },
    },
    {
        /**
         * Two unrelated things share this rule name here.
         *
         * `composer-references-button.tsx` is a false positive: the flagged node
         * is the quasi of a TAGGED template — `` t`${plural(count, …)}` `` —
         * where `t` is the Lingui macro binding. `.toString()` is not a
         * substitute and rewriting it changes the extracted message id. The
         * same shape is right wherever the plural must stay a STRING and follow
         * locale changes: a bare core-macro `plural()` reads the global i18n,
         * which React Compiler can cache across a locale switch. In JSX use
         * `<Plural>` instead — except inside a `<label>`, where
         * `jsx-a11y/label-has-associated-control` cannot see a component's text.
         *
         * The two test files are the "inject rather than `vi.mock`" rule. One
         * mocks `useNavigate`; the other mocks a Zustand store whose real
         * defaults are platform-dependent (`ctrl` vs `meta`) and
         * localStorage-persisted, so dropping the mock makes the assertions
         * platform-specific.
         */
        files: [
            "**/composer-references-button.tsx",
            "**/skill-marketplace.tsx",
            "**/star-rating-input.tsx",
            "**/canvas/canvas-panel.tsx",
            "**/usage-activity-heatmap.tsx",
            "**/thread-list/hooks/use-thread-handlers.tsx",
            "**/chat/thread/thread.tsx",
            "**/admin/components/admin-dashboard-stats.tsx",
            "**/*.test.ts",
            "**/*.test.tsx",
        ],
        rules: {
            "no-restricted-syntax": "off",
        },
    },
    {
        /**
         * Wants `authClient` — a module singleton carrying functions and likely
         * cycles — or a whole fetched session payload put into a query KEY.
         * Keys are hashed with a stable stringify, so that is either a throw or
         * a permanent cache miss. Neither value is a reactive input.
         */
        files: ["**/features/auth/hooks/**", "**/prefetch-session.ts"],
        rules: {
            "@tanstack/query/exhaustive-deps": "off",
        },
    },
    {
        /**
         * The SVG artifact renderer. `dangerouslySetInnerHTML` stays because
         * SVG has no non-HTML rendering path that preserves sizing — but the
         * content is now run through DOMPurify's SVG profile first, verified
         * against `onload`, `foreignObject`/`onerror`, inline `<script>` and
         * `javascript:` hrefs. The rule cannot see the sanitiser.
         */
        files: ["**/canvas/canvas-panel.tsx"],
        rules: {
            "react/no-danger": "off",
        },
    },
    {
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        rules: {
            /**
             * 31 of the survivors were classified site by site and 22 are
             * external-system synchronisation, which this rule's own
             * documentation permits: `ResizeObserver` writing a computed scale,
             * a `MutationObserver` on `<html class>`, scroll and resize
             * listeners feeding `getBoundingClientRect`, a throttle timer, a
             * `setInterval` metrics ticker, a polled job status that also fires
             * toasts, a post-hydration `navigator.language` read deliberately
             * deferred to avoid a hydration mismatch.
             *
             * In most of them the `setState` is not in the effect body at all —
             * it is inside a listener or timer callback the effect registers,
             * which is not "setState in an effect" under any reading.
             *
             * The remaining nine are the optimistic-UI gates in `chat-context`
             * (thread-switch reset, optimistic-message seed, optimistic-delete
             * reconciliation) plus a set whose render-phase conversion just
             * trades these errors for `react-hooks/refs` ones.
             *
             * ~20 genuine prop-mirrors WERE converted first; this covers what is
             * left. Demoted rather than disabled so new ones still surface.
             */
            "react-hooks/set-state-in-effect": "warn",
            "react-x/set-state-in-effect": "warn",

            /**
             * A FIXME is deferred work, and deferred work is not a build error.
             *
             * These six are substantive and worth keeping visible — a dead UI
             * branch whose model field does not exist, a request that stopped
             * carrying `imageSize`, a cross-reference tying two sites together.
             * Deleting the tags to go green would destroy that; leaving them as
             * errors would mean a TODO can block a deploy. `warn` is the honest
             * severity: still printed, still greppable, not fatal.
             */
            "sonarjs/fixme-tag": "warn",
        },
    },
    {
        /**
         * Both need a UX decision rather than an attribute.
         *
         * `changelog-panel`: the whole `<article>` card has an `onClick` that
         * only marks the entry read. Satisfying the rule means `role="button"`
         * plus a tab stop on a card that is not a button — a screen reader would
         * announce "button" for an article. The right fix is to mark read on
         * VISIBILITY, which serves keyboard and pointer users equally.
         *
         * `onboarding-dialog`: a labelled `role="region"` landmark that owns
         * arrow-key navigation. Giving it an interactive role changes how it is
         * announced.
         */
        files: ["**/changelog-panel.tsx", "**/onboarding-dialog.tsx"],
        rules: {
            "jsx-a11y/click-events-have-key-events": "off",
            "jsx-a11y/no-noninteractive-element-interactions": "off",
        },
    },
);
