/**
 * Who a bot's memory belongs to when the bot is another person's (a shared chat's bot): the label the memory list gives
 * it while that bot lives and once it is deleted, and the re-pointing of `botOwners` on account conversion.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { acquireMergeLease, reassignGlobalRows } from "../lib/account-merge";
import { botOwnerRows } from "./bot-owner";
import { listUserMemories } from "./functions";

const { registry } = vi.hoisted(() => {
    return { registry: new Map<string, unknown>() };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "memory_functions", await import("./functions"));
    registerModule(registry, "lib_account_merge", await import("../lib/account-merge"));
});

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let OWNER: string;
let COLLABORATOR: string;
const BOT = "bot-of-owner";

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    const seedUser = async (name: string): Promise<string> =>
        await harness.run(
            async (ctx: any) => await ctx.db.insert("user", { createdAt: 0, email: `${name}@example.com`, emailVerified: true, name, updatedAt: 0 }),
        );

    OWNER = await seedUser("owner");
    COLLABORATOR = await seedUser("collaborator");
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("botOwners", { botId: BOT, createdAt: 1, ownerId: OWNER });
    });
});

afterEach(() => {
    harness.close();
});

/** One `reassignGlobalRows` call as the merge runs it: holding the guest's merge lease, with its generation. */
const reassignAsMerge = async (from: string, to: string): Promise<unknown> =>
    await harness.run(async (ctx: any) => {
        const { generation } = (await ctx.runMutation(acquireMergeLease, { from, to })) as { generation: number };

        return await ctx.runMutation(reassignGlobalRows, { from, generation, to });
    });

const insertCollaboratorMemory = async (botId: string | undefined): Promise<void> => {
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("memories", {
                ...(botId && { botId }),
                lastConfirmedAt: 1,
                memory: "Prefers the shared recipe",
                source: "auto",
                type: "preference",
                updatedAt: 1,
                userId: COLLABORATOR,
            }),
    );
};

const listed = async () => await harness.withIdentity({ userId: COLLABORATOR } as never).query(listUserMemories, {});

describe("memory list label for a shared bot", () => {
    it("labels a live shared bot's memory as shared, and one whose bot was deleted as a deleted bot", async () => {
        await insertCollaboratorMemory(BOT);

        const live = await listed();

        expect(live[0]).toMatchObject({ botOwnedByOther: true, fromBot: true });

        await harness.run(async (ctx: any) => {
            const owner = await ctx.db.botOwners.findFirst({ where: { botId: BOT } });

            await ctx.db.patch("botOwners", owner._id, { deletedAt: 2 });
        });

        const rows = await listed();

        expect(rows[0]).toMatchObject({ fromBot: true });
        expect(rows[0]?.botOwnedByOther).toBeUndefined();
        expect(rows[0]?.botOwnerUnknown).toBeUndefined();
    });

    it("marks a bot with no owner row (made before botOwners) as unknown, not as deleted", async () => {
        await insertCollaboratorMemory("bot-made-before-owner-rows");

        const rows = await listed();

        expect(rows[0]).toMatchObject({ botOwnerUnknown: true, fromBot: true });
        expect(rows[0]?.botOwnedByOther).toBeUndefined();
        expect(rows[0]?.botName).toBeUndefined();
    });

    it("marks the user's own bot that no longer exists as deleted, not unknown", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("botOwners", { botId: "own-gone-bot", createdAt: 1, ownerId: COLLABORATOR });
        });
        await insertCollaboratorMemory("own-gone-bot");

        const rows = await listed();

        expect(rows[0]).toMatchObject({ fromBot: true });
        expect(rows[0]?.botOwnedByOther).toBeUndefined();
        expect(rows[0]?.botOwnerUnknown).toBeUndefined();
    });
});

describe("a bot with two owner rows", () => {
    it("reads a bot as live when a restore cut short left a tombstone beside its live row", async () => {
        expect.assertions(1);

        // Both orders, as a read may return the two rows either way round.
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("botOwners", { botId: "live-first", createdAt: 1, ownerId: OWNER });
            await ctx.db.insert("botOwners", { botId: "live-first", createdAt: 1, deletedAt: 5, ownerId: OWNER });
            await ctx.db.insert("botOwners", { botId: "tombstone-first", createdAt: 1, deletedAt: 5, ownerId: OWNER });
            await ctx.db.insert("botOwners", { botId: "tombstone-first", createdAt: 1, ownerId: OWNER });
        });

        const rows = await harness.run(async (ctx: any) => await botOwnerRows(ctx, ["live-first", "tombstone-first"]));

        expect([rows.get("live-first")?.deleted, rows.get("tombstone-first")?.deleted]).toEqual([false, false]);
    });
});

