/**
 * The scheduled analytics-erasure retry: 1h / 6h / 24h backoff capped at five attempts per chain,
 * every attempt logged without personal data, only the PostHog erasure re-run, the request
 * finished the way the workflow's success path finishes it, the confirmation email sent from the
 * address kept for the chain, and a watchdog for an attempt that stops without an outcome.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { POSTHOG_RETRY_DELAYS_MS, POSTHOG_RETRY_LEASE_MS, POSTHOG_RETRY_MAX_ATTEMPTS, POSTHOG_RETRY_WATCHDOG_MS } from "./constants";
import { updateRequestProgress } from "./functions";
import {
    expireStalePostHogRetry,
    failPostHogRetry,
    recordPostHogErased,
    recordPostHogRetrySuccess,
    retryPostHogErasure,
    schedulePostHogRetry,
    startPostHogRetry,
} from "./posthog-retry";
import { erasePostHogPerson } from "./steps/posthog-steps";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("./steps/posthog-steps", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("./steps/posthog-steps")>()), erasePostHogPerson: vi.fn() };
});

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const USER = "user-1";
const FAILED_MESSAGE = "Your account data was erased, but deleting your analytics profile failed.";

const deleteAuthRecordsSpy = vi.fn();
const sendEmailSpy = vi.fn();

let harness: ReturnType<typeof lunoraTest>;
let requestId: string;

const run = <T>(body: (ctx: any) => Promise<T>): Promise<T> => harness.run(body as never);
const allJobs = () => harness.scheduler.list();
/**
 * A watchdog is armed `delay + 2h` after the attempt it watches, a delay no attempt (1h, 6h, 24h,
 * a lease for a deferral, 0 for a requeue) is ever queued with. The fake scheduler records no function path.
 */
const isWatchdog = (job: { enqueuedAt: number; scheduledFor: number }) =>
    POSTHOG_RETRY_DELAYS_MS.some((delay) => job.scheduledFor - job.enqueuedAt === delay + POSTHOG_RETRY_WATCHDOG_MS);
/** The attempts queued (and re-queued). */
const jobs = () => allJobs().filter((job) => !isWatchdog(job));
const watchers = () => allJobs().filter((job) => isWatchdog(job));
/** One failure of the workflow queues one chain; a repeated `failureId` is a redelivery. */
const schedule = async (failureId = "failure-1", userEmail = "") =>
    await run(async (ctx) => await ctx.runMutation(schedulePostHogRetry, { failureId, requestId, userEmail, userId: USER }));
const audit = async () =>
    (await run(async (ctx) => await ctx.db.query("gdprAuditLog").collect())) as { action: string; details: string; performedBy: string; userId: string }[];
/** Sorted: rows read back in id order, not insertion order. */
const details = async (action: string) => {
    const rows = await audit();

    return JSON.parse(rows.find((row) => row.action === action)?.details ?? "null") as unknown;
};
const actions = async () => {
    const rows = await audit();

    return rows.map((row) => row.action).toSorted((a, b) => a.localeCompare(b));
};
const request = async () => (await run(async (ctx) => await ctx.db.get(requestId))) as { errorMessage?: string; status: string; userEmail: string };
const emailOnRequest = async () => {
    const row = await request();

    return row.userEmail;
};
const setEmail = async (userEmail: string) => await run(async (ctx) => await ctx.db.patch(requestId, { userEmail }));
const statusOf = async () => {
    const row = await request();

    return row.status;
};
const attempt = async (n: number, chain = 1) =>
    await harness.action((async (ctx: any) => await ctx.runAction(retryPostHogErasure, { attempt: n, chain, requestId, userId: USER })) as never);

beforeAll(async () => {
    registerModule(registry, "gdpr_functions", await import("./functions"));
    registerModule(registry, "gdpr_posthog_retry", await import("./posthog-retry"));
    registerModule(registry, "lib_claim_once", await import("../lib/claim-once"));

    // The mail itself is not under test: the spy sees the address the retry sends it to.
    const emailSteps = await import("./steps/email-steps");

    registry.set("gdpr_steps_email_steps:sendDeletionConfirmedEmailAction", {
        ...emailSteps.sendDeletionConfirmedEmailAction,
        handler: (...handlerArgs: unknown[]) => sendEmailSpy(...handlerArgs),
    });

    const deletionSteps = await import("./steps/deletion-steps");

    // The retry must never reach this: it is the step that deletes the user's sign-in.
    registry.set("gdpr_steps_deletion_steps:deleteAuthRecords", {
        ...deletionSteps.deleteAuthRecords,
        handler: deleteAuthRecordsSpy,
    });
});

beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    vi.mocked(erasePostHogPerson).mockReset();
    deleteAuthRecordsSpy.mockReset();
    sendEmailSpy.mockReset();
    sendEmailSpy.mockResolvedValue(null);
    harness = lunoraTest(schema as never);
    requestId = await run(
        async (ctx) =>
            await ctx.db.insert("gdprRequests", {
                errorMessage: FAILED_MESSAGE,
                requestedAt: NOW - HOUR,
                requestType: "deletion",
                status: "failed",
                userEmail: "",
                userId: USER,
            }),
    );
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

describe("scheduling the first retry", () => {
    it("queues exactly one retry, attempt 1 at +1h, and logs it", async () => {
        await schedule();

        expect(jobs()).toHaveLength(1);
        expect(jobs()[0]?.args).toStrictEqual({ attempt: 1, chain: 1, requestId, userId: USER });
        expect(jobs()[0]?.scheduledFor).toBe(NOW + HOUR);

        expect(await actions()).toStrictEqual(["deletion_retry_scheduled"]);
        expect(await details("deletion_retry_scheduled")).toStrictEqual({ attempt: 1, chain: 1, requestId });
    });
});

