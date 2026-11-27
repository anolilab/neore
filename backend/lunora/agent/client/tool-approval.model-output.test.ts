/**
 * An approved call's row keeps what the tool returned, and the model is given the tool's own view of it
 * (`toModelOutput`), on the approval's continuation and on every later turn, as it is for a step's own result.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { builtInToolNamed } from "../../chat/lib/tool-builder";
import browserTool from "../../chat/tools/browser";
import { textTranslateTool } from "../../chat/tools/text-translate";
import toonEncodeOutput from "../../chat/tools/toon-encode";
import startGeneration from "./start";
import { approveToolCallFor } from "./tool-approval";

const MODEL = { modelId: "test-model", provider: "test", specificationVersion: "v3" };

const SCREENSHOT = "iVBORw0KGgo=";
const BROWSER_RESULT = {
    humanCheck: { browserId: "browser-1", checkId: "check-1", run: "reply-1", site: "shop.example.com", status: "asked" },
    screenshot: SCREENSHOT,
    screenshotFormat: "png",
    success: true,
    title: "Checkout",
    url: "https://shop.example.com/",
};
const TRANSLATE_RESULT = {
    translationRequest: { sourceLanguageName: "German", targetLanguageName: "English", text: "Guten Tag" },
};

interface Case {
    input: Record<string, unknown>;
    name: string;
    result: Record<string, unknown>;
    tool: Record<string, unknown>;
}

const CASES: Case[] = [
    { input: { action: "click", selector: "#buy" }, name: "browser", result: BROWSER_RESULT, tool: browserTool as never },
    { input: { targetLanguage: "en", text: "Guten Tag" }, name: "textTranslate", result: TRANSLATE_RESULT, tool: textTranslateTool as never },
];

/** A tool whose model output is TOON text, like the site-login and pull-request tools: converting that text again changes it. */
const TOON_CASE: Case = {
    input: { number: 7 },
    name: "pullRequest",
    result: { pullRequest: { number: 7, title: "Fix it" }, success: true },
    tool: { toModelOutput: ({ output }: { output: unknown }) => toonEncodeOutput(output) },
};

const row = (id: string, order: number, stepOrder: number, message: unknown) => {
    return { _creationTime: order * 10 + stepOrder, _id: id, message, order, status: "success", stepOrder, threadId: "thread-1", tool: false };
};

/** Approves the pending call, and returns the tool row it saved plus the thread's rows up to it. */
const approve = async ({ input, name, result, tool }: Case) => {
    const callRow = row("m2", 1, 1, {
        content: [
            { input, toolCallId: "call-1", toolName: name, type: "tool-call" },
            { approvalId: "approval-1", toolCallId: "call-1", type: "tool-approval-request" },
        ],
        role: "assistant",
    });
    const tools = { [name]: { ...tool, execute: vi.fn(async () => result) } };
    let saved: unknown;
    const agent = {
        getThreadMetadata: vi.fn(async () => {
            return { userId: "user-1" };
        }),
        listMessages: vi.fn(async () => {
            return { continueCursor: null, isDone: true, page: [callRow] };
        }),
        options: { tools },
        saveMessage: vi.fn(async (_context: unknown, args: { message: unknown }) => {
            saved = args.message;

            return { messageId: "m3" };
        }),
        streamText: vi.fn(async () => {
            return {};
        }),
    };

    await approveToolCallFor(agent as never, {} as never, { threadId: "thread-1", userId: "user-1" }, { approvalId: "approval-1" });

    const rows = [row("m1", 1, 0, { content: "buy it", role: "user" }), callRow, row("m3", 1, 2, saved)];

    return { rows, saved: saved as { content: { output?: unknown; type: string }[] }, tools };
};

/** The messages a run hands the model for `promptMessageId`, reading `rows`. */
const modelMessages = async (rows: unknown[], promptMessageId: string, tools: Record<string, unknown>) => {
    const runQuery = vi.fn(async (ref: unknown) => {
        if (ref === internal.agent.context_reset_read.getContextReset || ref === internal.agent.thread_summaries.getThreadSummaryForContext) {
            return null;
        }

        if (ref === internal.agent.branches.getMaxOrder) {
            return 1;
        }

        if (ref === internal.agent.agent_switch.getHandoffAbove) {
            return [];
        }

        return ref === internal.agent.branches.getContextPathIds ? null : { page: rows };
    });
    const { args } = await startGeneration(
        { runQuery, storage: {} } as never,
        {} as never,
        { model: MODEL, promptMessageId, tools } as never,
        {
            agentName: "agent",
            // As `chat/lib/get-agent.ts` hands every agent.
            builtInToolFormatter: async (name: string) => builtInToolNamed(name),
            storageOptions: { saveMessages: "none" },
            threadId: "thread-1",
            userId: "user-1",
        } as never,
    );

    return (args as { messages: { content: unknown; role: string }[] }).messages;
};

const toolOutput = (messages: { content: unknown; role: string }[]) => {
    const parts = messages.flatMap((message) => (message.role === "tool" ? (message.content as { output?: unknown; type: string }[]) : []));

    return parts.find((part) => part.type === "tool-result")?.output;
};

