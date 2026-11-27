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

/**
 * Elapsed time after which a durable step stops and returns its cursor, well under the workflow's default step timeout. A step with
 * slow shard calls then ends early, and the next step carries on from the cursor it stopped at.
 */
export const SWEEP_STEP_MS = 3 * 60_000;

export type SweptRoute = { ownerId: string; threadId: string };

export type SweepCalls = {
    /** One erase batch of this route's pins on its owner's shard. Its `hasMore` asks for another batch on the same route. */
    eraseBatch: (route: SweptRoute) => Promise<{ hasMore: boolean }>;
    /** Fences the owner's shard for this account. Called once per owner per action, before that owner's first erase. */
    fence: (ownerId: string) => Promise<void>;
};

/** Where a sweep action stopped inside a page: the route it has not finished, which the next action resumes from. */
export type SweepResume = { ownerId: string; threadId: string };

/**
 * Sweeps the routes of one page from `start`, within `budget` shard calls. A route starts only if its fence and one erase batch both fit,
 * and a route with more batches stops between batches once the next would not fit. Returns the distinct owners it fenced, the calls it
 * made, and the route it stopped at (`unfinished`, null when the page is done). Each erase deletes pins, so a stopped route always
 * leaves progress behind for the next action.
 */
export const sweepRoutePage = async (
    routes: ReadonlyArray<SweptRoute>,
    calls: SweepCalls,
    { budget, start = 0 }: { budget: number; start?: number },
): Promise<{ owners: string[]; shardCalls: number; unfinished: SweptRoute | null }> => {
    const fenced = new Set<string>();
    let shardCalls = 0;

    for (const route of routes.slice(start)) {
        const fenceCost = fenced.has(route.ownerId) ? 0 : 1;

        if (shardCalls + fenceCost + 1 > budget) {
            return { owners: [...fenced], shardCalls, unfinished: route };
        }

        if (fenceCost === 1) {
            fenced.add(route.ownerId);
            await calls.fence(route.ownerId);
            shardCalls += 1;
        }

        let more = true;

        while (more) {
            if (shardCalls + 1 > budget) {
                return { owners: [...fenced], shardCalls, unfinished: route };
            }

            const batch = await calls.eraseBatch(route);

            shardCalls += 1;
            more = batch.hasMore;
        }
    }

    return { owners: [...fenced], shardCalls, unfinished: null };
};
