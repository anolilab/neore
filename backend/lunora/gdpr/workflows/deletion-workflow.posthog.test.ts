/**
 * The deletion workflow must not mark the request completed, mail the
 * confirmation, or write the `deletion_completed` audit row while the PostHog
 * erasure step is failing; and an intentional skip is recorded as such.
 */
import { describe, expect, it } from "vitest";

import { accountDeletionWorkflowConfig } from "./deletion-workflow";

interface Call {
    args: Record<string, unknown>;
    name: string;
    options?: Record<string, unknown>;
}

const DEDUP_ID_PATTERN = /^post-hog-retry:req-1:.+/;

/** Runs the real handler against a context whose steps record calls; the PostHog step returns `postHog`, or throws it when it is an Error. */
const runWorkflow = async (
    postHog: "deleted" | "no_profile" | "skipped" | Error,
    minimiseFails = false,
    auditFails = false,
    statusFails = false,
    scheduleFails: boolean | number = false,
    isEmailClaimTaken = false,
    isScheduleRefused = false,
) => {
    const calls: Call[] = [];
    const stepRetries: string[] = [];
    let scheduleFailuresLeft = scheduleFails === true ? Infinity : Number(scheduleFails);
    let current = "";
    let failedWrites = 0;
    // The stored request, as `updateRequestProgress` and `minimiseGdprRecords` would leave it.
    const request: { errorMessage?: string | null; status: string; userEmail: string } = { status: "processing", userEmail: "a@example.com" };

    const run = async (reference: unknown, args: Record<string, unknown> = {}, options?: Record<string, unknown>) => {
        const name = `${current}|${String((reference as { name?: string }).name ?? "")}`;

        calls.push({ args, name, options });

        // Only the first `failed` write fails: the one before the retry is queued and the request minimised.
        if (statusFails && args.status === "failed") {
            failedWrites += 1;

            if (failedWrites === 1) {
                throw new Error("status write failed");
            }
        }

        // Like the mutation: a conditional write leaves a request that moved on meanwhile alone.
        const unchanged = Array.isArray(args.fromStatus) && !args.fromStatus.includes(request.status);

        if (typeof args.status === "string" && !unchanged) {
            request.status = args.status;
            request.errorMessage = (args.errorMessage as string | undefined) ?? request.errorMessage;
        }

        if (scheduleFailuresLeft > 0 && current === "schedule-post-hog-retry") {
            scheduleFailuresLeft -= 1;
            throw new Error("scheduling failed");
        }

        // The mutation answers `false` when it queued nothing (the request had already ended).
        if (isScheduleRefused && current === "schedule-post-hog-retry") {
            return false;
        }

        // The claim mutation answers `false` for a key the scheduled retry (or an earlier run) already holds.
        if (current === "claim-deletion-confirmed-email") {
            return !isEmailClaimTaken;
        }

        if (auditFails && current === "log-audit-posthog-failed") {
            throw new Error("audit failed");
        }

        // Batched steps are drained until `hasMore` is false; everything else returns null.
        if (minimiseFails && current === "minimise-gdpr-records-posthog-failed") {
            throw new Error("minimise failed");
        }

        if (current === "minimise-gdpr-records-posthog-failed") {
            request.errorMessage = null;
            // Like the mutation: the request a queued retry still has to mail keeps its address.
            request.userEmail = args.retainEmailOf === undefined ? "" : request.userEmail;
        } else if (current === "erase-post-hog-person") {
            if (postHog instanceof Error) {
                throw postHog;
            }

            return postHog;
        }

        return { hasMore: false };
    };

    const context = {
        params: { requestId: "req-1", userEmail: "a@example.com", userId: "user-1" },
        run,
        step: {
            do: async (name: string, configOrCallback: unknown, maybeCallback?: () => Promise<unknown>) => {
                const config = typeof configOrCallback === "function" ? undefined : (configOrCallback as { retries?: { limit: number } });
                const callback = (maybeCallback ?? configOrCallback) as () => Promise<unknown>;

                current = name;
                calls.push({ args: {}, name: `step:${name}` });

                try {
                    // Like the platform: a failing callback runs again, up to `retries.limit` more times.
                    for (let tries = 0; ; tries += 1) {
                        try {
                            return await callback();
                        } catch (error) {
                            if (tries >= (config?.retries?.limit ?? 0)) {
                                throw error;
                            }

                            stepRetries.push(name);
                        }
                    }
                } finally {
                    current = "";
                }
            },
        },
    };

    const outcome = await (async () => {
        try {
            await accountDeletionWorkflowConfig.handler(context as never);

            return "resolved" as const;
        } catch (error) {
            return error as Error;
        }
    })();

    return { calls, outcome, request, stepRetries };
};

const stepNames = (calls: Call[]) => calls.filter((call) => call.name.startsWith("step:")).map((call) => call.name.slice("step:".length));

const completionMarked = (calls: Call[]) => calls.some((call) => call.args.status === "completed");

