import { describe, expect, it, vi } from "vitest";

import { extractJsonFromFile, parseExportFile } from "./index";

vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray, ...values: unknown[]) => {
            const text = String.raw({ raw: strings }, ...values);

            return { id: text, message: text };
        },
    };
});

const claudeCodeSession = [
    { sessionId: "s1", type: "last-prompt" },
    { summary: "Fixing the build", type: "summary" },
    { isSidechain: false, message: { content: "Fix the build", role: "user" }, sessionId: "s1", timestamp: "2026-10-01T10:00:00.000Z", type: "user" },
    {
        message: {
            content: [
                { thinking: "hm", type: "thinking" },
                { text: "Looking.", type: "text" },
                { id: "t1", input: {}, name: "Bash", type: "tool_use" },
            ],
            role: "assistant",
        },
        sessionId: "s1",
        timestamp: "2026-10-01T10:00:01.000Z",
        type: "assistant",
    },
    { message: { content: [{ content: "ok", tool_use_id: "t1", type: "tool_result" }], role: "user" }, sessionId: "s1", type: "user" },
    { message: { content: [{ text: "Done.", type: "text" }], role: "assistant" }, sessionId: "s1", timestamp: "2026-10-01T10:00:02.000Z", type: "assistant" },
    { isSidechain: true, message: { content: "sub-agent chatter", role: "user" }, sessionId: "s1", type: "user" },
    { isMeta: true, message: { content: "meta", role: "user" }, sessionId: "s1", type: "user" },
    { message: { content: "<command-name>/clear</command-name>", role: "user" }, sessionId: "s1", type: "user" },
];

const codexRollout = [
    { payload: { id: "c1", timestamp: "2026-10-01T10:00:00.000Z" }, timestamp: "2026-10-01T10:00:00.000Z", type: "session_meta" },
    {
        payload: { content: [{ text: "<environment_context>cwd</environment_context>", type: "input_text" }], role: "user", type: "message" },
        type: "response_item",
    },
    {
        payload: { content: [{ text: "List files", type: "input_text" }], role: "user", type: "message" },
        timestamp: "2026-10-01T10:00:01.000Z",
        type: "response_item",
    },
    { payload: { arguments: "{}", call_id: "k1", name: "shell", type: "function_call" }, type: "response_item" },
    { payload: { call_id: "k1", output: "a b", type: "function_call_output" }, type: "response_item" },
    {
        payload: { content: [{ text: "Two files.", type: "output_text" }], role: "assistant", type: "message" },
        timestamp: "2026-10-01T10:00:02.000Z",
        type: "response_item",
    },
    { payload: { message: "List files", type: "user_message" }, type: "event_msg" },
];

