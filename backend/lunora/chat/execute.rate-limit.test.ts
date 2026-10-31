/**
 * `runStreamingAgent` (`execute.ts`) when the provider rate-limits the model call: the run pauses on its
 * stream and resumes by itself at the provider's retry time, instead of failing.
 *
 * Real: the harness schema, the agent client saving real rows, the stream gate and claims
 * (`claimStreamRun`, `claimRunResume`), the pause and "Retry now" mutations, the stop.
 * Faked at the edges: the language model (the error it throws is the one `GatewayLanguageModel` throws, with its
 * `rateLimit` field), the jobs queue (what `enqueueJob` is asked is the assertion), and the reads of tables or keys
 * the harness cannot hold — the same edges as `execute.run.test.ts`.
 */
import { lunoraTest } from "@lunora/testing";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { RetryError, tool } from "ai";
import { v } from "lunorash/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { registeredApi, registerModule } from "../../test/registered-api";
import { internalQuery } from "../_generated/server";
import schema from "../schema";
import { scriptedModel, textStep, toolCallStep } from "./group/test-models";
import { RATE_LIMIT_RESUME_SLACK_MS } from "./lib/rate-limit-pause";

const { enqueued, modelState, registry } = vi.hoisted(() => {
    return {
        enqueued: [] as { args: Record<string, unknown>; delayMs: number | undefined }[],
        modelState: { builtAgents: 0, model: undefined as unknown, withTools: false },
        registry: new Map<string, unknown>(),
    };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

// The signed-in caller of the procedures under test, taken from the harness identity.
vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    const sessionFrom = async (context: { auth: { userId?: string | null } }) =>
        context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null;

    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/rate-limiter")>()), rateLimitGuard: async () => undefined };
});

vi.mock("../lib/job-queue", () => {
    return {
        enqueueJob: vi.fn(async (_ref: unknown, args: Record<string, unknown>, options: { delayMs?: number } = {}) => {
            enqueued.push({ args, delayMs: options.delayMs });
        }),
    };
});

vi.mock("../lib/services", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/services")>()),
        gatewayFetch: () => async () => {
            throw new Error("execute.rate-limit.test: the gateway binding must not be reached");
        },
    };
});

vi.mock("../usage/schedule", async (importOriginal) => {
    const original = await importOriginal<typeof import("../usage/schedule")>();

    return { ...original, scheduleReplyUsage: vi.fn(original.scheduleReplyUsage) };
});

vi.mock("./lib/agent-run", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./lib/agent-run")>()),
        loadRunContext: vi.fn(async () => {
            return {
                botId: undefined,
                contextParts: [],
                knowledgeSources: [],
                memoryEnabled: false,
                prefs: { language: undefined, location: undefined, personalization: undefined, timezone: "Europe/Berlin" },
                researchDepth: "balanced",
                retrievedMemories: [],
                threadSettings: null,
                userProviderKeys: undefined,
            };
        }),
        resolveRunModel: vi.fn(async () => {
            return { allowTools: modelState.withTools, customProvider: undefined };
        }),
    };
});

vi.mock("./lib/agent-tools", () => {
    return {
        buildAgentTools: vi.fn(async () => {
            return {
                mcpClients: [],
                mcpLabels: {},
                mcpServerNames: [],
                permissionKeys: {},
                tools: { echo: tool({ description: "Echo", execute: async () => "echoed", inputSchema: z.object({}) }) },
            };
        }),
    };
});

vi.mock("./group/run", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("./group/run")>()), runGroupTurn: vi.fn(async () => undefined) };
});

vi.mock("./lib/get-agent", () => {
    return {
        default: async (model: string, options: { maxSteps?: number; tools?: Record<string, never> }) => {
            modelState.builtAgents += 1;

            const { Agent } = await import("../agent/client");
            const { api } = await import("../_generated/api");

            return new Agent(api as never, {
                instructions: "Be brief.",
                languageModel: modelState.model as never,
                maxSteps: options.maxSteps ?? 5,
                name: model,
                tools: options.tools as never,
            });
        },
    };
});