describe("a first retry scheduled by a workflow whose status writes failed", () => {
    it("moves a processing request to failed with the fixed reason, so the scheduled attempt can claim and erase", async () => {
        // Both of the workflow's best-effort writes failed: the request is still processing.
        await run(async (ctx) => await ctx.db.patch(requestId, { errorMessage: "stale", status: "processing" }));
        await schedule();

        expect(await statusOf()).toBe("failed");
        const row = await request();

        expect(row.errorMessage).toBe(FAILED_MESSAGE);
        expect(jobs()).toHaveLength(1);

        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");
        await attempt(1);

        expect(erasePostHogPerson).toHaveBeenCalledTimes(1);
        expect(await statusOf()).toBe("completed");
    });

    it("does not touch a request that finished meanwhile", async () => {
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "cancelled" }));
        await schedule();

        expect(await statusOf()).toBe("cancelled");
    });

    it("queues attempt 1 once when the step is delivered twice", async () => {
        await schedule();
        await schedule();

        expect(jobs()).toHaveLength(1);
        const names = await actions();

        expect(names.filter((name) => name === "deletion_retry_scheduled")).toHaveLength(1);
    });
});

describe("a retry attempt", () => {
    it("completes the request, records the outcome like the workflow, and minimises", async () => {
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");

        await attempt(1);

        const row = await request();

        expect(row.status).toBe("completed");
        expect(row.errorMessage).toBeFalsy();
        expect(await actions()).toStrictEqual(["deletion_completed", "deletion_retry_started", "deletion_retry_succeeded"]);

        expect(await details("deletion_retry_succeeded")).toStrictEqual({ attempt: 1, chain: 1, posthog: "deleted", requestId });
        expect(await details("deletion_completed")).toStrictEqual({ posthog: "deleted", requestId });
        expect(erasePostHogPerson).toHaveBeenCalledWith(USER, expect.anything());
        expect(jobs()).toHaveLength(0);
    });

    it("moves the request to processing while the erasure runs", async () => {
        let seen = "";

        vi.mocked(erasePostHogPerson).mockImplementation(async () => {
            const row = await request();

            seen = row.status;

            return "no_profile";
        });
        await attempt(1);

        expect(seen).toBe("processing");
    });

    it("on failure keeps the request failed with the fixed reason, logs a class not the message, and queues attempt 2 at +6h", async () => {
        vi.mocked(erasePostHogPerson).mockRejectedValue(new Error(`Failed to delete person ${USER}: 503 Service Unavailable`));

        await attempt(1);

        const row = await request();

        expect(row.status).toBe("failed");
        expect(row.errorMessage).toBe(FAILED_MESSAGE);
        expect(await actions()).toStrictEqual(["deletion_retry_failed", "deletion_retry_scheduled", "deletion_retry_started"]);

        expect(await details("deletion_retry_failed")).toStrictEqual({ attempt: 1, chain: 1, errorClass: "Error", requestId });
        expect(JSON.stringify(await audit())).not.toContain("Service Unavailable");
        expect(jobs()).toHaveLength(1);
        expect(jobs()[0]?.args).toStrictEqual({ attempt: 2, chain: 1, requestId, userId: USER });
        expect(jobs()[0]?.scheduledFor).toBe(NOW + 6 * HOUR);
    });

    it("follows 1h, 6h, 24h, 24h, 24h and gives up after the fifth attempt, scheduling nothing", async () => {
        vi.mocked(erasePostHogPerson).mockRejectedValue(new Error("down"));

        const delays: number[] = [];

        for (let n = 1; n <= POSTHOG_RETRY_MAX_ATTEMPTS; n += 1) {
            await attempt(n);

            if (n < POSTHOG_RETRY_MAX_ATTEMPTS) {
                delays.push((jobs().at(-1)?.scheduledFor ?? 0) - NOW);
            }
        }

        expect(POSTHOG_RETRY_MAX_ATTEMPTS).toBe(5);
        expect(POSTHOG_RETRY_DELAYS_MS).toStrictEqual([HOUR, 6 * HOUR, 24 * HOUR, 24 * HOUR, 24 * HOUR]);
        expect(delays).toStrictEqual([6 * HOUR, 24 * HOUR, 24 * HOUR, 24 * HOUR]);
        expect(jobs()).toHaveLength(4);

        const names = await actions();

        expect(names).toContain("deletion_retry_exhausted");
        expect(names.filter((name) => name === "deletion_retry_scheduled")).toHaveLength(4);
        const last = await request();

        expect(last.status).toBe("failed");
    });

    it("leaves a request that is no longer failed alone", async () => {
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "completed" }));
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");

        await attempt(1);

        expect(erasePostHogPerson).not.toHaveBeenCalled();
        expect(await audit()).toHaveLength(0);
    });

    it("never runs delete-auth-records", async () => {
        vi.mocked(erasePostHogPerson).mockResolvedValueOnce("deleted").mockRejectedValueOnce(new Error("down"));

        await attempt(1);
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "failed" }));
        await attempt(2);

        expect(deleteAuthRecordsSpy).not.toHaveBeenCalled();
    });
});

