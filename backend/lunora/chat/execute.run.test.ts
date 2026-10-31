/**
 * `runStreamingAgent` (`execute.ts`): the action that runs, and bills, every turn.
 *
 * Real: the harness schema, the agent client saving real rows through the real
 * `agent/messages` procedures, the stream gate (`streamRunThread`), the claim
 * (`claimStreamRun`), `persistentChunks`, `afterRun` and `failRun`.
 *
 * Faked at the edges only:
 * - the language model (`ai/test`'s mock), chosen in `get-agent.ts`;
 * - `loadRunContext` / `resolveRunModel` (preference, memory and key reads);
 * - the reads whose tables are D1 or encrypted (group config, skills, preferences);
 * - `runGroupTurn`, which has its own suite (`group/run.test.ts`);
 * - `gatewayFetch`: the gateway binding the harness does not build. A model call
 *   that reached the real one would fail, so the suite cannot bill by accident.
 */
import { lunoraTest } from "@lunora/testing";
import { MockLanguageModelV3 } from "ai/test";
import { v } from "lunorash/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { internalQuery } from "../_generated/server";
import schema from "../schema";
import { scriptedModel, textStep } from "./group/test-models";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const { groupState, modelState, registry, skillState, toolsState } = vi.hoisted(() => {
    return {
        /** What `getGroupRunConfig` answers, and how often it was asked. */
        groupState: { calls: 0, config: null as unknown },
        /** The model `getAgent` hands out; `builtAgents` counts the runs that got as far as generating. */
        modelState: { builtAgents: 0, model: undefined as unknown },
        registry: new Map<string, unknown>(),
        /** What `resolveSkillsForRun` is asked, and its answer. */
        skillState: { answer: undefined as unknown, calls: [] as { skillSlug?: string }[] },
        /** Whether the model may use tools, and the options `buildAgentTools` was last given. */
        toolsState: { allowTools: false, options: undefined as { untrustedContext?: Promise<boolean> | boolean } | undefined },
    };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("../lib/services", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/services")>()),
        gatewayFetch: () => async () => {
            throw new Error("execute.run.test: the gateway binding must not be reached");
        },
    };
});

// The one place `afterRun` hands a finished run's usage on: wrapped, so the real arguments are visible.
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
                untrustedContext: false,
                userProviderKeys: undefined,
            };
        }),
        resolveRunModel: vi.fn(async () => {
            return { allowTools: toolsState.allowTools, customProvider: undefined };
        }),
    };
});

// Only what the run hands the tools is under test here, not the tools.
vi.mock("./lib/agent-tools", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./lib/agent-tools")>()),
        buildAgentTools: vi.fn(async (_ctx: unknown, options: { untrustedContext?: Promise<boolean> | boolean }) => {
            toolsState.options = options;

            return { autoApprovals: {}, mcpClients: [], mcpLabels: {}, mcpServerNames: [], permissionKeys: {}, tools: {} };
        }),
    };
});

vi.mock("./group/run", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("./group/run")>()), runGroupTurn: vi.fn(async () => undefined) };
});

vi.mock("./lib/get-agent", () => {
    return {
        default: async (model: string, options: { maxSteps?: number }) => {
            modelState.builtAgents += 1;

            // Imported at call time: the agent client and `agent/messages` import each other.
            const { Agent } = await import("../agent/client");
            const { api } = await import("../_generated/api");

            return new Agent(api as never, {
                instructions: "Be brief.",
                languageModel: modelState.model as never,
                maxSteps: options.maxSteps ?? 5,
                name: model,
            });
        },
    };
});

const { scheduleReplyUsage } = await import("../usage/schedule");
const { runGroupTurn } = await import("./group/run");
const { runStreamingAgent } = await import("./execute");

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "owner-1";

let harness: Harness;
let ids: { messageId: string; streamId: string; threadId: string };

