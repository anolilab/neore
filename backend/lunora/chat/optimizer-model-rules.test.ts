/**
 * The prompt optimizers and the skill-draft generator send the user's text (and, for a thread-continuing
 * optimizer, its recent messages) to a model, so each one carries the user's model filter rules to the gateway,
 * and refuses rather than run unrestricted when the rules cannot be read or allow no model.
 */
import { DEFAULT_PROMPT_IMPROVEMENT_MODEL } from "@neore/ai/constants";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

const { generateObject, generateText, getAgent, registry, sessionFrom } = vi.hoisted(() => {
    return {
        generateObject: vi.fn(),
        generateText: vi.fn(),
        getAgent: vi.fn(),
        registry: new Map<string, unknown>(),
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, plan: null, role: null, userId: context.auth.userId }
                : null,
    };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateText };
});

vi.mock("./lib/get-agent", () => {
    return { default: getAgent };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

const PREFERENCES = "auth_functions:getAgentModulePreferencesQuery";

beforeAll(async () => {
    registerModule(registry, "auth_functions", await import("../auth/functions"));
    registerModule(registry, "lib_rate_limiter_mutations", await import("../lib/rate-limiter-mutations"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
});

// eslint-disable-next-line import/first -- the mocks above must be hoisted before these load
import { optimizePrompt } from "../prompts/functions";
// eslint-disable-next-line import/first
import schema from "../schema";
// eslint-disable-next-line import/first
import { generateSkillDraft } from "../skills/generate";
// eslint-disable-next-line import/first
import { improvePrompt, iteratePrompt, optimizeSystemPrompt } from "./functions";
// eslint-disable-next-line import/first
import { loadOptimizerModelRules, MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE, NO_ALLOWED_OPTIMIZER_MODEL_MESSAGE } from "./lib/optimizer-model-rules";

const USER = "user-1";
const RULES = { denyDataCollection: true, requireZDR: true };

let harness: ReturnType<typeof lunoraTest>;
let realPreferences: unknown;

const saveRules = async (modelFilterRules: Record<string, unknown>) =>
    await harness.run(async (ctx: any) => await ctx.db.insert("aiUserPreferences", { modelFilterRules, userId: USER }));

const run = async (action: unknown, args: Record<string, unknown>) =>
    await harness.action(async (context: any) => await context.runAction(action, { userId: USER, ...args }));

const failure = async (promise: Promise<unknown>): Promise<{ code?: string; message?: string }> => {
    try {
        await promise;
    } catch (error) {
        return error as { code?: string; message?: string };
    }

    return {};
};

const runs: Record<string, () => Promise<unknown>> = {
    generateSkillDraft: async () =>
        await harness.withIdentity({ userId: USER } as never).action(generateSkillDraft as never, { goal: "Summarise a meeting into action items" } as never),
    improvePrompt: async () => await run(improvePrompt, { prompt: "write a poem" }),
    iteratePrompt: async () => await run(iteratePrompt, { iterateInput: "shorter", lastOptimizedPrompt: "write a poem" }),
    optimizePrompt: async () => await run(optimizePrompt, { content: "write a poem" }),
    optimizeSystemPrompt: async () => await run(optimizeSystemPrompt, { prompt: "be helpful" }),
};

beforeEach(() => {
    harness = lunoraTest(schema as never);
    realPreferences = registry.get(PREFERENCES);

    const thread = { generateObject, threadId: "temp-thread" };

    generateObject.mockResolvedValue({ object: { improvedPrompt: "better", optimizedPrompt: "better" } });
    generateText.mockResolvedValue({ output: { description: "d", instructions: "i", name: "n", slug: "n" }, usage: {} });
    getAgent.mockResolvedValue({
        createThread: async () => {
            return { thread };
        },
        options: { languageModel: { id: "model" } },
    });
});

afterEach(() => {
    registry.set(PREFERENCES, realPreferences);
    harness.close();
    vi.clearAllMocks();
});

describe.each(Object.keys(runs))("%s", (name) => {
    it("hands the user's model filter rules to the agent", async () => {
        await saveRules(RULES);
        await runs[name]!().catch(() => undefined);

        expect(getAgent).toHaveBeenCalledTimes(1);
        expect(getAgent.mock.calls[0]![1].modelFilterRules).toStrictEqual(RULES);
    });

    it("refuses without a model call when the rules cannot be read", async () => {
        // A query that throws (rather than one that answers `readFailed`) is an unreadable read too.
        registry.set(PREFERENCES, {});

        const error = await failure(runs[name]!());

        expect(error.code).toBe("BAD_REQUEST");
        expect(error.message).toContain(MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE);
        expect(getAgent).not.toHaveBeenCalled();
    });

    it("refuses without a model call when the rules exclude the optimizer's model", async () => {
        await saveRules({ blockedModels: [DEFAULT_PROMPT_IMPROVEMENT_MODEL] });

        const error = await failure(runs[name]!());

        expect(error.code).toBe("BAD_REQUEST");
        expect(error.message).toContain(NO_ALLOWED_OPTIMIZER_MODEL_MESSAGE);
        expect(getAgent).not.toHaveBeenCalled();
    });
});

describe.each(Object.keys(runs))("%s with a blocked region", (name) => {
    it("refuses a model that is reachable in a blocked region even though another of its regions is allowed", async () => {
        // The optimizer model is served from the US and EU; blocking the US alone must refuse it, as the background models do.
        await saveRules({ blockedRegions: ["US"] });

        const error = await failure(runs[name]!());

        expect(error.code).toBe("BAD_REQUEST");
        expect(error.message).toContain(NO_ALLOWED_OPTIMIZER_MODEL_MESSAGE);
        expect(getAgent).not.toHaveBeenCalled();
    });
});

describe("loadOptimizerModelRules", () => {
    it("applies the thread owner's rules as well as the caller's on a shared thread", async () => {
        const rulesOf: Record<string, unknown> = { owner: { blockedModels: [DEFAULT_PROMPT_IMPROVEMENT_MODEL] }, [USER]: {} };
        const runQuery = vi.fn(async (_reference: unknown, args: { userId: string }) => {
            return { modelFilterRules: rulesOf[args.userId] };
        });

        const error = await failure(loadOptimizerModelRules({ runQuery } as never, USER, DEFAULT_PROMPT_IMPROVEMENT_MODEL, "owner"));

        expect(error.code).toBe("BAD_REQUEST");
        expect(error.message).toContain(NO_ALLOWED_OPTIMIZER_MODEL_MESSAGE);
    });

    it("refuses when the owner's settings cannot be read", async () => {
        const runQuery = vi.fn(async (_reference: unknown, args: { userId: string }) => (args.userId === "owner" ? { readFailed: true } : {}));

        const error = await failure(loadOptimizerModelRules({ runQuery } as never, USER, DEFAULT_PROMPT_IMPROVEMENT_MODEL, "owner"));

        expect(error.code).toBe("BAD_REQUEST");
        expect(error.message).toContain(MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE);
    });

    const withAnswer = (answer: () => unknown) => ({ runQuery: vi.fn(async () => answer()) }) as never;

    it("refuses when the preferences read answers readFailed", async () => {
        const error = await failure(
            loadOptimizerModelRules(
                withAnswer(() => {
                    return { readFailed: true };
                }),
                USER,
                DEFAULT_PROMPT_IMPROVEMENT_MODEL,
            ),
        );

        expect(error.code).toBe("BAD_REQUEST");
        expect(error.message).toContain(MODEL_FILTER_RULES_UNAVAILABLE_MESSAGE);
    });

    it("answers no rules for a user who set none", async () => {
        await expect(
            loadOptimizerModelRules(
                withAnswer(() => {
                    return {};
                }),
                USER,
                DEFAULT_PROMPT_IMPROVEMENT_MODEL,
            ),
        ).resolves.toStrictEqual({});
    });
});
