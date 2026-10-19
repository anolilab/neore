import { describe, expect, it } from "vitest";

import type { ChatCompletion } from "../routes/v1/responses-map.js";
import {
    chatCompletionToResponse,
    createResponsesStream,
    endOnReadError,
    isResponsesRequestError,
    passthroughHeaders,
    takeSseData,
    translateRequest,
    upstreamError,
} from "../routes/v1/responses-map.js";

const encoder = new TextEncoder();

/** Builds the chat SSE bytes the completions route would send for these chunks. */
const sse = (...frames: unknown[]): string => frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");

const RESPONSE_ID = /^resp_/;
const MESSAGE_ID = /^msg_/;
const FUNCTION_CALL_ID = /^fc_/;

const textChunk = (content: string) => {
    return { choices: [{ delta: { content }, finish_reason: null, index: 0 }] };
};
const finishChunk = (finish_reason: string) => {
    return { choices: [{ delta: {}, finish_reason, index: 0 }] };
};
const callChunk = (id: string, name: string, args: string) => {
    return {
        choices: [{ delta: { tool_calls: [{ function: { arguments: args, name }, id, index: 0, type: "function" }] }, finish_reason: null, index: 0 }],
    };
};

type StreamEvent = { sequence_number: number; type: string };

/** The events in a Responses SSE transcript, without `[DONE]`. */
const eventsOf = (raw: string): StreamEvent[] =>
    raw
        .split("\n\n")
        .filter((frame) => frame.includes("\ndata: ") && !frame.endsWith("[DONE]"))
        .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + 6)) as StreamEvent);

/** Runs SSE text through the real transform in pieces of `size` bytes and returns the parsed events. */
const runStream = async (model: string, text: string, size = text.length): Promise<{ events: StreamEvent[]; raw: string }> => {
    const bytes = encoder.encode(text);
    const chunks: Uint8Array[] = [];

    for (let offset = 0; offset < bytes.length; offset += size) {
        chunks.push(bytes.slice(offset, offset + size));
    }

    const source = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(chunk);
            }

            controller.close();
        },
    });
    const out = await new Response(source.pipeThrough(createResponsesStream(model))).text();

    return { events: eventsOf(out), raw: out };
};

/** The `response` object of the terminal event named `type`, parsed from the transcript. */
const terminalResponseOf = (raw: string, type: string): { incomplete_details: unknown; model: string; output: unknown[] } => {
    const frame = raw.split("\n\n").find((part) => part.startsWith(`event: ${type}`)) ?? "";

    return (JSON.parse(frame.slice(frame.indexOf("data: ") + 6)) as { response: { incomplete_details: unknown; model: string; output: unknown[] } }).response;
};

const typesOf = (events: { type: string }[]): string[] => events.map((event) => event.type);

describe("translateRequest — input", () => {
    it("maps a string input to one user message and defaults stream to false", () => {
        const body = translateRequest({ input: "hello", model: "gpt-x" });

        expect(body).toEqual({ messages: [{ content: "hello", role: "user" }], model: "gpt-x", stream: false });
    });

    it("prepends instructions as the leading system message", () => {
        const body = translateRequest({ input: "hi", instructions: "Be brief.", model: "m" });

        expect(body.messages).toEqual([
            { content: "Be brief.", role: "system" },
            { content: "hi", role: "user" },
        ]);
    });

    it("maps message items, joins text parts and folds developer into system", () => {
        const body = translateRequest({
            input: [
                { content: "rules", role: "developer" },
                {
                    content: [
                        { text: "part a", type: "input_text" },
                        { text: "part b", type: "input_text" },
                    ],
                    role: "user",
                    type: "message",
                },
                { content: [{ text: "earlier answer", type: "output_text" }], role: "assistant" },
            ],
            model: "m",
        });

        expect(body.messages).toEqual([
            { content: "rules", role: "system" },
            { content: "part a\npart b", role: "user" },
            { content: "earlier answer", role: "assistant" },
        ]);
    });

    it("drops reasoning items from earlier turns", () => {
        const body = translateRequest({
            input: [
                { encrypted_content: "x", id: "rs_1", summary: [], type: "reasoning" },
                { content: "q", role: "user" },
            ],
            model: "m",
        });

        expect(body.messages).toEqual([{ content: "q", role: "user" }]);
    });

    it("maps request limits and sampling onto the chat names", () => {
        const body = translateRequest({ input: "x", max_output_tokens: 64, model: "m", stream: true, temperature: 0.2, top_p: 0.9 });

        expect(body).toMatchObject({ max_tokens: 64, stream: true, temperature: 0.2, top_p: 0.9 });
        expect(body).not.toHaveProperty("max_output_tokens");
    });

    it("drops user quietly: it is advisory and completions would strip it anyway", () => {
        const body = translateRequest({ input: "x", model: "m", user: "u1" });

        expect(body).not.toHaveProperty("user");
    });
});

