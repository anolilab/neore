/**
 * What a headless run puts in front of the model. The agent is a stand-in whose
 * instructions come from the REAL system-prompt builder (`getSystemPrompt`),
 * exactly as `get-agent.ts` builds them, so the assertions are about the prompt
 * text a messenger sender's reply is generated from.
 */
import { MODEL_REGISTRY, requiresPaidPlan } from "@neore/ai/models";
import { getSystemPrompt } from "@neore/ai/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mappedReferences } from "../../../test/registered-api";

// A reference is read as its dispatch key, which the fake ctx below switches on.
vi.mock("../../_generated/api", async (importOriginal) => mappedReferences(await importOriginal(), (reference) => reference.__lunoraRef));
vi.mock("../../_generated/internal", async (importOriginal) => mappedReferences(await importOriginal(), (reference) => reference.__lunoraRef));

const seen = vi.hoisted(() => {
    return {
        backups: [] as (string | undefined)[],
        buildOptions: [] as unknown[],
        callOptions: [] as unknown[],
        created: [] as unknown[],
        failAt: undefined as "generate" | "keys" | "thread" | undefined,
        filterRules: undefined as Record<string, string[]> | undefined,
        filters: [] as unknown[],
        met: [] as boolean[],
        /** The owner has left the run's organization. */
        notMember: false,
        prepareSteps: [] as unknown[],
        prompts: [] as (string | undefined)[],
        providerOptions: [] as unknown[],
        replies: [] as string[],
        system: [] as string[],
        tools: [] as string[][],
    };
});

vi.mock("./get-agent", () => {
    return {
        default: async (
            _model: string,
            options: {
                backupModelId?: string;
                language?: string;
                location?: string;
                modelFilterRules?: unknown;
                personalization?: Parameters<typeof getSystemPrompt>[3];
                timezone?: string;
                tools?: Record<string, unknown>;
            },
        ) => {
            seen.tools.push(Object.keys(options.tools ?? {}));
            seen.backups.push(options.backupModelId);
            seen.filters.push(options.modelFilterRules);

            const instructions = getSystemPrompt(options.timezone, options.location, options.language, options.personalization);
            const thread = {
                generateText: async (
                    args: { prepareStep?: (options: { messages: unknown[] }) => unknown; prompt?: string; providerOptions?: unknown; system?: string },
                    callOptions?: unknown,
                ) => {
                    seen.prepareSteps.push(args.prepareStep);
                    seen.prompts.push(args.prompt);
                    seen.providerOptions.push(args.providerOptions);
                    seen.callOptions.push(callOptions);

                    if (seen.failAt === "generate") {
                        throw new Error("model call failed");
                    }

                    seen.system.push(args.system ?? instructions);

                    return { text: seen.replies.shift() ?? "reply" };
                },
            };

            return {
                continueThread: async () => {
                    return { thread };
                },
                createThread: async (_ctx: unknown, args: unknown) => {
                    if (seen.failAt === "thread") {
                        throw new Error("thread creation failed");
                    }

                    seen.created.push(args);

                    return { thread, threadId: "thread-new" };
                },
                options: { instructions },
            };
        },
    };
});

vi.mock("../goals/review", () => {
    return {
        reviewRound: vi.fn(async () => {
            return { costMicrodollars: 0, met: seen.met.shift() ?? true, reason: "Add more." };
        }),
    };
});

vi.mock("./agent-tools", () => {
    return {
        buildAgentTools: async (_ctx: unknown, options: unknown) => {
            seen.buildOptions.push(options);

            return {
                mcpClients: [],
                mcpLabels: { mcp_notes_search: { serverName: "notes", toolName: "search" } },
                tools: { browser: {}, dateTime: {}, imageGeneration: {}, mcp_notes_search: {}, webSearch: {} },
            };
        },
    };
});

const { runHeadlessAgent } = await import("./headless-run");
const { buildRunStreamArgs } = await import("./agent-run");

const EMPTY_AFTER_STRIPPING = /empty after removing hidden characters/u;

const PREFS = {
    aboutMe: "SECRET-ABOUT-ME lives in Berlin with two cats",
    customInstructions: "SECRET-INSTRUCTIONS always sign as Captain",
    language: "en",
    location: "SECRET-LOCATION",
    memoryEnabled: false,
    nickname: "SECRET-NICKNAME",
    profession: "SECRET-PROFESSION",
};

