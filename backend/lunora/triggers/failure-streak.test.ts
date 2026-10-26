/**
 * A trigger that keeps failing for a reason its owner can fix pauses itself and
 * says so. Only those failures count; a transient one neither counts nor resets,
 * a success starts over, and a settled run is never counted twice.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentRunError } from "../chat/lib/agent-run";
import type { AgentRunErrorKind } from "../chat/lib/agent-run";
import schema from "../schema";
import { isUserFixableRunError } from "./execute";
import { advanceStreak, isModelUnavailableRefusal, modelUnavailableMessage, TRIGGER_PAUSE_AFTER_FAILURES } from "./failure-streak";
import { createExecution, setTriggerEnabledInternal, updateExecution } from "./functions";

type Harness = ReturnType<typeof lunoraTest>;

const USER = "user-a";

let harness: Harness;

const insertTrigger = async (overrides: Record<string, unknown> = {}): Promise<string> =>
    await harness.run(
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
                userId: USER,
                ...overrides,
            }),
    );

const readTrigger = async (id: string): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.get(id));

const fieldOf = async (id: string, key: "enabled" | "failureStreak"): Promise<unknown> => {
    const trigger = await readTrigger(id);

    return trigger[key];
};

const startRun = async (triggerId: string): Promise<string> => await harness.run(async (ctx: any) => await ctx.runMutation(createExecution, { triggerId }));

const settle = async (executionId: string, status: "completed" | "failed", userFixable?: boolean): Promise<void> => {
    await harness.run(
        async (ctx: any) =>
            await ctx.runMutation(updateExecution, {
                executionId,
                status,
                ...(status === "failed" && { error: "The model is gone." }),
                ...(userFixable !== undefined && { userFixable }),
            }),
    );
};

/** One run from start to finish, as `executeTrigger` drives it. */
const run = async (triggerId: string, status: "completed" | "failed", userFixable?: boolean): Promise<string> => {
    const executionId = await startRun(triggerId);

    await settle(executionId, status, userFixable);

    return executionId;
};

const failFixable = async (triggerId: string): Promise<string> => await run(triggerId, "failed", true);

/** Notifications whose dedupe key starts with `prefix`. */
const noticesKeyed = async (prefix: string): Promise<Awaited<ReturnType<typeof notices>>> => {
    const rows = await notices();

    return rows.filter((row) => row.dedupeKey?.startsWith(prefix));
};

const notices = async (): Promise<{ body?: string; dedupeKey?: string; outcome?: string; title: string; type: string }[]> =>
    await harness.run(async (ctx: any) => await ctx.db.query("notifications").collect());

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("advanceStreak", () => {
    it("counts a user-fixable failure, keeps the streak through a transient one and clears it on success", () => {
        expect(advanceStreak(1, "user-fixable")).toEqual({ pause: false, streak: 2 });
        expect(advanceStreak(2, "transient")).toEqual({ pause: false, streak: 2 });
        expect(advanceStreak(2, "success")).toEqual({ pause: false, streak: 0 });
    });

    it("pauses on the failure that reaches the threshold", () => {
        expect(advanceStreak(TRIGGER_PAUSE_AFTER_FAILURES - 1, "user-fixable")).toEqual({ pause: true, streak: TRIGGER_PAUSE_AFTER_FAILURES });
    });
});

describe("what counts as user-fixable", () => {
    it.each<[AgentRunErrorKind, boolean]>([
        ["custom-endpoint", true],
        ["local-endpoint", true],
        ["plan-required", true],
        ["skill", false],
        ["stale-approval", false],
    ])("a run error of kind %s: %s", (kind, expected) => {
        expect(isUserFixableRunError(new AgentRunError(kind, "x"))).toBe(expected);
    });

    it("never counts an error that is not the run's own refusal", () => {
        expect(isUserFixableRunError(new Error("Gateway model proxy failed (502)"))).toBe(false);
        expect(isUserFixableRunError("Custom endpoint missing or disabled")).toBe(false);
    });

    it("recognises the model refusal admission writes, and not the daily limit", () => {
        expect(isModelUnavailableRefusal(modelUnavailableMessage("gpt-x"))).toBe(true);
        expect(isModelUnavailableRefusal("You've reached your daily limit for task runs. Run the task again tomorrow.")).toBe(false);
    });
});