const { scheduleReplyUsage } = await import("../usage/schedule");
const { runStreamingAgent } = await import("./execute");
const { pauseRunForRateLimit, retryPausedRunsNow, stopActiveForThread } = await import("./streaming/persistent/library");

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "owner-1";
const RETRY_IN_MS = 42_000;

let harness: Harness;
let ids: { messageId: string; streamId: string; threadId: string };

/** The error `GatewayLanguageModel` throws for a gateway-reported rate limit. */
const rateLimited = (retryInMs: number | undefined = RETRY_IN_MS) =>
    Object.assign(new Error("Gateway model proxy failed (502): rate limited"), {
        rateLimit: { provider: "anthropic", ...(retryInMs !== undefined && { retryAt: Date.now() + retryInMs }), status: 429 },
        statusCode: 502,
    });

/** A model whose calls play `plan` in order: an `Error` is thrown, a script step is streamed. The last entry repeats. */
const planned = (plan: (Error | ReturnType<typeof textStep>)[]) => {
    let call = 0;
    const scripts = plan.map((entry) => (entry instanceof Error ? undefined : scriptedModel([entry])));

    return new MockLanguageModelV3({
        doStream: async (options) => {
            const index = Math.min(call, plan.length - 1);
            const entry = plan[index];

            call += 1;

            if (entry instanceof Error) {
                throw entry;
            }

            return await scripts[index]!.doStream(options);
        },
    });
};

