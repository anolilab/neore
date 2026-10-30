import { describe, expect, it } from "vitest";

import type { ToolProgressEvent } from "./stream-line";
import type { ToolProgressState } from "./tool-progress";
import { applyToolProgress, NO_TOOL_PROGRESS, progressFraction } from "./tool-progress";

const event = (toolCallId: string, extra: Partial<ToolProgressEvent> = {}): ToolProgressEvent => {
    return { progress: 1, serverName: "Docs", toolCallId, toolName: "index", ...extra };
};

/** The state after the stream delivered `events` in order. */
const play = (events: ToolProgressEvent[]): ToolProgressState => {
    let state = NO_TOOL_PROGRESS;

    for (const next of events) {
        state = applyToolProgress(state, next);
    }

    return state;
};

describe(applyToolProgress, () => {
    it("keeps only the latest report of a call", () => {
        const state = play([event("a", { progress: 1, total: 10 }), event("a", { message: "Now", progress: 4, total: 10 })]);

        expect(state).toStrictEqual([{ message: "Now", progress: 4, serverName: "Docs", toolCallId: "a", toolName: "index", total: 10 }]);
    });

    it("drops the message a later report no longer carries", () => {
        const state = play([event("a", { message: "Reading" }), event("a", { progress: 2 })]);

        expect(state[0]).not.toHaveProperty("message");
    });

    it("tracks calls side by side, in the order they first reported", () => {
        const state = play([event("a"), event("b"), event("a", { progress: 5 })]);

        expect(state.map((entry) => [entry.toolCallId, entry.progress])).toStrictEqual([
            ["a", 5],
            ["b", 1],
        ]);
    });

    it("removes a call when it ends, and ignores the end of one it never saw", () => {
        const running = play([event("a"), event("b")]);

        expect(applyToolProgress(running, event("a", { ended: true })).map((entry) => entry.toolCallId)).toStrictEqual(["b"]);
        expect(applyToolProgress(running, event("zzz", { ended: true }))).toBe(running);
    });
});

describe(progressFraction, () => {
    it("is progress over total, clamped to 0..1", () => {
        expect(progressFraction({ progress: 25, total: 100 })).toBe(0.25);
        expect(progressFraction({ progress: 150, total: 100 })).toBe(1);
        expect(progressFraction({ progress: 0, total: 100 })).toBe(0);
    });

    it("is undefined (indeterminate) without a usable total", () => {
        expect(progressFraction({ progress: 3 })).toBeUndefined();
        expect(progressFraction({ progress: 3, total: 0 })).toBeUndefined();
        expect(progressFraction({ progress: 3, total: NaN })).toBeUndefined();
    });
});
