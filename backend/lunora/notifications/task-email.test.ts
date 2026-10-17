import { beforeEach, describe, expect, it, vi } from "vitest";

import { notifyOutcome } from "./task-email";

const { notify } = vi.hoisted(() => {
    return { notify: vi.fn() };
});

vi.mock("./notify", () => {
    return { notify };
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

describe("notifyOutcome", () => {
    beforeEach(() => {
        notify.mockReset();
        notify.mockResolvedValue("n1");
    });

    it("schedules the email only for an opted-in successful run with a result", async () => {
        const on = makeCtx(true);

        await notifyOutcome(on.ctx, input, true);
        expect(on.runAfter).toHaveBeenCalledWith(0, "sendTaskOutcomeEmail", { link: "/tasks", title: "Report", userId: "u1" });

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
        notify.mockResolvedValue(null);

        const on = makeCtx(true);

        await notifyOutcome(on.ctx, input, true);
        expect(on.runAfter).not.toHaveBeenCalled();
    });
});