const fakeCtx = (prefs: typeof PREFS = PREFS) =>
    ({
        runAction: vi.fn(),
        runMutation: vi.fn(async (reference: string) => (reference === "chat_goals_internal:chargeGoalRound" ? true : null)),
        runQuery: vi.fn(async (reference: string) => {
            if (reference === "auth_functions:getUserPreferencesQuery") {
                return prefs;
            }

            if (reference === "auth_functions:getAgentModulePreferencesQuery") {
                return { modelFilterRules: seen.filterRules };
            }

            if (reference === "auth_organization_policy:isOrganizationMemberQuery") {
                return !seen.notMember;
            }

            if (reference === "auth_functions:getDecryptedProviderKeysQuery") {
                if (seen.failAt === "keys") {
                    throw new Error("provider keys unavailable");
                }

                return {};
            }

            throw new Error(`unexpected query ${reference}`);
        }),
        scheduler: { runAfter: vi.fn() },
    }) as never;

const SECRETS = ["SECRET-ABOUT-ME", "SECRET-NICKNAME", "SECRET-PROFESSION", "SECRET-INSTRUCTIONS", "SECRET-LOCATION"];

describe("runHeadlessAgent personalization", () => {
    beforeEach(() => {
        seen.system = [];
    });

    it("keeps the owner's personalization out of a messenger reply", async () => {
        await runHeadlessAgent(fakeCtx(), {
            maxSteps: 3,
            memory: false,
            model: "test-model",
            organizationId: null,
            origin: "lead",
            personalization: "none",
            thread: { threadId: "thread-1" },
            tools: "none",
            userId: "owner",
        });

        expect(seen.system).toHaveLength(1);

        for (const secret of SECRETS) {
            expect(seen.system[0]).not.toContain(secret);
        }
    });

    it("gives a run the user reads their full personalization", async () => {
        await runHeadlessAgent(fakeCtx(), {
            memory: false,
            model: "test-model",
            organizationId: null,
            origin: "lead",
            personalization: "full",
            prompt: "Do the thing",
            thread: { title: "Trigger: x" },
            tools: "none",
            userId: "owner",
        });

        for (const secret of SECRETS) {
            expect(seen.system[0]).toContain(secret);
        }
    });
});

describe("runHeadlessAgent hidden characters", () => {
    const run = (prompt: string, system?: string) =>
        runHeadlessAgent(fakeCtx(), {
            memory: false,
            model: "test-model",
            organizationId: null,
            origin: "lead",
            personalization: "none",
            prompt,
            system,
            thread: { title: "t" },
            tools: "none",
            userId: "owner",
        });

    it("tells the agent the prompt and system text without tag or bidi characters", async () => {
        seen.prompts.length = 0;
        seen.system.length = 0;

        await run("Summarise this\u{E0069}\u{E0067}\u{202E}", "Be brief\u{E0041}");

        expect(seen.prompts.at(-1)).toBe("Summarise this");
        expect(seen.system.at(-1)).toContain("Be brief");
        expect(seen.system.at(-1)).not.toContain("\u{E0041}");
    });

    it("refuses a prompt that was only hidden characters", async () => {
        await expect(run("\u{E0069}\u{E0067}")).rejects.toThrow(EMPTY_AFTER_STRIPPING);
    });
});

describe("runHeadlessAgent backup model", () => {
    const BACKUP = MODEL_REGISTRY.find((m) => m.enabled !== false && m.provider !== "external" && (m.mode ?? "text") === "text" && !requiresPaidPlan(m))!.id;

    const PRIMARY = MODEL_REGISTRY.find(
        (m) => m.enabled !== false && m.provider !== "external" && (m.mode ?? "text") === "text" && !requiresPaidPlan(m) && m.id !== BACKUP,
    )!.id;

    const ctxWith = (backupModel: string | undefined) => {
        const ctx = fakeCtx() as unknown as { runQuery: ReturnType<typeof vi.fn> };
        const base = ctx.runQuery.getMockImplementation() as (reference: string, args: unknown) => Promise<unknown>;

        ctx.runQuery.mockImplementation(async (reference: string, args: unknown) => {
            const result = await base(reference, args);

            return reference === "auth_functions:getUserPreferencesQuery" ? { ...(result as object), backupModel } : result;
        });

        return ctx;
    };

    const run = async (ctx: unknown) =>
        await runHeadlessAgent(ctx as never, {
            memory: false,
            model: PRIMARY,
            organizationId: null,
            origin: "lead",
            personalization: "none",
            prompt: "Do the thing",
            thread: { threadId: "thread-1" },
            tools: "none",
            userId: "owner",
        });

    beforeEach(() => {
        seen.backups = [];
    });

    it("gives the agent the user's backup model, so an unattended run survives an outage too", async () => {
        await run(ctxWith(BACKUP));

        expect(seen.backups).toEqual([BACKUP]);
    });

    it("hands the user's privacy routing rules to the agent that builds the primary and the backup gateway models", async () => {
        seen.filterRules = { requireZDR: true } as never;
        seen.filters = [];

        try {
            await run(ctxWith(BACKUP));
        } finally {
            seen.filterRules = undefined;
        }

        expect(seen.filters).toEqual([{ requireZDR: true }]);
        expect(seen.backups).toEqual([BACKUP]);
    });

    it("gives none when the user's stored model filters exclude it, though the caller passes no rules", async () => {
        seen.filterRules = { blockedModels: [BACKUP] };

        try {
            await run(ctxWith(BACKUP));
        } finally {
            seen.filterRules = undefined;
        }

        expect(seen.backups).toEqual([undefined]);
    });

    it("gives none when the user set none", async () => {
        await run(ctxWith(undefined));

        expect(seen.backups).toEqual([undefined]);
    });
});

