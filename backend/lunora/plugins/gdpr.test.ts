import { describe, expect, it } from "vitest";

import { GLOBAL_USER_COLUMNS } from "../lib/account-merge";
import { erasePluginsForUser } from "./gdpr";

const USER = "user-a";
const OTHER = "user-b";

interface Row {
    _id: string;
    userId: string;
}

/** A fake of the two `.global()` readers. Only `findMany` exists, as on the D1 backend, and it honours `limit`. */
const fakeCtx = (tables: { pluginInstalls: Row[]; pluginItems: Row[] }) => {
    const deleted: string[] = [];
    let statements = 0;

    const reader = (rows: Row[]) => {
        return {
            findMany: async ({ limit, where }: { limit: number; where: { userId: string } }) => {
                await Promise.resolve();
                statements += 1;

                return { page: rows.filter((row) => row.userId === where.userId).slice(0, limit) };
            },
        };
    };
    const db = {
        delete: async (table: string, id: string) => {
            await Promise.resolve();
            statements += 1;
            deleted.push(`${table}:${id}`);

            const rows = table === "pluginItems" ? tables.pluginItems : tables.pluginInstalls;

            rows.splice(
                rows.findIndex((row) => row._id === id),
                1,
            );
        },
        pluginInstalls: reader(tables.pluginInstalls),
        pluginItems: reader(tables.pluginItems),
    };

    return { ctx: { db } as never, deleted, statements: () => statements };
};

const rows = (prefix: string, userId: string, count: number): Row[] =>
    Array.from({ length: count }, (_, index) => {
        return { _id: `${prefix}-${String(index)}`, userId };
    });

describe("erasePluginsForUser", () => {
    it("erases the person's links and installs, and no other person's rows", async () => {
        const { ctx, deleted } = fakeCtx({
            pluginInstalls: [...rows("install", USER, 2), ...rows("other-install", OTHER, 1)],
            pluginItems: [...rows("item", USER, 3), ...rows("other-item", OTHER, 2)],
        });

        expect(await erasePluginsForUser(ctx, USER)).toEqual({ hasMore: false });
        expect(deleted.toSorted((a, b) => a.localeCompare(b))).toEqual([
            "pluginInstalls:install-0",
            "pluginInstalls:install-1",
            "pluginItems:item-0",
            "pluginItems:item-1",
            "pluginItems:item-2",
        ]);
    });

    it("takes several bounded calls for a large account, and leaves other people's rows alone", async () => {
        const { ctx, deleted, statements } = fakeCtx({
            pluginInstalls: [...rows("install", USER, 45), ...rows("other-install", OTHER, 1)],
            pluginItems: [...rows("item", USER, 130), ...rows("other-item", OTHER, 2)],
        });
        let calls = 0;
        let mostStatements = 0;

        for (;;) {
            const before = statements();
            const { hasMore } = await erasePluginsForUser(ctx, USER);

            calls += 1;
            mostStatements = Math.max(mostStatements, statements() - before);

            if (!hasMore) {
                break;
            }
        }

        expect(calls).toBeGreaterThan(1);
        expect(mostStatements).toBeLessThan(50);
        expect(deleted.filter((entry) => entry.startsWith("pluginItems:"))).toHaveLength(130);
        expect(deleted.filter((entry) => entry.startsWith("pluginInstalls:"))).toHaveLength(45);
        expect(deleted.some((entry) => entry.includes("other-"))).toBe(false);
    });
});

describe("account merge lists the plugin tables", () => {
    it("moves both plugin tables by their user column", () => {
        // The installs move in the merge's own step (`mergePluginInstallsPage`), so a plugin both accounts have is not installed twice.
        expect(GLOBAL_USER_COLUMNS.pluginInstalls).toEqual([]);
        expect(GLOBAL_USER_COLUMNS.pluginItems).toEqual(["userId"]);
    });
});
