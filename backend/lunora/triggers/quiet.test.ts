import { describe, expect, it, vi } from "vitest";

import type { QuietSnapshot } from "./quiet";
import { canBeQuiet, isQuietRunSkipped, quietBriefInputs, quietWindowStart } from "./quiet";

const EMPTY: QuietSnapshot = { events: [], needsYou: [], running: [], threads: [] };

const ROUTINE = { botId: "bot-a", createdAt: 100, lastTriggeredAt: 500, quietWhenEmpty: true, type: "schedule" } as const;

const MANUAL = { manual: true };
const SCHEDULED = { manual: false };

describe("quietWindowStart", () => {
    it("starts at the last finished run", () => {
        expect(quietWindowStart({ createdAt: 100, lastTriggeredAt: 500 })).toBe(500);
    });

    it("starts at creation before any run has finished", () => {
        expect(quietWindowStart({ createdAt: 100 })).toBe(100);
    });
});

describe("canBeQuiet", () => {
    it("needs a bot and a schedule", () => {
        expect(canBeQuiet({ botId: "bot-a", type: "schedule" })).toBe(true);
        expect(canBeQuiet({ botId: undefined, type: "schedule" })).toBe(false);
        expect(canBeQuiet({ botId: "bot-a", type: "webhook" })).toBe(false);
        expect(canBeQuiet({ botId: "bot-a", type: "event" })).toBe(false);
    });
});

describe("quietBriefInputs", () => {
    const SINCE = 500;

    it("drops an event from before the window and keeps one after it", () => {
        const inputs = quietBriefInputs(
            {
                ...EMPTY,
                events: [
                    { createdAt: 500, type: "task" },
                    { createdAt: 501, type: "task" },
                ],
            },
            SINCE,
        );

        expect(inputs.events).toHaveLength(1);
    });

    it("drops another routine's notification and the brief itself", () => {
        const inputs = quietBriefInputs(
            {
                ...EMPTY,
                events: [
                    { createdAt: 600, type: "trigger" },
                    { createdAt: 600, type: "daily_brief" },
                ],
            },
            SINCE,
        );

        expect(inputs.events).toEqual([]);
    });

    it("keeps an event of another kind that is as new as the routine's own", () => {
        const inputs = quietBriefInputs(
            {
                ...EMPTY,
                events: [
                    { createdAt: 600, type: "trigger" },
                    { createdAt: 600, type: "eval" },
                ],
            },
            SINCE,
        );

        expect(inputs.events).toEqual([{ title: "", type: "eval" }]);
    });

    it("drops a request that arose before the window and keeps one after it", () => {
        const inputs = quietBriefInputs(
            {
                ...EMPTY,
                needsYou: [
                    { at: 400, kind: "waiting_in_chat", title: "Old approval" },
                    { at: 700, kind: "task_review", title: "New review" },
                ],
            },
            SINCE,
        );

        expect(inputs.needsYou).toEqual([{ at: 700, kind: "task_review", title: "New review" }]);
    });

    it("drops running work that started before the window and keeps work that changed after it", () => {
        const inputs = quietBriefInputs(
            {
                ...EMPTY,
                running: [
                    { at: 400, kind: "task", title: "Old sync" },
                    { at: 700, kind: "sub_agent", title: "New sync" },
                ],
            },
            SINCE,
        );

        expect(inputs.running).toEqual([{ at: 700, kind: "sub_agent", title: "New sync" }]);
    });

    it("keeps a touched thread after the window, not one before it, an untitled one or a locked one", () => {
        const inputs = quietBriefInputs(
            {
                ...EMPTY,
                threads: [{ title: "Planning", updatedAt: 700 }, { title: "Stale", updatedAt: 400 }, { updatedAt: 700 }],
            },
            SINCE,
        );

        expect(inputs.threads).toEqual(["Planning"]);
    });

    it("counts a chat a user titled like a run thread: the title says nothing about who wrote it", () => {
        const inputs = quietBriefInputs({ ...EMPTY, threads: [{ title: "Trigger: x", updatedAt: 700 }] }, SINCE);

        expect(inputs.threads).toEqual(["Trigger: x"]);
    });
});

