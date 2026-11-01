/**
 * The quick check judges with the model it names, and never with a substitute: a user whose model filter rules
 * refuse it is asked about every call (fail closed), and spends none of the quick-check budget on the attempt.
 */
import { DEFAULT_MEMORY_EXTRACTION_MODEL } from "@neore/ai/constants";
import type { ModelFilterRules } from "@neore/ai/models";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRunLowRiskCheck } from "./low-risk-check";

const state = vi.hoisted(() => {
    return { rules: {} as ModelFilterRules };
});
const generateText = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateText };
});
vi.mock("@neore/ai/providers", async () => {
    const { MODEL_REGISTRY } = await import("@neore/ai/models");

    return { buildAgents: () => Object.fromEntries(MODEL_REGISTRY.map((model) => [model.id, { chat: { modelId: model.id } }])) };
});
vi.mock("./model-filter-rules", () => {
    return { loadModelFilterRules: async () => state.rules };
});
vi.mock("../../lib/services", () => {
    return { gatewayFetch: () => async () => new Response("{}") };
});

const consumeLowRiskCheck = vi.fn(async () => true);
const ctx = {
    log: { event: vi.fn() },
    runMutation: consumeLowRiskCheck,
    runQuery: vi.fn(async () => null),
} as never;

const readCall = { input: { query: "weather" }, key: "mcp:Weather:get_forecast", messages: [], toolCallId: "call-1" };
const newCheck = () => createRunLowRiskCheck(ctx, { threadId: "thread-1", untrustedContext: Promise.resolve(false), userId: "user-1" }).check;

beforeEach(() => {
    state.rules = {};
    generateText.mockReset();
    generateText.mockResolvedValue({ output: { lowRisk: false, reason: "needs a person" } });
    consumeLowRiskCheck.mockClear();
});

describe("the quick check under the user's model filter rules", () => {
    it("asks the model, and spends budget, when no rules are set", async () => {
        await newCheck()(readCall);

        expect(generateText).toHaveBeenCalledOnce();
        expect(consumeLowRiskCheck).toHaveBeenCalledOnce();
    });

    it("keeps the call for a person, with no model call and no budget spent, when the rules exclude its model", async () => {
        state.rules = { blockedModels: [DEFAULT_MEMORY_EXTRACTION_MODEL] };

        await expect(newCheck()(readCall)).resolves.toBe(false);
        await expect(newCheck()(readCall)).resolves.toBe(false);

        expect(generateText).not.toHaveBeenCalled();
        expect(consumeLowRiskCheck).not.toHaveBeenCalled();
    });
});
