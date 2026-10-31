/** The measurement behind the child buffer's budget (`child-buffer.ts`). */
import { describe, expect, it } from "vitest";

import { measureChildBuffer, updatesBySession } from "./child-buffer";

const stamped = (value: string, parent: string) => {
    return { _meta: { claudeCode: { parentToolUseId: parent } }, content: { text: value, type: "text" }, sessionUpdate: "agent_message_chunk" };
};

const spawn = (id: string) => {
    return { sessionUpdate: "tool_call", status: "in_progress", title: "Task", toolCallId: id };
};

describe("the child buffer measurement", () => {
    it("reports nothing held when every parent comes first", () => {
        expect(measureChildBuffer([spawn("a"), stamped("hi", "a"), stamped("there", "a")])).toEqual({ childEvents: 2, dropped: 0, peakBytes: 0 });
    });

    it("reports the most that waited for a parent, and what a smaller budget would have dropped", () => {
        const updates = [stamped("x".repeat(200), "a"), stamped("x".repeat(200), "b"), spawn("a"), spawn("b"), stamped("later", "a")];
        const measured = measureChildBuffer(updates);

        expect(measured.childEvents).toBe(3);
        expect(measured.peakBytes).toBeGreaterThan(400);
        expect(measured.dropped).toBe(0);
        expect(measureChildBuffer(updates, 300).dropped).toBe(1);
    });

    it("reads a log of the agent's output, grouped by its session", () => {
        const frame = (sessionId: string, update: unknown) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
        const log = [frame("s1", spawn("a")), "not json", JSON.stringify({ id: 1, result: {} }), frame("s2", spawn("b")), frame("s1", stamped("hi", "a"))].join("\n");
        const sessions = updatesBySession(log);

        // eslint-disable-next-line unicorn/prefer-iterator-to-array -- the desktop's tsconfig `lib` has no iterator helpers
        expect([...sessions.keys()]).toEqual(["s1", "s2"]);
        expect(sessions.get("s1")).toHaveLength(2);
    });
});
