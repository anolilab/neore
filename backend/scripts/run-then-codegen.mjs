#!/usr/bin/env node
/**
 * Run a `lunora` command, then ALWAYS re-run codegen, then exit with the
 * ORIGINAL command's status.
 *
 * Both halves matter, and the comment in AGENTS.md explains why: `lunora build`
 * and `lunora prepare` re-run codegen internally and overwrite `_generated/`
 * without the fixpoint loop, so the project's own `pnpm codegen` has to run
 * afterwards — but a failing build must still fail the script, or CI goes green
 * on a broken tree.
 *
 * This used to be inline shell:
 *
 *     lunora build --emit-bindings lunora-bindings.json; status=$?; pnpm run codegen; exit $status
 *
 * npm runs scripts through `cmd.exe` on Windows, where `;` is not a separator
 * and `status=$?` is handed to the program as an argument — so the Windows leg
 * of the test matrix died with `Error: Found unknown argument "status=$?;"`
 * before it built anything. Node is the portable shell here.
 */
import { spawnSync } from "node:child_process";

const [, , ...command] = process.argv;

if (command.length === 0) {
    console.error("usage: run-then-codegen.mjs <command> [args...]");
    process.exit(2);
}

/** `.cmd` shims on Windows are not executable images, so they need a shell. */
const shell = process.platform === "win32";

const run = (bin, args) => spawnSync(bin, args, { shell, stdio: "inherit" });

const first = run(command[0], command.slice(1));

// Always regenerate, even when the command above failed — a half-generated
// `_generated/` is the thing this wrapper exists to prevent.
run("pnpm", ["run", "codegen"]);

// A signal death has a null status; treat it as a failure rather than success.
process.exit(first.status ?? 1);