beforeAll(async () => {
    registerModule(registry, "agent_branches", await import("../agent/branches"));
    registerModule(registry, "agent_messages", await import("../agent/messages"));
    registerModule(registry, "agent_streams", await import("../agent/streams"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "chat_streaming", await import("./streaming"));
    registerModule(registry, "chat_streaming_persistent_library", await import("./streaming/persistent/library"));

    registry.set(
        "chat_group_functions:getGroupRunConfig",
        internalQuery.input({ organizationId: v.optional(v.string()), threadId: v.string(), userId: v.string() }).query(async () => null as never),
    );
    registry.set(
        "auth_functions:getAgentModulePreferencesQuery",
        internalQuery.input({ userId: v.string() }).query(async () => {
            return { autoDetectComplexity: false, autoMediaEnrichment: false, enableDatasource: false, enableKnowledge: false, enablePlanner: false };
        }),
    );
    registry.set(
        "skills_executor:resolveSkillsForRun",
        internalQuery
            .input({
                organizationId: v.optional(v.string()),
                rawArgs: v.optional(v.string()),
                skillSlug: v.optional(v.string()),
                threadId: v.optional(v.string()),
                userId: v.string(),
            })
            .query(async () => ({ enabledSkills: [], invocation: null }) as never),
    );
    registry.set(
        "chat_functions:generateFollowupSuggestionsForThread",
        internalQuery.input({ threadId: v.string(), userId: v.string() }).query(async () => null),
    );
}, 60_000);

beforeEach(async () => {
    vi.mocked(scheduleReplyUsage).mockClear();
    enqueued.length = 0;
    modelState.builtAgents = 0;
    modelState.withTools = false;
    modelState.model = scriptedModel([textStep("Hello there.")]);

    harness = lunoraTest(schema as never);

    ids = await harness.run(async (ctx: any) => {
        const threadId = await ctx.db.insert("threads", { status: "running", title: "Chat", userId: OWNER });
        const messageId = await ctx.db.insert("messages", {
            message: { content: "Say hello", role: "user" },
            order: 0,
            status: "success",
            stepOrder: 0,
            text: "Say hello",
            threadId,
            tool: false,
            userId: OWNER,
        });
        const streamId = await ctx.db.insert("persistentStreams", {
            expiresAt: Date.now() + 60_000,
            messageId,
            status: "pending",
            streamingConfig: { contentType: "text", model: "test-model" },
            threadId,
            userId: OWNER,
        });

        return { messageId: String(messageId), streamId: String(streamId), threadId: String(threadId) };
    });
});

afterEach(() => {
    harness.close();
});

const run = async (extra: { resume?: string } = {}) =>
    await harness.action(
        async (ctx: any) =>
            await ctx.runAction(runStreamingAgent, {
                messageId: ids.messageId,
                streamId: ids.streamId,
                streamingConfig: { contentType: "text", model: "test-model" },
                threadId: ids.threadId,
                userId: OWNER,
                ...extra,
            }),
    );

interface RunState {
    chunkText: string;
    pause: { from: string; id: string; provider?: string; reason: string; retryAt: number; status: number } | undefined;
    pausedSteps: string[] | undefined;
    rows: { id: string; order: number; parent: string | undefined; role: string; status: string; stepOrder: number }[];
    streamStatus: string | undefined;
    threadStatus: string | undefined;
}

const readState = async (): Promise<RunState> =>
    await harness.run(async (ctx: any) => {
        const thread = await ctx.db.get(ids.threadId as never);
        const stream = await ctx.db.get(ids.streamId as never);
        const chunks = await ctx.db
            .query("persistentChunks")
            .withIndex("by_streamId_seq", (q: any) => q.eq("streamId", ids.streamId))
            .collect();
        const rows = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", ids.threadId))
            .collect();

        return {
            chunkText: chunks.map((chunk: { text: string }) => chunk.text).join(""),
            pause: stream?.pause,
            pausedSteps: stream?.pausedSteps,
            rows: rows.map((row: any) => {
                return {
                    id: String(row._id),
                    order: row.order,
                    parent: row.parentMessageId,
                    role: row.message?.role,
                    status: row.status,
                    stepOrder: row.stepOrder,
                };
            }),
            streamStatus: stream?.status,
            threadStatus: thread?.status,
        };
    });

describe("a provider rate limit on the first model call", () => {
    it("pauses the run instead of failing it, and queues its resume for the retry time", async () => {
        const before = Date.now();

        modelState.model = planned([rateLimited()]);

        await run();

        const state = await readState();

        // Still live: a stop, the live query and the expiry sweep see a run in progress.
        expect(["pending", "streaming"]).toContain(state.streamStatus);
        expect(state.threadStatus).toBe("running");
        expect(state.chunkText).not.toContain("Error:");
        expect(state.pause).toMatchObject({ provider: "anthropic", reason: "rate_limit", status: 429 });
        expect(state.pause!.retryAt).toBeGreaterThanOrEqual(before + RETRY_IN_MS);
        expect(state.pause!.retryAt).toBeLessThanOrEqual(Date.now() + RETRY_IN_MS);
        // The rejected step's empty placeholder is gone: nothing but the prompt is left in the thread.
        expect(state.rows.map((row) => row.role)).toStrictEqual(["user"]);
        expect(scheduleReplyUsage).not.toHaveBeenCalled();

        // Exactly one resume is queued: the same job, naming the pause, delayed to the retry time. Nothing waited here.
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]!.args).toMatchObject({ messageId: ids.messageId, resume: state.pause!.id, streamId: ids.streamId, userId: OWNER });
        // Queued a moment after the provider's time, so it does not land just before the limit lifts.
        expect(enqueued[0]!.delayMs).toBeGreaterThan(RETRY_IN_MS + RATE_LIMIT_RESUME_SLACK_MS - 5000);
        expect(enqueued[0]!.delayMs).toBeLessThanOrEqual(RETRY_IN_MS + RATE_LIMIT_RESUME_SLACK_MS);
    });

    it("keeps the pause visible to the live query that drives the countdown", async () => {
        modelState.model = planned([rateLimited()]);

        await run();

        const { getActiveStreamForThread } = await import("./streaming");
        const active = (await harness
            .withIdentity({ userId: OWNER } as never)
            .query(getActiveStreamForThread as never, { threadId: ids.threadId } as never)) as {
            pause: object;
        };

        expect(active).toMatchObject({ pause: { provider: "anthropic", reason: "rate_limit", status: 429 }, streamId: ids.streamId });
        expect(active.pause).not.toHaveProperty("run");
    });

    it("waits the default when the provider gave no retry time", async () => {
        modelState.model = planned([rateLimited(undefined)]);

        await run();

        const { pause } = await readState();

        expect(pause).toBeDefined();
        expect(enqueued[0]!.delayMs).toBeGreaterThan(25_000);
    });

    it("continues the same run when the resume arrives: one reply, no failed rows, one charge", async () => {
        modelState.model = planned([rateLimited(), textStep("Hello there.")]);

        await run();

        const paused = await readState();

        await run({ resume: paused.pause!.id });

        const state = await readState();

        // The same rows an uninterrupted run leaves: the prompt and one successful reply.
        expect(state.rows.map((row) => [row.role, row.status])).toStrictEqual([
            ["user", "success"],
            ["assistant", "success"],
        ]);
        expect(state.chunkText).toContain("Hello there.");
        expect(state.chunkText).not.toContain("Error:");
        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("active");
        expect(state.pause).toBeUndefined();
        expect(scheduleReplyUsage).toHaveBeenCalledOnce();
    });

    it("resumes once when its job is delivered twice", async () => {
        modelState.model = planned([rateLimited(), textStep("Hello there.")]);

        await run();

        const { pause } = await readState();

        await run({ resume: pause!.id });
        await run({ resume: pause!.id });

        const state = await readState();

        // One agent for the first run, one for the resume; the second delivery claimed nothing and built nothing.
        expect(modelState.builtAgents).toBe(2);
        expect(state.rows.filter((row) => row.role === "assistant")).toHaveLength(1);
        expect(scheduleReplyUsage).toHaveBeenCalledOnce();
    });

    it("ignores a redelivery of the original job while the run is paused", async () => {
        modelState.model = planned([rateLimited(), textStep("Hello there.")]);

        await run();
        await run();

        expect(modelState.builtAgents).toBe(1);
        const { streamStatus } = await readState();

        expect(["pending", "streaming"]).toContain(streamStatus);
    });

    it("ignores a resume that names an earlier pause", async () => {
        modelState.model = planned([rateLimited(), textStep("Hello there.")]);

        await run();
        await run({ resume: "not-this-pause" });

        expect(modelState.builtAgents).toBe(1);
        const { pause } = await readState();

        expect(pause).toBeDefined();
    });
});

