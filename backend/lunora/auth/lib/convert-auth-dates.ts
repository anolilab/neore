import type { LunoraAuthOptions, SqlExecutor } from "@lunora/auth";

/**
 * How long an isolate waits after a failed conversion before the next request tries again. A failure that persists
 * (a date column holding text that is not an ISO date) would otherwise rescan every auth table on every request.
 */
export const RETRY_AFTER_MS = 60_000;

let converted: Promise<void> | undefined;
let failedAt: number | undefined;

/** Test seam: forget this isolate's memo. */
export const resetAuthDateConversionForTests = (): void => {
    converted = undefined;
    failedAt = undefined;
};

/**
 * Rewrite the ISO-string dates `@lunora/auth` up to alpha.275 stored in better-auth's tables as epoch-ms numbers, once
 * per isolate.
 *
 * Lunora runs this conversion inside `ensureMigrated`, which this Worker never calls (see `src/server.ts`), so it runs
 * here instead. Until a row is converted, a `ctx.db.patch` of it fails validation, and SQL range filters on its date
 * columns compare wrongly, because SQLite orders every string above every number.
 *
 * It never rejects. better-auth checks a session's or verification's expiry on the value it read, which the adapter
 * parses from either form, so serving auth with some rows still unconverted is safe. A failure is logged and retried
 * after {@link RETRY_AFTER_MS}. The conversion is idempotent (it only rewrites text SQLite can read as a date), so two
 * isolates racing it, or a retry after a partial run, are harmless.
 */
export const ensureAuthDatesConverted = async (exec: SqlExecutor, options: LunoraAuthOptions, now: () => number = Date.now): Promise<void> => {
    if (converted === undefined) {
        if (failedAt !== undefined && now() - failedAt < RETRY_AFTER_MS) {
            return;
        }

        converted = (async () => {
            const { convertAuthDatesToEpochMs } = await import("@lunora/auth");
            const tables = await convertAuthDatesToEpochMs(exec, options);
            const rewritten = tables.filter((table) => table.converted > 0);

            if (rewritten.length > 0) {
                console.info("auth: converted stored ISO dates to epoch ms", rewritten);
            }

            failedAt = undefined;
        })().catch((error: unknown) => {
            console.error("auth: converting stored ISO dates to epoch ms failed; retrying later", error);
            failedAt = now();
            converted = undefined;
        });
    }

    await converted;
};