describe("translateRequest — tool round trip", () => {
    it("maps function tools and a full call-and-result history", () => {
        const body = translateRequest({
            input: [
                { content: "weather?", role: "user" },
                { arguments: '{"city":"Oslo"}', call_id: "call_1", name: "get_weather", type: "function_call" },
                { call_id: "call_1", output: "12C", type: "function_call_output" },
            ],
            model: "m",
            tools: [{ description: "Look up weather", name: "get_weather", parameters: { type: "object" }, strict: true, type: "function" }],
        });

        expect(body.tools).toEqual([{ function: { description: "Look up weather", name: "get_weather", parameters: { type: "object" } }, type: "function" }]);
        expect(body.messages).toEqual([
            { content: "weather?", role: "user" },
            {
                content: "",
                role: "assistant",
                tool_calls: [{ function: { arguments: '{"city":"Oslo"}', name: "get_weather" }, id: "call_1", type: "function" }],
            },
            { content: "12C", role: "tool", tool_call_id: "call_1" },
        ]);
    });

    it("merges consecutive function calls into one assistant message", () => {
        const body = translateRequest({
            input: [
                { arguments: "{}", call_id: "a", name: "f", type: "function_call" },
                { arguments: "{}", call_id: "b", name: "g", type: "function_call" },
            ],
            model: "m",
        });

        expect(body.messages).toHaveLength(1);
        expect(body.messages[0]).toMatchObject({ role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] });
    });

    it("maps a json_schema text format to response_format with the raw schema", () => {
        const schema = { properties: { ok: { type: "boolean" } }, type: "object" };
        const body = translateRequest({ input: "x", model: "m", text: { format: { name: "answer", schema, type: "json_schema" } } });

        expect(body.response_format).toEqual({ json_schema: schema, type: "json_schema" });
    });
});

describe("translateRequest — refused fields", () => {
    const refusal = (raw: unknown): { message: string; param: string | null } => {
        try {
            translateRequest(raw);
        } catch (error) {
            if (isResponsesRequestError(error)) {
                return error;
            }

            throw error;
        }

        throw new Error("expected a refusal");
    };

    it("refuses previous_response_id and names it", () => {
        const error = refusal({ input: "x", model: "m", previous_response_id: "resp_1" });

        expect(error.param).toBe("previous_response_id");
        expect(error.message).toContain("previous_response_id");
    });

    it("treats a null previous_response_id as absent", () => {
        expect(() => translateRequest({ input: "x", model: "m", previous_response_id: null })).not.toThrow();
    });

    it("refuses a hosted tool and names tools[i].type", () => {
        const error = refusal({ input: "x", model: "m", tools: [{ name: "f", type: "function" }, { type: "web_search" }] });

        expect(error.param).toBe("tools[1].type");
        expect(error.message).toContain("web_search");
    });

    it("refuses background mode", () => {
        expect(refusal({ background: true, input: "x", model: "m" }).param).toBe("background");
    });

    it("refuses non-text content parts and names the part", () => {
        const error = refusal({
            input: [
                {
                    content: [
                        { text: "hi", type: "input_text" },
                        { image_url: "https://x", type: "input_image" },
                    ],
                    role: "user",
                },
            ],
            model: "m",
        });

        expect(error.param).toBe("input[0].content[1].type");
    });

    it("refuses an unknown input item type and names input[i].type", () => {
        const error = refusal({ input: [{ id: "ws_1", status: "completed", type: "web_search_call" }], model: "m" });

        expect(error.param).toBe("input[0].type");
    });

    it("names the field of a malformed request", () => {
        expect(refusal({ input: "x" }).param).toBe("model");
    });

    it("refuses a hosted tool_choice and names it", () => {
        expect(refusal({ input: "x", model: "m", tool_choice: { type: "file_search" } }).param).toBe("tool_choice");
        expect(refusal({ input: "x", model: "m", tool_choice: "sometimes" }).param).toBe("tool_choice");
    });

    it("maps tool_choice onto the chat names, and an absent or null one to nothing", () => {
        expect(translateRequest({ input: "x", model: "m", tool_choice: "required" }).tool_choice).toBe("required");
        expect(translateRequest({ input: "x", model: "m", tool_choice: { name: "f", type: "function" } }).tool_choice).toEqual({
            function: { name: "f" },
            type: "function",
        });
        expect(translateRequest({ input: "x", model: "m", tool_choice: null })).not.toHaveProperty("tool_choice");
    });

    it("allows text.format with tools both streaming and not; the chat route validates the non-streaming one", () => {
        const raw = { input: "x", model: "m", text: { format: { schema: { type: "object" }, type: "json_schema" } }, tools: [{ name: "f", type: "function" }] };

        expect(translateRequest(raw).response_format).toEqual({ json_schema: { type: "object" }, type: "json_schema" });
        expect(translateRequest({ ...raw, stream: true }).response_format).toEqual({ json_schema: { type: "object" }, type: "json_schema" });
    });

    it("asks a stream for its usage chunk, and a non-streaming request for nothing extra", () => {
        expect(translateRequest({ input: "x", model: "m", stream: true }).stream_options).toEqual({ include_usage: true });
        expect(translateRequest({ input: "x", model: "m" })).not.toHaveProperty("stream_options");
    });
});