describe("the address kept for the confirmation email", () => {
    it("stays on the request through a failed attempt while the chain is pending", async () => {
        await setEmail("a@example.com");
        vi.mocked(erasePostHogPerson).mockRejectedValue(new Error("down"));

        await attempt(1);

        const row = await request();

        expect(row.userEmail).toBe("a@example.com");
        expect(row.status).toBe("failed");
        expect(row.errorMessage).toBe(FAILED_MESSAGE);
        expect(jobs()).toHaveLength(1);
        expect(sendEmailSpy).not.toHaveBeenCalled();
    });

    it("is mailed once when the erasure recovers on a later attempt, and the request ends minimised", async () => {
        await setEmail("a@example.com");
        vi.mocked(erasePostHogPerson).mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce("deleted");

        await attempt(1);
        await attempt(2);

        expect(sendEmailSpy).toHaveBeenCalledTimes(1);
        // The handler's first argument is the ctx, whose lazy getters throw when inspected whole.
        expect(sendEmailSpy.mock.calls[0]?.[1]).toStrictEqual({ userEmail: "a@example.com" });

        const row = await request();

        expect(row.status).toBe("completed");
        expect(row.userEmail).toBe("");
        expect(await actions()).toContain("deletion_completed");
    });

    it("is gone, unmailed, once the chain is exhausted", async () => {
        await setEmail("a@example.com");
        vi.mocked(erasePostHogPerson).mockRejectedValue(new Error("down"));

        for (let n = 1; n <= POSTHOG_RETRY_MAX_ATTEMPTS; n += 1) {
            await attempt(n);

            const row = await request();

            // Kept until the last attempt fails, gone with it.
            expect(row.userEmail).toBe(n < POSTHOG_RETRY_MAX_ATTEMPTS ? "a@example.com" : "");
        }

        const last = await request();

        expect(last.status).toBe("failed");
        expect(last.errorMessage).toBe(FAILED_MESSAGE);
        expect(sendEmailSpy).not.toHaveBeenCalled();
        expect(await actions()).toContain("deletion_retry_exhausted");
    });

    it("sends nothing when the address is already gone", async () => {
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");

        await attempt(1);

        expect(sendEmailSpy).not.toHaveBeenCalled();
        expect(await statusOf()).toBe("completed");
    });

    it("keeps the erasure recorded as succeeded and the request completed when the mail cannot be queued", async () => {
        await setEmail("a@example.com");
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");
        sendEmailSpy.mockRejectedValueOnce(new Error("queue down"));

        await attempt(1);

        const row = await request();

        expect(row.status).toBe("completed");
        expect(row.userEmail).toBe("");
        expect(await actions()).toStrictEqual(["deletion_completed", "deletion_retry_started", "deletion_retry_succeeded"]);
        expect(sendEmailSpy).toHaveBeenCalledTimes(1);
        expect(jobs()).toHaveLength(0);
    });

    it("sends the mail at most once per request: a second delivery after a successful send sends nothing", async () => {
        await setEmail("a@example.com");
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");

        await attempt(1);
        await attempt(1);

        expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    });

    it("does not send when the request's confirmation was already sent", async () => {
        await setEmail("a@example.com");
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");
        await run(async (ctx) => {
            const now = Date.now();

            await ctx.db.insert("idempotencyClaims", { claimedAt: now, expiresAt: now + HOUR, key: requestId, scope: "gdpr-deletion-confirmed-email" });
        });

        await attempt(1);

        expect(sendEmailSpy).not.toHaveBeenCalled();
        expect(await statusOf()).toBe("completed");
    });

    it("minimises the user's other records when the chain ends", async () => {
        const otherId = await run(
            async (ctx) =>
                await ctx.db.insert("gdprRequests", {
                    requestedAt: NOW - 2 * HOUR,
                    requestType: "export",
                    status: "completed",
                    userEmail: "b@example.com",
                    userId: USER,
                }),
        );

        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");
        await attempt(1);

        const other = (await run(async (ctx) => await ctx.db.get(otherId))) as { userEmail: string };

        expect(other.userEmail).toBe("");
    });
});

describe("chains", () => {
    it("starts chain 2 with a fresh attempt 1 at +1h when a re-run fails again after chain 1 was exhausted", async () => {
        vi.mocked(erasePostHogPerson).mockRejectedValue(new Error("down"));

        // One failure of the workflow per call: its `failureId` is new each time. No `deletion_failed`
        // row is written here, as when the workflow's best-effort audit write is swallowed.
        let failures = 0;
        const failedRun = async () => {
            failures += 1;
            await run(async (ctx) => await ctx.db.patch(requestId, { status: "processing" }));
            await schedule(`failure-${String(failures)}`);
        };

        await failedRun();

        for (let n = 1; n <= POSTHOG_RETRY_MAX_ATTEMPTS; n += 1) {
            await attempt(n);
        }

        expect(erasePostHogPerson).toHaveBeenCalledTimes(POSTHOG_RETRY_MAX_ATTEMPTS);
        expect(await actions()).toContain("deletion_retry_exhausted");
        const before = jobs().length;

        await failedRun();

        const queued = jobs().slice(before);

        expect(queued).toHaveLength(1);
        expect(queued[0]?.args).toStrictEqual({ attempt: 1, chain: 2, requestId, userId: USER });
        expect(queued[0]?.scheduledFor).toBe(NOW + HOUR);

        // Chain 2 has its own five attempts, and chain 1's finished attempts do not stop them.
        await attempt(1, 2);

        expect(erasePostHogPerson).toHaveBeenCalledTimes(POSTHOG_RETRY_MAX_ATTEMPTS + 1);
        expect(jobs().at(-1)?.args).toStrictEqual({ attempt: 2, chain: 2, requestId, userId: USER });
    });

    it("keeps the attempt dedupe within a chain: a redelivered scheduling call queues nothing new", async () => {
        await schedule();
        await schedule();

        expect(jobs()).toHaveLength(1);
    });
});

