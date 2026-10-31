/**
 * The review job (`reviewGoalRound`) with the real goal state machine and a
 * scripted reviewer: a met verdict stops, an unmet one queues the next round
 * with the reason as its instruction, a failing reviewer ends the goal, and a
 * redelivered job spends no second reviewer call and queues no second round.
 *
 * Faked at the edge only: the utility-model call (`generateText`) and the
 * gateway binding. The jobs queue is the test stub that records what is sent.
 */
/* eslint-disable unicorn/no-await-expression-member -- the assertions read one field of an awaited result */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../../test/registered-api";
import { jobsQueueMessages } from "../../../test/stubs/cloudflare-workers";
import { v } from "lunorash/server";
import { internalMutation } from "../../_generated/server";
import schema from "../../schema";

const { modelState, registry, users } = vi.hoisted(() => {
    return {
        modelState: {
            calls: [] as { prompt: string }[],
            during: undefined as (() => Promise<void>) | undefined,
            failWith: undefined as Error | undefined,
            reply: '{"met": false, "reason": "x"}',
        },
        registry: new Map<string, unknown>(),
        users: new Map<string, { isAnonymous?: boolean; role?: string }>(),
    };
});

vi.mock("../../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("../../auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../../auth/lib/better-auth-queries")>()),
        getUser: async (_ctx: unknown, userId: string) => {
            const user = users.get(userId);

            return user ? { _id: userId, ...user } : null;
        },
    };
});

vi.mock("../../lib/services", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../../lib/services")>()), gatewayFetch: () => async () => new Response("unreachable", { status: 500 }) };
});

vi.mock("../../lib/utility-model", () => {
    return {
        getUtilityModel: async () => {
            return { modelId: "reviewer" };
        },
    };
});

vi.mock("ai", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("ai")>()),
        generateText: vi.fn(async (options: { prompt: string }) => {
            modelState.calls.push({ prompt: options.prompt });
            await modelState.during?.();

            if (modelState.failWith) {
                throw modelState.failWith;
            }

            return { text: modelState.reply };
        }),
    };
});

const { handOffToGoalReview, reviewGoalRound } = await import("./execute");

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "owner-1";

let harness: Harness;
let threadId: string;
let promptId: string;
let goalId: string;

beforeAll(async () => {
    registerModule(registry, "agent_threads", await import("../../agent/threads"));
    registerModule(registry, "chat_goals_internal", await import("./internal"));
    registerModule(registry, "chat_streaming_persistent_library", await import("../streaming/persistent/library"));
    // Scheduled once a goal has ended; nothing here runs the scheduler.
    registry.set(
        "chat_functions:generateFollowupSuggestionsForThread",
        internalMutation.input({ threadId: v.string(), userId: v.string() }).mutation(async () => null),
    );
}, 60_000);

beforeEach(async () => {
    jobsQueueMessages.length = 0;
    modelState.calls = [];
    modelState.during = undefined;
    modelState.failWith = undefined;
    modelState.reply = '{"met": false, "reason": "The charts are missing."}';
    users.clear();
    users.set(OWNER, {});
    harness = lunoraTest(schema as never);

    const { internal } = await import("../../_generated/internal");

    ({ goalId, promptId, threadId } = await harness.run(async (ctx: any) => {
        const thread = await ctx.db.insert("threads", { status: "running", title: "Chat", userId: OWNER });
        const message = await ctx.db.insert("messages", {
            message: { content: "Make the report", role: "user" },
            order: 0,
            status: "success",
            stepOrder: 0,
            text: "Make the report",
            threadId: thread,
            tool: false,
            userId: OWNER,
        });

        await ctx.db.insert("messages", {
            message: { content: "Here is a draft.", role: "assistant" },
            order: 0,
            status: "success",
            stepOrder: 1,
            threadId: thread,
            tool: false,
            userId: OWNER,
        });

        const started = await ctx.runMutation(internal.chat.goals.internal.startGoal, {
            config: { model: "test-model" },
            promptMessageId: String(message),
            text: "Ship the report",
            threadId: thread,
            userId: OWNER,
        });

        return { goalId: String(started.goalId), promptId: String(message), threadId: String(thread) };
    }));
});