beforeAll(async () => {
    registerModule(registry, "agent_branches", await import("../agent/branches"));
    registerModule(registry, "agent_messages", await import("../agent/messages"));
    registerModule(registry, "agent_streams", await import("../agent/streams"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "chat_streaming", await import("./streaming"));
    registerModule(registry, "chat_streaming_persistent_library", await import("./streaming/persistent/library"));

    // The reads whose tables the harness cannot hold, or that touch encrypted keys.
    registry.set(
        "chat_group_functions:getGroupRunConfig",
        internalQuery.input({ organizationId: v.optional(v.string()), threadId: v.string(), userId: v.string() }).query(async () => {
            groupState.calls += 1;

            return groupState.config as never;
        }),
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
            .query(async ({ args }) => {
                skillState.calls.push({ skillSlug: args.skillSlug });

                return skillState.answer as never;
            }),
    );
    // Only scheduled after a run; nothing here runs the scheduler.
    registry.set(
        "chat_functions:generateFollowupSuggestionsForThread",
        internalQuery.input({ threadId: v.string(), userId: v.string() }).query(async () => null),
    );
}, 60_000);

beforeEach(async () => {
    vi.mocked(scheduleReplyUsage).mockClear();
    vi.mocked(runGroupTurn).mockClear();
    groupState.calls = 0;
    groupState.config = null;
    modelState.builtAgents = 0;
    modelState.model = scriptedModel([textStep("Hello there.")]);
    skillState.calls = [];
    skillState.answer = { enabledSkills: [], invocation: null };
    toolsState.allowTools = false;
    toolsState.options = undefined;

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

const run = async (extra: { userPrompt?: string } = {}) =>
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

const readState = async () =>
    await harness.run(async (ctx: any) => {
        const thread = await ctx.db.get(ids.threadId as never);
        const stream = await ctx.db.get(ids.streamId as never);
        const chunks = await ctx.db
            .query("persistentChunks")
            .withIndex("by_streamId_seq", (q: any) => q.eq("streamId", ids.streamId))
            .collect();
        const replies = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", ids.threadId))
            .collect();

        return {
            chunkText: chunks.map((chunk: { text: string }) => chunk.text).join(""),
            replies: replies.filter((row: { message?: { role?: string } }) => row.message?.role === "assistant"),
            streamStatus: stream?.status as string | undefined,
            threadStatus: thread?.status as string | undefined,
        };
    });

describe("runStreamingAgent: a successful turn", () => {
    it("streams the reply, closes the stream and hands the thread back", async () => {
        await run();

        const state = await readState();

        expect(modelState.builtAgents).toBe(1);
        expect(state.chunkText).toContain("Hello there.");
        expect(state.replies).toHaveLength(1);
        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("active");
    });

    it("records the reply's usage through scheduleReplyUsage, for the user and their day", async () => {
        await run();

        expect(scheduleReplyUsage).toHaveBeenCalledOnce();

        const [, usageArgs] = vi.mocked(scheduleReplyUsage).mock.calls[0] as [unknown, Record<string, unknown> | undefined];

        // The scripted model reports 3 input and 5 output tokens; the reply is filed under the user's own calendar day.
        expect(usageArgs).toMatchObject({ date: expect.stringMatching(ISO_DATE), replyKey: expect.any(String), tokens: 8, userId: OWNER });
        // A plain turn has no invoked skill, so the usage page files it under the assistant.
        expect(usageArgs).not.toHaveProperty("skillName");
    });
});

describe("runStreamingAgent: a redelivered job", () => {
    it("returns quietly when the stream was already claimed, without reading the thread or touching the model", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch(ids.streamId as never, { runClaimedAt: Date.now() }));

        await run();

        const state = await readState();

        expect(modelState.builtAgents).toBe(0);
        expect(scheduleReplyUsage).not.toHaveBeenCalled();
        expect(state.replies).toHaveLength(0);
        expect(state.chunkText).toBe("");
        // Quiet means untouched: the first delivery owns the stream and the thread's `running` state.
        expect(state.streamStatus).toBe("pending");
        expect(state.threadStatus).toBe("running");
    });

    it("lets only the first of two deliveries generate", async () => {
        await run();
        await run();

        const state = await readState();

        expect(modelState.builtAgents).toBe(1);
        expect(state.replies).toHaveLength(1);
        expect(scheduleReplyUsage).toHaveBeenCalledOnce();
    });
});

describe("runStreamingAgent: a failed run", () => {
    it("finishes the stream with the error and resets the thread to `error` when the model call fails", async () => {
        modelState.model = new MockLanguageModelV3({
            doStream: async () => {
                throw new Error("provider exploded");
            },
        });

        await run();

        const state = await readState();

        expect(modelState.builtAgents).toBe(1);
        expect(state.streamStatus).toBe("done");
        expect(state.chunkText).toContain("Error:");
        // The raw provider text is for the log, not for the user.
        expect(state.chunkText).not.toContain("provider exploded");
        expect(state.threadStatus).toBe("error");
        expect(scheduleReplyUsage).not.toHaveBeenCalled();
    });

    it("finishes the stream and frees the thread when the chat is locked after the stream started", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch(ids.threadId as never, { lockedAt: Date.now() + 60_000 }));

        await run();

        const state = await readState();

        // A chat locked after the stream started is refused (`streamRunThread`): no model, a closed stream, a free thread.
        expect(modelState.builtAgents).toBe(0);
        expect(state.chunkText).toContain("Thread not found");
        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("active");
    });
});

