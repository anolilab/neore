import { describe, expect, it } from "vitest";

import { SWEEP_CALL_BUDGET, SWEEP_ROUTES_PER_ACTION, sweepRoutePage, type SweptRoute } from "./owner-sweep";

/** The budget one action has for its sweep: the page read takes one call of the action's budget. */
const SWEEP_BUDGET = SWEEP_CALL_BUDGET - 1;

const noMoreBatches = async () => {
    return { hasMore: false };
};

const noopFence = async () => {};

describe("one owner-sweep action", () => {
    it("keeps a full page within its call budget, counting the page read", async () => {
        // Every route has its own owner: each costs one fence and one erase batch, and the page read is one more call.
        const routes: SweptRoute[] = Array.from({ length: SWEEP_ROUTES_PER_ACTION }, (_, index) => {
            return { ownerId: `owner-${String(index)}`, threadId: `t-${String(index)}` };
        });

        const { owners, shardCalls, unfinished } = await sweepRoutePage(routes, { eraseBatch: noMoreBatches, fence: noopFence }, { budget: SWEEP_BUDGET });

        expect(unfinished).toBeNull();
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

        const { owners } = await sweepRoutePage(
            routes,
            {
                eraseBatch: async (route) => {
                    calls.push(`erase ${route.threadId}`);

                    return { hasMore: false };
                },
                fence: async (ownerId) => {
                    calls.push(`fence ${ownerId}`);
                },
            },
            { budget: SWEEP_BUDGET },
        );

        expect(owners).toStrictEqual(["owner-a", "owner-b"]);
        expect(calls).toStrictEqual(["fence owner-a", "erase t-1", "erase t-2", "fence owner-b", "erase t-3"]);
    });

    it("repeats a route's erase batch until none is left, and counts every batch", async () => {
        let batches = 0;

        const { shardCalls, unfinished } = await sweepRoutePage(
            [{ ownerId: "owner-a", threadId: "t-1" }],
            {
                eraseBatch: async () => {
                    batches += 1;

                    return { hasMore: batches < 3 };
                },
                fence: noopFence,
            },
            { budget: SWEEP_BUDGET },
        );

        expect(batches).toBe(3);
        expect(shardCalls).toBe(4);
        expect(unfinished).toBeNull();
    });

    it("stops before a route that does not fit, and names it as the route to resume from", async () => {
        const routes: SweptRoute[] = [
            { ownerId: "owner-a", threadId: "t-1" },
            { ownerId: "owner-b", threadId: "t-2" },
            { ownerId: "owner-c", threadId: "t-3" },
        ];

        // Each route costs a fence and an erase: two fit in the budget of five, the third does not.
        const { owners, shardCalls, unfinished } = await sweepRoutePage(routes, { eraseBatch: noMoreBatches, fence: noopFence }, { budget: 5 });

        expect(shardCalls).toBe(4);
        expect(owners).toStrictEqual(["owner-a", "owner-b"]);
        expect(unfinished).toStrictEqual({ ownerId: "owner-c", threadId: "t-3" });
    });

    it("stops between the batches of a route that needs many, keeping its owner fenced", async () => {
        let batches = 0;

        // The fence takes one call; each batch takes one more. The budget of four lets three batches through.
        const { owners, shardCalls, unfinished } = await sweepRoutePage(
            [{ ownerId: "owner-a", threadId: "t-1" }],
            {
                eraseBatch: async () => {
                    batches += 1;

                    return { hasMore: true };
                },
                fence: noopFence,
            },
            { budget: 4 },
        );

        expect(batches).toBe(3);
        expect(shardCalls).toBe(4);
        expect(owners).toStrictEqual(["owner-a"]);
        expect(unfinished).toStrictEqual({ ownerId: "owner-a", threadId: "t-1" });
    });

    it("makes progress on a route that needs many batches, even at the smallest budget", async () => {
        let batches = 0;

        // A budget of two lets the fence and one batch through: each action leaves the route with one batch fewer to go.
        const { shardCalls, unfinished } = await sweepRoutePage(
            [{ ownerId: "owner-a", threadId: "t-1" }],
            {
                eraseBatch: async () => {
                    batches += 1;

                    return { hasMore: true };
                },
                fence: noopFence,
            },
            { budget: 2 },
        );

        expect(batches).toBe(1);
        expect(shardCalls).toBe(2);
        expect(unfinished).not.toBeNull();
    });

    it("starts from the route it is given, and sweeps the routes from there on", async () => {
        const erased: string[] = [];
        const routes: SweptRoute[] = [
            { ownerId: "owner-a", threadId: "t-1" },
            { ownerId: "owner-b", threadId: "t-2" },
            { ownerId: "owner-c", threadId: "t-3" },
        ];

        await sweepRoutePage(
            routes,
            {
                eraseBatch: async (route) => {
                    erased.push(route.threadId);

                    return { hasMore: false };
                },
                fence: noopFence,
            },
            { budget: SWEEP_BUDGET, start: 1 },
        );

        expect(erased).toStrictEqual(["t-2", "t-3"]);
    });
});
