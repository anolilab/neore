/**
 * The account deletion workflow's ordering and failure behaviour.
 *
 * The handler runs against a recording fake of the workflow context: `step.do`
 * runs its callback inline and `run` answers every batched step as exhausted,
 * so the trace is the exact sequence of durable steps and internal calls. Step
 * names are identifiers in the durable log, so the order and the names are what
 * these tests pin.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { ROOT_SHARD_KEY } from "../../lib/shard-context";
import { accountDeletionWorkflowConfig } from "./deletion-workflow";

const USER = "user-1";
const PARAMS = { requestId: "request-1", userEmail: "user@example.com", userId: USER };

type Entry = { args: Record<string, unknown>; dedupId?: string; kind: "run"; ref: string; shardKey?: string } | { kind: "step"; name: string };

let trace: Entry[];
let failOn: ((entry: Entry) => boolean) | undefined;
let answer: (ref: string, round: number, args: Record<string, unknown>) => unknown;
const rounds = new Map<string, number>();

const refOf = (reference: unknown): string => (reference as { __lunoraRef: string }).__lunoraRef;

const workflowContext = () => {
    const run = async (reference: unknown, args: Record<string, unknown>, options?: { dedupId?: string; shardKey?: string }) => {
        const entry: Entry = { args, dedupId: options?.dedupId, kind: "run", ref: refOf(reference), shardKey: options?.shardKey };

        trace.push(entry);

        if (failOn?.(entry)) {
            throw new Error(`${entry.ref} failed`);
        }

        const round = (rounds.get(entry.ref) ?? 0) + 1;

        rounds.set(entry.ref, round);

        return answer(entry.ref, round, args);
    };

    return {
        params: PARAMS,
        run,
        step: {
            do: async (name: string, callback: () => Promise<unknown>) => {
                trace.push({ kind: "step", name });

                return await callback();
            },
        },
    };
};

const execute = async (): Promise<void> => {
    await accountDeletionWorkflowConfig.handler(workflowContext() as never);
};

const stepNames = (): string[] => trace.flatMap((entry) => (entry.kind === "step" ? [entry.name] : []));
const runs = (): Extract<Entry, { kind: "run" }>[] => trace.filter((entry): entry is Extract<Entry, { kind: "run" }> => entry.kind === "run");
const indexOfStep = (name: string): number => trace.findIndex((entry) => entry.kind === "step" && entry.name === name);
const indexOfRun = (ref: string): number => trace.findIndex((entry) => entry.kind === "run" && entry.ref === ref);
const completionIndex = (): number =>
    trace.findIndex((entry) => entry.kind === "run" && entry.ref === "gdpr_functions:updateRequestProgress" && entry.args["status"] === "completed");

beforeEach(() => {
    trace = [];
    failOn = undefined;
    rounds.clear();
    answer = () => {
        return { cursor: null, hasMore: false };
    };
});

describe("account deletion workflow: order", () => {
    it("deletes the PostHog person after the auth records and before reporting the request completed", async () => {
        await execute();

        const authRecords = indexOfStep("delete-auth-records");
        const postHog = indexOfStep("erase-post-hog-person");
        const completed = completionIndex();

        expect(authRecords).toBeGreaterThan(-1);
        expect(postHog).toBeGreaterThan(authRecords);
        expect(completed).toBeGreaterThan(postHog);
        // The PostHog call is the step's own work, not just its marker.
        expect(indexOfRun("gdpr_steps_posthog_steps:deletePostHogPerson")).toBeGreaterThan(postHog);
        expect(indexOfRun("gdpr_steps_posthog_steps:deletePostHogPerson")).toBeLessThan(completed);
    });

    it("deletes the user's presentations before reporting the request completed", async () => {
        await execute();

        const completed = completionIndex();
        const step = indexOfStep("delete-user-presentations");
        const call = indexOfRun("gdpr_steps_deletion_steps:deleteUserPresentations");

        expect(step).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(step);
        expect(call).toBeLessThan(completed);
        expect(runs().find((entry) => entry.ref === "gdpr_steps_deletion_steps:deleteUserPresentations")?.args).toStrictEqual({ userId: USER });
    });

    it("writes the audit entry and minimises the records after completion, and only then claims and sends the confirmation", async () => {
        await execute();

        const completed = completionIndex();
        const audit = indexOfStep("log-audit");
        const minimise = indexOfStep("minimise-gdpr-records");
        const claim = indexOfStep("claim-deletion-confirmed-email");
        const email = indexOfStep("send-deletion-confirmed-email-action");

        expect(audit).toBeGreaterThan(completed);
        expect(minimise).toBeGreaterThan(audit);
        expect(claim).toBeGreaterThan(minimise);
        expect(email).toBeGreaterThan(claim);
        expect(email).toBe(trace.findLastIndex((entry) => entry.kind === "step"));
    });

    it("still resolves, with the records minimised, when the confirmation cannot be sent", async () => {
        failOn = (entry) => entry.kind === "run" && entry.ref === "gdpr_steps_email_steps:sendDeletionConfirmedEmailAction";

        await expect(execute()).resolves.toBeUndefined();

        expect(stepNames()).toContain("log-audit");
        expect(stepNames()).toContain("minimise-gdpr-records");
    });

    it("does nothing for a request that already ended: the first status write is conditional and a refusal ends the run", async () => {
        answer = (ref) => (ref === "gdpr_functions:updateRequestProgress" ? false : { cursor: null, hasMore: false });

        await execute();

        expect(runs()[0]?.args).toMatchObject({ fromStatus: ["pending", "processing", "failed"], status: "processing" });
        expect(runs()).toHaveLength(1);
        // Checkpointed, so a replay of the instance reads this answer instead of writing again.
        expect(stepNames()).toStrictEqual(["open-deletion-request"]);
    });

    it("writes the completion audit, minimises and mails only when this run's completion applied", async () => {
        // A scheduled retry completed the request first: this run's conditional completion write is refused.
        answer = (ref, _round, args) =>
            ref === "gdpr_functions:updateRequestProgress" && args["status"] === "completed" ? false : { cursor: null, hasMore: false };
        await execute();

        expect(stepNames()).not.toContain("log-audit");
        expect(stepNames()).not.toContain("minimise-gdpr-records");
        expect(stepNames()).not.toContain("claim-deletion-confirmed-email");
        expect(stepNames()).not.toContain("send-deletion-confirmed-email-action");
    });

    it("reports completion exactly once, at 100 percent", async () => {
        await execute();

        const completions = runs().filter((entry) => entry.ref === "gdpr_functions:updateRequestProgress" && entry.args["status"] === "completed");

        expect(completions).toHaveLength(1);
        expect(completions[0]?.args).toMatchObject({ progress: 100, requestId: PARAMS.requestId });
    });

    it("reports progress that never goes backwards", async () => {
        await execute();

        const progress = runs()
            .filter((entry) => entry.ref === "gdpr_functions:updateRequestProgress")
            .map((entry) => entry.args["progress"] as number);

        expect(progress.length).toBeGreaterThan(10);
        expect(progress).toStrictEqual(progress.toSorted((a, b) => a - b));
        expect(progress[0]).toBe(3);
        expect(progress.at(-1)).toBe(100);
    });

    it("revokes sessions first, then runs the steps that need rows or secrets that a later step removes", async () => {
        await execute();

        // The request is opened (a checkpointed step) before anything is deleted.
        expect(stepNames().slice(0, 2)).toStrictEqual(["open-deletion-request", "revoke-user-sessions"]);

        const before = (early: string, late: string) => {
            // A step that never ran is index -1, which would satisfy every "earlier than" comparison.
            expect(indexOfStep(early), `${early} ran`).toBeGreaterThan(-1);
            expect(indexOfStep(late), `${late} ran`).toBeGreaterThan(-1);
            expect(indexOfStep(early), `${early} before ${late}`).toBeLessThan(indexOfStep(late));
        };

        // Needs the bot token that `delete-user-settings` removes.
        before("deregister-messenger-webhooks", "delete-user-settings");
        // Revoked at the provider while the tokens still exist.
        before("revoke-connector-grants", "delete-user-connectors");
        // A task or eval round in flight would recreate a thread after the cascade.
        before("stop-user-tasks", "delete-user-thread-cascade");
        before("stop-user-evals", "delete-user-thread-cascade");
        before("kill-user-sandboxes", "delete-user-thread-cascade");
        // A coding agent run in flight would post its result into a thread after the cascade.
        before("stop-user-coding-agents", "delete-user-thread-cascade");
        // The subscription is cancelled while the user still exists.
        before("cancel-user-billing", "delete-user-thread-metadata");
        // Thread-dependent rows go before the threads themselves.
        before("delete-user-thread-metadata", "delete-user-thread-cascade");
        before("delete-user-thread-cascade", "delete-all-for-user-id-async");
        // Projects are found through workflow rows, and the document history is the last data purge.
        before("delete-user-workflow-data", "delete-user-projects");
        before("delete-auth-records", "delete-user-identity");
        before("delete-user-identity", "purge-user-document-history");
        before("purge-user-document-history", "erase-post-hog-person");
    });

    it("uses each durable step name once, since the names key the durable log", async () => {
        await execute();

        const names = stepNames();

        expect(new Set(names).size).toBe(names.length);
    });
});

describe("account deletion workflow: shards", () => {
    it("runs every step on the user's shard, except billing which lives on the root shard", async () => {
        await execute();

        const billing = runs().filter((entry) => entry.ref === "billing_gdpr:cancelBilling");

        expect(billing).toHaveLength(1);
        expect(billing[0]).toMatchObject({ args: { referenceId: USER }, shardKey: ROOT_SHARD_KEY });

        for (const entry of runs()) {
            if (entry.ref !== "billing_gdpr:cancelBilling") {
                expect(entry.shardKey, entry.ref).toBe(USER);
            }
        }
    });
});

describe("account deletion workflow: targets", () => {
    it("aims every account-scoped call at the user being deleted, and only the e-mail calls at the address", async () => {
        await execute();

        const scoped = runs().filter((entry) => "userId" in entry.args);

        // The workflow has dozens of user-scoped calls; a handful would mean the fake stopped recording them.
        expect(scoped.length).toBeGreaterThan(30);

        for (const entry of scoped) {
            expect(entry.args["userId"], entry.ref).toBe(USER);
        }

        const emailed = runs().filter((entry) => "userEmail" in entry.args);

        expect(emailed.length).toBeGreaterThan(0);

        for (const entry of emailed) {
            expect(entry.args["userEmail"], entry.ref).toBe(PARAMS.userEmail);
        }

        // Billing is keyed by the reference id, not the user id.
        expect(runs().find((entry) => entry.ref === "billing_gdpr:cancelBilling")?.args).toStrictEqual({ referenceId: USER });

        const reports = runs().filter((item) => item.ref === "gdpr_functions:updateRequestProgress");

        expect(reports.length).toBeGreaterThan(10);

        for (const entry of reports) {
            expect(entry.args["requestId"]).toBe(PARAMS.requestId);
        }
    });
});

describe("account deletion workflow: failure", () => {
    it("does not report completed, confirm by e-mail or audit when the PostHog step fails", async () => {
        failOn = (entry) => entry.kind === "run" && entry.ref === "gdpr_steps_posthog_steps:deletePostHogPerson";

        await expect(execute()).rejects.toThrow("deletePostHogPerson failed");

        expect(completionIndex()).toBe(-1);
        expect(stepNames()).not.toContain("send-deletion-confirmed-email-action");
        expect(stepNames()).not.toContain("log-audit");
        expect(stepNames()).not.toContain("minimise-gdpr-records");
    });

    it("stops at the first failing step, running nothing after it", async () => {
        failOn = (entry) => entry.kind === "run" && entry.ref === "gdpr_steps_deletion_steps:deleteUserThreadMetadata";

        await expect(execute()).rejects.toThrow("deleteUserThreadMetadata failed");

        expect(stepNames().at(-1)).toBe("delete-user-thread-metadata");
        expect(stepNames()).not.toContain("delete-user-thread-cascade");
        expect(stepNames()).not.toContain("delete-auth-records");
        expect(completionIndex()).toBe(-1);
    });

    it("keeps the auth records when an earlier data step fails, so the deletion can resume", async () => {
        failOn = (entry) => entry.kind === "run" && entry.ref === "gdpr_steps_deletion_steps:deleteUserFiles";

        await expect(execute()).rejects.toThrow("deleteUserFiles failed");

        expect(stepNames()).not.toContain("delete-auth-records");
        expect(stepNames()).not.toContain("erase-post-hog-person");
        expect(completionIndex()).toBe(-1);
    });
});

describe("account deletion workflow: batched steps", () => {
    it("repeats a batched step until it reports no more rows", async () => {
        answer = (ref, round) => {
            return { cursor: null, hasMore: ref === "gdpr_steps_deletion_steps:deleteUserDocuments" && round < 4 };
        };

        await execute();

        expect(runs().filter((entry) => entry.ref === "gdpr_steps_deletion_steps:deleteUserDocuments")).toHaveLength(4);
        expect(completionIndex()).toBeGreaterThan(-1);
    });

    it("walks the thread cascade with the cursor each round returned", async () => {
        answer = (ref, round) =>
            ref === "gdpr_steps_deletion_steps:deleteUserThreadCascade"
                ? { cursor: `c${String(round)}`, hasMore: round < 3 }
                : { cursor: null, hasMore: false };

        await execute();

        const cursors = runs()
            .filter((entry) => entry.ref === "gdpr_steps_deletion_steps:deleteUserThreadCascade")
            .map((entry) => entry.args["cursor"]);

        expect(cursors).toStrictEqual([null, "c1", "c2"]);
    });

    it("fails, rather than completing, when a batched step never runs out of rows", async () => {
        answer = (ref) => {
            return { cursor: null, hasMore: ref === "gdpr_steps_deletion_steps:deleteUserMemories" };
        };

        await expect(execute()).rejects.toThrow("still had rows after 10000 batches");

        expect(completionIndex()).toBe(-1);
    });
});

describe("account deletion workflow: watched repositories", () => {
    const WATCHED = "source_control_gdpr:deleteUserWatchedRepositories";

    // A raw `step.do` callback is skipped on a replay, so the body's positional dedup counter does not advance and a
    // later call can be answered with an earlier call's cached result: the erasure would be reported done unrun.
    // An id of its own, stable across replays and different per batch, cannot collide.
    it("dispatches each batch under an id of its own that a replay reproduces", async () => {
        answer = (ref, round) => {
            return { cursor: null, hasMore: ref === WATCHED && round < 3 };
        };
        await execute();

        const first = runs()
            .filter((entry) => entry.ref === WATCHED)
            .map((entry) => entry.dedupId);

        expect(first).toHaveLength(3);
        expect(new Set(first).size).toBe(3);
        expect(first.every((id) => typeof id === "string" && id.includes(PARAMS.requestId))).toBe(true);

        trace = [];
        rounds.clear();
        await execute();

        expect(
            runs()
                .filter((entry) => entry.ref === WATCHED)
                .map((entry) => entry.dedupId),
        ).toEqual(first);
    });
});