describe("chatCompletionToResponse — finish reasons and output", () => {
    const completion = (finish_reason: string, message: ChatCompletion["choices"][number]["message"]): ChatCompletion => {
        return {
            choices: [{ finish_reason, message }],
            created: 1_700_000_000,
            model: "m",
            usage: { completion_tokens: 5, prompt_tokens: 7, total_tokens: 12 },
        };
    };

    it("maps stop to completed with the message item and usage", () => {
        const response = chatCompletionToResponse(completion("stop", { content: "Hi." }));

        expect(response).toMatchObject({
            created_at: 1_700_000_000,
            error: null,
            incomplete_details: null,
            model: "m",
            object: "response",
            status: "completed",
            usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
        });
        expect(response.id).toMatch(RESPONSE_ID);
        expect(response.output).toEqual([
            {
                content: [{ annotations: [], text: "Hi.", type: "output_text" }],
                id: expect.stringMatching(MESSAGE_ID),
                role: "assistant",
                status: "completed",
                type: "message",
            },
        ]);
    });

    it("maps length to incomplete with max_output_tokens", () => {
        const response = chatCompletionToResponse(completion("length", { content: "cut" }));

        expect(response.status).toBe("incomplete");
        expect(response.incomplete_details).toEqual({ reason: "max_output_tokens" });
    });

    it("maps content_filter to incomplete with content_filter", () => {
        const response = chatCompletionToResponse(completion("content_filter", { content: "" }));

        expect(response.status).toBe("incomplete");
        expect(response.incomplete_details).toEqual({ reason: "content_filter" });
    });

    it("emits function_call items and no empty message when the reply is only tool calls", () => {
        const response = chatCompletionToResponse(
            completion("tool_calls", {
                content: null,
                tool_calls: [{ function: { arguments: '{"a":1}', name: "f" }, id: "call_9", type: "function" }],
            }),
        );

        expect(response.status).toBe("completed");
        expect(response.output).toEqual([
            { arguments: '{"a":1}', call_id: "call_9", id: expect.stringMatching(FUNCTION_CALL_ID), name: "f", status: "completed", type: "function_call" },
        ]);
    });

    it("derives the response id from the completion id, so a replayed reply keeps it", () => {
        const withId: ChatCompletion = { ...completion("stop", { content: "x" }), id: "chatcmpl-abc" };

        expect(chatCompletionToResponse(withId).id).toBe("resp_abc");
        expect(chatCompletionToResponse(withId).id).toBe(chatCompletionToResponse({ ...withId }).id);
    });

    it("derives output item ids from the completion id and their place, so a replayed reply keeps them", () => {
        const withCalls: ChatCompletion = {
            ...completion("tool_calls", { content: "Checking.", tool_calls: [{ function: { arguments: "{}", name: "f" }, id: "call_1", type: "function" }] }),
            id: "chatcmpl-abc",
        };
        const first = chatCompletionToResponse(withCalls).output.map((item) => item.id);

        expect(first).toEqual(["msg_abc_0", "fc_abc_1"]);
        expect(chatCompletionToResponse({ ...withCalls }).output.map((item) => item.id)).toEqual(first);
    });

    it("falls back to a random response id when the completion has none", () => {
        const first = chatCompletionToResponse(completion("stop", { content: "x" })).id;
        const second = chatCompletionToResponse(completion("stop", { content: "x" })).id;

        expect(first).toMatch(RESPONSE_ID);
        expect(second).toMatch(RESPONSE_ID);
        expect(first).not.toBe(second);
    });

    it("keeps usage null when the reply carried none", () => {
        const bare: ChatCompletion = { ...completion("stop", { content: "x" }), usage: undefined };

        expect(chatCompletionToResponse(bare).usage).toBeNull();
    });
});

