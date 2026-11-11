/**
 * The limits on a teammate's connection settings: a teammate holds at most `MAX_SETTINGS_PER_TEAMMATE`, a deleted teammate's
 * settings are removed with it, and a deleted teammate restricts nothing.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi } from "../../test/registered-api";
import schema from "../schema";
import { deleteBotConnectorAccess, MAX_SETTINGS_PER_TEAMMATE, threadConnectorAccess } from "./access";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    const exports = await import("./access");

    for (const [name, value] of Object.entries(exports)) {
        registry.set(`connectors_access:${name}`, value);
    }
});

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let OWNER = "";
let botId = "";
let threadId = "";

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    OWNER = (await harness.run(
        async (ctx: any) => await ctx.db.insert("user", { createdAt: 0, email: "owner@example.com", emailVerified: true, name: "owner", updatedAt: 0 }),
    )) as string;
    botId = (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("bots", {
                computerEnabled: false,
                createdAt: 1,
                instructions: "",
                model: "test-model",
                name: "Ada",
                updatedAt: 1,
                userId: OWNER,
            }),
    )) as string;
    threadId = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { botId, title: "Inbox", userId: OWNER }))) as string;
});

afterEach(() => {
    harness.close();
});

const insertSettings = async (count: number, forBot = botId) =>
    await harness.run(async (ctx: any) => {
        for (let index = 0; index < count; index += 1) {
            await ctx.db.insert("teammateConnectorAccess", { botId: forBot, connectorSlug: `slug-${index}`, level: "read_only", updatedAt: 1, userId: OWNER });
        }
    });

const countSettings = async (forBot = botId) =>
    await harness.run(async (ctx: any) => {
        const rows: { botId: string }[] = await ctx.db.query("teammateConnectorAccess").collect();

        return rows.filter((row) => row.botId === forBot).length;
    });

const setter = (): never => registry.get("connectors_access:setTeammateConnectorAccess") as never;

describe("the limit on a teammate's connection settings", () => {
    it("refuses a new setting once the teammate holds the most a run reads, and writes nothing", async () => {
        await insertSettings(MAX_SETTINGS_PER_TEAMMATE);

        await expect(
            harness.withIdentity({ userId: OWNER } as never).mutation(setter(), { botId, connectorSlug: "one-more", level: "none" } as never),
        ).rejects.toThrow(`at most ${MAX_SETTINGS_PER_TEAMMATE}`);

        expect(await countSettings()).toBe(MAX_SETTINGS_PER_TEAMMATE);
    });

    it("still changes a setting the teammate already holds at the limit", async () => {
        await insertSettings(MAX_SETTINGS_PER_TEAMMATE);

        await harness.withIdentity({ userId: OWNER } as never).mutation(setter(), { botId, connectorSlug: "slug-0", level: "none" } as never);

        expect(await countSettings()).toBe(MAX_SETTINGS_PER_TEAMMATE);
    });
});

describe("a deleted teammate", () => {
    it("loses every connection setting, and no other teammate's", async () => {
        const otherBot = (await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("bots", {
                    computerEnabled: false,
                    createdAt: 1,
                    instructions: "",
                    model: "test-model",
                    name: "Bo",
                    updatedAt: 1,
                    userId: OWNER,
                }),
        )) as string;

        await insertSettings(MAX_SETTINGS_PER_TEAMMATE + 3);
        await insertSettings(2, otherBot);

        await harness.run(async (ctx: any) => await deleteBotConnectorAccess(ctx, botId as never));

        expect(await countSettings()).toBe(0);
        expect(await countSettings(otherBot)).toBe(2);
    });

    it("restricts none of its old threads once the teammate is gone", async () => {
        await insertSettings(2);
        await harness.run(async (ctx: any) => await ctx.db.delete("bots", botId as never));

        expect(await harness.run(async (ctx: any) => await threadConnectorAccess(ctx, { threadId: threadId as never, userId: OWNER }))).toStrictEqual([]);
    });
});
