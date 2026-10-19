/**
 * POST /v1/chat/completions through the real app with the mock model: a tool
 * round trip is replayed, a non-streaming reply carries its tool calls, and a
 * stream reports usage only when asked. The mock echoes the names of the tool
 * results it was given, so a lost tool name shows up in the reply text.
 */
import { describe, expect, it } from "vitest";

import { createMockEnv, makeVirtualKeyRow } from "../helpers/mock-env.js";
import { useTrackedAppFetch } from "../helpers/tracked-app-fetch.js";

const TOKEN = "gk_tool_calls_integration_test";
const MOCK_CALL_ID = /^mock-call-/;
const TOOLS = [{ function: { name: "get_weather", parameters: { type: "object" } }, type: "function" }];

const fetchApp = useTrackedAppFetch();

const env = async () => {
    const row = await makeVirtualKeyRow(TOKEN, { tier: "pro" });

    return { ...createMockEnv({ apiKeyCacheRows: [row], nodeEnv: "development" }), MOCK_LLM: "1" } as never;
};

const chat = (body: Record<string, unknown>): Request =>
    new Request("http://localhost/v1/chat/completions", {
        body: JSON.stringify({ model: "mock/echo", ...body }),
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        method: "POST",
    });

/** The `data:` payloads of an SSE body, in order, with `[DONE]` kept as the string it is. */
const framesOf = async (res: Response): Promise<string[]> => {
    const text = await res.text();

    return text
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => frame.slice("data: ".length));
};

const CALL = { function: { arguments: '{"city":"Oslo"}', name: "get_weather" }, id: "call_1", type: "function" };

describe("tool round trip through /v1/chat/completions", () => {
    it("replays the assistant's call and names the tool of its result", async () => {
        const res = await fetchApp(
            chat({
                messages: [
                    { content: "Weather in Oslo?", role: "user" },
                    { content: null, role: "assistant", tool_calls: [CALL] },
                    { content: '{"temp":5}', role: "tool", tool_call_id: "call_1" },
                ],
                tools: TOOLS,
            }),
            await env(),
        );

        expect(res.status).toBe(200);

        const body = (await res.json()) as { choices: { message: { content: string } }[] };

        expect(body.choices[0]?.message.content).toBe("Mock: tool get_weather finished. Continuing after the tool result.");
    });
});

describe("non-streaming tool calls", () => {
    it("returns the model's call as message.tool_calls, with content null and finish_reason tool_calls", async () => {
        const res = await fetchApp(chat({ messages: [{ content: 'Weather? [[tool:get_weather {"city":"Oslo"}]]', role: "user" }], tools: TOOLS }), await env());
        const body = (await res.json()) as {
            choices: { finish_reason: string; message: { content: unknown; tool_calls: { function: unknown; id: string; type: string }[] } }[];
        };
        const [choice] = body.choices;

        expect(choice?.finish_reason).toBe("tool_calls");
        expect(choice?.message.content).toBeNull();
        expect(choice?.message.tool_calls).toEqual([
            { function: { arguments: '{"city":"Oslo"}', name: "get_weather" }, id: expect.stringMatching(MOCK_CALL_ID), type: "function" },
        ]);
    });

    it("answers with text and no tool_calls when tool_choice is none", async () => {
        const res = await fetchApp(
            chat({ messages: [{ content: 'Weather? [[tool:get_weather {"city":"Oslo"}]]', role: "user" }], tool_choice: "none", tools: TOOLS }),
            await env(),
        );
        const body = (await res.json()) as { choices: { finish_reason: string; message: { content: string; tool_calls?: unknown } }[] };

        expect(body.choices[0]?.finish_reason).toBe("stop");
        expect(body.choices[0]?.message.tool_calls).toBeUndefined();
        expect(body.choices[0]?.message.content).toContain("Mock reply");
    });
});

describe("streamed usage", () => {
    it("ends the stream with a usage chunk, just before [DONE], when include_usage is set", async () => {
        const res = await fetchApp(chat({ messages: [{ content: "ping", role: "user" }], stream: true, stream_options: { include_usage: true } }), await env());
        const frames = await framesOf(res);
        const usageFrame = frames.at(-2);

        expect(frames.at(-1)).toBe("[DONE]");
        expect(usageFrame).toBeDefined();

        const chunk = JSON.parse(usageFrame!) as { choices: unknown[]; usage: { completion_tokens: number; prompt_tokens: number; total_tokens: number } };

        expect(chunk.choices).toEqual([]);
        expect(chunk.usage.prompt_tokens).toBeGreaterThan(0);
        expect(chunk.usage.completion_tokens).toBeGreaterThan(0);
        expect(chunk.usage.total_tokens).toBe(chunk.usage.prompt_tokens + chunk.usage.completion_tokens);
    });

    it("sends no usage chunk when include_usage is not set", async () => {
        const res = await fetchApp(chat({ messages: [{ content: "ping", role: "user" }], stream: true }), await env());
        const frames = await framesOf(res);

        expect(frames.at(-1)).toBe("[DONE]");
        expect(frames.some((frame) => frame.includes('"usage"'))).toBe(false);
    });

    it("streams a tool call as a whole delta with its index", async () => {
        const res = await fetchApp(
            chat({ messages: [{ content: 'Weather? [[tool:get_weather {"city":"Oslo"}]]', role: "user" }], stream: true, tools: TOOLS }),
            await env(),
        );
        const lines = await framesOf(res);
        const frames = lines.filter((frame) => frame !== "[DONE]").map((frame) => JSON.parse(frame) as { choices: { delta: { tool_calls?: unknown[] } }[] });
        const calls = frames.flatMap((frame) => frame.choices[0]?.delta.tool_calls ?? []);

        expect(calls).toEqual([
            { function: { arguments: '{"city":"Oslo"}', name: "get_weather" }, id: expect.stringMatching(MOCK_CALL_ID), index: 0, type: "function" },
        ]);
    });
});