describe("account deletion workflow, PostHog step", () => {
    it("does not complete, email or audit-complete when the PostHog step fails", async () => {
        const failure = new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable");
        const { calls, outcome } = await runWorkflow(failure);

        expect(outcome).toBe(failure);
        expect(stepNames(calls)).toContain("erase-post-hog-person");
        expect(completionMarked(calls)).toBe(false);
        expect(stepNames(calls)).not.toContain("send-deletion-confirmed-email-action");
        expect(stepNames(calls)).not.toContain("log-audit");
        expect(stepNames(calls)).not.toContain("minimise-gdpr-records");
    });

    it("marks the request failed and audits it when the PostHog step is exhausted, with no raw error stored", async () => {
        const failure = new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable");
        const { calls, outcome } = await runWorkflow(failure);

        expect(outcome).toBe(failure);

        const failed = calls.find((call) => call.args.status === "failed");

        expect(failed?.args.requestId).toBe("req-1");
        expect(String(failed?.args.errorMessage)).not.toContain("user-1");

        const audit = calls.find((call) => call.args.action === "deletion_failed");

        expect(JSON.parse(audit?.args.details as string)).toStrictEqual({ requestId: "req-1" });
        expect(stepNames(calls)).toContain("log-audit-posthog-failed");
    });

    it("writes `failed` only over a processing or failed request, never over a completed one", async () => {
        const { calls } = await runWorkflow(new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable"));
        const failedWrites = calls.filter((call) => call.args.status === "failed");

        expect(failedWrites).toHaveLength(2);

        for (const write of failedWrites) {
            expect(write.args.fromStatus).toStrictEqual(["processing", "failed"]);
        }
    });

    it("minimises the request records after the failure audit when the PostHog step is exhausted", async () => {
        const failure = new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable");
        const { calls, outcome } = await runWorkflow(failure);

        expect(outcome).toBe(failure);

        const names = stepNames(calls);

        expect(names.indexOf("minimise-gdpr-records-posthog-failed")).toBeGreaterThan(names.indexOf("log-audit-posthog-failed"));

        const minimise = calls.find((call) => call.name.startsWith("minimise-gdpr-records-posthog-failed|"));

        expect(minimise?.args).toStrictEqual({ retainEmailOf: "req-1", userId: "user-1" });

        const failed = calls.find((call) => call.args.status === "failed");

        expect(String(failed?.args.errorMessage)).not.toContain("a@example.com");
    });

    it("leaves the failed request carrying the fixed failure reason, and its address for the retry's confirmation email", async () => {
        const failure = new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable");
        const { outcome, request } = await runWorkflow(failure);

        expect(outcome).toBe(failure);
        expect(request.status).toBe("failed");
        expect(request.userEmail).toBe("a@example.com");
        expect(request.errorMessage).toBe("Your account data was erased, but deleting your analytics profile failed.");
    });

    it("still reports the PostHog error when the minimisation step fails too", async () => {
        const failure = new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable");
        const { outcome } = await runWorkflow(failure, true);

        expect(outcome).toBe(failure);
    });

    it("still minimises the request and reports the PostHog error when the failure audit step fails", async () => {
        const failure = new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable");
        const { calls, outcome, request } = await runWorkflow(failure, false, true);

        expect(outcome).toBe(failure);
        expect(stepNames(calls)).toContain("minimise-gdpr-records-posthog-failed");
        expect(request.userEmail).toBe("a@example.com");
        expect(request.status).toBe("failed");
        expect(request.errorMessage).toBe("Your account data was erased, but deleting your analytics profile failed.");
    });

    it("still minimises the request and reports the PostHog error when the first failed-status write fails", async () => {
        const failure = new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable");
        const { calls, outcome, request } = await runWorkflow(failure, false, false, true);

        expect(outcome).toBe(failure);
        expect(stepNames(calls)).toContain("minimise-gdpr-records-posthog-failed");
        expect(request.userEmail).toBe("a@example.com");
        expect(request.status).toBe("failed");
        expect(request.errorMessage).toBe("Your account data was erased, but deleting your analytics profile failed.");
    });

    it("schedules the analytics retry once, after the failure audit and before the minimisation", async () => {
        const { calls } = await runWorkflow(new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable"));
        const names = stepNames(calls);

        expect(names.filter((name) => name === "schedule-post-hog-retry")).toHaveLength(1);
        expect(names.indexOf("schedule-post-hog-retry")).toBeGreaterThan(names.indexOf("log-audit-posthog-failed"));
        expect(names.indexOf("schedule-post-hog-retry")).toBeLessThan(names.indexOf("minimise-gdpr-records-posthog-failed"));
        expect(calls.find((call) => call.name.startsWith("schedule-post-hog-retry|"))?.args).toStrictEqual({
            failureId: expect.any(String),
            requestId: "req-1",
            userEmail: "a@example.com",
            userId: "user-1",
        });
    });

    it("minimises the address at once when the scheduling mutation queued nothing", async () => {
        const failure = new Error("[GDPR/PostHog] Failed to delete person: 503 Service Unavailable");
        const { request } = await runWorkflow(failure, false, false, false, false, false, true);

        expect(request.userEmail).toBe("");
    });

    it("still minimises and reports the PostHog error when scheduling the retry fails", async () => {
        const failure = new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable");
        const { calls, outcome, request } = await runWorkflow(failure, false, false, false, true);

        expect(outcome).toBe(failure);
        expect(stepNames(calls)).toContain("minimise-gdpr-records-posthog-failed");
        expect(request.userEmail).toBe("");
        expect(request.status).toBe("failed");
    });

    it("gives every failure its own dedup id, so a re-run that fails again queues its own retry chain", async () => {
        const failure = new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable");
        const dedupIds = new Set<unknown>();

        for (let run = 0; run < 2; run += 1) {
            const { calls } = await runWorkflow(failure);

            dedupIds.add(calls.find((call) => call.name.startsWith("schedule-post-hog-retry|"))?.options?.dedupId);
        }

        expect(dedupIds.size).toBe(2);
    });

    it("minimises the address too when no retry could be queued, since no chain will ever end", async () => {
        const failure = new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable");
        const { calls } = await runWorkflow(failure, false, false, false, true);

        expect(calls.find((call) => call.name.startsWith("minimise-gdpr-records-posthog-failed|"))?.args).toStrictEqual({ userId: "user-1" });
    });

    it("retries the scheduling step, so a transient scheduling failure still queues the analytics retry", async () => {
        const failure = new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable");
        const { calls, outcome, stepRetries } = await runWorkflow(failure, false, false, false, 3);
        const scheduled = calls.filter((call) => call.name.startsWith("schedule-post-hog-retry|"));

        expect(outcome).toBe(failure);
        expect(stepRetries).toStrictEqual(["schedule-post-hog-retry", "schedule-post-hog-retry", "schedule-post-hog-retry"]);
        expect(scheduled).toHaveLength(4);
    });

    it("gives the scheduling step a retry budget and a dedup id so a retried attempt queues one job", async () => {
        const { calls, stepRetries } = await runWorkflow(new Error("503"), false, false, false, true);

        // 1 attempt + 7 retries, all spent before the failure is logged.
        expect(stepRetries).toHaveLength(7);
        expect(calls.find((call) => call.name.startsWith("schedule-post-hog-retry|"))?.options?.dedupId).toMatch(DEDUP_ID_PATTERN);
    });

    it("schedules no retry when the PostHog step succeeds", async () => {
        const { calls } = await runWorkflow("deleted");

        expect(stepNames(calls)).not.toContain("schedule-post-hog-retry");
    });

    it("never marks a request failed when the PostHog step succeeds", async () => {
        const { calls } = await runWorkflow("deleted");

        expect(calls.some((call) => call.args.status === "failed")).toBe(false);
        expect(calls.some((call) => call.args.action === "deletion_failed")).toBe(false);
    });

    it("completes after a successful PostHog deletion and records it", async () => {
        const { calls, outcome } = await runWorkflow("deleted");

        expect(outcome).toBe("resolved");
        expect(completionMarked(calls)).toBe(true);
        expect(stepNames(calls)).toContain("send-deletion-confirmed-email-action");

        const audit = calls.find((call) => call.args.action === "deletion_completed");

        expect(JSON.parse(audit?.args.details as string)).toStrictEqual({ posthog: "deleted", requestId: "req-1" });
    });

    it("claims the shared confirmation key before it mails, so a retry that completed the request mails nothing twice", async () => {
        const { calls } = await runWorkflow("deleted");
        const names = stepNames(calls);
        const claim = calls.find((call) => call.name.startsWith("claim-deletion-confirmed-email|"));

        expect(names.indexOf("claim-deletion-confirmed-email")).toBeGreaterThan(-1);
        expect(names.indexOf("claim-deletion-confirmed-email")).toBeLessThan(names.indexOf("send-deletion-confirmed-email-action"));
        expect(claim?.args).toMatchObject({ key: "req-1", scope: "gdpr-deletion-confirmed-email" });

        const taken = await runWorkflow("deleted", false, false, false, false, true);

        expect(taken.outcome).toBe("resolved");
        expect(completionMarked(taken.calls)).toBe(true);
        expect(stepNames(taken.calls)).not.toContain("send-deletion-confirmed-email-action");
        expect(stepNames(taken.calls)).toContain("minimise-gdpr-records");
    });

    it("completes on no_profile (nothing to erase) and records it as such, not as deleted", async () => {
        const { calls, outcome } = await runWorkflow("no_profile");

        expect(outcome).toBe("resolved");
        expect(completionMarked(calls)).toBe(true);

        const audit = calls.find((call) => call.args.action === "deletion_completed");

        expect(JSON.parse(audit?.args.details as string)).toStrictEqual({ posthog: "no_profile", requestId: "req-1" });
    });

    it("records an intentional skip as skipped, not as a PostHog deletion", async () => {
        const { calls, outcome } = await runWorkflow("skipped");

        expect(outcome).toBe("resolved");

        const audit = calls.find((call) => call.args.action === "deletion_completed");

        expect(JSON.parse(audit?.args.details as string)).toStrictEqual({ posthog: "skipped", requestId: "req-1" });
    });
});
