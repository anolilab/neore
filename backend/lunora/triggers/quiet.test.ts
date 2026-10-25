import { describe, expect, it, vi } from "vitest";

import type { BriefInputs } from "../notifications/daily-brief-logic";
import { isQuietRunSkipped, quietWindowStart } from "./quiet";

const EMPTY: BriefInputs = { events: [], needsYou: [], running: [], threads: [] };

const ROUTINE = { createdAt: 100, lastTriggeredAt: 500, quietWhenEmpty: true };

describe("quietWindowStart", () => {
    it("starts at the last run that posted", () => {
        expect(quietWindowStart({ createdAt: 100, lastTriggeredAt: 500 })).toBe(500);
    });

    it("starts at creation before any run has posted", () => {
        expect(quietWindowStart({ createdAt: 100 })).toBe(100);
    });
});

describe("isQuietRunSkipped", () => {
    it("posts every run of a routine that did not opt in, without reading the workspace", async () => {
        const loadInputs = vi.fn(async () => EMPTY);

        await expect(isQuietRunSkipped({ createdAt: 100, quietWhenEmpty: undefined }, loadInputs)).resolves.toBe(false);
        await expect(isQuietRunSkipped({ createdAt: 100, quietWhenEmpty: false }, loadInputs)).resolves.toBe(false);
        expect(loadInputs).not.toHaveBeenCalled();
    });

    it("skips an opted-in run when the workspace reads nothing to report since the last post", async () => {
        const loadInputs = vi.fn(async () => EMPTY);

        await expect(isQuietRunSkipped(ROUTINE, loadInputs)).resolves.toBe(true);
        expect(loadInputs).toHaveBeenCalledWith(500);
    });

    it("reads from creation when the routine has never posted", async () => {
        const loadInputs = vi.fn(async () => EMPTY);

        await expect(isQuietRunSkipped({ createdAt: 100, quietWhenEmpty: true }, loadInputs)).resolves.toBe(true);
        expect(loadInputs).toHaveBeenCalledWith(100);
    });

    it.each([
        ["an event", { events: [{ title: "Done", type: "trigger" }] }],
        ["a request for the user", { needsYou: [{ kind: "task_review", title: "Review" }] }],
        ["running work", { running: [{ kind: "task", title: "Sync" }] }],
        ["a touched thread", { threads: ["Planning"] }],
    ])("posts an opted-in run when there is %s to report", async (_label, patch) => {
        const loadInputs = vi.fn(async () => {
            return { ...EMPTY, ...patch };
        });

        await expect(isQuietRunSkipped(ROUTINE, loadInputs)).resolves.toBe(false);
    });
});
