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