describe("an approved call's result", () => {
    it.each(CASES)("keeps the $name tool's raw result in the saved row", async (testCase) => {
        expect.assertions(1);

        const { saved } = await approve(testCase);

        expect(saved.content.find((part) => part.type === "tool-result")).toMatchObject({
            output: { type: "json", value: testCase.result },
            providerOptions: { neore: { rawToolResult: true } },
        });
    });

    it.each([...CASES, TOON_CASE])("reaches the model as saved when the $name row was approved before results were saved raw", async (testCase) => {
        expect.assertions(1);

        const { rows, tools } = await approve(testCase);
        // A row approved earlier holds the tool's model output already, and no mark.
        const modelOutput = await (testCase.tool as { toModelOutput: (options: unknown) => unknown }).toModelOutput({
            input: testCase.input,
            output: testCase.result,
            toolCallId: "call-1",
        });
        const legacy = rows.map((entry) => {
            if (entry._id !== "m3") {
                return entry;
            }

            const message = entry.message as { content: Record<string, unknown>[]; role: string };
            const content = message.content.map((part) => {
                if (part.type !== "tool-result") {
                    return part;
                }

                return { input: part.input, output: modelOutput, toolCallId: part.toolCallId, toolName: part.toolName, type: part.type };
            });

            return { ...entry, message: { ...message, content } };
        });

        expect(toolOutput(await modelMessages(legacy, "m3", tools))).toStrictEqual(modelOutput);
    });

    it.each([...CASES, TOON_CASE])("reaches the model as the $name tool's model output on the continuation and on a later turn", async (testCase) => {
        expect.assertions(2);

        const { rows, tools } = await approve(testCase);
        const expected = await (testCase.tool as { toModelOutput: (options: unknown) => unknown }).toModelOutput({
            input: testCase.input,
            output: testCase.result,
            toolCallId: "call-1",
        });

        const continuation = await modelMessages(rows, "m3", tools);
        const later = await modelMessages([...rows, row("m4", 2, 0, { content: "and now?", role: "user" })], "m4", tools);

        expect(toolOutput(continuation)).toStrictEqual(expected);
        expect(toolOutput(later)).toStrictEqual(expected);
    });

    it.each(CASES)("reaches the model as the $name tool's model output on a call that offers no tools", async (testCase) => {
        expect.assertions(1);

        const { rows } = await approve(testCase);
        const expected = await (testCase.tool as { toModelOutput: (options: unknown) => unknown }).toModelOutput({
            input: testCase.input,
            output: testCase.result,
            toolCallId: "call-1",
        });

        // A cap's wrap-up offers no tools, and a later turn may have the tool switched off: the built-in formats it still.
        expect(toolOutput(await modelMessages(rows, "m3", {}))).toStrictEqual(expected);
    });

    it("reaches the model as the browser tool's model output in a stateless run's explicit messages", async () => {
        expect.assertions(2);

        const { rows, tools } = await approve(CASES[0]!);
        const { args } = await startGeneration(
            { runQuery: vi.fn(), storage: {} } as never,
            {} as never,
            { messages: rows.map((entry) => entry.message), model: MODEL, tools } as never,
            { agentName: "agent", statelessMode: true, storageOptions: { saveMessages: "none" }, threadId: "thread-1", userId: "user-1" } as never,
        );
        const output = toolOutput((args as { messages: { content: unknown; role: string }[] }).messages) as { type: string };

        expect(output.type).toBe("content");
        expect(JSON.stringify(output)).not.toContain("reply-1");
    });

    it("gives the model a screenshot moved to storage as an image from its signed URL, never an unsigned one", async () => {
        expect.assertions(3);

        const stored: Record<string, unknown> = { ...BROWSER_RESULT };

        delete stored["screenshot"];
        const format = (screenshotUrl: string) =>
            (browserTool as unknown as { toModelOutput: (options: unknown) => { type: string; value: unknown } }).toModelOutput({
                input: CASES[0]!.input,
                output: { ...stored, screenshotUrl },
                toolCallId: "call-1",
            });
        const signed = format("https://files.example.com/screenshot.png?signature=abc") as { type: string; value: { type: string; url?: string }[] };

        expect(signed.value[0]).toStrictEqual({ type: "image-url", url: "https://files.example.com/screenshot.png?signature=abc" });
        expect(JSON.stringify(signed)).not.toContain("reply-1");
        // A reference the row's owner does not own is signed to an empty string: no image, only the text.
        expect(format("").type).not.toBe("content");
    });

    it("never shows the model the human check's reply key, and gives it the screenshot as an image", async () => {
        expect.assertions(3);

        const { rows, tools } = await approve(CASES[0]!);
        const output = toolOutput(await modelMessages(rows, "m3", tools)) as { type: string; value: { data?: string; text?: string; type: string }[] };

        expect(output.type).toBe("content");
        expect(output.value[0]).toStrictEqual({ data: SCREENSHOT, mediaType: "image/png", type: "image-data" });
        expect(JSON.stringify(output)).not.toContain("reply-1");
    });
});
