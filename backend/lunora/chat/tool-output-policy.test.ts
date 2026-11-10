import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FIRST_PAINT_TOOL_NAMES, isOutputInline, isTrimmableToolOutput, TOOL_OUTPUT_INLINE_BYTES } from "./tool-output-policy";
import { trimToolOutputs, toolResultRowIds } from "./tool-output-trim";

const repoFile = (path: string): string => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../..", path), "utf8");

/** The names inside a `const NAME = { … };` or `new Set([ … ])` block, found by their literal keys or strings. */
const blockNames = (source: string, startPattern: RegExp, keyPattern: RegExp): string[] => {
    const start = source.search(startPattern);

    if (start < 0) {
        return [];
    }

    const end = source.includes("\n};", start) ? source.indexOf("\n};", start) : source.indexOf("]);", start);

    return [...source.slice(start, end).matchAll(keyPattern)].map((match) => match[1] as string);
};

const big = "x".repeat(TOOL_OUTPUT_INLINE_BYTES + 1);
const part = (type: string, extra: Record<string, unknown> = {}) => ({ state: "output-available", type, ...extra });

describe("tool output policy", () => {
    it("keeps the output of a tool whose own view reads it, whatever its size", () => {
        expect(isOutputInline(part("tool-askUser"))).toBe(true);
        expect(isOutputInline(part("tool-codeExecution"))).toBe(true);
        expect(isOutputInline(part("tool-weather"))).toBe(true);
        expect(isOutputInline(part("tool-device_ab12__read_file"))).toBe(true);
        expect(isOutputInline(part("tool-mcp_Files__list"))).toBe(true);
        expect(isOutputInline(part("tool-anything", { callProviderMetadata: { neore: { mcpServerName: "Files" } } }))).toBe(true);
    });

    it("trims a large output of a generic tool, and keeps a small one inline", () => {
        expect(isTrimmableToolOutput(part("tool-docs_search"), big)).toBe(true);
        expect(isTrimmableToolOutput(part("tool-docs_search"), "small")).toBe(false);
    });

    it("never trims a part that is not a finished tool result", () => {
        expect(isTrimmableToolOutput(part("text"), big)).toBe(false);
        expect(isTrimmableToolOutput({ state: "input-available", type: "tool-docs_search" }, big)).toBe(false);
    });

    it("trims the output but keeps the part, its state and a ref to fetch the output back", () => {
        const ids = toolResultRowIds([
            { _id: "row-result", message: { content: [{ output: { type: "text", value: big }, toolCallId: "call-1", type: "tool-result" }] } },
        ]);
        const message = { id: "m1", parts: [{ input: {}, output: big, state: "output-available", toolCallId: "call-1", type: "tool-docs_search" }] };

        const [trimmed] = trimToolOutputs([message] as never, "thread-1", ids);
        const [trimmedPart] = (trimmed as { parts: Array<Record<string, unknown>> }).parts;

        expect(trimmedPart).toMatchObject({
            outputRef: { messageId: "row-result", threadId: "thread-1", toolCallId: "call-1" },
            state: "output-available",
            type: "tool-docs_search",
        });
        expect(trimmedPart?.["output"]).toBeUndefined();
    });

    it("keeps the output when no result row is known for the call", () => {
        const message = { id: "m1", parts: [{ input: {}, output: big, state: "output-available", toolCallId: "call-9", type: "tool-docs_search" }] };

        expect(trimToolOutputs([message] as never, "thread-1", new Map())).toStrictEqual([message]);
    });

    it("names every tool a renderer reads output for, so a new view cannot silently lose its output", () => {
        // Names are read from the renderers' own registries and sets, so adding a view there fails this test until the policy lists it.
        const viewNames = blockNames(repoFile("apps/web/src/features/chat/thread/message-content.tsx"), /const TOOL_VIEWS/u, /^\s{4}(\w+):/gmu);
        const widgetNames = blockNames(repoFile("apps/web/src/features/chat/thread/widgets/index.tsx"), /const TOOL_WIDGETS/u, /^\s{4}(\w+):/gmu);
        const chatUiTypes = [...repoFile("packages/chat-ui/src/chat/message-content.tsx").matchAll(/"tool-(\w+)"/gu)].map((match) => match[1] as string);
        const sandboxTypes = [...repoFile("packages/chat-ui/src/utils/sandbox-files.ts").matchAll(/"tool-(\w+)"/gu)].map((match) => match[1] as string);

        const unlisted = [...viewNames, ...widgetNames, ...chatUiTypes, ...sandboxTypes].filter((name) => !FIRST_PAINT_TOOL_NAMES.has(name));

        expect(viewNames.length).toBeGreaterThan(0);
        expect(widgetNames.length).toBeGreaterThan(0);
        expect(unlisted).toStrictEqual([]);
    });
});
