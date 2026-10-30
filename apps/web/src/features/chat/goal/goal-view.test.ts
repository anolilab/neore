import { describe, expect, it } from "vitest";

import { anchorVerdicts, isGoalInstruction, withoutGoalInstructions } from "./goal-view";

const message = (id: string, role: "assistant" | "user", order: number, agentName?: string) => ({ agentName, id, order, role }) as never;

describe("withoutGoalInstructions", () => {
    it("drops the instructions a goal saved, and keeps the user's own messages", () => {
        const list = [message("u1", "user", 0), message("a1", "assistant", 0), message("g1", "user", 1, "neore:goal"), message("a2", "assistant", 1)];

        expect(withoutGoalInstructions(list).map((m) => m.id)).toEqual(["u1", "a1", "a2"]);
        expect(isGoalInstruction(list[2]!)).toBe(true);
        expect(isGoalInstruction(list[0]!)).toBe(false);
    });

    it("returns the same array when there is nothing to drop", () => {
        const list = [message("u1", "user", 0), message("a1", "assistant", 0)];

        expect(withoutGoalInstructions(list)).toBe(list);
    });
});

describe("anchorVerdicts", () => {
    const list = [message("u1", "user", 0), message("a1", "assistant", 0), message("a2", "assistant", 1)];

    it("puts a verdict under the last assistant message of its turn", () => {
        const anchors = anchorVerdicts(list, [
            { met: false, order: 0, reason: "More.", round: 1 },
            { met: true, order: 1, reason: "Done.", round: 2 },
        ]);

        expect(anchors.get("a1")?.map((v) => v.round)).toEqual([1]);
        expect(anchors.get("a2")?.map((v) => v.round)).toEqual([2]);
    });

    it("falls back to the last message when the turn is not loaded or unknown", () => {
        const anchors = anchorVerdicts(list, [
            { met: false, order: 9, reason: "x", round: 1 },
            { met: false, reason: "y", round: 2 },
        ]);

        expect(anchors.get("a2")?.map((v) => v.round)).toEqual([1, 2]);
    });

    it("anchors nothing in an empty thread", () => {
        expect(anchorVerdicts([], [{ met: true, reason: "x", round: 1 }]).size).toBe(0);
    });
});
