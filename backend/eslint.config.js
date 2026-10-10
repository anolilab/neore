import { createConfig } from "@anolilab/eslint-config";

/**
 * `backend/` was created during the migration and never got one, so `eslint .`
 * here reported 290 `Parsing error: Unexpected token` — the TypeScript parser was
 * never configured, so nothing in this package had been linted at all.
 *
 * Codegen output (`lunora/_generated/**`) is ignored because it is
 * rewritten on every `pnpm codegen`, so a lint error in it is not actionable —
 * the next run overwrites the fix.
 *
 * That is not just `lunora/_generated/**`. `lunora/.lunora-schema.json` is the
 * serialized schema snapshot codegen writes beside it, and it alone accounted for
 * 5,609 of the errors `eslint .` reported here — a quarter of the total, all in a
 * file nobody edits. `lunora.advisor.map.json` is the same shape of artifact from
 * `lunora advisor`. `.lunora/` is the `lunora build` bundle and `.wrangler/` is
 * local dev state; both are gitignored, but eslint walks the working tree, not
 * the index.
 *
 * @type {import("@anolilab/eslint-config").PromiseFlatConfigComposer}
 */
export default createConfig(
    {
        ignores: [
            "./eslint.config.js",
            "./dist/**",
            // Codegen output — `pnpm codegen` rewrites all of it.
            "./lunora/_generated/**",
            "./lunora/.lunora-schema.json",
            // Tool artifacts, gitignored but present in the working tree.
            "./lunora.advisor.map.json",
            "./lunora-bindings.json",
            "./.lunora/**",
            "./.wrangler/**",
            // Documentation. The shared config extracts fenced code blocks into
            // VIRTUAL source files that inherit the `.md` path, so app rules end up
            // judging illustrative snippets — `import/prefer-default-export` on a
            // three-line example, `sonarjs/no-labels` on pseudo-code, and
            // `unicorn/filename-case` on `AGENTS.md` itself. Those snippets are
            // deliberately partial; linting them reports nothing actionable.
            //
            // The Markdown-specific findings WERE fixed first rather than hidden:
            // four directory-tree fences are now ```text, and `gdpr/README.md` had a
            // stray fence pair that swallowed `</details>`, the closing rule and the
            // whole License section into a code block.
            "./**/*.md",
        ],
        // `vitest: false`, matching `apps/web`. The plugin's `unbound-method` rule
        // needs type-aware parser services, and `isTypeAware: false` here (461
        // tests across 307 files — type-aware linting is minutes, not seconds).
        // With the plugin on, eslint crashes rather than reporting.
        vitest: false,
        typescript: {
            ignoresTypeAware: ["*.json", "*.md"],
            isTypeAware: false,
            tsconfigPath: "./tsconfig.json",
        },
    },
    {
        files: ["**/*"],
        rules: {
            /**
             * Off because together their fixes produce code that does not compile.
             *
             * `no-duplicates` merges a `import type { A }` and a sibling
             * `import { b }` from the same module into ONE statement, and picks the
             * type-only form — so genuine VALUE imports end up declared type-only:
             *
             *     import type { Context, getErrorMessage } from "@ai-sdk/provider-utils";
             *     …
             *     getErrorMessage(e)   // TS1361: cannot be used as a value
             *
             * `consistent-type-specifier-style` then hoists/strips the inline `type`
             * modifiers on the merged statement, which is where TS2206 comes from.
             * Observed on `getErrorMessage`, `convertToModelMessages` and
             * `vMessageWithMetadata` — three files, seven errors, all from imports
             * that were correct before the fix ran.
             */
            /**
             * Off because the rule reports a violation whose own fix is a NO-OP.
             *
             * `eslint --fix` leaves these files byte-identical and the error
             * survives; `--fix-dry-run` confirms it, emitting output equal to the
             * input while still reporting `Run autofix to sort these imports!`.
             * Checked on four files independently. The imports are already grouped
             * and alphabetised, so there is nothing for a human to change either —
             * following the rule is not possible, only silencing it is.
             *
             * `import/first` and `@stylistic/padding-line-between-statements` still
             * enforce the shape of the import block, so ordering is not unguarded.
             */
            "simple-import-sort/imports": "off",
            "import/consistent-type-specifier-style": "off",
            "import/no-duplicates": "off",
            /**
             * Off, and it has to be: its autofix CORRUPTS these doc comments.
             *
             * It rewrites `<` to `&lt;` anywhere in a jsdoc block, without
             * understanding backticked code spans — and in a TypeScript codebase
             * that is where the character overwhelmingly lives. A `--fix` pass
             * turned `Id<"_storage">` into ``Id&lt;"_storage">``,
             * `Pick<ActionCtx, "auth">` into ``Pick&lt;ActionCtx, "auth">``, and
             * `Record<string, unknown>` likewise: 47 doc comments across 24 files,
             * every one of them made less readable than before.
             *
             * The rule is aimed at jsdoc rendered as HTML. Nothing here renders
             * these; they are read in an editor, where the escape is pure noise.
             * Escaping inside a code span is wrong by Markdown's own rules anyway.
             */
            /**
             * Forbids structured prose in a doc comment. It requires every line of
             * a description to start at the same indentation, which rules out nested
             * bullet lists, hanging indents, and quoted output — all of which these
             * comments use deliberately:
             *
             *   ` *   - \`files\` (vault) — user-uploaded images …`
             *   ` *     \`by_user_and_chatId\` indexes.`
             *   ` *     Uncaught TypeError: The argument 'path' must be a file URL …`
             *
             * The comments in this package carry a lot of explanation, and the
             * indentation is what makes them readable.
             */
            "jsdoc/check-indentation": "off",
            /**
             * A TypeScript project gets its types from the compiler; jsdoc here is
             * prose. Every finding is a `{@link …}` cross-reference to a symbol in
             * another module — `StorageOptions`, `continueThread`,
             * `DEFAULT_STREAMING_OPTIONS` — and satisfying the rule would mean
             * adding otherwise-unused imports purely so a doc comment can name
             * something. The rule is built for JS projects where jsdoc IS the type
             * system.
             */
            "jsdoc/no-undefined-types": "off",
            "jsdoc/text-escaping": "off",

            "no-underscore-dangle": "off",
            /**
             * The `zod` rules below are off because their autofixes change what the
             * schema ACCEPTS at runtime, and a lint pass is not where that decision
             * belongs. Each was observed rewriting live validators:
             *
             * - `prefer-string-schema-with-trim` turns `z.string()` into
             *   `z.string().trim()`. Every string arriving through a validator would
             *   then be silently trimmed before it is stored or compared — including
             *   ids, hashes and tokens, where a stray space should be an error, not
             *   quietly repaired.
             * - `prefer-strict-object` turns `z.object()` into `z.strictObject()`,
             *   which REJECTS unknown keys. Applied wholesale that breaks every
             *   caller sending a field we do not model yet, which is the normal
             *   state of a forward-compatible API.
             * - `no-optional-and-default-together` rewrites `.optional().default(x)`,
             *   changing whether the key may be absent versus present-and-undefined.
             *
             * `consistent-import` is off for a different reason: its fix is BROKEN.
             * It rewrites `import { z } from "zod"` into named imports and emits
             * `import { object, array, number, string, enum, boolean } from "zod"` —
             * `enum` is a reserved word, so the file no longer parses. That fix alone
             * produced 550 TypeScript errors across the tree.
             */
            "zod/consistent-import": "off",
            "zod/no-optional-and-default-together": "off",
            "zod/prefer-strict-object": "off",
            "zod/prefer-string-schema-with-trim": "off",
            "unicorn/no-null": "off",
        },
    },
    {
        /**
         * Scoped to source, NOT `**\/*`.
         *
         * The block above applies to every file, which includes Markdown — and the
         * shared config lints fenced code blocks inside it. Rules that declare no
         * support for the `markdown/gfm` language then hard-ERROR the whole run:
         *
         *     The following rules do not support the language "markdown/gfm":
         *       - "unicorn/max-nested-calls"
         *
         * It is also why `import/exports-last` was reporting against
         * `lunora/AGENTS.md`, a documentation file with no exports in it.
         */
        files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.mjs"],
        rules: {
            /**
             * Raised from the default 3 to 5.
             *
             * The rule counts argument nesting, and a Lunora validator is nested
             * argument expressions by construction — this is one call, at depth 4:
             *
             *     .output(v.from(z.object({ logs: z.array(AuditLogEntrySchema) })))
             *
             * At the default it fired 2,860 times, essentially once per declared
             * schema. The prescribed fix — hoisting every inner schema to its own
             * const — would not make a validator easier to read; it would scatter
             * one declaration across several statements and separate a field from
             * its type.
             *
             * 9 is measured, not picked: max 5 leaves 393 findings, 6 leaves 117,
             * 7 leaves 23, and 9 leaves none. The deepest is
             * `aiUserPreferences.mcpServers[].headers[]` — an optional array of
             * objects holding an optional array of key/value objects, nine calls
             * deep by construction.
             *
             * Hoisting that inner object out was tried and does NOT work. A bare
             * const in a table column typechecks but silently degrades the element
             * type to `unknown[]`, and `v.from(const)` — the workaround that fixes
             * exactly this in `.input()`/`.output()` positions — is rejected at
             * runtime: `defineTable: column "mcpServers" uses v.from() which is
             * args-only`. The nesting is not reducible, so the threshold fits it.
             */
            "unicorn/max-nested-calls": ["error", { max: 9 }],
            /**
             * Wrong runtime. This package targets Cloudflare Workers, not Node —
             * `crypto` and `ReadableStream` are standard globals in workerd, and the
             * rule reports them as "not supported until Node.js 23". Every one of the
             * 80 findings was of that shape.
             */
            "n/no-unsupported-features/node-builtins": "off",
            /**
             * Following this rule here would be a SECURITY REGRESSION, not a style
             * change. All 39 uses are deliberate bit manipulation:
             *
             *   `diff |= element ^ viewB[index]` — constant-time HMAC comparison, in
             *   nine places. The whole point is to compare every byte without an
             *   early exit; rewriting it with `!==` and `&&` reintroduces the timing
             *   side-channel it exists to remove.
             *
             *   `((n << 24) >>> 0) | (n << 16)` and `(~0 << (32 - prefix)) >>> 0` —
             *   IPv4 packing and CIDR masking in the SSRF guard, where the operators
             *   ARE the algorithm.
             *
             * `no-bitwise` is aimed at `&` typed where `&&` was meant. Nothing here
             * is that.
             */
            "no-bitwise": "off",
            /**
             * The fix is an API change, not a cleanup. These are `Agent` methods —
             * `updateThreadMetadata`, `finalizeMessage` and 19 others — that happen
             * not to touch `this` today because they delegate straight to a
             * `runMutation`. Making them `static` moves them off the instance every
             * caller already holds, and the alternative reading (they belong
             * elsewhere) is a design question this rule cannot answer.
             *
             * The class is one cohesive surface; whether a given method currently
             * reads instance state is an implementation detail that will change the
             * first time one of them needs the agent's config.
             */
            "class-methods-use-this": "off",
            /**
             * Off, because its fix would break 11 modules at RUNTIME.
             *
             * `function` declarations hoist; `const fn = () => …` does not. Checking
             * each of the 21 findings against the first use of its name, 11 are
             * referenced ABOVE their declaration — `addMessagesHandler`,
             * `copyFileHandler`, `abortById`, `deletePageForUserId`, `assert` and
             * six more. Converting those to expressions is a temporal dead zone
             * error at module evaluation, which tsc does not catch and the tests
             * would only find if they imported that module.
             *
             * The declaration form is also what `no-use-before-define`'s
             * `functions: false` above relies on. Turning both knobs the other way
             * would mean reordering every handler module around its helpers.
             */
            "func-style": "off",
            /**
             * Off: codegen discovers NAMED exports.
             *
             * `export const runStreamingAgent` in `chat/execute.ts` becomes
             * `internal.chat.execute.runStreamingAgent` in the generated API. A
             * default export is not part of that surface, so taking this rule's
             * advice on a handler module removes the procedure from the API
             * entirely — and it does so silently, because nothing in TypeScript
             * knows the name mattered.
             *
             * That a module currently has one export is an accident of how many
             * procedures it happens to hold today.
             */
            "import/prefer-default-export": "off",
            /**
             * Off: the invariant return is the framework's output contract.
             *
             * A handler declared `.output(v.null())` MUST `return null` on every
             * path, including its early exits — that is what the validator checks.
             * `sonarjs` sees a function whose every `return` is `null` and reports a
             * smell; here it is the signature being honoured.
             */
            "sonarjs/no-invariant-returns": "off",
            /**
             * Off: every finding is a lazy singleton, which is the point.
             *
             *     if (cached) return cached;
             *     cached = createAuth({ … });      // <- reported
             *
             * All 14 are that shape — `cached`, `_gatewayClient`, `_agentsPromise`,
             * `cachedToken`, `legacyCryptoKey`, `hkdfBaseKey`, `assertCache` — and two
             * are the other half of it, invalidating on failure
             * (`_agentsPromise = undefined; // clear so next call retries`).
             *
             * On a Worker this matters more than usual: the module scope IS the
             * per-isolate cache, and rebuilding a better-auth instance or re-importing
             * the provider module on every request is the cost this avoids. Writing to
             * module scope from a function is how memoisation is spelled; there is no
             * alternative that keeps the caching.
             */
            "unicorn/no-top-level-assignment-in-function": "off",
            /**
             * Off, after renaming the 11 findings where it was RIGHT.
             *
             * `createPendingMessage`, `allowAnonymous`, `autoContinue` and
             * `validateTelegramWebhook` all read as instructions while holding a
             * boolean, and are now `shouldCreatePendingMessage`,
             * `shouldAllowAnonymous`, `shouldAutoContinue`,
             * `shouldValidateTelegramWebhook`.
             *
             * The 10 that remain would be made worse by a prefix. `domainMatches`,
             * `modelSupportsTools` and `atMostOneOf` already read as predicates;
             * `timingSafeEqual` is the established name for that comparison and
             * `isTimingSafeEqual` would obscure it; `predicate` is the conventional
             * name for a predicate parameter. The rule matches on PREFIX, so none of
             * these can be satisfied by extending the prefix list either — English
             * is carrying the meaning at the end of the word instead of the front.
             *
             * Worth recording: applying this rule by search-and-replace conflated two
             * different `developmentOnly` bindings — a boolean option in
             * `auth/functions.ts` and a MIDDLEWARE FACTORY in `lib/crpc.ts` that
             * returns `Middleware<C, C>`. They are now `isDevelopmentOnly` and
             * `requireDevelopment`.
             */
            "unicorn/consistent-boolean-name": "off",
            /**
             * A warning: the rule is advisory by its own wording.
             *
             *   "Consider moving this simple condition first after verifying
             *    short-circuit behavior."
             *
             * It cannot check the property it depends on, and reordering is not free:
             * `if (error || !response.ok || !data)` guards the fetch error path, and
             * putting `!response.ok` first evaluates `response` on a branch where the
             * client may not have set it. The gain — reordering two equally cheap
             * property reads — does not justify an error that blocks the build on a
             * correctness question the rule defers to the reader.
             */
            "unicorn/prefer-simple-condition-first": "warn",
            /**
             * A warning for the 11 findings that are `process.env[…]`, which is the
             * whole remainder after the fixable ones were fixed.
             *
             * `!process.env.X` is deliberately a truthiness test: a variable that is
             * SET BUT EMPTY must count as unset. `Object.hasOwn(process.env, "X")` is
             * true for `X=""`, so taking the rule's advice makes `isToolAvailable`
             * report a tool ready with a blank API key — seven tests caught exactly
             * that when it was tried.
             *
             * The genuinely fixable ones are already done: five `key in object`
             * checks became `Object.hasOwn`, which also closes a real hole, since
             * `in` walks the prototype chain and `"toString" in userSuppliedObject`
             * is true.
             */
            "unicorn/no-computed-property-existence-check": "warn",
            /**
             * A WARNING, not off — this is the rule that catches a pasted API key,
             * and that has to keep working.
             *
             * All 19 current findings were opened and read: TypeScript generics
             * inside doc comments (`Omit<WithoutSystemFields<Doc<"messages">>`,
             * `ToolExecutionOptions<CONTEXT>`), the Crockford-style alphabet
             * `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` used to mint pairing codes, the hex
             * alphabet in `traceparent.ts`, a Google Places query string, and one
             * test fixture sitting beside `BETTER_AUTH_SECRET:
             * "test-secret-that-is-long-enough"`. No secrets.
             *
             * The rule scores entropy, so satisfying it means renaming legitimate
             * identifiers or scattering 19 inline disables. As a warning the
             * false positives stop blocking while a real key committed tomorrow
             * still surfaces.
             */
            "no-secrets/no-secrets": "warn",
            /**
             * Off. All 29 findings split into two shapes, and neither can become an
             * `await` without making the code worse or changing what it does.
             *
             * **19 are a single-expression `.catch()` supplying a fallback:**
             *
             *     await response.text().catch(() => "")   // building an error message
             *     await client.close().catch(() => {})    // best-effort cleanup
             *
             * If the body read fails there is nothing to recover, only a worse
             * message; the close is on a path already unwinding. Expanding either
             * into a statement-level try/catch costs a mutable `let`, a wider scope
             * and three lines to express the same fallback.
             *
             * **10 STORE or RETURN the derived promise rather than consuming it.**
             * `DocumentStream` is a lazy chain — `new DocumentStream(this.#rows.then(…))`
             * builds the next stage without forcing the previous one, and awaiting
             * would evaluate it eagerly. The five `_agentsPromise = import(…).then(…)`
             * are module-level caches whose entire purpose is to hold the promise.
             *
             * The rule is right about a `.then()` chain carrying real control flow.
             * There are none of those here.
             */
            "unicorn/prefer-await": "off",
            /**
             * Allows a leading underscore, which the shared config's default forbids.
             *
             * Two things here rely on it and neither is a style choice. Lunora's own
             * system fields ARE `_id` and `_creationTime` — `lib/system-fields.ts`
             * exists to name them and cannot spell them any other way. And a leading
             * underscore is how an intentionally-unused binding is marked, which
             * `no-unused-vars` is separately configured to honour; forbidding it here
             * makes the two rules contradict each other.
             *
             * The `format: null` entries are the same case for type parameters:
             * `DATA_PARTS` and `TOOLS` come from the AI SDK's own generic signatures,
             * and renaming them locally would just obscure which upstream parameter
             * they correspond to.
             */
            "@typescript-eslint/naming-convention": [
                "error",
                { format: ["camelCase", "PascalCase", "UPPER_CASE"], leadingUnderscore: "allow", selector: "variable" },
                { format: null, selector: "typeParameter" },
                { format: null, modifiers: ["requiresQuotes"], selector: "objectLiteralProperty" },
                { format: ["camelCase", "PascalCase"], leadingUnderscore: "allow", selector: "function" },
            ],
            /**
             * Conflicts with Prettier, which is the formatter of record here
             * (`lint:prettier` is a separate gate and runs after `--fix`). The rule's
             * fix and Prettier's disagree, so `--fix` and `prettier --write` undo each
             * other indefinitely. The formatter wins.
             */
            "antfu/if-newline": "off",
            /**
             * Fights how these modules are organised. A Lunora function module is a
             * sequence of `export const <handler>` declarations, each sitting next to
             * the helpers and validators it uses. Hoisting all 557 exports to the
             * bottom would separate every handler from its own schema and put `const`
             * declarations after their use — a TDZ hazard, not just a readability one.
             */
            "import/exports-last": "off",
            /**
             * `functions: false` because function declarations hoist, so calling one
             * defined lower in the file is legal and idiomatic. The remaining
             * `const`/`class` cases still report.
             */
            /**
             * `classes: true` is kept — a class referenced before its declaration is
             * a real TDZ error at module evaluation, and the worker would fail to
             * boot.
             *
             * `variables: false` because every one of the 150 findings was a
             * DEFERRED reference: a helper called inside a function body that runs
             * later, or a `@react-email` style const referenced from JSX. Two of
             * them cannot be satisfied at all — `serializeContent` and
             * `toModelMessageContent` in `agent/mapping.ts` are mutually recursive,
             * so whichever is declared first references the other before it exists.
             *
             * The pattern this rule fights here is "public surface first, helpers
             * below", which is the deliberate shape of these modules.
             */
            "@typescript-eslint/no-use-before-define": ["error", { classes: true, enums: true, functions: false, typedefs: false, variables: false }],
            /**
             * `checkDestructured: false`: for a destructured parameter the TypeScript
             * type already declares every property, and the rule wants each restated
             * as `@param params.<field>`. That is documentation duplicating a type
             * annotation, which then rots independently of it.
             */
            "jsdoc/check-param-names": ["error", { checkDestructured: false }],
            /**
             * Sequential `await` in a loop is usually the point here — ordered writes,
             * rate-limited provider calls, and paginated cursors that cannot be
             * fetched concurrently because each depends on the previous page.
             */
            "no-await-in-loop": "off",
            /** `break` out of a nested loop is ordinary JavaScript; extracting a
             * function per occurrence would add 102 indirections for no reader. */
            "unicorn/no-break-in-nested-loop": "off",
            /** TypeScript members are public by default; restating it adds no
             * information the compiler does not already enforce. */
            "@typescript-eslint/explicit-member-accessibility": "off",
            /** Return types are inferred, and every procedure boundary is already
             * described by its `.input()`/`.output()` validators. */
            "@typescript-eslint/explicit-module-boundary-types": "off",
            /**
             * Left ON as warnings rather than turned off. Both are real debt in
             * codemod-ported code — `!` hiding a check the compiler cannot see, and
             * `any` hiding a shape nobody modelled — and an earlier sweep of exactly
             * these found ~20 live bugs. They should stay visible and get burned down,
             * so they are not errors (which would block every commit) and not off
             * (which would lose the signal).
             */
            /**
             * A warning, like the two below, and for the same reason: real debt that
             * should stay visible without blocking every commit.
             *
             * 58 functions exceed the threshold of 15, from 16 up to 138. That range
             * matters — this is not a miscalibrated metric to be tuned away. 16 is
             * arguably noise; `createAssistantUIMessage` at 138 and
             * `runStreamingAgent` at 130 are genuinely hard to reason about.
             *
             * They are not refactored here because splitting a 138-complexity
             * function is a control-flow change, and `agent/ui-messages.ts` has no
             * test file at all. The order that makes that safe is characterisation
             * tests first, then the split — per function, with review. Three times in
             * this migration a change that compiled and passed the suite was still
             * wrong (a renamed wire field, a rebound validator import, a dropped
             * `fileIds`), so "tsc is clean" is not the bar for restructuring
             * something this size.
             */
            "sonarjs/cognitive-complexity": "warn",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-non-null-assertion": "warn",
            /**
             * `ctx`, `Doc`, `args`, `db`, `props` are not abbreviations this project
             * chose — they are the names Lunora and React define. A handler's
             * parameter IS `ctx`, the generated row type IS `Doc<"table">`, and the
             * rule's own suggestion for the latter is `Document_`, which collides
             * with the DOM global badly enough that it needs a trailing underscore
             * to exist at all.
             *
             * This is not hypothetical: taking the rule's advice renamed `Doc` and
             * `MessageDoc` to local aliases across 37 files, and codegen then printed
             * those alias names into `_generated/api.ts` where they do not resolve —
             * `TS2304: Cannot find name 'MessageDocument'`. The tree compiled until
             * the next `pnpm codegen`.
             */
            "unicorn/name-replacements": [
                "error",
                {
                    checkDefaultAndNamespaceImports: false,
                    checkShorthandImports: false,
                    checkShorthandProperties: false,
                    replacements: {
                        args: false,
                        ctx: false,
                        db: false,
                        doc: false,
                        docs: false,
                        env: false,
                        // Loop counters. `for (let index = 0; …)` reads worse than
                        // `for (let i = 0; …)` and nobody is confused by either.
                        i: false,
                        j: false,
                        params: false,
                        prop: false,
                        props: false,
                        ref: false,
                        refs: false,
                    },
                },
            ],

            /**
             * kebab-case. The camelCase this replaces was inherited from the previous backend —
             * there the filename IS part of the function path, so `agent/files.ts`
             * had to read as `agent.files`. Lunora derives its API from the module
             * graph, not the literal filename, so the constraint is gone.
             *
             * NOT applied to `**\/*`: that also judged `AGENTS.md` and `README.md`,
             * which are conventionally upper-case and were never in scope. That was
             * 44 of the 95 errors reported against Markdown.
             */
            "unicorn/filename-case": ["error", { case: "kebabCase" }],
        },
    },
    {
        /**
         * Registration IS the module's job in these two files, so a top-level call
         * is the API, not an accident.
         *
         * `crons.ts` is a sequence of `crons.interval(...)` / `crons.daily(...)`
         * calls — that is how a schedule is declared; there is nothing to defer it
         * into. `http.ts` is the same shape for route registration. Both are
         * imported for their effect and export the built object at the end.
         */
        files: ["lunora/crons.ts", "lunora/http.ts"],
        rules: {
            "unicorn/no-top-level-side-effects": "off",
        },
    },
    {
        /**
         * `@react-email` templates are rendered ONCE, server-side, to an HTML string
         * — there is no reconciler, no re-render, and nothing to memoise. The
         * react-perf rules exist to stop a new object identity forcing a child to
         * re-render, which cannot happen here; `<Text style={{ margin: 0 }}>` in a
         * template is the library's own documented idiom.
         */
        files: ["lunora/email/**/*.tsx"],
        rules: {
            "react-perf/jsx-no-new-array-as-prop": "off",
            "react-perf/jsx-no-new-function-as-prop": "off",
            "react-perf/jsx-no-new-object-as-prop": "off",
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
        files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
        rules: {
            /**
             * `Math.random()` here is an image seed, a mock model's sampling and
             * a retry jitter. The one site that was in an auth path — an
             * org-slug uniqueness suffix — was switched to `crypto.randomUUID()`
             * rather than covered by this.
             */
            "sonarjs/pseudo-random": "off",

            /**
             * Fires on the sandbox's own `/tmp` boundary CHECK —
             * `normalized === "/tmp" || normalized.startsWith("/tmp/")` — which
             * is the code enforcing the restriction the rule is worried about.
             */
            "sonarjs/publicly-writable-directories": "off",

            /**
             * The AI SDK binds `this` to the tool at call time, and
             * `agent/client/create-tool.ts` documents why `.bind()` cannot be
             * used instead. Same situation as Tiptap's extensions in `apps/web`.
             */
            "unicorn/no-this-outside-of-class": "off",

            /**
             * Unsatisfiable with `@typescript-eslint/member-ordering`: one
             * demands private members first, the other public first, and
             * `agent/client/mock-model.ts` interleaves `readonly` public fields
             * with a private one. Verified by making the move and watching the
             * error swap rules.
             */
            "unicorn/consistent-class-member-order": "off",

            /**
             * `Number(x)` is not `Number.parseInt(x, 10)`.
             * `messenger/platforms/slack.ts` parses a Slack `ts` like
             * "1531420618.000200", where keeping the fraction is what makes the
             * ±5-minute replay comparison correct.
             */
            "unicorn/prefer-number-coercion": "off",
        },
    },
    {
        /**
         * The `http://` URLs in the browser-security suite are SSRF FIXTURES:
         * `expect(validateDomain("http://169.254.169.254")).not.toBeNull()`
         * asserts the validator rejects link-local metadata endpoints. Making
         * them `https://` would test nothing.
         *
         * `parameterized-tests` wants these collapsed into `it.each`, but each
         * case carries its own rationale comment naming the attack it covers.
         */
        files: ["**/*.test.ts"],
        rules: {
            "sonarjs/no-clear-text-protocols": "off",
            "sonarjs/parameterized-tests": "off",
        },
    },
    {
        /**
         * The multilingual keyword regexes that decide query complexity. Both
         * rules ask for rewrites that change which queries match, i.e. which
         * model a request is routed to. A lint pass is the wrong place to
         * retune classification.
         */
        files: ["**/chat/lib/query-classifier.ts"],
        rules: {
            "regexp/no-contradiction-with-assertion": "off",
            "sonarjs/regex-complexity": "off",
        },
    },
    {
        /**
         * `new Function(…)` in `executeCodeNode` / `executeBranchNode` IS the
         * workflow builder's code and condition nodes — the feature, not an
         * accident. It is sandboxed: `"use strict"`, a fixed four-argument
         * surface, and a 10s `Promise.race` timeout. Satisfying `code-eval`
         * means deleting the capability.
         */
        files: ["**/workflow/core.ts"],
        rules: {
            "sonarjs/code-eval": "off",
        },
    },
    {
        /**
         * Every literal these rules object to is the thing under test:
         * `169.254.169.254` is the cloud-metadata endpoint in the SSRF blocklist
         * fixture, and `validateDomain("javascript:alert(1)")` asserts that
         * scheme is REJECTED. Obfuscating them to satisfy a scanner would make
         * the suite harder to read and no safer.
         */
        files: ["**/browser-security.test.ts"],
        rules: {
            "no-script-url": "off",
            "sonarjs/no-hardcoded-ip": "off",
            "unicorn/prefer-https": "off",
        },
    },
    {
        /**
         * `import * as sharing` exists so `Object.keys(sharing)` can enumerate
         * the module's exports and fail when a new public function is added
         * without a matching expectation. Named imports defeat the test's whole
         * purpose; the file records that `await import(…)` was tried and timed
         * out.
         */
        files: ["**/sharing.test.ts"],
        rules: {
            "import/no-namespace": "off",
        },
    },
    {
        files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
        rules: {
            /**
             * Fights Prettier: eslint inserts the blank line this rule wants
             * before a JSDoc block, prettier removes it again. Ran both and
             * watched the loop. Formatting yields to the formatter, as it does
             * for `antfu/consistent-list-newline`.
             */
            "jsdoc/lines-before-block": "off",

            /**
             * `Reflect.get(target, property, receiver)` inside a `Proxy` get
             * trap is the standard forwarding form — `target[property]` changes
             * the `this` an accessor sees, and needs a cast that trips another
             * rule. This is the DB stream reader; proxy semantics are not
             * something to alter for a syntax preference.
             */
            "no-restricted-syntax": "off",
        },
    },
    {
        files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
        rules: {
            /**
             * `accumulateUsage(total, …)` exists to mutate `total` — that is
             * its whole contract, and returning a new object instead is an API
             * change to every caller. Aliasing the parameter to satisfy the rule
             * would be laundering, not fixing. Same call as
             * `packages/ui`'s canvas-resize helper.
             */
            "no-param-reassign": "off",

            /**
             * A FIXME is deferred work, not a build error. This one is a
             * cross-reference tying a backend note to its counterpart in
             * `apps/web`, inside a block explaining why the fix must NOT be
             * applied here — rewording it to dodge the token would break the
             * grep that connects them. `warn` keeps it printed and greppable
             * without letting a TODO block a deploy.
             */
            "sonarjs/fixme-tag": "warn",
        },
    },
);
