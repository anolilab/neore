/**
 * A guest's pins move to the account that converted, around the row merge (`lib/account-merge.ts#moveGuestPins`). The owner of the
 * thread may merge its own account in parallel: its shard moves the guest's pin and re-points the route after the guest's first pass
 * has read the route. The replay below interleaves exactly that, and checks that the second pass reaches the pin.
 */
import { describe, expect, it } from "vitest";

import { type GuestPinMoves, moveGuestPins, movePinsOnRoutesOf } from "./account-merge";

type Pin = { shard: string; threadId: string; userId: string };
type Route = { ownerId: string; threadId: string; userId: string };

const build = () => {
    const state = {
        // The owner's conversion has not happened yet.
        converted: false,
        pins: [{ shard: "owner-a", threadId: "t1", userId: "guest" }] as Pin[],
        routes: [{ ownerId: "owner-a", threadId: "t1", userId: "guest" }] as Route[],
    };

    // The owner's merge: after the guest's pass read the route, its shard moves the pin and the route follows to the new owner.
    const ownerConverts = () => {
        state.converted = true;

        for (const pin of state.pins) {
            if (pin.shard === "owner-a") {
                pin.shard = "owner-b";
            }
        }

        for (const route of state.routes) {
            if (route.ownerId === "owner-a") {
                route.ownerId = "owner-b";
            }
        }
    };

    const moves: GuestPinMoves = {
        listRoutes: async (routeUserId) => {
            // The snapshot is taken first: the owner converts after the read, which is the interleaving under test.
            const page = state.routes
                .filter((route) => route.userId === routeUserId)
                .map(({ ownerId, threadId }) => {
                    return { ownerId, threadId };
                });

            if (routeUserId === "guest" && !state.converted) {
                ownerConverts();
            }

            return { continueCursor: null, isDone: true, page };
        },
        mergeRows: async () => {
            // The row merge re-points the guest's routes to the account that converted.
            for (const route of state.routes) {
                if (route.userId === "guest") {
                    route.userId = "new";
                }
            }

            return { moved: 1 };
        },
        moveBatch: async (route) => {
            // Moves the guest's pins on this thread from the route's owner shard, as `reassignUserPinsOnThread` does.
            for (const pin of state.pins) {
                if (pin.shard === route.ownerId && pin.threadId === route.threadId && pin.userId === "guest") {
                    pin.userId = "new";
                }
            }

            return { hasMore: false };
        },
    };

    return { moves, state };
};

describe("moving a guest's pins around the row merge", () => {
    it("reaches a pin that a parallel owner merge moved between the first pass's route read and its reassignment", async () => {
        const { moves, state } = build();

        const result = await moveGuestPins(moves, "guest", "new");

        expect(result).toStrictEqual({ moved: 1 });
        expect(state.pins).toStrictEqual([{ shard: "owner-b", threadId: "t1", userId: "new" }]);
    });

    it("leaves the pin with the guest when the second pass is skipped, so the test depends on that pass", async () => {
        const { moves, state } = build();

        await movePinsOnRoutesOf(moves, "guest");
        await moves.mergeRows();

        expect(state.pins).toStrictEqual([{ shard: "owner-b", threadId: "t1", userId: "guest" }]);
    });
});