describe("runStreamingAgent: group chats and skill commands", () => {
    const groupConfig = { debateRounds: undefined, mode: "supervisor", participants: [] };

    it("hands a plain message in a group chat to the group's participants", async () => {
        groupState.config = groupConfig;

        await run({ userPrompt: "Say hello" });

        expect(groupState.calls).toBe(1);
        expect(runGroupTurn).toHaveBeenCalledOnce();
        expect(modelState.builtAgents).toBe(0);
    });

    it("skips the group config for a `/<slug>` command and runs that one skill instead", async () => {
        groupState.config = groupConfig;

        await run({ userPrompt: "/summarise the thread" });

        expect(groupState.calls).toBe(0);
        expect(runGroupTurn).not.toHaveBeenCalled();
        expect(skillState.calls).toStrictEqual([{ skillSlug: "summarise" }]);
        // The single agent answered, not the group.
        expect(modelState.builtAgents).toBe(1);
    });

    it("records the invoked skill on the reply's usage", async () => {
        skillState.answer = {
            enabledSkills: [],
            invocation: { config: undefined, instructions: "Summarise.", skillId: undefined, slug: "summarise" },
        };

        await run({ userPrompt: "/summarise the thread" });

        const [, usageArgs] = vi.mocked(scheduleReplyUsage).mock.calls[0] as [unknown, Record<string, unknown> | undefined];

        expect(usageArgs).toMatchObject({ skillName: "/summarise", userId: OWNER });
    });

    describe("the quick check's view of skill text", () => {
        const listed = { description: "Summarise a page", name: "Summary", slug: "summarise" };

        it("treats the run as untrusted when any skill is enabled, whoever wrote it", async () => {
            toolsState.allowTools = true;
            skillState.answer = { enabledSkills: [listed], invocation: null };

            await run();

            await expect(toolsState.options?.untrustedContext).resolves.toBe(true);
        });

        it("treats the run as untrusted when a skill is invoked", async () => {
            toolsState.allowTools = true;
            skillState.answer = { enabledSkills: [], invocation: { config: undefined, instructions: "Summarise.", skillId: undefined, slug: "summarise" } };

            await run({ userPrompt: "/summarise the thread" });

            await expect(toolsState.options?.untrustedContext).resolves.toBe(true);
        });

        it("control: with no skill text and no injected context the run is trusted", async () => {
            toolsState.allowTools = true;

            await run();

            await expect(toolsState.options?.untrustedContext).resolves.toBe(false);
        });
    });

    it("ends the run with the skill's own message when the skill cannot run", async () => {
        skillState.answer = { enabledSkills: [], error: "The skill is disabled.", invocation: null };

        await run({ userPrompt: "/summarise the thread" });

        const state = await readState();

        expect(groupState.calls).toBe(0);
        expect(modelState.builtAgents).toBe(0);
        expect(state.chunkText).toContain("The skill is disabled.");
        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("error");
    });
});
