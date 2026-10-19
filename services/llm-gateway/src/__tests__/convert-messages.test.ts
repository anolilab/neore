/**
 * What the model actually receives for a chat request with a tool round trip.
 * The capture wraps the mock model, so the assertions are on the provider prompt
 * the AI SDK built, not on the gateway's intermediate messages.
 */
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";

import { createMockLanguageModel } from "../providers/mock-model.js";
import { convertMessages } from "../routes/v1/completions.js";

const CALL = { function: { arguments: '{"city":"Oslo"}', name: "get_weather" }, id: "call_1", type: "function" as const };

/** Runs the messages through the AI SDK against the mock, and returns the prompt the model was called with. */
const promptFor = async (messages: Parameters<typeof convertMessages>[0]): Promise<LanguageModelV3CallOptions["prompt"]> => {
    const base = createMockLanguageModel();
    const seen: LanguageModelV3CallOptions[] = [];
    const model = {
        ...base,
        doGenerate: async (options: LanguageModelV3CallOptions) => {
            seen.push(options);

            return base.doGenerate(options);
        },
    };

    await generateText({ messages: convertMessages(messages), model });

    return seen[0]!.prompt;
};

describe("convertMessages — tool round trip", () => {
    it("gives the model the assistant's call and the name and output of its result", async () => {
        const prompt = await promptFor([
            { content: "Weather in Oslo?", role: "user" },
            { content: null, role: "assistant", tool_calls: [CALL] },
            { content: '{"temp":5}', role: "tool", tool_call_id: "call_1" },
        ]);

        expect(prompt).toContainEqual(
            expect.objectContaining({
                content: [expect.objectContaining({ input: { city: "Oslo" }, toolCallId: "call_1", toolName: "get_weather", type: "tool-call" })],
                role: "assistant",
            }),
        );
        expect(prompt).toContainEqual(
            expect.objectContaining({
                content: [
                    expect.objectContaining({
                        output: { type: "text", value: '{"temp":5}' },
                        toolCallId: "call_1",
                        toolName: "get_weather",
                        type: "tool-result",
                    }),
                ],
                role: "tool",
            }),
        );
    });

    it("gives the model the text of a tool result sent as parts, not their JSON", () => {
        const [, tool] = convertMessages([
            { content: null, role: "assistant", tool_calls: [CALL] },
            { content: [{ text: '{"temp":5}', type: "text" }], role: "tool", tool_call_id: "call_1" },
        ]);

        expect(tool).toMatchObject({ content: [{ output: { type: "text", value: '{"temp":5}' } }] });
    });

    it("joins several text parts and keeps JSON only for parts that carry no text", () => {
        const [first, second] = convertMessages([
            {
                content: [
                    { text: "a", type: "text" },
                    { text: "b", type: "text" },
                ],
                role: "tool",
                tool_call_id: "x",
            },
            { content: [{ image_url: { url: "https://example.com/a.png" }, type: "image_url" }], role: "tool", tool_call_id: "y" },
        ]);

        expect(first).toMatchObject({ content: [{ output: { value: "ab" } }] });
        expect(second).toMatchObject({ content: [{ output: { value: '[{"image_url":{"url":"https://example.com/a.png"},"type":"image_url"}]' } }] });
    });

    it("keeps an assistant's text beside its calls, as a text part before them", () => {
        const [assistant] = convertMessages([{ content: "Checking.", role: "assistant", tool_calls: [CALL] }]);

        expect(assistant).toEqual({
            content: [
                { text: "Checking.", type: "text" },
                { input: { city: "Oslo" }, toolCallId: "call_1", toolName: "get_weather", type: "tool-call" },
            ],
            role: "assistant",
        });
    });

    it("passes arguments that are not JSON through as the string they were", () => {
        const [assistant] = convertMessages([{ content: null, role: "assistant", tool_calls: [{ ...CALL, function: { arguments: "{oops", name: "f" } }] }]);

        expect(assistant).toMatchObject({ content: [{ input: "{oops", type: "tool-call" }] });
    });

    it("takes a result's name from the call with its id, and falls back to the message name", () => {
        const converted = convertMessages([
            { content: null, role: "assistant", tool_calls: [CALL] },
            { content: "{}", role: "tool", tool_call_id: "call_1" },
            { content: "{}", role: "tool", tool_call_id: "call_1" },
            { content: "{}", name: "lookup", role: "tool", tool_call_id: "unknown" },
        ]);
        const [named, unnamed] = converted.slice(2);

        expect(named).toMatchObject({ content: [{ toolName: "get_weather" }] });
        expect(unnamed).toMatchObject({ content: [{ toolName: "lookup" }] });
    });

    it("names each result from the call before it when two turns reuse one call id", () => {
        const converted = convertMessages([
            { content: null, role: "assistant", tool_calls: [{ ...CALL, function: { arguments: "{}", name: "get_weather" } }] },
            { content: "{}", role: "tool", tool_call_id: "call_1" },
            { content: "Now the time?", role: "user" },
            { content: null, role: "assistant", tool_calls: [{ ...CALL, function: { arguments: "{}", name: "get_time" } }] },
            { content: "{}", role: "tool", tool_call_id: "call_1" },
        ]);

        expect(converted[1]).toMatchObject({ content: [{ toolName: "get_weather" }] });
        expect(converted[4]).toMatchObject({ content: [{ toolName: "get_time" }] });
    });

    it("treats a null content on a plain assistant message as empty text", () => {
        expect(convertMessages([{ content: null, role: "assistant" }])).toEqual([{ content: "", role: "assistant" }]);
    });
});