describe("the caps", () => {
    it("fails the run, as before, when the provider asks for more than ten minutes", async () => {
        modelState.model = planned([rateLimited(10 * 60 * 1000 + 60_000)]);

        await run();

        const state = await readState();

        expect(state.chunkText).toContain("Error:");
        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("error");
        expect(state.pause).toBeUndefined();
        expect(enqueued).toHaveLength(0);
    });

    it("pauses for exactly ten minutes", async () => {
        modelState.model = planned([rateLimited(10 * 60 * 1000 - 1000)]);

        await run();

        const { pause } = await readState();

        expect(pause).toBeDefined();
    });

    it("fails a step that is rate-limited again after its resume (one pause per step)", async () => {
        modelState.model = planned([rateLimited()]);

        await run();

        const { pause } = await readState();

        await run({ resume: pause!.id });

        const state = await readState();

        expect(state.chunkText).toContain("Error:");
        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("error");
        expect(enqueued).toHaveLength(1);
    });

    it("fails the run on a fourth pause", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch(ids.streamId as never, { pausedSteps: ["step-a", "step-b", "step-c"] }));
        modelState.model = planned([rateLimited()]);

        await run();

        const state = await readState();

        expect(state.chunkText).toContain("Error:");
        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("error");
        expect(enqueued).toHaveLength(0);
    });

    it("allows the third pause", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch(ids.streamId as never, { pausedSteps: ["step-a", "step-b"] }));
        modelState.model = planned([rateLimited()]);

        await run();

        const { pause } = await readState();

        expect(pause).toBeDefined();
    });

    it("never pauses on an error without the gateway's rateLimit field, whatever its text says", async () => {
        modelState.model = planned([Object.assign(new Error("Rate limit exceeded (429)"), { statusCode: 429 })]);

        await run();

        const state = await readState();

        expect(state.chunkText).toContain("Error:");
        expect(state.pause).toBeUndefined();
        expect(enqueued).toHaveLength(0);
    });
});

