import { describe, expect, it } from "vitest";

import type { PublicThreadSourceMessage } from "./public-thread";
import { getMessageFileIds, redactUIMessagesForPublicViewer, toPublicThreadMessages } from "./public-thread";

const IMAGE_URL = "https://files.example.com/generated.png";

const message = (role: string, parts: unknown[], metadata?: unknown): PublicThreadSourceMessage => {
    return { _creationTime: 1_700_000_000_000, metadata, parts, role };
};

describe("toPublicThreadMessages", () => {
    it("keeps text and web sources", () => {
        const [result] = toPublicThreadMessages([
            message("assistant", [
                { text: "Hello", type: "text" },
                { providerMetadata: { secret: 1 }, sourceId: "s1", title: "Docs", type: "source-url", url: "https://example.com" },
            ]),
        ]);

        expect(result).toEqual({
            createdAt: 1_700_000_000_000,
            id: "m0",
            parts: [
                { text: "Hello", type: "text" },
                { title: "Docs", type: "source-url", url: "https://example.com" },
            ],
            role: "assistant",
        });
    });

    it("never carries tool input or output, only the tool name", () => {
        const [result] = toPublicThreadMessages([
            message("assistant", [
                {
                    input: { query: "my private notes" },
                    output: { memories: ["secret"] },
                    state: "output-available",
                    toolCallId: "c1",
                    type: "tool-search_memory",
                },
                { input: {}, output: "x", toolCallId: "c2", toolName: "gmail_read", type: "dynamic-tool" },
            ]),
        ]);

        expect(result?.parts).toEqual([
            { toolName: "search_memory", type: "tool" },
            { toolName: "gmail_read", type: "tool" },
        ]);
        expect(JSON.stringify(result)).not.toContain("secret");
    });

    it("collapses consecutive calls of the same tool into one", () => {
        const [result] = toPublicThreadMessages([
            message("assistant", [
                { toolCallId: "a", type: "tool-web_search" },
                { toolCallId: "b", type: "tool-web_search" },
                { text: "Found it", type: "text" },
                { toolCallId: "c", type: "tool-web_search" },
            ]),
        ]);

        expect(result?.parts.map((part) => part.type)).toEqual(["tool", "text", "tool"]);
    });

    it("drops reasoning, data parts, source documents and generation markers", () => {
        const result = toPublicThreadMessages([
            message("assistant", [
                { text: "thinking about the system prompt", type: "reasoning" },
                { data: { a: 1 }, type: "data-progress" },
                { filename: "contract.pdf", sourceId: "d1", type: "source-document" },
                { type: "step-start" },
                { text: "__IMAGE_GENERATING__", type: "text" },
            ]),
        ]);

        expect(result).toEqual([]);
    });

    it("replaces user attachments with a URL-less, filename-less placeholder", () => {
        const [result] = toPublicThreadMessages([
            message("user", [
                { filename: "passport.jpg", mediaType: "image/jpeg", type: "file", url: "https://files.example.com/private.jpg" },
                { text: "What is this?", type: "text" },
            ]),
        ]);

        expect(result?.parts).toEqual([
            { mediaType: "image/jpeg", type: "attachment" },
            { text: "What is this?", type: "text" },
        ]);
        expect(JSON.stringify(result)).not.toContain("private.jpg");
        expect(JSON.stringify(result)).not.toContain("passport");
    });

    it("keeps assistant-generated media with an http(s) URL", () => {
        const [result] = toPublicThreadMessages([message("assistant", [{ filename: "out.png", mediaType: "image/png", type: "file", url: IMAGE_URL }])]);

        expect(result?.parts).toEqual([{ filename: "out.png", mediaType: "image/png", type: "file", url: IMAGE_URL }]);
    });

    it("drops assistant media with a non-http URL", () => {
        const result = toPublicThreadMessages([
            message("assistant", [
                // eslint-disable-next-line no-script-url -- the input under test is exactly this
                { mediaType: "image/png", type: "file", url: "javascript:alert(1)" },
                { mediaType: "image/png", type: "file", url: "data:image/png;base64,AAAA" },
            ]),
        ]);

        expect(result).toEqual([]);
    });

    it("drops all media of a message whose files have not cleared the NSFW check", () => {
        const parts = [
            { mediaType: "image/png", type: "file", url: IMAGE_URL },
            { text: "Here you go", type: "text" },
        ];
        const statuses = new Map([
            ["f1", "safe"],
            ["f2", "blocked"],
        ]);

        const [blocked] = toPublicThreadMessages([message("assistant", parts, { fileIds: ["f1", "f2"] })], statuses);
        const [cleared] = toPublicThreadMessages([message("assistant", parts, { fileIds: ["f1"] })], statuses);

        expect(blocked?.parts).toEqual([{ text: "Here you go", type: "text" }]);
        expect(cleared?.parts).toHaveLength(2);
    });

    it("treats a file with no loaded row as not cleared", () => {
        const parts = [
            { mediaType: "image/png", type: "file", url: IMAGE_URL },
            { text: "Here you go", type: "text" },
        ];
        const statuses = new Map([["f1", undefined]]);

        const [missing] = toPublicThreadMessages([message("assistant", parts, { fileIds: ["f1", "gone"] })], statuses);
        const [unset] = toPublicThreadMessages([message("assistant", parts, { fileIds: ["f1"] })], statuses);
        const [redacted] = redactUIMessagesForPublicViewer([message("assistant", parts, { fileIds: ["gone"] })], statuses);

        expect(missing?.parts).toEqual([{ text: "Here you go", type: "text" }]);
        expect(unset?.parts).toHaveLength(2);
        expect(redacted?.parts).toEqual([{ text: "Here you go", type: "text" }]);
    });

    it("skips system and tool roles and numbers ids by position", () => {
        const result = toPublicThreadMessages([
            message("system", [{ text: "You are a helpful assistant with the owner's secret prompt", type: "text" }]),
            message("user", [{ text: "Hi", type: "text" }]),
            message("tool", [{ text: "raw", type: "text" }]),
            message("assistant", [{ text: "Hello", type: "text" }]),
        ]);

        expect(result.map((item) => [item.id, item.role])).toEqual([
            ["m0", "user"],
            ["m1", "assistant"],
        ]);
    });
});

