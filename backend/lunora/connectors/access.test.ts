/**
 * A run reads the access settings of the teammate its thread belongs to, and only for the thread's own owner. The owner sets
 * them, and only for a teammate of their own.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi } from "../../test/registered-api";
import schema from "../schema";
import { threadConnectorAccess, userConnectorAccessForSlug } from "./access";

// The setter is an authenticated mutation: it runs through the same `api` reference the app uses, so its owner check is the real one.
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

// Real user rows, so a signed-in call (`as(OWNER)`) resolves its session the way the app's does.
let OWNER = "";
let STRANGER = "";

let harness: Harness;
let botId = "";
let threadId = "";

const seedUser = async (name: string) =>
    (await harness.run(
        async (ctx: any) => await ctx.db.insert("user", { createdAt: 0, email: `${name}@example.com`, emailVerified: true, name, updatedAt: 0 }),
    )) as string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    OWNER = await seedUser("owner");
    STRANGER = await seedUser("stranger");
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

const setAccess = async (connectorSlug: string, level: "none" | "read_only" | "read_write") =>
    await harness.run(async (ctx: any) => await ctx.db.insert("teammateConnectorAccess", { botId, connectorSlug, level, updatedAt: 1, userId: OWNER }));

const readFor = async (userId = OWNER) => await harness.run(async (ctx: any) => await threadConnectorAccess(ctx, { threadId: threadId as never, userId }));

const rowsOfAccess = async () =>
    await harness.run(async (ctx: any) => {
        const rows: { botId: string; connectorSlug: string; level: string }[] = await ctx.db.query("teammateConnectorAccess").collect();

        return rows.map((row) => {
            return { botId: row.botId, connectorSlug: row.connectorSlug, level: row.level };
        });
    });

const as = (userId: string) => harness.withIdentity({ userId } as never);

const setter = (): never => registry.get("connectors_access:setTeammateConnectorAccess") as never;

describe("the access settings a run reads", () => {
    it("reads the settings of the thread's teammate", async () => {
        await setAccess("calendar", "read_only");
        await setAccess("mail", "none");

        expect(await readFor()).toStrictEqual([
            { connectorSlug: "calendar", level: "read_only" },
            { connectorSlug: "mail", level: "none" },
        ]);
    });

    it("reads nothing for a teammate's settings when the thread has no teammate", async () => {
        await setAccess("calendar", "read_only");
        const plain = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { title: "Plain", userId: OWNER }))) as string;

        expect(await harness.run(async (ctx: any) => await threadConnectorAccess(ctx, { threadId: plain as never, userId: OWNER }))).toStrictEqual([]);
    });

    it("reads nothing for a thread that is not the caller's", async () => {
        await setAccess("calendar", "none");

        expect(await readFor(STRANGER)).toStrictEqual([]);
    });

    it("reads nothing for a thread that does not exist", async () => {
        await setAccess("calendar", "none");

        expect(await harness.run(async (ctx: any) => await threadConnectorAccess(ctx, { threadId: "missing" as never, userId: OWNER }))).toStrictEqual([]);
    });
});

describe("the levels a user's teammates have on one connection", () => {
    it("lists each teammate's level for that connection, and no other connection's", async () => {
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

        await setAccess("calendar", "read_only");
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("teammateConnectorAccess", { botId: otherBot, connectorSlug: "calendar", level: "none", updatedAt: 1, userId: OWNER }),
        );
        await setAccess("mail", "none");

        const levels = await harness.run(async (ctx: any) => await userConnectorAccessForSlug(ctx, { connectorSlug: "calendar", userId: OWNER }));

        expect(levels.map((row) => row.level).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["none", "read_only"]);
    });

    it("lists nothing for another user's connection settings", async () => {
        await setAccess("calendar", "none");

        expect(await harness.run(async (ctx: any) => await userConnectorAccessForSlug(ctx, { connectorSlug: "calendar", userId: STRANGER }))).toStrictEqual([]);
    });
});

describe("setting a teammate's connection access", () => {
    it("lets the owner set a level, and change it in place rather than adding a second row", async () => {
        await as(OWNER).mutation(setter(), { botId, connectorSlug: "calendar", level: "read_only" } as never);
        await as(OWNER).mutation(setter(), { botId, connectorSlug: "calendar", level: "none" } as never);

        expect(await rowsOfAccess()).toStrictEqual([{ botId, connectorSlug: "calendar", level: "none" }]);
    });

    it("refuses a teammate that is not the caller's, and writes nothing", async () => {
        await expect(as(STRANGER).mutation(setter(), { botId, connectorSlug: "calendar", level: "none" } as never)).rejects.toThrow("Teammate not found");

        expect(await rowsOfAccess()).toStrictEqual([]);
    });
});
