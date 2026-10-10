import { describe, expect, it } from "vitest";

import parseGemini from "./gemini";
import type { NormalizedConversation, NormalizedMessage } from "./types";

describe("parseGemini", () => {
    it("parses a basic conversation with USER and MODEL messages", () => {
        const data = [
            {
                createTime: "2024-01-15T10:00:00.000Z",
                messages: [
                    { createTime: "2024-01-15T10:00:01.000Z", role: "USER", text: "Hello" },
                    { createTime: "2024-01-15T10:00:02.000Z", role: "MODEL", text: "Hi there!" },
                ],
                title: "Gemini Chat",
            },
        ];

        const result = parseGemini(data);

        expect(result).toHaveLength(1);
        expect((result[0] as NormalizedConversation).title).toBe("Gemini Chat");
        expect((result[0] as NormalizedConversation).createdAt).toBe(new Date("2024-01-15T10:00:00.000Z").getTime());
        expect((result[0] as NormalizedConversation).messages).toHaveLength(2);
        expect((result[0] as NormalizedConversation).messages[0]).toEqual({
            content: "Hello",
            createdAt: new Date("2024-01-15T10:00:01.000Z").getTime(),
            role: "user",
        });
        expect((result[0] as NormalizedConversation).messages[1]).toEqual({
            content: "Hi there!",
            createdAt: new Date("2024-01-15T10:00:02.000Z").getTime(),
            role: "assistant",
        });
    });

    it("handles case-insensitive role matching", () => {
        const data = [
            {
                messages: [
                    { role: "user", text: "lowercase" },
                    { role: "Model", text: "mixed case" },
                ],
                title: "Case test",
            },
        ];

        const result = parseGemini(data);

        expect((result[0] as NormalizedConversation).messages).toHaveLength(2);
        expect(((result[0] as NormalizedConversation).messages[0] as NormalizedMessage).role).toBe("user");
        expect(((result[0] as NormalizedConversation).messages[1] as NormalizedMessage).role).toBe("assistant");
    });

    it("supports content field as alternative to text", () => {
        const data = [
            {
                messages: [
                    { content: "Using content field", role: "USER" },
                    { role: "MODEL", text: "Using text field" },
                ],
                title: "Content field",
            },
        ];

        const result = parseGemini(data);

        expect(((result[0] as NormalizedConversation).messages[0] as NormalizedMessage).content).toBe("Using content field");
        expect(((result[0] as NormalizedConversation).messages[1] as NormalizedMessage).content).toBe("Using text field");
    });

    it("filters out unknown roles", () => {
        const data = [
            {
                messages: [
                    { role: "USER", text: "Hello" },
                    { role: "SYSTEM", text: "System prompt" },
                    { role: "MODEL", text: "Response" },
                ],
                title: "Unknown role",
            },
        ];

        const result = parseGemini(data);

        expect((result[0] as NormalizedConversation).messages).toHaveLength(2);
        expect(((result[0] as NormalizedConversation).messages[0] as NormalizedMessage).role).toBe("user");
        expect(((result[0] as NormalizedConversation).messages[1] as NormalizedMessage).role).toBe("assistant");
    });

    it("skips messages with empty content", () => {
        const data = [
            {
                messages: [
                    { role: "USER", text: "Hello" },
                    { role: "MODEL", text: "  " },
                    { role: "MODEL", text: "Actual response" },
                ],
                title: "Empty text",
            },
        ];

        const result = parseGemini(data);

        expect((result[0] as NormalizedConversation).messages).toHaveLength(2);
        expect(((result[0] as NormalizedConversation).messages[1] as NormalizedMessage).content).toBe("Actual response");
    });

    it("skips conversations with no valid messages", () => {
        const data = [
            {
                messages: [],
                title: "No messages",
            },
            {
                messages: [{ role: "SYSTEM", text: "prompt" }],
                title: "Only system",
            },
        ];

        const result = parseGemini(data);

        expect(result).toHaveLength(0);
    });

    it("handles a single conversation object (not array)", () => {
        const data = {
            messages: [
                { role: "USER", text: "Hello" },
                { role: "MODEL", text: "Hi!" },
            ],
            title: "Single conv",
        };

        const result = parseGemini(data);

        expect(result).toHaveLength(1);
        expect((result[0] as NormalizedConversation).title).toBe("Single conv");
    });

    it("uses 'Untitled' when title is missing", () => {
        const data = [
            {
                messages: [{ role: "USER", text: "Hi" }],
            },
        ];

        const result = parseGemini(data);

        expect((result[0] as NormalizedConversation).title).toBe("Untitled");
    });

    it("handles missing timestamps", () => {
        const data = [
            {
                messages: [{ role: "USER", text: "Hello" }],
                title: "No timestamps",
            },
        ];

        const result = parseGemini(data);

        expect((result[0] as NormalizedConversation).createdAt).toBeUndefined();
        expect(((result[0] as NormalizedConversation).messages[0] as NormalizedMessage).createdAt).toBeUndefined();
    });

    it("handles invalid ISO timestamps", () => {
        const data = [
            {
                createTime: "not-a-date",
                messages: [{ createTime: "also-not-a-date", role: "USER", text: "Hello" }],
                title: "Bad timestamps",
            },
        ];

        const result = parseGemini(data);

        expect((result[0] as NormalizedConversation).createdAt).toBeUndefined();
        expect(((result[0] as NormalizedConversation).messages[0] as NormalizedMessage).createdAt).toBeUndefined();
    });

    it("handles multiple conversations", () => {
        const data = [
            {
                messages: [{ role: "USER", text: "One" }],
                title: "First",
            },
            {
                messages: [{ role: "USER", text: "Two" }],
                title: "Second",
            },
        ];

        const result = parseGemini(data);

        expect(result).toHaveLength(2);
        expect(result.map((c) => c.title)).toEqual(["First", "Second"]);
    });

    it("returns empty array for non-matching input shapes", () => {
        expect(parseGemini("string")).toHaveLength(0);
        expect(parseGemini(42)).toHaveLength(0);
        expect(parseGemini(null)).toHaveLength(0);
    });

    it("skips conversations without messages field", () => {
        const data = [
            { title: "No messages field" },
            {
                messages: [{ role: "USER", text: "Hi" }],
                title: "Has messages",
            },
        ];

        const result = parseGemini(data);

        expect(result).toHaveLength(1);
        expect((result[0] as NormalizedConversation).title).toBe("Has messages");
    });
});
