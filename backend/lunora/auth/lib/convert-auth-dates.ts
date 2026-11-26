import type { LunoraAuthOptions, SqlExecutor } from "@lunora/auth";

/**
 * How long an isolate waits after a failed conversion before the next request tries again. A failure that persists
 * (a date column holding text that is not an ISO date) would otherwise rescan every auth table on every request.
 */
export const RETRY_AFTER_MS = 60_000;

/** How long an isolate waits after a successful pass before it checks again for dates written meanwhile. */
export const RECHECK_AFTER_MS = 10 * 60_000;

/**
 * How long after the first successful pass the conversion keeps checking. During a rollout an isolate still on the
 * previous `@lunora/auth` writes ISO dates after this one converted; Lunora's own conversion keeps checking for the same
 * day for that reason. A pass that runs this long after the first one is the last, for every isolate.
 */
export const ROLLOUT_WINDOW_MS = 24 * 60 * 60_000;

/** Raw table recording when the first pass succeeded and whether the last one ran; ours, not a schema table. */
const MARKER_TABLE = "authDateConversionMarker";
const MARKER_NAME = "epoch-ms";

let finished = false;
let running: Promise<void> | undefined;
let nextAt = 0;

/** Test seam: forget this isolate's memo. */
export const resetAuthDateConversionForTests = (): void => {
    finished = false;
    running = undefined;
    nextAt = 0;
};

const pass = async (exec: SqlExecutor, options: LunoraAuthOptions, startedAt: number): Promise<boolean> => {
    await exec.run(`CREATE TABLE IF NOT EXISTS "${MARKER_TABLE}" ("name" TEXT PRIMARY KEY, "since" INTEGER NOT NULL, "final" INTEGER NOT NULL)`, []);

    const [marker] = await exec.all(`SELECT "since", "final" FROM "${MARKER_TABLE}" WHERE "name" = ?`, [MARKER_NAME]);

    if (marker?.final === 1) {
        return true;
    }

    const { convertAuthDatesToEpochMs } = await import("@lunora/auth");
    const tables = await convertAuthDatesToEpochMs(exec, options);
    const rewritten = tables.filter((table) => table.converted > 0);

    if (rewritten.length > 0) {
        console.info("auth: converted stored ISO dates to epoch ms", rewritten);
    }

    // The first success records when it ran; a pass at least the rollout window after it is the last.
    await exec.run(`INSERT OR IGNORE INTO "${MARKER_TABLE}" ("name", "since", "final") VALUES (?, ?, 0)`, [MARKER_NAME, startedAt]);

    const since = typeof marker?.since === "number" ? marker.since : startedAt;

    if (startedAt - since < ROLLOUT_WINDOW_MS) {
        return false;
    }

    await exec.run(`UPDATE "${MARKER_TABLE}" SET "final" = 1 WHERE "name" = ?`, [MARKER_NAME]);

    return true;
};

/**
 * Rewrite the ISO-string dates `@lunora/auth` up to alpha.275 stored in better-auth's tables as epoch-ms numbers.
 *
 * Lunora runs this conversion inside `ensureMigrated`, which this Worker never calls (see `src/server.ts`), so it runs
 * here instead. Until a row is converted, a `ctx.db.patch` of it fails validation, and SQL range filters on its date
 * columns compare wrongly, because SQLite orders every string above every number.
 *
 * Each isolate runs a pass on its first auth request and again at most every {@link RECHECK_AFTER_MS}, so dates an
 * isolate still on the previous version writes during a rollout are converted too. Once a pass runs
 * {@link ROLLOUT_WINDOW_MS} after the first success, a marker row ends it for every isolate: later ones read one row.
 *
 * It never rejects. better-auth checks a session's or verification's expiry on the value it read, which the adapter
 * parses from either form, so serving auth with some rows still unconverted is safe. A failure is logged and retried
 * after {@link RETRY_AFTER_MS}. The conversion is idempotent (it only rewrites text SQLite can read as a date), so two
 * isolates racing it, or a retry after a partial run, are harmless.
 */
export const ensureAuthDatesConverted = async (exec: SqlExecutor, options: LunoraAuthOptions, now: () => number = Date.now): Promise<void> => {
    if (finished) {
        return;
    }

    if (running === undefined) {
        const startedAt = now();

        if (startedAt < nextAt) {
            return;
        }

        running = (async () => {
            try {
                finished = await pass(exec, options, startedAt);
                nextAt = startedAt + RECHECK_AFTER_MS;
            } catch (error) {
                console.error("auth: converting stored ISO dates to epoch ms failed; retrying later", error);
                nextAt = now() + RETRY_AFTER_MS;
            } finally {
                running = undefined;
            }
        })();
    }

    await running;
};