describe("account conversion in batches", () => {
    it("moves a guest's many global rows over several calls, never more than a batch at a time", async () => {
        expect.assertions(3);

        const guest = "guest-with-many-bots";

        await harness.run(async (ctx: any) => {
            for (let i = 0; i < 250; i += 1) {
                await ctx.db.insert("botOwners", { botId: `guest-bot-${i}`, createdAt: 1, ownerId: guest });
            }
        });

        const first = await reassignAsMerge(guest, OWNER);
        const second = await reassignAsMerge(guest, OWNER);

        expect(first).toEqual({ done: false, reassigned: 200 });
        expect(second).toEqual({ done: true, reassigned: 50 });

        const left = await harness.run(async (ctx: any) => await ctx.db.botOwners.findMany({ where: { ownerId: guest } }));

        expect(left.page).toHaveLength(0);
    });
});

describe("account conversion", () => {
    it("re-points the bot owner row to the new account and keeps a shared bot another owner's", async () => {
        const guest = "guest";
        const account = await harness.run(
            async (ctx: any) => await ctx.db.insert("user", { createdAt: 0, email: "account@example.com", emailVerified: true, name: "account", updatedAt: 0 }),
        );

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("botOwners", { botId: "guest-bot", createdAt: 1, ownerId: guest });
        });
        await reassignAsMerge(guest, account);

        await harness.run(async (ctx: any) => {
            const row = await ctx.db.botOwners.findFirst({ where: { botId: "guest-bot" } });

            expect(row?.ownerId).toBe(account);
            // A memory the guest learned from another owner's bot stays shared: the label compares two ids that were renamed alike.
            const owners = await botOwnerRows(ctx, [BOT, "guest-bot"]);

            expect(owners.get(BOT)?.ownerId).not.toBe(account);
            expect(owners.get("guest-bot")?.ownerId).toBe(account);
        });
    });
});

describe("deleted shared bots, read in batches", () => {
    const BOT_COUNT = 60;
    const botIdAt = (i: number): string => `shared-bot-${i}`;
    // Every seventh bot was deleted by its owner.
    const isDeleted = (i: number): boolean => i % 7 === 0;

    beforeEach(async () => {
        await harness.run(async (ctx: any) => {
            for (let i = 0; i < BOT_COUNT; i += 1) {
                await ctx.db.insert("botOwners", {
                    botId: botIdAt(i),
                    createdAt: 1,
                    ...(isDeleted(i) && { deletedAt: 2 }),
                    ownerId: OWNER,
                });
            }
        });
    });

    it("finds the deleted bots among 60 shared ones in ceil(60 / 50) botOwners reads, not one per bot", async () => {
        const ids = Array.from({ length: BOT_COUNT }, (_, i) => botIdAt(i));

        await harness.run(async (ctx: any) => {
            const real = ctx.db.botOwners;
            const findMany = vi.fn(real.findMany.bind(real));
            const findFirst = vi.fn(real.findFirst.bind(real));
            const counted = { db: { botOwners: { findFirst, findMany } } };

            const owners = await botOwnerRows(counted as never, ids);
            const gone = [...owners].filter(([, owner]) => owner.deleted).map(([botId]) => botId);

            expect(findMany).toHaveBeenCalledTimes(2);
            expect(findFirst).not.toHaveBeenCalled();
            expect([...gone].toSorted((a, b) => a.localeCompare(b))).toEqual(ids.filter((_, i) => isDeleted(i)).toSorted((a, b) => a.localeCompare(b)));
        });
    });

    it("labels every shared bot of a list of 60 correctly, deleted or live", async () => {
        for (let i = 0; i < BOT_COUNT; i += 1) {
            await insertCollaboratorMemory(botIdAt(i));
        }

        const rows = await listed();
        const deletedCount = Array.from({ length: BOT_COUNT }, (_, i) => i).filter((i) => isDeleted(i)).length;

        expect(rows).toHaveLength(BOT_COUNT);
        expect(rows.every((row) => row.fromBot)).toBe(true);
        expect(rows.filter((row) => row.botOwnedByOther === true)).toHaveLength(BOT_COUNT - deletedCount);
        expect(rows.filter((row) => row.botOwnedByOther === undefined)).toHaveLength(deletedCount);
    });
});
