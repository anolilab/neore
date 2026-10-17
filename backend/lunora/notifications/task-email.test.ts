import { beforeEach, describe, expect, it, vi } from "vitest";

import { notifyOutcome, shouldEmailOutcome } from "./task-email";

const { notifyQuietly } = vi.hoisted(() => {
    return { notifyQuietly: vi.fn() };
});

vi.mock("./notify", () => {
    return { notifyQuietly };
});
vi.mock("../_generated/internal", () => {
    return { internal: { notifications: { task_email: { sendTaskOutcomeEmail: "sendTaskOutcomeEmail" } } } };
});
vi.mock("../email/mailer", () => {
    return { queueEmail: vi.fn() };
});

const input = { link: "/tasks", outcome: "success", title: "Report", type: "task", userId: "u1" } as const;

const makeCtx = (taskEmailEnabled: boolean | undefined) => {
    const runAfter = vi.fn();
    const ctx = {
        db: { userSettings: { findFirst: async () => (taskEmailEnabled === undefined ? null : { taskEmailEnabled }) } },
        scheduler: { runAfter },
    };

    return { ctx: ctx as never, runAfter };
};

describe("shouldEmailOutcome", () => {
    const base = { hasResult: true, notificationId: "n1" as never, outcome: "success" as const, taskEmailEnabled: true };

    it("mails only a new, successful, opted-in run with a result", () => {
        expect(shouldEmailOutcome(base)).toBe(true);
        expect(shouldEmailOutcome({ ...base, taskEmailEnabled: undefined })).toBe(false);
        expect(shouldEmailOutcome({ ...base, taskEmailEnabled: false })).toBe(false);
        expect(shouldEmailOutcome({ ...base, hasResult: false })).toBe(false);
        expect(shouldEmailOutcome({ ...base, outcome: "failure" })).toBe(false);
        expect(shouldEmailOutcome({ ...base, notificationId: null })).toBe(false);
    });
});

describe("notifyOutcome", () => {
    beforeEach(() => {
        notifyQuietly.mockReset();
        notifyQuietly.mockResolvedValue("n1");
    });

    it("schedules the email for an opted-in successful run with a result", async () => {
        const on = makeCtx(true);

        await notifyOutcome(on.ctx, input, true);
        expect(on.runAfter).toHaveBeenCalledWith(0, "sendTaskOutcomeEmail", { link: "/tasks", title: "Report", userId: "u1" });
    });

    it("sends nothing when the user has not opted in, or the run has no result, or it failed", async () => {
        for (const [settings, hasResult, outcome] of [
            [undefined, true, "success"],
            [false, true, "success"],
            [true, false, "success"],
            [true, true, "failure"],
        ] as const) {
            const off = makeCtx(settings);

            await notifyOutcome(off.ctx, { ...input, outcome }, hasResult);
            expect(off.runAfter).not.toHaveBeenCalled();
        }
    });

    it("sends nothing for a duplicate notification", async () => {
        notifyQuietly.mockResolvedValue(null);

        const on = makeCtx(true);

        await notifyOutcome(on.ctx, input, true);
        expect(on.runAfter).not.toHaveBeenCalled();
    });
});
