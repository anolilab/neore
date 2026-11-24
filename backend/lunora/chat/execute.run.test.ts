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
import { enabledModelOf, MODEL_REGISTRY } from "@neore/ai/models";
import { jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { v } from "lunorash/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { jobsQueueMessages } from "../../test/stubs/cloudflare-workers";
import { internalQuery } from "../_generated/server";
import schema from "../schema";
import { scriptedModel, textStep, toolCallStep } from "./group/test-models";
import { CAP_WRAP_UP_INSTRUCTION } from "./lib/cap-wrap-up";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const { autoState, groupState, modelState, prefsState, registry, skillState, toolsState } = vi.hoisted(() => {
    return {
        /** What `resolveAutoModel` was asked, and the organization the plan read was made for. */
        autoState: { plans: [] as unknown[], requests: 0 },
        /** What `getGroupRunConfig` answers, and how often it was asked. */
        groupState: { calls: 0, config: null as unknown },
        /** The model `getAgent` hands out; `builtAgents` counts the runs that got as far as generating, `tools` names the last one's tools. */
        modelState: { builtAgents: 0, model: undefined as unknown, tools: [] as string[] },
        /** Whether the agent-module preference read reports a failure. */
        prefsState: { readFailed: false },
        registry: new Map<string, unknown>(),
        /** What `resolveSkillsForRun` is asked, and its answer. */
        skillState: { answer: undefined as unknown, calls: [] as { skillSlug?: string }[] },
        /** Whether the model may use tools, and the options `buildAgentTools` was last given. */
        /**
         * Whether the model may use tools, and the options `buildAgentTools` was last given.
         * `removesInstructionRead`: the tools' own gates (the cap, a bot's selection, the permissions) removed it.
         */
        toolsState: {
            allowTools: false,
            /** The action ctx the tools were built with: the tools get it as their `ToolCtx`. */
            ctx: undefined as { runTurn?: unknown } | undefined,
            options: undefined as { untrustedContext?: Promise<boolean> | boolean } | undefined,
            removesInstructionRead: false,
            /** When set, the tools the run is given, in place of the rule-file tool. */
            tools: undefined as Record<string, unknown> | undefined,
        },
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
    const actual = await importOriginal<typeof import("./lib/agent-run")>();

    return {
        ...actual,
        // Passed through; watched for the snapshot a pause would record.
        finishRun: vi.fn(actual.finishRun),
        loadRunContext: vi.fn(async () => {
            return {
                botId: undefined,
                contextParts: [],
                contextPartsWithoutInstructions: [],
                knowledgeSources: [],
                memoryEnabled: false,
                prefs: { language: undefined, location: undefined, personalization: undefined, timezone: "Europe/Berlin" },
                projectInstructions: [],
                researchDepth: "balanced",
                retrievedMemories: [],
                systemContext: ["instructions"],
                threadSettings: null,
                untrustedContext: false,
                userProviderKeys: undefined,
            };
        }),
        readRunPlan: vi.fn(async (_ctx: unknown, _userId: string, organizationId?: string | null) => {
            autoState.plans.push(organizationId);

            return { isAdmin: false, plan: null };
        }),
        resolveRunModel: vi.fn(async () => {
            return { allowTools: toolsState.allowTools, customProvider: undefined };
        }),
    };
});

// The routing call itself has its own suite (`lib/auto-model.test.ts`); here only whether a run asks for it.
vi.mock("./lib/auto-model", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./lib/auto-model")>()),
        resolveAutoModel: vi.fn(async (_ctx: unknown, request: { fallbackModel: string; plan: () => Promise<unknown> }) => {
            autoState.requests += 1;
            await request.plan();

            return request.fallbackModel;
        }),
    };
});

// Only what the run hands the tools is under test here, not the tools.
vi.mock("./lib/agent-tools", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./lib/agent-tools")>()),
        buildAgentTools: vi.fn(
            async (ctx: { runTurn?: unknown }, options: { instructions?: Promise<ReadonlyArray<unknown>>; untrustedContext?: Promise<boolean> | boolean }) => {
                toolsState.ctx = ctx;
                toolsState.options = options;

                // Offered as a candidate, kept unless the gates remove it (`agent-tools.bot-selection.test.ts`).
                const listed = (await options.instructions) ?? [];
                const tools =
                    toolsState.tools ??
                    (listed.length > 0 && !toolsState.removesInstructionRead ? { instruction_read: { description: "read", inputSchema: {} } } : {});

                return { autoApprovals: {}, mcpClients: [], mcpLabels: {}, mcpServerNames: [], permissionKeys: {}, repeatable: [], tools };
            },
        ),
    };
});

vi.mock("./group/run", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("./group/run")>()), runGroupTurn: vi.fn(async () => undefined) };
});

