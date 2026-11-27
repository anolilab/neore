import type { MessagePart, ToolPart } from "@neore/chat-ui/types";
import { describe, expect, it } from "vitest";

import type { TurnMessage } from "./turn-announcements";
import { freshToolSteps, inFlightReply, knownToolCalls, REPLY_SNIPPET_MAX_LENGTH, replySnippet, toolCallKey } from "./turn-announcements";

const tool = (toolCallId: string, type = "tool-search", extra: Partial<ToolPart> = {}): MessagePart =>
    ({ state: "input-available", toolCallId, type, ...extra }) as MessagePart;

const text = (value: string): MessagePart => ({ text: value, type: "text" }) as MessagePart;

const message = (id: string, role: string, status: string | undefined, parts: MessagePart[]): TurnMessage => {
    return { id, parts, role, status };
};

describe("replySnippet", () => {
    it("reads a short reply whole, with its whitespace collapsed", () => {
        expect(replySnippet("Hello\n\n  there.")).toBe("Hello there.");
    });

    it("reads no Markdown syntax aloud", () => {
        expect(replySnippet("**Bold** and a [link](https://example.com).")).toBe("Bold and a link.");
    });

    it("cuts a long reply at a word and marks the cut with an ellipsis", () => {
        const snippet = replySnippet(`${"alpha ".repeat(60)}omega`);

        expect(snippet.endsWith("…")).toBe(true);
        expect(snippet.length).toBeLessThanOrEqual(REPLY_SNIPPET_MAX_LENGTH + 1);
        expect(
            snippet
                .slice(0, -1)
                .split(" ")
                .every((word) => word === "alpha" || word === ""),
        ).toBe(true);
    });

    it("never cuts a reply inside an emoji, even when the cut would fall there", () => {
        const snippet = replySnippet(`a${"😀".repeat(250)}`);

        expect(snippet).toBe(`a${"😀".repeat(199)}…`);
    });

    it("reads a long reply with many unmatched brackets as a bounded snippet", () => {
        const snippet = replySnippet("[".repeat(200_000));

        expect(snippet.endsWith("…")).toBe(true);
        expect(snippet.length).toBeLessThanOrEqual(REPLY_SNIPPET_MAX_LENGTH + 1);
    });

    it("reads a long reply with many unmatched backtick runs as a bounded snippet", () => {
        const runs = Array.from({ length: 600 }, (_, index) => `${"`".repeat(600 - index)}x`).join("");
        const snippet = replySnippet(runs);

        expect(snippet.length).toBeLessThanOrEqual(REPLY_SNIPPET_MAX_LENGTH + 1);
    });

    it("reads a link's label when its URL is long, not the URL", () => {
        expect(replySnippet(`[Read the notes](https://example.com/${"a".repeat(5000)}) first.`)).toBe("Read the notes first.");
    });

    it("does not take a literal private-use sequence for a converter placeholder", () => {
        expect(replySnippet("one 0 two")).toBe("one 0 two");
    });

    it("is empty for a reply with no text", () => {
        expect(replySnippet("")).toBe("");
        expect(replySnippet(" ".repeat(3))).toBe("");
    });
});

describe("inFlightReply", () => {
    it("is the newest assistant message while it is still streaming or pending", () => {
        const reply = message("r1", "assistant", "streaming", []);

        expect(inFlightReply([message("u1", "user", undefined, []), reply])).toBe(reply);
        expect(inFlightReply([message("r0", "assistant", "pending", [])])?.id).toBe("r0");
    });

    it("is null once the newest assistant message has settled, or when there is none", () => {
        expect(inFlightReply([message("r1", "assistant", "success", [])])).toBeNull();
        expect(inFlightReply([message("u1", "user", undefined, [])])).toBeNull();
    });

    it("counts a settled newest reply while the turn is still streaming", () => {
        const settled = message("r1", "assistant", "success", []);

        expect(inFlightReply([settled], true)).toBe(settled);
    });

    it("is null for an earlier turn's reply once a new prompt has been sent", () => {
        const messages = [message("u1", "user", undefined, []), message("r1", "assistant", "success", []), message("u2", "user", undefined, [])];

        expect(inFlightReply(messages, true)).toBeNull();
    });
});

describe("knownToolCalls", () => {
    it("collects the key of every tool call in every message, and nothing else", () => {
        const keys = knownToolCalls([
            message("u1", "user", undefined, [text("hi")]),
            message("r1", "assistant", "success", [tool("c1"), text("ok"), tool("c2", "tool-fetch")]),
        ]);

        // The reply belongs to the turn that the user message "u1" starts.
        expect(keys).toEqual(new Set([toolCallKey("u1", "c1"), toolCallKey("u1", "c2")]));
    });

    it("keeps two replies to one prompt apart when their runs differ, though they reuse a call id", () => {
        const keys = knownToolCalls([
            message("u1", "user", undefined, [text("hi")]),
            { ...message("r1", "assistant", "success", [tool("c1")]), replyId: "run-1" },
            { ...message("r2", "assistant", "success", [tool("c1")]), replyId: "run-2" },
        ]);

        expect(keys.size).toBe(2);
    });

    it("keeps a call's identity when one run's rows are merged into a single reply", () => {
        const before = [
            message("u1", "user", undefined, [text("hi")]),
            { ...message("a1", "assistant", "success", [tool("ca")]), replyId: "run-1" },
            { ...message("b1", "assistant", "streaming", [tool("cb")]), replyId: "run-1" },
        ];
        const after = [
            message("u1", "user", undefined, [text("hi")]),
            { ...message("ab", "assistant", "streaming", [tool("ca"), tool("cb")]), replyId: "run-1" },
        ];

        expect(freshToolSteps(after, knownToolCalls(before), true)).toEqual([]);
    });

    it("does not announce a call again when a multi-step turn's live row merges into the saved one", () => {
        const before = [
            message("u1", "user", undefined, [text("hi")]),
            message("a1", "assistant", "success", [tool("ca")]),
            message("b1", "assistant", "streaming", [tool("cb")]),
        ];
        const after = [message("u1", "user", undefined, [text("hi")]), message("ab", "assistant", "streaming", [tool("ca"), tool("cb")])];

        expect(freshToolSteps(after, knownToolCalls(before), true)).toEqual([]);
    });
});

describe("freshToolSteps", () => {
    it("returns the calls of the reply being written that are not known yet, in order", () => {
        const messages = [message("r1", "assistant", "streaming", [tool("c1"), tool("c2", "tool-fetch")])];

        const steps = freshToolSteps(messages, new Set([toolCallKey("r1", "c1")]));

        expect(steps).toEqual([{ key: toolCallKey("r1", "c2"), toolName: "fetch" }]);
    });

    it("says an MCP call by the tool name the backend labelled it with", () => {
        const labelled = tool("c1", "tool-mcp_docs__search_pages", {
            callProviderMetadata: { neore: { mcpServerName: "Docs", mcpToolName: "Search pages" } },
        });

        expect(freshToolSteps([message("r1", "assistant", "streaming", [labelled])], new Set())).toEqual([
            { key: toolCallKey("r1", "c1"), toolName: "Search pages" },
        ]);
    });

    it("says a dynamic-tool call by its toolName, which is how the backend sends MCP calls", () => {
        const dynamic = { state: "input-available", toolCallId: "c1", toolName: "search_pages", type: "dynamic-tool" } as MessagePart;

        expect(freshToolSteps([message("r1", "assistant", "streaming", [dynamic])], new Set())).toEqual([
            { key: toolCallKey("r1", "c1"), toolName: "search_pages" },
        ]);
    });

    it("says a dynamic-tool MCP call by its tool name, not the runtime name, before any label arrives", () => {
        const dynamic = { state: "input-available", toolCallId: "c1", toolName: "mcp_My_Server__list_files", type: "dynamic-tool" } as MessagePart;

        expect(freshToolSteps([message("r1", "assistant", "streaming", [dynamic])], new Set())).toEqual([
            { key: toolCallKey("r1", "c1"), toolName: "list_files" },
        ]);
    });

    it("says a device tool call by the tool's name, as the chat shows it", () => {
        const device = { state: "input-available", toolCallId: "c1", type: "tool-device_a1b2c3__shell_run" } as MessagePart;

        expect(freshToolSteps([message("r1", "assistant", "streaming", [device])], new Set())).toEqual([
            { key: toolCallKey("r1", "c1"), toolName: "shell_run" },
        ]);
    });

    it("finds nothing once the reply has settled, so history is never news", () => {
        const settled = [message("r1", "assistant", "success", [tool("c1")])];

        expect(freshToolSteps(settled, new Set())).toEqual([]);
    });

    it("finds a call in a settled reply while the turn is still streaming", () => {
        const settled = [message("r1", "assistant", "success", [tool("c1")])];

        expect(freshToolSteps(settled, new Set(), true)).toEqual([{ key: toolCallKey("r1", "c1"), toolName: "search" }]);
    });

    it("treats a call id reused in a later reply as a new call", () => {
        const messages = [message("r2", "assistant", "streaming", [tool("c1")])];

        const steps = freshToolSteps(messages, new Set([toolCallKey("r1", "c1")]));

        expect(steps).toEqual([{ key: toolCallKey("r2", "c1"), toolName: "search" }]);
    });
});
