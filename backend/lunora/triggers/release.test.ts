/**
 * A `gitlab-token` delivery is claimed for years, so every way it can end WITHOUT a
 * run must give the claim back: GitLab's retry of a delivery that never ran has to run.
 * A run that did execute keeps its claim, and the other schemes' claims lapse as before.
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { internal } from "../_generated/internal";
import schema from "../schema";
import { claimKey, claimKeyFenced, releaseKey, TRIGGER_DELIVERY_SCOPE } from "../lib/claim-once";
import { hmacSha256Hex } from "../lib/crypto";
import { DAILY_LIMIT_MESSAGE } from "../tasks/account";
import { executeTrigger } from "./execute";
import { admitTriggerRun } from "./functions";
import handleTriggerWebhook from "./http";

const world = vi.hoisted(() => {
    return { agentRuns: 0, chargeOk: true, registry: new Map<string, unknown>(), userExists: true, userLookupThrows: false };
});

vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), world.registry));

vi.mock("../chat/lib/headless-run", () => {
    return {
        runHeadlessAgent: async () => {
            world.agentRuns += 1;

            return { text: "done", threadId: "thread-1" };
        },
    };
});

// `user` is a `.global()` (D1) table the in-memory harness cannot write.
vi.mock("../auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/lib/better-auth-queries")>()),
        getUser: async (_ctx: unknown, userId: string) => {
            if (world.userLookupThrows) {
                throw new Error("user lookup failed");
            }

            return world.userExists ? { _id: userId } : null;
        },
    };
});

vi.mock("../tasks/account", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../tasks/account")>()),
        chargeRound: async () => world.chargeOk,
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
const UUID = "0a2f7c1e-6c1d-4b53-9d3a-1f7e4d0c9b11";
const NO_LONGER_AVAILABLE = /no longer available/u;
const BODY = '{"object_kind":"merge_request"}';

type Harness = ReturnType<typeof lunoraTest>;
type Claim = { claimedAt: number; key: string; scope: string };
type Scheduled = { claim?: Claim; payload?: string; releaseUnlessRun?: boolean; triggerId: string };

let harness: Harness;

beforeAll(async () => {
    registerModule(world.registry, "triggers_functions", await import("./functions"));
    registerModule(world.registry, "lib_claim_once", await import("../lib/claim-once"));
});

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    world.agentRuns = 0;
    world.chargeOk = true;
    world.userExists = true;
    world.userLookupThrows = false;
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

const insertTrigger = async (patch: Record<string, unknown> = {}): Promise<string> =>
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
                webhookSecret: SECRET,
                webhookSignatureScheme: "gitlab-token",
                ...patch,
            }),
    );

const claimMutation = (reference: unknown) => {
    if (reference === internal.lib.claim_once.releaseKey) {
        return releaseKey;
    }

    return reference === internal.lib.claim_once.claimKeyFenced ? claimKeyFenced : claimKey;
};

/** One GitLab delivery through the real handler; the args it scheduled, or `undefined` when it was answered as a duplicate. */
const deliver = async (triggerId: string, scheme: "gitlab-token" | "native" = "gitlab-token", body = BODY): Promise<Scheduled | undefined> => {
    const scheduled: Scheduled[] = [];
    const context = {
        runMutation: async (reference: unknown, args: unknown) => await harness.run(async (ctx: any) => await ctx.runMutation(claimMutation(reference), args)),
        runQuery: async () => {
            return { enabled: true, type: "webhook", userId: "u", webhookSecret: SECRET, webhookSignatureScheme: scheme };
        },
        scheduler: {
            runAfter: async (_delay: number, _reference: unknown, args: Scheduled) => {
                scheduled.push(args);
            },
        },
    };
    const headers: Record<string, string> =
        scheme === "gitlab-token"
            ? { "x-gitlab-event-uuid": UUID, "x-gitlab-token": SECRET }
            : { "x-hub-signature-256": `sha256=${await hmacSha256Hex(SECRET, body)}` };
    const response = await handleTriggerWebhook(context as never, new Request("https://x/triggers/webhook/t", { body, headers, method: "POST" }), triggerId);

    expect(response.status).toBe(200);

    return scheduled[0];
};

const claims = async (): Promise<{ scope: string }[]> => await harness.run(async (ctx: any) => await ctx.db.query("idempotencyClaims").collect());

/** What `executeTrigger` does first with a scheduled delivery. */
const admit = async (delivery: Scheduled) =>
    await harness.run(async (ctx: any) => {
        const executionId = await ctx.runMutation(internal.triggers.functions.createExecution, { payload: delivery.payload, triggerId: delivery.triggerId });

        return await ctx.runMutation(admitTriggerRun, {
            claim: delivery.claim,
            executionId,
            filterPayload: delivery.payload ?? "",
            releaseUnlessRun: delivery.releaseUnlessRun,
            triggerId: delivery.triggerId,
        });
    });

