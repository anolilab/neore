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
const runWorkflow = async (postHog: "deleted" | "skipped" | Error) => {
    const calls: Call[] = [];
    let current = "";

    const run = async (reference: unknown, args: Record<string, unknown> = {}) => {
        const name = `${current}|${String((reference as { name?: string }).name ?? "")}`;

        calls.push({ args, name });

        // Batched steps are drained until `hasMore` is false; everything else returns null.
        if (current === "delete-post-hog-person") {
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

                const result = await callback();

                current = "";

                return result;
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
        expect(stepNames(calls)).toContain("delete-post-hog-person");
        expect(completionMarked(calls)).toBe(false);
        expect(stepNames(calls)).not.toContain("send-deletion-confirmed-email-action");
        expect(stepNames(calls)).not.toContain("log-audit");
        expect(stepNames(calls)).not.toContain("minimise-gdpr-records");
    });

    it("completes after a successful PostHog deletion and records it", async () => {
        const { calls, outcome } = await runWorkflow("deleted");

        expect(outcome).toBe("resolved");
        expect(completionMarked(calls)).toBe(true);
        expect(stepNames(calls)).toContain("send-deletion-confirmed-email-action");

        const audit = calls.find((call) => call.args.action === "deletion_completed");

        expect(JSON.parse(audit?.args.details as string)).toStrictEqual({ postHog: "deleted", requestId: "req-1" });
    });

    it("records an intentional skip as skipped, not as a PostHog deletion", async () => {
        const { calls, outcome } = await runWorkflow("skipped");

        expect(outcome).toBe("resolved");

        const audit = calls.find((call) => call.args.action === "deletion_completed");

        expect(JSON.parse(audit?.args.details as string)).toStrictEqual({ postHog: "skipped", requestId: "req-1" });
    });
});
