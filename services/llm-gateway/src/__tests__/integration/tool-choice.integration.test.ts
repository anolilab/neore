/**
 * `tool_choice` on both public routes, checked at the model: the capture wraps the
 * mock model and records the `toolChoice` the AI SDK hands it. The two routes use
 * different wire shapes (chat `{ type, function: { name } }`, Responses
 * `{ type, name }`), so each named form is asserted on what the model receives.
 * `top_p` is checked the same way, on both the streamed and the non-streamed call.
 */
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockEnv, makeVirtualKeyRow } from "../helpers/mock-env.js";
import { useTrackedAppFetch } from "../helpers/tracked-app-fetch.js";

const state = vi.hoisted(() => {
    return { toolChoices: [] as unknown[], topPs: [] as unknown[] };
});

vi.mock("../../providers/factory.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../providers/factory.js")>();

    return {
        ...actual,
        createProviderModelForEnv: vi.fn(async (...args: Parameters<typeof actual.createProviderModelForEnv>) => {
            const model = (await actual.createProviderModelForEnv(...args)) as LanguageModelV3;

            return {
                ...model,
                doGenerate: async (options: LanguageModelV3CallOptions) => {
                    state.toolChoices.push(options.toolChoice);
                    state.topPs.push(options.topP);

                    return model.doGenerate(options);
                },
                doStream: async (options: LanguageModelV3CallOptions) => {
                    state.topPs.push(options.topP);

                    return model.doStream(options);
                },
            };
        }),
    };
});

const TOKEN = "gk_tool_choice_integration_test";
const CHAT_TOOLS = [{ function: { name: "get_weather", parameters: { type: "object" } }, type: "function" }];
const RESPONSES_TOOLS = [{ name: "get_weather", parameters: { type: "object" }, type: "function" }];

const fetchApp = useTrackedAppFetch();

const env = async () => {
    const row = await makeVirtualKeyRow(TOKEN, { tier: "pro" });

    return { ...createMockEnv({ apiKeyCacheRows: [row], nodeEnv: "development" }), MOCK_LLM: "1" } as never;
};

const post = (path: string, body: Record<string, unknown>): Request =>
    new Request(`http://localhost${path}`, {
        body: JSON.stringify({ model: "mock/echo", ...body }),
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        method: "POST",
    });

beforeEach(() => {
    state.toolChoices.length = 0;
    state.topPs.length = 0;
});

describe("tool_choice on /v1/chat/completions", () => {
    it("passes required through as the model's required tool choice", async () => {
        const res = await fetchApp(
            post("/v1/chat/completions", {
                messages: [{ content: 'Weather? [[tool:get_weather {"city":"Oslo"}]]', role: "user" }],
                tool_choice: "required",
                tools: CHAT_TOOLS,
            }),
            await env(),
        );

        expect(res.status).toBe(200);
        expect(state.toolChoices).toEqual([{ type: "required" }]);
    });

    it("maps a named function to the SDK's tool choice", async () => {
        const res = await fetchApp(
            post("/v1/chat/completions", {
                messages: [{ content: 'Weather? [[tool:get_weather {"city":"Oslo"}]]', role: "user" }],
                tool_choice: { function: { name: "get_weather" }, type: "function" },
                tools: CHAT_TOOLS,
            }),
            await env(),
        );

        expect(res.status).toBe(200);
        expect(state.toolChoices).toEqual([{ toolName: "get_weather", type: "tool" }]);
    });

    it("leaves the SDK default when no tool_choice is sent", async () => {
        const res = await fetchApp(post("/v1/chat/completions", { messages: [{ content: "Weather?", role: "user" }], tools: CHAT_TOOLS }), await env());

        expect(res.status).toBe(200);
        expect(state.toolChoices).toEqual([{ type: "auto" }]);
    });
});

describe("top_p on /v1/chat/completions", () => {
    it("passes top_p to the model on a non-streamed call", async () => {
        const res = await fetchApp(post("/v1/chat/completions", { messages: [{ content: "Hi", role: "user" }], top_p: 0.5 }), await env());

        expect(res.status).toBe(200);
        expect(state.topPs).toEqual([0.5]);
    });

    it("passes top_p to the model on a streamed call", async () => {
        const res = await fetchApp(post("/v1/chat/completions", { messages: [{ content: "Hi", role: "user" }], stream: true, top_p: 0.5 }), await env());

        await res.text();

        expect(res.status).toBe(200);
        expect(state.topPs).toEqual([0.5]);
    });
});

describe("tool_choice on /v1/responses", () => {
    it("maps a named function from the Responses shape to the model's tool choice", async () => {
        const res = await fetchApp(
            post("/v1/responses", {
                input: 'Weather? [[tool:get_weather {"city":"Oslo"}]]',
                tool_choice: { name: "get_weather", type: "function" },
                tools: RESPONSES_TOOLS,
            }),
            await env(),
        );

        expect(res.status).toBe(200);
        expect(state.toolChoices).toEqual([{ toolName: "get_weather", type: "tool" }]);
    });

    it("passes required through", async () => {
        const res = await fetchApp(
            post("/v1/responses", { input: 'Weather? [[tool:get_weather {"city":"Oslo"}]]', tool_choice: "required", tools: RESPONSES_TOOLS }),
            await env(),
        );

        expect(res.status).toBe(200);
        expect(state.toolChoices).toEqual([{ type: "required" }]);
    });
});
