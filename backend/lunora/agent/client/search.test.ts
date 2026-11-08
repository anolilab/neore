import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { agentSwitchRowContent } from "../agent-switch-logic";
import { composeHandoff } from "../handoff";
import { fetchContextWithPrompt, fetchRecentAndSearchMessages } from "./search";

const message = (id: string, order: number) => {
    return {
        _creationTime: order,
        _id: id,
        order,
        parts: [{ text: id, type: "text" }],
        role: "user",
        stepOrder: 0,
        threadId: "thread-1",
    };
};

describe("fetchRecentAndSearchMessages", () => {
    it("issues the branch-path read and the recent read together, then filters the page to the path", async () => {
        const runQuery = vi.fn(async (ref: unknown) => {
            if (ref === internal.agent.branches.getContextPathIds) {
                return ["m1"];
            }

            return { page: [message("m2", 2), message("m1", 1)] };
        });

        const pending = fetchRecentAndSearchMessages({ runQuery } as never, {} as never, {
            contextOptions: { recentMessages: 5 },
            targetMessageId: "m1",
            threadId: "thread-1",
            userId: "user-1",
        });

        // The function yields only after both reads are issued.
        expect(runQuery).toHaveBeenCalledTimes(2);

        const { recentMessages } = await pending;

        expect(recentMessages.map((m) => m._id)).toEqual(["m1"]);
    });
});

describe("fetchContextWithPrompt after a portable switch", () => {
    const handoff = composeHandoff({ kind: "portable", summary: "Earlier the user set up a build.", tail: [{ role: "user", text: "fix the build" }] });
    const row = (id: string, order: number, stepOrder: number, role: "assistant" | "user", content: string) => {
        return { _id: id, message: { content, role }, order, status: "success", stepOrder, threadId: "thread-1" };
    };
    const divider = {
        _id: "d1",
        order: 2,
        status: "success",
        stepOrder: 0,
        threadId: "thread-1",
        ...agentSwitchRowContent({ from: { kind: "model", model: "a" }, handoff, mode: "portable", startMessageId: "a1", to: { kind: "model", model: "b" } }),
    };
    const history = [
        row("u0", 0, 0, "user", "old question"),
        row("a0", 0, 1, "assistant", "old answer"),
        row("u1", 1, 0, "user", "fix the build"),
        row("a1", 1, 1, "assistant", "done"),
        divider,
    ];

    /** The messages a model gets for the turn that answers `promptId`, given the rows saved so far (newest first, as the read returns them). */
    const contextFor = async (rows: unknown[], promptId: string) => {
        const runQuery = vi.fn(async (ref: unknown) => {
            if (ref === internal.agent.branches.getContextPathIds) {
                return null;
            }

            if (ref === internal.agent.files.getStorageKeys || ref === internal.agent.files.getOwnedStorageKeys) {
                return {};
            }

            if (ref === internal.agent.context_reset_read.getContextReset) {
                return null;
            }

            if (ref === internal.agent.thread_summaries.getThreadSummaryForContext) {
                return null;
            }

            return { page: rows.toReversed() };
        });
        const { messages } = await fetchContextWithPrompt(
            { runQuery } as never,
            {} as never,
            {
                contextOptions: {},
                messages: undefined,
                prompt: undefined,
                promptMessageId: promptId,
                threadId: "thread-1",
                userId: "user-1",
            } as never,
        );

        return messages;
    };

    it("sends the stored handoff first, then only the turns after the switch, with the same bytes on every later turn", async () => {
        const turn1 = [...history, row("u2", 3, 0, "user", "next question")];
        const turn3 = [
            ...turn1,
            row("a2", 3, 1, "assistant", "r1"),
            row("u3", 4, 0, "user", "q2"),
            row("a3", 4, 1, "assistant", "r2"),
            row("u4", 5, 0, "user", "q3"),
        ];
        const first = await contextFor(turn1, "u2");
        const third = await contextFor(turn3, "u4");

        expect(first.map((m) => m.role)).toStrictEqual(["user", "user"]);
        expect(first[0]!.content).toBe(handoff);
        expect(first[1]!.content).toBe("next question");
        expect(JSON.stringify(first[0])).not.toContain("old question");
        expect(third[0]).toStrictEqual(first[0]);
        expect(Buffer.from(third[0]!.content as string).equals(Buffer.from(handoff))).toBe(true);
        expect(third.slice(1).map((m) => m.content)).toStrictEqual(["next question", "r1", "q2", "r2", "q3"]);
    });
});

