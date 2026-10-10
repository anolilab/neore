import { describe, expect, it } from "vitest";

import parseChatGPT from "./chatgpt";
import type { NormalizedConversation, NormalizedMessage } from "./types";

describe("parseChatGPT", () => {
    it("parses a basic conversation with user and assistant messages", () => {
        const data = [
            {
                create_time: 1_700_000_000,
                current_node: "msg2",
                mapping: {
                    msg1: {
                        children: ["msg2"],
                        id: "msg1",
                        message: {
                            author: { role: "user" },
                            content: { content_type: "text", parts: ["Hello"] },
                            create_time: 1_700_000_001,
                            id: "msg1",
                        },
                        parent: "root",
                    },
                    msg2: {
                        children: [],
                        id: "msg2",
                        message: {
                            author: { role: "assistant" },
                            content: { content_type: "text", parts: ["Hi there!"] },
                            create_time: 1_700_000_002,
                            id: "msg2",
                        },
                        parent: "msg1",
                    },
                    root: {
                        children: ["msg1"],
                        id: "root",
                    },
                },
                title: "Hello World",
            },
        ];

        const result = parseChatGPT(data);

        expect(result).toHaveLength(1);
        expect((result[0] as NormalizedConversation).title).toBe("Hello World");
        expect((result[0] as NormalizedConversation).createdAt).toBe(1_700_000_000_000);
        expect((result[0] as NormalizedConversation).messages).toHaveLength(2);
        expect((result[0] as NormalizedConversation).messages[0]).toEqual({
            content: "Hello",
            createdAt: 1_700_000_001_000,
            role: "user",
        });
        expect((result[0] as NormalizedConversation).messages[1]).toEqual({
            content: "Hi there!",
            createdAt: 1_700_000_002_000,
            role: "assistant",
        });
    });

    it("filters out system and tool messages", () => {
        const data = [
            {
                current_node: "asst1",
                mapping: {
                    asst1: {
                        children: [],
                        id: "asst1",
                        message: {
                            author: { role: "assistant" },
                            content: { content_type: "text", parts: ["Here are some cats."] },
                            id: "asst1",
                        },
                        parent: "tool1",
                    },
                    root: {
                        children: ["sys"],
                        id: "root",
                    },
                    sys: {
                        children: ["user1"],
                        id: "sys",
                        message: {
                            author: { role: "system" },
                            content: { content_type: "text", parts: ["You are an assistant."] },
                            id: "sys",
                        },
                        parent: "root",
                    },
                    tool1: {
                        children: ["asst1"],
                        id: "tool1",
                        message: {
                            author: { role: "tool" },
                            content: { content_type: "text", parts: ["tool result"] },
                            id: "tool1",
                        },
                        parent: "user1",
                    },
                    user1: {
                        children: ["tool1"],
                        id: "user1",
                        message: {
                            author: { role: "user" },
                            content: { content_type: "text", parts: ["Search for cats"] },
                            id: "user1",
                        },
                        parent: "sys",
                    },
                },
                title: "System test",
            },
        ];

        const result = parseChatGPT(data);

        expect(result).toHaveLength(1);
        expect((result[0] as NormalizedConversation).messages).toHaveLength(2);
        expect(((result[0] as NormalizedConversation).messages[0] as NormalizedMessage).role).toBe("user");
        expect(((result[0] as NormalizedConversation).messages[1] as NormalizedMessage).role).toBe("assistant");
    });

    it("extracts text from mixed parts (strings and objects)", () => {
        const data = [
            {
                current_node: "msg1",
                mapping: {
                    msg1: {
                        children: [],
                        id: "msg1",
                        message: {
                            author: { role: "user" },
                            content: {
                                content_type: "text",
                                parts: ["Hello", { type: "image", url: "..." }, "World"],
                            },
                            id: "msg1",
                        },
                        parent: "root",
                    },
                    root: { children: ["msg1"], id: "root" },
                },
                title: "Mixed parts",
            },
        ];

        const result = parseChatGPT(data);

        expect(((result[0] as NormalizedConversation).messages[0] as NormalizedMessage).content).toBe("Hello\nWorld");
    });

    it("skips messages with empty content", () => {
        const data = [
            {
                current_node: "msg2",
                mapping: {
                    msg1: {
                        children: ["msg2"],
                        id: "msg1",
                        message: {
                            author: { role: "user" },
                            content: { content_type: "text", parts: ["  "] },
                            id: "msg1",
                        },
                        parent: "root",
                    },
                    msg2: {
                        children: [],
                        id: "msg2",
                        message: {
                            author: { role: "assistant" },
                            content: { content_type: "text", parts: ["Response"] },
                            id: "msg2",
                        },
                        parent: "msg1",
                    },
                    root: { children: ["msg1"], id: "root" },
                },
                title: "Empty content",
            },
        ];

        const result = parseChatGPT(data);

        expect((result[0] as NormalizedConversation).messages).toHaveLength(1);
        expect(((result[0] as NormalizedConversation).messages[0] as NormalizedMessage).role).toBe("assistant");
    });

    it("skips conversations without mapping", () => {
        const data = [
            { title: "No mapping" },
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
                title: "Has mapping",
            },
        ];

        const result = parseChatGPT(data);

        expect(result).toHaveLength(1);
        expect((result[0] as NormalizedConversation).title).toBe("Has mapping");
    });

    it("skips conversations with no extractable messages", () => {
        const data = [
            {
                current_node: "root",
                mapping: {
                    root: {
                        children: [],
                        id: "root",
                        message: {
                            author: { role: "system" },
                            content: { content_type: "text", parts: ["system prompt"] },
                            id: "root",
                        },
                    },
                },
                title: "System only",
            },
        ];

        const result = parseChatGPT(data);

        expect(result).toHaveLength(0);
    });

    it("handles missing current_node gracefully", () => {
        const data = [
            {
                mapping: {
                    root: { children: [], id: "root" },
                },
                title: "No current_node",
            },
        ];

        const result = parseChatGPT(data);

        expect(result).toHaveLength(0);
    });

    it("uses 'Untitled' when title is missing", () => {
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
            },
        ];

        const result = parseChatGPT(data);

        expect((result[0] as NormalizedConversation).title).toBe("Untitled");
    });

    it("throws for non-array input", () => {
        expect(() => parseChatGPT({ not: "an array" })).toThrow("Expected an array of conversations");
    });

    it("handles multiple conversations", () => {
        const makeConv = (title: string) => {
            return {
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
                title,
            };
        };

        const result = parseChatGPT([makeConv("First"), makeConv("Second"), makeConv("Third")]);

        expect(result).toHaveLength(3);
        expect(result.map((c) => c.title)).toEqual(["First", "Second", "Third"]);
    });

    it("handles nodes without message property", () => {
        const data = [
            {
                current_node: "msg2",
                mapping: {
                    msg1: {
                        children: ["msg2"],
                        id: "msg1",
                        parent: "root",
                        // no message property
                    },
                    msg2: {
                        children: [],
                        id: "msg2",
                        message: {
                            author: { role: "user" },
                            content: { content_type: "text", parts: ["Hello"] },
                            id: "msg2",
                        },
                        parent: "msg1",
                    },
                    root: { children: ["msg1"], id: "root" },
                },
                title: "Bare nodes",
            },
        ];

        const result = parseChatGPT(data);

        expect((result[0] as NormalizedConversation).messages).toHaveLength(1);
        expect(((result[0] as NormalizedConversation).messages[0] as NormalizedMessage).content).toBe("Hello");
    });

    it("converts float seconds to millisecond timestamps", () => {
        const data = [
            {
                create_time: 1_700_000_000.123,
                current_node: "msg1",
                mapping: {
                    msg1: {
                        children: [],
                        id: "msg1",
                        message: {
                            author: { role: "user" },
                            content: { content_type: "text", parts: ["Hi"] },
                            create_time: 1_700_000_001.456,
                            id: "msg1",
                        },
                        parent: "root",
                    },
                    root: { children: ["msg1"], id: "root" },
                },
                title: "Timestamps",
            },
        ];

        const result = parseChatGPT(data);

        expect((result[0] as NormalizedConversation).createdAt).toBe(1_700_000_000_123);
        expect(((result[0] as NormalizedConversation).messages[0] as NormalizedMessage).createdAt).toBe(1_700_000_001_456);
    });
});