describe("runHeadlessAgent context sizing for a backup", () => {
    // A 1M-window primary and a 128k backup that cannot call tools.
    const PRIMARY = "google/gemini-2.5-flash";
    const NO_TOOLS_BACKUP = MODEL_REGISTRY.find(
        (m) => m.supportsToolCalling === false && m.enabled !== false && m.provider !== "external" && (m.mode ?? "text") === "text",
    )!.id;
    const big = Array.from({ length: 24 }, (_, index) => {
        return { content: "y".repeat(40_000), role: index % 2 === 0 ? "user" : "assistant" };
    });

    beforeEach(() => {
        seen.prepareSteps = [];
    });

    const sizedFor = async (toolAllowlist: string[]) => {
        const ctx = fakeCtx() as unknown as { runQuery: ReturnType<typeof vi.fn> };
        const base = ctx.runQuery.getMockImplementation() as (reference: string, args: unknown) => Promise<unknown>;

        ctx.runQuery.mockImplementation(async (reference: string, args: unknown) => {
            if (reference === "auth_functions:getUserRunPlanQuery") {
                return { isAdmin: true, plan: null };
            }

            const result = await base(reference, args);

            return reference === "auth_functions:getUserPreferencesQuery" ? { ...(result as object), backupModel: NO_TOOLS_BACKUP } : result;
        });

        await runHeadlessAgent(ctx as never, {
            maxSteps: 5,
            memory: false,
            model: PRIMARY,
            organizationId: null,
            origin: "lead",
            personalization: "none",
            prompt: "go",
            thread: { threadId: "thread-1" },
            toolAllowlist,
            tools: "headless",
            userId: "owner",
        });

        const prepareStep = seen.prepareSteps[0] as (options: { messages: unknown[] }) => unknown;

        return prepareStep({ messages: big });
    };

    it("sizes a run the allowlist strips of every tool for the backup, which then takes the call", async () => {
        expect(await sizedFor(["no-such-tool"])).toBeDefined();
    });

    it("leaves a run that still carries tools sized for the primary, since the backup would be skipped", async () => {
        expect(await sizedFor(["webSearch"])).toBeUndefined();
    });
});

