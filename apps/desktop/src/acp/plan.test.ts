import { describe, expect, it } from "vitest";

import { MAX_PLAN_ENTRIES, MAX_PLAN_ENTRY_CHARS, planOf } from "./plan";

const keep = (text: string): string => text;

describe(planOf, () => {
    it("reads each entry's text, priority and status", () => {
        expect(planOf({ entries: [{ content: "Read the code", priority: "high", status: "in_progress" }] }, keep)).toEqual([
            { content: "Read the code", priority: "high", status: "in_progress" },
        ]);
    });

    it("has nothing to say about an update without a list, and an empty list empties the plan", () => {
        expect(planOf({}, keep)).toBeUndefined();
        expect(planOf({ entries: [] }, keep)).toEqual([]);
    });

    it("leaves out an entry the backend would refuse instead of sending it", () => {
        const entries = [
            { content: "fine", priority: "low", status: "completed" },
            { content: "odd priority", priority: "urgent", status: "pending" },
            { content: "odd status", priority: "low", status: "blocked" },
            { content: " ".repeat(3), priority: "low", status: "pending" },
            { priority: "low", status: "pending" },
            "not an entry",
        ];

        expect(planOf({ entries }, keep)).toEqual([{ content: "fine", priority: "low", status: "completed" }]);
    });

    it("masks before it cuts, so a value straddling the cut is never half shown", () => {
        const secret = "s3cr3t-value";
        const content = `${"x".repeat(MAX_PLAN_ENTRY_CHARS - 4)}${secret}`;
        const [entry] = planOf({ entries: [{ content, priority: "high", status: "pending" }] }, (text) => text.replaceAll(secret, "[masked]")) ?? [];

        expect(entry?.content).toHaveLength(MAX_PLAN_ENTRY_CHARS);
        expect(entry?.content).not.toContain("s3cr");
    });

    it("does not end a cut entry on half of a character outside the basic plane", () => {
        // The cut falls between the two halves of an emoji, which would end the entry on its first half.
        const content = `${"x".repeat(MAX_PLAN_ENTRY_CHARS - 1)}😀`;
        const [entry] = planOf({ entries: [{ content, priority: "high", status: "pending" }] }, keep) ?? [];

        expect(entry?.content).toBe("x".repeat(MAX_PLAN_ENTRY_CHARS - 1));
    });

    it("keeps at most the entries one event may carry", () => {
        const entries = Array.from({ length: MAX_PLAN_ENTRIES + 5 }, (_, index) => {
            return { content: `step ${String(index)}`, priority: "medium", status: "pending" };
        });

        expect(planOf({ entries }, keep)).toHaveLength(MAX_PLAN_ENTRIES);
    });
});