describe("Retry now", () => {
    it("queues the resume for now, and the delayed job that follows finds the pause claimed", async () => {
        modelState.model = planned([rateLimited(), textStep("Hello there.")]);

        await run();

        const { pause } = await readState();
        const resumed = await harness.run(async (ctx: any) => await ctx.runMutation(retryPausedRunsNow, { threadId: ids.threadId }));

        expect(resumed).toBe(true);
        expect(enqueued).toHaveLength(2);
        expect(enqueued[1]!.args).toMatchObject({ resume: pause!.id });
        expect(enqueued[1]!.delayMs).toBe(0);

        // The early job runs first; the delayed one, delivered at the retry time, claims nothing.
        await run({ resume: pause!.id });
        await run({ resume: pause!.id });

        const state = await readState();

        expect(modelState.builtAgents).toBe(2);
        expect(state.rows.filter((row) => row.role === "assistant")).toHaveLength(1);
        expect(state.streamStatus).toBe("done");
    });

    it("queues once however often it is asked", async () => {
        modelState.model = planned([rateLimited(), textStep("Hello there.")]);

        await run();
        await harness.run(async (ctx: any) => await ctx.runMutation(retryPausedRunsNow, { threadId: ids.threadId }));

        const again = await harness.run(async (ctx: any) => await ctx.runMutation(retryPausedRunsNow, { threadId: ids.threadId }));

        expect(again).toBe(false);
        expect(enqueued).toHaveLength(2);
    });

    it("is the procedure's job to check the caller: the owner resumes it, a stranger is refused and queues nothing", async () => {
        modelState.model = planned([rateLimited(), textStep("Hello there.")]);

        await run();

        const { retryRateLimitedRun } = await import("./rate-limit-retry");
        const as = (userId: string) => harness.withIdentity({ userId } as never);

        await expect(as("stranger-1").mutation(retryRateLimitedRun as never, { threadId: ids.threadId } as never)).rejects.toThrow();
        expect(enqueued).toHaveLength(1);

        expect(await as(OWNER).mutation(retryRateLimitedRun as never, { threadId: ids.threadId } as never)).toStrictEqual({ resumed: true });
        expect(enqueued).toHaveLength(2);
        expect(enqueued[1]!.delayMs).toBe(0);
    });

    it("does nothing for a thread that is not paused", async () => {
        const resumed = await harness.run(async (ctx: any) => await ctx.runMutation(retryPausedRunsNow, { threadId: ids.threadId }));

        expect(resumed).toBe(false);
        expect(enqueued).toHaveLength(0);
    });
});

describe("Stop during a pause", () => {
    it("ends the run cleanly: the stream is done, the thread is freed, and the resume does nothing", async () => {
        modelState.model = planned([rateLimited(), textStep("Hello there.")]);

        await run();

        const { pause } = await readState();
        const stopped = await harness.run(async (ctx: any) => await ctx.runMutation(stopActiveForThread, { threadId: ids.threadId }));

        expect(stopped).toBe(true);

        await run({ resume: pause!.id });

        const state = await readState();

        expect(modelState.builtAgents).toBe(1);
        expect(state.streamStatus).toBe("done");
        // The stop frees the thread (`abort`, then `active` a second later); a pause leaves nothing pending to fail.
        expect(state.threadStatus).toBe("abort");
        expect(state.rows.map((row) => row.role)).toStrictEqual(["user"]);
        expect(state.chunkText).not.toContain("Error:");
    });

    it("wins against a rate limit that arrives after it: the run does not pause a stopped stream", async () => {
        modelState.model = planned([rateLimited()]);
        await harness.run(async (ctx: any) => await ctx.runMutation(stopActiveForThread, { threadId: ids.threadId }));

        const outcome = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(pauseRunForRateLimit, {
                    from: ids.messageId,
                    replyRowIds: [],
                    run: {
                        messageId: ids.messageId,
                        streamId: ids.streamId,
                        streamingConfig: { contentType: "text", model: "m" },
                        threadId: ids.threadId,
                        userId: OWNER,
                    },
                    status: 429,
                    stepsUsed: 0,
                    streamId: ids.streamId,
                }),
        );

        expect(outcome).toMatchObject({ paused: false, reason: "not_live" });
        expect(enqueued).toHaveLength(0);
    });
});

