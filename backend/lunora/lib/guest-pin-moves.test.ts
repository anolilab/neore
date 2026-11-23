/**
 * A guest's pins move to the account that converted, around the row merge (`lib/account-merge.ts#moveGuestPins`). Two interleavings are
 * replayed here, with the account-move marker already set (the merge sets it before the first pass):
 *
 * - the owner's parallel merge moves the pin and re-points the route after the guest's first pass has read the route: the second pass
 *   must reach the pin;
 * - a guest pin write lands during that route read: the marker refuses it, so no new pin of the guest's is left on the owner shard.
 *
 * The fake models the marker's refusal itself. The real check is covered by `account-moves.test.ts` and `chat/pins/functions.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { type GuestPinMoves, moveGuestPins, movePinsOnRoutesOf } from "./account-merge";

type Pin = { id: string; shard: string; threadId: string; userId: string };
type Route = { ownerId: string; threadId: string; userId: string };
type State = { converted: boolean; marked: boolean; pins: Pin[]; routes: Route[] };

/** A guest pin write as `createPin` makes it: refused once the account is marked, otherwise a new pin on the owner shard. */
const guestPinWrite = (state: State, id: string): "refused" | "written" => {
    if (state.marked) {
        return "refused";
    }

    state.pins.push({ id, shard: "owner-a", threadId: "t1", userId: "guest" });

    return "written";
};

/** The fake merge's moves. `duringRead` runs after the guest's route read, which is where a concurrent write lands. */
const build = (duringRead?: (write: (id: string) => "refused" | "written") => void) => {
    const state: State = {
        converted: false,
        // The merge marks the guest before its first pass reads the routes.
        marked: true,
        pins: [{ id: "pin-1", shard: "owner-a", threadId: "t1", userId: "guest" }],
        routes: [{ ownerId: "owner-a", threadId: "t1", userId: "guest" }],
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
                .map((route) => {
                    return { ownerId: route.ownerId, threadId: route.threadId };
                });

            if (routeUserId === "guest") {
                duringRead?.((id) => guestPinWrite(state, id));

                if (!state.converted) {
                    ownerConverts();
                }
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
        expect(state.pins).toStrictEqual([{ id: "pin-1", shard: "owner-b", threadId: "t1", userId: "new" }]);
    });

    it("leaves the pin with the guest when the second pass is skipped, so the test depends on that pass", async () => {
        const { moves, state } = build();

        await movePinsOnRoutesOf(moves, "guest");
        await moves.mergeRows();

        expect(state.pins).toStrictEqual([{ id: "pin-1", shard: "owner-b", threadId: "t1", userId: "guest" }]);
    });

    it("refuses a guest pin write that lands during the route read, so none of the guest's pins is left on the owner shard", async () => {
        const outcomes: string[] = [];
        const { moves, state } = build((write) => {
            outcomes.push(write("pin-late"));
        });

        await moveGuestPins(moves, "guest", "new");

        expect(outcomes).toStrictEqual(["refused"]);
        expect(state.pins.map((pin) => pin.id)).toStrictEqual(["pin-1"]);
        expect(state.pins.every((pin) => pin.userId === "new")).toBe(true);
    });
});