describe("Claude Code parser", () => {
    it("keeps the turns after a compaction boundary, which has an empty parentUuid", () => {
        const base = { isSidechain: false, sessionId: "s1", timestamp: "2026-10-01T10:00:00Z" };
        const events = [
            { ...base, message: { content: "first question", role: "user" }, parentUuid: null, type: "user", uuid: "u1" },
            { ...base, message: { content: "first answer", role: "assistant" }, parentUuid: "u1", type: "assistant", uuid: "a1" },
            { ...base, logicalParentUuid: "a1", parentUuid: "", subtype: "compact_boundary", type: "system", uuid: "b1" },
            { ...base, message: { content: "after compaction", role: "user" }, parentUuid: "b1", type: "user", uuid: "u2" },
            { ...base, message: { content: "answer after", role: "assistant" }, parentUuid: "u2", type: "assistant", uuid: "a2" },
        ];

        const [conversation] = parseExportFile(events, "claude-code").conversations;

        expect(conversation?.messages.map((message) => message.content)).toEqual(["first question", "first answer", "after compaction", "answer after"]);
    });

    it("is detected and round-trips a session", () => {
        const result = parseExportFile(claudeCodeSession);

        expect(result.provider).toBe("claude-code");
        expect(result.conversations).toHaveLength(1);

        const [conversation] = result.conversations;

        expect(conversation?.title).toBe("Fixing the build");
        expect(conversation?.createdAt).toBe(Date.parse("2026-10-01T10:00:00.000Z"));
        expect(conversation?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(conversation?.messages[0]?.content).toBe("Fix the build");
        expect(conversation?.messages[1]?.content).toContain("Looking.\n\nDone.");
        expect(conversation?.messages[1]?.content).toContain("3 tool calls, results and reasoning blocks were not included");
        expect(JSON.stringify(conversation)).not.toContain("sub-agent chatter");
    });

    it("titles from the first prompt without a summary", () => {
        const result = parseExportFile(claudeCodeSession.filter((record) => record.type !== "summary"));

        expect(result.conversations[0]?.title).toBe("Fix the build");
    });
});

describe("Codex parser", () => {
    it("is detected and round-trips a rollout", () => {
        const result = parseExportFile(codexRollout);

        expect(result.provider).toBe("codex");

        const [conversation] = result.conversations;

        expect(conversation?.title).toBe("List files");
        expect(conversation?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(conversation?.messages[0]?.content).toBe("List files");
        expect(conversation?.messages[1]?.content).toContain("Two files.");
        expect(conversation?.messages[1]?.content).toContain("2 tool calls, results and reasoning blocks were not included");
    });
});

describe("detection does not steal existing formats", () => {
    it("keeps ChatGPT, Claude and Gemini exports", () => {
        expect(parseExportFile([{ mapping: {}, title: "x" }]).provider).toBe("chatgpt");
        expect(parseExportFile([{ chat_messages: [], name: "x" }]).provider).toBe("claude");
        expect(parseExportFile([{ messages: [{ content: "hi", role: "USER" }], title: "x" }]).provider).toBe("gemini");
    });

    it("rejects unrelated records", () => {
        expect(() => parseExportFile([{ type: "user" }, { foo: 1 }])).toThrow();
    });
});

describe("extractJsonFromFile", () => {
    it("stops on a damaged line in the middle of a transcript, naming it", async () => {
        const text = `${JSON.stringify(codexRollout[0])}\nnot json\n${JSON.stringify(codexRollout[2])}\n`;

        await expect(extractJsonFromFile(new File([text], "rollout.jsonl"))).rejects.toThrow("Line 2");
    });

    it("stops on a truncated final line too, rather than dropping it", async () => {
        const text = `${JSON.stringify(codexRollout[0])}\n{"partial`;

        await expect(extractJsonFromFile(new File([text], "rollout.jsonl"))).rejects.toThrow("Line 2");
    });
});

describe("Codex rollouts mixing both turn formats", () => {
    it("keeps a legacy user prompt when the assistant turns are response items", () => {
        const rollout = [
            { payload: { message: "Summarise the logs", type: "user_message" }, timestamp: "2026-10-01T10:00:00Z", type: "event_msg" },
            {
                payload: { content: [{ text: "Here is the summary.", type: "output_text" }], role: "assistant", type: "message" },
                timestamp: "2026-10-01T10:00:05Z",
                type: "response_item",
            },
        ];

        const [conversation] = parseExportFile(rollout, "codex").conversations;

        expect(conversation?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(conversation?.messages[0]?.content).toBe("Summarise the logs");
    });
});

describe("Codex prompts beside unrelated response items", () => {
    it("keeps a legacy prompt that has no response-item copy", () => {
        const rollout = [
            { payload: { message: "Only as a legacy event", type: "user_message" }, timestamp: "2026-10-01T10:00:00Z", type: "event_msg" },
            { payload: { content: [{ text: "A different prompt", type: "input_text" }], role: "user", type: "message" }, type: "response_item" },
        ];

        const [conversation] = parseExportFile(rollout, "codex").conversations;

        // Both are user turns in a row, so the importer merges them into one message.
        expect(conversation?.messages[0]?.content).toContain("Only as a legacy event");
        expect(conversation?.messages[0]?.content).toContain("A different prompt");
    });
});

describe("Codex user messages with injected context", () => {
    it("keeps the prompt that follows an environment block", () => {
        const rollout = [
            {
                payload: {
                    content: [
                        { text: "<environment_context>\n  <cwd>/work</cwd>\n</environment_context>", type: "input_text" },
                        { text: "Refactor the parser", type: "input_text" },
                    ],
                    role: "user",
                    type: "message",
                },
                type: "response_item",
            },
            {
                payload: { content: [{ text: "Done.", type: "output_text" }], role: "assistant", type: "message" },
                type: "response_item",
            },
        ];

        const [conversation] = parseExportFile(rollout, "codex").conversations;

        expect(conversation?.messages[0]?.content).toBe("Refactor the parser");
    });
});

describe("merged transcript records", () => {
    it("keeps the latest record's time for a message merged from several records", () => {
        const events = [
            { message: { content: "first", role: "user" }, sessionId: "s", timestamp: "2026-10-01T10:00:00Z", type: "user", uuid: "a" },
            { message: { content: "second", role: "user" }, sessionId: "s", timestamp: "2026-10-05T10:00:00Z", type: "user", uuid: "b", parentUuid: "a" },
        ];

        const [conversation] = parseExportFile(events, "claude-code").conversations;

        expect(conversation?.messages).toHaveLength(1);
        expect(conversation?.messages[0]?.createdAt).toBe(Date.parse("2026-10-05T10:00:00Z"));
    });
});

describe("Codex legacy prompts with a later copy", () => {
    it("keeps an earlier legacy prompt whose text is repeated later as a response item", () => {
        const rollout = [
            { payload: { message: "Run the tests", type: "user_message" }, timestamp: "2026-10-01T10:00:00Z", type: "event_msg" },
            { payload: { content: [{ text: "Run the tests", type: "input_text" }], role: "user", type: "message" }, type: "response_item" },
            { payload: { content: [{ text: "Done.", type: "output_text" }], role: "assistant", type: "message" }, type: "response_item" },
        ];

        const [conversation] = parseExportFile(rollout, "codex").conversations;

        // The legacy event and the response item are one prompt: the copy is skipped, the prompt kept once.
        expect(conversation?.messages[0]?.content).toContain("Run the tests");
        expect(conversation?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    });
});

describe("Codex legacy copies keep their timestamps and turn order", () => {
    it("gives the kept prompt its legacy time, and leaves the turns in their order", () => {
        const rollout = [
            { payload: { message: "First", type: "user_message" }, timestamp: "2026-10-01T10:00:00Z", type: "event_msg" },
            { payload: { content: [{ text: "First", type: "input_text" }], role: "user", type: "message" }, type: "response_item" },
            { payload: { content: [{ text: "Reply one.", type: "output_text" }], role: "assistant", type: "message" }, type: "response_item" },
            { payload: { message: "Second", type: "user_message" }, timestamp: "2026-10-01T10:05:00Z", type: "event_msg" },
            { payload: { content: [{ text: "Second", type: "input_text" }], role: "user", type: "message" }, type: "response_item" },
        ];

        const [conversation] = parseExportFile(rollout, "codex").conversations;

        expect(conversation?.messages.map((message) => message.content)).toEqual(["First", "Reply one.", "Second"]);
        expect(conversation?.messages[0]?.createdAt).toBe(Date.parse("2026-10-01T10:00:00Z"));
        expect(conversation?.messages[2]?.createdAt).toBe(Date.parse("2026-10-01T10:05:00Z"));
    });
});

describe("injected blocks match only when they are complete", () => {
    it("keeps a prompt that starts with an injected marker but is not wrapped in it", () => {
        const rollout = [
            {
                payload: {
                    content: [{ text: "<environment_context> is what the CLI writes; why does my import drop it?", type: "input_text" }],
                    role: "user",
                    type: "message",
                },
                type: "response_item",
            },
            {
                payload: { content: [{ text: "Because the block was unclosed.", type: "output_text" }], role: "assistant", type: "message" },
                type: "response_item",
            },
        ];

        const [conversation] = parseExportFile(rollout, "codex").conversations;

        expect(conversation?.messages[0]?.content).toContain("why does my import drop it?");
    });
});

describe("Claude Code slash-command echoes", () => {
    it("drops a command echo made of message, name and args tags, and keeps the prompt", () => {
        const records = [
            {
                isSidechain: false,
                message: {
                    content: [
                        {
                            text: "<command-message>review is running</command-message>\n<command-name>/review</command-name>\n<command-args>main</command-args>",
                            type: "text",
                        },
                    ],
                    role: "user",
                },
                sessionId: "s1",
                timestamp: "2026-10-01T10:00:00.000Z",
                type: "user",
            },
            {
                isSidechain: false,
                message: { content: "Fix the build", role: "user" },
                sessionId: "s1",
                timestamp: "2026-10-01T10:00:01.000Z",
                type: "user",
            },
            {
                isSidechain: false,
                message: { content: [{ text: "Reviewed.", type: "text" }], role: "assistant" },
                sessionId: "s1",
                timestamp: "2026-10-01T10:00:02.000Z",
                type: "assistant",
            },
        ];

        const [conversation] = parseExportFile(records, "claude-code").conversations;

        expect(conversation?.messages.map((message) => message.content)).toEqual(["Fix the build", "Reviewed."]);
    });
});
