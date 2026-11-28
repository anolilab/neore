/**
 * Starts `lunora dev` with a larger V8 heap. `lunora dev` ran out of the default heap (about 4 GB) while it started wrangler and
 * the studio. The limit is set here, not in package.json or project.json, so it reaches the CLI and the processes it spawns
 * through NODE_OPTIONS without a long flag string in those files.
 *
 * Usage: node scripts/dev.mjs [lunora dev options]   (`pnpm --filter @neore/backend run dev`)
 */
import { spawnSync } from "node:child_process";

const HEAP_MB = 8192;

const result = spawnSync("lunora", ["dev", ...process.argv.slice(2)], {
    env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${HEAP_MB}` },
    stdio: "inherit",
});

process.exit(result.status ?? 1);
