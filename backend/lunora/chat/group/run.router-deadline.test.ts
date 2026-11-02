/**
 * The router's model filter rules read shares the routing deadline: a read that never answers must fall back to
 * the rotation (an empty list) rather than stall the turn.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { routeSpeakers } from "./run";

afterEach(() => {
    vi.useRealTimers();
});

describe("routeSpeakers", () => {
    it("falls back to the rotation when the rules read never answers", async () => {
        vi.useFakeTimers();

        const participants = [
            { name: "A", skillId: "a" },
            { name: "B", skillId: "b" },
        ];
        const result = routeSpeakers({
            gateway: (async () => new Response("{}")) as never,
            history: [],
            loadRules: async () => await new Promise(() => {}),
            participants: participants as never,
            threadId: "t",
            userId: "u",
        });

        await vi.advanceTimersByTimeAsync(16_000);

        await expect(result).resolves.toEqual([]);
    });
});
