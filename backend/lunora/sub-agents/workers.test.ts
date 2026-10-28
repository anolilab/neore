/**
 * Workers: a sub-agent thread that outlives one run. Driven against the real schema —
 * one thread for every dispatch, the dispatch claim taken before the rate limit, the
 * charge at the claim (once), and the tool subset rule.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import type { WorkerRunArgs } from "./functions";
import { admitSubAgentRun, admitWorkerRun, cancelSubAgentRunsForStop, claimQueuedRun, finishRun, isWorkerThread } from "./functions";
import { intersectWithLeadTools, SUB_AGENT_MAX_CONCURRENT, SUB_AGENT_MAX_TOOLS } from "./logic";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let userId: string;
let leadId: string;

const insertUser = async (fields: Record<string, unknown> = {}) =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("user", {
                createdAt: 0,
                email: `u${String(Math.random())}@example.com`,
                emailVerified: true,
                name: "U",
                updatedAt: 0,
                ...fields,
            }),
    )) as string;

const insertThread = async (owner: string, fields: Record<string, unknown> = {}) =>
    (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: owner, ...fields }))) as string;

/** `admitWorkerRun` as a lead's tool call: the call id is the dedupe key. */
const dispatch = async (overrides: Partial<WorkerRunArgs> = {}) =>
    await harness.run(async (ctx: any) => await admitWorkerRun(ctx, { parentThreadId: leadId, task: "Research the topic", userId, ...overrides }));

const create = async (overrides: Partial<WorkerRunArgs> = {}) => {
    const result = await dispatch({ name: "Researcher", toolCallId: "call-create", ...overrides });

    if ("error" in result) {
        throw new Error(result.error);
    }

    return result;
};

const ONLY_OWNER = /Only the owner/u;
const MISSING_TOOL = /shellExecution/u;
const FAN_OUT_CAP = /At most 3/u;
const LIFETIME_CAP = /at most 5 sub-agents of its own/u;
const DAILY_LIMIT = /daily limit/u;

const runs = async () => (await harness.run(async (ctx: any) => await ctx.db.query("subAgentRuns").collect())) as any[];
const rateLimitKeys = async () =>
    ((await harness.run(async (ctx: any) => await ctx.db.query("rateLimits").collect())) as { key: string }[]).map((row) => decodeURIComponent(row.key));
const claim = async (runId: string) => await harness.run(async (ctx: any) => await claimQueuedRun(ctx, runId as never));
const finish = async (runId: string) => await harness.run(async (ctx: any) => await finishRun(ctx, runId as never, { kind: "succeeded", result: "done" }));

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    userId = await insertUser();
    leadId = await insertThread(userId);
});

afterEach(() => {
    harness.close();
});