afterEach(() => {
    harness.close();
});

const review = async (round = 1): Promise<unknown> => await harness.action(async (ctx: any) => await ctx.runAction(reviewGoalRound, { goalId, round }));
const goal = async (): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.get(goalId));
const runs = (): { args: Record<string, any> }[] =>
    jobsQueueMessages
        .filter((message) => message.body.functionPath.includes("runStreamingAgent"))
        .map((message) => {
            return { args: message.body.args ?? {} };
        });

describe("reviewGoalRound", () => {
    it("stops when the reviewer says the goal is met", async () => {
        modelState.reply = '{"met": true, "reason": "The report is written."}';

        await review();

        expect(await goal()).toMatchObject({ round: 1, status: "met" });
        expect(runs()).toHaveLength(0);
        expect(modelState.calls).toHaveLength(1);
        // The reviewer reads the goal and the round's text.
        expect(modelState.calls[0]!.prompt).toContain("Ship the report");
        expect(modelState.calls[0]!.prompt).toContain("Here is a draft.");
    });

    it("queues the next round with the reviewer's reason as its instruction", async () => {
        await review();

        const [next] = runs();
        const state = await goal();

        expect(state).toMatchObject({ round: 1, status: "active" });
        expect(next!.args).toMatchObject({
            isAnonymous: false,
            streamingConfig: { contentType: "text", model: "test-model", shouldAutoContinue: true },
            threadId,
            userId: OWNER,
        });

        const instruction = await harness.run(async (ctx: any) => await ctx.db.get(next!.args.messageId));

        expect(JSON.stringify(instruction.message.content)).toContain("The charts are missing.");
        expect(instruction.agentName).toBe("neore:goal");
        expect(state.promptMessageId).toBe(next!.args.messageId);
    });

    it("carries the originating run's origin and skill into every further round", async () => {
        await harness.run(async (ctx: any) => {
            const row = await ctx.db.get(goalId);

            await ctx.db.patch(goalId, { config: { ...row.config, origin: "outside_agent", skill: { rawArgs: "the report", slug: "summarize" } } });
        });

        await review();

        const [next] = runs();

        expect(next!.args).toMatchObject({ origin: "outside_agent", skill: { rawArgs: "the report", slug: "summarize" } });
        // They are the run's own arguments, not part of the stream's saved config.
        expect(next!.args.streamingConfig).not.toHaveProperty("origin");
        expect(next!.args.streamingConfig).not.toHaveProperty("skill");
    });

    it("runs an ordinary goal as the user's own chat", async () => {
        await review();

        expect(runs()[0]!.args.origin).toBeUndefined();
        expect(runs()[0]!.args.skill).toBeUndefined();
    });

    it("ends the goal and gives the thread back when the verdict cannot be written", async () => {
        const key = "chat_goals_internal:recordGoalVerdict";
        const original = registry.get(key);

        registry.set(
            key,
            internalMutation
                .input({ costMicrodollars: v.number(), goalId: v.string(), met: v.boolean(), reason: v.string(), round: v.number() })
                .mutation(async () => {
                    throw new Error("write failed");
                }),
        );

        try {
            await review();
        } finally {
            registry.set(key, original);
        }

        expect(await goal()).toMatchObject({ status: "stopped", stopReason: "error" });
        expect(runs()).toHaveLength(0);
        expect((await harness.run(async (ctx: any) => await ctx.db.get(threadId))).status).toBe("active");
    });

    it("treats an unreadable verdict as not met and goes on", async () => {
        modelState.reply = "I think so?";

        await review();

        expect(await goal()).toMatchObject({ round: 1, status: "active" });
        expect(runs()).toHaveLength(1);
    });

    it("ends the goal, and gives the thread back, when the reviewer cannot be reached", async () => {
        modelState.failWith = new Error("gateway down");

        await review();

        expect(await goal()).toMatchObject({ status: "stopped", stopReason: "review_failed" });
        expect(runs()).toHaveLength(0);
        expect((await harness.run(async (ctx: any) => await ctx.db.get(threadId))).status).toBe("active");
    });

    it("leaves the thread alone when the goal was ended while the reviewer failed", async () => {
        const { internal } = await import("../../_generated/internal");

        modelState.failWith = new Error("gateway down");
        // The user presses Stop mid-review: the thread is `abort`, which is not the goal's to settle.
        modelState.during = async () => {
            await harness.run(async (ctx: any) => {
                await ctx.runMutation(internal.chat.goals.internal.endGoalsForThread, { reason: "user", threadId });
                await ctx.db.patch(threadId, { status: "abort" });
            });
        };

        await review();

        expect(await goal()).toMatchObject({ status: "stopped", stopReason: "user" });
        expect((await harness.run(async (ctx: any) => await ctx.db.get(threadId))).status).toBe("abort");
    });

    it("spends one reviewer call and queues one round however often the job is delivered", async () => {
        await review();
        await review();
        await review();

        expect(modelState.calls).toHaveLength(1);
        expect(runs()).toHaveLength(1);
        expect((await goal()).verdicts).toHaveLength(1);
    });

    it("does nothing for a goal that was stopped", async () => {
        const { internal } = await import("../../_generated/internal");

        await harness.run(async (ctx: any) => await ctx.runMutation(internal.chat.goals.internal.endGoalsForThread, { reason: "user", threadId }));
        await review();

        expect(modelState.calls).toHaveLength(0);
        expect(runs()).toHaveLength(0);
    });
});