const execute = async (delivery: Scheduled): Promise<void> => {
    await harness.action((async (ctx: any) => await ctx.runAction(executeTrigger, { ...delivery })) as never);
};

describe("a refused admission gives a gitlab-token claim back", () => {
    it("on the daily limit, so the redelivery runs", async () => {
        const triggerId = await insertTrigger();
        const first = (await deliver(triggerId))!;

        world.chargeOk = false;
        expect(await admit(first)).toBe(DAILY_LIMIT_MESSAGE);
        expect(await claims()).toEqual([]);

        world.chargeOk = true;

        const redelivery = await deliver(triggerId);

        expect(redelivery).toBeDefined();
        expect(await admit(redelivery!)).toBeNull();
    });

    it("when the model is no longer available, so the redelivery runs", async () => {
        const triggerId = await insertTrigger({ model: "retired-model" });
        const first = (await deliver(triggerId))!;

        expect(await admit(first)).toMatch(NO_LONGER_AVAILABLE);
        expect(await claims()).toEqual([]);

        await harness.run(async (ctx: any) => await ctx.db.patch(triggerId, { model: DEFAULT_CHAT_MODEL }));
        expect(await deliver(triggerId)).toBeDefined();
    });

    it("when the account is gone or may not run tasks, so the redelivery runs", async () => {
        const triggerId = await insertTrigger();
        const first = (await deliver(triggerId))!;

        world.userExists = false;
        expect(await admit(first)).toBe("Your account no longer exists.");
        expect(await claims()).toEqual([]);

        world.userExists = true;
        expect(await deliver(triggerId)).toBeDefined();
    });

    it("when the trigger was deleted after acceptance", async () => {
        const triggerId = await insertTrigger();
        const first = (await deliver(triggerId))!;

        await harness.run(async (ctx: any) => await ctx.db.delete(triggerId));

        expect(await admit(first)).toBe("Trigger not found");
        expect(await claims()).toEqual([]);
    });

    it("but keeps the claim of a delivery that was admitted, so its replay stays a duplicate", async () => {
        const triggerId = await insertTrigger();
        const first = (await deliver(triggerId))!;

        expect(await admit(first)).toBeNull();
        expect(await claims()).toEqual([expect.objectContaining({ scope: TRIGGER_DELIVERY_SCOPE })]);
        expect(await deliver(triggerId)).toBeUndefined();
    });

    it("and leaves another scheme's claim to lapse, as before", async () => {
        const triggerId = await insertTrigger({ webhookSignatureScheme: "native" });
        const first = (await deliver(triggerId, "native"))!;

        world.chargeOk = false;
        expect(await admit(first)).toBe(DAILY_LIMIT_MESSAGE);
        expect(await claims()).toHaveLength(1);
        expect(await deliver(triggerId, "native")).toBeUndefined();
    });
});

describe("executeTrigger gives a gitlab-token claim back when the delivery never runs", () => {
    it("when the trigger was disabled between acceptance and execution, so a redelivery after re-enabling runs", async () => {
        const triggerId = await insertTrigger();
        const first = (await deliver(triggerId))!;

        await harness.run(async (ctx: any) => await ctx.db.patch(triggerId, { enabled: false }));
        await execute(first);

        expect(world.agentRuns).toBe(0);
        expect(await claims()).toEqual([]);

        await harness.run(async (ctx: any) => await ctx.db.patch(triggerId, { enabled: true }));

        const redelivery = await deliver(triggerId);

        expect(redelivery).toBeDefined();
        await execute(redelivery!);
        expect(world.agentRuns).toBe(1);
    });

    it("when admission throws before the agent starts", async () => {
        const triggerId = await insertTrigger();
        const first = (await deliver(triggerId))!;

        world.userLookupThrows = true;
        await execute(first);

        expect(world.agentRuns).toBe(0);
        expect(await claims()).toEqual([]);
    });

    it("but keeps it once the agent ran", async () => {
        const triggerId = await insertTrigger();
        const first = (await deliver(triggerId))!;

        await execute(first);

        expect(world.agentRuns).toBe(1);
        expect(await claims()).toEqual([expect.objectContaining({ scope: TRIGGER_DELIVERY_SCOPE })]);
        expect(await deliver(triggerId)).toBeUndefined();
    });

    it("and does not release the claim of another scheme", async () => {
        const triggerId = await insertTrigger({ webhookSignatureScheme: "native" });
        const first = (await deliver(triggerId, "native"))!;

        await harness.run(async (ctx: any) => await ctx.db.patch(triggerId, { enabled: false }));
        await execute(first);

        expect(await claims()).toHaveLength(1);
    });
});
