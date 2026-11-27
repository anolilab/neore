import type { LunoraAuthOptions, SqlExecutor } from "@lunora/auth";

/**
 * How long an isolate waits after a failed conversion before the next request tries again. A failure that persists
 * (a date column holding text that is not an ISO date) would otherwise rescan every auth table on every request.
 */
export const RETRY_AFTER_MS = 60_000;

/**
 * How long an isolate waits after a successful run before it runs again. During a rollout an isolate still on the
 * previous `@lunora/auth` writes ISO dates after this one converted; Lunora keeps converting for a day after the first
 * clean run, but checks only when called, and a warm isolate would otherwise call it once.
 */
export const RECHECK_AFTER_MS = 10 * 60_000;

let running: Promise<void> | undefined;
let nextAt = 0;

/** Test seam: forget this isolate's memo. */
export const resetAuthDateConversionForTests = (): void => {
    running = undefined;
    nextAt = 0;
};

/**
 * Rewrite the ISO-string dates `@lunora/auth` up to alpha.275 stored in better-auth's tables as epoch-ms numbers.
 *
 * Lunora's own data steps (`ensureMigrated`, `prepareAuthData`) run this conversion, but neither fits this Worker:
 * better-auth's migrator cannot drive the Lunora D1 adapter, and `prepareAuthData` also runs Lunora's email backfill
 * (this app gates its own, `email-canonical-backfill.ts`) and drops the `account.issuer` column `schema.ts` declares.
 * So this calls the conversion alone: `convertAuthDatesOnce`, which records its progress in Lunora's backfill state
 * table, keeps converting for 24 hours after the first clean run, and is then one indexed lookup.
 *
 * Until a row is converted, a `ctx.db.patch` of it fails validation, and SQL range filters on its date columns compare
 * wrongly, because SQLite orders every string above every number.
 *
 * It never rejects. better-auth checks a session's or verification's expiry on the value it read, which the adapter
 * parses from either form, so serving auth with some rows still unconverted is safe. A failure is logged and retried
 * after {@link RETRY_AFTER_MS}; a success is re-run after {@link RECHECK_AFTER_MS}.
 */
export const ensureAuthDatesConverted = async (exec: SqlExecutor, options: LunoraAuthOptions, now: () => number = Date.now): Promise<void> => {
    if (running === undefined) {
        const startedAt = now();

        if (startedAt < nextAt) {
            return;
        }

        running = (async () => {
            try {
                const { convertAuthDatesOnce } = await import("@lunora/auth");
                const tables = await convertAuthDatesOnce(exec, options);
                const rewritten = tables.filter((table) => table.converted > 0);

                if (rewritten.length > 0) {
                    console.info("auth: converted stored ISO dates to epoch ms", rewritten);
                }

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