describe("runHeadlessAgent thread tags", () => {
    beforeEach(() => {
        seen.created = [];
        seen.notMember = false;
    });

    const run = async (ctx: unknown, extra: Partial<Parameters<typeof runHeadlessAgent>[1]> = {}) =>
        await runHeadlessAgent(ctx as never, {
            memory: false,
            model: "test-model",
            organizationId: null,
            origin: "lead",
            personalization: "none",
            prompt: "Do the thing",
            thread: { tags: ["trigger"], title: "Trigger: x" },
            tools: "none",
            userId: "owner",
            ...extra,
        });

    it("creates a new thread with its tags, so no later write is needed to tell it apart", async () => {
        const ctx = fakeCtx() as unknown as { runMutation: ReturnType<typeof vi.fn> };

        await run(ctx);

        expect(seen.created).toEqual([{ tags: ["trigger"], title: "Trigger: x", userId: "owner" }]);

        const patches = ctx.runMutation.mock.calls.map(([, args]) => (args as { patch?: object }).patch);

        expect(patches.every((patch) => !patch || !("tags" in patch))).toBe(true);
    });

    it("leaves tags out of the creation when the caller gave none, and still sets the bot", async () => {
        const ctx = fakeCtx() as unknown as { runMutation: ReturnType<typeof vi.fn> };

        await run(ctx, { botId: "bot-1", thread: { title: "Chat" } });

        expect(seen.created).toEqual([{ title: "Chat", userId: "owner" }]);

        const patches = ctx.runMutation.mock.calls.map(([, args]) => (args as { patch?: object }).patch);

        expect(patches[0]).toEqual({ botId: "bot-1" });
    });

    it("creates a new thread with the run's organization, so no linked thread exists without it", async () => {
        const ctx = fakeCtx() as unknown as { runMutation: ReturnType<typeof vi.fn> };

        await run(ctx, { organizationId: "org-a" });

        expect(seen.created).toEqual([{ organizationId: "org-a", tags: ["trigger"], title: "Trigger: x", userId: "owner" }]);

        const patches = ctx.runMutation.mock.calls.map(([, args]) => (args as { patch?: object }).patch);

        expect(patches.some((patch) => patch && "organizationId" in patch)).toBe(false);
    });

    it("refuses a run whose owner left its organization, filing no thread under it", async () => {
        const ctx = fakeCtx();

        seen.notMember = true;

        // The run's own kind, so a trigger or task stops instead of failing on every later run.
        await expect(run(ctx, { organizationId: "org-left" })).rejects.toMatchObject({ kind: "left-organization", name: "AgentRunError" });
        expect(seen.created).toEqual([]);
    });

    it("never moves an existing thread into another organization", async () => {
        const ctx = fakeCtx() as unknown as { runMutation: ReturnType<typeof vi.fn> };

        await run(ctx, { organizationId: "org-b", thread: { threadId: "thread-1" } });

        const patches = ctx.runMutation.mock.calls.map(([, args]) => (args as { patch?: object }).patch);

        expect(patches.some((patch) => patch && "organizationId" in patch)).toBe(false);
    });
});

describe("runHeadlessAgent fresh context and reasoning effort", () => {
    beforeEach(() => {
        seen.callOptions = [];
        seen.providerOptions = [];
    });

    // A registry model whose provider takes an effort, so the effort becomes a provider option.
    const effortOptions = (model: string, effort: number) =>
        (buildRunStreamArgs({ model, reasoningEffort: effort }) as { providerOptions?: unknown }).providerOptions;
    const reasoningModel = MODEL_REGISTRY.find(
        (model) => model.enabled !== false && (model.mode ?? "text") === "text" && effortOptions(model.id, 100) !== undefined,
    );

    /** The owner is on a paid plan, so any registry model may run. */
    const paidCtx = () => {
        const ctx = fakeCtx() as unknown as { runQuery: (reference: string, args?: unknown) => Promise<unknown> };
        const base = ctx.runQuery;

        ctx.runQuery = async (reference, args) =>
            reference === "auth_functions:getUserRunPlanQuery" ? { isAdmin: false, plan: "premium" } : await base(reference, args);

        return ctx;
    };

    const run = async (extra: Partial<Parameters<typeof runHeadlessAgent>[1]> = {}) =>
        await runHeadlessAgent(paidCtx() as never, {
            memory: false,
            model: "test-model",
            origin: "lead",
            personalization: "none",
            prompt: "Run the report",
            thread: { threadId: "thread-1" },
            tools: "none",
            userId: "owner",
            ...extra,
        });

    it("sends no earlier turns of the thread on a fresh-context run", async () => {
        await run({ freshContext: true });

        expect(seen.callOptions).toStrictEqual([{ contextOptions: { recentMessages: 0 } }]);
    });

    it("starts only the first generation fresh: a goal's later round reads the run's own turns", async () => {
        seen.met = [false, true];

        await run({ freshContext: true, goal: { text: "Ship it" } });

        expect(seen.callOptions).toStrictEqual([{ contextOptions: { recentMessages: 0 } }, undefined]);
    });

    it("leaves the thread's history in a run that continues it", async () => {
        await run();

        expect(seen.callOptions).toStrictEqual([undefined]);
    });

    it("hands the run's reasoning effort to the model", async () => {
        expect(reasoningModel).toBeDefined();

        await run({ model: reasoningModel!.id, reasoningEffort: 100 });

        expect(seen.providerOptions).toStrictEqual([effortOptions(reasoningModel!.id, 100)]);
        expect(effortOptions(reasoningModel!.id, 100)).not.toStrictEqual(effortOptions(reasoningModel!.id, 0));
    });
});

