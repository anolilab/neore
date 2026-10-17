import { describe, expect, it } from "vitest";

import { shouldEmailOutcome } from "./notify";

describe("shouldEmailOutcome", () => {
    it("mails only a successful run that produced a result", () => {
        expect(shouldEmailOutcome({ emailOutcome: true, outcome: "success" })).toBe(true);
        expect(shouldEmailOutcome({ emailOutcome: true, outcome: "failure" })).toBe(false);
        expect(shouldEmailOutcome({ emailOutcome: false, outcome: "success" })).toBe(false);
        expect(shouldEmailOutcome({ outcome: "success" })).toBe(false);
        expect(shouldEmailOutcome({ emailOutcome: true })).toBe(false);
    });
});