describe("fetchContextWithPrompt after a switch back whose earlier divider has left the window", () => {
    const first = composeHandoff({ kind: "portable", tail: [{ role: "user", text: "the model A era" }] });
    const delta = composeHandoff({ kind: "delta", tail: [{ role: "user", text: "what model B did" }] });
    const row = (id: string, order: number, stepOrder: number, role: "assistant" | "user", content: string) => {
        return { _id: id, message: { content, role }, order, status: "success", stepOrder, threadId: "thread-1" };
    };
    const back = {
        _id: "d2",
        order: 5,
        status: "success",
        stepOrder: 0,
        threadId: "thread-1",
        ...agentSwitchRowContent({
            from: { kind: "model", model: "b" },
            handoff: delta,
            mode: "delta",
            startMessageId: "a2",
            to: { kind: "model", model: "a" },
        }),
    };

    const contextFor = async (rows: unknown[], promptId: string, above: string[]) => {
        const runQuery = vi.fn(async (ref: unknown) => {
            if (ref === internal.agent.branches.getContextPathIds) {
                return null;
            }

            if (ref === internal.agent.files.getStorageKeys || ref === internal.agent.files.getOwnedStorageKeys) {
                return {};
            }

            if (ref === internal.agent.context_reset_read.getContextReset) {
                return null;
            }

            if (ref === internal.agent.thread_summaries.getThreadSummaryForContext) {
                return null;
            }

            if (ref === internal.agent.agent_switch.getHandoffAbove) {
                return above;
            }

            if (ref === internal.agent.agent_switch.getHandoffBeforeDelta) {
                return [first];
            }

            return { page: rows.toReversed() };
        });
        const { messages } = await fetchContextWithPrompt(
            { runQuery } as never,
            {} as never,
            { contextOptions: {}, messages: undefined, prompt: undefined, promptMessageId: promptId, threadId: "thread-1", userId: "user-1" } as never,
        );

        return messages;
    };

    it("sends what the model saw, then what it missed, and the same bytes on every later turn", async () => {
        const turn1 = [row("u2", 3, 0, "user", "b question"), row("a2", 3, 1, "assistant", "b answer"), back, row("u3", 6, 0, "user", "back on a")];
        const turn2 = [...turn1, row("a3", 6, 1, "assistant", "reply"), row("u4", 7, 0, "user", "and more")];
        const one = await contextFor(turn1, "u3", []);
        const two = await contextFor(turn2, "u4", []);

        expect(one.map((m) => m.content)).toStrictEqual([first, delta, "back on a"]);
        expect(two.slice(0, 2)).toStrictEqual(one.slice(0, 2));
        // One breakpoint across the handoffs: the gateway adds two of its own, and four is the limit.
        expect(one.filter((m) => m.providerOptions !== undefined)).toHaveLength(1);
    });

    it("keeps both handoffs once the delta divider has slid out too", async () => {
        const rows = [row("u3", 6, 0, "user", "back on a"), row("a3", 6, 1, "assistant", "reply"), row("u4", 7, 0, "user", "and more")];
        const messages = await contextFor(rows, "u4", [first, delta]);

        expect(messages.map((m) => m.content)).toStrictEqual([first, delta, "back on a", "reply", "and more"]);
    });
});

describe("fetchContextWithPrompt from a run's own first turn (fromOrder)", () => {
    it("sends a fresh-context run's continuation no turn from before the run's prompt", async () => {
        const row = (id: string, order: number, stepOrder: number, role: "assistant" | "user", content: string) => {
            return { _id: id, message: { content, role }, order, status: "success", stepOrder, threadId: "thread-1" };
        };
        const rows = [
            row("u0", 0, 0, "user", "earlier turn"),
            row("a0", 0, 1, "assistant", "earlier answer"),
            row("u1", 1, 0, "user", "the run's task"),
            row("u2", 2, 0, "user", "go on"),
        ];
        const runQuery = vi.fn(async (ref: unknown) => {
            if (ref === internal.agent.branches.getContextPathIds || ref === internal.agent.thread_summaries.getThreadSummaryForContext) {
                return null;
            }

            if (ref === internal.agent.context_reset_read.getContextReset) {
                return null;
            }

            if (ref === internal.agent.files.getStorageKeys || ref === internal.agent.files.getOwnedStorageKeys) {
                return {};
            }

            if (ref === internal.agent.agent_switch.getHandoffAbove) {
                return [];
            }

            return { page: rows.toReversed() };
        });
        const { messages } = await fetchContextWithPrompt(
            { runQuery } as never,
            {} as never,
            {
                contextOptions: { fromOrder: 1 },
                messages: undefined,
                prompt: undefined,
                promptMessageId: "u2",
                threadId: "thread-1",
                userId: "user-1",
            } as never,
        );

        expect(messages.map((m) => (m as { content: unknown }).content)).toStrictEqual(["the run's task", "go on"]);
        // A switch's handoff from before the run's prompt is not looked up either.
        expect(runQuery).toHaveBeenCalledWith(internal.agent.agent_switch.getHandoffAbove, expect.objectContaining({ fromOrder: 1 }));
    });

    it("drops this thread's search hits from before the run's prompt, and keeps another thread's", async () => {
        const hit = (id: string, threadId: string, content: string) => {
            return { _id: id, message: { content, role: "assistant" }, order: 0, status: "success", stepOrder: 1, threadId };
        };
        const runQuery = vi.fn(async (ref: unknown) => {
            if (ref === internal.agent.files.getStorageKeys || ref === internal.agent.files.getOwnedStorageKeys) {
                return {};
            }

            if (ref === internal.agent.thread_summaries.getThreadSummaryForContext || ref === internal.agent.context_reset_read.getContextReset) {
                return null;
            }

            if (ref === internal.agent.agent_switch.getHandoffAbove) {
                return [];
            }

            // No window rows: only the search hits reach the model.
            return { page: [] };
        });
        const runAction = vi.fn(async () => [hit("own", "thread-1", "an earlier turn of this thread"), hit("other", "thread-2", "another chat")]);
        const { messages } = await fetchContextWithPrompt(
            { runAction, runQuery } as never,
            {} as never,
            {
                contextOptions: { fromOrder: 1, searchOptions: { limit: 5, textSearch: true } },
                messages: undefined,
                prompt: "find it",
                promptMessageId: undefined,
                threadId: "thread-1",
                userId: "user-1",
            } as never,
        );

        expect((messages as { content: unknown }[]).map((m) => m.content)).toStrictEqual(["another chat", "find it"]);
    });
});