vi.mock("./lib/get-agent", () => {
    return {
        default: async (model: string, options: { maxSteps?: number; tools?: Record<string, unknown> }) => {
            modelState.builtAgents += 1;
            modelState.tools = Object.keys(options.tools ?? {});

            // Imported at call time: the agent client and `agent/messages` import each other.
            const { Agent } = await import("../agent/client");
            const { api } = await import("../_generated/api");

            return new Agent(api as never, {
                instructions: "Be brief.",
                languageModel: modelState.model as never,
                maxSteps: options.maxSteps ?? 5,
                name: model,
                // Offered to the model only by a suite that sets `toolsState.tools` (the step-cap suite's probe): the placeholder
                // `instruction_read` has no schema a model can take, so the other suites keep their agent tool-less.
                tools: toolsState.tools === undefined ? undefined : (options.tools as never),
            });
        },
    };
});

const { scheduleReplyUsage } = await import("../usage/schedule");
const { runGroupTurn } = await import("./group/run");
const { runStreamingAgent } = await import("./execute");
const { finishRun, loadRunContext } = await import("./lib/agent-run");
const { stopActiveForThread } = await import("./streaming/persistent/library");

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
            return {
                autoDetectComplexity: false,
                autoMediaEnrichment: false,
                enableDatasource: false,
                enableKnowledge: false,
                enablePlanner: false,
                ...(prefsState.readFailed && { readFailed: true }),
            };
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
    jobsQueueMessages.length = 0;
    vi.mocked(scheduleReplyUsage).mockClear();
    vi.mocked(runGroupTurn).mockClear();
    groupState.calls = 0;
    groupState.config = null;
    prefsState.readFailed = false;
    modelState.builtAgents = 0;
    modelState.model = scriptedModel([textStep("Hello there.")]);
    autoState.plans = [];
    autoState.requests = 0;
    skillState.calls = [];
    skillState.answer = { enabledSkills: [], invocation: null };
    toolsState.allowTools = false;
    toolsState.tools = undefined;
    toolsState.ctx = undefined;
    toolsState.options = undefined;
    toolsState.removesInstructionRead = false;

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

const run = async (
    extra: { impersonated?: boolean; model?: string; organizationId?: string; skill?: { rawArgs: string; slug: string }; userPrompt?: string } = {},
) => {
    const { model = "test-model", ...rest } = extra;

    return await harness.action(
        async (ctx: any) =>
            await ctx.runAction(runStreamingAgent, {
                messageId: ids.messageId,
                streamId: ids.streamId,
                streamingConfig: { contentType: "text", model },
                threadId: ids.threadId,
                userId: OWNER,
                ...rest,
            }),
    );
};

