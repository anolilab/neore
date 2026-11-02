import { lunoraTest } from "@lunora/testing";
import { MockLanguageModelV3 } from "ai/test";
import { tool } from "ai";
import { v } from "lunorash/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { registeredApi, registerModule } from "../../test/registered-api";
import { internalQuery } from "../_generated/server";
import schema from "../schema";
import { runGroupTurn } from "./group/run";
import { scriptedModel, textStep, toolCallStep } from "./group/test-models";

const { enqueued, modelState, registry } = vi.hoisted(() => {
    return {
        enqueued: [] as { args: Record<string, unknown>; delayMs: number | undefined }[],
        modelState: { builtAgents: 0, groupConfig: null as unknown, model: undefined as unknown, optOut: false, withTools: false },
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
                prefs: {
                    language: undefined,
                    location: undefined,
                    personalization: undefined,
                    resumeInterruptedRuns: modelState.optOut ? false : undefined,
                    timezone: "Europe/Berlin",
                },
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
const { addChunk, claimRunResume } = await import("./streaming/persistent/library");
const { assertRunEpoch, beatRun, inspectRun, markToolRun } = await import("./streaming/persistent/interrupted");
const { watchRun } = await import("./streaming/persistent/interrupted-watch");

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "owner-1";

let harness: Harness;
let ids: { messageId: string; streamId: string; threadId: string };

beforeAll(async () => {
    registerModule(registry, "agent_branches", await import("../agent/branches"));
    registerModule(registry, "agent_messages", await import("../agent/messages"));
    registerModule(registry, "agent_streams", await import("../agent/streams"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "chat_goals_internal", await import("./goals/internal"));
    registerModule(registry, "chat_streaming", await import("./streaming"));
    registerModule(registry, "chat_streaming_persistent_library", await import("./streaming/persistent/library"));
    registerModule(registry, "chat_streaming_persistent_interrupted", await import("./streaming/persistent/interrupted"));
    registerModule(registry, "chat_streaming_persistent_interrupted_watch", await import("./streaming/persistent/interrupted-watch"));

    registry.set(
        "chat_group_functions:getGroupRunConfig",
        internalQuery
            .input({ organizationId: v.optional(v.string()), threadId: v.string(), userId: v.string() })
            .query(async () => modelState.groupConfig as never),
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
    modelState.optOut = false;
    modelState.groupConfig = null;
    vi.mocked(runGroupTurn).mockClear();
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

const run = async (extra: { resume?: string; skill?: { rawArgs: string; slug: string } } = {}) =>
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

interface State {
    chunkText: string;
    interruptions: number | undefined;
    pause: { from: string; id: string; reason: string } | undefined;
    pauseCause: string | undefined;
    rows: { id: string; role: string; status: string }[];
    streamStatus: string | undefined;
    threadStatus: string | undefined;
}

const readState = async (): Promise<State> =>
    await harness.run(async (ctx: any) => {
        const thread = await ctx.db.get("threads", ids.threadId as never);
        const stream = await ctx.db.get("persistentStreams", ids.streamId as never);
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
            interruptions: stream?.interruptions,
            pause: stream?.pause,
            pauseCause: stream?.pauseCause,
            rows: rows.map((row: any) => {
                return { id: String(row._id), role: row.message?.role, status: row.status };
            }),
            streamStatus: stream?.status,
            threadStatus: thread?.status,
        };
    });

const readStream = async () => await harness.run(async (ctx: any) => await ctx.db.get("persistentStreams", ids.streamId as never));

const patchStream = async (fields: Record<string, unknown>) =>
    await harness.run(async (ctx: any) => await ctx.db.patch("persistentStreams", ids.streamId as never, fields));

const inspect = async () => await harness.run(async (ctx: any) => await ctx.runMutation(inspectRun, { streamId: ids.streamId as never }));

/** The beat of a run whose worker is long gone. */
const deadBeat = () => Date.now() - 10 * 60 * 1000;

const sleep = async (ms: number) => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
};

const untilRows = async (count: number) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const { rows } = await readState();

        if (rows.length >= count) {
            return;
        }

        await sleep(25);
    }

    throw new Error(`the run never saved ${count} rows`);
};

/**
 * A run whose worker dies inside its second model call: the first step (a tool call and its result) is saved, then the
 * invocation never returns. Not awaited: the leaked invocation stands for the dead worker and is dropped with the harness.
 */
const startRunThatDiesInStepTwo = async () => {
    modelState.withTools = true;

    let call = 0;
    const first = scriptedModel([toolCallStep("echo", "call-1")]);

    modelState.model = new MockLanguageModelV3({
        doStream: async (options) => {
            call += 1;

            if (call > 1) {
                return await new Promise<never>(() => {});
            }

            return await first.doStream(options);
        },
    });

    void run().catch(() => undefined);
    // The prompt, the step's assistant row and its tool result row.
    await untilRows(3);
    await sleep(100);
};

describe("a run whose worker dies mid-step", () => {
    it("registers its job arguments and beat on the stream while it generates", async () => {
        await startRunThatDiesInStepTwo();

        const stream = await readStream();

        expect(stream.runArgs).toMatchObject({ messageId: ids.messageId, streamId: ids.streamId, userId: OWNER });
        expect(stream.runArgs).not.toHaveProperty("resume");
        expect(stream.beatAt).toBeGreaterThan(0);
        expect(stream.toolsInFlight).toBeUndefined();
    });

    it("waits while the beat is fresh", async () => {
        await startRunThatDiesInStepTwo();

        expect(await inspect()).toStrictEqual({ kind: "fresh" });
        expect(enqueued).toHaveLength(0);
    });

    it("finishes as ONE reply with ONE charge: resumed from the saved step, nothing run twice", async () => {
        await startRunThatDiesInStepTwo();
        await patchStream({ beatAt: deadBeat() });

        expect(await inspect()).toStrictEqual({ kind: "resumed" });

        const queued = enqueued.at(-1)!;
        const midway = await readState();

        // The same job, naming the interrupted pause; the dead step's empty placeholder is gone, the saved step stays.
        expect(queued.args).toMatchObject({ messageId: ids.messageId, resume: midway.pause!.id, streamId: ids.streamId });
        expect(queued.delayMs).toBe(0);
        expect(midway.pauseCause).toBe("interrupted");
        expect(midway.rows.map((row) => [row.role, row.status])).toStrictEqual([
            ["user", "success"],
            ["assistant", "success"],
            ["tool", "success"],
        ]);

        // The queue's redelivery of the ORIGINAL job (the worker died, the message comes back) is dropped, as always.
        const agentsBefore = modelState.builtAgents;

        await run();

        expect(modelState.builtAgents).toBe(agentsBefore);

        modelState.model = scriptedModel([textStep("All done.")]);
        await run({ resume: midway.pause!.id });
        // ... and so is a second delivery of the resume.
        await run({ resume: midway.pause!.id });

        const state = await readState();

        expect(state.rows.map((row) => [row.role, row.status])).toStrictEqual([
            ["user", "success"],
            ["assistant", "success"],
            ["tool", "success"],
            ["assistant", "success"],
        ]);
        expect(state.chunkText).toContain("All done.");
        expect(state.chunkText).not.toContain("Error:");
        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("active");
        expect(state.interruptions).toBe(1);
        expect(scheduleReplyUsage).toHaveBeenCalledOnce();
    });

    it("fails the fourth interruption with a visible error", async () => {
        await startRunThatDiesInStepTwo();
        await patchStream({ beatAt: deadBeat(), interruptions: 3 });

        // The watchdog's own path, end to end.
        await harness.action(async (ctx: any) => await ctx.runAction(watchRun, { streamId: ids.streamId as never }));

        const state = await readState();

        expect(state.chunkText).toContain("Error: The run was interrupted 3 times");
        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("error");
        expect(enqueued).toHaveLength(0);
        // What the reply had saved is recorded once, as one reply.
        expect(scheduleReplyUsage).toHaveBeenCalledOnce();
    });

    it("resumes three times in a row and fails the fourth", async () => {
        await startRunThatDiesInStepTwo();

        for (const expected of [1, 2, 3]) {
            await patchStream({ beatAt: deadBeat() });
            expect(await inspect()).toStrictEqual({ kind: "resumed" });

            const { pause } = await readState();

            // The resume job starts (it claims the pause), then its worker dies again before saving anything.
            await harness.run(async (ctx: any) => await ctx.runMutation(claimRunResume, { pauseId: pause!.id, streamId: ids.streamId as never }));
            const after = await readState();

            expect(after.interruptions).toBe(expected);
        }

        await patchStream({ beatAt: deadBeat() });
        expect(await inspect()).toMatchObject({ kind: "fail" });
    });

    it("is not resumed when the person opted out: it expires as it always did", async () => {
        await startRunThatDiesInStepTwo();
        await patchStream({ beatAt: deadBeat() });
        await patchStream({ resumable: false });

        expect(await inspect()).toStrictEqual({ kind: "gone" });
        expect(enqueued).toHaveLength(0);
        const afterOptOut = await readState();

        expect(afterOptOut.pause).toBeUndefined();
    });

    it("is resumed when the setting is on", async () => {
        await startRunThatDiesInStepTwo();
        await patchStream({ beatAt: deadBeat() });
        await patchStream({ resumable: true });

        expect(await inspect()).toStrictEqual({ kind: "resumed" });
    });

    it("is never resumed from inside a tool: the tool may already have acted", async () => {
        await startRunThatDiesInStepTwo();
        await patchStream({ beatAt: deadBeat(), toolsInFlight: 1 });

        expect(await inspect()).toMatchObject({ kind: "fail", message: expect.stringContaining("while a tool was running") });
        expect(enqueued).toHaveLength(0);
    });

    it("leaves a run that waits out a rate limit to its own resume", async () => {
        await startRunThatDiesInStepTwo();
        await patchStream({
            beatAt: deadBeat(),
            pause: {
                from: ids.messageId,
                id: "rl-1",
                reason: "rate_limit",
                retryAt: Date.now() + 60_000,
                run: {
                    messageId: ids.messageId,
                    streamId: ids.streamId,
                    streamingConfig: { contentType: "text", model: "m" },
                    threadId: ids.threadId,
                    userId: OWNER,
                },
                status: 429,
            },
        });

        expect(await inspect()).toStrictEqual({ kind: "fresh" });
        expect(enqueued).toHaveLength(0);
    });

    it("queues an interrupted resume again when its job was lost", async () => {
        await startRunThatDiesInStepTwo();
        await patchStream({ beatAt: deadBeat() });
        await inspect();

        const { pause } = await readStream();

        await patchStream({ pause: { ...pause, retryAt: Date.now() - 5 * 60 * 1000 } });
        enqueued.length = 0;

        expect(await inspect()).toStrictEqual({ kind: "fresh" });
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]!.args).toMatchObject({ resume: pause.id });
    });

    it("does not show an interrupted resume as a rate-limit wait", async () => {
        await startRunThatDiesInStepTwo();
        await patchStream({ beatAt: deadBeat() });
        await inspect();

        const { getActiveStreamForThread } = await import("./streaming");
        const active = (await harness
            .withIdentity({ userId: OWNER } as never)
            .query(getActiveStreamForThread as never, { threadId: ids.threadId } as never)) as object;

        expect(active).not.toHaveProperty("pause");
    });
});

describe("the beat and the tool marks", () => {
    it("beatRun moves the beat of a live, unpaused stream", async () => {
        await patchStream({ beatAt: 1, runClaimedAt: 1 });
        await harness.run(async (ctx: any) => await ctx.runMutation(beatRun, { epoch: 0, streamId: ids.streamId as never }));

        const beaten = await readStream();

        expect(beaten.beatAt).toBeGreaterThan(1);
    });

    it("markToolRun counts open tools, never below zero, and refuses to start one on a stream that ended", async () => {
        const mark = async (delta: number) =>
            await harness.run(async (ctx: any) => await ctx.runMutation(markToolRun, { delta, epoch: 0, streamId: ids.streamId as never }));

        await mark(1);
        await mark(1);
        const two = await readStream();

        expect(two.toolsInFlight).toBe(2);
        await mark(-1);
        await mark(-1);
        await mark(-1);
        const none = await readStream();

        expect(none.toolsInFlight).toBeUndefined();

        await patchStream({ status: "done" });
        await expect(mark(1)).rejects.toThrow();
    });
});

const insertRow = async (fields: Record<string, unknown>) =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("messages", {
                status: "success",
                threadId: ids.threadId,
                tool: false,
                userId: OWNER,
                ...fields,
            }),
    );

