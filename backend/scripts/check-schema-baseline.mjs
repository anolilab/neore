/**
 * Checks that the committed schema baseline (`lunora/.lunora-schema.json`) matches `lunora/schema.ts`.
 *
 * `lunora prepare` is the only command that advances the baseline, and it also gates breaking schema drift. Nothing else fails when
 * a schema change is not followed by `prepare:deploy` and a commit of the baseline, so the stale file can ship unnoticed.
 *
 * This runs `lunora prepare`, then compares the baseline. If prepare advanced it, the working tree was stale: the committed file is
 * restored (this check never edits the tree) and the script fails with the command to run. If prepare itself fails (breaking drift
 * with no migration), that failure is reported as is.
 *
 * Run: node scripts/check-schema-baseline.mjs   (or `pnpm check:schema-baseline`)
 */
/* eslint-disable no-console */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const BACKEND = resolve(import.meta.dirname, "..");
const BASELINE = join(BACKEND, "lunora/.lunora-schema.json");

const before = readFileSync(BASELINE, "utf8");

const prepare = spawnSync("npx", ["lunora", "prepare", "--no-smoke-load"], { cwd: BACKEND, shell: process.platform === "win32", stdio: "inherit" });

const after = readFileSync(BASELINE, "utf8");

if (after !== before) {
    // Put the committed baseline back: the check reports, it does not write.
    writeFileSync(BASELINE, before);
    console.error("\nThe schema baseline is out of date: lunora/schema.ts changed without its baseline being committed.");
    console.error("Run `pnpm --filter @neore/backend run prepare:deploy`, then commit lunora/.lunora-schema.json.");

    process.exit(1);
}

if (prepare.status !== 0) {
    console.error(`\nlunora prepare failed (exit ${String(prepare.status ?? "signal")}).`);

    process.exit(prepare.status ?? 1);
}

console.log("The schema baseline matches lunora/schema.ts.");
