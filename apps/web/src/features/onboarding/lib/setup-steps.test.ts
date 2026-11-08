import { describe, expect, it } from "vitest";

import { deriveSetupSteps, detectSetupDone, toggleSkipped } from "./setup-steps";

describe("setup steps", () => {
    it("detects pairing, an SSH server and an agent offer on a paired computer", () => {
        expect(detectSetupDone([])).toEqual({ agent: false, pair: false, ssh: false });
        expect(detectSetupDone([{ acpOffers: [{}] }, { transport: "ssh" }])).toEqual({ agent: true, pair: true, ssh: true });
        expect(detectSetupDone([{ acpOffers: [{}], transport: "ssh" }])).toEqual({ agent: false, pair: false, ssh: true });
    });

    it("marks skipped steps and lets done win", () => {
        expect(deriveSetupSteps([], ["ssh"]).map((s) => s.status)).toEqual(["todo", "skipped", "todo"]);
        expect(deriveSetupSteps([{}], ["pair"])[0]?.status).toBe("done");
    });

    it("skips and resumes without duplicates and keeps unknown ids", () => {
        expect(toggleSkipped(["pair"], "pair", true)).toEqual(["pair"]);
        expect(toggleSkipped(["pair", "x"], "pair", false)).toEqual(["x"]);
    });
});