describe("the watchdog", () => {
    const watchdog = async (n: number) =>
        await run(async (ctx) => await ctx.runMutation(expireStalePostHogRetry, { attempt: n, chain: 1, requestId, userId: USER }));

    it("is armed with the attempt, two hours after it is due, once even when the attempt is started twice", async () => {
        await schedule();
        await schedule();
        await run(async (ctx) => await ctx.runMutation(startPostHogRetry, { attempt: 1, chain: 1, requestId, userId: USER }));
        await run(async (ctx) => await ctx.runMutation(startPostHogRetry, { attempt: 1, chain: 1, requestId, userId: USER }));

        expect(watchers()).toHaveLength(1);
        expect(watchers()[0]?.args).toStrictEqual({ attempt: 1, chain: 1, requestId, userId: USER });
        expect(watchers()[0]?.scheduledFor).toBe(NOW + HOUR + POSTHOG_RETRY_WATCHDOG_MS);
    });

    it("fails an attempt whose job never started once the request is failed again, and queues its successor", async () => {
        await schedule();
        expect(await statusOf()).toBe("failed");

        await watchdog(1);

        expect(await details("deletion_retry_failed")).toStrictEqual({ attempt: 1, chain: 1, errorClass: "watchdog", requestId });
        expect(jobs().at(-1)?.args).toStrictEqual({ attempt: 2, chain: 1, requestId, userId: USER });
    });

    it("fails an attempt that stopped without an outcome and queues its successor", async () => {
        await run(async (ctx) => await ctx.runMutation(startPostHogRetry, { attempt: 1, chain: 1, requestId, userId: USER }));
        expect(await statusOf()).toBe("processing");

        await watchdog(1);

        const row = await request();

        expect(row.status).toBe("failed");
        expect(row.errorMessage).toBe(FAILED_MESSAGE);
        expect(await details("deletion_retry_failed")).toStrictEqual({ attempt: 1, chain: 1, errorClass: "watchdog", requestId });
        expect(jobs()).toHaveLength(1);
        expect(jobs()[0]?.args).toStrictEqual({ attempt: 2, chain: 1, requestId, userId: USER });
        expect(jobs()[0]?.scheduledFor).toBe(NOW + 6 * HOUR);

        // A second firing finds the outcome and changes nothing.
        await watchdog(1);

        expect(jobs()).toHaveLength(1);
        const names = await actions();

        expect(names.filter((name) => name === "deletion_retry_failed")).toHaveLength(1);
    });

    it("ends the chain, minimised, when the last attempt is the one that stopped", async () => {
        await setEmail("a@example.com");
        await run(async (ctx) => await ctx.runMutation(startPostHogRetry, { attempt: POSTHOG_RETRY_MAX_ATTEMPTS, chain: 1, requestId, userId: USER }));

        await watchdog(POSTHOG_RETRY_MAX_ATTEMPTS);

        const row = await request();

        expect(row.status).toBe("failed");
        expect(row.userEmail).toBe("");
        expect(row.errorMessage).toBe(FAILED_MESSAGE);
        expect(jobs()).toHaveLength(0);
        expect(await actions()).toContain("deletion_retry_exhausted");
    });

    it("does nothing for an attempt that recorded an outcome", async () => {
        vi.mocked(erasePostHogPerson).mockRejectedValue(new Error("down"));
        await attempt(1);
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "processing" }));

        await watchdog(1);

        expect(await statusOf()).toBe("processing");
        expect(jobs()).toHaveLength(1);
    });

    it("does nothing for an attempt that never started, or a request that finished", async () => {
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "processing" }));
        await watchdog(1);

        expect(await statusOf()).toBe("processing");

        await run(async (ctx) => await ctx.db.patch(requestId, { status: "failed" }));
        await run(async (ctx) => await ctx.runMutation(startPostHogRetry, { attempt: 1, chain: 1, requestId, userId: USER }));
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "completed" }));
        await watchdog(1);

        expect(await statusOf()).toBe("completed");
    });
});