describe("a rate limit after earlier steps", () => {
    it("resumes under the last saved row: the reply stays one chain, with no failed row beside it", async () => {
        modelState.withTools = true;
        modelState.model = planned([toolCallStep("echo", "call-1"), rateLimited(), textStep("All done.")]);

        await run();

        const paused = await readState();

        // The tool step finished and was saved; the rejected second step left no row behind.
        expect(paused.pause).toBeDefined();
        expect(paused.rows.map((row) => [row.role, row.status])).toStrictEqual([
            ["user", "success"],
            ["assistant", "success"],
            ["tool", "success"],
        ]);
        expect(paused.pause!.from).toBe(paused.rows.at(-1)!.id);
        // Nothing is recorded yet: the reply is one reply, recorded when it ends.
        expect(scheduleReplyUsage).not.toHaveBeenCalled();

        await run({ resume: paused.pause!.id });

        const state = await readState();

        expect(state.rows.map((row) => [row.role, row.status])).toStrictEqual([
            ["user", "success"],
            ["assistant", "success"],
            ["tool", "success"],
            ["assistant", "success"],
        ]);
        // One order, one chain: the resumed step is a child of the tool result, not a sibling reply.
        expect(new Set(state.rows.map((row) => row.order)).size).toBe(1);
        expect(state.rows.at(-1)!.parent).toBe(state.rows[2]!.id);
        expect(state.chunkText).toContain("All done.");
        expect(state.streamStatus).toBe("done");
        // One reply, keyed on its first reply row, covering the steps from before the pause and the one after.
        expect(scheduleReplyUsage).toHaveBeenCalledOnce();
        expect(vi.mocked(scheduleReplyUsage).mock.calls[0]![1]).toMatchObject({ replyKey: state.rows[1]!.id, tokens: 16 });
    });
});

/** An empty assistant reply row under `parent`, as a rejected step leaves one. */
const seedEmptyReply = async (status: "failed" | "pending", parent: string, stepOrder: number) =>
    await harness.run(async (ctx: any) => {
        const id = await ctx.db.insert("messages", {
            message: { content: [], role: "assistant" },
            order: 0,
            parentMessageId: parent,
            status,
            stepOrder,
            threadId: ids.threadId,
            tool: false,
            userId: OWNER,
        });

        return String(id);
    });

describe("the placeholder a pause removes", () => {
    it("is this run's own: a sibling reply's failed row and another run's pending row stay", async () => {
        const failedSibling = await seedEmptyReply("failed", ids.messageId, 7);
        const pendingSibling = await seedEmptyReply("pending", ids.messageId, 8);

        modelState.model = planned([rateLimited()]);

        await run();

        const state = await readState();

        expect(state.pause).toBeDefined();
        expect(new Set(state.rows.map((row) => row.id))).toStrictEqual(new Set([failedSibling, ids.messageId, pendingSibling]));
    });
});

describe("one reply, however many pauses", () => {
    const stepsCalled = () => (modelState.model as MockLanguageModelV3).doStreamCalls.length;

    it("gives the resume only the steps the run has left", async () => {
        modelState.withTools = true;
        // Two tool steps, a rejection, then tool steps for as long as the model is asked: the cap of five steps is for the run.
        modelState.model = planned([toolCallStep("echo", "call-1"), toolCallStep("echo", "call-2"), rateLimited(), toolCallStep("echo", "call-3")]);

        await run();

        const paused = await readState();

        await run({ resume: paused.pause!.id });

        // 2 steps + the rejected call, then the 3 steps that were left: 6 calls, not 2 + 1 + 5.
        expect(stepsCalled()).toBe(6);
    });

    it("pauses a second time on a later step, and records the reply once when it ends", async () => {
        modelState.withTools = true;
        modelState.model = planned([toolCallStep("echo", "call-1"), rateLimited(), toolCallStep("echo", "call-2"), rateLimited(), textStep("All done.")]);

        await run();

        const first = await readState();

        await run({ resume: first.pause!.id });

        const second = await readState();

        // A different step (it continues from the row the first resume saved), so it may pause too.
        expect(second.pause).toBeDefined();
        expect(second.pause!.id).not.toBe(first.pause!.id);
        expect(second.pause!.from).not.toBe(first.pause!.from);
        expect(second.pausedSteps).toHaveLength(2);
        expect(enqueued).toHaveLength(2);
        expect(scheduleReplyUsage).not.toHaveBeenCalled();

        await run({ resume: second.pause!.id });

        const state = await readState();

        expect(state.rows.map((row) => row.role)).toStrictEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
        expect(new Set(state.rows.map((row) => row.order)).size).toBe(1);
        expect(state.streamStatus).toBe("done");
        expect(scheduleReplyUsage).toHaveBeenCalledOnce();
        expect(vi.mocked(scheduleReplyUsage).mock.calls[0]![1]).toMatchObject({ replyKey: state.rows[1]!.id, tokens: 24 });
    });

    it("records the finished steps once when the run is stopped after its resume", async () => {
        modelState.withTools = true;
        modelState.model = planned([toolCallStep("echo", "call-1"), rateLimited(), rateLimited()]);

        await run();

        const paused = await readState();

        // The resumed step is rejected again, which fails the run (one pause per step) through the stop path.
        await run({ resume: paused.pause!.id });

        expect(scheduleReplyUsage).toHaveBeenCalledOnce();
        expect(vi.mocked(scheduleReplyUsage).mock.calls[0]![1]).toMatchObject({ replyKey: paused.rows[1]!.id });
    });
});

