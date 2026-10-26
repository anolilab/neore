/**
 * A `gitlab-token` delivery is claimed for years, so every way it can end WITHOUT a
 * run must give the claim back: GitLab's retry of a delivery that never ran has to run.
 * A run that did execute keeps its claim, and the other schemes' claims lapse as before.
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { v } from "lunorash/server";

import { registeredApi, registerModule } from "../../test/registered-api";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/internal";
import schema from "../schema";
import { releaseClaim, retryReleaseKey, TRIGGER_DELIVERY_SCOPE } from "../lib/claim-once";
import { hmacSha256Hex } from "../lib/crypto";
import { DAILY_LIMIT_MESSAGE } from "../tasks/account";
import { executeTrigger } from "./execute";
import { admitTriggerRun } from "./functions";
import handleTriggerWebhook from "./http";

const world = vi.hoisted(() => {
    return {
        agentRuns: 0,
        chargeOk: true,
        failAt: undefined as "generate" | "keys" | "thread" | undefined,
        registry: new Map<string, unknown>(),
        releaseFailures: 0,
        userExists: true,
        userLookupThrows: false,
    };
});

vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), world.registry));

vi.mock("../chat/lib/headless-run", () => {
    return {
        // The stages of the real run (`headless-run.ts`) in order: provider keys, thread, then the model call, announced by `onGenerationStart`.
        runHeadlessAgent: async (_ctx: unknown, options: { onGenerationStart?: () => Promise<void> | void }) => {
            if (world.failAt === "keys") {
                throw new Error("provider keys unavailable");
            }

            if (world.failAt === "thread") {
                throw new Error("thread creation failed");
            }

            await options.onGenerationStart?.();

            if (world.failAt === "generate") {
                throw new Error("model call failed");
            }

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
    // The real release, failing while `world.releaseFailures` lasts.
    world.registry.set(
        "lib_claim_once:releaseKey",
        internalMutation
            .input({ claimedAt: v.optional(v.number()), key: v.string(), scope: v.string() })
            .output(v.null())
            .mutation(async ({ args: { claimedAt, key, scope }, ctx }) => {
                if (world.releaseFailures > 0) {
                    world.releaseFailures -= 1;

                    throw new Error("database unavailable");
                }

                await releaseClaim(ctx, scope, key, claimedAt);

                return null;
            }),
    );
});

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    world.agentRuns = 0;
    world.chargeOk = true;
    world.userExists = true;
    world.userLookupThrows = false;
    world.failAt = undefined;
    world.releaseFailures = 0;
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

type Job = { args: Record<string, unknown>; delay: number; reference: unknown };

/** What the last `deliver` saw: its status and everything it put on the scheduler. */
const lastDelivery: { jobs: Job[]; status: number } = { jobs: [], status: 0 };

/**
 * One delivery through the real handler; the args it scheduled for the run, or `undefined` when it was answered as a
 * duplicate. `lastDelivery` keeps the status and the other scheduled jobs. Every reference is a registered procedure
 * (the mocked `internal`), so it runs as is.
 */
