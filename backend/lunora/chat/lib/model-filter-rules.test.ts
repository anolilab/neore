/**
 * A failed read of the user's model filters is not "no rules": a background call must not pick a model without them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveBackgroundModel } from "./background-model";
import { createRunLowRiskCheck } from "./low-risk-check";
import { loadModelFilterRules, ModelFilterRulesUnavailableError } from "./model-filter-rules";

const generateText = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateText };
});
vi.mock("@neore/ai/providers", async () => {
    const { MODEL_REGISTRY } = await import("@neore/ai/models");

    return { buildAgents: () => Object.fromEntries(MODEL_REGISTRY.map((model) => [model.id, { chat: { modelId: model.id } }])) };
});
vi.mock("../../lib/services", () => {
    return { gatewayFetch: () => async () => new Response("{}") };
});

const prefs = (extra: object = {}) => {
    return {
        autoDetectComplexity: false,
        autoMediaEnrichment: false,
        enableDatasource: false,
        enableKnowledge: false,
        enablePlanner: false,
        ...extra,
    };
};
const FREE_PLAN = { isAdmin: false, plan: null };
const PLAN_REF = "getUserRunPlanQuery";

/** A ctx whose preferences read behaves as `preferences` says; `plan` answers the plan read. */
const ctxOf = (preferences: () => unknown, plan: unknown = FREE_PLAN) =>
    ({
        log: { event: vi.fn() },
        runMutation: vi.fn(async () => true),
        runQuery: vi.fn(async (reference: unknown) =>
            JSON.stringify(reference).includes(PLAN_REF) || String(reference).includes(PLAN_REF) ? plan : preferences(),
        ),
    }) as never;

const failing = () => {
    throw new Error("D1 unavailable");
};

beforeEach(() => {
    generateText.mockReset();
    generateText.mockResolvedValue({ output: { lowRisk: false, reason: "x" } });
});

describe("loadModelFilterRules", () => {
    it("reads no rules as an empty set", async () => {
        await expect(
            loadModelFilterRules(
                ctxOf(() => prefs()),
                "u1",
            ),
        ).resolves.toEqual({});
    });

    it("throws when the preferences query throws", async () => {
        await expect(loadModelFilterRules(ctxOf(failing), "u1")).rejects.toBeInstanceOf(ModelFilterRulesUnavailableError);
    });

    it("throws when the query reports its own read failed", async () => {
        await expect(
            loadModelFilterRules(
                ctxOf(() => prefs({ readFailed: true })),
                "u1",
            ),
        ).rejects.toBeInstanceOf(ModelFilterRulesUnavailableError);
    });
});

describe("a failed rules read", () => {
    it("makes a background caller skip rather than pick a model", async () => {
        await expect(resolveBackgroundModel(ctxOf(failing), "u1", "moonshotai/kimi-k2-0905")).resolves.toBeUndefined();
        await expect(
            resolveBackgroundModel(
                ctxOf(() => prefs({ readFailed: true })),
                "u1",
                "moonshotai/kimi-k2-0905",
            ),
        ).resolves.toBeUndefined();
    });

    it("still resolves a model when the read succeeded with no rules", async () => {
        await expect(
            resolveBackgroundModel(
                ctxOf(() => prefs()),
                "u1",
                "moonshotai/kimi-k2-0905",
            ),
        ).resolves.toMatchObject({ model: "moonshotai/kimi-k2-0905" });
    });

    it("keeps a tool call for a person, with no model call, in the quick check", async () => {
        const { check } = createRunLowRiskCheck(ctxOf(failing), { threadId: "t1", untrustedContext: Promise.resolve(false), userId: "u1" });

        await expect(check({ input: { query: "weather" }, key: "mcp:Weather:get_forecast", messages: [], toolCallId: "c1" })).resolves.toBe(false);
        expect(generateText).not.toHaveBeenCalled();
    });
});

describe("the plan carried by the rules", () => {
    it("lets a paid user's background call fall back to a paid model, and a free user's not", async () => {
        const rules = () => prefs({ modelFilterRules: { allowedModels: ["anthropic/claude-haiku-4.5"] } });

        await expect(resolveBackgroundModel(ctxOf(rules, { isAdmin: false, plan: null }), "u1", "moonshotai/kimi-k2-0905")).resolves.toBeUndefined();
        await expect(resolveBackgroundModel(ctxOf(rules, { isAdmin: false, plan: "premium" }), "u1", "moonshotai/kimi-k2-0905")).resolves.toMatchObject({
            model: "anthropic/claude-haiku-4.5",
        });
        await expect(resolveBackgroundModel(ctxOf(rules, { isAdmin: true, plan: null }), "u1", "moonshotai/kimi-k2-0905")).resolves.toMatchObject({
            model: "anthropic/claude-haiku-4.5",
        });
    });
});