describe("creating a worker", () => {
    it("creates the child thread with the first run, linked under the lead, charging nothing", async () => {
        const { created, run } = await create({ parentModel: "gpt-4o-mini" });

        expect(created).toBe(true);
        expect(run).toMatchObject({ depth: 1, mode: "worker", parentThreadId: leadId, runner: { kind: "headless" }, status: "queued", userId });

        const thread = await harness.run(async (ctx: any) => await ctx.db.get(run.childThreadId));

        expect(thread).toMatchObject({ status: "active", tags: ["sub-agent", "worker"], title: "Researcher", userId });

        const relationships = await harness.run(async (ctx: any) => await ctx.db.query("threadRelationships").collect());

        expect(relationships).toHaveLength(1);
        expect(relationships[0]).toMatchObject({ branchType: "subagent", parentThreadId: leadId, threadId: run.childThreadId });

        const keys = await rateLimitKeys();

        expect(keys.some((key) => key.includes("subAgents/run:free"))).toBe(true);
        expect(keys.some((key) => key.includes("chat/dailyText") || key.includes("tasks/dailyRuns"))).toBe(false);
        expect(await harness.run(async (ctx: any) => await isWorkerThread(ctx, run.childThreadId!))).toBe(true);
    });

    it("refuses a lead the caller does not own", async () => {
        const stranger = await insertUser();

        expect(await dispatch({ toolCallId: "call-x", userId: stranger })).toMatchObject({ error: expect.stringMatching(ONLY_OWNER), kind: "other" });
        expect(await runs()).toHaveLength(0);
    });

    it("refuses a tool the lead lacks, and charges nothing for the refusal", async () => {
        const result = await dispatch({ leadTools: ["webSearch"], toolAllowlist: ["webSearch", "shellExecution"], toolCallId: "call-tools" });

        expect(result).toMatchObject({ error: expect.stringMatching(MISSING_TOOL), kind: "other" });
        expect(await runs()).toHaveLength(0);
        expect(await rateLimitKeys()).toHaveLength(0);
    });

    it("stores the lead's tools when none are requested, and only the requested ones when they are a subset", async () => {
        const all = await create({ leadTools: ["dateTime", "webSearch"] });

        expect(all.run.toolAllowlist).toStrictEqual(["dateTime", "webSearch"]);

        const some = await create({ leadTools: ["dateTime", "webSearch"], toolAllowlist: ["webSearch"], toolCallId: "call-2" });

        expect(some.run.toolAllowlist).toStrictEqual(["webSearch"]);
    });

    it("lets a person's request stand when no lead run vouches for it", () => {
        expect(intersectWithLeadTools(["a", "b"], undefined)).toStrictEqual({ tools: ["a", "b"] });
        expect(intersectWithLeadTools(undefined, undefined)).toStrictEqual({ tools: undefined });
    });

    it("stores at most SUB_AGENT_MAX_TOOLS of the lead's tools when none are requested", () => {
        const lead = Array.from({ length: SUB_AGENT_MAX_TOOLS + 10 }, (_, index) => `tool${String(index)}`);

        expect(intersectWithLeadTools(undefined, lead)).toStrictEqual({ tools: lead.slice(0, SUB_AGENT_MAX_TOOLS) });
    });
});

