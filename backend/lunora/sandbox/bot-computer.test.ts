/**
 * A bot's computer is shared by every chat of the bot, so two callers must
 * claim ONE session, and an idle one is paused (state kept) rather than killed.
 * A thread's sandbox still dies when idle, and a session that is not idle yet is
 * checked again rather than dropped.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { checkAndTerminateIdle, claimBotComputer } from "./functions";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const insertBot = async (): Promise<string> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("bots", {
                computerEnabled: true,
                createdAt: Date.now(),
                instructions: "Be brief.",
                model: "gemini-1.5-flash",
                name: "Scout",
                updatedAt: Date.now(),
                userId: "user-1",
            }),
    );

const insertSession = async (fields: Record<string, unknown>): Promise<string> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("sandboxSessions", {
                lastActivityAt: Date.now(),
                startedAt: Date.now(),
                status: "active",
                timeoutMs: 600_000,
                userId: "user-1",
                ...fields,
            }),
    );

const readSession = async (id: string): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.get(id));

const readStatus = async (id: string): Promise<string> => {
    const session = await readSession(id);

    return session.status;
};

describe("checkAndTerminateIdle", () => {
    it("pauses an idle bot computer and keeps its session", async () => {
        const botId = await insertBot();
        const sessionId = await insertSession({ botId, lastActivityAt: Date.now() - 11 * 60_000, sandboxId: "sbx-1" });

        const result = await harness.run(async (ctx: any) => await ctx.runMutation(checkAndTerminateIdle, { sessionId }));

        expect(result).toMatchObject({ pause: true, sandboxId: "sbx-1", shouldTerminate: true });
        expect(await readStatus(sessionId)).toBe("paused");
    });

    it("terminates an idle thread sandbox", async () => {
        const sessionId = await insertSession({ lastActivityAt: Date.now() - 11 * 60_000, sandboxId: "sbx-2" });

        const result = await harness.run(async (ctx: any) => await ctx.runMutation(checkAndTerminateIdle, { sessionId }));

        expect(result).toMatchObject({ pause: false, shouldTerminate: true });
        expect(await readStatus(sessionId)).toBe("terminated");
    });

    it("asks for a recheck instead of terminating a session that is still in use", async () => {
        const sessionId = await insertSession({ lastActivityAt: Date.now() - 60_000, sandboxId: "sbx-3" });

        const result = await harness.run(async (ctx: any) => await ctx.runMutation(checkAndTerminateIdle, { sessionId }));

        expect(result.shouldTerminate).toBe(false);
        expect(result.recheckInMs).toBeGreaterThan(0);
        expect(await readStatus(sessionId)).toBe("active");
    });
});

describe("claimBotComputer", () => {
    it("hands a second caller the first caller's session", async () => {
        const botId = await insertBot();

        const first = await harness.run(async (ctx: any) => await ctx.runMutation(claimBotComputer, { botId, timeoutMs: 600_000, userId: "user-1" }));
        const second = await harness.run(async (ctx: any) => await ctx.runMutation(claimBotComputer, { botId, timeoutMs: 600_000, userId: "user-1" }));

        expect(first.created).toBe(true);
        expect(second).toMatchObject({ created: false, sessionId: first.sessionId, status: "starting" });
    });
});
