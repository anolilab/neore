import { describe, expect, it } from "vitest";

import { normalizeNotification, shouldEmailOutcome } from "./notify";

describe("shouldEmailOutcome", () => {
    it("mails only a successful run that produced a result", () => {
        expect(shouldEmailOutcome({ emailOutcome: true, outcome: "success" })).toBe(true);
        expect(shouldEmailOutcome({ emailOutcome: true, outcome: "failure" })).toBe(false);
        expect(shouldEmailOutcome({ emailOutcome: false, outcome: "success" })).toBe(false);
        expect(shouldEmailOutcome({ outcome: "success" })).toBe(false);
        expect(shouldEmailOutcome({ emailOutcome: true })).toBe(false);
    });
});

describe("outcome email title", () => {
    it("is clamped to the length the email action accepts, for a long trigger name", () => {
        const row = normalizeNotification({ title: "T".repeat(300), type: "trigger", userId: "u1" });

        expect(row.title.length).toBeLessThanOrEqual(200);
    });
});