describe("a redelivered attempt", () => {
    const claim = async (n: number) =>
        (await run(async (ctx) => await ctx.runMutation(startPostHogRetry, { attempt: n, chain: 1, requestId, userId: USER }))) !== "skip";

    it("finishes a request its own interrupted attempt left processing", async () => {
        expect(await claim(1)).toBe(true);
        expect(await statusOf()).toBe("processing");
        vi.setSystemTime(NOW + POSTHOG_RETRY_LEASE_MS + 1);
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");

        await attempt(1);

        expect(erasePostHogPerson).toHaveBeenCalledTimes(1);
        expect(await statusOf()).toBe("completed");
        expect(await actions()).toStrictEqual(["deletion_completed", "deletion_retry_resumed", "deletion_retry_started", "deletion_retry_succeeded"]);
    });

    it("does not run a failed attempt again, nor queue a second successor, when its job is redelivered", async () => {
        vi.mocked(erasePostHogPerson).mockRejectedValue(new Error("down"));

        await attempt(1);

        expect(erasePostHogPerson).toHaveBeenCalledTimes(1);
        expect(jobs()).toHaveLength(1);

        // The job is delivered again after the failure committed: the request is `failed` once more.
        await attempt(1);

        expect(erasePostHogPerson).toHaveBeenCalledTimes(1);
        expect(jobs()).toHaveLength(1);
        expect(jobs()[0]?.args).toStrictEqual({ attempt: 2, chain: 1, requestId, userId: USER });
        expect(await statusOf()).toBe("failed");

        const names = await actions();

        expect(names.filter((name) => name === "deletion_retry_started")).toHaveLength(1);
        expect(names.filter((name) => name === "deletion_retry_scheduled")).toHaveLength(1);
        expect(names.filter((name) => name === "deletion_retry_failed")).toHaveLength(1);
    });

    it("does not run a succeeded attempt again even if the request is failed once more", async () => {
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");
        await attempt(1);
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "failed" }));

        await attempt(1);

        expect(erasePostHogPerson).toHaveBeenCalledTimes(1);
    });

    it("keeps the schedule going when the resumed attempt fails", async () => {
        await claim(1);
        vi.setSystemTime(NOW + POSTHOG_RETRY_LEASE_MS + 1);
        vi.mocked(erasePostHogPerson).mockRejectedValue(new Error("down"));

        await attempt(1);

        expect(await statusOf()).toBe("failed");
        expect(jobs()).toHaveLength(1);
        expect(jobs()[0]?.args).toStrictEqual({ attempt: 2, chain: 1, requestId, userId: USER });
    });

    it("does not call PostHog from a second delivery while the first holds a fresh lease", async () => {
        expect(await claim(1)).toBe(true);
        vi.setSystemTime(NOW + POSTHOG_RETRY_LEASE_MS - 1);
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");

        await attempt(1);

        expect(erasePostHogPerson).not.toHaveBeenCalled();
        expect(await statusOf()).toBe("processing");
        expect(await actions()).toStrictEqual(["deletion_retry_started"]);
    });

    it("takes an attempt over once the running delivery's lease has lapsed, and only one delivery does", async () => {
        expect(await claim(1)).toBe(true);
        vi.setSystemTime(NOW + POSTHOG_RETRY_LEASE_MS + 1);
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");

        expect(await claim(1)).toBe(true);
        // The takeover holds a new lease of its own.
        expect(await claim(1)).toBe(false);

        const names = await actions();

        expect(names.filter((name) => name === "deletion_retry_resumed")).toHaveLength(1);
    });

    it("lets a failure that arrives after the success change nothing", async () => {
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");
        await attempt(1);

        await run(async (ctx) => await ctx.runMutation(failPostHogRetry, { attempt: 1, chain: 1, errorClass: "late", requestId, userId: USER }));

        expect(await statusOf()).toBe("completed");
        expect(jobs()).toHaveLength(0);
        expect(await actions()).not.toContain("deletion_retry_failed");
    });

    it("lets a success that arrives after the failure change nothing: the attempt has one outcome", async () => {
        await claim(1);
        await run(async (ctx) => await ctx.runMutation(failPostHogRetry, { attempt: 1, chain: 1, errorClass: "down", requestId, userId: USER }));

        await run(async (ctx) => await ctx.runMutation(recordPostHogRetrySuccess, { attempt: 1, chain: 1, posthog: "deleted", requestId, userId: USER }));

        expect(await statusOf()).toBe("failed");
        expect(jobs()).toHaveLength(1);
    });

    it("leaves a processing request alone when no attempt of this number claimed it", async () => {
        // What a re-run workflow leaves: processing, with no retry row.
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "processing" }));
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");

        await attempt(1);

        // Attempt 1's claim does not entitle attempt 2.
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "failed" }));
        await claim(1);
        vi.setSystemTime(NOW + POSTHOG_RETRY_LEASE_MS + 1);
        await attempt(2);

        expect(erasePostHogPerson).not.toHaveBeenCalled();
        expect(await statusOf()).toBe("processing");
    });
});

describe("a request that finished meanwhile", () => {
    it("is not turned back into failed, and no further attempt is queued, when the erasure errors late", async () => {
        vi.mocked(erasePostHogPerson).mockImplementation(async () => {
            // A concurrent workflow re-run completes the request while this attempt is in flight.
            await run(async (ctx) => await ctx.db.patch(requestId, { status: "completed" }));

            throw new Error("down");
        });

        await attempt(1);

        expect(await statusOf()).toBe("completed");
        expect(jobs()).toHaveLength(0);
        expect(await actions()).toStrictEqual(["deletion_retry_started"]);
    });

    it("is not completed again by a duplicate success, and a cancelled one stays cancelled", async () => {
        vi.mocked(erasePostHogPerson).mockImplementation(async () => {
            await run(async (ctx) => await ctx.db.patch(requestId, { status: "cancelled" }));

            return "deleted";
        });

        await attempt(1);

        expect(await statusOf()).toBe("cancelled");
        expect(await actions()).toStrictEqual(["deletion_retry_started"]);
    });
});

describe("a retry while PostHog erasure is no longer configured", () => {
    it("does not complete the request: it fails the attempt, audits the class `unconfigured`, and queues the next one", async () => {
        vi.mocked(erasePostHogPerson).mockResolvedValue("skipped");

        await attempt(1);

        const row = await request();

        expect(row.status).toBe("failed");
        expect(row.errorMessage).toBe(FAILED_MESSAGE);
        expect(await actions()).not.toContain("deletion_completed");
        expect(await actions()).not.toContain("deletion_retry_succeeded");
        expect(await details("deletion_retry_failed")).toStrictEqual({ attempt: 1, chain: 1, errorClass: "unconfigured", requestId });
        expect(jobs()).toHaveLength(1);
        expect(jobs()[0]?.args).toStrictEqual({ attempt: 2, chain: 1, requestId, userId: USER });
        expect(jobs()[0]?.scheduledFor).toBe(NOW + 6 * HOUR);
    });
});

