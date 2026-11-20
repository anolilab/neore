/**
 * `botOwners` is a D1 table that may be read from a replica. A row written moments ago is on the primary only, so the
 * tombstone on delete and the erasure must read the primary, or they miss it.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { eraseBotsForUser } from "./gdpr";
import { BOT_OWNER_TOMBSTONE_TTL_MS, markBotOwnerDeleted, pruneBotOwnerTombstonesOf, restoreLiveBotOwnersOf } from "./owner";

vi.mock("../sandbox/functions", () => {
    return { retireBotComputersIn: vi.fn() };
});

const FRESH_ROW = { _id: "owner-row", botId: "bot-1", createdAt: 1, ownerId: "user-1" };

/** A database whose replica has not seen the fresh `botOwners` row yet: only a primary read finds it. */
const laggingDb = () => {
    const patch = vi.fn();
    const remove = vi.fn();
    const db = {
        botOwners: {
            findFirst: vi.fn(async (options: { consistency?: string }) => (options.consistency === "primary" ? FRESH_ROW : null)),
            findMany: vi.fn(async (options: { consistency?: string }) => {
                return { page: options.consistency === "primary" ? [FRESH_ROW] : [] };
            }),
        },
        delete: remove,
        patch,
        query: () => {
            return {
                withIndex: () => {
                    return { take: async () => [] };
                },
            };
        },
    };

    return { ctx: { db } as never, patch, remove };
};

describe("botOwners reads on the primary", () => {
    it("tombstones a bot deleted before a replica saw its owner row", async () => {
        const { ctx, patch } = laggingDb();

        await markBotOwnerDeleted(ctx, "bot-1" as never, 5);

        expect(patch).toHaveBeenCalledWith("botOwners", "owner-row", { deletedAt: 5 });
    });

    it("erases an owner row a replica has not seen yet", async () => {
        const { ctx, remove } = laggingDb();

        await eraseBotsForUser(ctx, "user-1");

        expect(remove).toHaveBeenCalledWith("botOwners", "owner-row");
    });
});

describe(restoreLiveBotOwnersOf, () => {
    it("clears the tombstone of a bot whose delete failed, and keeps the one of a bot that is gone", async () => {
        expect.assertions(2);

        const harness = lunoraTest(schema as never);

        try {
            const owners = await harness.run(async (ctx: any) => {
                const live = await ctx.db.insert("bots", {
                    computerEnabled: false,
                    createdAt: 1,
                    instructions: "",
                    model: "m",
                    name: "Live",
                    updatedAt: 1,
                    userId: "user-1",
                });

                await ctx.db.insert("botOwners", { botId: live, createdAt: 1, deletedAt: 5, ownerId: "user-1" });
                await ctx.db.insert("botOwners", { botId: "gone-bot", createdAt: 1, deletedAt: 5, ownerId: "user-1" });
                await restoreLiveBotOwnersOf(ctx, "user-1", 9);

                const { page } = await ctx.db.botOwners.findMany({ where: { ownerId: "user-1" } });

                return { gone: page.find((row: any) => row.botId === "gone-bot"), live: page.find((row: any) => row.botId === live) };
            });

            expect(owners.live.deletedAt).toBeUndefined();
            expect(owners.gone.deletedAt).toBe(5);
        } finally {
            harness.close();
        }
    });
});

describe("a restore cut short", () => {
    it("keeps the live row and drops the tombstone a failed restore left beside it", async () => {
        expect.assertions(1);

        const harness = lunoraTest(schema as never);

        try {
            const rows = await harness.run(async (ctx: any) => {
                const bot = await ctx.db.insert("bots", {
                    computerEnabled: false,
                    createdAt: 1,
                    instructions: "",
                    model: "m",
                    name: "Live",
                    updatedAt: 1,
                    userId: "user-1",
                });

                // The restore inserted the live row, then failed before deleting the tombstoned one.
                await ctx.db.insert("botOwners", { botId: bot, createdAt: 1, deletedAt: 5, ownerId: "user-1" });
                await ctx.db.insert("botOwners", { botId: bot, createdAt: 1, ownerId: "user-1" });
                await restoreLiveBotOwnersOf(ctx, "user-1", 9);

                const { page } = await ctx.db.botOwners.findMany({ where: { ownerId: "user-1" } });

                return page.map((row: any) => row.deletedAt);
            });

            expect(rows).toEqual([undefined]);
        } finally {
            harness.close();
        }
    });
});

describe(pruneBotOwnerTombstonesOf, () => {
    it("removes a tombstone past its retention and keeps a recent one and a live row", async () => {
        expect.assertions(1);

        const harness = lunoraTest(schema as never);
        const now = BOT_OWNER_TOMBSTONE_TTL_MS * 2;

        try {
            const left = await harness.run(async (ctx: any) => {
                await ctx.db.insert("botOwners", { botId: "old", createdAt: 1, deletedAt: 1, ownerId: "user-1" });
                await ctx.db.insert("botOwners", { botId: "recent", createdAt: 1, deletedAt: now - 1000, ownerId: "user-1" });
                await ctx.db.insert("botOwners", { botId: "live", createdAt: 1, ownerId: "user-1" });
                await pruneBotOwnerTombstonesOf(ctx, "user-1", now);

                const { page } = await ctx.db.botOwners.findMany({ where: { ownerId: "user-1" } });

                return page.map((row: any) => row.botId).toSorted((a: string, b: string) => a.localeCompare(b));
            });

            expect(left).toEqual(["live", "recent"]);
        } finally {
            harness.close();
        }
    });
});

describe("owner records a cut-short bot write left wrong", () => {
    it("gives a live bot with no record one, and tombstones a live record whose bot is gone", async () => {
        expect.assertions(2);

        const harness = lunoraTest(schema as never);

        try {
            const rows = await harness.run(async (ctx: any) => {
                const bot = await ctx.db.insert("bots", {
                    computerEnabled: false,
                    createdAt: 3,
                    instructions: "",
                    model: "m",
                    name: "Unrecorded",
                    updatedAt: 3,
                    userId: "user-1",
                });

                // A delete that removed its bot but never wrote the tombstone.
                await ctx.db.insert("botOwners", { botId: "deleted-bot", createdAt: 1, ownerId: "user-1" });
                await restoreLiveBotOwnersOf(ctx, "user-1", 9);

                const { page } = await ctx.db.botOwners.findMany({ where: { ownerId: "user-1" } });

                return { added: page.find((row: any) => row.botId === bot), orphan: page.find((row: any) => row.botId === "deleted-bot") };
            });

            expect(rows.added).toMatchObject({ createdAt: 3, ownerId: "user-1" });
            expect(rows.orphan.deletedAt).toBe(9);
        } finally {
            harness.close();
        }
    });
});
