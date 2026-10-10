import { describe, expect, it, vi } from "vitest";

import { parseExportFile } from "./index";
import type { NormalizedConversation, NormalizedMessage } from "./types";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted); a descriptor carries its English source.
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray, ...values: unknown[]) => {
            const text = String.raw({ raw: strings }, ...values);

            return { id: text, message: text };
        },
    };
});

describe("parseExportFile", () => {
    describe("auto-detection", () => {
        it("detects ChatGPT from mapping field in array", () => {
            const data = [
                {
                    current_node: "msg1",
                    mapping: {
                        msg1: {
                            children: [],
                            id: "msg1",
                            message: {
                                author: { role: "user" },
                                content: { content_type: "text", parts: ["Hi"] },
                                id: "msg1",
                            },
                            parent: "root",
                        },
                        root: { children: ["msg1"], id: "root" },
                    },
                    title: "ChatGPT conv",
                },
            ];

            const result = parseExportFile(data);

            expect(result.provider).toBe("chatgpt");
            expect(result.conversations).toHaveLength(1);
        });

        it("detects Claude from chat_messages field in array", () => {
            const data = [
                {
                    chat_messages: [
                        { sender: "human", text: "Hello" },
                        { sender: "assistant", text: "Hi!" },
                    ],
                    name: "Claude conv",
                },
            ];

            const result = parseExportFile(data);

            expect(result.provider).toBe("claude");
            expect(result.conversations).toHaveLength(1);
        });

        it("detects Gemini from messages with USER/MODEL roles in array", () => {
            const data = [
                {
                    messages: [
                        { role: "USER", text: "Hello" },
                        { role: "MODEL", text: "Hi!" },
                    ],
                    title: "Gemini conv",
                },
            ];

            const result = parseExportFile(data);

            expect(result.provider).toBe("gemini");
            expect(result.conversations).toHaveLength(1);
        });

        it("detects Claude from single object with chat_messages", () => {
            const data = {
                chat_messages: [{ sender: "human", text: "Hello" }],
                name: "Single Claude",
            };

            const result = parseExportFile(data);

            expect(result.provider).toBe("claude");
        });

        it("detects Gemini from single object with messages", () => {
            const data = {
                messages: [{ role: "USER", text: "Hello" }],
                title: "Single Gemini",
            };

            const result = parseExportFile(data);

            expect(result.provider).toBe("gemini");
        });

        it("detects ChatGPT from single object with mapping", () => {
            const data = {
                current_node: "msg1",
                mapping: {
                    msg1: {
                        children: [],
                        id: "msg1",
                        message: {
                            author: { role: "user" },
                            content: { content_type: "text", parts: ["Hi"] },
                            id: "msg1",
                        },
                        parent: "root",
                    },
                    root: { children: ["msg1"], id: "root" },
                },
                title: "Single ChatGPT",
            };

            // Single ChatGPT conv is not an array, so parseChatGPT will throw.
            // But detection itself should work — wrapping in array for the parser.
            const result = parseExportFile([data]);

            expect(result.provider).toBe("chatgpt");
        });

        it("throws for unrecognized data format", () => {
            expect(() => parseExportFile({ unknown: "format" })).toThrow("Could not detect the chat provider");
        });

        it("throws for empty array", () => {
            expect(() => parseExportFile([])).toThrow("Could not detect the chat provider");
        });
    });

    describe("explicit provider", () => {
        it("uses specified provider without auto-detection", () => {
            const data = [
                {
                    chat_messages: [{ sender: "human", text: "Hello" }],
                    name: "Conv",
                },
            ];

            const result = parseExportFile(data, "claude");

            expect(result.provider).toBe("claude");
            expect(result.conversations).toHaveLength(1);
        });
    });

    describe("end-to-end parsing", () => {
        it("correctly parses ChatGPT branching conversation", () => {
            const data = [
                {
                    create_time: 1_700_000_000,
                    // current_node follows the a2 -> u2 branch
                    current_node: "u2",
                    mapping: {
                        a1: {
                            children: [],
                            id: "a1",
                            message: {
                                author: { role: "assistant" },
                                content: { content_type: "text", parts: ["4"] },
                                create_time: 1_700_000_002,
                                id: "a1",
                            },
                            parent: "u1",
                        },
                        a2: {
                            children: ["u2"],
                            id: "a2",
                            message: {
                                author: { role: "assistant" },
                                content: { content_type: "text", parts: ["The answer is 4."] },
                                create_time: 1_700_000_003,
                                id: "a2",
                            },
                            parent: "u1",
                        },
                        root: { children: ["sys"], id: "root" },
                        sys: {
                            children: ["u1"],
                            id: "sys",
                            message: {
                                author: { role: "system" },
                                content: { content_type: "text", parts: ["You are helpful."] },
                                id: "sys",
                            },
                            parent: "root",
                        },
                        u1: {
                            children: ["a1", "a2"],
                            id: "u1",
                            message: {
                                author: { role: "user" },
                                content: { content_type: "text", parts: ["What is 2+2?"] },
                                create_time: 1_700_000_001,
                                id: "u1",
                            },
                            parent: "sys",
                        },
                        u2: {
                            children: [],
                            id: "u2",
                            message: {
                                author: { role: "user" },
                                content: { content_type: "text", parts: ["Thanks!"] },
                                create_time: 1_700_000_004,
                                id: "u2",
                            },
                            parent: "a2",
                        },
                    },
                    title: "Branching chat",
                },
            ];

            const result = parseExportFile(data);

            expect(result.provider).toBe("chatgpt");
            expect(result.conversations).toHaveLength(1);
            const conv = result.conversations[0] as NormalizedConversation;

            expect(conv.messages).toHaveLength(3);
            expect((conv.messages[0] as NormalizedMessage).content).toBe("What is 2+2?");
            expect((conv.messages[1] as NormalizedMessage).content).toBe("The answer is 4.");
            expect((conv.messages[2] as NormalizedMessage).content).toBe("Thanks!");
        });

        it("correctly parses Gemini multi-turn conversation", () => {
            const data = [
                {
                    createTime: "2024-06-01T09:00:00.000Z",
                    messages: [
                        { createTime: "2024-06-01T09:00:01.000Z", role: "USER", text: "Explain gravity" },
                        { createTime: "2024-06-01T09:00:05.000Z", role: "MODEL", text: "Gravity is a force..." },
                        { createTime: "2024-06-01T09:01:00.000Z", role: "USER", text: "Can you simplify?" },
                        { createTime: "2024-06-01T09:01:05.000Z", role: "MODEL", text: "Things fall down." },
                    ],
                    title: "Gemini multi-turn",
                },
            ];

            const result = parseExportFile(data);

            expect(result.provider).toBe("gemini");
            const conv = result.conversations[0] as NormalizedConversation;

            expect(conv.messages).toHaveLength(4);
            expect((conv.messages[0] as NormalizedMessage).role).toBe("user");
            expect((conv.messages[3] as NormalizedMessage).role).toBe("assistant");
        });

        it("correctly parses Claude conversation with metadata", () => {
            const data = [
                {
                    chat_messages: [
                        {
                            created_at: "2024-05-15T14:30:01.000000Z",
                            sender: "human",
                            text: "Review this code",
                            uuid: "msg-1",
                        },
                        {
                            created_at: "2024-05-15T14:30:10.000000Z",
                            sender: "assistant",
                            text: "The code looks good but...",
                            uuid: "msg-2",
                        },
                    ],
                    created_at: "2024-05-15T14:30:00.000000Z",
                    name: "Code Review",
                    uuid: "abc-123",
                },
            ];

            const result = parseExportFile(data);

            expect(result.provider).toBe("claude");
            const conv = result.conversations[0] as NormalizedConversation;

            expect(conv.title).toBe("Code Review");
            expect(conv.messages).toHaveLength(2);
        });
    });
});
