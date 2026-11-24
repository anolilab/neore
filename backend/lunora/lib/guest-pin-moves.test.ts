/**
 * A guest's pins move to the account that converted, in the merge's `pins` step and again in its `repins` pass over the new account's
 * routes (`lib/account-merge.ts#mergeGuestInto`). Two interleavings are replayed here, with the account-move marker set by the run's
 * start (`beginMergeRun`), before the pins step reads a route:
 *
 * - the owner's parallel merge moves the pin and re-points the route after the guest's pins step has read the route: the second pass
 *   must reach the pin;
 * - a guest pin write lands during that route read: the marker refuses it, so no new pin of the guest's is left on the owner shard.
 *
 * The fake models the marker's refusal itself. The real check is covered by `account-moves.test.ts` and `chat/pins/functions.test.ts`.
 */
import { describe, expect, it } from "vitest";

import type { MergeProgress, MergeReferences, ShardCall } from "./account-merge";
import { mergeGuestInto } from "./account-merge";

type Pin = { id: string; shard: string; threadId: string; userId: string };
type Route = { ownerId: string; threadId: string; userId: string };
type State = { converted: boolean; marked: boolean; pins: Pin[]; routes: Route[] };

const reference = (name: string) => {
    return { __lunoraRef: `test:${name}` };
};

const REFERENCES: MergeReferences = {
    acquireLease: reference("acquireMergeLease"),
    beginRun: reference("beginMergeRun"),
    deleteGuest: reference("deleteMergedGuest"),
    deleteRows: reference("deleteShardRows"),
    dropMarkers: reference("dropImportMarkersPage"),
    importRows: reference("importShardRows"),
    list: reference("listShardRowsPage"),
    listClear: reference("listShardRowsToClear"),
    listPinRoutes: reference("listSharedPinRoutesForExport"),
    movePinRoute: reference("moveSharedPinRouteOf"),
    nextPinRoute: reference("nextSharedPinRoute"),
    noteGeneration: reference("noteMergeGeneration"),
    reassignFollows: reference("reassignThreadFollowsPage"),
    reassignGlobal: reference("reassignGlobalRows"),
    reassignPins: reference("reassignUserPinsOnThread"),
    releaseLease: reference("releaseMergeLease"),
};

/** A guest pin write as `createPin` makes it: refused once the account is marked, otherwise a new pin on the owner shard. */
const guestPinWrite = (state: State, id: string): "refused" | "written" => {
    if (state.marked) {
        return "refused";
    }

    state.pins.push({ id, shard: "owner-a", threadId: "t1", userId: "guest" });

    return "written";
};

/**
 * The fake merge's shards, with no rows to copy. `duringRead` runs after the pins step's route read, which is where a concurrent write
 * lands; `skipRepins` answers the second pass with no routes, so a test can show it is that pass which reaches the pin.
 */
