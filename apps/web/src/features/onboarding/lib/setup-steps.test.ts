import { describe, expect, it } from "vitest";

import { deriveSetupSteps, detectSetupDone, toggleSkipped } from "./setup-steps";

describe("setup steps", () => {
    it("starts with every step todo", () => {
        expect(deriveSetupSteps([], undefined).map((s) => s.status)).toEqual(["todo", "todo", "todo"]);
        expect(deriveSetupSteps(undefined, undefined).map((s) => s.id)).toEqual(["pair", "ssh", "agent"]);
    });

    it("detects pairing, an SSH server and an agent offer", () => {
        expect(detectSetupDone([{ acpOffers: [{}] }, { transport: "ssh" }])).toEqual({ agent: true, pair: true, ssh: true });
        expect(detectSetupDone([{ acpOffers: [{}], transport: "ssh" }])).toEqual({ agent: true, pair: false, ssh: true });
    });

    it("marks skipped steps and lets done win", () => {
        expect(deriveSetupSteps([], ["ssh"]).map((s) => s.status)).toEqual(["todo", "skipped", "todo"]);
        expect(deriveSetupSteps([{}], ["pair"])[0]?.status).toBe("done");
    });

    it("skips and resumes without duplicates", () => {
        expect(toggleSkipped(["pair"], "pair", true)).toEqual(["pair"]);
        expect(toggleSkipped(["pair", "x"], "pair", false)).toEqual(["x"]);
        expect(toggleSkipped(undefined, "agent", true)).toEqual(["agent"]);
    });
});
