/**
 * The typed fallback on /v1/chat/completions: when the primary model cannot be
 * built, the retry must carry the same options as the primary (tools, tool
 * choice, stream usage) and reply in the same shape.
 *
 * The primary's model creation is made to fail once. The retry then gets the
 * mock model, which is the real factory's answer under MOCK_LLM.
 */
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { createMockEnv, makeVirtualKeyRow } from "../helpers/mock-env.js";
import { useTrackedAppFetch } from "../helpers/tracked-app-fetch.js";

const state = vi.hoisted(() => {
    return { failNextModel: false, topPs: [] as unknown[] };
});

vi.mock("../../providers/factory.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../providers/factory.js")>();

    return {
        ...actual,
        createProviderModelForEnv: vi.fn(async (...args: Parameters<typeof actual.createProviderModelForEnv>) => {
            if (state.failNextModel) {
                state.failNextModel = false;

                throw Object.assign(new Error("upstream unavailable"), { statusCode: 503 });
            }

            const model = (await actual.createProviderModelForEnv(...args)) as LanguageModelV3;

            return {
                ...model,
                doGenerate: async (options: LanguageModelV3CallOptions) => {
                    state.topPs.push(options.topP);

                    return model.doGenerate(options);
                },
                doStream: async (options: LanguageModelV3CallOptions) => {
                    state.topPs.push(options.topP);

                    return model.doStream(options);
                },
            };
        }),
        resolveApiKey: vi.fn().mockReturnValue("test-api-key"),
    };
});

const TOKEN = "gk_chat_fallback_integration_test";
// A model with an infra fallback candidate in the catalogue (see fallback.test.ts).
const MODEL = "gemini-2.5-flash";
const TOOLS = [{ function: { name: "get_weather", parameters: { type: "object" } }, type: "function" }];

const fetchApp = useTrackedAppFetch();

const env = async () => {
    const row = await makeVirtualKeyRow(TOKEN, { tier: "pro" });

    return { ...createMockEnv({ apiKeyCacheRows: [row], nodeEnv: "development" }), MOCK_LLM: "1" } as never;
};

const chat = (body: Record<string, unknown>): Request =>
    new Request("http://localhost/v1/chat/completions", {
        body: JSON.stringify({ model: MODEL, ...body }),
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        method: "POST",
    });

const framesOf = async (res: Response): Promise<string[]> => {
    const text = await res.text();

    return text
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => frame.slice("data: ".length));
};

const toolPrompt = { content: 'Weather? [[tool:get_weather {"city":"Oslo"}]]', role: "user" };

describe("chat fallback: top_p", () => {
    it("passes top_p to the fallback model, streamed and not", async () => {
        const fixture = await env();

        state.topPs.length = 0;
        state.failNextModel = true;
        const plain = await fetchApp(chat({ messages: [{ content: "ping", role: "user" }], top_p: 0.25 }), fixture);

        await plain.json();

        state.failNextModel = true;

        const streamed = await fetchApp(chat({ messages: [{ content: "ping", role: "user" }], stream: true, top_p: 0.25 }), fixture);

        await streamed.text();

        expect(state.topPs).toEqual([0.25, 0.25]);
    });
});

describe("chat fallback: non-streaming", () => {
    it("retries on the fallback model and returns its tool calls", async () => {
        state.failNextModel = true;

        const res = await fetchApp(chat({ messages: [toolPrompt], tools: TOOLS }), await env());
        const body = (await res.json()) as { choices: { finish_reason: string; message: { content: unknown; tool_calls?: { function: unknown }[] } }[] };

        expect(res.status).toBe(200);
        expect(res.headers.get("X-Gateway-Fallback-Reason")).toBe("infra");
        expect(body.choices[0]?.finish_reason).toBe("tool_calls");
        expect(body.choices[0]?.message.content).toBeNull();
        expect(body.choices[0]?.message.tool_calls?.[0]?.function).toEqual({ arguments: '{"city":"Oslo"}', name: "get_weather" });
    });
});

describe("chat fallback: streaming", () => {
    it("sends the fallback's usage chunk just before [DONE] when include_usage is set", async () => {
        state.failNextModel = true;

        const res = await fetchApp(chat({ messages: [{ content: "ping", role: "user" }], stream: true, stream_options: { include_usage: true } }), await env());
        const frames = await framesOf(res);
        const usage = JSON.parse(frames.at(-2) ?? "null") as { choices: unknown[]; usage: { total_tokens: number } } | null;

        expect(res.status).toBe(200);
        expect(res.headers.get("X-Gateway-Fallback-Reason")).toBe("infra");
        expect(frames.at(-1)).toBe("[DONE]");
        expect(usage?.choices).toEqual([]);
        expect(usage?.usage.total_tokens).toBeGreaterThan(0);
    });

    it("streams the fallback's tool call as a delta", async () => {
        state.failNextModel = true;

        const res = await fetchApp(chat({ messages: [toolPrompt], stream: true, tools: TOOLS }), await env());
        const lines = await framesOf(res);
        const frames = lines.filter((frame) => frame !== "[DONE]").map((frame) => JSON.parse(frame) as { choices: { delta: { tool_calls?: unknown[] } }[] });
        const calls = frames.flatMap((frame) => frame.choices[0]?.delta.tool_calls ?? []);

        expect(calls).toEqual([{ function: { arguments: '{"city":"Oslo"}', name: "get_weather" }, id: expect.any(String), index: 0, type: "function" }]);
    });
});
