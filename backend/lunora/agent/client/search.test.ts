import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { fetchRecentAndSearchMessages } from "./search";

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