describe("dispatching to a worker", () => {
    it("runs the second dispatch in the same child thread, copying the first run's tools and runner", async () => {
        const first = await create({ leadTools: ["webSearch"], toolAllowlist: ["webSearch"] });

        await claim(first.run._id);
        await finish(first.run._id);

        const second = await dispatch({ childThreadId: first.run.childThreadId, task: "And the second part", toolCallId: "call-2" });

        expect(second).toMatchObject({
            created: true,
            run: { childThreadId: first.run.childThreadId, mode: "worker", runner: { kind: "headless" }, toolAllowlist: ["webSearch"] },
        });
        expect(await runs()).toHaveLength(2);

        const threads = await harness.run(async (ctx: any) => await ctx.db.query("threads").collect());

        // The lead and the one worker thread.
        expect(threads).toHaveLength(2);
    });

    it("returns the same run for a redelivered tool call and consumes nothing more", async () => {
        const first = await create();
        const usedKeys = await rateLimitKeys();
        const used = usedKeys.length;
        const again = await dispatch({ name: "Researcher", toolCallId: "call-create" });

        expect(again).toMatchObject({ created: false, run: { _id: first.run._id } });
        expect(await runs()).toHaveLength(1);
        const keysAfter = await rateLimitKeys();

        expect(keysAfter).toHaveLength(used);
    });

    it("takes the claim before the rate limit: a redelivery finds its claim even with the limit spent", async () => {
        const first = await create();

        // Spend the hourly limit; the redelivery must still answer from its claim.
        for (let index = 0; index < 10; index += 1) {
            await dispatch({ name: `W${String(index)}`, toolCallId: `fill-${String(index)}` });
        }

        expect(await dispatch({ name: "Researcher", toolCallId: "call-create" })).toMatchObject({ created: false, run: { _id: first.run._id } });
    });

    it("gives the claim back when the dispatch is refused, so a retry of the same key is judged afresh", async () => {
        const first = await create();

        await claim(first.run._id);

        const busy = await dispatch({ childThreadId: first.run.childThreadId, toolCallId: "call-busy" });

        expect(busy).toMatchObject({ kind: "busy" });

        await finish(first.run._id);

        expect(await dispatch({ childThreadId: first.run.childThreadId, toolCallId: "call-busy" })).toMatchObject({ created: true });
    });

    it("refuses a dispatch to a worker of another lead or another owner as not found", async () => {
        const first = await create();
        const otherLead = await insertThread(userId);
        const stranger = await insertUser();
        const strangerLead = await insertThread(stranger);

        await claim(first.run._id);
        await finish(first.run._id);

        expect(await dispatch({ childThreadId: first.run.childThreadId, parentThreadId: otherLead, toolCallId: "c-a" })).toMatchObject({ kind: "not_found" });
        expect(await dispatch({ childThreadId: first.run.childThreadId, parentThreadId: strangerLead, toolCallId: "c-b", userId: stranger })).toMatchObject({
            kind: "not_found",
        });
    });

    it("counts a message to an existing worker against the concurrent cap, not the lifetime cap", async () => {
        // Premium, so the hourly start limit does not end the loop below first.
        await harness.run(async (ctx: any) => await ctx.db.patch(userId, { plan: "premium" }));

        const workers = [];

        for (let index = 0; index < SUB_AGENT_MAX_CONCURRENT; index += 1) {
            workers.push(await create({ name: `W${String(index)}`, toolCallId: `c-${String(index)}` }));
        }

        expect(await dispatch({ name: "One too many", toolCallId: "c-over" })).toMatchObject({ error: expect.stringMatching(FAN_OUT_CAP) });

        // Depth 2: a worker's own lead may message its worker more than five times.
        const nested = workers[0]!.run.childThreadId as string;
        const nestedWorker = await create({ parentThreadId: nested, toolCallId: "nested-1" });

        for (let index = 0; index < 7; index += 1) {
            await claim(nestedWorker.run._id);
            await finish(nestedWorker.run._id);

            const again = await dispatch({ childThreadId: nestedWorker.run.childThreadId, parentThreadId: nested, toolCallId: `nested-msg-${String(index)}` });

            expect(again).toMatchObject({ created: true });

            await claim((again as any).run._id);
            await finish((again as any).run._id);
        }
    });

    it("keeps the first run's skill on every later run", async () => {
        const first = await create({ skillSlug: "research" });

        await claim(first.run._id);
        await finish(first.run._id);

        const second = await dispatch({ childThreadId: first.run.childThreadId, toolCallId: "call-2" });

        expect(second).toMatchObject({ created: true, run: { skillSlug: "research" } });
    });

    it("counts a worker once toward the lifetime cap however many runs it had, for a one-shot sub-agent too", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch(userId, { plan: "premium" }));

        const lead = await create();
        const nested = lead.run.childThreadId as string;
        const worker = await create({ name: "Only", parentThreadId: nested, toolCallId: "n-0" });
        let latest: string = worker.run._id;

        for (let index = 0; index < 6; index += 1) {
            await claim(latest);
            await finish(latest);

            const again = (await dispatch({ childThreadId: worker.run.childThreadId, parentThreadId: nested, toolCallId: `n-msg-${String(index)}` })) as {
                run: { _id: string };
            };

            latest = again.run._id;
        }

        await claim(latest);
        await finish(latest);

        // Seven runs, one child: the lifetime cap of five is not reached.
        const oneShot = await harness.run(
            async (ctx: any) => await admitSubAgentRun(ctx, { parentThreadId: nested, task: "Side question", toolCallId: "one-shot", userId }),
        );

        expect(oneShot).not.toHaveProperty("error");
    });

    it("refuses a second distinct worker beyond the lifetime cap at depth 2", async () => {
        const first = await create();
        const nested = first.run.childThreadId as string;

        for (let index = 0; index < 5; index += 1) {
            const worker = await create({ name: `N${String(index)}`, parentThreadId: nested, toolCallId: `n-${String(index)}` });

            await claim(worker.run._id);
            await finish(worker.run._id);
        }

        expect(await dispatch({ name: "Sixth", parentThreadId: nested, toolCallId: "n-6" })).toMatchObject({
            error: expect.stringMatching(LIFETIME_CAP),
        });
    });
});

