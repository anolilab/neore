import { createConfig } from "@anolilab/eslint-config";

/**
 * `packages/ui` had no eslint config at all, so `eslint .` resolved up to the
 * repo-root `eslint.config.mjs` — which registers no TypeScript parser. Every
 * `.ts`/`.tsx` here failed with `Parsing error: Unexpected token` instead of
 * being linted, so the package had no lint gate whatsoever. Same hole
 * `backend/eslint.config.js` was written to close, and the calibration below is
 * mostly ported from it and from `apps/web`, which is the other React tree.
 *
 * @type {import("@anolilab/eslint-config").PromiseFlatConfigComposer}
 */
export default createConfig(
    {
        ignores: ["./eslint.config.js", "./.eslint.cache.json", "./dist/**"],
        react: {
            reactCompiler: true,
            reactVersion: "19.2",
        },
        typescript: {
            ignoresTypeAware: ["*.json", "*.md"],
            isTypeAware: false,
            tsconfigPath: "./tsconfig.json",
        },
        // Matching `apps/web`, `backend/` and the services: the plugin's
        // `unbound-method` rule needs type-aware parser services, and this config
        // is not type-aware — with the plugin on, eslint crashes rather than
        // reporting.
        vitest: false,
    },
    {
        files: ["**/*.css"],
        rules: {
            // `global.css` is a Tailwind v4 entrypoint. Its `@import "tailwindcss"`
            // and the utility overrides after it are cascade-ordered on purpose;
            // wrapping them in `@layer` changes which declarations win, and
            // `!important` is how a handful of third-party widget styles (Univer,
            // tiptap, react-pdf) get overridden at all.
            "css/no-important": "off",
            "css/use-layers": "off",
        },
    },
    {
        // Scoped to the script languages: a bare `**/*` also matches `global.css`,
        // and eslint hard-errors when a rule is configured for a language its
        // plugin does not support.
        files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
        rules: {
            /*
             * House style the whole repo already contradicts, turned off in
             * `backend/eslint.config.js` and `services/*` for the same reasons.
             */
            /**
             * The same three-way cycle `apps/web` documents, hit from the other
             * side: this package already spells them `globalThis.X`, and that
             * form is the one `no-unnecessary-global-this` rejects.
             *
             *   globalThis.addEventListener -> unicorn/no-unnecessary-global-this
             *   addEventListener            -> no-restricted-globals
             *   window.addEventListener     -> unicorn/prefer-global-this
             *
             * Turned off here for the same reason and in the same direction, so
             * the repo has ONE spelling rather than a different rule disabled in
             * each package. `globalThis` is the right side to land on: `window`
             * is an unresolved identifier during SSR, so even a feature-detect
             * guard throws when spelled with it.
             */
            "unicorn/no-unnecessary-global-this": "off",

            /**
             * `react-refresh/only-export-components` guards Fast Refresh
             * granularity: a file that exports both a component and something
             * else loses HMR for the component. That premise does not hold for
             * every finding here, so the rule is narrowed rather than obeyed or
             * silenced.
             *
             * `allowExportNames` is the rule's own escape hatch. The six names
             * below are hooks and a cva variant object that live beside the
             * component they belong to. Satisfying the rule properly means
             * moving each to a sibling file and updating every importer —
             * `useAppForm` alone has 27 across `apps/web`, `Keys` has 13 — for a
             * dev-only ergonomic gain in a library whose consumers import
             * through the barrel anyway. A re-export does not satisfy it.
             */
            "react-refresh/only-export-components": [
                "error",
                {
                    allowExportNames: ["Keys", "buttonVariants", "useAppForm", "useFieldContext", "useFormContext", "useSidebar", "withForm"],
                },
            ],

            "@typescript-eslint/explicit-member-accessibility": "off",
            "@typescript-eslint/explicit-module-boundary-types": "off",
            "antfu/if-newline": "off",
            "class-methods-use-this": "off",
            "func-style": "off",
            "import/exports-last": "off",
            "import/prefer-default-export": "off",
            "jsdoc/check-indentation": "off",
            // Its fix rewrites `<style>` inside a doc comment to `&lt;style>`,
            // which is worse to read than the thing it guards against. Off in
            // `backend/eslint.config.js` for the same reason.
            "jsdoc/text-escaping": "off",
            "no-await-in-loop": "off",
            "no-bitwise": "off",
            "no-plusplus": "off",
            "no-underscore-dangle": "off",
            "unicorn/no-break-in-nested-loop": "off",
            "unicorn/prefer-await": "off",
            /*
             * Its autofixer rewrote a `.reduce()` min-search into a
             * `let closestValue;` for-loop — tab-indented in a space-indented file,
             * and no longer provably defined, so `tsc` then flagged three
             * `possibly 'undefined'` errors downstream. Off rather than merely
             * unenforced, because the fix is what does the damage.
             */
            "unicorn/no-array-reduce": "off",
            /*
             * Rewrites `parent.appendChild(node)` to `parent.append(node)`. Both
             * are DOM, but `apps/web` compiles this source with the Workers types
             * in scope, where the global `Element` is HTMLRewriter's — whose
             * `append()` takes `string | Response | ReadableStream`. The rewrite
             * therefore typechecks inside `packages/ui` and breaks in its consumer.
             */
            "unicorn/prefer-dom-node-append": "off",
            /*
             * Its autofixer rewrites `function Impl() {}` into
             * `const Impl = () => {}`. Seven data-grid components are wrapped as
             * `React.memo(Impl)` ABOVE their definition and rely on function
             * hoisting; the arrow form puts the reference in the TDZ.
             */
            "react/function-component-definition": "off",
            "unicorn/no-top-level-side-effects": "off",

            // React uses null as a first-class value: `return null` (render
            // nothing), `useRef<T>(null)` (DOM refs), and the DOM APIs this package
            // wraps return it everywhere.
            "unicorn/no-null": "off",

            // This package runs in a browser, not in Node. `navigator`, `File`,
            // `crypto.randomUUID` and `URL.revokeObjectURL` are standard web
            // platform globals here, not experimental Node builtins.
            "n/no-unsupported-features/node-builtins": "off",

            // `import * as React from "react"` is what all 67 component files use,
            // and it is the form the React docs give for the automatic JSX runtime.
            "import/no-namespace": "off",

            // Prop-shape booleans are named by the API they mirror (`disabled`,
            // `open`, `loading`), not by an `is`/`has` prefix the consumer would
            // then have to remember.
            "unicorn/consistent-boolean-name": "off",

            // Hoisted helpers below their use sites are the existing shape here;
            // the hazard the rule guards is a `const` in the TDZ.
            "@typescript-eslint/no-use-before-define": ["error", { classes: true, enums: true, functions: false, typedefs: false, variables: false }],

            /*
             * Worth seeing, not worth blocking on — each is a judgement the author
             * has to make. Same three-way split `backend/` settled on.
             */
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-non-null-assertion": "warn",
            "no-secrets/no-secrets": "warn",
            "sonarjs/cognitive-complexity": "warn",
            "unicorn/no-computed-property-existence-check": "warn",
            "unicorn/prefer-simple-condition-first": "warn",

            // `e` is the event in every DOM handler in this package, and the rest
            // are the names the codebase already uses consistently.
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
                        e: false,
                        env: false,
                        err: false,
                        i: false,
                        j: false,
                        obj: false,
                        params: false,
                        prev: false,
                        prop: false,
                        props: false,
                        ref: false,
                        refs: false,
                        res: false,
                        temp: false,
                    },
                },
            ],
        },
    },
    {
        /**
         * Barrels are re-export files: they define no components, so there is
         * nothing for Fast Refresh to preserve and the rule's premise does not
         * apply. `file-renderers/index.tsx` has zero local declarations, and
         * `spreadsheet/index.tsx` now has zero too — its three `is*File`
         * predicates were exported, imported by nothing anywhere in the
         * monorepo, and have been deleted.
         *
         * Scoped to index files specifically, so a component file that grows a
         * stray export is still caught.
         */
        files: ["**/index.ts", "**/index.tsx"],
        rules: {
            "react-refresh/only-export-components": "off",
        },
    },
    {
        /**
         * `*-context.tsx` files ARE the "separate file" the rule asks for: each
         * holds only `createContext` values and their types, no component, so
         * Fast Refresh has nothing to preserve in them. eslint-plugin-react-refresh
         * 0.5.4+ flags any exported context in a `.tsx` file regardless; that
         * version reached this config once `autoInstallPeers` went off and
         * `@anolilab/eslint-config` stopped getting its own pinned 0.5.3.
         */
        files: ["**/*-context.tsx"],
        rules: {
            "react-refresh/only-export-components": "off",
        },
    },
    {
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        rules: {
            /**
             * `Iterator.prototype.toArray()` is ES2025 and `tsconfig.base.json`
             * sets `"lib": [… "ES2023"]`, so obeying this rule produces code
             * that does not compile. Turn it back on when `lib` moves.
             */
            "unicorn/prefer-iterator-to-array": "off",
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
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        rules: {
            // Animation phase and skeleton widths — no security boundary.
            "sonarjs/pseudo-random": "off",
            // `Number.parseFloat`'s prefix parsing is load-bearing: a cell of
            // `"12abc"` must resolve to 12, where `Number()` gives NaN.
            "unicorn/prefer-number-coercion": "off",
        },
    },
    {
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        rules: {
            /**
             * `unicorn/filename-case` wants `AGENTS.md` renamed to `agents.md`.
             * That is the agent-instruction convention — eight of them in this
             * tree, plus the `CLAUDE.md` symlink. Renaming breaks tooling to
             * satisfy a style rule about source files.
             */
            "unicorn/filename-case": ["error", { case: "kebabCase", ignore: [String.raw`^AGENTS\.md$`] }],
        },
    },
    {
        /**
         * `photon.filter(img, preset)` is the Photon WASM API, not
         * `Array#filter`. Both rules match on the method NAME plus a second
         * argument. The only way to satisfy them is `photon["filter"](…)`,
         * which then trips `dot-notation`.
         */
        files: ["**/image-editor/photon-operations.ts"],
        rules: {
            "unicorn/no-array-callback-reference": "off",
            "unicorn/no-array-method-this-argument": "off",
        },
    },
    {
        /**
         * Unused TYPE PARAMETERS inside `declare module` interface
         * augmentations for `@tanstack/react-table`. Renaming them to `_TData`
         * is a hard `TS2428` — declaration merging requires every declaration to
         * use identical type-parameter names. Verified by trying it.
         */
        files: ["**/types/data-grid.ts"],
        rules: {
            "unused-imports/no-unused-vars": "off",
        },
    },
    {
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        rules: {
            /**
             * The 15 that survive three passes of fixing are all EXTERNAL-STORE
             * synchronisation, which is the usage this rule's own documentation
             * permits — it is simply written with `useEffect` rather than
             * `useSyncExternalStore`. Spot-checked rather than taken on report:
             * `carousel.tsx` and `inline-citation.tsx` read `canScrollPrev()` /
             * `scrollSnapList()` off Embla's API, `use-audio-devices` awaits
             * `enumerateDevices()`, `video-player` sets state from an HLS error
             * event, `lazy-image` probes `img.complete`.
             *
             * Converting each is a per-component rearchitecture, not a lint fix.
             * Demoted rather than disabled so a genuine prop-mirror in NEW code
             * still shows up — several of those were found and fixed this
             * session.
             */
            "react-hooks/set-state-in-effect": "warn",
            "react-x/set-state-in-effect": "warn",

            /**
             * Every remaining site was checked and none has a stable id: CSV
             * grids where the row/column index IS the identity, a slide's text
             * runs (plain strings, duplicates possible), `sourceUrls.slice(0,3)`
             * where the same URL can legitimately be cited twice, and
             * append-only console logs. Keying on the value instead would
             * produce DUPLICATE keys, which is a worse bug than the warning.
             */
            "react-x/no-array-index-key": "warn",
        },
    },
    {
        /**
         * The nine survivors are all one expression repeated across three cell
         * types: `const sideOffset = -(containerRef.current?.clientHeight ?? 0)`
         * — a DOM layout read during render, used to position a popover.
         *
         * Today it yields 0 on first render and a real value only once
         * something re-renders. Any fix (callback ref plus state, or a layout
         * effect) forces an extra render and changes WHEN the popover first
         * gets its true offset. That is a visible behaviour change to a
         * hand-tuned interaction.
         *
         * The genuinely unsafe pattern this rule exists for — a DOM WRITE during
         * render — was found in this same file earlier in the session and fixed.
         */
        files: ["**/data-grid/data-grid-cell-variants.tsx"],
        rules: {
            "react-hooks/refs": "off",
        },
    },
    {
        files: ["**/*.{jsx,tsx}"],
        rules: {
            /**
             * `label.tsx` and `snappy-slider`'s label are one-line design-system
             * wrappers that spread `ComponentProps<"label">`. The rule cannot
             * see a control the component does not own. Where a real control WAS
             * in scope, the fix was made — `snappy-slider`'s value input now
             * wires `htmlFor`/`id` through `useId`.
             */
            "jsx-a11y/label-has-associated-control": "off",

            /**
             * Generic media primitives for AI-generated audio and arbitrary user
             * uploads. There is no caption track to point at, and a `<track>`
             * with no `src` is a lie rather than an accommodation.
             */
            "jsx-a11y/media-has-caption": "off",
        },
    },
    {
        /**
         * Click-to-focus wrappers, not controls. `InputGroupAddon` and the
         * `textarea` expand wrapper put an `onClick` on the padding around a
         * real, natively focusable input so a pointer user can click near it.
         *
         * A keyboard user tabs straight to the inner control and never needs
         * the wrapper — giving it `tabIndex` would ADD a redundant tab stop and
         * make keyboard navigation worse, so obeying this rule here would
         * reduce accessibility rather than improve it.
         *
         * The one site in this package that WAS a real gap is fixed rather than
         * exempted: `image-comparison.tsx` was pointer-only and now carries
         * `role="slider"`, a tab stop, `aria-valuenow`, and arrow/Home/End key
         * handling.
         */
        files: ["**/components/input-group.tsx", "**/components/textarea.tsx"],
        rules: {
            "jsx-a11y/click-events-have-key-events": "off",
            "jsx-a11y/no-noninteractive-element-interactions": "off",
            "jsx-a11y/no-static-element-interactions": "off",
        },
    },
    {
        /**
         * The column resizer is the ARIA WINDOW SPLITTER pattern —
         * `role="separator"` with `aria-valuenow`/`min`/`max`, a tab stop and
         * drag handlers. That is the spec-correct markup for a resizable
         * divider; jsx-a11y classifies `separator` as non-interactive and has
         * no exception for the focusable variant.
         */
        files: ["**/data-grid/data-grid-column-header.tsx", "**/data-grid/data-grid-sort-menu.tsx"],
        rules: {
            "jsx-a11y/no-noninteractive-element-interactions": "off",
            "jsx-a11y/no-noninteractive-tabindex": "off",
        },
    },
    {
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        rules: {
            /**
             * `<canvas role="img">` with an `aria-label` is the recommended
             * markup for a canvas that renders a picture, and `<a
             * role="listitem">` inside a `role="list"` is the correct pair; the
             * rule lists both elements as interactive with no allowance.
             */
            "jsx-a11y/no-interactive-element-to-noninteractive-role": "off",

            /**
             * `photon-image-editor` resizes the caller's canvas before
             * `putImageData` — a replacing op returns a differently-sized image,
             * so mutating the parameter IS the function's contract. Aliasing it
             * to satisfy the rule would be theatre.
             */
            "no-param-reassign": "off",

            /**
             * `docx-preview` renders HTML produced by the docx converter and
             * sanitised with DOMPurify; `dangerouslySetInnerHTML` is the
             * mechanism, not an oversight. (`chart.tsx`'s instance WAS
             * removable and was removed.)
             */
            "react/no-danger": "off",

            /**
             * `PopoverAnchor` merges props into a consumer-supplied `render`
             * element — the Base UI render-prop contract this library is built
             * on. Removing `cloneElement` is an API redesign.
             */
            "react-x/no-clone-element": "off",

            /**
             * `hls.js` disagrees with itself: its ESM bundle exports a named
             * `isSupported`, its `.d.ts` declares it only as a static on the
             * class, so `import { Hls }` is `TS2614`. The rule reads the runtime
             * module and TypeScript reads the declarations.
             */
            "import/no-named-as-default-member": "off",
        },
    },
    {
        /**
         * Both are the same cascade. `data-grid-row.tsx` deliberately depends on
         * `columnVisibility`/`columnPinning` because `row.getVisibleCells()`
         * reads them through TanStack's internal state — there is no way to
         * express that the rule accepts. `fabric-canvas-editor.tsx` carries a
         * correct `exhaustive-deps` disable on its mount-only Fabric init
         * (honouring the deps would dispose and rebuild the canvas on every
         * prop change), and React Compiler then refuses to optimise the
         * component BECAUSE a React rule is disabled. Fixing either trades one
         * error for another.
         */
        files: ["**/data-grid/data-grid-row.tsx", "**/canvas-editor/fabric-canvas-editor.tsx"],
        rules: {
            "react-compiler/react-compiler": "off",
            "react-hooks/exhaustive-deps": "off",
        },
    },
);
