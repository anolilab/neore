import { describe, expect, it } from "vitest";

import { MAX_TOOL_OUTPUT_CHARS, outputTail, terminalIdOf, toolTextOf } from "./tool-output";

describe(toolTextOf, () => {
    it("joins the text blocks of a call's content and leaves out every other kind", () => {
        const content = [
            { content: { text: "line 1", type: "text" }, type: "content" },
            { newText: "x", path: "a.ts", type: "diff" },
            { content: { data: "...", mimeType: "image/png", type: "image" }, type: "content" },
            { terminalId: "term-1", type: "terminal" },
            { content: { text: "line 2", type: "text" }, type: "content" },
        ];

        expect(toolTextOf(content)).toBe("line 1\nline 2");
    });

    it("says nothing for an update without content, and empty for content with no text", () => {
        expect(toolTextOf(undefined)).toBeUndefined();
        expect(toolTextOf([{ path: "a.ts", type: "diff" }])).toBe("");
    });
});

describe(terminalIdOf, () => {
    it("names the terminal the call ran in", () => {
        expect(terminalIdOf([{ content: { text: "x", type: "text" }, type: "content" }, { terminalId: "term-1", type: "terminal" }])).toBe("term-1");
        expect(terminalIdOf([{ type: "terminal" }])).toBeUndefined();
    });
});

describe(outputTail, () => {
    it("keeps the tail of a long output", () => {
        const raw = `${"a".repeat(5000)}END`;

        expect(outputTail(raw, (value) => value)).toHaveLength(MAX_TOOL_OUTPUT_CHARS);
        expect(outputTail(raw, (value) => value).endsWith("END")).toBe(true);
    });

    it("masks before it cuts, so no part of a masked value survives the cut", () => {
        const secret = "sk-very-secret-token";
        const raw = `${secret}${"b".repeat(MAX_TOOL_OUTPUT_CHARS - 5)}`;
        const tail = outputTail(raw, (value) => value.replaceAll(secret, "***"));

        expect(tail).not.toContain("token");
        expect(tail).not.toContain("secret");
    });
});

describe("cutting at the edge", () => {
    it("drops what a cut could have left of a masked value", async () => {
        const { cutEdge, cutTerminal } = await import("./tool-output");

        expect(cutEdge("abcdefgh", 5, 4)).toBe("gh");
        expect(cutEdge("abc", 5, 4)).toBe("abc");
        expect(cutTerminal({ output: "xyzabc", truncated: true }, 3)).toBe("zabc");
        expect(cutTerminal({ output: "xyzabc", truncated: false }, 3)).toBe("xyzabc");
    });
});