describe("fetchContextWithPrompt after a context reset (/clear)", () => {
    const row = (id: string, order: number, stepOrder: number, role: "assistant" | "user", content: string) => {
        return { _id: id, message: { content, role }, order, status: "success", stepOrder, threadId: "thread-1" };
    };
    // The reset row is an empty system row: nothing in the context, and the rows after it start the model's turns again.
    const reset = { _id: "reset", message: { content: "", role: "system" }, order: 1, status: "success", stepOrder: 0, threadId: "thread-1" };
    const rows = [row("u0", 0, 0, "user", "old question"), row("a0", 0, 1, "assistant", "old answer"), reset, row("u1", 2, 0, "user", "new question")];

    it("sends the model no turn from before the reset, only the turns written after it", async () => {
        const runQuery = vi.fn(async (ref: unknown) => {
            if (ref === internal.agent.branches.getContextPathIds) {
                return null;
            }

            if (ref === internal.agent.files.getStorageKeys || ref === internal.agent.files.getOwnedStorageKeys) {
                return {};
            }

            if (ref === internal.agent.thread_summaries.getThreadSummaryForContext) {
                return null;
            }

            if (ref === internal.agent.context_reset_read.getContextReset) {
                return { branched: false, order: reset.order };
            }

            return { page: rows.toReversed() };
        });
        const { messages } = await fetchContextWithPrompt(
            { runQuery } as never,
            {} as never,
            { contextOptions: {}, messages: undefined, prompt: undefined, promptMessageId: "u1", threadId: "thread-1", userId: "user-1" } as never,
        );

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ content: "new question", role: "user" });
    });

    it.each([
        [true, ["sibling answer", "new question", "find it"]],
        [false, ["new question", "find it"]],
    ])(
        "keeps a same-thread hit from below the reset only when the thread is branched and the prompt is not named (branched: %s)",
        async (branched, expected) => {
            const sibling = row("s0", 0, 2, "assistant", "sibling answer");
            const runQuery = vi.fn(async (ref: unknown) => {
                if (ref === internal.agent.files.getStorageKeys || ref === internal.agent.files.getOwnedStorageKeys) {
                    return {};
                }

                if (ref === internal.agent.thread_summaries.getThreadSummaryForContext) {
                    return null;
                }

                if (ref === internal.agent.context_reset_read.getContextReset) {
                    return { branched, order: reset.order };
                }

                if (ref === internal.agent.agent_switch.getHandoffAbove) {
                    return [];
                }

                return { page: rows.toReversed() };
            });
            const runAction = vi.fn(async () => [sibling]);
            const { messages } = await fetchContextWithPrompt(
                { runAction, runQuery } as never,
                {} as never,
                {
                    contextOptions: { searchOptions: { limit: 5, textSearch: true } },
                    messages: undefined,
                    prompt: "find it",
                    promptMessageId: undefined,
                    threadId: "thread-1",
                    userId: "user-1",
                } as never,
            );

            expect(
                (messages as { content: unknown }[]).map((entry) => (typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content))),
            ).toStrictEqual(expected);
        },
    );
});