describe("createResponsesStream — event order", () => {
    it("reports the usage chunk the chat stream sends last on response.completed", async () => {
        const usage = { completion_tokens: 3, prompt_tokens: 7, total_tokens: 10 };
        const { raw } = await runStream("m", sse(textChunk("Hi"), finishChunk("stop"), { choices: [], usage }));
        const frame = raw.split("\n\n").find((part) => part.startsWith("event: response.completed")) ?? "";
        const response = JSON.parse(frame.slice(frame.indexOf("data: ") + 6)).response as { usage: unknown };

        expect(response.usage).toEqual({ input_tokens: 7, output_tokens: 3, total_tokens: 10 });
    });

    it("emits created, the text item lifecycle, completed, then [DONE]", async () => {
        const text = sse(textChunk("Hel"), textChunk("lo"), finishChunk("stop"));
        const { events, raw } = await runStream("m", text);

        expect(typesOf(events)).toEqual([
            "response.created",
            "response.output_item.added",
            "response.content_part.added",
            "response.output_text.delta",
            "response.output_text.delta",
            "response.output_text.done",
            "response.content_part.done",
            "response.output_item.done",
            "response.completed",
        ]);
        expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
        expect(raw.endsWith("data: [DONE]\n\n")).toBe(true);
        expect(raw.startsWith("event: response.created\ndata: ")).toBe(true);
    });

    it("reports the completed text and an incomplete status on length", async () => {
        const { raw } = await runStream("m", sse(textChunk("cut"), finishChunk("length")));
        const frame = raw.split("\n\n").find((part) => part.startsWith("event: response.incomplete")) ?? "";
        const payload = JSON.parse(frame.slice(frame.indexOf("data: ") + 6)) as {
            response: { incomplete_details: unknown; output: { content: { text: string }[] }[] };
        };

        expect(payload.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
        expect(payload.response.output[0].content[0].text).toBe("cut");
    });

    it("emits the function call lifecycle for a tool-call stream, one item per call id", async () => {
        const text = sse(callChunk("call_1", "get_weather", '{"city":"Oslo"}'), callChunk("call_2", "get_time", '{"tz":"CET"}'), finishChunk("tool_calls"));
        const { events, raw } = await runStream("m", text);

        expect(typesOf(events)).toEqual([
            "response.created",
            "response.output_item.added",
            "response.function_call_arguments.delta",
            "response.function_call_arguments.done",
            "response.output_item.done",
            "response.output_item.added",
            "response.function_call_arguments.delta",
            "response.function_call_arguments.done",
            "response.output_item.done",
            "response.completed",
        ]);

        const added = events.filter((event) => event.type === "response.output_item.added") as unknown as {
            item: { call_id: string; name: string };
            output_index: number;
        }[];

        expect(added.map((event) => [event.item.call_id, event.item.name, event.output_index])).toEqual([
            ["call_1", "get_weather", 0],
            ["call_2", "get_time", 1],
        ]);
        expect(raw).toContain(String.raw`"arguments":"{\"city\":\"Oslo\"}"`);
    });

    it("emits response.failed and stays failed when a later stop arrives", async () => {
        const text = sse(
            textChunk("par"),
            { error: { message: "provider down" } },
            { choices: [{ delta: {}, finish_reason: "error", index: 0 }] },
            finishChunk("stop"),
        );
        const { events } = await runStream("m", text);
        const types = typesOf(events);

        expect(types).not.toContain("response.completed");
        expect(types.at(-1)).toBe("response.failed");
    });

    it("parses a frame split across two chunks the same as a whole one", async () => {
        const text = sse(textChunk("split me"), finishChunk("stop"));
        const whole = await runStream("m", text);
        const pieces = await runStream("m", text, 7);

        expect(typesOf(pieces.events)).toEqual(typesOf(whole.events));
        expect(pieces.events.at(-1)?.type).toBe("response.completed");
    });

    it("fails the response when a frame cannot be read, instead of completing around the hole", async () => {
        const text = `${sse(textChunk("before"))}data: {"choices":[{"delta":{"content":"lost"\n\n${sse(finishChunk("stop"))}`;
        const { events } = await runStream("m", text);
        const types = events.map((event) => event.type);

        expect(types).not.toContain("response.completed");
        expect(types.at(-1)).toBe("response.failed");
    });

    it("handles a final frame that lacks its blank line", async () => {
        const text = `${sse(textChunk("tail"))}data: ${JSON.stringify(finishChunk("stop"))}`;
        const { events } = await runStream("m", text);

        expect(events.at(-1)?.type).toBe("response.completed");
    });

    it("reports the model the chat stream routed to, and the requested one when no chunk names it", async () => {
        const routed = await runStream("auto", sse({ ...textChunk("Hi"), model: "gpt-routed" }, { ...finishChunk("stop"), model: "gpt-routed" }));
        const unnamed = await runStream("auto", sse(textChunk("Hi"), finishChunk("stop")));

        expect(terminalResponseOf(routed.raw, "response.completed").model).toBe("gpt-routed");
        expect(terminalResponseOf(unnamed.raw, "response.completed").model).toBe("auto");
    });

    it("ends as incomplete with stream_ended when the upstream stops without a finish_reason", async () => {
        const { events, raw } = await runStream("m", sse(textChunk("cut off")));

        expect(typesOf(events).at(-1)).toBe("response.incomplete");
        expect(terminalResponseOf(raw, "response.incomplete")).toMatchObject({
            incomplete_details: { reason: "stream_ended" },
            output: [{ content: [{ text: "cut off" }] }],
        });
    });

    it("ends as response.failed when the upstream body errors mid-stream, even mid-frame", async () => {
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.error(new Error("socket reset"));
            },
            start(controller) {
                controller.enqueue(encoder.encode(`${sse(textChunk("par"))}data: {"choices":[{"del`));
            },
        });
        const raw = await new Response(endOnReadError(body).pipeThrough(createResponsesStream("m"))).text();
        const types = typesOf(eventsOf(raw));

        expect(types).not.toContain("response.completed");
        expect(types.at(-1)).toBe("response.failed");
        expect(raw.endsWith("data: [DONE]\n\n")).toBe(true);
    });
});

