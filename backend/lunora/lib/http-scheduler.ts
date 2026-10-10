/**
 * `ctx.scheduler` for an HTTP action.
 *
 * "Receive webhook, enqueue the real work, return 200 immediately" is the single
 * most common thing an HTTP action does — 12 call sites here, across
 * `chat/http.ts`, `messenger/webhooks.ts` and `triggers/http.ts`, every one of them
 * `runAfter(0, …)`.
 *
 * This used to be `lib/dispatch.ts`, a much larger workaround: Lunora's
 * `HttpActionCtx` carried no `scheduler` at all, so the work had to hop through
 * an internal mutation, and because a function *reference* cannot cross an RPC
 * boundary the target was named by a string key resolved against a closed
 * allow-list. The allow-list was load-bearing — these endpoints are
 * unauthenticated, and a free-form target string would have turned any of them
 * into a "call any internal function" primitive.
 *
 * `HttpActionCtx` gained `scheduler` (and `storage`, `waitUntil`, `forShard`) in
 * `@lunora/server@1.0.0-alpha.104`, so all of that is gone: the reference is
 * resolved in our own source at compile time, nothing is selected by a string,
 * and the mutation round trip per webhook goes away with it.
 *
 * What remains is that `scheduler` is *optional* on the type — it exists only
 * when the app declared `.scheduler(...)` on the generated app builder, which
 * `src/server.ts` does. Asserting that once here beats repeating a null check at
 * twelve call sites, and it fails loudly if the capability is ever dropped
 * instead of silently not scheduling.
 */
import type { HttpActionCtx } from "lunorash/server";
import { LunoraError } from "lunorash/server";

/** The scheduler this app declares, or a loud failure if the capability went away. */
export const httpScheduler = (context: HttpActionCtx): NonNullable<HttpActionCtx["scheduler"]> => {
    if (!context.scheduler) {
        throw new LunoraError(
            "INTERNAL_SERVER_ERROR",
            "This worker has no scheduler binding; `.scheduler(...)` is missing from the app builder in src/server.ts",
        );
    }

    return context.scheduler;
};
