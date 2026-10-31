/**
 * What the model is actually handed when a thread has a summary: the agent's own
 * instructions AND the notes, in the one system prompt that reaches the model call.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import startGeneration from "./start";

const ROWS = [
    {
        _creationTime: 1,
        _id: "m1",
        message: { content: "the prompt", role: "user" },
        order: 1,
        status: "success",
        stepOrder: 0,
        text: "the prompt",
        threadId: "thread-1",
        tool: false,
    },
];

const MODEL = { modelId: "test-model", provider: "test", specificationVersion: "v3" };

const start = async (summary: string | null, system: string | undefined) => {
    const runQuery = vi.fn(async (ref: unknown) => {
        if (ref === internal.agent.thread_summaries.getThreadSummaryForContext) {
            return summary;
        }

        return ref === internal.agent.branches.getContextPathIds ? null : { page: ROWS };
    });
    const { args } = await startGeneration(
        { runQuery, storage: {} } as never,
        {} as never,
        { model: MODEL, promptMessageId: "m1", system } as never,
        { agentName: "agent", storageOptions: { saveMessages: "none" }, threadId: "thread-1", userId: "user-1" } as never,
    );

    return args as { messages: { role: string }[]; system?: string };
};

describe("startGeneration with a thread summary", () => {
    it("puts the agent's instructions and the notes in one system prompt, instructions first", async () => {
        expect.assertions(4);

        const args = await start("The user is planning a trip.", "BASE INSTRUCTIONS");

        expect(args.system?.startsWith("BASE INSTRUCTIONS")).toBe(true);
        expect(args.system).toContain("<thread_notes>");
        expect(args.system).toContain("The user is planning a trip.");
        // Never among the messages: AI SDK 7 refuses a system message there, and a user one would pass for the user's words.
        expect(args.messages.map((message) => message.role)).toStrictEqual(["user"]);
    });

    it("keeps the notes when the agent has no instructions of its own", async () => {
        expect.assertions(1);

        const args = await start("Notes.", undefined);

        expect(args.system).toContain("Notes.");
    });

    it("leaves the system prompt exactly as it was without a summary", async () => {
        expect.assertions(2);

        const withBase = await start(null, "BASE INSTRUCTIONS");
        const without = await start(null, undefined);

        expect(withBase.system).toBe("BASE INSTRUCTIONS");
        expect(without.system).toBeUndefined();
    });
});
