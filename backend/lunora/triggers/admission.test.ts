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
import { claimKey, claimKeyFenced, releaseKey, TRIGGER_CLAIM_TTL_MS } from "../lib/claim-once";
import { hmacSha256Hex } from "../lib/crypto";
import { filterTextOf, MAX_WEBHOOK_BODY_BYTES } from "./filters";
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
const TOO_LONG = /filterPayload|too long|maximum|length/i;
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

/** The claim mutation the webhook handler calls, served by the harness's own copy. */
const claimMutation = (reference: unknown) => {
    if (reference === internal.lib.claim_once.releaseKey) {
        return releaseKey;
    }

    return reference === internal.lib.claim_once.claimKeyFenced ? claimKeyFenced : claimKey;
};

const executions = async (): Promise<{ status: string }[]> => await harness.run(async (ctx: any) => await ctx.db.query("triggerExecutions").collect());

type Claim = { claimedAt: number; key: string; scope: string };

type Scheduled = { claim?: Claim; invalidUtf8?: boolean; payload?: string };

const hmacBytesHex = async (bytes: Uint8Array): Promise<string> => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);

    return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * The webhook handler against a trigger snapshot taken BEFORE the owner saved filters; returns what it scheduled.
 * `native` signs the body alone (no timestamp), the scheme whose replay claim lapses with its TTL.
 */
const deliver = async (
    triggerId: string,
    body: Uint8Array | string = BODY,
    { at = NOW, native = false }: { at?: number; native?: boolean } = {},
): Promise<Scheduled> => {
    const scheduled: Scheduled[] = [];
    const timestamp = String(Math.floor(at / 1000));
    const prefix = native ? "" : `${timestamp}.`;
    const signature =
        typeof body === "string"
            ? await hmacSha256Hex(SECRET, `${prefix}${body}`)
            : await hmacBytesHex(new Uint8Array([...new TextEncoder().encode(prefix), ...body]));
    const context = {
        runMutation: async (reference: unknown, args: unknown) => await harness.run(async (ctx: any) => await ctx.runMutation(claimMutation(reference), args)),
        runQuery: async () => {
            return { enabled: true, type: "webhook", userId: "u", webhookSecret: SECRET, webhookSignatureScheme: native ? "native" : undefined };
        },
        scheduler: {
            runAfter: async (_delay: number, reference: unknown, args: Scheduled) => {
                expect(reference).toBe(internal.triggers.execute.executeTrigger);
                scheduled.push(args);
            },
        },
    };
    const headers: Record<string, string> = native
        ? { "x-hub-signature-256": `sha256=${signature}` }
        : { "x-neore-timestamp": timestamp, "x-signature-256": `sha256=${signature}` };
    const response = await handleTriggerWebhook(context as never, new Request("https://x/triggers/webhook/t", { body, headers, method: "POST" }), triggerId);

    expect(response.status).toBe(200);

    return scheduled[0] as Scheduled;
};

const admit = async (triggerId: string, payload: string | undefined, claim?: Claim) =>
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

    it("does not clear a newer claim when a run that starts after its claim lapsed is refused", async () => {
        // A native signature has no timestamp to go stale, so once its claim lapses a redelivery of the same body takes the key again.
        const triggerId = await insertTrigger();
        const first = await deliver(triggerId, BODY, { native: true });

        vi.setSystemTime(NOW + TRIGGER_CLAIM_TTL_MS + 1);
        const redelivery = await deliver(triggerId, BODY, { at: NOW + TRIGGER_CLAIM_TTL_MS + 1, native: true });

        expect(redelivery.claim).toBeDefined();
        await harness.run(async (ctx: any) => await ctx.db.patch(triggerId, { filters: MAIN_ONLY }));

        // The first run starts late; the owner's filters refuse it and it gives back its own (lapsed) claim only.
        expect(await admit(triggerId, first.payload, first.claim)).toEqual({ filtered: 'branch equals "main"' });

        // The redelivery's claim still holds the key, so the sender's next retry is a replay and schedules nothing.
        expect(await deliver(triggerId, BODY, { at: NOW + TRIGGER_CLAIM_TTL_MS + 1, native: true })).toBeUndefined();
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

    it("refuses a body that was not valid UTF-8 once the owner adds a filter its lossy decode would pass", async () => {
        const triggerId = await insertTrigger();
        const bytes = new Uint8Array([...new TextEncoder().encode('{"note":"'), 0xff, 0x22, 0x7d]);
        const delivery = await deliver(triggerId, bytes);

        expect(delivery.invalidUtf8).toBe(true);

        await harness.run(async (ctx: any) => await ctx.db.patch(triggerId, { filters: [{ op: "exists", path: "note" }] }));

        // The lossy text alone would pass: the replacement character leaves valid JSON.
        expect(await admit(triggerId, delivery.payload)).toBeNull();
        expect(charged.rounds).toBe(1);

        const executionId = await harness.run(async (ctx: any) => await ctx.runMutation(createExecution, { payload: delivery.payload, triggerId }));
        const result = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(admitTriggerRun, {
                    claim: delivery.claim,
                    executionId,
                    filterPayload: filterTextOf(delivery.payload, delivery.invalidUtf8),
                    triggerId,
                }),
        );

        expect(result).toEqual({ filtered: expect.any(String) });
        expect(charged.rounds).toBe(1);
    });

    it("rejects a filter payload longer than a webhook body can be", async () => {
        const triggerId = await insertTrigger();
        const run = async (filterPayload: string) =>
            await harness.run(async (ctx: any) => await ctx.runMutation(admitTriggerRun, { filterPayload, triggerId }));

        expect(await run("x".repeat(MAX_WEBHOOK_BODY_BYTES))).toBeNull();
        await expect(run("x".repeat(MAX_WEBHOOK_BODY_BYTES + 1))).rejects.toThrow(TOO_LONG);
    });

    it("does not look at filters for a run that passes no delivery payload", async () => {
        const triggerId = await insertTrigger();

        await harness.run(async (ctx: any) => await ctx.db.patch(triggerId, { filters: MAIN_ONLY }));

        const result = await harness.run(async (ctx: any) => await ctx.runMutation(admitTriggerRun, { triggerId }));

        expect(result).toBeNull();
        expect(charged.rounds).toBe(1);
    });
});