describe("pausing a trigger after repeated user-fixable failures", () => {
    it("pauses on the Nth failure in a row, not before", async () => {
        const triggerId = await insertTrigger();

        for (let index = 1; index < TRIGGER_PAUSE_AFTER_FAILURES; index += 1) {
            await failFixable(triggerId);
        }

        expect(await readTrigger(triggerId)).toMatchObject({ enabled: true, failureStreak: TRIGGER_PAUSE_AFTER_FAILURES - 1 });

        await failFixable(triggerId);

        expect(await readTrigger(triggerId)).toMatchObject({ enabled: false, failureStreak: TRIGGER_PAUSE_AFTER_FAILURES });
    });

    it("never pauses on transient failures, however many", async () => {
        const triggerId = await insertTrigger();

        for (let index = 0; index < TRIGGER_PAUSE_AFTER_FAILURES * 2; index += 1) {
            await run(triggerId, "failed");
        }

        const trigger = await readTrigger(triggerId);

        expect(trigger.enabled).toBe(true);
        expect(trigger.failureStreak ?? 0).toBe(0);
    });

    it("leaves the streak alone on a transient failure between user-fixable ones", async () => {
        const triggerId = await insertTrigger();

        await failFixable(triggerId);
        await run(triggerId, "failed", false);
        await failFixable(triggerId);

        expect(await readTrigger(triggerId)).toMatchObject({ enabled: true, failureStreak: 2 });

        await failFixable(triggerId);

        expect(await fieldOf(triggerId, "enabled")).toBe(false);
    });

    it("starts the streak over after a success", async () => {
        const triggerId = await insertTrigger();

        await failFixable(triggerId);
        await failFixable(triggerId);
        await run(triggerId, "completed");

        expect(await readTrigger(triggerId)).toMatchObject({ enabled: true, failureStreak: 0 });

        await failFixable(triggerId);
        await failFixable(triggerId);

        expect(await fieldOf(triggerId, "enabled")).toBe(true);
    });

    it("counts a run once when its settle is delivered again", async () => {
        const triggerId = await insertTrigger();
        const executionId = await startRun(triggerId);

        await settle(executionId, "failed", true);
        await settle(executionId, "failed", true);
        await settle(executionId, "failed", true);

        expect(await fieldOf(triggerId, "failureStreak")).toBe(1);
    });

    it("does not count a failure reported for a run that already completed", async () => {
        const triggerId = await insertTrigger({ failureStreak: 1 });
        const executionId = await startRun(triggerId);

        await settle(executionId, "completed");
        await settle(executionId, "failed", true);

        expect(await fieldOf(triggerId, "failureStreak")).toBe(0);
    });

    it("notifies the owner once, under a key naming the trigger and the pausing run", async () => {
        const triggerId = await insertTrigger();
        let pausingRun = "";

        for (let index = 0; index < TRIGGER_PAUSE_AFTER_FAILURES; index += 1) {
            pausingRun = await failFixable(triggerId);
        }

        // Delivered again, and a manual run of the paused trigger failing the same way: neither may notify again.
        await settle(pausingRun, "failed", true);
        await failFixable(triggerId);

        const paused = await noticesKeyed("trigger-paused:");

        expect(paused).toHaveLength(1);
        expect(paused[0]).toMatchObject({
            dedupeKey: `trigger-paused:${triggerId}:${pausingRun}`,
            outcome: "failure",
            title: "Daily",
            type: "trigger",
        });
        expect(paused[0]?.body).toContain("Paused after");
        // The pausing run is announced by the pause alone, not by a second failure notice.
        expect(await noticesKeyed(`trigger:${pausingRun}`)).toHaveLength(0);
    });

    it("starts a new episode, with its own notification, after the owner turns it back on", async () => {
        const triggerId = await insertTrigger();

        for (let index = 0; index < TRIGGER_PAUSE_AFTER_FAILURES; index += 1) {
            await failFixable(triggerId);
        }

        await harness.run(async (ctx: any) => await ctx.runMutation(setTriggerEnabledInternal, { enabled: true, triggerId }));

        expect(await readTrigger(triggerId)).toMatchObject({ enabled: true, failureStreak: 0 });

        for (let index = 0; index < TRIGGER_PAUSE_AFTER_FAILURES; index += 1) {
            await failFixable(triggerId);
        }

        expect(await noticesKeyed("trigger-paused:")).toHaveLength(2);
    });
});
