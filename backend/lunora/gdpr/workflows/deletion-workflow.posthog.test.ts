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

/** Runs the real handler against a context whose steps record calls; the PostHog step returns `postHog`, or throws it when it is an Error. */
const runWorkflow = async (
    postHog: "deleted" | "no_profile" | "skipped" | Error,
    minimiseFails = false,
    auditFails = false,
    statusFails = false,
    scheduleFails: boolean | number = false,
) => {
    const calls: Call[] = [];
    const stepRetries: string[] = [];
    let scheduleFailuresLeft = scheduleFails === true ? Infinity : Number(scheduleFails);
    let current = "";
    // The stored request, as `updateRequestProgress` and `minimiseGdprRecords` would leave it.
    const request: { errorMessage?: string | null; status: string; userEmail: string } = { status: "processing", userEmail: "a@example.com" };

    const run = async (reference: unknown, args: Record<string, unknown> = {}, options?: Record<string, unknown>) => {
        const name = `${current}|${String((reference as { name?: string }).name ?? "")}`;

        calls.push({ args, name, options });

        // The first `failed` write happens before minimisation, while the email is still stored.
        if (statusFails && args.status === "failed" && request.userEmail !== "") {
            throw new Error("status write failed");
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

        if (auditFails && current === "log-audit-posthog-failed") {
            throw new Error("audit failed");
        }

        // Batched steps are drained until `hasMore` is false; everything else returns null.
        if (minimiseFails && current === "minimise-gdpr-records-posthog-failed") {
            throw new Error("minimise failed");
        }

        if (current === "minimise-gdpr-records-posthog-failed") {
            request.errorMessage = null;
            request.userEmail = "";
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

        expect(minimise?.args).toStrictEqual({ userId: "user-1" });

        const failed = calls.find((call) => call.args.status === "failed");

        expect(String(failed?.args.errorMessage)).not.toContain("a@example.com");
    });

    it("leaves the failed request minimised but still carrying the fixed failure reason", async () => {
        const failure = new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable");
        const { outcome, request } = await runWorkflow(failure);

        expect(outcome).toBe(failure);
        expect(request.status).toBe("failed");
        expect(request.userEmail).toBe("");
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
        expect(request.userEmail).toBe("");
        expect(request.status).toBe("failed");
        expect(request.errorMessage).toBe("Your account data was erased, but deleting your analytics profile failed.");
    });

    it("still minimises the request and reports the PostHog error when the first failed-status write fails", async () => {
        const failure = new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable");
        const { calls, outcome, request } = await runWorkflow(failure, false, false, true);

        expect(outcome).toBe(failure);
        expect(stepNames(calls)).toContain("minimise-gdpr-records-posthog-failed");
        expect(request.userEmail).toBe("");
        expect(request.status).toBe("failed");
        expect(request.errorMessage).toBe("Your account data was erased, but deleting your analytics profile failed.");
    });

    it("schedules the analytics retry once, after the failure audit and before the minimisation", async () => {
        const { calls } = await runWorkflow(new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable"));
        const names = stepNames(calls);

        expect(names.filter((name) => name === "schedule-post-hog-retry")).toHaveLength(1);
        expect(names.indexOf("schedule-post-hog-retry")).toBeGreaterThan(names.indexOf("log-audit-posthog-failed"));
        expect(names.indexOf("schedule-post-hog-retry")).toBeLessThan(names.indexOf("minimise-gdpr-records-posthog-failed"));
        expect(calls.find((call) => call.name.startsWith("schedule-post-hog-retry|"))?.args).toStrictEqual({ requestId: "req-1", userId: "user-1" });
    });

    it("still minimises and reports the PostHog error when scheduling the retry fails", async () => {
        const failure = new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable");
        const { calls, outcome, request } = await runWorkflow(failure, false, false, false, true);

        expect(outcome).toBe(failure);
        expect(stepNames(calls)).toContain("minimise-gdpr-records-posthog-failed");
        expect(request.userEmail).toBe("");
        expect(request.status).toBe("failed");
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
        expect(calls.find((call) => call.name.startsWith("schedule-post-hog-retry|"))?.options?.dedupId).toBe("post-hog-retry:req-1");
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
