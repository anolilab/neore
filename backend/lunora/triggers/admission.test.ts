/**
 * Filters are checked again when a webhook delivery is admitted. The webhook
 * handler reads the trigger, evaluates its filters and schedules the run; an owner
 * who saves stricter filters in between must not have that delivery run, or be
 * charged for it.
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import schema from "../schema";
import { claimKey, releaseKey } from "../lib/claim-once";
import { hmacSha256Hex } from "../lib/crypto";
import { admitTriggerRun, createExecution } from "./functions";
import handleTriggerWebhook from "./http";

const charged = vi.hoisted(() => {
    return { rounds: 0 };
});

// `user` is a `.global()` (D1) table the in-memory harness cannot write.
vi.mock("../auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/lib/better-auth-queries")>()),
        getUser: async (_ctx: unknown, userId: string) => {
            return { _id: userId };
        },
    };
});

vi.mock("../tasks/account", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../tasks/account")>()),
        chargeRound: async () => {
            charged.rounds += 1;

            return true;
        },
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        checkRateLimit: async () => {
            return { ok: true };
        },
    };
});

const SECRET = "whsec_test";
const NOW = 1_800_000_000_000;
const BODY = '{"event":"push","branch":"dev"}';
const MAIN_ONLY = [{ op: "equals", path: "branch", value: "main" }];

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const insertTrigger = async (): Promise<string> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("triggers", {
                createdAt: NOW,
                enabled: true,
                model: DEFAULT_CHAT_MODEL,
                name: "t",
                triggerCount: 0,
                type: "webhook",
                updatedAt: NOW,
                userId: "u",
            }),
    );

const executions = async (): Promise<{ status: string }[]> => await harness.run(async (ctx: any) => await ctx.db.query("triggerExecutions").collect());

/** The webhook handler against a trigger snapshot taken BEFORE the owner saved filters; returns what it scheduled. */
const deliver = async (triggerId: string): Promise<{ claim?: { key: string; scope: string }; payload?: string }> => {
    const scheduled: { claim?: { key: string; scope: string }; payload?: string }[] = [];
    const timestamp = String(Math.floor(NOW / 1000));
    const signature = await hmacSha256Hex(SECRET, `${timestamp}.${BODY}`);
    const context = {
        runMutation: async (reference: unknown, args: unknown) =>
            await harness.run(async (ctx: any) => await ctx.runMutation(reference === internal.lib.claim_once.releaseKey ? releaseKey : claimKey, args)),
        runQuery: async () => {
            return { enabled: true, type: "webhook", userId: "u", webhookSecret: SECRET };
        },
        scheduler: {
            runAfter: async (_delay: number, reference: unknown, args: { claim?: { key: string; scope: string }; payload?: string }) => {
                expect(reference).toBe(internal.triggers.execute.executeTrigger);
                scheduled.push(args);
            },
        },
    };
    const response = await handleTriggerWebhook(
        context as never,
        new Request("https://x/triggers/webhook/t", {
            body: BODY,
            headers: { "x-neore-timestamp": timestamp, "x-signature-256": `sha256=${signature}` },
            method: "POST",
        }),
        triggerId,
    );

    expect(response.status).toBe(200);

    return scheduled[0] as { claim?: { key: string; scope: string }; payload?: string };
};

const admit = async (triggerId: string, payload: string | undefined, claim?: { key: string; scope: string }) =>
    await harness.run(async (ctx: any) => {
        const executionId = await ctx.runMutation(createExecution, { payload, triggerId });

        return await ctx.runMutation(admitTriggerRun, { claim, executionId, filterPayload: payload ?? "", triggerId });
    });

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    charged.rounds = 0;
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

describe("admitTriggerRun filter recheck", () => {
    it("refuses and does not charge a delivery the owner's newer filters no longer match", async () => {
        const triggerId = await insertTrigger();
        const { payload } = await deliver(triggerId);

        await harness.run(async (ctx: any) => await ctx.db.patch(triggerId, { filters: MAIN_ONLY }));

        const result = await admit(triggerId, payload);

        expect(result).toEqual({ filtered: 'branch equals "main"' });
        expect(charged.rounds).toBe(0);
        // The running row the execution created is replaced by the one filtered row.
        expect(await executions()).toEqual([expect.objectContaining({ error: 'branch equals "main"', status: "filtered" })]);
    });

    it("gives the replay claim back, so the same signed body redelivered after the filters are fixed runs", async () => {
        const triggerId = await insertTrigger();
        const first = await deliver(triggerId);

        await harness.run(async (ctx: any) => await ctx.db.patch(triggerId, { filters: MAIN_ONLY }));

        expect(first.claim).toBeDefined();
        expect(await admit(triggerId, first.payload, first.claim)).toEqual({ filtered: 'branch equals "main"' });

        await harness.run(async (ctx: any) => await ctx.db.patch(triggerId, { filters: [{ op: "equals", path: "branch", value: "dev" }] }));

        // A duplicate would schedule nothing, so `deliver` would return `undefined`.
        const redelivery = await deliver(triggerId);

        expect(redelivery).toMatchObject({ payload: first.payload });
        expect(await admit(triggerId, redelivery.payload, redelivery.claim)).toBeNull();
    });

    it("keeps the claim of a delivery that is admitted", async () => {
        const triggerId = await insertTrigger();
        const first = await deliver(triggerId);

        expect(await admit(triggerId, first.payload, first.claim)).toBeNull();
        expect(await deliver(triggerId)).toBeUndefined();
    });

    it("admits and charges a delivery that still matches", async () => {
        const triggerId = await insertTrigger();
        const { payload } = await deliver(triggerId);

        await harness.run(async (ctx: any) => await ctx.db.patch(triggerId, { filters: [{ op: "equals", path: "branch", value: "dev" }] }));

        expect(await admit(triggerId, payload)).toBeNull();
        expect(charged.rounds).toBe(1);
        expect(await executions()).toEqual([expect.objectContaining({ status: "running" })]);
    });

    it("does not look at filters for a run that passes no delivery payload", async () => {
        const triggerId = await insertTrigger();

        await harness.run(async (ctx: any) => await ctx.db.patch(triggerId, { filters: MAIN_ONLY }));

        const result = await harness.run(async (ctx: any) => await ctx.runMutation(admitTriggerRun, { triggerId }));

        expect(result).toBeNull();
        expect(charged.rounds).toBe(1);
    });
});