describe("a run the watchdog reads wrongly", () => {
    it("registers the person's opt-out and the reply's context from the run itself", async () => {
        modelState.optOut = true;
        await startRunThatDiesInStepTwo();

        const stream = await readStream();

        expect(stream.resumable).toBe(false);
        expect(stream.replyContext).toMatchObject({ timeZone: "Europe/Berlin" });
    });

    it("moves the stream's expiry with the beat", async () => {
        await patchStream({ beatAt: 1, expiresAt: Date.now() + 1000, runClaimedAt: 1 });
        await harness.run(async (ctx: any) => await ctx.runMutation(beatRun, { epoch: 0, streamId: ids.streamId as never }));

        expect((await readStream()).expiresAt).toBeGreaterThan(Date.now() + 10 * 60 * 1000);
    });

    it("closes a reply whose answer was saved whole instead of asking the model again", async () => {
        await startRunThatDiesInStepTwo();
        // The same reply as the saved step: it shares its order.
        const last = await harness.run(async (ctx: any) => {
            const rows = await ctx.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", ids.threadId))
                .collect();

            return rows.at(-1);
        });

        await insertRow({
            message: { content: [{ text: "All done.", type: "text" }], role: "assistant" },
            order: last.order,
            stepOrder: last.stepOrder + 1,
            text: "All done.",
        });
        await patchStream({ beatAt: deadBeat() });

        expect(await inspect()).toStrictEqual({ kind: "finished" });
        expect(enqueued).toHaveLength(0);
        expect((await readState()).streamStatus).toBe("done");
        expect(scheduleReplyUsage).toHaveBeenCalledOnce();
    });

    it("ends quietly, not in error, when a newer reply took the thread", async () => {
        await startRunThatDiesInStepTwo();
        await patchStream({ beatAt: deadBeat(), toolsInFlight: 1 });
        // The newer reply: its own stream, and rows that would fail this run if they were read as its own.
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
        await insertRow({ message: { content: [], role: "assistant" }, order: 1, status: "pending", stepOrder: 5 });

        expect(await inspect()).toStrictEqual({ kind: "gone" });
        expect((await readState()).threadStatus).not.toBe("error");
        expect((await readState()).streamStatus).toBe("done");
    });

    it("records the rows a refused run saved", async () => {
        await startRunThatDiesInStepTwo();
        // The tool result never landed: the run is refused, but its assistant row is a reply that was paid for.
        await harness.run(async (ctx: any) => {
            const rows = await ctx.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", ids.threadId))
                .collect();
            const tool = rows.find((row: any) => row.message?.role === "tool");

            await ctx.db.delete("messages", tool._id);
        });
        await patchStream({ beatAt: deadBeat() });
        vi.mocked(scheduleReplyUsage).mockClear();

        expect(await inspect()).toMatchObject({ kind: "fail" });
        expect(scheduleReplyUsage).toHaveBeenCalledOnce();
        expect(vi.mocked(scheduleReplyUsage).mock.calls[0]![1]).toMatchObject({ tokens: expect.any(Number), userId: OWNER });
    });
});