describe("takeSseData", () => {
    it("returns complete payloads and keeps the unfinished tail", () => {
        expect(takeSseData('data: {"a":1}\n\ndata: {"b"')).toEqual({ data: ['{"a":1}'], rest: 'data: {"b"' });
    });

    it("joins multi-line data fields", () => {
        expect(takeSseData("data: one\ndata: two\n\n")).toEqual({ data: ["one\ntwo"], rest: "" });
    });
});

describe("upstreamError", () => {
    it("keeps the completions error message and code, with a server type for 5xx", () => {
        expect(upstreamError(502, JSON.stringify({ error: { code: "PROVIDER_ERROR", message: "boom", type: "server_error" } }))).toEqual({
            error: { code: "PROVIDER_ERROR", message: "boom", param: null, type: "server_error" },
        });
    });

    it("replaces a non-JSON body with a generic message", () => {
        expect(upstreamError(500, "<html>stack trace</html>").error).toEqual({
            code: null,
            message: "Upstream request failed with status 500.",
            param: null,
            type: "server_error",
        });
    });
});

describe("passthroughHeaders", () => {
    it("keeps gateway diagnostics and retry hints only", () => {
        const headers = new Headers({
            "Access-Control-Allow-Origin": "https://app.example",
            "Content-Type": "application/json",
            "Retry-After": "30",
            "X-Gateway-Fallback-Model": "m2",
            "X-Request-Id": "r1",
        });

        expect(passthroughHeaders(headers)).toEqual({ "retry-after": "30", "x-gateway-fallback-model": "m2", "x-request-id": "r1" });
    });
});
