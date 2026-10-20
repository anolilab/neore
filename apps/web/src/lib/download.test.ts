// @vitest-environment jsdom

import type { Doc } from "@neore/backend/dataModel";
import JsZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleDownload } from "./download";

const thread = { _creationTime: Date.UTC(2026, 9, 19), title: "Plan" } as Doc<"threads">;
const toolRow = {
    _creationTime: 3,
    message: { content: [{ output: { type: "json", value: { ok: true } }, type: "tool-result" }], role: "tool" },
    text: undefined,
    tool: true,
};
const messages = [
    toolRow,
    { _creationTime: 1, message: { role: "user" }, text: "First line\nSecond line" },
    { _creationTime: 2, message: { role: "assistant" }, text: "Done." },
] as unknown as Doc<"messages">[];

/** Runs an export and returns the blob it handed to the browser. */
const exported = async (format: Parameters<typeof handleDownload>[2], rows: Doc<"messages">[] = messages): Promise<Blob> => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:test");

    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    await handleDownload(thread, rows, format);

    return createObjectURL.mock.calls[0]![0];
};

describe("chat export", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("puts every line of a text export on its own line", async () => {
        const blob = await exported("txt");
        const text = await blob.text();

        expect(text).toContain("User: First line\nSecond line\nAssistant: Done.");
        expect(text).not.toContain(String.raw`\n`);
    });

    it("exports a tool result's output, not a placeholder", async () => {
        const blob = await exported("txt");
        const text = await blob.text();

        expect(text).toContain('Tool Output: {"ok":true}');
        expect(text).not.toContain("No result");
    });

    it("exports every result part of a tool message, in order", async () => {
        const multi = {
            _creationTime: 4,
            message: {
                content: [
                    { output: { type: "text", value: "first" }, type: "tool-result" },
                    { output: { type: "text", value: "second" }, type: "tool-result" },
                ],
                role: "tool",
            },
            text: undefined,
            tool: true,
        } as unknown as Doc<"messages">;

        const blob = await exported("txt", [multi]);

        expect(await blob.text()).toContain("Tool Output: first\nsecond");
    });

    it("writes a null tool output as null, not as a placeholder", async () => {
        const nullOutput = {
            _creationTime: 6,
            message: { content: [{ output: { type: "json", value: null }, type: "tool-result" }], role: "tool" },
            text: undefined,
            tool: true,
        } as unknown as Doc<"messages">;

        const blob = await exported("txt", [nullOutput]);

        expect(await blob.text()).toContain("Tool Output: null");
        expect(await blob.text()).not.toContain("No result");
    });

    it("writes the reason of a denied tool call, not a placeholder", async () => {
        const denied = {
            _creationTime: 8,
            message: { content: [{ output: { reason: "Not allowed to delete files", type: "execution-denied" }, type: "tool-result" }], role: "tool" },
            text: undefined,
            tool: true,
        } as unknown as Doc<"messages">;

        const blob = await exported("txt", [denied]);
        const text = await blob.text();

        expect(text).toContain("Tool Output: Not allowed to delete files");
        expect(text).not.toContain("No result");
    });

    it("names an image in a tool output instead of exporting its bytes", async () => {
        const image = {
            _creationTime: 7,
            message: {
                content: [
                    {
                        output: {
                            type: "content",
                            value: [
                                { text: "Chart ready", type: "text" },
                                { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", mediaType: "image/png", type: "image-data" },
                            ],
                        },
                        type: "tool-result",
                    },
                ],
                role: "tool",
            },
            text: undefined,
            tool: true,
        } as unknown as Doc<"messages">;

        const blob = await exported("txt", [image]);
        const text = await blob.text();

        expect(text).toContain("Chart ready\n[image: image/png]");
        expect(text).not.toContain("iVBORw0KGgo");
    });

    it("labels an assistant message that made a tool call as the assistant, not as tool output", async () => {
        const call = {
            _creationTime: 5,
            message: { content: [{ type: "tool-call" }], role: "assistant" },
            text: "Let me check.",
            tool: true,
        } as unknown as Doc<"messages">;

        const blob = await exported("txt", [call]);

        expect(await blob.text()).toContain("Assistant: Let me check.");
        expect(await blob.text()).not.toContain("Tool Output");
    });

    it("writes a Word document with the thread's messages", async () => {
        const blob = await exported("docx");
        const zip = await JsZip.loadAsync(await blob.arrayBuffer());
        const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";

        expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        expect(xml).toContain("Plan");
        expect(xml).toContain(">Second line</w:t>");
        expect(xml).toContain(">Assistant</w:t>");
    });
});
