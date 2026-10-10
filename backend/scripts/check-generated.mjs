/**
 * Post-codegen CHECK for `lunora/_generated/**`. It reports; it does not write.
 *
 * This used to be `tools/lunora-migrate/patch-generated.ts`, a patch script with
 * thirteen edits that made generated output compile. Editing `_generated/**` was
 * always the wrong place for a fix: the directory is written by a tool, and every
 * regeneration threw the repairs away without saying so (`lunora dev` does it on
 * any source change). The repairs were therefore in force right up until someone
 * started the dev server, and their absence surfaced later as a wall of type
 * errors in whatever was being worked on at the time.
 *
 * All thirteen are gone, and none of them by ignoring the problem:
 *
 * - Nine resolved names the generator emits without importing. Those moved to a
 *   `.d.ts` global — a global resolves an identifier as well as an import does,
 *   from outside the file. Codegen@135 then fixed the leak at source (it emits a
 *   qualified `import("…").Type`), so that file is gone too.
 * - Two rewrote a `.pnpm` store path the generator emitted instead of a module
 *   specifier. Fixed upstream; this file now checks that it stays fixed.
 * - One corrected an `_ctx`/`ctx` typo, fixed upstream. Removing it exposed nine
 *   real type errors in our own code that it had been masking — procedures
 *   declaring `.output(v.null())` and then returning nothing.
 * - One narrowed `ctx.db.query()` to exclude `.global()` tables. That guard is
 *   ours and we still want it, so it moved to
 *   `lunora/lib/global-table-reader.test.ts`, which reads the same rule out of
 *   `schema.ts` and names the offending call site.
 *
 * What remains is the check below, so a regression announces itself here rather
 * than as `TS2307` inside a generated file nobody expects to read. `tsc` would
 * catch it too — the value here is the diagnosis and the "do not edit
 * `_generated/**`" instruction, not the detection.
 *
 * Plain Node ESM with no imports beyond `node:*`, deliberately: it used to live
 * in its own workspace package (`@neore/lunora-migrate`) that pulled `tsx` and
 * `ts-morph` for a file that needs neither, and whose name described codemods
 * that were deleted long before it was.
 *
 * Run: node scripts/check-generated.mjs
 *      (or `pnpm codegen`, which chains it)
 */
/* eslint-disable no-console */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const BACKEND = resolve(import.meta.dirname, "..");

/**
 * Defaults to the real generated directory; overridable by argument so the check
 * can be exercised against a fixture. Worth the one line — the previous version
 * silently reported success when `_generated/` was absent entirely (both
 * `existsSync` calls return false, so `problems` is empty), which is
 * indistinguishable from a clean pass and is exactly the state a `pnpm clean`
 * leaves behind.
 */
const GENERATED = process.argv[2] ? resolve(process.argv[2]) : join(BACKEND, "lunora/_generated");

/**
 * Codegen once wrote an inferred third-party type as an `import()` of the path
 * it resolved on disk, with the leading `node_modules/` sliced off:
 *
 *     import(".pnpm/@lunora+server@1.0.0-alpha.87_…/node_modules/@lunora/server/data-model")
 *
 * That is not a specifier and resolves from nowhere, so `tsc` reports TS2307
 * against a generated file. Fixed upstream, and cheap enough to keep watching:
 * it reappeared once already when an unrelated change altered which types were
 * inferred.
 *
 * @param {string} fileName
 * @returns {string[]}
 */
const findStorePathImports = (fileName) => {
    const path = join(GENERATED, fileName);

    if (!existsSync(path)) {
        return [];
    }

    const text = readFileSync(path, "utf8");

    return [...text.matchAll(/import\("(?:\.\.\/)*\.pnpm\/[^"]+"\)/g)].map((hit) => `${fileName}: ${hit[0].slice(0, 90)}…`);
};

const CHECKED = ["api.ts", "functions.ts"];

if (!CHECKED.some((name) => existsSync(join(GENERATED, name)))) {
    console.warn(`Nothing to check: ${GENERATED} has neither ${CHECKED.join(" nor ")}. Run \`lunora codegen\` first.`);
    process.exit(0);
}

const problems = CHECKED.flatMap((name) => findStorePathImports(name));

if (problems.length > 0) {
    console.error("Generated output contains unresolvable store-path imports — a fixed codegen defect has regressed:\n");

    for (const problem of problems.slice(0, 5)) {
        console.error(`  ${problem}`);
    }

    if (problems.length > 5) {
        console.error(`  … and ${String(problems.length - 5)} more`);
    }

    console.error(
        "\nDo NOT repair these by editing _generated/** — a regeneration discards it.\n" +
            "Either pin back to a Lunora release that emits a real specifier, or map the\n" +
            'prefix in backend/tsconfig.json paths: `".pnpm/*": ["./node_modules/.pnpm/*"]`.',
    );

    process.exit(1);
}

console.log("Generated output checked: no store-path imports. Nothing patched — _generated/ is not ours to edit.");
