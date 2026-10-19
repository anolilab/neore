// @vitest-environment jsdom

import type { Doc } from "@neore/backend/dataModel";
import JsZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleDownload } from "./download";

const thread = { _creationTime: Date.UTC(2026, 9, 19), title: "Plan" } as Doc<"threads">;
const messages = [
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
        const text = await (await exported("txt")).text();

        expect(text).toContain("User: First line\nSecond line\nAssistant: Done.");
        expect(text).not.toContain(String.raw`\n`);
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
