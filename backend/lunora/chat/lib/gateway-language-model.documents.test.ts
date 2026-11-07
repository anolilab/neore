/**
 * Workers AI takes no document input: a PDF part reaches it as a line naming the file, so the call does not fail.
 * Images pass, and so does everything for a provider that reads documents.
 */
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { withoutUnreadableDocuments } from "./gateway-language-model";

const options = {
    prompt: [
        { content: "Be brief.", role: "system" },
        {
            content: [
                { text: "What does this say?", type: "text" },
                { data: "storage:agent-files/pdf", filename: "q3.pdf", mediaType: "application/pdf", type: "file" },
                { data: "storage:agent-files/png", mediaType: "image/png", type: "file" },
            ],
            role: "user",
        },
    ],
} as unknown as LanguageModelV3CallOptions;

describe(withoutUnreadableDocuments, () => {
    it("names a document instead of sending it to Workers AI, and keeps images", () => {
        const [, user] = withoutUnreadableDocuments(options, "cloudflare").prompt;

        expect(user?.content).toStrictEqual([
            { text: "What does this say?", type: "text" },
            { text: "[Attached file: q3.pdf (application/pdf) — this model cannot read it]", type: "text" },
            { data: "storage:agent-files/png", mediaType: "image/png", type: "file" },
        ]);
    });

    it("leaves the call alone for a provider that reads documents", () => {
        expect(withoutUnreadableDocuments(options, "openrouter")).toBe(options);
    });
});
