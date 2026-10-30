/**
 * The context the agent is handed for a long thread: the summary of the older
 * turns, then the recent rows, then the prompt — and today's context when the
 * summary does not apply.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { fetchContextWithPrompt } from "./search";

const row = (id: string, order: number, role: "assistant" | "user", text: string) => {
    return {
        _creationTime: order,
        _id: id,
        message: { content: text, role },
        order,
        status: "success",
        stepOrder: 0,
        text,
        threadId: "thread-1",
        tool: false,
    };
};

const RECENT = [row("m1", 1, "user", "first recent"), row("m2", 2, "assistant", "second recent"), row("m3", 3, "user", "the prompt")];

const contextFor = async (summary: string | null, options: { recentMessages?: number; statelessMode?: boolean } = {}) => {
    const runQuery = vi.fn(async (ref: unknown) => {
        if (ref === internal.agent.thread_summaries.getThreadSummaryForContext) {
            return summary;
        }

        if (ref === internal.agent.branches.getContextPathIds) {
            return null;
        }

        return { page: [...RECENT].toReversed() };
    });
    const { statelessMode, ...contextOptions } = options;
    const { messages } = await fetchContextWithPrompt(
        { runQuery, storage: {} } as never,
        {} as never,
        {
            contextOptions,
            messages: undefined,
            prompt: undefined,
            promptMessageId: "m3",
            statelessMode,
            threadId: "thread-1",
            userId: "user-1",
        } as never,
    );

    return { messages, runQuery };
};

const texts = (messages: { content: unknown }[]) =>
    messages.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));

describe("fetchContextWithPrompt with a thread summary", () => {
    it("puts the summary ahead of the recent rows, then the recent rows, then the prompt, in order", async () => {
        expect.assertions(5);

        const { messages, runQuery } = await contextFor("The user is planning a trip to Lisbon.");
        const all = texts(messages as never);

        expect(all).toHaveLength(4);
        expect(all[0]).toContain("The user is planning a trip to Lisbon.");
        expect(all.slice(1)).toStrictEqual(["first recent", "second recent", "the prompt"]);
        expect(runQuery).toHaveBeenCalledWith(internal.agent.thread_summaries.getThreadSummaryForContext, { promptMessageId: "m3", threadId: "thread-1" });
        // It is labelled so the model reads it as background, in the role the compressor uses.
        expect((messages as { role: string }[])[0]?.role).toBe("user");
    });

    it("leaves today's context alone when there is no summary for this path", async () => {
        expect.assertions(1);

        const { messages } = await contextFor(null);

        expect(texts(messages as never)).toStrictEqual(["first recent", "second recent", "the prompt"]);
    });

    it("does not look for one when the recent window is smaller than the one the summary was made for", async () => {
        expect.assertions(2);

        const { messages, runQuery } = await contextFor("A summary", { recentMessages: 20 });

        expect(texts(messages as never)).toHaveLength(3);
        expect(runQuery).not.toHaveBeenCalledWith(internal.agent.thread_summaries.getThreadSummaryForContext, expect.anything());
    });

    it("carries on without it when the read fails", async () => {
        expect.assertions(1);

        const runQuery = vi.fn(async (ref: unknown) => {
            if (ref === internal.agent.thread_summaries.getThreadSummaryForContext) {
                throw new Error("shard busy");
            }

            return ref === internal.agent.branches.getContextPathIds ? null : { page: [...RECENT].toReversed() };
        });
        const { messages } = await fetchContextWithPrompt(
            { runQuery, storage: {} } as never,
            {} as never,
            {
                contextOptions: {},
                messages: undefined,
                prompt: undefined,
                promptMessageId: "m3",
                threadId: "thread-1",
                userId: "user-1",
            } as never,
        );

        expect(texts(messages as never)).toStrictEqual(["first recent", "second recent", "the prompt"]);
    });
});