describe("attempt deduplication", () => {
    const claims = async () =>
        (await run(async (ctx) => await ctx.db.query("idempotencyClaims").collect())) as { key: string; scope: string; userId?: string }[];

    it("is held by claim-once rows, not by the audit log: wiping the log changes nothing", async () => {
        vi.mocked(erasePostHogPerson).mockRejectedValue(new Error("down"));
        await schedule();
        await attempt(1);

        const rows = await claims();

        expect(rows.map((row) => `${row.scope}|${row.key}`).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            `posthog-retry-chain|${requestId}:failure-1`,
            `posthog-retry-lease|${requestId}:1:1`,
            `posthog-retry-outcome|${requestId}:1:1`,
            `posthog-retry-scheduled|${requestId}:1:1`,
            `posthog-retry-scheduled|${requestId}:1:2`,
            `posthog-retry-started|${requestId}:1:1`,
        ]);
        // Untagged, so erasing the account keeps them.
        expect(rows.every((row) => row.userId === undefined)).toBe(true);

        await run(async (ctx) => {
            const logRows = await ctx.db.query("gdprAuditLog").collect();

            for (const row of logRows) {
                await ctx.db.delete(row._id);
            }
        });

        await schedule();
        await attempt(1);

        expect(erasePostHogPerson).toHaveBeenCalledTimes(1);
        // The queued attempt 1 and its successor, each once.
        expect(jobs().map((job) => (job.args as { attempt: number }).attempt)).toStrictEqual([1, 2]);
    });
});

