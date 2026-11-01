import { describe, expect, it } from "vitest";

import { buildGoalContinuationPrompt } from "../../chat/goals/logic";
import { computeTaint, mergeTaint, taintOfTool } from "./taint";

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
    it("treats history compressed to text as having read a page", () => {
        expect(computeTaint([{ content: "[Context from earlier in this conversation]\nnotes", role: "user" }])).toEqual(["web"]);
        expect(computeTaint([{ content: "[Earlier conversation was removed to fit the context window]", role: "user" }])).toEqual(["web"]);
        expect(computeTaint([{ content: "hello", role: "user" }])).toEqual([]);
    });

    it("is empty for a plain conversation", () => {
        expect(
            computeTaint([
                { content: "hi", role: "user" },
                { content: [{ text: "hello", type: "text" }], role: "assistant" },
            ]),
        ).toEqual([]);
    });

    it("counts a coding agent's posted result as device taint, whichever key its mark rides under", () => {
        const mark = { neore: { runner: "host" } };

        expect(computeTaint([{ content: [{ providerMetadata: mark, text: "Done.", type: "text" }], role: "assistant" }])).toEqual(["device"]);
        expect(computeTaint([{ content: [{ providerOptions: mark, text: "Done.", type: "text" }], role: "assistant" }])).toEqual(["device"]);
        // The person's own words never carry it.
        expect(computeTaint([{ content: [{ providerMetadata: mark, text: "hi", type: "text" }], role: "user" }])).toEqual([]);
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

    it("treats what a server reached over SSH returned as device output", () => {
        // A host is a device of its own, so its tools carry the same `device_<tag>__` name.
        expect(computeTaint([{ content: [{ toolName: "device_9f3k2a__shell_run", type: "tool-result" }], role: "tool" }])).toEqual(["device"]);
    });

    it("ignores a tool CALL (only results carry content)", () => {
        expect(computeTaint([{ content: [{ toolName: "webSearch", type: "tool-call" }], role: "assistant" }])).toEqual([]);
    });

    it("treats a missing message list as clean", () => {
        expect(computeTaint(undefined)).toEqual([]);
    });

    it("carries what a goal round read onto the instruction that opens the next one", () => {
        const text = buildGoalContinuationPrompt({ goal: "g", reason: "r", taintedBy: ["mcp", "web"] });

        expect(computeTaint([{ content: [{ text, type: "text" }], role: "user" }])).toEqual(["web", "mcp"]);
        expect(computeTaint([{ content: text, role: "user" }])).toEqual(["web", "mcp"]);
    });

    it("reads only known sources from a note, and not from an assistant message", () => {
        const text = buildGoalContinuationPrompt({ goal: "g", reason: "r", taintedBy: ["bogus", "device"] });

        expect(computeTaint([{ content: text, role: "user" }])).toEqual(["device"]);
        expect(computeTaint([{ content: text, role: "assistant" }])).toEqual([]);
    });
});

describe("mergeTaint", () => {
    it("unions lists into the stable order, once each", () => {
        expect(mergeTaint(["files", "web"], ["mcp", "web"], undefined)).toEqual(["web", "mcp", "files"]);
    });

    it("is empty for nothing", () => {
        expect(mergeTaint()).toEqual([]);
    });
});