describe("getMessageFileIds", () => {
    it("reads string ids and ignores malformed metadata", () => {
        expect(getMessageFileIds({ metadata: { fileIds: ["a", 1, "b"] } })).toEqual(["a", "b"]);
        expect(getMessageFileIds({ metadata: { fileIds: "a" } })).toEqual([]);
        expect(getMessageFileIds({ metadata: undefined })).toEqual([]);
    });
});

describe("redactUIMessagesForPublicViewer", () => {
    it("keeps text, sources and cleared assistant media in UIMessage shape, and nothing else", () => {
        const [redacted, ...rest] = redactUIMessagesForPublicViewer([
            {
                ...message("assistant", [
                    { text: "private reasoning", type: "reasoning" },
                    { input: { q: "secret" }, output: "secret", toolCallId: "c1", type: "tool-search_memory" },
                    { text: "Answer", type: "text" },
                    { sourceId: "x", type: "source-url", url: "https://example.com" },
                    { mediaType: "image/png", type: "file", url: IMAGE_URL },
                ]),
                order: 3,
                status: "success",
                stepOrder: 1,
            },
            { ...message("user", [{ text: "still streaming", type: "text" }]), status: "pending" },
        ]);

        expect(rest).toEqual([]);
        expect(redacted).toEqual({
            _creationTime: 1_700_000_000_000,
            id: "m0",
            key: "m0",
            order: 3,
            parts: [
                { text: "Answer", type: "text" },
                { sourceId: "s3", title: undefined, type: "source-url", url: "https://example.com" },
                { filename: undefined, mediaType: "image/png", type: "file", url: IMAGE_URL },
            ],
            role: "assistant",
            status: "success",
            stepOrder: 1,
            text: "Answer",
        });
        expect(JSON.stringify(redacted)).not.toContain("secret");
    });

    it("drops user attachments entirely rather than exposing their URL", () => {
        const [redacted] = redactUIMessagesForPublicViewer([
            message("user", [
                { filename: "passport.jpg", mediaType: "image/jpeg", type: "file", url: "https://files.example.com/private.jpg" },
                { text: "What is this?", type: "text" },
            ]),
        ]);

        expect(redacted?.parts).toEqual([{ text: "What is this?", type: "text" }]);
    });
});

describe("group chat speakers", () => {
    const speakerReply = { ...message("assistant", [{ text: "From the writer", type: "text" }]), agentName: "Writer", speakerSkillId: "skill-123" };
    const plainReply = { ...message("assistant", [{ text: "Plain", type: "text" }]), agentName: "gpt-4o" };

    it("keeps a participant's name on the share page, never its skill id", () => {
        const [speaker, plain] = toPublicThreadMessages([speakerReply, plainReply]);

        expect(speaker?.speakerName).toBe("Writer");
        expect(JSON.stringify(speaker)).not.toContain("skill-123");
        // An ordinary reply's `agentName` is the model id, not a speaker.
        expect(plain).not.toHaveProperty("speakerName");
    });

    it("keeps it in the redacted in-app view too", () => {
        const [speaker, plain] = redactUIMessagesForPublicViewer([speakerReply, plainReply]);

        expect(speaker?.speakerName).toBe("Writer");
        expect(JSON.stringify(speaker)).not.toContain("skill-123");
        expect(plain).not.toHaveProperty("speakerName");
    });
});