const readState = async () =>
    await harness.run(async (ctx: any) => {
        const thread = await ctx.db.get("threads", ids.threadId as never);
        const stream = await ctx.db.get("persistentStreams", ids.streamId as never);
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

describe("runStreamingAgent: the turn its tools see", () => {
    it.each([false, true])(
        "hands the tools the turn as /chat/start recorded it (impersonated: %s), its prompt and its system prompt's kinds",
        async (impersonated) => {
            toolsState.allowTools = true;

            await run({ impersonated });

            expect(toolsState.ctx?.runTurn).toStrictEqual({
                impersonated,
                promptMessageId: ids.messageId,
                systemContext: expect.arrayContaining(["instructions"]),
            });
        },
    );

    it("hands them no turn when the job does not say whether an admin sent it, which refuses a saved login", async () => {
        toolsState.allowTools = true;

        await run();

        expect(toolsState.ctx).toBeDefined();
        expect(toolsState.ctx?.runTurn).toBeUndefined();
    });
});

describe("runStreamingAgent: a project's rule files read when needed", () => {
    const instructions = [{ content: "Run the script.", description: "How to deploy", id: "d", title: "Deploy" }];

    /** The run's context with the project's `auto` files, as `loadRunContext` reads them. */
    const withInstructions = (threadSettings: { projectId: string } | null = null) => {
        vi.mocked(loadRunContext).mockResolvedValueOnce({
            botId: undefined,
            contextParts: ["PROJECT CONTEXT:\nBe brief."],
            // Chosen without the list's cost: a later file the list left no room for.
            contextPartsWithoutInstructions: ["PROJECT CONTEXT:\nBe brief.\n\nAlso this."],
            knowledgeSources: [],
            memoryEnabled: false,
            prefs: { language: undefined, location: undefined, personalization: undefined, timezone: "Europe/Berlin" },
            projectInstructions: instructions,
            researchDepth: "balanced",
            retrievedMemories: [],
            systemContext: ["instructions"],
            threadSettings,
            untrustedContext: true,
            userProviderKeys: undefined,
        } as never);
    };

    /** The tools the run's agent was built with, and the system prompt the model was called with. */
    const firstCall = () => {
        const [call] = (modelState.model as MockLanguageModelV3).doStreamCalls;
        const system = call?.prompt.find((message) => message.role === "system");

        return { system: typeof system?.content === "string" ? system.content : "", tools: modelState.tools };
    };

    it("lists them after the project's context and offers instruction_read over them", async () => {
        toolsState.allowTools = true;
        withInstructions();

        await run();

        const { system, tools } = firstCall();

        expect(tools).toContain("instruction_read");
        expect(system).toContain("PROJECT CONTEXT:\nBe brief.\n\nInstruction files you can read with the instruction_read tool");
        expect(system).toContain("- Deploy (id: d): How to deploy");
        expect(system).not.toContain("Run the script.");
    });

    it("names the project they came from in the snapshot a pause records, so its continuation reads that one's", async () => {
        toolsState.allowTools = true;
        withInstructions({ projectId: "project-a" });

        await run();

        expect(vi.mocked(finishRun).mock.calls.at(-1)?.[1].snapshot).toMatchObject({ projectId: "project-a" });
    });

    it("neither lists them nor gives up their room once the tools' own gates removed instruction_read", async () => {
        toolsState.allowTools = true;
        toolsState.removesInstructionRead = true;
        withInstructions();

        await run();

        const { system, tools } = firstCall();

        expect(tools).not.toContain("instruction_read");
        expect(system).not.toContain("instruction_read");
        expect(system).toContain("PROJECT CONTEXT:\nBe brief.\n\nAlso this.");
    });

    it("neither lists nor offers them to a model that takes no tools", async () => {
        withInstructions();

        await run();

        const { system, tools } = firstCall();

        expect(tools).not.toContain("instruction_read");
        expect(system).not.toContain("instruction_read");
    });
});

describe("runStreamingAgent: a reply that spends its step cap", () => {
    // The default cap for a run that is not auto-continuing: five steps. Five tool steps reach it, so the next model call is the wrap-up.
    const CAP = 5;
    const probeSteps = (count: number) => Array.from({ length: count }, (_, index) => toolCallStep("probe", `c${index + 1}`));
    const modelCalls = () => (modelState.model as MockLanguageModelV3).doStreamCalls;
    const offeredTools = (call: { tools?: unknown[] }) => call.tools ?? [];

    let probeRuns = 0;

    beforeEach(() => {
        probeRuns = 0;
        toolsState.allowTools = true;
        // Each run answers something new: three identical calls in a row are a loop to the repeated-call guard, which would end the run first.
        toolsState.tools = {
            probe: {
                description: "probe",
                execute: async () => {
                    probeRuns += 1;

                    return `probed ${probeRuns}`;
                },
                inputSchema: jsonSchema({ properties: {}, type: "object" }),
            },
        };
    });

    it("makes exactly one wrap-up call, with no tools offered, and saves its text under the reply", async () => {
        modelState.model = scriptedModel([...probeSteps(CAP), textStep("Wrap-up: probed five times, nothing left.")]);

        await run();

        const calls = modelCalls();

        // The five tool steps each offered the tool; the sixth call is the wrap-up and offers none.
        expect(calls).toHaveLength(CAP + 1);
        expect(calls.slice(0, CAP).every((call) => offeredTools(call).length === 1)).toBe(true);
        expect(offeredTools(calls[CAP]!)).toHaveLength(0);
        expect(JSON.stringify(calls[CAP]!.prompt)).toContain(CAP_WRAP_UP_INSTRUCTION);

        const state = await readState();

        expect(JSON.stringify(state.replies)).toContain("Wrap-up: probed five times");
        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("active");
    });

    it("makes no wrap-up call when the person stopped the reply on its cap", async () => {
        let calls = 0;

        modelState.model = scriptedModel([...probeSteps(CAP), textStep("Wrap-up that must not run.")], async () => {
            calls += 1;

            // Stop lands while the cap's last tool step is being generated.
            if (calls === CAP) {
                await harness.run(async (ctx: any) => await ctx.runMutation(stopActiveForThread, { threadId: ids.threadId }));
            }
        });

        await run();

        // Every call that ran offered the tool: none was the tool-less wrap-up.
        expect(modelCalls().every((call) => offeredTools(call).length > 0)).toBe(true);
        const state = await readState();

        expect(JSON.stringify(state.replies)).not.toContain("Wrap-up that must not run");
    });

    it("makes no wrap-up call when the reply finishes in text before the cap", async () => {
        modelState.model = scriptedModel([probeSteps(1)[0]!, textStep("Done, after one probe.")]);

        await run();

        const calls = modelCalls();

        // Exactly the calls the loop itself makes: the tool step, then the text answer. No extra call.
        expect(calls).toHaveLength(2);
        expect(calls.every((call) => offeredTools(call).length > 0)).toBe(true);

        const state = await readState();

        expect(JSON.stringify(state.replies)).toContain("Done, after one probe.");
    });

    it("makes no wrap-up call for a reply that answers in text at once", async () => {
        await run();

        expect(modelCalls()).toHaveLength(1);
    });
});

describe("runStreamingAgent: a redelivered job", () => {
    it("returns quietly when the stream was already claimed, without reading the thread or touching the model", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch("persistentStreams", ids.streamId as never, { runClaimedAt: Date.now() }));

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

describe("runStreamingAgent: a goal's queued round", () => {
    it("does not run when its goal ended after the round was queued, and gives the thread back", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch("messages", ids.messageId as never, { agentName: "neore:goal" }));

        await run();

        const state = await readState();

        expect(modelState.builtAgents).toBe(0);
        expect(state.replies).toHaveLength(0);
        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("active");
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

    it("refuses the run, with a readable error and no model call, when the model settings could not be read", async () => {
        prefsState.readFailed = true;

        await run();

        const state = await readState();

        // The defaults a failed read answers carry no ZDR, region or provider rule: nothing may go out under them.
        expect(modelState.builtAgents).toBe(0);
        expect(state.chunkText).toContain("Your model settings could not be read; try again.");
        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("error");
        expect(scheduleReplyUsage).not.toHaveBeenCalled();
    });

    it("finishes the stream and frees the thread when the chat is locked after the stream started", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", ids.threadId as never, { lockedAt: Date.now() + 60_000 }));

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

    it("runs the skill a goal carried into a later round, whose own text starts with no slash", async () => {
        await run({ skill: { rawArgs: "the thread", slug: "summarise" }, userPrompt: "Goal: summarise the thread" });

        expect(skillState.calls).toStrictEqual([{ skillSlug: "summarise" }]);
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

describe("runStreamingAgent: a run that belongs to a goal", () => {
    const insertGoal = async (): Promise<string> =>
        await harness.run(async (ctx: any) =>
            String(
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
                    text: "Say hello twice",
                    threadId: ids.threadId,
                    updatedAt: 1,
                    userId: OWNER,
                    verdicts: [],
                }),
            ),
        );

    it("queues the round's review and leaves the thread running until the goal ends", async () => {
        const goalId = await insertGoal();

        await run();

        const state = await readState();
        const reviews = jobsQueueMessages.filter((message) => message.body.functionPath.includes("reviewGoalRound"));

        expect(reviews).toHaveLength(1);
        expect(reviews[0]!.body.args).toEqual({ goalId, round: 1 });
        expect(state.streamStatus).toBe("done");
        expect(state.threadStatus).toBe("running");
    });

    it("settles the thread as usual for a run with no goal", async () => {
        await run();

        expect(jobsQueueMessages.filter((message) => message.body.functionPath.includes("reviewGoalRound"))).toHaveLength(0);

        const state = await readState();

        expect(state.threadStatus).toBe("active");
    });
});

describe("runStreamingAgent: an Auto thread", () => {
    const MODEL = MODEL_REGISTRY.find((row) => enabledModelOf(row.id, { mode: "text" }))!.id;

    const patchThread = async (fields: Record<string, unknown>) =>
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", ids.threadId as never, { autoModel: true, model: MODEL, ...fields }));

    it("asks the gateway for a model, on the plan of the run's own organization", async () => {
        await patchThread({});
        await run({ model: MODEL, organizationId: "org-1" });

        expect(autoState.requests).toBe(1);
        expect(autoState.plans).toEqual(["org-1"]);
    });

    it("reads the plan of a personal run the way the ordinary model gate does: across the user's organizations", async () => {
        await patchThread({});
        await run({ model: MODEL });

        expect(autoState.plans).toEqual([undefined]);
    });

    it("does not route when the invoked skill names a preferred model, even the thread's own", async () => {
        await patchThread({});
        skillState.answer = {
            enabledSkills: [],
            invocation: { config: { preferredModel: MODEL }, instructions: "Summarise.", skillId: undefined, slug: "summarise" },
        };
        await run({ model: MODEL, skill: { rawArgs: "the thread", slug: "summarise" }, userPrompt: "/summarise the thread" });

        expect(autoState.requests).toBe(0);
    });

    it("does not route a group chat, including an owner's direct skill command", async () => {
        await patchThread({ groupChat: { mode: "round-robin", participants: [{ addedAt: 1, skillId: "skill-1" }] } });
        skillState.answer = { enabledSkills: [], invocation: { config: undefined, instructions: "Summarise.", skillId: undefined, slug: "summarise" } };
        await run({ model: MODEL, skill: { rawArgs: "the thread", slug: "summarise" }, userPrompt: "/summarise the thread" });

        expect(autoState.requests).toBe(0);
    });
});
