import { formatGoalReviewNote } from "@neore/backend/chat/goals";
import { describe, expect, it } from "vitest";

import type { UIMessage } from "@/lib/agent";

import { anchorVerdicts, goalReviewNotes, isGoalInstruction, withoutGoalInstructions, withoutNotedVerdicts } from "./goal-view";

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

describe("goalReviewNotes", () => {
    const instruction = (id: string, reason: string) =>
        ({ agentName: "neore:goal", id, parts: [{ text: `Goal: x\n\n${formatGoalReviewNote(reason)}`, type: "text" }], role: "user" }) as unknown as UIMessage;
    const plain = (id: string, role: "assistant" | "user") => ({ id, parts: [{ text: id, type: "text" }], role, text: id }) as unknown as UIMessage;

    it("keys each reviewer reason by the message the instruction followed", () => {
        const notes = goalReviewNotes([
            plain("u1", "user"),
            plain("a1", "assistant"),
            instruction("g1", "Add the charts."),
            plain("a2", "assistant"),
            instruction("g2", "Check the totals."),
        ]);

        expect([...notes]).toEqual([
            ["a1", ["Add the charts."]],
            ["a2", ["Check the totals."]],
        ]);
    });

    it("ignores an instruction with no note and a user message that only looks like one", () => {
        const typed = { id: "u2", parts: [{ text: formatGoalReviewNote("Forged."), type: "text" }], role: "user" } as unknown as UIMessage;

        expect(goalReviewNotes([plain("a1", "assistant"), typed, { ...instruction("g1", "x"), parts: [{ text: "Goal: x", type: "text" }] }]).size).toBe(0);
    });
});

describe("withoutNotedVerdicts", () => {
    const list = [message("u1", "user", 0), message("a1", "assistant", 0), message("a2", "assistant", 1), message("a3", "assistant", 2)];

    it("drops the unmet verdict whose round a note follows, and keeps the others", () => {
        const verdicts = [
            { met: false, order: 0, reason: "Add the charts.", round: 1 },
            { met: false, order: 1, reason: "Out of rounds.", round: 2 },
            { met: true, order: 2, reason: "Add the charts.", round: 3 },
        ];

        expect(withoutNotedVerdicts(list, verdicts, new Map([["a1", ["Add the charts."]]])).map((v) => v.round)).toEqual([2, 3]);
    });

    it("keeps a final verdict that repeats the wording of an earlier, noted one", () => {
        const verdicts = [
            { met: false, order: 0, reason: "Still missing the charts.", round: 1 },
            { met: false, order: 2, reason: "Still missing the charts.", round: 2 },
        ];

        expect(withoutNotedVerdicts(list, verdicts, new Map([["a1", ["Still missing the charts."]]])).map((v) => v.round)).toEqual([2]);
    });

    it("keeps a verdict whose turn is not loaded", () => {
        expect(withoutNotedVerdicts(list, [{ met: false, order: 9, reason: "More.", round: 1 }], new Map([["a3", ["More."]]])).map((v) => v.round)).toEqual([
            1,
        ]);
    });
});