describe("a run a newer one replaced", () => {
    it("is refused on every write that matters, and the current run is untouched", async () => {
        await startRunThatDiesInStepTwo();
        await patchStream({ beatAt: deadBeat() });
        expect(await inspect()).toStrictEqual({ kind: "resumed" });

        const { pause } = await readState();
        const claim = (await harness.run(
            async (ctx: any) => await ctx.runMutation(claimRunResume, { pauseId: pause!.id, streamId: ids.streamId as never }),
        )) as { epoch: number };

        expect(claim.epoch).toBe(1);

        const stale = async (fn: () => Promise<unknown>) => await expect(fn()).rejects.toMatchObject({ code: "RUN_REPLACED" });
        const mutate = async (ref: any, args: Record<string, unknown>) =>
            await harness.run(async (ctx: any) => await ctx.runMutation(ref, { streamId: ids.streamId as never, ...args }));
        const before = await readStream();

        await stale(async () => await mutate(addChunk, { final: false, runEpoch: 0, text: "stale" }));
        await stale(async () => await mutate(addChunk, { final: true, runEpoch: 0, text: "stale end" }));
        await stale(async () => await mutate(beatRun, { epoch: 0 }));
        await stale(async () => await mutate(markToolRun, { delta: 1, epoch: 0 }));
        await stale(async () => await mutate(markToolRun, { delta: -1, epoch: 0 }));
        await stale(async () => await mutate(assertRunEpoch, { epoch: 0 }));

        const after = await readStream();

        expect(after.status).toBe(before.status);
        expect(after.toolsInFlight).toBeUndefined();
        expect((await readState()).chunkText).not.toContain("stale");

        // The current run writes as usual.
        await mutate(addChunk, { final: false, runEpoch: 1, text: "fresh" });
        await mutate(beatRun, { epoch: 1 });
        await mutate(assertRunEpoch, { epoch: 1 });
        expect((await readState()).chunkText).toContain("fresh");
    });
});
