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
const exported = async (format: Parameters<typeof handleDownload>[2]): Promise<Blob> => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:test");

    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    await handleDownload(thread, messages, format);

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
