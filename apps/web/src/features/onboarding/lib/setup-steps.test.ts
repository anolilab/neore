import { describe, expect, it } from "vitest";

import { deriveSetupSteps, detectSetupDone, toggleSkipped } from "./setup-steps";

describe("setup steps", () => {
    it("detects pairing, an SSH server and an agent offer on a paired computer", () => {
        expect(detectSetupDone([])).toEqual({ agent: false, pair: false, ssh: false });
        expect(
            detectSetupDone([
                { acpOffers: [{}], lastSeenAt: 1 },
                { lastSeenAt: 1, transport: "ssh" },
            ]),
        ).toEqual({ agent: true, pair: true, ssh: true });
        expect(detectSetupDone([{ acpOffers: [{}], lastSeenAt: 1, transport: "ssh" }])).toEqual({ agent: false, pair: false, ssh: true });
    });

    it("counts no device that has not reported in, because its row exists before the pairing is confirmed", () => {
        expect(detectSetupDone([{ acpOffers: [{}] }, { transport: "ssh" }])).toEqual({ agent: false, pair: false, ssh: false });
    });

    it("marks skipped steps and lets done win", () => {
        expect(deriveSetupSteps([], ["ssh"]).map((s) => s.status)).toEqual(["todo", "skipped", "todo"]);
        expect(deriveSetupSteps([{ lastSeenAt: 1 }], ["pair"])[0]?.status).toBe("done");
    });

    it("skips and resumes without duplicates and keeps unknown ids", () => {
        expect(toggleSkipped(["pair"], "pair", true)).toEqual(["pair"]);
        expect(toggleSkipped(["pair", "x"], "pair", false)).toEqual(["x"]);
    });
});
