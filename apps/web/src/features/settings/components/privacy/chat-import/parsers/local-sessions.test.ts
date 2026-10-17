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
        expect(conversation?.messages[1]?.content).toContain("2 tool calls and results were not included");
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
        expect(conversation?.messages[1]?.content).toContain("2 tool calls and results were not included");
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

    it("tolerates a truncated final line, as a transcript still being written can end with one", async () => {
        const text = `${JSON.stringify(codexRollout[0])}\n${JSON.stringify(codexRollout[2])}\n{"partial`;
        const [records] = await extractJsonFromFile(new File([text], "rollout.jsonl"));

        expect(records).toHaveLength(2);
    });
});