const build = ({ duringRead, skipRepins = false }: { duringRead?: (write: (id: string) => "refused" | "written") => void; skipRepins?: boolean } = {}) => {
    const state: State = {
        converted: false,
        marked: false,
        pins: [{ id: "pin-1", shard: "owner-a", threadId: "t1", userId: "guest" }],
        routes: [{ ownerId: "owner-a", threadId: "t1", userId: "guest" }],
    };

    // The owner's merge: after the guest's pins step read the route, its shard moves the pin and the route follows to the new owner.
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

    const call: ShardCall = async (target, args, shardKey) => {
        const name = target.__lunoraRef.split(":", 2)[1];

        switch (name) {
            case "acquireMergeLease": {
                return { generation: 1 } as never;
            }
            case "beginMergeRun": {
                // The run marks the guest before any of its steps read a route.
                state.marked = true;

                return { finished: false, pinWritesUntil: null, stopped: false } as never;
            }
            case "deleteMergedGuest": {
                return (state.routes.some((route) => route.userId === args.userId) ? { deleted: false, pinsRemain: true } : { deleted: true }) as never;
            }
            case "dropImportMarkersPage": {
                state.marked = false;

                return { fenced: false, hasMore: false } as never;
            }
            case "listShardRowsPage": {
                return { continueCursor: null, isDone: true, page: [] } as never;
            }
            case "listShardRowsToClear": {
                return { digests: [], rows: [] } as never;
            }
            case "listSharedPinRoutesForExport": {
                const page = skipRepins
                    ? []
                    : state.routes
                          .filter((route) => route.userId === args.userId)
                          .map((route) => {
                              return { ownerId: route.ownerId, threadId: route.threadId };
                          });

                return { continueCursor: null, isDone: true, page } as never;
            }
            case "moveSharedPinRouteOf": {
                for (const route of state.routes) {
                    if (route.userId === args.from && route.threadId === args.threadId) {
                        route.userId = args.to as string;
                    }
                }

                return null as never;
            }
            case "nextSharedPinRoute": {
                // The snapshot is taken first: the owner converts after the read, which is the interleaving under test.
                const route = state.routes.find((each) => each.userId === args.from);

                if (route === undefined) {
                    return null as never;
                }

                const snapshot = { ownerId: route.ownerId, threadId: route.threadId };

                duringRead?.((id) => guestPinWrite(state, id));

                if (!state.converted) {
                    ownerConverts();
                }

                return snapshot as never;
            }
            case "noteMergeGeneration": {
                return { current: true } as never;
            }
            case "reassignGlobalRows": {
                return { done: true, reassigned: 0 } as never;
            }
            case "reassignThreadFollowsPage": {
                return { hasMore: false, moved: 0 } as never;
            }
            case "reassignUserPinsOnThread": {
                // Moves the guest's pins on this thread on the shard called, as the real procedure does on the owner's shard.
                for (const pin of state.pins) {
                    if (pin.shard === shardKey && pin.threadId === args.threadId && pin.userId === args.from) {
                        pin.userId = args.to as string;
                    }
                }

                return { hasMore: false } as never;
            }
            case "releaseMergeLease": {
                return null as never;
            }
            default: {
                throw new Error(`unexpected ${String(name)}`);
            }
        }
    };

    return { call, state };
};

const mergeToEnd = async (call: ShardCall): Promise<void> => {
    let resume: MergeProgress | undefined;

    for (;;) {
        const { next } = await mergeGuestInto(call, REFERENCES, "guest", "new", resume === undefined ? {} : { resume });

        if (next === null) {
            return;
        }

        resume = next;
    }
};

describe("moving a guest's pins around the row merge", () => {
    it("reaches a pin that a parallel owner merge moved between the pins step's route read and its reassignment", async () => {
        const { call, state } = build();

        await mergeToEnd(call);

        expect(state.pins).toStrictEqual([{ id: "pin-1", shard: "owner-b", threadId: "t1", userId: "new" }]);
        expect(state.routes).toStrictEqual([{ ownerId: "owner-b", threadId: "t1", userId: "new" }]);
    });

    it("leaves the pin with the guest when the second pass finds nothing, so the test depends on that pass", async () => {
        const { call, state } = build({ skipRepins: true });

        await mergeToEnd(call);

        expect(state.pins).toStrictEqual([{ id: "pin-1", shard: "owner-b", threadId: "t1", userId: "guest" }]);
    });

    it("refuses a guest pin write that lands during the route read, so none of the guest's pins is left on the owner shard", async () => {
        const outcomes: string[] = [];
        const { call, state } = build({
            duringRead: (write) => {
                outcomes.push(write("pin-late"));
            },
        });

        await mergeToEnd(call);

        expect(outcomes).toStrictEqual(["refused"]);
        expect(state.pins.map((pin) => pin.id)).toStrictEqual(["pin-1"]);
        expect(state.pins.every((pin) => pin.userId === "new")).toBe(true);
    });
});
