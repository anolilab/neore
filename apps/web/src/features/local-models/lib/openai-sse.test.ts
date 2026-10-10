import { describe, expect, it } from "vitest";

import { createSseParser, LocalStreamError, parseChatCompletionChunk } from "./openai-sse";

/** A real Ollama 0.12 `/v1/chat/completions` stream, verbatim apart from ids. */
const OLLAMA_STREAM = [
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama3.2:3b","system_fingerprint":"fp_ollama","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama3.2:3b","system_fingerprint":"fp_ollama","choices":[{"index":0,"delta":{"role":"assistant","content":"lo ✓"},"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama3.2:3b","system_fingerprint":"fp_ollama","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop"}]}',
    "",
    "data: [DONE]",
    "",
    "",
].join("\n");

const collect = (chunks: string[]) => {
    const parser = createSseParser();
    const events = chunks.flatMap((chunk) => parser.feed(chunk));

    return [...events, ...parser.flush()];
};

const textOf = (events: ReturnType<typeof collect>) =>
    events
        .filter((event) => event.type === "data")
        .map((event) => parseChatCompletionChunk((event as { data: string }).data).content)
        .join("");

describe(createSseParser, () => {
    it("reads an Ollama stream delivered in one piece", () => {
        expect.assertions(2);

        const events = collect([OLLAMA_STREAM]);

        expect(textOf(events)).toBe("Hello ✓");
        expect(events.at(-1)).toStrictEqual({ type: "done" });
    });

    it("gives the same result whatever the chunk boundaries", () => {
        expect.assertions(3);

        const everyByte = collect([...OLLAMA_STREAM]);
        const sevens = collect(OLLAMA_STREAM.match(/[\s\S]{1,7}/gu) ?? []);

        expect(textOf(everyByte)).toBe("Hello ✓");
        expect(textOf(sevens)).toBe("Hello ✓");
        expect(everyByte).toStrictEqual(collect([OLLAMA_STREAM]));
    });

    it("handles CRLF split between chunks without inventing a blank line", () => {
        expect.assertions(1);

        const events = collect(['data: {"choices":[{"delta":{"content":"a"}}]}\r', '\n\r\ndata: {"choices":[{"delta":{"content":"b"}}]}\r\n\r\n']);

        expect(textOf(events)).toBe("ab");
    });

    it("ignores comments and non-data fields, and joins multi-line data", () => {
        expect.assertions(1);

        const events = collect([": keep-alive\nevent: message\nid: 7\ndata: first\ndata: second\n\n"]);

        expect(events).toStrictEqual([{ data: "first\nsecond", type: "data" }]);
    });

    it("dispatches a final event that has no trailing blank line", () => {
        expect.assertions(1);
        expect(collect(["data: [DONE]"])).toStrictEqual([{ type: "done" }]);
    });
});

describe(parseChatCompletionChunk, () => {
    it("reads reasoning from Ollama's and LM Studio's field names", () => {
        expect.assertions(2);
        expect(parseChatCompletionChunk('{"choices":[{"delta":{"reasoning":"think"}}]}').reasoning).toBe("think");
        expect(parseChatCompletionChunk('{"choices":[{"delta":{"reasoning_content":"ponder"}}]}').reasoning).toBe("ponder");
    });

    it("carries finish reason and usage", () => {
        expect.assertions(1);
        expect(
            parseChatCompletionChunk('{"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":12,"completion_tokens":34}}'),
        ).toStrictEqual({
            content: "",
            finishReason: "length",
            reasoning: "",
            usage: { completionTokens: 34, promptTokens: 12 },
        });
    });

    it("treats unknown or malformed chunks as empty", () => {
        expect.assertions(2);
        expect(parseChatCompletionChunk("not json")).toStrictEqual({ content: "", reasoning: "" });
        expect(parseChatCompletionChunk('{"object":"something.else"}')).toStrictEqual({ content: "", reasoning: "" });
    });

    it("throws on an in-stream error payload", () => {
        expect.assertions(2);
        expect(() => parseChatCompletionChunk('{"error":{"message":"model requires more system memory"}}')).toThrow(LocalStreamError);
        expect(() => parseChatCompletionChunk('{"error":"boom"}')).toThrow("boom");
    });
});