describe("Retry now and the step's one pause", () => {
    it("lets a step that Retry now cut short pause once more when the limit has not lifted", async () => {
        modelState.model = planned([rateLimited(), rateLimited(), textStep("Hello there.")]);

        await run();

        const first = await readState();

        await harness.run(async (ctx: any) => await ctx.runMutation(retryPausedRunsNow, { threadId: ids.threadId }));
        await run({ resume: first.pause!.id });

        const second = await readState();

        expect(second.streamStatus).not.toBe("done");
        expect(second.pause).toBeDefined();
        expect(second.pause!.id).not.toBe(first.pause!.id);

        // Only once: the second resume was not cut short, so a third rejection fails the run.
        await run({ resume: second.pause!.id });

        const third = await readState();

        expect(third.rows.map((row) => row.role)).toStrictEqual(["user", "assistant"]);
        expect(third.streamStatus).toBe("done");
        expect(third.chunkText).toContain("Hello there.");
    });

    it("does not give the allowance to a resume that waited out the whole pause", async () => {
        modelState.model = planned([rateLimited()]);

        await run();

        const { pause } = await readState();

        await run({ resume: pause!.id });

        const state = await readState();

        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("error");
    });
});

describe("a pause whose resume never came", () => {
    const overdueBy = async (ms: number) =>
        await harness.run(async (ctx: any) => {
            const stream = await ctx.db.get(ids.streamId as never);

            await ctx.db.patch(ids.streamId as never, { pause: { ...stream.pause, retryAt: Date.now() - ms } });
        });

    it("can be resumed with Retry now once it is more than 30 seconds overdue, and that is not an early resume", async () => {
        modelState.model = planned([rateLimited(), rateLimited()]);

        await run();
        await overdueBy(60_000);

        const resumed = await harness.run(async (ctx: any) => await ctx.runMutation(retryPausedRunsNow, { threadId: ids.threadId }));
        const { pause } = await readState();

        expect(resumed).toBe(true);
        expect(enqueued).toHaveLength(2);
        expect(enqueued[1]!.delayMs).toBe(0);

        await run({ resume: pause!.id });

        // The wait had run out, so this was not cut short: a rejection now fails the run.
        const { streamStatus } = await readState();

        expect(streamStatus).toBe("done");
    });

    it("is left alone while the resume that was queued may still be on its way", async () => {
        modelState.model = planned([rateLimited()]);

        await run();
        await overdueBy(5000);

        const resumed = await harness.run(async (ctx: any) => await ctx.runMutation(retryPausedRunsNow, { threadId: ids.threadId }));

        expect(resumed).toBe(false);
        expect(enqueued).toHaveLength(1);
    });
});

