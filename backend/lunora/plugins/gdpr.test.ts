import { describe, expect, it } from "vitest";

import { GLOBAL_USER_COLUMNS } from "../lib/account-merge";
import { erasePluginsForUser } from "./gdpr";

const USER = "user-a";
const OTHER = "user-b";

interface Row {
    _id: string;
    userId: string;
}

/** A fake of the two `.global()` readers. Only `findMany` exists, as on the D1 backend. */
const fakeCtx = (tables: { pluginInstalls: Row[]; pluginItems: Row[] }) => {
    const deleted: string[] = [];

    const reader = (rows: Row[]) => ({
        findMany: async ({ where }: { where: { userId: string } }) => ({
            page: rows.filter((row) => row.userId === where.userId),
        }),
    });

    const db = {
        delete: async (table: string, id: string) => {
            deleted.push(`${table}:${id}`);
        },
        pluginInstalls: reader(tables.pluginInstalls),
        pluginItems: reader(tables.pluginItems),
    };

    return { ctx: { db } as never, deleted };
};

const rows = (prefix: string, userId: string, count: number): Row[] =>
    Array.from({ length: count }, (_, index) => ({ _id: `${prefix}-${String(index)}`, userId }));

describe("erasePluginsForUser", () => {
    it("erases the person's links and installs, and no other person's rows", async () => {
        const { ctx, deleted } = fakeCtx({
            pluginInstalls: [...rows("install", USER, 2), ...rows("install", OTHER, 1)],
            pluginItems: [...rows("item", USER, 3), ...rows("item", OTHER, 2)],
        });

        await erasePluginsForUser(ctx, USER);

        expect(deleted.sort()).toEqual([
            "pluginInstalls:install-0",
            "pluginInstalls:install-1",
            "pluginItems:item-0",
            "pluginItems:item-1",
            "pluginItems:item-2",
        ]);
    });
});

describe("account merge lists the plugin tables", () => {
    it("moves both plugin tables by their user column", () => {
        expect(GLOBAL_USER_COLUMNS.pluginInstalls).toEqual(["userId"]);
        expect(GLOBAL_USER_COLUMNS.pluginItems).toEqual(["userId"]);
    });
});
