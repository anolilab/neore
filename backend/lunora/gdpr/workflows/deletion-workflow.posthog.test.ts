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
}

/** Runs the real handler against a context whose steps record calls; the PostHog step returns `postHog`, or throws it when it is an Error. */
const runWorkflow = async (postHog: "deleted" | "no_profile" | "skipped" | Error, minimiseFails = false) => {
    const calls: Call[] = [];
    let current = "";

    const run = async (reference: unknown, args: Record<string, unknown> = {}) => {
        const name = `${current}|${String((reference as { name?: string }).name ?? "")}`;

        calls.push({ args, name });

        // Batched steps are drained until `hasMore` is false; everything else returns null.
        if (minimiseFails && current === "minimise-gdpr-records-posthog-failed") {
            throw new Error("minimise failed");
        }

        if (current === "erase-post-hog-person") {
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
            do: async (name: string, callback: () => Promise<unknown>) => {
                current = name;
                calls.push({ args: {}, name: `step:${name}` });

                try {
                    return await callback();
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

    return { calls, outcome };
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

    it("still reports the PostHog error when the minimisation step fails too", async () => {
        const failure = new Error("[GDPR/PostHog] Failed to delete person user-1: 503 Service Unavailable");
        const { outcome } = await runWorkflow(failure, true);

        expect(outcome).toBe(failure);
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