describe("a pause that never resumes", () => {
    it("Stop records the steps that finished, once", async () => {
        modelState.withTools = true;
        modelState.model = planned([toolCallStep("echo", "call-1"), rateLimited(), textStep("All done.")]);

        await run();

        const paused = await readState();

        await harness.run(async (ctx: any) => await ctx.runMutation(stopActiveForThread, { threadId: ids.threadId }));
        await run({ resume: paused.pause!.id });

        expect(scheduleReplyUsage).toHaveBeenCalledOnce();
        expect(vi.mocked(scheduleReplyUsage).mock.calls[0]![1]).toMatchObject({ replyKey: paused.rows[1]!.id, tokens: 8 });
    });

    it("a regenerate that moved the conversation on ends the paused run and frees the thread", async () => {
        modelState.withTools = true;
        modelState.model = planned([toolCallStep("echo", "call-1"), rateLimited(), textStep("All done.")]);

        await run();

        const paused = await readState();

        // A later reply to the same prompt got its own stream, and has finished since.
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("persistentStreams", {
                expiresAt: Date.now() + 60_000,
                messageId: ids.messageId,
                status: "done",
                streamingConfig: { contentType: "text", model: "test-model" },
                threadId: ids.threadId,
                userId: OWNER,
            });
        });
        await run({ resume: paused.pause!.id });

        const state = await readState();

        expect(modelState.builtAgents).toBe(1);
        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("active");
        expect(state.rows.map((row) => row.role)).toStrictEqual(["user", "assistant", "tool"]);
        expect(state.chunkText).not.toContain("All done.");
        expect(scheduleReplyUsage).toHaveBeenCalledOnce();
    });

    it("leaves the thread to the newer run that is still live", async () => {
        modelState.model = planned([rateLimited(), textStep("Hello there.")]);

        await run();

        const paused = await readState();

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("persistentStreams", {
                expiresAt: Date.now() + 60_000,
                messageId: ids.messageId,
                status: "streaming",
                streamingConfig: { contentType: "text", model: "test-model" },
                threadId: ids.threadId,
                userId: OWNER,
            });
        });
        await run({ resume: paused.pause!.id });

        const state = await readState();

        expect(modelState.builtAgents).toBe(1);
        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("running");
    });

    it("ends the paused run when the row it continues from was deleted", async () => {
        modelState.withTools = true;
        modelState.model = planned([toolCallStep("echo", "call-1"), rateLimited(), textStep("All done.")]);

        await run();

        const paused = await readState();

        await harness.run(async (ctx: any) => await ctx.db.delete(paused.pause!.from as never));
        await run({ resume: paused.pause!.id });

        const state = await readState();

        expect(modelState.builtAgents).toBe(1);
        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("active");
    });
});

describe("how the model fails", () => {
    it("pauses when the error comes in the middle of a reply, and resumes it cleanly", async () => {
        let calls = 0;

        modelState.model = new MockLanguageModelV3({
            doStream: async () => {
                calls += 1;

                if (calls > 1) {
                    return { stream: simulateReadableStream({ chunkDelayInMs: null, chunks: textStep("Hello there."), initialDelayInMs: null }) };
                }

                return {
                    stream: new ReadableStream({
                        start(controller) {
                            controller.enqueue({ type: "stream-start", warnings: [] });
                            controller.enqueue({ id: "t", type: "text-start" });
                            controller.enqueue({ delta: "Hel", id: "t", type: "text-delta" });
                            controller.error(rateLimited());
                        },
                    }),
                };
            },
        });

        await run();

        const paused = await readState();

        expect(paused.pause).toBeDefined();
        expect(paused.chunkText).not.toContain("Error:");
        expect(paused.rows.map((row) => row.role)).toStrictEqual(["user"]);

        await run({ resume: paused.pause!.id });

        const state = await readState();

        expect(state.rows.map((row) => [row.role, row.status])).toStrictEqual([
            ["user", "success"],
            ["assistant", "success"],
        ]);
        expect(state.streamStatus).toBe("done");
    });

    it("finds the rate limit through the AI SDK's retry wrapper", async () => {
        const wrapped = new RetryError({ errors: [new Error("overloaded"), rateLimited()], message: "Failed after 3 attempts", reason: "maxRetriesExceeded" });

        modelState.model = planned([wrapped, textStep("Hello there.")]);

        await run();

        const paused = await readState();

        expect(wrapped.lastError).toBeDefined();
        expect(paused.pause).toMatchObject({ provider: "anthropic", status: 429 });
    });
});
