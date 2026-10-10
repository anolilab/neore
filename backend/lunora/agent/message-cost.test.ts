import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { withGatewayCost } from "../chat/lib/gateway-language-model";
import { GATEWAY_COST_METADATA_KEY, readMessageCost, sumMessageCosts, sumStepUsage } from "./message-cost";

type FinishPart = Extract<LanguageModelV3StreamPart, { type: "finish" }>;

const finish = (providerMetadata?: FinishPart["providerMetadata"]): FinishPart => {
    return {
        finishReason: { raw: "stop", unified: "stop" },
        type: "finish",
        usage: {
            inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 10, total: 10 },
            outputTokens: { reasoning: undefined, text: 5, total: 5 },
        },
        ...(providerMetadata && { providerMetadata }),
    };
};

describe(withGatewayCost, () => {
    it("folds the gateway cost into the finish part, keeping provider metadata", () => {
        const result = withGatewayCost(finish({ openai: { id: "x" } }), { cost: { microdollars: 1234, pricingAvailable: true } }, false);

        expect(result.providerMetadata).toStrictEqual({
            [GATEWAY_COST_METADATA_KEY]: { byok: false, costMicrodollars: 1234, pricingAvailable: true },
            openai: { id: "x" },
        });
    });

    it("records BYOK and missing pricing", () => {
        const result = withGatewayCost(finish(), { cost: { microdollars: 0, pricingAvailable: false } }, true);

        expect(readMessageCost(result.providerMetadata)).toStrictEqual({ byok: true, microdollars: 0, pricingAvailable: false });
    });

    it("folds cost into a doGenerate-shaped result too", () => {
        const result = withGatewayCost({ content: [], providerMetadata: undefined }, { cost: { microdollars: 7, pricingAvailable: true } }, false);

        expect(readMessageCost(result.providerMetadata)).toStrictEqual({ byok: false, microdollars: 7, pricingAvailable: true });
        expect(result.content).toStrictEqual([]);
    });

    it("leaves the part unchanged when the cost is malformed", () => {
        const part = finish();

        expect(withGatewayCost(part, { cost: { microdollars: "12" } }, false)).toBe(part);
        expect(withGatewayCost(part, {}, false)).toBe(part);
    });
});

describe(readMessageCost, () => {
    it("returns undefined for metadata without a gateway entry", () => {
        expect(readMessageCost(undefined)).toBeUndefined();
        expect(readMessageCost({ openai: {} })).toBeUndefined();
        expect(readMessageCost({ [GATEWAY_COST_METADATA_KEY]: { costMicrodollars: -1 } })).toBeUndefined();
    });
});

describe(sumMessageCosts, () => {
    it("sums every step that carries a cost and skips those that do not", () => {
        const step = (costMicrodollars: number, extra: Record<string, unknown> = {}) => {
            return { [GATEWAY_COST_METADATA_KEY]: { byok: false, costMicrodollars, pricingAvailable: true, ...extra } };
        };

        expect(sumMessageCosts([step(100), undefined, step(250, { byok: true }), step(50, { pricingAvailable: false })])).toStrictEqual({
            byok: true,
            microdollars: 400,
            pricingAvailable: false,
        });
    });

    it("returns undefined when no step carries a cost", () => {
        expect(sumMessageCosts([undefined, {}])).toBeUndefined();
    });
});

describe(sumStepUsage, () => {
    it("sums token counts across steps and keeps the turn timings", () => {
        expect(
            sumStepUsage([
                { cachedInputTokens: 50, completionTokens: 20, promptTokens: 100, totalTokens: 120 },
                undefined,
                { completionTokens: 30, durationMs: 900, promptTokens: 140, reasoningTokens: 12, totalTokens: 170, ttftMs: 210 },
            ]),
        ).toStrictEqual({
            cachedInputTokens: 50,
            completionTokens: 50,
            durationMs: 900,
            promptTokens: 240,
            reasoningTokens: 12,
            totalTokens: 290,
            ttftMs: 210,
        });
    });

    it("returns undefined when no step has usage", () => {
        expect(sumStepUsage([undefined, undefined])).toBeUndefined();
    });
});