describe("isQuietRunSkipped", () => {
    it("posts every run of a routine that did not opt in, without reading the workspace", async () => {
        const loadSnapshot = vi.fn(async () => EMPTY);

        await expect(isQuietRunSkipped({ ...ROUTINE, quietWhenEmpty: undefined }, loadSnapshot, SCHEDULED)).resolves.toBe(false);
        await expect(isQuietRunSkipped({ ...ROUTINE, quietWhenEmpty: false }, loadSnapshot, SCHEDULED)).resolves.toBe(false);
        expect(loadSnapshot).not.toHaveBeenCalled();
    });

    it("skips an opted-in run when the workspace reads nothing to report since the last run", async () => {
        const loadSnapshot = vi.fn(async () => EMPTY);

        await expect(isQuietRunSkipped(ROUTINE, loadSnapshot, SCHEDULED)).resolves.toBe(true);
        expect(loadSnapshot).toHaveBeenCalledWith(500);
    });

    it("reads from creation when the routine has never run", async () => {
        const loadSnapshot = vi.fn(async () => EMPTY);

        await expect(isQuietRunSkipped({ ...ROUTINE, lastTriggeredAt: undefined }, loadSnapshot, SCHEDULED)).resolves.toBe(true);
        expect(loadSnapshot).toHaveBeenCalledWith(100);
    });

    it("never reads the workspace for a webhook routine, even one whose row carries the flag", async () => {
        const loadSnapshot = vi.fn(async () => EMPTY);

        await expect(isQuietRunSkipped({ ...ROUTINE, type: "webhook" }, loadSnapshot, SCHEDULED)).resolves.toBe(false);
        expect(loadSnapshot).not.toHaveBeenCalled();
    });

    it("posts when the bot is gone, whatever the flag says", async () => {
        const loadSnapshot = vi.fn(async () => EMPTY);

        await expect(isQuietRunSkipped({ ...ROUTINE, botId: undefined }, loadSnapshot, SCHEDULED)).resolves.toBe(false);
        expect(loadSnapshot).not.toHaveBeenCalled();
    });

    it("never skips a manual run, without reading the workspace", async () => {
        const loadSnapshot = vi.fn(async () => EMPTY);

        await expect(isQuietRunSkipped(ROUTINE, loadSnapshot, MANUAL)).resolves.toBe(false);
        expect(loadSnapshot).not.toHaveBeenCalled();
    });

    it.each([
        ["an event", { events: [{ createdAt: 600, type: "task" }] }],
        ["a request for the user", { needsYou: [{ at: 600, kind: "task_review", title: "Review" }] }],
        ["running work", { running: [{ at: 600, kind: "task", title: "Sync" }] }],
        ["a touched thread", { threads: [{ title: "Planning", updatedAt: 600 }] }],
    ])("posts an opted-in run when there is %s to report", async (_label, patch) => {
        const loadSnapshot = vi.fn(async () => {
            return { ...EMPTY, ...patch };
        });

        await expect(isQuietRunSkipped(ROUTINE, loadSnapshot, SCHEDULED)).resolves.toBe(false);
    });

    it("skips when everything in the workspace is older than the window or another routine's notification", async () => {
        const loadSnapshot = vi.fn(async () => {
            return {
                events: [{ createdAt: 600, type: "trigger" }],
                needsYou: [{ at: 400, kind: "waiting_in_chat", title: "Old approval" }],
                running: [{ at: 400, kind: "task", title: "Old task" }],
                threads: [{ title: "Old chat", updatedAt: 400 }],
            };
        });

        await expect(isQuietRunSkipped(ROUTINE, loadSnapshot, SCHEDULED)).resolves.toBe(true);
    });
});