describe("runHeadlessAgent tool allowlist", () => {
    beforeEach(() => {
        seen.buildOptions = [];
        seen.tools = [];
    });

    const run = async (extra: Partial<Parameters<typeof runHeadlessAgent>[1]>) =>
        await runHeadlessAgent(fakeCtx(), {
            maxSteps: 5,
            memory: false,
            model: "test-model",
            organizationId: null,
            origin: "lead",
            personalization: "none",
            thread: { threadId: "thread-1" },
            tools: "headless",
            userId: "owner",
            ...extra,
        });

    it("narrows to the allowlist and drops MCP tools unless told to keep them", async () => {
        await run({ toolAllowlist: ["webSearch", "imageGeneration"] });
        await run({ toolAllowlist: ["webSearch", "imageGeneration"], toolAllowlistKeepsMcp: true });

        expect(seen.tools).toStrictEqual([
            ["imageGeneration", "webSearch"],
            ["imageGeneration", "mcp_notes_search", "webSearch"],
        ]);
    });

    it("offers extra built-ins to the tool builder as candidates, headless", async () => {
        await run({ additionalTools: ["imageGeneration"], toolAllowlist: ["imageGeneration"] });

        expect(seen.buildOptions[0]).toMatchObject({ headless: true, skillTools: { additionalTools: ["imageGeneration"] } });
    });
});

describe("runHeadlessAgent onGenerationStart", () => {
    const run = async (onGenerationStart: () => void) =>
        await runHeadlessAgent(fakeCtx(), {
            memory: false,
            model: "test-model",
            onGenerationStart,
            organizationId: null,
            origin: "lead",
            personalization: "full",
            prompt: "Do the thing",
            thread: { title: "Trigger: x" },
            tools: "none",
            userId: "owner",
        });

    beforeEach(() => {
        seen.failAt = undefined;
    });

    it("is called once, right before the model is asked", async () => {
        const started = vi.fn();

        await run(started);

        expect(started).toHaveBeenCalledTimes(1);
    });

    it("is not called when the provider keys fail to load", async () => {
        const started = vi.fn();

        seen.failAt = "keys";
        await expect(run(started)).rejects.toThrow("provider keys unavailable");
        expect(started).not.toHaveBeenCalled();
    });

    it("is not called when the thread cannot be created", async () => {
        const started = vi.fn();

        seen.failAt = "thread";
        await expect(run(started)).rejects.toThrow("thread creation failed");
        expect(started).not.toHaveBeenCalled();
    });

    it("is called when the model call itself fails", async () => {
        const started = vi.fn();

        seen.failAt = "generate";
        await expect(run(started)).rejects.toThrow("model call failed");
        expect(started).toHaveBeenCalledTimes(1);
    });
});

describe("runHeadlessAgent with a goal and memory", () => {
    beforeEach(() => {
        seen.failAt = undefined;
        seen.replies = [];
        seen.met = [];
    });

    const extractions = (ctx: { scheduler: { runAfter: ReturnType<typeof vi.fn> } }): string[] =>
        ctx.scheduler.runAfter.mock.calls.flatMap((call) =>
            (call[2] as { assistantResponse?: string } | undefined)?.assistantResponse ? [(call[2] as { assistantResponse: string }).assistantResponse] : [],
        );

    it("remembers only the answer the goal ended on, not an interim round", async () => {
        seen.replies = ["interim answer", "final answer"];
        seen.met = [false, true];

        const ctx = fakeCtx({ ...PREFS, memoryEnabled: true });
        const result = await runHeadlessAgent(ctx, {
            goal: { text: "Ship it" },
            memory: true,
            model: "test-model",
            organizationId: null,
            origin: "lead",
            personalization: "none",
            prompt: "Do the thing",
            thread: { title: "Trigger: x" },
            tools: "none",
            userId: "owner",
        });

        expect(result.text).toBe("final answer");
        expect(extractions(ctx as never)).toEqual(["final answer"]);
    });

    it("still remembers the answer of a run without a goal", async () => {
        seen.replies = ["only answer"];

        const ctx = fakeCtx({ ...PREFS, memoryEnabled: true });

        await runHeadlessAgent(ctx, {
            memory: true,
            model: "test-model",
            organizationId: null,
            origin: "lead",
            personalization: "none",
            prompt: "Do the thing",
            thread: { title: "t" },
            tools: "none",
            userId: "owner",
        });

        expect(extractions(ctx as never)).toEqual(["only answer"]);
    });
});
