import { lunoraTest } from "@lunora/testing";
import { MockLanguageModelV3 } from "ai/test";
import { tool } from "ai";
import { LunoraError, v } from "lunorash/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { registeredApi, registerModule } from "../../test/registered-api";
import { internalMutation, internalQuery } from "../_generated/server";
import schema from "../schema";
import { runGroupTurn } from "./group/run";
import { scriptedModel, textStep, toolCallStep } from "./group/test-models";

const { enqueued, modelState, registry } = vi.hoisted(() => {
    return {
        enqueued: [] as { args: Record<string, unknown>; delayMs: number | undefined }[],
        modelState: {
            builtAgents: 0,
            groupConfig: null as unknown,
            mcpLabels: {} as Record<string, { serverName: string; toolName: string }>,
            memory: false,
            model: undefined as unknown,
            optOut: false,
            prefsFail: false,
            prefsReads: [] as { shardKey: string; userId: string }[],
            /** The tools the run may call again after a death inside one. */
            repeatable: [] as string[],
            /** Calls of the tools that never return (`look`, `act`): a death inside them. */
            stuckCalls: [] as string[],
            threadStateless: false,
            toolCalls: 0,
            withTools: false,
        },
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

// The person's own shard answers their preferences: the harness is one database, so the read is faked, and its target is recorded.
vi.mock("../lib/cross-shard", () => {
    return {
        callOnShard: vi.fn(async (_reference: unknown, args: { userId: string }, options: { shardKey: string }) => {
            modelState.prefsReads.push({ shardKey: options.shardKey, userId: args.userId });

            if (modelState.prefsFail) {
                throw new Error("shard unreachable");
            }

            return { memoryEnabled: modelState.memory, resumeInterruptedRuns: modelState.optOut ? false : undefined, threadSummariesEnabled: false };
        }),
    };
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
    const original = await importOriginal<typeof import("./lib/agent-run")>();

    return {
        ...original,
        afterRun: vi.fn(original.afterRun),
        loadRunContext: vi.fn(async () => {
            return {
                botId: undefined,
                contextParts: [],
                knowledgeSources: [],
                memoryEnabled: modelState.memory,
                prefs: {
                    language: undefined,
                    location: undefined,
                    personalization: undefined,
                    timezone: "Europe/Berlin",
                },
                researchDepth: "balanced",
                retrievedMemories: [],
                threadSettings: modelState.threadStateless ? { statelessMode: true } : null,
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
                mcpLabels: modelState.mcpLabels,
                mcpServerNames: [],
                permissionKeys: {},
                repeatable: modelState.repeatable,
                tools: {
                    act: tool({
                        description: "Changes something, and never returns",
                        execute: async () => {
                            modelState.stuckCalls.push("act");

                            return await new Promise<string>(() => {});
                        },
                        inputSchema: z.object({}),
                    }),
                    echo: tool({
                        description: "Echo",
                        execute: async () => {
                            modelState.toolCalls += 1;

                            return "echoed";
                        },
                        inputSchema: z.object({}),
                    }),
                    look: tool({
                        description: "Reads something, and never returns",
                        // Never returns the first time (the death), and answers when the resume calls it again.
                        execute: async () => {
                            modelState.stuckCalls.push("look");

                            return modelState.stuckCalls.filter((name) => name === "look").length > 1 ? "looked" : await new Promise<string>(() => {});
                        },
                        inputSchema: z.object({}),
                    }),
                },
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
const { afterRun } = await import("./lib/agent-run");
const { runStreamingAgent } = await import("./execute");
const { addChunk, claimRunResume } = await import("./streaming/persistent/library");
const { addMessages } = await import("../agent/messages");
const { beatRun, inspectRun, markToolRun } = await import("./streaming/persistent/interrupted");
const { watchRun } = await import("./streaming/persistent/interrupted-watch");

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "owner-1";

let harness: Harness;
let ids: { messageId: string; streamId: string; threadId: string };

beforeAll(async () => {
    registerModule(registry, "agent_branches", await import("../agent/branches"));
    registerModule(registry, "agent_context_reset_read", await import("../agent/context-reset-read"));
    registerModule(registry, "agent_messages", await import("../agent/messages"));
    registerModule(registry, "agent_streams", await import("../agent/streams"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "chat_goals_internal", await import("./goals/internal"));
    registerModule(registry, "chat_streaming", await import("./streaming"));
    registerModule(registry, "chat_streaming_persistent_library", await import("./streaming/persistent/library"));
    registerModule(registry, "chat_streaming_persistent_interrupted", await import("./streaming/persistent/interrupted"));
    registerModule(registry, "chat_streaming_persistent_interrupted_watch", await import("./streaming/persistent/interrupted-watch"));
    registerModule(registry, "chat_mcp_tool_labels", await import("./mcp-tool-labels"));
    registry.set(
        "chat_functions:getThreadSettings",
        internalQuery.input({ threadId: v.string() }).query(async () => null),
    );

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
    modelState.toolCalls = 0;
    modelState.memory = false;
    modelState.mcpLabels = {};
    vi.mocked(afterRun).mockClear();
    modelState.prefsFail = false;
    modelState.threadStateless = false;
    modelState.prefsReads.length = 0;
    modelState.repeatable = [];
    modelState.stuckCalls.length = 0;
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

    it("never resumes or fails a run whose beat is fresh, whatever else its row looks like", async () => {
        await startRunThatDiesInStepTwo();
        await patchStream({ beatAt: Date.now() - 60_000, interruptions: 3, toolsInFlight: 2 });

        expect(await inspect()).toStrictEqual({ kind: "fresh" });
        expect(enqueued).toHaveLength(0);

        const state = await readState();

        expect(state.pause).toBeUndefined();
        expect(state.streamStatus).not.toBe("done");
        expect(state.threadStatus).toBe("running");
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

        // The first run made its model calls and died inside the second; the resume must make that second call again, once.
        let resumedModelCalls = 0;
        const answer = scriptedModel([textStep("All done.")]);

        modelState.model = new MockLanguageModelV3({
            doStream: async (options) => {
                resumedModelCalls += 1;

                return await answer.doStream(options);
            },
        });
        await run({ resume: midway.pause!.id });
        expect(resumedModelCalls).toBe(1);
        // ... and so is a second delivery of the resume.
        await run({ resume: midway.pause!.id });
        expect(resumedModelCalls).toBe(1);

        const state = await readState();
        const stored = await harness.run(
            async (ctx: any) =>
                await ctx.db
                    .query("messages")
                    .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", ids.threadId))
                    .collect(),
        );
        const finalAnswers = stored.filter(
            (row: any) =>
                row.message?.role === "assistant" &&
                row.status === "success" &&
                Array.isArray(row.message.content) &&
                row.message.content.every((part: any) => part.type !== "tool-call"),
        );

        // Exactly one final assistant answer, and its text once in the stream.
        expect(finalAnswers).toHaveLength(1);
        expect(state.chunkText.split("All done.")).toHaveLength(2);

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

/**
 * A run whose worker dies inside the tools its first step called (`look` reads and is safe to repeat, `act` is not):
 * the tools never return. Not awaited, like `startRunThatDiesInStepTwo`.
 */
const startRunThatDiesInTools = async (toolNames: string[]) => {
    modelState.withTools = true;
    modelState.repeatable = ["look"];
    modelState.model = scriptedModel([
        [
            { type: "stream-start", warnings: [] },
            ...toolNames.map((toolName, index) => {
                return { input: "{}", toolCallId: `call-${index}`, toolName, type: "tool-call" as const };
            }),
            {
                finishReason: { raw: "tool-calls", unified: "tool-calls" },
                type: "finish",
                usage: {
                    inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 3, total: 3 },
                    outputTokens: { reasoning: undefined, text: 5, total: 5 },
                },
            },
        ],
        textStep("Found it."),
    ]);

    void run().catch(() => undefined);

    for (let attempt = 0; attempt < 200 && modelState.stuckCalls.length < toolNames.length; attempt += 1) {
        await sleep(25);
    }

    expect(modelState.stuckCalls.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(toolNames.toSorted((a, b) => a.localeCompare(b)));
    await sleep(100);
};

describe("a run whose worker dies inside a tool", () => {
    it("is resumed when the tool is safe to repeat: the open call is dropped and the step runs again", async () => {
        await startRunThatDiesInTools(["look"]);

        const { toolsInFlight } = await readStream();

        expect(toolsInFlight).toBeUndefined();

        await patchStream({ beatAt: deadBeat() });

        expect(await inspect()).toStrictEqual({ kind: "resumed" });
        expect(enqueued).toHaveLength(1);

        // Nothing of the dead step was saved: the resume asks the model again from the prompt, and the model calls the tool again.
        const { pause, rows } = await readState();

        expect(pause?.from).toBe(ids.messageId);
        expect(rows.map((row) => row.id)).toStrictEqual([ids.messageId]);

        modelState.model = scriptedModel([toolCallStep("look", "call-again"), textStep("Found it.")]);
        await run({ resume: String(pause?.id) });

        expect(modelState.stuckCalls).toStrictEqual(["look", "look"]);
        const { streamStatus } = await readState();

        expect(streamStatus).toBe("done");
    });

    it("is not resumed when the tool is not safe to repeat", async () => {
        await startRunThatDiesInTools(["act"]);

        const { toolsInFlight } = await readStream();

        expect(toolsInFlight).toBe(1);

        await patchStream({ beatAt: deadBeat() });

        expect(await inspect()).toMatchObject({ kind: "fail", message: expect.stringContaining("while a tool was running") });
        expect(enqueued).toHaveLength(0);
    });

    it("is not resumed when a safe tool and an unsafe one were both open", async () => {
        await startRunThatDiesInTools(["look", "act"]);

        const { toolsInFlight } = await readStream();

        expect(toolsInFlight).toBe(1);

        await patchStream({ beatAt: deadBeat() });

        expect(await inspect()).toMatchObject({ kind: "fail", message: expect.stringContaining("while a tool was running") });
        expect(enqueued).toHaveLength(0);
    });
});

describe("the beat and the tool marks", () => {
    it("markToolRun checks a repeatable tool's start without counting it, and refuses it once the stream ended", async () => {
        const mark = async () =>
            await harness.run(
                async (ctx: any) => await ctx.runMutation(markToolRun, { delta: 1, epoch: 0, repeatable: true, streamId: ids.streamId as never }),
            );

        await mark();

        const { toolsInFlight } = await readStream();

        expect(toolsInFlight).toBeUndefined();

        await patchStream({ status: "done" });
        await expect(mark()).rejects.toThrow();
    });

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
    it("reads the person's opt-out on their own shard and is then not resumed, with the reply's context stored", async () => {
        modelState.optOut = true;
        await startRunThatDiesInStepTwo();

        const stream = await readStream();

        expect(modelState.prefsReads).toStrictEqual([{ shardKey: OWNER, userId: OWNER }]);
        expect(stream.resumable).toBe(false);
        await patchStream({ beatAt: deadBeat() });
        expect(await inspect()).toStrictEqual({ kind: "gone" });
        expect(enqueued).toHaveLength(0);
        expect(stream.replyContext).toMatchObject({ timeZone: "Europe/Berlin" });
    });

    it("moves the stream's expiry with the beat, but never past the invocation's ceiling", async () => {
        const margin = 3 * 60 * 1000 + 2 * 60 * 1000;
        const beat = async () => await harness.run(async (ctx: any) => await ctx.runMutation(beatRun, { epoch: 0, streamId: ids.streamId as never }));

        await patchStream({ beatAt: 1, expiresAt: Date.now() + 1000, runClaimedAt: Date.now() });
        await beat();
        const extended = await readStream();

        expect(extended.expiresAt).toBeGreaterThan(Date.now() + margin - 5000);

        // A run that is alive but stuck keeps beating: past the ceiling (its claim + the stream's life + the margin) the
        // expiry stays where it was, so the sweep still times the stream out.
        const stuck = Date.now() - 30 * 60 * 1000;

        await patchStream({ expiresAt: Date.now() - 1000, runClaimedAt: stuck });
        await beat();
        await beat();

        const afterStuck = await readStream();

        expect(afterStuck.expiresAt).toBeLessThan(Date.now());
    });

    /** The run saved its final assistant row (the content given) and then its worker died before it could close the run. */
    const dieAfterSavingFinalRow = async (content: unknown[], { withNextStep = false }: { withNextStep?: boolean } = {}) => {
        await startRunThatDiesInStepTwo();

        // A final step is saved with no row for a next step; the hung step two of this scenario left one, so it goes.
        if (!withNextStep) {
            await harness.run(async (ctx: any) => {
                const rows = await ctx.db
                    .query("messages")
                    .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", ids.threadId))
                    .collect();

                const placeholders = rows.filter((candidate: any) => candidate.status === "pending" && candidate.message?.role === "assistant");

                for (const row of placeholders) {
                    await ctx.db.delete("messages", row._id);
                }
            });
        }

        // The same reply as the saved step: it shares its order.
        const last = await harness.run(async (ctx: any) => {
            const rows = await ctx.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", ids.threadId))
                .collect();

            return rows.at(-1);
        });

        await insertRow({ message: { content, role: "assistant" }, order: last.order, stepOrder: last.stepOrder + 1, text: "All done." });
        await patchStream({ beatAt: deadBeat() });
    };

    it("closes a reply whose answer was saved whole instead of asking the model again", async () => {
        await dieAfterSavingFinalRow([{ text: "All done.", type: "text" }]);

        expect(await inspect()).toMatchObject({ kind: "finished" });
        expect(enqueued).toHaveLength(0);
        const state230 = await readState();

        expect(state230.streamStatus).toBe("done");
        expect(scheduleReplyUsage).toHaveBeenCalledOnce();
    });

    it("gives a recovered reply the rest of its end: memory, activity, tool names; usage once", async () => {
        modelState.memory = true;
        modelState.mcpLabels = { echo: { serverName: "srv", toolName: "echo" } };
        await dieAfterSavingFinalRow([{ text: "All done.", type: "text" }]);
        const stream = await readStream();

        await patchStream({ runArgs: { ...stream.runArgs, userPrompt: "Say hello" } });
        expect(stream.toolLabels).toStrictEqual({ echo: { serverName: "srv", toolName: "echo" } });

        const watch = async () => await harness.action(async (ctx: any) => await ctx.runAction(watchRun, { streamId: ids.streamId as never }));

        await watch();

        // As a normal finish: the after-run work runs once, for the whole reply, with the memory switch the person's setting gives.
        expect(afterRun).toHaveBeenCalledOnce();

        const [, args] = vi.mocked(afterRun).mock.calls[0]!;

        expect(args).toMatchObject({ extractMemory: true, prompt: "Say hello", recordUsage: false, userId: OWNER });
        expect(args.savedMessages).toHaveLength(3);

        // The thread carries the reply stamp a normal finish leaves.
        const thread = await harness.run(async (ctx: any) => await ctx.db.get("threads", ids.threadId as never));

        expect(thread.lastReplyAt).toBeGreaterThan(0);
        // The usage record is the close's, once.
        expect(scheduleReplyUsage).toHaveBeenCalledOnce();

        // The tool call the dead worker saved shows the MCP tool's real name.
        const labelled = await harness.run(async (ctx: any) => {
            const rows = await ctx.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", ids.threadId))
                .collect();

            return rows.find((row: any) => Array.isArray(row.message?.content) && row.message.content.some((part: any) => part.type === "tool-call"));
        });
        const call = labelled.message.content.find((part: any) => part.type === "tool-call");

        expect(call.providerOptions.neore).toMatchObject({ mcpServerName: "srv", mcpToolName: "echo" });

        // Closed: another look does nothing, so nothing is recorded twice.
        await watch();
        expect(afterRun).toHaveBeenCalledOnce();
    });

    it("runs the after-run work of a resumed reply once, for the whole reply, and stamps the resume's own rows", async () => {
        modelState.memory = true;
        modelState.mcpLabels = { echo: { serverName: "srv", toolName: "echo" } };
        await startRunThatDiesInStepTwo();
        await patchStream({ beatAt: deadBeat() });
        expect(await inspect()).toStrictEqual({ kind: "resumed" });

        const { pause } = await readState();

        // The resume itself calls the tool again, so its OWN row carries a call to be labelled.
        modelState.model = scriptedModel([toolCallStep("echo", "call-2"), textStep("All done.")]);
        await run({ resume: String(pause?.id) });

        // The dead invocation never reached its end; the resume's is the only one, and it covers every row of the reply.
        expect(afterRun).toHaveBeenCalledOnce();

        const [, args] = vi.mocked(afterRun).mock.calls[0]!;

        expect(args).toMatchObject({ extractMemory: true, userId: OWNER });
        expect(args.savedMessages!.length).toBeGreaterThanOrEqual(4);

        const all = await harness.run(
            async (ctx: any) =>
                await ctx.db
                    .query("messages")
                    .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", ids.threadId))
                    .collect(),
        );
        const rows = all.filter((row: any) => Array.isArray(row.message?.content) && row.message.content.some((part: any) => part.type === "tool-call"));

        expect(rows.length).toBeGreaterThanOrEqual(2);

        for (const row of rows) {
            const call = row.message.content.find((part: any) => part.type === "tool-call");

            expect(call.providerOptions.neore).toMatchObject({ mcpServerName: "srv", mcpToolName: "echo" });
        }
    });

    it("stamps the tool names on the rows an earlier invocation saved, when the resume finishes the reply", async () => {
        modelState.mcpLabels = { echo: { serverName: "srv", toolName: "echo" } };
        await startRunThatDiesInStepTwo();
        await patchStream({ beatAt: deadBeat() });
        expect(await inspect()).toStrictEqual({ kind: "resumed" });

        const { pause } = await readState();

        modelState.model = scriptedModel([textStep("All done.")]);
        await run({ resume: String(pause?.id) });

        const labelled = await harness.run(async (ctx: any) => {
            const rows = await ctx.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", ids.threadId))
                .collect();

            return rows.find((row: any) => Array.isArray(row.message?.content) && row.message.content.some((part: any) => part.type === "tool-call"));
        });
        const call = labelled.message.content.find((part: any) => part.type === "tool-call");

        expect(call.providerOptions.neore).toMatchObject({ mcpServerName: "srv", mcpToolName: "echo" });
    });

    it("stamps the reply and queues the follow-up suggestions of a recovered reply exactly once", async () => {
        const { internal } = await import("../_generated/internal");
        const { recoverFinishedReply } = await import("./lib/recover-finished-reply");

        await dieAfterSavingFinalRow([{ text: "All done.", type: "text" }]);

        const verdict = await inspect();

        expect(verdict).toMatchObject({ goal: false, kind: "finished" });

        const queued: unknown[] = [];

        await harness.action(async (ctx: any) => {
            const scheduler = {
                runAfter: async (...call: unknown[]) => {
                    queued.push(call[1]);

                    return await ctx.scheduler.runAfter(...call);
                },
            };

            await recoverFinishedReply({ runMutation: ctx.runMutation.bind(ctx), runQuery: ctx.runQuery.bind(ctx), scheduler } as never, verdict as never);
        });

        const thread = await harness.run(async (ctx: any) => await ctx.db.get("threads", ids.threadId as never));

        expect(thread.lastReplyAt).toBeGreaterThan(0);
        expect(queued.filter((target) => target === internal.chat.functions.generateFollowupSuggestionsForThread)).toHaveLength(1);

        // The close is the claim: the stream is done, so another look recovers nothing.
        expect(await inspect()).toStrictEqual({ kind: "gone" });
    });

    it("counts a tool the provider ran itself (call and result in one row) as part of a complete answer", async () => {
        await dieAfterSavingFinalRow([
            { input: { query: "q" }, providerExecuted: true, toolCallId: "ws-1", toolName: "web_search", type: "tool-call" },
            { output: { value: "found" }, toolCallId: "ws-1", toolName: "web_search", type: "tool-result" },
            { text: "All done.", type: "text" },
        ]);

        expect(await inspect()).toMatchObject({ kind: "finished" });
    });

    it("does not close a reply whose last row is a provider-run tool step that a next step was to answer", async () => {
        await dieAfterSavingFinalRow(
            [
                { input: { query: "q" }, providerExecuted: true, toolCallId: "ws-1", toolName: "web_search", type: "tool-call" },
                { output: { value: "found" }, toolCallId: "ws-1", toolName: "web_search", type: "tool-result" },
            ],
            { withNextStep: true },
        );

        // The row was saved with the empty row its next step was to fill: mid-answer, so it resumes instead of closing.
        expect(await inspect()).toStrictEqual({ kind: "resumed" });
    });

    it("still refuses a row whose tool call has no result", async () => {
        await dieAfterSavingFinalRow([{ input: {}, toolCallId: "t-1", toolName: "echo", type: "tool-call" }]);

        expect(await inspect()).toMatchObject({ kind: "fail" });
    });

    it("hands a finished goal round to its review exactly once, and the goal keeps the thread", async () => {
        await dieAfterSavingFinalRow([{ text: "All done.", type: "text" }]);
        const goalId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threadGoals", {
                    config: { model: "test-model" },
                    costMicrodollars: 0,
                    createdAt: 1,
                    maxCostMicrodollars: 2_000_000,
                    maxRounds: 5,
                    promptMessageId: ids.messageId,
                    round: 0,
                    startMessageId: ids.messageId,
                    status: "active",
                    text: "Say hello",
                    threadId: ids.threadId,
                    updatedAt: 1,
                    userId: OWNER,
                    verdicts: [],
                }),
        );

        expect(await inspect()).toMatchObject({ kind: "finished" });
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]!.args).toStrictEqual({ goalId, round: 1 });

        const state = await readState();

        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("running");

        // The stream is closed: another look finds nothing to do, and nothing is queued twice.
        expect(await inspect()).toStrictEqual({ kind: "gone" });
        expect(enqueued).toHaveLength(1);
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
        const state621 = await readState();

        expect(state621.threadStatus).not.toBe("error");
        const state230 = await readState();

        expect(state230.streamStatus).toBe("done");
    });

    it("records the rows a refused run saved", async () => {
        await startRunThatDiesInStepTwo();
        // The tool result never landed: the run is refused, but its assistant row is a reply that was paid for.
        await harness.run(async (ctx: any) => {
            const rows = await ctx.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", ids.threadId))
                .collect();
            const toolRow = rows.find((row: any) => row.message?.role === "tool");

            await ctx.db.delete("messages", toolRow._id);
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

        const stale = async (function_: () => Promise<unknown>) => await expect(function_()).rejects.toMatchObject({ code: "RUN_REPLACED" });
        const mutate = async (ref: any, args: Record<string, unknown>) =>
            await harness.run(async (ctx: any) => await ctx.runMutation(ref, { streamId: ids.streamId as never, ...args }));
        const before = await readStream();

        await stale(async () => await mutate(addChunk, { final: false, runEpoch: 0, text: "stale" }));
        await stale(async () => await mutate(addChunk, { final: true, runEpoch: 0, text: "stale end" }));
        await stale(async () => await mutate(beatRun, { epoch: 0 }));
        await stale(async () => await mutate(markToolRun, { delta: 1, epoch: 0 }));
        await stale(async () => await mutate(markToolRun, { delta: -1, epoch: 0 }));

        const after = await readStream();

        expect(after.status).toBe(before.status);
        expect(after.toolsInFlight).toBeUndefined();
        const state961 = await readState();

        expect(state961.chunkText).not.toContain("stale");

        // The current run writes as usual.
        await mutate(addChunk, { final: false, runEpoch: 1, text: "fresh" });
        await mutate(beatRun, { epoch: 1 });
        const state658 = await readState();

        expect(state658.chunkText).toContain("fresh");
    });
});

describe("a run judged dead but still alive", () => {
    it("cannot end the goal a newer run owns: a replaced run's failure touches nothing, even once the stream is closed", async () => {
        const { failRun } = await import("./lib/agent-run");
        const goalId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threadGoals", {
                    config: { model: "test-model" },
                    costMicrodollars: 0,
                    createdAt: 1,
                    maxCostMicrodollars: 2_000_000,
                    maxRounds: 5,
                    promptMessageId: ids.messageId,
                    round: 0,
                    startMessageId: ids.messageId,
                    status: "active",
                    text: "Say hello",
                    threadId: ids.threadId,
                    updatedAt: 1,
                    userId: OWNER,
                    verdicts: [],
                }),
        );

        // A newer run (epoch 1) has taken the stream, finished and closed it, and queued the goal's review.
        await patchStream({ runEpoch: 1, status: "done" });

        const outcome = await harness.action(
            async (ctx: any) =>
                await failRun(ctx, { runEpoch: 0, safeMessage: "late failure", streamId: ids.streamId, threadId: ids.threadId, threadStatus: "error" }),
        );
        const goal = await harness.run(async (ctx: any) => await ctx.db.get("threadGoals", goalId));
        const state = await readState();

        expect(outcome).toStrictEqual({ replaced: true });
        expect(goal.status).toBe("active");
        expect(state.threadStatus).toBe("running");
    });

    it("is fenced from the resume decision on: its marks, chunks and finish are refused before the resume claims", async () => {
        await startRunThatDiesInStepTwo();
        await patchStream({ beatAt: deadBeat() });
        expect(await inspect()).toStrictEqual({ kind: "resumed" });

        const mutate = async (ref: any, args: Record<string, unknown>) =>
            await harness.run(async (ctx: any) => await ctx.runMutation(ref, { streamId: ids.streamId as never, ...args }));

        await expect(mutate(markToolRun, { delta: 1, epoch: 0 })).rejects.toMatchObject({ code: "RUN_REPLACED" });
        await expect(mutate(addChunk, { final: false, runEpoch: 0, text: "late" })).rejects.toMatchObject({ code: "RUN_REPLACED" });
    });

    it("refuses a tool start and a chunk of the current epoch while the stream is paused", async () => {
        await startRunThatDiesInStepTwo();
        await patchStream({
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

        const mutate = async (ref: any, args: Record<string, unknown>) =>
            await harness.run(async (ctx: any) => await ctx.runMutation(ref, { streamId: ids.streamId as never, ...args }));

        await expect(mutate(markToolRun, { delta: 1, epoch: 0 })).rejects.toMatchObject({ code: "RUN_REPLACED" });
        await expect(mutate(addChunk, { final: false, runEpoch: 0, text: "late" })).rejects.toMatchObject({ code: "RUN_REPLACED" });
    });

    it("writes nothing when the epoch changes between a run's last check and its save: the check is in the saving mutation", async () => {
        await patchStream({ runEpoch: 1 });

        const save = async (epoch: number) =>
            await harness.run(
                async (ctx: any) =>
                    await ctx.runMutation(addMessages, {
                        messages: [{ message: { content: [{ text: "Too late.", type: "text" }], role: "assistant" }, status: "success" }],
                        promptMessageId: ids.messageId,
                        runHold: { epoch, streamId: ids.streamId },
                        threadId: ids.threadId,
                        userId: OWNER,
                    }),
            );
        const before = await readState();

        await expect(save(0)).rejects.toMatchObject({ code: "RUN_REPLACED" });
        const refused = await readState();

        expect(refused.rows).toHaveLength(before.rows.length);

        await save(1);
        const saved = await readState();

        expect(saved.rows).toHaveLength(before.rows.length + 1);
    });

    it("lands no step beside the resume's when its epoch changes before the step is saved", async () => {
        let call = 0;

        modelState.model = new MockLanguageModelV3({
            doStream: async (options) => {
                call += 1;

                // The resume claims the stream while the old run's model call is still going.
                await patchStream({ runEpoch: 1 });

                return await scriptedModel([textStep("Too late.")]).doStream(options);
            },
        });

        await run().catch(() => undefined);

        const state = await readState();

        expect(call).toBe(1);
        expect(state.rows.filter((row) => row.role === "assistant" && row.status === "success")).toHaveLength(0);
        expect(state.chunkText).not.toContain("Error:");
        expect(state.streamStatus).not.toBe("error");
        expect(scheduleReplyUsage).not.toHaveBeenCalled();
    });

    it("records no usage when a replaced run fails", async () => {
        await startRunThatDiesInStepTwo();
        await patchStream({ beatAt: deadBeat() });
        expect(await inspect()).toStrictEqual({ kind: "resumed" });

        const { pause } = await readState();

        vi.mocked(scheduleReplyUsage).mockClear();
        modelState.model = new MockLanguageModelV3({
            doStream: async () => {
                // A still newer run took the stream, and this one's model call then fails.
                await patchStream({ runEpoch: 9 });

                throw new Error("provider exploded");
            },
        });

        await run({ resume: pause!.id }).catch(() => undefined);

        const state = await readState();

        expect(state.chunkText).not.toContain("provider exploded");
        expect(state.streamStatus).not.toBe("error");
        expect(scheduleReplyUsage).not.toHaveBeenCalled();
    });
});

describe("the resume setting and mode of a run", () => {
    it("fails closed: a preference read that fails leaves the run unresumable", async () => {
        modelState.prefsFail = true;
        await startRunThatDiesInStepTwo();

        const registered = await readStream();

        expect(registered.resumable).toBe(false);
    });

    it("keeps a resumed run stateful even when its thread was switched to stateless meanwhile", async () => {
        await startRunThatDiesInStepTwo();
        await patchStream({ beatAt: deadBeat() });
        expect(await inspect()).toStrictEqual({ kind: "resumed" });

        const { pause } = await readState();

        modelState.threadStateless = true;
        modelState.model = scriptedModel([textStep("All done.")]);
        await run({ resume: String(pause?.id) });

        const state = await readState();

        // A stateless pass would have saved no row and answered the original prompt alone.
        expect(state.rows.map((row) => [row.role, row.status])).toStrictEqual([
            ["user", "success"],
            ["assistant", "success"],
            ["tool", "success"],
            ["assistant", "success"],
        ]);
    });

    it("fences the run on the fail branch too, until the stream is closed", async () => {
        await startRunThatDiesInStepTwo();
        await patchStream({ beatAt: deadBeat(), toolsInFlight: 1 });
        expect(await inspect()).toMatchObject({ kind: "fail" });

        const late = async () =>
            await harness.run(async (ctx: any) => await ctx.runMutation(markToolRun, { delta: 1, epoch: 0, streamId: ids.streamId as never }));

        await expect(late()).rejects.toMatchObject({ code: "RUN_REPLACED" });
    });
});

describe("a run whose registration for resuming fails", () => {
    const KEY = "chat_streaming_persistent_interrupted:registerResumableRun";
    const failWith = (error: Error) => {
        registry.set(
            KEY,
            internalMutation
                .input({ epoch: v.number(), reply: v.any(), resumable: v.boolean(), run: v.any(), streamId: v.string() })
                .output(v.boolean())
                .mutation(async () => {
                    throw error;
                }),
        );
    };

    afterEach(async () => {
        registerModule(registry, "chat_streaming_persistent_interrupted", await import("./streaming/persistent/interrupted"));
    });

    it("still runs the model and finishes the reply, and keeps beating in case the registration did land", async () => {
        failWith(new Error("shard blip"));

        await run();

        const state = await readState();
        const stream = await readStream();

        expect(state.chunkText).toContain("Hello there.");
        expect(state.chunkText).not.toContain("Error:");
        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("active");
        expect(stream.runArgs).toBeUndefined();
        // The answer may have been lost after the registration committed, and a watchdog would then be looking: the run beats.
        expect(stream.beatAt).toBeGreaterThan(0);
    });

    it("never lets a RESUMED run run a tool without a confirmed mark, even if the person opted out meanwhile", async () => {
        await startRunThatDiesInStepTwo();
        await patchStream({ beatAt: deadBeat() });
        expect(await inspect()).toStrictEqual({ kind: "resumed" });

        const { pause } = await readState();

        modelState.toolCalls = 0;
        modelState.optOut = true;
        registry.set(
            "chat_streaming_persistent_interrupted:markToolRun",
            internalMutation
                .input({ delta: v.number(), epoch: v.number(), setTo: v.optional(v.number()), streamId: v.string() })
                .output(v.null())
                .mutation(async () => {
                    throw new Error("shard blip");
                }),
        );
        modelState.model = scriptedModel([toolCallStep("echo", "call-2"), textStep("All done.")]);
        await run({ resume: pause!.id }).catch(() => undefined);

        expect(modelState.toolCalls).toBe(0);
    });

    it("logs a heartbeat that fails, and goes on", async () => {
        const { streamLogger } = await import("../lib/logger");
        const warn = vi.spyOn(streamLogger, "warn");

        failWith(new Error("shard blip"));
        registry.set(
            "chat_streaming_persistent_interrupted:beatRun",
            internalMutation
                .input({ epoch: v.number(), streamId: v.string() })
                .output(v.null())
                .mutation(async () => {
                    throw new Error("beat refused");
                }),
        );

        await run();

        const state = await readState();

        expect(warn.mock.calls.some((call) => String(call[0]).includes("a heartbeat failed"))).toBe(true);
        expect(state.streamStatus).toBe("done");
        warn.mockRestore();
    });

    it("stops quietly when a newer run holds the stream", async () => {
        failWith(new LunoraError("RUN_REPLACED", "A newer run holds this stream"));

        await run();

        const state = await readState();

        expect(modelState.builtAgents).toBe(1);
        expect(state.rows.filter((row) => row.role === "assistant")).toHaveLength(0);
        expect(state.chunkText).not.toContain("Error:");
        expect(state.streamStatus).not.toBe("error");
    });
});

describe("a run whose model call is aborted", () => {
    const KEY = "agent_messages:finalizeMessage";

    afterEach(async () => {
        registerModule(registry, "agent_messages", await import("../agent/messages"));
    });

    it("does not return before the abort's write to the pending row has landed", async () => {
        const original = registry.get(KEY);
        let release = () => {};
        let reached = () => {};
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` needs Node >= 22.11; the configured range starts at 22.0
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` needs Node >= 22.11; the configured range starts at 22.0
        const writeStarted = new Promise<void>((resolve) => {
            reached = resolve;
        });

        // The abort's write to the pending row waits here, as one stuck behind a busy shard would.
        registry.set(
            KEY,
            internalMutation
                .input({ messageId: v.string(), result: v.any() })
                .output(v.null())
                .mutation(async ({ args, ctx }) => {
                    reached();
                    await released;

                    await ctx.runMutation(original as never, args as never);

                    return null;
                }),
        );

        modelState.withTools = true;

        let call = 0;
        const first = scriptedModel([toolCallStep("echo", "call-1")]);

        // The first step leaves a pending row for the next one.
        modelState.model = new MockLanguageModelV3({
            doStream: async (options) => {
                call += 1;

                if (call === 1) {
                    return await first.doStream(options);
                }

                // A newer run takes the stream during the second step: the run's next write is refused and its model call aborted.
                await patchStream({ runEpoch: 1 });

                return await scriptedModel([textStep("Too late.")]).doStream(options);
            },
        });

        let returned = false;
        let runRejected = false;
        const running = (async () => {
            await run().catch(() => {
                runRejected = true;
            });
            returned = true;
        })();

        // Phase 1: the abort has started its write, and it is held.
        await writeStarted;

        // Phase 2: the run is held with it. Yield the event loop a few times so any return that is not waiting would have happened.
        for (let turn = 0; turn < 20; turn += 1) {
            await new Promise<void>((resolve) => {
                setImmediate(resolve);
            });
        }

        // (Not a database read: the harness runs one write at a time, so a read would wait behind the held one.)
        expect(returned).toBe(false);

        // Phase 3: the write lands, the run returns, and the row is finalized.
        release();
        await running;

        expect(returned).toBe(true);
        expect(runRejected).toBe(false);

        const { rows } = await readState();

        expect(rows.some((row) => row.status === "pending")).toBe(false);
        expect(rows.some((row) => row.role === "assistant" && row.status === "failed")).toBe(true);
    });
});
