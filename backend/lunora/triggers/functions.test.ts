/**
 * `updateTriggerStats` after a failure and then a success: the success must
 * CLEAR `lastError`. It used to patch `lastError: undefined`, which the runtime
 * refuses, so every successful run after a failed one threw in its bookkeeping.
 *
 * And a schedule is checked when it is saved: `getNextCronTime` reads garbage as
 * a wildcard, so an unchecked expression fires every minute.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { assertComputerRoutine, createTrigger, testRunTrigger, updateTrigger, updateTriggerStats } from "./functions";

// `user` is a `.global()` (D1) table the in-memory harness cannot write, so the
// session is read straight off the harness identity.
const { registry, sessionFrom } = vi.hoisted(() => {
    return {
        registry: new Map<string, unknown>(),
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
    };
});

// `testRunTrigger` reads the trigger through `ctx.runQuery(internal.…)`.
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "triggers_functions", await import("./functions"));
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const record = async (args: Record<string, unknown>): Promise<void> => {
    await harness.run(async (ctx: any) => await ctx.runMutation(updateTriggerStats, args));
};

const readTrigger = async (id: string): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.get(id));

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("updateTriggerStats", () => {
    it("records a failure, then clears it on the next success", async () => {
        const triggerId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("triggers", {
                    createdAt: 1,
                    cronExpression: "0 9 * * *",
                    enabled: true,
                    model: "m",
                    name: "Daily",
                    triggerCount: 0,
                    type: "schedule",
                    updatedAt: 1,
                    userId: "user-a",
                }),
        );

        await record({ error: "boom", lastTriggeredAt: 10, triggerId });

        const failed = await readTrigger(triggerId);

        expect(failed).toMatchObject({ lastError: "boom", lastTriggeredAt: 10, triggerCount: 1 });

        await record({ lastTriggeredAt: 20, nextTriggerAt: 99, triggerId });

        const recovered = await readTrigger(triggerId);

        expect(recovered).toMatchObject({ cronExpression: "0 9 * * *", lastTriggeredAt: 20, name: "Daily", nextTriggerAt: 99, triggerCount: 2 });
        // Removed, not nulled: a `null` would fail `getTriggers`' output validator.
        expect("lastError" in recovered).toBe(false);
        expect(recovered._id).toBe(triggerId);
    });
});

describe("trigger schedules", () => {
    const as = () => harness.withIdentity({ userId: "user-a" } as never);
    const schedule = (cronExpression?: string) => {
        return { cronExpression, model: "m", name: "Daily", type: "schedule" };
    };

    it("refuses an expression the parser would read as a wildcard, on create and on update", async () => {
        for (const garbage of ["every day", "0 9 * *", "60 * * * *", "1-5/2 * * * *"]) {
            await expect(as().mutation(createTrigger as never, schedule(garbage) as never), garbage).rejects.toThrow("5-field cron expression");
        }

        await expect(as().mutation(createTrigger as never, schedule() as never)).rejects.toThrow("5-field cron expression");

        const { triggerId } = (await as().mutation(createTrigger as never, schedule("0 9 * * 1") as never)) as { triggerId: string };

        await expect(as().mutation(updateTrigger as never, { cronExpression: "nope", triggerId } as never)).rejects.toThrow("5-field cron expression");
        const trigger = await readTrigger(triggerId);

        expect(trigger.cronExpression).toBe("0 9 * * 1");
    });

    it("does not ask a webhook trigger for a schedule", async () => {
        await expect(as().mutation(createTrigger as never, { model: "m", name: "Hook", type: "webhook" } as never)).resolves.toMatchObject({
            triggerId: expect.any(String),
        });
    });
});
describe("a routine's bot computer", () => {
    it("needs a bot and a schedule", () => {
        expect(() => assertComputerRoutine({ botComputer: true, botId: undefined, type: "schedule" })).toThrow("Only a routine with a bot");
        expect(() => assertComputerRoutine({ botComputer: true, botId: "bot-a", type: "webhook" })).toThrow("Only a scheduled routine");
        expect(() => assertComputerRoutine({ botComputer: true, botId: "bot-a", type: "schedule" })).not.toThrow();
        expect(() => assertComputerRoutine({ botComputer: false, botId: undefined, type: "webhook" })).not.toThrow();
    });

    it("is cleared with the bot, so a routine with no bot has no computer", async () => {
        const triggerId = (await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("triggers", {
                    botComputer: true,
                    botId: "bot-a",
                    createdAt: 1,
                    cronExpression: "0 9 * * 1",
                    enabled: false,
                    model: "m",
                    name: "Daily",
                    triggerCount: 0,
                    type: "schedule",
                    updatedAt: 1,
                    userId: "user-a",
                }),
        )) as string;

        await harness.withIdentity({ userId: "user-a" } as never).mutation(updateTrigger as never, { botId: null, triggerId } as never);

        const cleared = await readTrigger(triggerId);

        expect(cleared.botId).toBeUndefined();
        expect(cleared.botComputer).toBeUndefined();
    });
});

describe("testRunTrigger", () => {
    // The run reads the trigger when it starts, after this action returned. Enabling the
    // trigger only for the action's length meant a disabled trigger never ran.
    it("runs a disabled trigger without enabling it", async () => {
        const as = harness.withIdentity({ userId: "user-a" } as never);
        const { triggerId } = (await as.mutation(createTrigger as never, { cronExpression: "0 9 * * 1", model: "m", name: "Daily", type: "schedule" } as never)) as {
            triggerId: string;
        };
        const before = await readTrigger(triggerId);

        await as.action(testRunTrigger as never, { triggerId } as never);

        expect(harness.scheduler.list().map((job) => job.args)).toEqual([{ ignoreDisabled: true, payload: "Manual test run triggered.", triggerId }]);

        const after = await readTrigger(triggerId);

        expect(after.enabled).toBe(false);
        expect(after.updatedAt).toBe(before.updatedAt);
    });
});
