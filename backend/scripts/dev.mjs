/**
 * Starts `lunora dev` with a larger V8 heap. `lunora dev` ran out of the default heap (about 4 GB) while it started wrangler and
 * the studio. The limit is set here, not in package.json or project.json, so it reaches the CLI and the processes it spawns
 * through NODE_OPTIONS without a long flag string in those files.
 *
 * Usage: node scripts/dev.mjs [lunora dev options]   (`pnpm --filter @neore/backend run dev`)
 */
import { spawnSync } from "node:child_process";

const HEAP_MB = 8192;

// A heap limit the caller already set (CI sizes the e2e backend's) is kept; the default applies only when none is set.
const inherited = process.env.NODE_OPTIONS ?? "";
const nodeOptions = inherited.includes("--max-old-space-size") ? inherited : `${inherited} --max-old-space-size=${HEAP_MB}`.trim();

const result = spawnSync("lunora", ["dev", ...process.argv.slice(2)], {
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
    shell: process.platform === "win32",
    stdio: "inherit",
});

if (result.error) {
    console.error(`Could not start lunora: ${result.error.message}`);
    process.exit(1);
}

if (result.signal) {
    console.error(`lunora dev was stopped by ${result.signal}.`);
    process.exit(1);
}

process.exit(result.status ?? 1);
