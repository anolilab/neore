import { describe, expect, it } from "vitest";

import parseClaude from "./claude";
import type { NormalizedConversation, NormalizedMessage } from "./types";

describe("parseClaude", () => {
    it("parses a basic conversation with human and assistant messages", () => {
        const data = [
            {
                chat_messages: [
                    { created_at: "2024-03-01T12:00:01.000000Z", sender: "human", text: "Hello" },
                    { created_at: "2024-03-01T12:00:02.000000Z", sender: "assistant", text: "Hi there!" },
                ],
                created_at: "2024-03-01T12:00:00.000000Z",
                name: "Claude Chat",
            },
        ];

        const result = parseClaude(data);

        expect(result).toHaveLength(1);
        expect((result[0] as NormalizedConversation).title).toBe("Claude Chat");
        expect((result[0] as NormalizedConversation).createdAt).toBe(new Date("2024-03-01T12:00:00.000000Z").getTime());
        expect((result[0] as NormalizedConversation).messages).toHaveLength(2);
        expect((result[0] as NormalizedConversation).messages[0]).toEqual({
            content: "Hello",
            createdAt: new Date("2024-03-01T12:00:01.000000Z").getTime(),
            role: "user",
        });
        expect((result[0] as NormalizedConversation).messages[1]).toEqual({
            content: "Hi there!",
            createdAt: new Date("2024-03-01T12:00:02.000000Z").getTime(),
            role: "assistant",
        });
    });

    it("normalizes 'human' sender to 'user' role", () => {
        const data = [
            {
                chat_messages: [
                    { sender: "human", text: "From human" },
                    { sender: "assistant", text: "From assistant" },
                ],
                name: "Role test",
            },
        ];

        const result = parseClaude(data);

        expect(((result[0] as NormalizedConversation).messages[0] as NormalizedMessage).role).toBe("user");
        expect(((result[0] as NormalizedConversation).messages[1] as NormalizedMessage).role).toBe("assistant");
    });

    it("handles case-insensitive sender matching", () => {
        const data = [
            {
                chat_messages: [
                    { sender: "Human", text: "Upper" },
                    { sender: "ASSISTANT", text: "All caps" },
                ],
                name: "Case test",
            },
        ];

        const result = parseClaude(data);

        expect((result[0] as NormalizedConversation).messages).toHaveLength(2);
        expect(((result[0] as NormalizedConversation).messages[0] as NormalizedMessage).role).toBe("user");
        expect(((result[0] as NormalizedConversation).messages[1] as NormalizedMessage).role).toBe("assistant");
    });

    it("supports content field as alternative to text", () => {
        const data = [
            {
                chat_messages: [
                    { content: "Using content", sender: "human" },
                    { sender: "assistant", text: "Using text" },
                ],
                name: "Content field",
            },
        ];

        const result = parseClaude(data);

        expect(((result[0] as NormalizedConversation).messages[0] as NormalizedMessage).content).toBe("Using content");
        expect(((result[0] as NormalizedConversation).messages[1] as NormalizedMessage).content).toBe("Using text");
    });

    it("filters out unknown sender roles", () => {
        const data = [
            {
                chat_messages: [
                    { sender: "human", text: "Hello" },
                    { sender: "system", text: "System message" },
                    { sender: "assistant", text: "Response" },
                ],
                name: "Unknown sender",
            },
        ];

        const result = parseClaude(data);

        expect((result[0] as NormalizedConversation).messages).toHaveLength(2);
    });

    it("skips messages with empty content", () => {
        const data = [
            {
                chat_messages: [
                    { sender: "human", text: "Hello" },
                    { sender: "assistant", text: "" },
                    { sender: "assistant", text: "Real response" },
                ],
                name: "Empty text",
            },
        ];

        const result = parseClaude(data);

        expect((result[0] as NormalizedConversation).messages).toHaveLength(2);
        expect(((result[0] as NormalizedConversation).messages[1] as NormalizedMessage).content).toBe("Real response");
    });

    it("skips conversations with no valid messages", () => {
        const data = [
            {
                chat_messages: [],
                name: "Empty",
            },
            {
                chat_messages: [{ sender: "system", text: "prompt" }],
                name: "System only",
            },
        ];

        const result = parseClaude(data);

        expect(result).toHaveLength(0);
    });

    it("handles a single conversation object (not array)", () => {
        const data = {
            chat_messages: [
                { sender: "human", text: "Hello" },
                { sender: "assistant", text: "Hi!" },
            ],
            name: "Single",
        };

        const result = parseClaude(data);

        expect(result).toHaveLength(1);
        expect((result[0] as NormalizedConversation).title).toBe("Single");
    });

    it("throws for invalid non-array, non-object input", () => {
        expect(() => parseClaude("string")).toThrow("Expected an array of conversations");
        expect(() => parseClaude(42)).toThrow("Expected an array of conversations");
    });

    it("uses 'Untitled' when name is missing", () => {
        const data = [
            {
                chat_messages: [{ sender: "human", text: "Hi" }],
            },
        ];

        const result = parseClaude(data);

        expect((result[0] as NormalizedConversation).title).toBe("Untitled");
    });

    it("handles missing timestamps", () => {
        const data = [
            {
                chat_messages: [{ sender: "human", text: "Hello" }],
                name: "No timestamps",
            },
        ];

        const result = parseClaude(data);

        expect((result[0] as NormalizedConversation).createdAt).toBeUndefined();
        expect(((result[0] as NormalizedConversation).messages[0] as NormalizedMessage).createdAt).toBeUndefined();
    });

    it("handles missing chat_messages field", () => {
        const data = [{ name: "No messages" }];

        const result = parseClaude(data);

        expect(result).toHaveLength(0);
    });

    it("handles multiple conversations", () => {
        const data = [
            { chat_messages: [{ sender: "human", text: "One" }], name: "First" },
            { chat_messages: [{ sender: "human", text: "Two" }], name: "Second" },
            { chat_messages: [{ sender: "human", text: "Three" }], name: "Third" },
        ];

        const result = parseClaude(data);

        expect(result).toHaveLength(3);
        expect(result.map((c) => c.title)).toEqual(["First", "Second", "Third"]);
    });

    it("handles microsecond ISO timestamps from Claude exports", () => {
        const data = [
            {
                chat_messages: [{ created_at: "2024-03-01T12:00:01.654321Z", sender: "human", text: "Hi" }],
                created_at: "2024-03-01T12:00:00.123456Z",
                name: "Microseconds",
            },
        ];

        const result = parseClaude(data);

        // JS Date truncates microseconds to milliseconds
        expect((result[0] as NormalizedConversation).createdAt).toBe(new Date("2024-03-01T12:00:00.123456Z").getTime());
        expect(((result[0] as NormalizedConversation).messages[0] as NormalizedMessage).createdAt).toBe(new Date("2024-03-01T12:00:01.654321Z").getTime());
    });
});
