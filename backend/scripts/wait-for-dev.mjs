/**
 * Waits until the backend dev server answers on 8788, watching the process `lunora dev` recorded in `.lunora/dev.json`.
 *
 * `lunora dev` starts the server in the background and records its pid there. A port probe alone cannot tell a server that
 * is still starting from one that has died, so each poll also checks the recorded pid. When that pid is gone and stays gone,
 * the script prints the end of `.lunora/dev.log` and fails, instead of waiting out the timeout.
 *
 * The record can change while the server starts (it first holds the launcher's pid, then the server's), so a dead pid only
 * counts once it has been unchanged for `STALE_AFTER_MS`.
 *
 * Run: node scripts/wait-for-dev.mjs   (or `pnpm --filter @neore/backend run dev:wait`)
 */
/* eslint-disable no-console */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const BACKEND = resolve(import.meta.dirname, "..");
const DEV_JSON = join(BACKEND, ".lunora/dev.json");
const DEV_LOG = join(BACKEND, ".lunora/dev.log");
const BACKEND_URL = process.env.VITE_LUNORA_URL || "http://localhost:8788";
const STATUS_URL = `${BACKEND_URL}/_lunora/status`;
const POLL_MS = 2000;
// Cold starts run codegen before `lunora dev` records its pid (about 11 s cold), so a missing or dead record is only final after this.
const STALE_AFTER_MS = 120_000;
const TIMEOUT_MS = 300_000;

const recordedPid = () => {
    try {
        return JSON.parse(readFileSync(DEV_JSON, "utf8")).pid;
    } catch {
        return undefined;
    }
};

const isAlive = (pid) => {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
};

const answers = async () => {
    try {
        const response = await fetch(STATUS_URL, { signal: AbortSignal.timeout(2000) });

        return response.ok;
    } catch {
        return false;
    }
};

const logTail = () => {
    try {
        return readFileSync(DEV_LOG, "utf8").trimEnd().split("\n").slice(-20).join("\n");
    } catch {
        return "(no .lunora/dev.log)";
    }
};

const started = Date.now();
let pid = recordedPid();
let pidSince = started;

for (;;) {
    if (await answers()) {
        console.log(`Backend ready on 8788 (pid ${String(recordedPid())}).`);

        process.exit(0);
    }

    const current = recordedPid();
    const now = Date.now();

    if (current !== pid) {
        pid = current;
        pidSince = now;
    }

    const dead = current === undefined || !isAlive(current);

    if (dead && now - pidSince > STALE_AFTER_MS) {
        console.error(current === undefined ? `No ${DEV_JSON}: the dev server is not running.` : `The dev server (pid ${current}) exited before it was ready.`);
        console.error(logTail());

        process.exit(1);
    }

    if (now - started > TIMEOUT_MS) {
        console.error(`The backend did not answer on 8788 within ${TIMEOUT_MS / 1000}s (recorded pid ${String(current)}, ${dead ? "gone" : "alive"}).`);
        console.error(logTail());

        process.exit(1);
    }

    await new Promise((done) => {
        setTimeout(done, POLL_MS);
    });
}
