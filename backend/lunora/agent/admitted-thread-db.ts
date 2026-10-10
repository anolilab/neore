/**
 * The database a thread's rows are read from on the hot read paths (a message
 * page, the thread's streaming messages).
 *
 * Once the request admitted the thread, the row-level policy passes every row
 * of it, so evaluating it only costs. `readerForAdmittedThread` reads past the
 * policy, keyed on this thread only. (It was written when `rls()` also dropped
 * the legacy builder's SQL LIMIT, so a page read the whole thread; that is
 * fixed since `@lunora/server@alpha.145`, anolilab/lunora#822.) A thread nobody admitted
 * keeps the guarded `ctx.db`, which then finds only what the policy allows.
 */
import type { QueryCtx } from "../_generated/server";
import { readerForAdmittedThread, scopeOf } from "../lib/rls/scope";

export const admittedThreadDb = (context: { db: QueryCtx["db"] }, threadId: string): QueryCtx["db"] => {
    const scope = scopeOf(context);

    if (!scope || !(scope.admin || scope.threads.levels.has(threadId))) {
        return context.db;
    }

    // Callers reach only `query(table).withIndex(<threadId-first index>, <range
    // on this thread>)`, which is all the admitted reader serves (it throws on
    // anything else).
    return readerForAdmittedThread(context, threadId) as unknown as QueryCtx["db"];
};
