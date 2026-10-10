import { describe, expect, it } from "vitest";

import { computeTaint, taintOfTool } from "./taint";

describe("taintOfTool", () => {
    it("classifies tools by where their output comes from", () => {
        expect(taintOfTool("webSearch")).toBe("web");
        expect(taintOfTool("retrieve")).toBe("web");
        expect(taintOfTool("knowledgeSearch")).toBe("knowledge");
        expect(taintOfTool("mcp_notion__search")).toBe("mcp");
        expect(taintOfTool("device_abc123__fs_read")).toBe("device");
        expect(taintOfTool("createDocument")).toBeNull();
        expect(taintOfTool("askUser")).toBeNull();
    });

    it("fails closed for a tool it does not know", () => {
        expect(taintOfTool("someNewTool")).toBe("web");
    });
});

describe("computeTaint", () => {
    it("is empty for a plain conversation", () => {
        expect(
            computeTaint([
                { content: "hi", role: "user" },
                { content: [{ text: "hello", type: "text" }], role: "assistant" },
            ]),
        ).toEqual([]);
    });

    it("collects every untrusted source the model read, once, in a stable order", () => {
        expect(
            computeTaint([
                { content: [{ image: "x", type: "image" }], role: "user" },
                { content: [{ toolName: "mcp_github__get_issue", type: "tool-result" }], role: "tool" },
                { content: [{ toolName: "webSearch", type: "tool-result" }], role: "tool" },
                { content: [{ toolName: "retrieve", type: "tool-result" }], role: "tool" },
                { content: [{ toolName: "dateTime", type: "tool-result" }], role: "tool" },
            ]),
        ).toEqual(["web", "mcp", "files"]);
    });

    it("ignores a tool CALL (only results carry content)", () => {
        expect(computeTaint([{ content: [{ toolName: "webSearch", type: "tool-call" }], role: "assistant" }])).toEqual([]);
    });

    it("treats a missing message list as clean", () => {
        expect(computeTaint(undefined)).toEqual([]);
    });
});