const deliver = async (
    triggerId: string,
    scheme: "gitlab-token" | "native" = "gitlab-token",
    { body = BODY, filters, status = 200 }: { body?: string; filters?: unknown[]; status?: number } = {},
): Promise<Scheduled | undefined> => {
    const scheduled: Scheduled[] = [];
    const jobs: Job[] = [];
    const context = {
        runMutation: async (reference: never, args: unknown) => await harness.run(async (ctx: any) => await ctx.runMutation(reference, args)),
        runQuery: async () => {
            return { enabled: true, filters, type: "webhook", userId: "u", webhookSecret: SECRET, webhookSignatureScheme: scheme };
        },
        scheduler: {
            runAfter: async (delay: number, reference: unknown, args: Record<string, unknown>) => {
                if (reference === internal.triggers.execute.executeTrigger) {
                    scheduled.push(args as Scheduled);
                } else {
                    jobs.push({ args, delay, reference });
                }
            },
        },
    };
    const headers: Record<string, string> =
        scheme === "gitlab-token"
            ? { "x-gitlab-event-uuid": UUID, "x-gitlab-token": SECRET }
            : { "x-hub-signature-256": `sha256=${await hmacSha256Hex(SECRET, body)}` };
    const response = await handleTriggerWebhook(context as never, new Request("https://x/triggers/webhook/t", { body, headers, method: "POST" }), triggerId);

    lastDelivery.jobs = jobs;
    lastDelivery.status = response.status;
    expect(response.status).toBe(status);

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

describe("a release that fails is retried, not dropped", () => {
    const runRetry = async (job: Job) => await harness.run(async (ctx: any) => await ctx.runMutation(retryReleaseKey, job.args));

    it("in executeTrigger: a retry is scheduled and noted in the history, and once it succeeds the redelivery runs", async () => {
        const triggerId = await insertTrigger();
        const first = (await deliver(triggerId))!;

        await harness.run(async (ctx: any) => await ctx.db.patch(triggerId, { enabled: false }));
        world.releaseFailures = 1;
        await execute(first);

        // The claim is still held, but a retry of its release is scheduled...
        expect(await claims()).toHaveLength(1);

        const [job] = harness.scheduler.list();

        expect(job!.args).toEqual({ ...first.claim, attempt: 1 });

        // ...and the owner can see why the delivery is still refused.
        const history = (await harness.run(async (ctx: any) => await ctx.db.query("triggerExecutions").collect())) as { error?: string; status: string }[];

        expect(history).toEqual([expect.objectContaining({ error: expect.stringContaining("retry is scheduled"), status: "failed" })]);
        expect(await deliver(triggerId)).toBeUndefined();

        // The next attempt succeeds; the redelivery then runs.
        await runRetry({ args: job!.args as Record<string, unknown>, delay: 0, reference: undefined });
        expect(await claims()).toEqual([]);
        await harness.run(async (ctx: any) => await ctx.db.patch(triggerId, { enabled: true }));

        const redelivery = await deliver(triggerId);

        expect(redelivery).toBeDefined();
        await execute(redelivery!);
        expect(world.agentRuns).toBe(1);
    });

    it("in executeTrigger after a failure before the model: the failed release is noted on the execution it fails", async () => {
        const triggerId = await insertTrigger();
        const first = (await deliver(triggerId))!;

        world.failAt = "keys";
        world.releaseFailures = 1;
        await execute(first);

        expect(harness.scheduler.list()).toHaveLength(1);

        const history = (await harness.run(async (ctx: any) => await ctx.db.query("triggerExecutions").collect())) as { error?: string; status: string }[];

        expect(history).toEqual([expect.objectContaining({ error: expect.stringContaining("retry is scheduled"), status: "failed" })]);
    });

    it("in the webhook handler: the request fails (not 2xx), a retry is scheduled, and the redelivery runs once it succeeds", async () => {
        const triggerId = await insertTrigger();
        const filters = [{ op: "equals", path: "object_kind", value: "push" }];

        // A filtered delivery gives its claim back before answering; here the release fails.
        world.releaseFailures = 1;
        expect(await deliver(triggerId, "gitlab-token", { filters, status: 500 })).toBeUndefined();
        expect(await claims()).toHaveLength(1);
        expect(lastDelivery.jobs).toHaveLength(1);

        const [job] = lastDelivery.jobs;

        expect(job!.args).toMatchObject({ attempt: 1, scope: TRIGGER_DELIVERY_SCOPE });
        expect(job!.delay).toBeGreaterThan(0);

        await runRetry(job!);
        expect(await claims()).toEqual([]);

        // The owner fixed the filters meanwhile.
        expect(await deliver(triggerId, "gitlab-token", { filters: [{ op: "equals", path: "object_kind", value: "merge_request" }] })).toBeDefined();
    });

    it("in the webhook handler: a native trigger's failed release is not retried in the background", async () => {
        const triggerId = await insertTrigger({ webhookSignatureScheme: "native" });
        const filters = [{ op: "equals", path: "object_kind", value: "push" }];

        world.releaseFailures = 1;
        expect(await deliver(triggerId, "native", { filters, status: 500 })).toBeUndefined();
        expect(lastDelivery.jobs).toEqual([]);
    });

    it("is idempotent: a second attempt, or one for a claim a newer holder replaced, deletes nothing", async () => {
        const triggerId = await insertTrigger();
        const first = (await deliver(triggerId))!;
        const retry = { args: { ...first.claim, attempt: 1 }, delay: 0, reference: undefined };

        await runRetry(retry);
        expect(await claims()).toEqual([]);
        await runRetry(retry);

        const redelivery = (await deliver(triggerId))!;

        expect(redelivery.claim!.claimedAt).toBe(first.claim!.claimedAt);

        vi.setSystemTime(NOW + 1);
        await harness.run(async (ctx: any) => {
            const [row] = await ctx.db.query("idempotencyClaims").collect();

            await ctx.db.patch(row._id, { claimedAt: NOW + 1 });
        });

        // The retry names the old claim (`claimedAt` NOW): the newer holder keeps its row.
        await runRetry(retry);
        expect(await claims()).toHaveLength(1);
    });
});

describe("a gitlab-token claim is kept only for a run that reached the model", () => {
    it("gives it back when provider keys fail to load, so the redelivery runs", async () => {
        const triggerId = await insertTrigger();
        const first = (await deliver(triggerId))!;

        world.failAt = "keys";
        await execute(first);

        expect(world.agentRuns).toBe(0);
        expect(await claims()).toEqual([]);

        world.failAt = undefined;

        const redelivery = await deliver(triggerId);

        expect(redelivery).toBeDefined();
        await execute(redelivery!);
        expect(world.agentRuns).toBe(1);
    });

    it("gives it back when the thread cannot be created, so the redelivery runs", async () => {
        const triggerId = await insertTrigger();
        const first = (await deliver(triggerId))!;

        world.failAt = "thread";
        await execute(first);

        expect(await claims()).toEqual([]);
        expect(await deliver(triggerId)).toBeDefined();
    });

    it("keeps it when the model call itself fails, so the replay stays a duplicate", async () => {
        const triggerId = await insertTrigger();
        const first = (await deliver(triggerId))!;

        world.failAt = "generate";
        await execute(first);

        expect(await claims()).toEqual([expect.objectContaining({ scope: TRIGGER_DELIVERY_SCOPE })]);
        expect(await deliver(triggerId)).toBeUndefined();
    });
});
