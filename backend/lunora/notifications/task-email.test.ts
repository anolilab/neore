/**
 * The outcome-email outbox: `notify()` writes the row with the inbox row, and the
 * sweep sends it once. The mailer is mocked; the action runs over a ctx that routes
 * `runQuery` / `runMutation` to the real handlers on the harness.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import { LOCKED_THREAD_TITLE } from "../lib/thread-lock";
import schema from "../schema";
import { notify } from "./notify";
import {
    dispatchOutcomeEmails,
    claimOutcomeEmail,
    holdsOutcomeEmailClaim,
    listPendingOutcomeEmails,
    loadRecipientEmail,
    OUTCOME_EMAIL_MAX_ATTEMPTS,
    OUTCOME_EMAIL_RETENTION_MS,
    SEND_BATCH,
    sendPendingOutcomeEmails,
    settleOutcomeEmail,
} from "./task-email";

const { queueEmail } = vi.hoisted(() => {
    return { queueEmail: vi.fn(async () => {}) };
});

vi.mock("../email/mailer", () => {
    return { queueEmail };
});

const { env } = vi.hoisted(() => {
    return { env: { SITE_URL: "https://app.example" as string | undefined } };
});

vi.mock("../env", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../env")>()),
        get SITE_URL() {
            return env.SITE_URL;
        },
    };
});

vi.mock("../email/templates/task-outcome", () => {
    return { default: () => null };
});

// Reassigned to the seeded user's real id: `loadRecipientEmail` reads the user row by `_id`.
let USER = "user-a";

let harness: ReturnType<typeof lunoraTest>;

type Handler<R> = { handler: (ctx: any, args: any) => Promise<R> };

const run = async <R>(procedure: unknown, args: Record<string, unknown> = {}): Promise<R> =>
    await harness.run(async (ctx: any) => await (procedure as Handler<R>).handler(ctx, args));

const handlers = new Map<unknown, unknown>([
    [internal.notifications.task_email.claimOutcomeEmail, claimOutcomeEmail],
    [internal.notifications.task_email.holdsOutcomeEmailClaim, holdsOutcomeEmailClaim],
    [internal.notifications.task_email.listPendingOutcomeEmails, listPendingOutcomeEmails],
    [internal.notifications.task_email.loadRecipientEmail, loadRecipientEmail],
    [internal.notifications.task_email.settleOutcomeEmail, settleOutcomeEmail],
]);

const runSend = async (): Promise<ReturnType<typeof vi.fn>> => {
    const route = async (ref: unknown, args: Record<string, unknown>) => await run(handlers.get(ref), args);
    const runAfter = vi.fn(async () => {});

    await (sendPendingOutcomeEmails as unknown as Handler<null>).handler({ runMutation: route, runQuery: route, scheduler: { runAfter } }, {});

    return runAfter;
};

const outbox = async () =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.outcomeEmails.findMany({ limit: 100, where: { userId: USER } });

        return page;
    });

const write = async (extra: Record<string, unknown> = {}) =>
    await harness.run(
        async (ctx: any) =>
            await notify(ctx, { emailOutcome: true, link: "/tasks/1", outcome: "success", title: "Nightly", type: "task", userId: USER, ...extra } as never),
    );

const firstOutbox = async () => {
    const [row] = await outbox();

    return row;
};

const seedUser = async (taskEmailEnabled = true) => {
    USER = await harness.run(
        async (ctx: any) => await ctx.db.insert("user", { createdAt: 1, email: "a@example.com", emailVerified: true, name: "A", updatedAt: 1 }),
    );

    await harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", { taskEmailEnabled, userId: USER });
    });

    return USER;
};

beforeEach(() => {
    queueEmail.mockReset();
    USER = "user-a";
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

describe("outbox write", () => {
    it("writes a pending row with the inbox row for an opted-in successful run", async () => {
        await seedUser();
        const id = await write();

        const rows = await outbox();

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ attempts: 0, link: "/tasks/1", notificationId: id, status: "pending", title: "Nightly" });
    });

    it("writes no row for a failure, a disabled setting or a run without a result", async () => {
        await seedUser(false);
        await write();
        await write({ outcome: "failure", title: "Failed" });
        await write({ emailOutcome: false, title: "No result" });

        expect(await outbox()).toHaveLength(0);
    });

    it("writes one row for a duplicate notification", async () => {
        await seedUser();
        await write({ dedupeKey: "k1" });
        await write({ dedupeKey: "k1" });

        expect(await outbox()).toHaveLength(1);
    });
});

describe("sweep", () => {
    it("sends a pending row once and marks it sent", async () => {
        await seedUser();
        await write();

        await runSend();
        await runSend();

        expect(queueEmail).toHaveBeenCalledTimes(1);
        expect(queueEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "a@example.com" }));
        expect(await firstOutbox()).toMatchObject({ status: "sent" });
    });

    it("lets only one run claim a row, so overlapping runs cannot both send it", async () => {
        await seedUser();
        await write();
        const [row] = await outbox();

        const claim = async () => await harness.run(async (ctx: any) => await claimOutcomeEmail.handler(ctx, { id: row._id }));

        expect(await claim()).not.toBeNull();
        expect(await claim()).toBeNull();
    });

    it("does not mail a row whose claim was taken over after the run listed it", async () => {
        await seedUser();
        await write();
        const [row] = await outbox();
        const claimedAt = await harness.run(async (ctx: any) => await claimOutcomeEmail.handler(ctx, { id: row._id }));
        const holds = async (token: number) =>
            await harness.run(async (ctx: any) => await holdsOutcomeEmailClaim.handler(ctx, { claimedAt: token, id: row._id }));

        expect(await holds(claimedAt as number)).toBe(true);
        expect(await holds((claimedAt as number) - 1)).toBe(false);
    });

    it("leaves the row pending without using an attempt while the site URL is not set", async () => {
        await seedUser();
        await write();
        env.SITE_URL = undefined;

        try {
            await runSend();
        } finally {
            env.SITE_URL = "https://app.example";
        }

        expect(queueEmail).not.toHaveBeenCalled();
        expect(await firstOutbox()).toMatchObject({ attempts: 0, status: "pending" });
    });

    it("keeps the row pending with attempts incremented when the mailer fails, then gives up at the cap", async () => {
        await seedUser();
        await write();
        queueEmail.mockRejectedValue(new Error("down"));
        vi.spyOn(console, "warn").mockImplementation(() => {});

        await runSend();

        expect(await firstOutbox()).toMatchObject({ attempts: 1, status: "pending" });

        for (let index = 1; index < OUTCOME_EMAIL_MAX_ATTEMPTS; index += 1) {
            await runSend();
        }

        expect(await firstOutbox()).toMatchObject({ attempts: OUTCOME_EMAIL_MAX_ATTEMPTS, status: "failed" });
    });

    it("schedules another run when a full batch leaves rows waiting", async () => {
        await seedUser();

        for (let index = 0; index < SEND_BATCH + 1; index += 1) {
            await write({ dedupeKey: `k${String(index)}` });
        }

        const runAfter = await runSend();

        expect(queueEmail).toHaveBeenCalledTimes(SEND_BATCH);
        expect(runAfter).toHaveBeenCalledTimes(1);
    });

    it("drops the row without mailing when the setting was turned off", async () => {
        await seedUser();
        await write();
        await harness.run(async (ctx: any) => {
            const settings = await ctx.db.userSettings.findFirst({ where: { userId: USER } });

            await ctx.db.patch(settings._id, { taskEmailEnabled: false });
        });

        await runSend();

        expect(queueEmail).not.toHaveBeenCalled();
        expect(await outbox()).toHaveLength(0);
    });

    it("drops the row without mailing when the account is being deleted", async () => {
        await seedUser();
        await write();
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("gdprRequests", {
                requestedAt: 1,
                requestType: "deletion",
                status: "processing",
                userEmail: "a@example.com",
                userId: USER,
            });
        });

        await runSend();

        expect(queueEmail).not.toHaveBeenCalled();
        expect(await outbox()).toHaveLength(0);
    });

    it("prunes sent rows older than the retention window", async () => {
        vi.useFakeTimers({ now: Date.UTC(2026, 0, 1), toFake: ["Date"] });
        await seedUser();
        await write();
        await runSend();
        vi.setSystemTime(Date.UTC(2026, 0, 1) + OUTCOME_EMAIL_RETENTION_MS + 60_000);

        await harness.run(async (ctx: any) => await dispatchOutcomeEmails.handler(ctx, {}));

        expect(await outbox()).toHaveLength(0);
    });
});

describe("the outbox title for a chat", () => {
    const queuedTitle = async (lockedAt: number | undefined): Promise<string> => {
        await harness.run(async (ctx: any) => {
            const threadId = await ctx.db.insert("threads", { ...(lockedAt !== undefined && { lockedAt }), status: "regular", title: "Salary", userId: USER });
            const notificationId = await ctx.db.insert("notifications", {
                createdAt: 1,
                link: `/chat/${threadId}`,
                title: "Salary",
                type: "task",
                userId: USER,
            });

            await ctx.db.insert("outcomeEmails", {
                attempts: 0,
                createdAt: 1,
                link: `/chat/${threadId}`,
                notificationId,
                status: "pending",
                title: "Salary",
                userId: USER,
            });
        });

        const [row] = await run<{ title: string }[]>(listPendingOutcomeEmails);

        return row?.title ?? "";
    };

    it("sends the generic title once the chat was locked after the row was queued", async () => {
        expect(await queuedTitle(Date.now())).toBe(LOCKED_THREAD_TITLE);
    });

    it("keeps the title of a chat that is not locked", async () => {
        expect(await queuedTitle(undefined)).toBe("Salary");
    });
});
