/**
 * One owner-shard sweep action of an account erasure: a bounded page of the account's shared-pin routes, each owner fenced once
 * before its first erase, and each route's pins erased on its owner's shard. Pure, so the shard calls are injected and counted.
 */

/**
 * Shard calls one action may make: the Free-plan Worker allows 50 subrequests per invocation, and this keeps headroom under it
 * (the same budget `admin/shard-footprint-logic.ts` uses for its own actions).
 */
export const SWEEP_CALL_BUDGET = 40;

/**
 * Routes per action. A page costs one read, then at most two shard calls per route (its owner's fence and one erase batch), so
 * 15 routes cost at most 31 calls. The rest of the budget covers a route whose pins need more than one erase batch.
 */
export const SWEEP_ROUTES_PER_ACTION = 15;

/** Routes per durable step. Each step's owner list is bounded by this, so no step result grows with the account. */
export const SWEEP_ROUTES_PER_STEP = 1000;

export type SweptRoute = { ownerId: string; threadId: string };

export type SweepCalls = {
    /** One erase batch of this route's pins on its owner's shard. Its `hasMore` asks for another batch on the same route. */
    eraseBatch: (route: SweptRoute) => Promise<{ hasMore: boolean }>;
    /** Fences the owner's shard for this account. Called once per owner per action, before that owner's first erase. */
    fence: (ownerId: string) => Promise<void>;
};

/**
 * Sweeps one page of routes. Returns the distinct owners it fenced and the number of shard calls made, so the caller can check
 * the page against `SWEEP_CALL_BUDGET`. Every route is swept in full; a page is never cut short, so the caller's cursor is always
 * a page boundary and a resume needs no state from inside a page.
 */
export const sweepRoutePage = async (routes: ReadonlyArray<SweptRoute>, calls: SweepCalls): Promise<{ owners: string[]; shardCalls: number }> => {
    const fenced = new Set<string>();
    let shardCalls = 0;

    for (const route of routes) {
        if (!fenced.has(route.ownerId)) {
            fenced.add(route.ownerId);
            await calls.fence(route.ownerId);
            shardCalls += 1;
        }

        let more = true;

        while (more) {
            const batch = await calls.eraseBatch(route);

            more = batch.hasMore;
            shardCalls += 1;
        }
    }

    return { owners: [...fenced], shardCalls };
};