describe("handOffToGoalReview", () => {
    it("queues the next review for a thread with an active goal, once per round", async () => {
        expect(await harness.action(async (ctx: any) => await handOffToGoalReview(ctx, threadId, { messageId: promptId }))).toBe(true);

        const jobs = jobsQueueMessages.filter((message) => message.body.functionPath.includes("reviewGoalRound"));

        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.body.args).toEqual({ goalId, round: 1 });
    });

    it("hands off nothing for an ordinary thread, or one whose goal ended", async () => {
        const { internal } = await import("../../_generated/internal");

        await harness.run(async (ctx: any) => await ctx.runMutation(internal.chat.goals.internal.endGoalsForThread, { reason: "user", threadId }));

        expect(await harness.action(async (ctx: any) => await handOffToGoalReview(ctx, threadId, { messageId: promptId }))).toBe(false);
        expect(jobsQueueMessages).toHaveLength(0);
    });

    it("hands an approval continuation to its own goal only, found through its stream", async () => {
        const streamFor = async (messageId: string): Promise<string> =>
            await harness.run(
                async (ctx: any) =>
                    await ctx.db.insert("persistentStreams", {
                        createdAt: Date.now(),
                        messageId,
                        status: "streaming",
                        streamingConfig: { contentType: "text", model: "test-model" },
                        threadId,
                        userId: OWNER,
                    }),
            );

        // A continuation of this goal's round is handed to it.
        expect(await harness.action(async (ctx: any) => await handOffToGoalReview(ctx, threadId, { streamId: await streamFor(promptId) }))).toBe(true);

        // One that answered an earlier prompt, before this goal replaced the one it belonged to, is not.
        jobsQueueMessages.length = 0;
        const earlier = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("messages", {
                    message: { content: "An older request", role: "user" },
                    order: 0,
                    status: "success",
                    stepOrder: 0,
                    text: "An older request",
                    threadId,
                    tool: false,
                    userId: OWNER,
                }),
        );

        expect(await harness.action(async (ctx: any) => await handOffToGoalReview(ctx, threadId, { streamId: await streamFor(String(earlier)) }))).toBe(false);
        expect(jobsQueueMessages).toHaveLength(0);
    });
});