describe("a worker run's claim", () => {
    it("charges the daily quotas once as it leaves queued; a redelivered claim charges nothing", async () => {
        const { run } = await create();

        const beforeKeys = await rateLimitKeys();

        expect(beforeKeys.filter((key) => key.includes("chat/dailyText"))).toHaveLength(0);
        expect(await claim(run._id)).toMatchObject({ _id: run._id });

        const afterKeys = await rateLimitKeys();

        expect(afterKeys.some((key) => key.includes("chat/dailyText:free"))).toBe(true);

        const spent = await harness.run(async (ctx: any) => await ctx.db.query("rateLimits").collect());

        expect(await claim(run._id)).toBeNull();
        expect(await harness.run(async (ctx: any) => await ctx.db.query("rateLimits").collect())).toStrictEqual(spent);
    });

    it("marks the worker's thread running, and active again when the run ends", async () => {
        const { run } = await create();
        const statusOf = async () => ((await harness.run(async (ctx: any) => await ctx.db.get(run.childThreadId))) as { status: string }).status;

        await claim(run._id);
        expect(await statusOf()).toBe("running");
        await finish(run._id);
        expect(await statusOf()).toBe("active");
    });

    it("ends the run as failed, charging nothing more, when the daily limit is spent", async () => {
        const { run } = await create();

        // The free tier's daily text allowance, spent.
        await harness.run(async (ctx: any) => {
            const { createRatelimit } = await import("../lib/rate-limiter");
            const limiter = createRatelimit("chat/dailyText:free", ctx.db as never);

            for (let index = 0; index < 1000; index += 1) {
                const { ok } = await limiter.limit(userId);

                if (!ok) {
                    break;
                }
            }
        });

        expect(await claim(run._id)).toBeNull();

        const [failed] = await runs();

        expect(failed).toMatchObject({ error: expect.stringMatching(DAILY_LIMIT), status: "failed" });
    });
});

describe("archiving a worker", () => {
    const archive = async (threadId: string) => await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { status: "archived" }));
    const statusOf = async (threadId: string) => ((await harness.run(async (ctx: any) => await ctx.db.get(threadId))) as { status: string }).status;

    it("stays archived after the running run ends, and the next dispatch is refused", async () => {
        const { run } = await create();

        await claim(run._id);
        await archive(run.childThreadId!);
        await finish(run._id);

        expect(await statusOf(run.childThreadId!)).toBe("archived");
        expect(await dispatch({ childThreadId: run.childThreadId, toolCallId: "call-2" })).toMatchObject({ kind: "archived" });
    });

    it("cancels a queued run at the claim without charging it", async () => {
        const { run } = await create();

        await archive(run.childThreadId!);

        expect(await claim(run._id)).toBeNull();

        const [cancelled] = await runs();
        const keys = await rateLimitKeys();

        expect(cancelled).toMatchObject({ status: "cancelled" });
        expect(keys.filter((key) => key.includes("chat/dailyText"))).toHaveLength(0);
        expect(await statusOf(run.childThreadId!)).toBe("archived");
    });
});

describe("a Stop in a worker's thread", () => {
    it("cancels its active run, not an older finished one", async () => {
        const first = await create();

        await claim(first.run._id);
        await finish(first.run._id);

        const second = (await dispatch({ childThreadId: first.run.childThreadId, toolCallId: "call-2" })) as { run: { _id: string } };

        await claim(second.run._id);

        const cancelled = await harness.run(async (ctx: any) => await cancelSubAgentRunsForStop(ctx, first.run.childThreadId!, userId));

        expect(cancelled).toBe(1);
        const all = await runs();

        expect(all.find((run) => run._id === second.run._id)).toMatchObject({ status: "cancelled" });
    });
});
