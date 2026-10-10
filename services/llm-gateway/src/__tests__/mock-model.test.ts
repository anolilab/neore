/**
 * The `MOCK_LLM` provider: its gate, its prompt markers, its structured output,
 * and that the real proxy route streams it with usage and a cost.
 */
import type { JSONSchema7, LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import type { AppEnv } from "../env.js";
import { app } from "../index.js";
import { createProviderModelForEnv, resolveApiKey } from "../providers/factory.js";
import {
    assertMockLlmAllowed,
    createMockLanguageModel,
    isMockLlmEnabled,
    minimalValueForSchema,
    MOCK_PRICING,
    mockDelayMs,
    planMockResponse,
} from "../providers/mock-model.js";
import { PricingService } from "../providers/pricing.js";
import { bindingEnv, makeInternalRequest } from "./helpers/internal.js";
import { createMockCtx, createMockEnv } from "./helpers/mock-env.js";

const MOCK_LLM_RE = /MOCK_LLM/;

const userPrompt = (text: string): LanguageModelV3CallOptions["prompt"] => [{ content: [{ text, type: "text" }], role: "user" }];

const options = (overrides: Partial<LanguageModelV3CallOptions> & { text?: string } = {}): LanguageModelV3CallOptions => {
    const { text = "hello", ...rest } = overrides;

    return { prompt: userPrompt(text), ...rest };
};

const readAll = async (model: LanguageModelV3, callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamPart[]> => {
    const { stream } = await model.doStream(callOptions);
    const parts: LanguageModelV3StreamPart[] = [];
    const reader = stream.getReader();

    for (;;) {
        const { done, value } = await reader.read();

        if (done) {
            return parts;
        }

        parts.push(value);
    }
};

const mockEnv = (overrides: Partial<AppEnv> = {}): AppEnv =>
    ({ ...createMockEnv({ nodeEnv: "development" }), MOCK_LLM: "1", ...overrides }) as unknown as AppEnv;

describe("mock LLM gate", () => {
    it("is on only with the flag outside production", () => {
        expect.assertions(5);

        expect(isMockLlmEnabled({ MOCK_LLM: "1", NODE_ENV: "development" })).toBe(true);
        expect(isMockLlmEnabled({ MOCK_LLM: "true", NODE_ENV: "test" })).toBe(true);
        expect(isMockLlmEnabled({ MOCK_LLM: undefined, NODE_ENV: "development" })).toBe(false);
        expect(isMockLlmEnabled({ MOCK_LLM: "0", NODE_ENV: "development" })).toBe(false);
        expect(isMockLlmEnabled({ MOCK_LLM: "1", NODE_ENV: "production" })).toBe(false);
    });

    it("throws when the flag is set in production, by either signal", () => {
        expect.assertions(3);

        expect(() => assertMockLlmAllowed({ MOCK_LLM: "1", NODE_ENV: "production" })).toThrow(MOCK_LLM_RE);
        expect(() => assertMockLlmAllowed({ ENVIRONMENT: "production", MOCK_LLM: "1", NODE_ENV: "development" })).toThrow(MOCK_LLM_RE);
        expect(() => assertMockLlmAllowed({ MOCK_LLM: undefined, NODE_ENV: "production" })).not.toThrow();
    });

    it("fails every request, health included, when set in production", async () => {
        expect.assertions(2);

        const env = mockEnv({ NODE_ENV: "production" });
        const response = await app.fetch(new Request("http://localhost/health"), env, createMockCtx());

        expect(response.status).toBe(500);
        await expect(response.text()).resolves.toContain("MOCK_LLM");
    });

    it("swaps every provider for the mock and needs no key", async () => {
        expect.assertions(3);

        const env = mockEnv({ OPENROUTER_API_KEY: undefined });

        expect(resolveApiKey("openrouter", env)).toBe("mock");

        const model = (await createProviderModelForEnv(env, "openrouter", "google/gemini-2.5-flash", "mock")) as LanguageModelV3;

        expect(model.provider).toBe("mock");
        await expect(new PricingService(env).getPricing("google/gemini-2.5-flash")).resolves.toStrictEqual(MOCK_PRICING);
    });
});

describe("mock LLM responses", () => {
    const model = createMockLanguageModel();

    it("streams deterministic text with usage", async () => {
        expect.assertions(4);

        const first = await readAll(model, options({ text: "What is 2+2?" }));
        const second = await readAll(model, options({ text: "What is 2+2?" }));
        const text = first.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("");
        const finish = first.find((part) => part.type === "finish");

        expect(text).toBe("Mock reply: What is 2+2?");
        expect(second).toStrictEqual(first);
        expect(finish?.type === "finish" && finish.finishReason.unified).toBe("stop");
        expect(finish?.type === "finish" && finish.usage.outputTokens.total).toBeGreaterThan(0);
    });

    it("emits reasoning only when asked", async () => {
        expect.assertions(2);

        const withReasoning = await readAll(model, options({ text: "think [[reasoning]]" }));
        const without = await readAll(model, options({ text: "think" }));

        expect(withReasoning.some((part) => part.type === "reasoning-delta")).toBe(true);
        expect(without.some((part) => part.type === "reasoning-start")).toBe(false);
    });

    it("calls a marked tool once, then answers after its result", async () => {
        expect.assertions(3);

        const tools: LanguageModelV3CallOptions["tools"] = [{ inputSchema: { type: "object" }, name: "getWeather", type: "function" }];
        const text = 'weather please [[tool:getWeather {"city":"Berlin"}]]';
        const parts = await readAll(model, options({ text, tools }));
        const call = parts.find((part) => part.type === "tool-call");

        expect(call).toMatchObject({ input: '{"city":"Berlin"}', toolName: "getWeather" });

        const followUp = planMockResponse({
            prompt: [
                ...userPrompt(text),
                { content: [{ input: { city: "Berlin" }, toolCallId: "c1", toolName: "getWeather", type: "tool-call" }], role: "assistant" },
                { content: [{ output: { type: "text", value: "sunny" }, toolCallId: "c1", toolName: "getWeather", type: "tool-result" }], role: "tool" },
            ],
            tools,
        });

        expect(followUp.kind).toBe("text");
        expect(planMockResponse(options({ text, tools: [] })).kind).toBe("text");
    });

    it("returns a schema-valid minimal object for JSON mode", async () => {
        expect.assertions(2);

        const schema = {
            $defs: { Step: { properties: { id: { minLength: 3, type: "string" } }, required: ["id"], type: "object" } },
            properties: {
                count: { minimum: 2, type: "integer" },
                kind: { enum: ["a", "b"] },
                note: { anyOf: [{ type: "null" }, { type: "string" }] },
                passed: { type: "boolean" },
                steps: { items: { $ref: "#/$defs/Step" }, minItems: 1, type: "array" },
                title: { type: "string" },
            },
            required: ["title", "passed", "kind", "count", "steps"],
            type: "object",
        } satisfies JSONSchema7;

        const result = await model.doGenerate({ prompt: userPrompt("title this"), responseFormat: { schema, type: "json" } });
        const text = result.content.find((part) => part.type === "text");

        expect(JSON.parse(text?.type === "text" ? text.text : "null")).toStrictEqual({
            count: 2,
            kind: "a",
            note: "Mock response",
            passed: true,
            steps: [{ id: "Mock response" }],
            title: "Mock response",
        });
        expect(minimalValueForSchema({ items: { type: "number" }, type: "array" })).toStrictEqual([]);
    });

    it("answers a prompt-level JSON instruction from its template", () => {
        expect.assertions(2);

        const verifier = planMockResponse({
            prompt: [
                {
                    content:
                        'You are a strict verifier.\n\nRespond with ONLY a JSON object:\n{"pass": boolean, "reasons": string[], "repairInstructions": string}',
                    role: "system",
                },
                ...userPrompt("Verify this task result."),
            ],
        });
        const suggestions = planMockResponse({ prompt: userPrompt('Respond with ONLY a JSON object in this exact format:\n{"suggestions": ["question 1"]}') });

        expect(verifier).toStrictEqual({ kind: "json", text: JSON.stringify({ pass: true, reasons: [], repairInstructions: "" }) });
        expect(suggestions).toStrictEqual({ kind: "json", text: '{"suggestions": ["question 1"]}' });
    });
});

describe("mock LLM through /internal/model/proxy", () => {
    it("streams the mock and trails a non-zero cost", async () => {
        expect.assertions(3);

        const body = JSON.stringify({
            action: "stream",
            callOptions: { prompt: userPrompt("ping [[reasoning]]") },
            modelApiId: "google/gemini-2.5-flash",
            modelId: "gemini-2.5-flash",
            provider: "openrouter",
            requestId: "req-mock-1",
            userId: "user-1",
        });
        const response = await app.fetch(makeInternalRequest("POST", "/internal/model/proxy", body), bindingEnv(mockEnv()), createMockCtx());
        const raw = await response.text();
        const events = raw
            .split("\n\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)) as { cost?: { microdollars: number }; delta?: string; type: string });

        expect(response.status).toBe(200);
        expect(
            events
                .filter((event) => event.type === "text-delta")
                .map((event) => event.delta)
                .join(""),
        ).toBe("Mock reply: ping");
        expect(events.find((event) => event.type === "gateway-metadata")?.cost?.microdollars).toBeGreaterThan(0);
    });
});

describe("[[delay:<ms>]] marker", () => {
    it("reads the delay from any message, capped at 60s, and 0 without one", () => {
        expect(mockDelayMs(userPrompt("hi [[delay:1500]]"))).toBe(1500);
        expect(mockDelayMs([{ content: "Title for: slow [[delay:200]]", role: "system" }, ...userPrompt("x")])).toBe(200);
        expect(mockDelayMs(userPrompt("[[delay:999999]]"))).toBe(60_000);
        expect(mockDelayMs(userPrompt("no marker"))).toBe(0);
    });

    it("waits before answering and keeps the marker out of the echo", async () => {
        const started = Date.now();
        const parts = await readAll(createMockLanguageModel(), options({ text: "slow one [[delay:120]]" }));
        const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("");

        expect(Date.now() - started).toBeGreaterThanOrEqual(110);
        expect(text).toBe("Mock reply: slow one");
    });
});
