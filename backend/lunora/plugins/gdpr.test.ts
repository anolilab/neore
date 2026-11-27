import { describe, expect, it } from "vitest";

import { GLOBAL_USER_COLUMNS } from "../lib/account-merge";
import { collectPluginsForExport, erasePluginsForUser } from "./gdpr";

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
            findMany: async ({ consistency, limit, where }: { consistency?: string; limit: number; where: { userId: string } }) => {
                // A replica that lags shows nothing: only a primary read sees the rows.
                if (consistency !== "primary") {
                    return { page: [] };
                }

                await Promise.resolve();
                statements += 1;

                return { page: rows.filter((row) => row.userId === where.userId).slice(0, limit) };
            },
        };
    };
    const db = {
        delete: async (table: string, id: string) => {
            await Promise.resolve();
            // A `.global()` delete reads its row, then deletes it: two D1 statements.
            statements += 2;
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
        expect(mostStatements).toBeLessThanOrEqual(42);
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

describe("collectPluginsForExport", () => {
    it("returns the installs with the first page only, then pages of links, without content hashes and other people's rows", async () => {
        const install = { _id: "i1", contentHash: "h", installedAt: 1, pluginSlug: "brief", status: "installed", updatedAt: 2, userId: USER, version: "1.0.0" };
        const item = (id: string, userId: string) => {
            return { _id: id, contentHash: "h", createdAt: 3, entryKey: `skill:${id}`, installId: "i1", kind: "skill", state: "created", userId };
        };
        const links = [...Array.from({ length: 250 }, (_, index) => item(`a${String(index)}`, USER)), item("b0", OTHER)];
        const ctx = {
            db: {
                pluginInstalls: {
                    findMany: async () => {
                        await Promise.resolve();

                        return { isDone: true, page: [install, { ...install, _id: "i2", userId: OTHER }].filter((row) => row.userId === USER) };
                    },
                },
                pluginItems: {
                    findMany: async ({ cursor, limit, where }: { cursor: string | null; limit: number; where: { userId: string } }) => {
                        await Promise.resolve();

                        const mine = links.filter((row) => row.userId === where.userId);
                        const start = cursor === null ? 0 : Number(cursor);

                        return { continueCursor: String(start + limit), isDone: start + limit >= mine.length, page: mine.slice(start, start + limit) };
                    },
                },
            },
        };
        const { handler } = collectPluginsForExport as unknown as {
            handler: (c: unknown, a: unknown) => Promise<{ continueCursor?: string; installs: object[]; items: object[] }>;
        };
        const first = await handler(ctx, { userId: USER });
        const second = await handler(ctx, { cursor: first.continueCursor, userId: USER });
        const third = await handler(ctx, { cursor: second.continueCursor, userId: USER });

        expect(first.installs).toEqual([{ id: "i1", installedAt: 1, pluginSlug: "brief", status: "installed", updatedAt: 2, version: "1.0.0" }]);
        expect([first.items.length, second.items.length, third.items.length]).toEqual([100, 100, 50]);
        expect(second.installs).toEqual([]);
        expect(third.continueCursor).toBeUndefined();
        expect(first.items[0]).toEqual({ createdAt: 3, entryKey: "skill:a0", installId: "i1", kind: "skill", state: "created" });
    });
});
