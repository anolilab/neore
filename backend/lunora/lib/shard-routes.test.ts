import { describe, expect, it, vi } from "vitest";

import { deleteShardRoute, shardRouteKey } from "./shard-routes";

/** A route the replica has not seen yet: only a primary read finds it. */
const lagging = () => {
    const route = { _id: "route-1", key: shardRouteKey("merged-guest", "guest"), ownerId: "user" };
    const deleted: string[] = [];
    const db = {
        delete: vi.fn(async (_table: string, id: string) => {
            deleted.push(id);
        }),
        shardRoutes: {
            findMany: vi.fn(async ({ consistency, where }: { consistency?: string; where: { key: string } }) => {
                return { page: consistency === "primary" && where.key === route.key ? [route] : [] };
            }),
        },
    };

    return { db, deleted };
};

describe(deleteShardRoute, () => {
    it("deletes a route a replica does not show yet", async () => {
        expect.assertions(1);

        const { db, deleted } = lagging();

        await deleteShardRoute({ db } as never, "merged-guest", "guest");

        expect(deleted).toStrictEqual(["route-1"]);
    });
});