describe("a newer chain, a concurrent re-run and a stopped attempt", () => {
    const EMAIL_SCOPE = "gdpr-deletion-confirmed-email";
    const start = async (n: number, chain = 1) =>
        await run(async (ctx) => await ctx.runMutation(startPostHogRetry, { attempt: n, chain, requestId, userId: USER }));
    const erased = async (n: number, posthog: "deleted" | "no_profile" = "deleted", chain = 1) =>
        await run(async (ctx) => await ctx.runMutation(recordPostHogErased, { attempt: n, chain, posthog, requestId, userId: USER }));
    const emailClaims = async () =>
        ((await run(async (ctx) => await ctx.db.query("idempotencyClaims").collect())) as { key: string; scope: string }[]).filter(
            (row) => row.scope === EMAIL_SCOPE && row.key === requestId,
        );
    const getterKey = "gdpr_posthog_retry:getRetryConfirmationEmail";

    it("lets an old chain's watchdog and failure leave a request a newer chain owns alone", async () => {
        await schedule("a");
        await start(1, 1);
        // A workflow re-run fails again: chain 2 starts and its attempt 1 is running.
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "processing" }));
        await schedule("b");
        expect(await start(1, 2)).toBe("erase");

        await run(async (ctx) => await ctx.runMutation(expireStalePostHogRetry, { attempt: 1, chain: 1, requestId, userId: USER }));
        await run(async (ctx) => await ctx.runMutation(failPostHogRetry, { attempt: 1, chain: 1, errorClass: "late", requestId, userId: USER }));

        expect(await statusOf()).toBe("processing");
        // Only the two chains' own first attempts: the old chain queued no successor.
        expect(jobs()).toHaveLength(2);
        expect(await actions()).not.toContain("deletion_retry_failed");
        // And an old chain's queued attempt does not start.
        expect(await start(2, 1)).toBe("skip");
    });

    it("does not complete, or mail, a request a re-run failed while the retry's erasure was in flight", async () => {
        await setEmail("a@example.com");
        vi.mocked(erasePostHogPerson).mockImplementation(async () => {
            await run(async (ctx) => await ctx.db.patch(requestId, { status: "failed" }));

            return "deleted";
        });

        await attempt(1);

        const row = await request();

        expect(row.status).toBe("failed");
        expect(row.userEmail).toBe("a@example.com");
        expect(await actions()).toStrictEqual(["deletion_retry_started"]);
        expect(sendEmailSpy).not.toHaveBeenCalled();
    });

    it("sends nothing when a re-run completed the request meanwhile, and the re-run's claim keeps a second mail out", async () => {
        await setEmail("a@example.com");
        vi.mocked(erasePostHogPerson).mockImplementation(async () => {
            await run(async (ctx) => await ctx.db.patch(requestId, { status: "completed" }));

            return "deleted";
        });

        await attempt(1);

        expect(sendEmailSpy).not.toHaveBeenCalled();
        expect(await actions()).not.toContain("deletion_retry_succeeded");

        // The re-run's own mail holds the shared claim: a retry that completes later finds it taken.
        vi.mocked(erasePostHogPerson).mockReset();
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "failed" }));
        await run(async (ctx) => {
            const now = Date.now();

            await ctx.db.insert("idempotencyClaims", { claimedAt: now, expiresAt: now + HOUR, key: requestId, scope: EMAIL_SCOPE });
        });
        await attempt(2);

        expect(await statusOf()).toBe("completed");
        expect(sendEmailSpy).not.toHaveBeenCalled();
    });

    it("finishes a redelivered attempt whose erasure was recorded, even while the lease is held", async () => {
        await start(1);
        await erased(1);
        vi.setSystemTime(NOW + POSTHOG_RETRY_LEASE_MS - 1);

        await attempt(1);

        // PostHog is not called again, the lease did not matter, and the watchdog has nothing to fail.
        expect(erasePostHogPerson).not.toHaveBeenCalled();
        expect(await statusOf()).toBe("completed");
        expect(await details("deletion_retry_succeeded")).toStrictEqual({ attempt: 1, chain: 1, posthog: "deleted", requestId });

        await run(async (ctx) => await ctx.runMutation(expireStalePostHogRetry, { attempt: 1, chain: 1, requestId, userId: USER }));

        expect(await actions()).not.toContain("deletion_retry_failed");
    });

    it("does not let the watchdog fail an attempt that erased: it queues the attempt again", async () => {
        await start(1);
        await erased(1, "no_profile");

        await run(async (ctx) => await ctx.runMutation(expireStalePostHogRetry, { attempt: 1, chain: 1, requestId, userId: USER }));

        expect(await statusOf()).toBe("processing");
        expect(await actions()).not.toContain("deletion_retry_failed");
        expect(jobs()).toHaveLength(1);
        expect(jobs()[0]?.args).toStrictEqual({ attempt: 1, chain: 1, requestId, userId: USER });
        expect(jobs()[0]?.scheduledFor).toBe(NOW);
    });

    it("resends a confirmation whose send stopped after the claim, once, on redelivery", async () => {
        await setEmail("a@example.com");
        // The first delivery erased, completed the request and claimed the mail, then stopped.
        await start(1);
        await erased(1);
        await run(async (ctx) => await ctx.runMutation(recordPostHogRetrySuccess, { attempt: 1, chain: 1, posthog: "deleted", requestId, userId: USER }));
        await run(async (ctx) => {
            const now = Date.now();

            await ctx.db.insert("idempotencyClaims", { claimedAt: now, expiresAt: now + HOUR, key: requestId, scope: EMAIL_SCOPE });
        });
        const before = await request();

        expect(before.userEmail).toBe("a@example.com");

        await attempt(1);

        expect(erasePostHogPerson).not.toHaveBeenCalled();
        expect(sendEmailSpy).toHaveBeenCalledTimes(1);
        expect(sendEmailSpy.mock.calls[0]?.[1]).toStrictEqual({ userEmail: "a@example.com" });
        const after = await request();

        expect(after.userEmail).toBe("");
        expect(await actions()).toContain("deletion_confirmation_sent");
        expect(await emailClaims()).toHaveLength(1);

        await attempt(1);

        expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    });

    it("has the watchdog queue the attempt again for a confirmation that is still owed", async () => {
        await setEmail("a@example.com");
        await start(1);
        await erased(1);
        await run(async (ctx) => await ctx.runMutation(recordPostHogRetrySuccess, { attempt: 1, chain: 1, posthog: "deleted", requestId, userId: USER }));

        await run(async (ctx) => await ctx.runMutation(expireStalePostHogRetry, { attempt: 1, chain: 1, requestId, userId: USER }));

        expect(jobs()).toHaveLength(1);
        expect(jobs()[0]?.args).toStrictEqual({ attempt: 1, chain: 1, requestId, userId: USER });
    });

    it("does not mark the attempt failed when the address cannot be read: the erasure stays recorded and a redelivery mails", async () => {
        await setEmail("a@example.com");
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");

        const original = registry.get(getterKey);

        registry.set(getterKey, {
            ...(original as object),
            handler: () => {
                throw new Error("read failed");
            },
        });

        try {
            await expect(attempt(1)).rejects.toThrow();
        } finally {
            registry.set(getterKey, original);
        }

        expect(await statusOf()).toBe("completed");
        expect(await actions()).toStrictEqual(["deletion_completed", "deletion_retry_started", "deletion_retry_succeeded"]);
        expect(sendEmailSpy).not.toHaveBeenCalled();

        await attempt(1);

        expect(erasePostHogPerson).toHaveBeenCalledTimes(1);
        expect(sendEmailSpy).toHaveBeenCalledTimes(1);
        const after = await request();

        expect(after.userEmail).toBe("");
    });

    it("numbers chains from the rows the scheduler writes itself: a swallowed `deletion_failed` audit write starts no duplicate chain", async () => {
        expect(await schedule("first")).toBe(true);
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "processing" }));
        expect(await schedule("second")).toBe(true);

        expect(jobs().map((job) => job.args)).toStrictEqual([
            { attempt: 1, chain: 1, requestId, userId: USER },
            { attempt: 1, chain: 2, requestId, userId: USER },
        ]);
        // A redelivery of the second call is the same failure: still two chains.
        await schedule("second");

        expect(jobs()).toHaveLength(2);
    });

    it("queues nothing, and says so, for a request that already completed or was cancelled", async () => {
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "completed" }));

        expect(await schedule()).toBe(false);
        expect(jobs()).toHaveLength(0);
        expect(await audit()).toHaveLength(0);

        await run(async (ctx) => await ctx.db.patch(requestId, { status: "cancelled" }));

        expect(await schedule("again")).toBe(false);
        expect(jobs()).toHaveLength(0);
    });

    it("ends the chain of an attempt whose request a sweep failed mid-run, instead of leaving it without an outcome", async () => {
        await setEmail("a@example.com");
        await start(1);
        // A sweep or re-run flips the request to failed under the running attempt.
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "failed" }));

        await run(async (ctx) => await ctx.runMutation(failPostHogRetry, { attempt: 1, chain: 1, errorClass: "swept", requestId, userId: USER }));

        expect(await details("deletion_retry_failed")).toStrictEqual({ attempt: 1, chain: 1, errorClass: "swept", requestId });
        expect(jobs().at(-1)?.args).toStrictEqual({ attempt: 2, chain: 1, requestId, userId: USER });
        expect(await emailOnRequest()).toBe("a@example.com");

        await start(POSTHOG_RETRY_MAX_ATTEMPTS);
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "failed" }));
        await run(
            async (ctx) =>
                await ctx.runMutation(failPostHogRetry, { attempt: POSTHOG_RETRY_MAX_ATTEMPTS, chain: 1, errorClass: "swept", requestId, userId: USER }),
        );

        expect(await actions()).toContain("deletion_retry_exhausted");
        expect(await emailOnRequest()).toBe("");
    });

    it("keeps the address a newer chain needs when an older chain's last attempt expires", async () => {
        await setEmail("a@example.com");
        await schedule("a");
        await start(POSTHOG_RETRY_MAX_ATTEMPTS, 1);
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "processing" }));
        await schedule("b");

        await run(async (ctx) => await ctx.runMutation(expireStalePostHogRetry, { attempt: POSTHOG_RETRY_MAX_ATTEMPTS, chain: 1, requestId, userId: USER }));

        expect(await emailOnRequest()).toBe("a@example.com");
        expect(await actions()).not.toContain("deletion_retry_exhausted");
    });

    it("defers an attempt that finds a workflow re-run holding the request, audits it, and gives up after a bounded number of tries", async () => {
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "processing" }));
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");

        await attempt(1);

        expect(erasePostHogPerson).not.toHaveBeenCalled();
        expect(await details("deletion_retry_deferred")).toStrictEqual({ attempt: 1, chain: 1, deferral: 1, requestId });
        expect(jobs()).toHaveLength(1);
        expect(jobs()[0]?.args).toStrictEqual({ attempt: 1, chain: 1, requestId, userId: USER });
        expect(jobs()[0]?.scheduledFor).toBe(NOW + POSTHOG_RETRY_LEASE_MS);
        expect(await statusOf()).toBe("processing");

        for (let n = 0; n < 20; n += 1) {
            await attempt(1);
        }

        const names = await actions();
        const deferred = names.filter((name) => name === "deletion_retry_deferred");

        // Twelve deferrals and the one record that it gave up; the queue holds the twelve re-tries.
        expect(deferred).toHaveLength(13);
        expect(jobs()).toHaveLength(12);
    });

    it("does not start an attempt twice: a started attempt whose request was failed under it is left to the watchdog", async () => {
        await start(1);
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "failed" }));

        expect(await start(1)).toBe("skip");

        const names = await actions();
        const started = names.filter((name) => name === "deletion_retry_started");

        expect(started).toHaveLength(1);
    });

    it("hands the lease back when a delivery throws, so the redelivery inside the lease runs the attempt", async () => {
        vi.mocked(erasePostHogPerson).mockRejectedValueOnce(new Error("down")).mockResolvedValue("deleted");

        const failKey = "gdpr_posthog_retry:failPostHogRetry";
        const original = registry.get(failKey);

        registry.set(failKey, {
            ...(original as object),
            handler: () => {
                throw new Error("write failed");
            },
        });

        try {
            await expect(attempt(1)).rejects.toThrow();
        } finally {
            registry.set(failKey, original);
        }

        expect(await statusOf()).toBe("processing");

        // Still inside the lease.
        await attempt(1);

        expect(erasePostHogPerson).toHaveBeenCalledTimes(2);
        expect(await statusOf()).toBe("completed");
    });

    it("leaves the address in place when the confirmation claim is not this delivery's", async () => {
        await setEmail("a@example.com");
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");
        await run(async (ctx) => {
            const now = Date.now();

            await ctx.db.insert("idempotencyClaims", { claimedAt: now, expiresAt: now + HOUR, key: requestId, scope: EMAIL_SCOPE });
        });

        await attempt(1);

        expect(sendEmailSpy).not.toHaveBeenCalled();
        expect(await emailOnRequest()).toBe("a@example.com");

        // The sender holding the claim failed: the watchdog's requeued delivery resumes the confirmation.
        await run(async (ctx) => await ctx.runMutation(expireStalePostHogRetry, { attempt: 1, chain: 1, requestId, userId: USER }));
        await attempt(1);

        expect(sendEmailSpy).toHaveBeenCalledTimes(1);
        expect(await emailOnRequest()).toBe("");
    });

    it("restores the workflow's copy of the address for a new chain after an earlier chain's end minimised it", async () => {
        await setEmail("a@example.com");
        await schedule("a");
        await start(POSTHOG_RETRY_MAX_ATTEMPTS, 1);
        await run(
            async (ctx) =>
                await ctx.runMutation(failPostHogRetry, { attempt: POSTHOG_RETRY_MAX_ATTEMPTS, chain: 1, errorClass: "down", requestId, userId: USER }),
        );
        expect(await emailOnRequest()).toBe("");

        // A re-run fails again and schedules chain 2 with the address it holds in its own params.
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "processing" }));
        await schedule("b", "a@example.com");
        expect(await emailOnRequest()).toBe("a@example.com");

        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");
        await attempt(1, 2);

        expect(sendEmailSpy).toHaveBeenCalledTimes(1);
        expect(sendEmailSpy.mock.calls[0]?.[1]).toStrictEqual({ userEmail: "a@example.com" });
    });
});

describe("updateRequestProgress with fromStatus", () => {
    const write = async (fromStatus?: string[]) =>
        await run(async (ctx) => await ctx.runMutation(updateRequestProgress, { errorMessage: FAILED_MESSAGE, fromStatus, requestId, status: "failed" }));

    it("does not turn a completed request back into failed", async () => {
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "completed" }));

        await write(["processing", "failed"]);

        expect(await statusOf()).toBe("completed");
    });

    it("moves a processing request to failed", async () => {
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "processing" }));

        await write(["processing", "failed"]);

        expect(await statusOf()).toBe("failed");
    });

    it("writes unconditionally when no fromStatus is given", async () => {
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "completed" }));

        await write();

        expect(await statusOf()).toBe("failed");
    });
});
