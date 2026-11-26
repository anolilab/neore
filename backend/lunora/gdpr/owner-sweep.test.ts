import { describe, expect, it } from "vitest";

import { SWEEP_CALL_BUDGET, SWEEP_ROUTES_PER_ACTION, sweepRoutePage, type SweptRoute } from "./owner-sweep";

const noMoreBatches = async () => {
    return { hasMore: false };
};

describe("one owner-sweep action", () => {
    it("keeps a full page within its call budget, counting the page read", async () => {
        // Every route has its own owner: each costs one fence and one erase batch, and the page read is one more call.
        const routes: SweptRoute[] = Array.from({ length: SWEEP_ROUTES_PER_ACTION }, (_, index) => {
            return { ownerId: `owner-${String(index)}`, threadId: `t-${String(index)}` };
        });

        const { owners, shardCalls } = await sweepRoutePage(routes, { eraseBatch: noMoreBatches, fence: async () => {} });

        expect(owners).toHaveLength(SWEEP_ROUTES_PER_ACTION);
        expect(shardCalls + 1).toBeLessThanOrEqual(SWEEP_CALL_BUDGET);
    });

    it("leaves room in the budget for a route that needs more than one erase batch", () => {
        expect(1 + 2 * SWEEP_ROUTES_PER_ACTION).toBeLessThan(SWEEP_CALL_BUDGET);
    });

    it("fences each owner once, before that owner's first erase", async () => {
        const calls: string[] = [];
        const routes: SweptRoute[] = [
            { ownerId: "owner-a", threadId: "t-1" },
            { ownerId: "owner-a", threadId: "t-2" },
            { ownerId: "owner-b", threadId: "t-3" },
        ];

        const { owners } = await sweepRoutePage(routes, {
            eraseBatch: async (route) => {
                calls.push(`erase ${route.threadId}`);

                return { hasMore: false };
            },
            fence: async (ownerId) => {
                calls.push(`fence ${ownerId}`);
            },
        });

        expect(owners).toStrictEqual(["owner-a", "owner-b"]);
        expect(calls).toStrictEqual(["fence owner-a", "erase t-1", "erase t-2", "fence owner-b", "erase t-3"]);
    });

    it("repeats a route's erase batch until none is left, and counts every batch", async () => {
        let batches = 0;

        const { shardCalls } = await sweepRoutePage([{ ownerId: "owner-a", threadId: "t-1" }], {
            eraseBatch: async () => {
                batches += 1;

                return { hasMore: batches < 3 };
            },
            fence: async () => {},
        });

        expect(batches).toBe(3);
        expect(shardCalls).toBe(4);
    });
});
